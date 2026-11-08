'use strict';
// Native UI thread queries must stay on the owning SSH host. Local filesystem,
// settings, skills and process requests stay with the independent local server.
const collections=new Set(['thread/list','thread/loaded/list','thread/search','thread/attachmentOwner/list']);
const reads=new Set(['account/read','account/rateLimits/read','model/list','collaborationMode/list','mcpServerStatus/list','modelProvider/capabilities/read','thread/realtime/listVoices']);
function threadScoped(method,params){
 return method==='thread/start'||method==='review/start'||Boolean(params?.threadId&&/^(thread\/|turn\/|mcpServer\/)/.test(method));
}
const ownerId=item=>typeof item==='string'?item:item?.threadId||item?.thread?.id||item?.id;
async function ownedPage(rpc,method,params,known,profile){
 let cursor=params?.cursor,result,data=[],pages=0;
 const seen=new Set();
 do{
  if(cursor&&seen.has(cursor))throw Error('遠端對話分頁游標重複。');
  if(cursor)seen.add(cursor);
  const query={...params,cursor:cursor||null};delete query.cwd;
  result=await rpc.request(method,query);
  if(!Array.isArray(result.data))throw Error('遠端回傳無效對話清單。');
  const localRows=result.data.filter(item=>{
   const entry=known[ownerId(item)];
   if(entry?.profile!==profile||entry.deleted)return false;
   const t=typeof item==='object'&&item?(item.thread||item):null;
   if(t&&['thread/list','thread/search'].includes(method)&&entry.emptyHistory===true&&!t.name&&!t.preview&&!(Array.isArray(t.turns)&&t.turns.length))return false;
   return true;
  }).map(item=>{
   if(typeof item==='string')return item;
   const cwd=known[ownerId(item)]?.localCwd;
   return cwd?(item.thread?{...item,thread:{...item.thread,cwd}}:{...item,cwd}):item;
  }).filter(item=>{
   if(!params?.cwd)return true;
   const cwd=known[ownerId(item)]?.localCwd||(item.thread||item).cwd;
   return Array.isArray(params.cwd)?params.cwd.includes(cwd):params.cwd===cwd;
  });
  data.push(...localRows);
  cursor=result.nextCursor;
 }while(cursor&&data.length<(params?.limit||25)&&++pages<20);
 // The remote backwards cursor can anchor an unrelated owner's row.
 return {...result,data,backwardsCursor:null,nextCursor:cursor||null};
}
// scope: 'own' = this host; 'others' = conversations cached from every other host, which open from
// the cache until that host is connected again; 'all' = both.
// Engine list rows always carry `turns` (empty when not loaded); the window dereferences it while
// grouping sub-agent threads, so cached rows must look the same. Sub-agent discovery asks with
// parentThreadId/ancestorThreadId and sourceKinds; cached rows honour those filters too.
const SUBAGENT_KINDS=new Set(['subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther']);
function descendsFrom(known,id,ancestor){for(let cur=known[id]?.summary?.parentThreadId,depth=0;cur&&depth<32;cur=known[cur]?.summary?.parentThreadId,depth++)if(cur===ancestor)return true;return false;}
// A plain sidebar/history query, where other hosts' cached conversations may be merged in.
function generalListing(params={}){return !params.parentThreadId&&!params.ancestorThreadId&&!params.cwd&&!params.searchTerm&&!(Array.isArray(params.sourceKinds)&&params.sourceKinds.some(k=>SUBAGENT_KINDS.has(k)));}
function cachedPage(method,params,known,profile,{scope='own'}={}){
 const mine=t=>t.profile===profile,shown=t=>t.summary&&!t.deleted&&t.summary.ephemeral!==true&&!(t.emptyHistory===true&&!t.summary.name&&!t.summary.preview);
 let data=Object.values(known).filter(t=>shown(t)&&(scope==='all'||(scope==='others'?!mine(t):mine(t)))).map(t=>({...t.summary,turns:Array.isArray(t.summary.turns)?t.summary.turns:[],archived:!!t.archived}));
 data=data.filter(t=>t.archived===!!params?.archived);
 if(params?.parentThreadId)data=data.filter(t=>t.parentThreadId===params.parentThreadId);
 if(params?.ancestorThreadId)data=data.filter(t=>descendsFrom(known,t.id,params.ancestorThreadId));
 const kinds=Array.isArray(params?.sourceKinds)&&params.sourceKinds.length?new Set(params.sourceKinds):null;
 if(kinds){const sub=[...kinds].some(k=>SUBAGENT_KINDS.has(k)),user=[...kinds].some(k=>!SUBAGENT_KINDS.has(k));data=data.filter(t=>t.threadSource==='subagent'?sub:t.threadSource==='thread_title'?false:user&&(!t.source||kinds.has(t.source)||kinds.has('unknown')));}
 else if(!params?.parentThreadId&&!params?.ancestorThreadId)data=data.filter(t=>t.threadSource!=='subagent'&&t.threadSource!=='thread_title');
 if(params?.cwd)data=data.filter(t=>t.cwd===params.cwd||Array.isArray(params.cwd)&&params.cwd.includes(t.cwd));
 const term=(params?.searchTerm||'').toLocaleLowerCase();
 if(term)data=data.filter(t=>[t.name,t.preview].some(v=>v?.toLocaleLowerCase().includes(term)));
 const sort=params?.sortKey==='created_at'?'createdAt':'updatedAt';
 data.sort((a,b)=>(Number(a[sort]||0)-Number(b[sort]||0))*(params?.sortDirection==='asc'?1:-1));
 const offset=Number(params?.cursor?.replace(/^local:/,''))||0,limit=Math.max(1,Math.min(params?.limit||25,100));
 const nextCursor=offset+limit<data.length?'local:'+(offset+limit):null;
 data=data.slice(offset,offset+limit);
 if(method==='thread/search')data=data.map(thread=>({thread,snippet:thread.preview||thread.name||''}));
 return {data,backwardsCursor:null,nextCursor};
}
// Every cached row for one query, for merging into a live page.
function cachedAll(method,params,known,profile,options){
 const rows=[];let cursor=null;
 for(let page=0;page<20;page++){const result=cachedPage(method,{...params,cursor,limit:100},known,profile,options);rows.push(...result.data);cursor=result.nextCursor;if(!cursor)break;}
 return rows;
}

