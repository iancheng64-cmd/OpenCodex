'use strict';
// The native local app-server owns section/project entities. SSH peers own
// conversation bodies. Keep the join on the Mac; local UUIDs are never sent
// to a peer's unrelated state database. Use only from the SSH routing branch.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const copy=o=>structuredClone(o);
const hash=o=>crypto.createHash('sha256').update(JSON.stringify(o,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)).digest('hex');
const set=(o,k,v)=>Object.defineProperty(o,k,{value:v,enumerable:true,writable:true,configurable:true});
const methods=new Set(['threadSection/list','threadSection/create','threadSection/update','threadSection/delete',
 'project/list','project/read','project/create','project/import','project/update','project/delete','project/move','thread/section/move']);
const id=v=>typeof v==='string'&&v.length>0&&v.length<=4096;
class NativeOrganization {
 constructor(file,{localRequest,owns=()=>false,getThreads=null,notify=()=>{},clock=()=>Math.floor(Date.now()/1000)}={}){
  this.file=file;this.localRequest=localRequest;this.owns=owns;this.getThreads=getThreads;this.notify=notify;this.clock=clock;this.tail=Promise.resolve();this.volatile=new Map();
  try{
   this.state=JSON.parse(fs.readFileSync(file,'utf8'));
   if(this.state.version!==1||!this.state.sections||!this.state.projects||!this.state.profiles)throw Error('版本或格式無效');
  }catch(error){
   if(error.code!=='ENOENT')throw Error('無法讀取本機對話分類；原始檔案已保留：'+error.message);
   this.state={version:1,sections:{},projects:{},profiles:{}};
  }
 }
 handles(method){return methods.has(method);}
 profile(state,profile,create=false){
  if(!id(profile))throw Error('SSH 主機識別碼無效。');
  const key=hash(profile);
  if(!own(state.profiles,key)&&create)set(state.profiles,key,{profile,threads:{},orders:{}});
  return state.profiles[key];
 }
 entry(profile,threadId){
  if(!id(profile))return null;
  const ephemeral=this.volatile.get(hash([profile,threadId]));if(ephemeral)return ephemeral;
  const p=this.profile(this.state,profile);return p&&own(p.threads,threadId)?p.threads[threadId]:null;
 }
 transaction(edit){
  const next=copy(this.state);edit(next);
  fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
  const temp=this.file+'.tmp-'+crypto.randomUUID();
  try{fs.writeFileSync(temp,JSON.stringify(next),{flag:'wx',mode:0o600});fs.renameSync(temp,this.file);}
  catch(error){try{fs.rmSync(temp,{force:true});}catch{}throw error;}
  this.state=next;
 }
 serial(action){const pending=this.tail.then(action);this.tail=pending.catch(()=>{});return pending;}
 assertOwner(profile,threadId){
  if(!id(threadId)||!this.owns(profile,threadId))throw Error('此對話不屬於目前 OpenCodex 主機。');
 }
 async allSections(){
  let cursor=null,items=[],seen=new Set();
  do{
   if(cursor&&seen.has(cursor))throw Error('本機分類分頁游標重複。');
   if(cursor)seen.add(cursor);
   const result=await this.localRequest('threadSection/list',{cursor,limit:100});
   if(!Array.isArray(result?.data))throw Error('本機分類清單無效。');
   items.push(...result.data);cursor=result.nextCursor||null;
   if(seen.size>=1000&&cursor)throw Error('本機分類清單過大，未套用變更。');
  }while(cursor);
  this.transaction(s=>{
   s.sections={};for(const section of items)if(id(section.id))set(s.sections,section.id,copy(section));
   for(const p of Object.values(s.profiles)){
    for(const e of Object.values(p.threads))if(e.sectionId&&!own(s.sections,e.sectionId)){e.sectionId=null;e.sectionEnteredAt=null;}
    for(const key of Object.keys(p.orders))if(!own(s.sections,key))delete p.orders[key];
   }
  });
  return items;
 }
 async projectExists(projectId){
  if(projectId==null)return;
  if(!id(projectId))throw Error('本機專案識別碼無效。');
  const result=await this.localRequest('project/read',{projectId});
  if(result?.project?.id!==projectId)throw Error('本機專案不存在。');
  this.transaction(s=>set(s.projects,projectId,copy(result.project)));
 }
 async request(profile,method,params={}){
  if(!this.handles(method))throw Error('不支援此分類操作。');
  return this.serial(async()=>{
   if(method==='thread/section/move'){
    this.assertOwner(profile,params.threadId);
    if(params.sectionId!==null&&!id(params.sectionId))throw Error('本機分類識別碼無效。');
    if(params.sectionId!==null){await this.allSections();if(!own(this.state.sections,params.sectionId))throw Error('本機分類不存在。');}
    if(params.beforeThreadId!=null){
     this.assertOwner(profile,params.beforeThreadId);
     if(params.sectionId===null||this.entry(profile,params.beforeThreadId)?.sectionId!==params.sectionId)throw Error('排序目標不在同一分類。');
    }
    if(params.beforeThreadId===params.threadId)throw Error('不能將對話移到自己之前。');
    this.transaction(s=>{
     const p=this.profile(s,profile,true),before=own(p.threads,params.threadId)?p.threads[params.threadId]:{};
     for(const key of Object.keys(p.orders))p.orders[key]=p.orders[key].filter(t=>t!==params.threadId);
     const entry={...before,sectionId:params.sectionId,sectionEnteredAt:params.sectionId===null?null:before.sectionId===params.sectionId?before.sectionEnteredAt:this.clock()};
     set(p.threads,params.threadId,entry);
     if(params.sectionId!==null){
      const order=own(p.orders,params.sectionId)?p.orders[params.sectionId]:[];
      const index=params.beforeThreadId==null?order.length:order.indexOf(params.beforeThreadId);
      if(index<0)throw Error('分類排序已變更，請重新整理。');
      order.splice(index,0,params.threadId);set(p.orders,params.sectionId,order);
     }
    });
    return {};
   }
   if(method==='project/list'&&this.getThreads)return this.listProjects(profile,params);
   const removedProjects=method==='project/delete'?Object.values(this.state.profiles).flatMap(p=>Object.entries(p.threads).filter(([,e])=>e.projectId===params.projectId).map(([threadId])=>({profile:p.profile,threadId}))):[];
   const threads=method==='project/import'&&params.threads!=null?params.threads:[];
   if(!Array.isArray(threads))throw Error('匯入專案的對話清單無效。');
   for(const threadId of threads)this.assertOwner(profile,threadId);
   const localParams={...params};if(method==='project/import')delete localParams.threads;
   const result=await this.localRequest(method,localParams);
   this.transaction(s=>{
    if(result?.section?.id)set(s.sections,result.section.id,copy(result.section));
    if(result?.project?.id)set(s.projects,result.project.id,copy(result.project));
    if(method==='threadSection/list'&&Array.isArray(result?.data)){
     const complete=!params.cursor&&!result.nextCursor;if(complete)s.sections={};
     for(const section of result.data)if(id(section.id))set(s.sections,section.id,copy(section));
     if(complete)this.pruneSections(s);
    }
    if(method==='project/list'&&Array.isArray(result?.data)){
     const complete=!params.cursor&&!result.nextCursor;if(complete)s.projects={};
     for(const project of result.data)if(id(project.id))set(s.projects,project.id,copy(project));
     if(complete)this.pruneProjects(s);
    }
    if(method==='threadSection/delete'){delete s.sections[params.sectionId];this.pruneSections(s);}
    if(method==='project/delete'){delete s.projects[params.projectId];this.pruneProjects(s);}
    if(method==='project/import'&&threads.length){
     if(!id(result?.project?.id))throw Error('本機專案匯入未回傳識別碼。');
     const p=this.profile(s,profile,true);
     for(const threadId of threads)set(p.threads,threadId,{...(own(p.threads,threadId)?p.threads[threadId]:{}),projectId:result.project.id});
    }
   });
   if(method==='project/import')for(const threadId of threads)this.notify(profile,{method:'thread/project/updated',params:{threadId,projectId:result.project.id}});
   for(const removed of removedProjects)this.notify(removed.profile,{method:'thread/project/updated',params:{threadId:removed.threadId,projectId:null}});
   return result?.project?{...result,project:this.projectRecord(profile,result.project)}:result;
  });
 }
 projectRecord(profile,project){
  if(!this.getThreads)return project;
  if(!id(profile))return {...project,recencyAt:null};
  let recencyAt=null;
  for(const record of this.getThreads(profile)||[]){
   if(record.deleted||record.archived)continue;
   const thread=record.summary||record;
   if(this.entry(profile,thread.id)?.projectId!==project.id)continue;
   const time=Number(thread.recencyAt??thread.updatedAt??thread.createdAt);
   if(Number.isFinite(time)&&(recencyAt===null||time>recencyAt))recencyAt=time;
  }
  return {...project,recencyAt};
 }
 async listProjects(profile,params){
  const all=[],seen=new Set();let cursor=null;
  do{
   if(cursor&&seen.has(cursor))throw Error('本機專案分頁游標重複。');
   if(cursor)seen.add(cursor);
   const result=await this.localRequest('project/list',{cursor,limit:100,sortKey:'position',sortDirection:'asc'});
   if(!Array.isArray(result?.data))throw Error('本機專案清單無效。');
   all.push(...result.data);cursor=result.nextCursor||null;
   if(seen.size>=1000&&cursor)throw Error('本機專案清單過大，未完整讀取。');
  }while(cursor);
  this.transaction(s=>{s.projects={};for(const project of all)if(id(project.id))set(s.projects,project.id,copy(project));this.pruneProjects(s);});
  const signature=hash([profile,params.sortKey||'position',params.sortDirection||null]).slice(0,20);
  let offset=0;
  if(params.cursor){const parts=String(params.cursor).split(':');if(parts.length!==3||parts[0]!=='projects'||parts[1]!==signature||!/^[0-9]+$/.test(parts[2]))throw Error('專案分頁已變更，請重新整理。');offset=Number(parts[2]);if(!Number.isSafeInteger(offset))throw Error('專案分頁游標無效。');}
  const recent=params.sortKey==='recencyAt',direction=params.sortDirection?(params.sortDirection==='asc'?1:-1):(recent?-1:1);
  const data=all.map(p=>this.projectRecord(profile,p)).sort((a,b)=>{
   if(recent){if(a.recencyAt===null&&b.recencyAt!==null)return 1;if(b.recencyAt===null&&a.recencyAt!==null)return -1;}
   return ((Number(recent?a.recencyAt:a.position)-Number(recent?b.recencyAt:b.position))||String(a.id).localeCompare(String(b.id)))*direction;
  });
  const limit=Math.max(1,Math.min(Number(params.limit)||25,100));
  return {data:data.slice(offset,offset+limit),nextCursor:offset+limit<data.length?'projects:'+signature+':'+(offset+limit):null};
 }
 pruneSections(s){
  for(const p of Object.values(s.profiles)){
   for(const e of Object.values(p.threads))if(e.sectionId&&!own(s.sections,e.sectionId)){e.sectionId=null;e.sectionEnteredAt=null;}
   for(const key of Object.keys(p.orders))if(!own(s.sections,key))delete p.orders[key];
  }
 }
 pruneProjects(s){
  for(const p of Object.values(s.profiles))for(const e of Object.values(p.threads))if(e.projectId&&!own(s.projects,e.projectId))e.projectId=null;
 }
 // A pure project reassignment belongs to the Mac. Obtain a fresh peer thread
 // using read: native metadata/update rejects a request with no patch fields.
 remoteMethod(method,params={}){
  return method==='thread/metadata/update'&&params.projectId!=null&&Object.keys(params).every(k=>k==='threadId'||k==='projectId')?'thread/read':method;
 }
 async prepareThread(profile,method,params={}){
  if(method==='thread/start'&&own(params,'projectId'))await this.projectExists(params.projectId);
  if(method==='thread/metadata/update'&&params.projectId!=null){
   this.assertOwner(profile,params.threadId);
   if(params.projectId!=='')await this.projectExists(params.projectId);
  }
  const result={...params};delete result.projectId;delete result.sectionId;
  return result;
 }
 captureThread(profile,method,params={},thread){
  if(!thread?.id)return thread;
  if(method==='thread/start'||method==='thread/fork'){
   const projectId=method==='thread/start'?(params.projectId??null):(this.entry(profile,params.threadId)?.projectId??null);
   const entry={projectId,sectionId:null,sectionEnteredAt:null};
   if(thread.ephemeral)this.volatile.set(hash([profile,thread.id]),entry);
   else this.transaction(s=>{const p=this.profile(s,profile,true);set(p.threads,thread.id,{...(own(p.threads,thread.id)?p.threads[thread.id]:{}),...entry});});
  }
  if(method==='thread/metadata/update'&&params.projectId!=null){
   this.assertOwner(profile,params.threadId);
   if(thread.id!==params.threadId)throw Error('遠端回傳的對話識別碼不符。');
   const projectId=params.projectId===''?null:params.projectId;
   if(projectId!==null&&!own(this.state.projects,projectId))throw Error('本機專案已不存在，請重新整理。');
   const entry={...(this.entry(profile,thread.id)||{}),projectId};
   if(thread.ephemeral)this.volatile.set(hash([profile,thread.id]),entry);
   else this.transaction(s=>{const p=this.profile(s,profile,true);set(p.threads,thread.id,entry);});
   this.notify(profile,{method:'thread/project/updated',params:{threadId:thread.id,projectId}});
  }
  return this.projectThread(profile,thread);
 }
 projectThread(profile,thread){
  if(!thread?.id)return thread;
  const e=this.entry(profile,thread.id),section=e?.sectionId&&own(this.state.sections,e.sectionId)?this.state.sections[e.sectionId]:null;
  return {...thread,projectId:e?.projectId&&own(this.state.projects,e.projectId)?e.projectId:null,section:section?copy(section):null,sectionEnteredAt:section?e.sectionEnteredAt??null:null};
 }
 projectNotification(profile,message){
  if(!message?.params)return message;
  if(message.params.thread)return {...message,params:{...message.params,thread:this.projectThread(profile,message.params.thread)}};
  if(message.method==='thread/project/updated')return {...message,params:{...message.params,projectId:this.projectThread(profile,{id:message.params.threadId}).projectId??null}};
  return message;
 }
 projectResult(profile,result){
  if(!result||typeof result!=='object')return result;
  if(result.thread)return {...result,thread:this.projectThread(profile,result.thread)};
  return result;
 }
 removeThread(profile,threadId){
  this.volatile.delete(hash([profile,threadId]));
  this.transaction(s=>{const p=this.profile(s,profile);if(!p)return;delete p.threads[threadId];for(const key of Object.keys(p.orders))p.orders[key]=p.orders[key].filter(t=>t!==threadId);});
 }
 remoteListParams(params={}){
  const query={...params};delete query.sectionId;delete query.projectId;
  if(query.sortKey==='section_position')query.sortKey='created_at';
  return query;
 }
 // fetchPage must already apply host ownership and local cwd filtering. Do not
 // pass unfiltered peer rows here: sections are not an authorization boundary.
 async listPage(profile,method,params={},fetchPage){
  // A fresh offline install has no selected SSH profile or owned threads yet.
  if(!id(profile))return {data:[],backwardsCursor:null,nextCursor:null};
  const query=this.remoteListParams(params);delete query.cursor;query.limit=100;
  const signature=hash([profile,method,{...params,cursor:undefined,limit:undefined}]).slice(0,20);
  let offset=0;
  if(params.cursor){
   const parts=String(params.cursor).split(':');
   if(parts.length!==3||parts[0]!=='organization'||parts[1]!==signature||!/^\d+$/.test(parts[2]))throw Error('對話分類分頁已變更，請重新整理。');
   offset=Number(parts[2]);if(!Number.isSafeInteger(offset))throw Error('對話分頁游標無效。');
  }
  const rows=[],seen=new Set(),ids=new Set();let cursor=null;
  do{
   if(cursor&&seen.has(cursor))throw Error('遠端對話分頁游標重複。');
   if(cursor)seen.add(cursor);
   const result=await fetchPage({...query,cursor});
   if(!Array.isArray(result?.data))throw Error('對話清單無效。');
   for(const row of result.data){
    const thread=row?.thread||row;if(!thread?.id||!this.owns(profile,thread.id))continue;
    if(ids.has(thread.id))continue;ids.add(thread.id);
    const projected=this.projectThread(profile,thread);
    if(own(params,'sectionId')&&(projected.section?.id??null)!==(params.sectionId??null))continue;
    if(own(params,'projectId')&&(projected.projectId??null)!==(params.projectId??null))continue;
    rows.push(row.thread?{...row,thread:projected}:projected);
   }
   cursor=result.nextCursor||null;
   if(seen.size>=1000&&cursor)throw Error('對話清單過大，尚未完整讀取。');
  }while(cursor);
  const p=this.profile(this.state,profile),sort=params.sortKey||'created_at';
  // The native app-server defaults section position to ASC, unlike date sorts.
  const direction=params.sortDirection?(params.sortDirection==='asc'?1:-1):(sort==='section_position'?1:-1);
  const field={created_at:'createdAt',updated_at:'updatedAt',recency_at:'recencyAt'}[sort]||'createdAt';
  const positions=new Map();for(const [section,order] of Object.entries(p?.orders||{}))order.forEach((t,i)=>positions.set(t,{section,index:i}));
  rows.sort((a,b)=>{
   a=a.thread||a;b=b.thread||b;
   if(sort==='section_position'){
    const left=positions.get(a.id),right=positions.get(b.id);
    if(left&&right&&left.section===right.section)return (left.index-right.index)*direction;
   }
   const n=Number(a[field]??a.updatedAt??a.createdAt??0)-Number(b[field]??b.updatedAt??b.createdAt??0);
   return (n||String(a.id).localeCompare(String(b.id)))*direction;
  });
  const limit=Math.max(1,Math.min(Number(params.limit)||25,100));
  return {data:rows.slice(offset,offset+limit),backwardsCursor:null,nextCursor:offset+limit<rows.length?'organization:'+signature+':'+(offset+limit):null};
 }
}
module.exports={NativeOrganization};
