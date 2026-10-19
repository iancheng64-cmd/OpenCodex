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
  const localRows=result.data.filter(item=>known[ownerId(item)]?.profile===profile&&!known[ownerId(item)].deleted).map(item=>{
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
function cachedPage(method,params,known,profile){
 let data=Object.values(known).filter(t=>t.profile===profile&&t.summary&&!t.deleted).map(t=>({...t.summary,archived:!!t.archived}));
 data=data.filter(t=>t.archived===!!params?.archived);
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

module.exports={collections,reads,threadScoped,ownedPage,cachedPage,NativeEventStreams};