const {randomUUID}=require('node:crypto');
// Subscription ids are scoped to a native frontend, while the remote server sees
// a unique id. Retain the originating runtime even if the current host changes.
class NativeEventStreams {
 constructor({send,onError=()=>{}}){this.send=send;this.onError=onError;this.entries=new Map();}
 find(client,id){return [...this.entries.values()].find(e=>e.client===client&&e.id===id);}
 forget(entry){this.entries.delete(entry.remoteId);}
 async start(runtime,client,params){
  if(!client||typeof params.subscriptionId!=='string'||!params.subscriptionId)throw Error('MCP 訂閱識別碼無效。');
  if(this.find(client,params.subscriptionId))throw Error('MCP 訂閱識別碼已使用。');
  const e={runtime,client,id:params.subscriptionId,remoteId:'opencodex:'+randomUUID(),closing:false};
  this.entries.set(e.remoteId,e);
  // The pinned engine may wait 90 seconds for activation. Leave time for its
  // authoritative timeout and the SSH round trip before cancelling the lease.
  e.started=Promise.resolve().then(()=>runtime.rpc.request('mcpServer/event/stream/start',{...params,subscriptionId:e.remoteId},100000));
  try{return await e.started;}
  catch(error){
   // A timeout does not prove the peer rejected start. Cancel on the same peer.
   try{await this.stopEntry(e);}catch(cleanup){this.onError(cleanup);}
   this.forget(e);throw error;
  }
 }
 stopEntry(e){
  e.closing=true;
  // Startup failure, explicit stop and frontend teardown can race. Keep one
  // cleanup per remote lease, but permit a retry if the peer rejects stop.
  if(e.stopping)return e.stopping;
  e.stopping=(async()=>{
   await e.started.catch(()=>{});
   if(!this.entries.has(e.remoteId))return {};
   if(e.runtime.closed){this.forget(e);return {};}
   const result=await e.runtime.rpc.request('mcpServer/event/stream/stop',{subscriptionId:e.remoteId},10000);
   this.forget(e);return result;
  })().catch(error=>{e.stopping=null;throw error;});
  return e.stopping;
 }
 stop(client,id){
  const e=this.find(client,id);
  if(!e)throw Error('MCP 訂閱不存在或已關閉；請重新開啟。');
  return this.stopEntry(e);
 }
 notification(runtime,message){
  if(message.method!=='mcpServer/event/stream/notification')return false;
  const e=this.entries.get(message.params?.subscriptionId);
  if(e&&e.runtime===runtime){
   // Release before delivery so a frontend may immediately resubscribe using
   // the same id. A late terminal event from another runtime cannot release it.
   const terminated=message.params?.notification?.method==='notifications/events/terminated';
   if(terminated)this.forget(e);
   if(!e.closing)this.send(e.client,{...message,params:{...message.params,subscriptionId:e.id}});
  }
  return true; // Never broadcast another frontend's or stale host's events.
 }
 disconnect(runtime){for(const e of this.entries.values())if(e.runtime===runtime)this.forget(e);}
 async closeClient(client){
  await Promise.all([...this.entries.values()].filter(e=>e.client===client).map(async e=>{
   try{await this.stopEntry(e);}catch(error){this.onError(error);this.forget(e);}
  }));
 }
}

module.exports={collections,reads,threadScoped,ownedPage,cachedPage,cachedAll,generalListing,NativeEventStreams};
