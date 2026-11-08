'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
// A remote app-server drains queue/add itself, bypassing the Mac run/tool gate.
// Keep the native protocol, but dispatch through the same validated turn/start.
// The window also drives the queue (thread/queue/start when a turn ends, 引導 = steer + delete),
// so starting is idempotent: a message that is being sent, or was just sent, reports the same
// turn instead of failing and leaving a copy in the list that could be sent twice.
const RECENT_MS=15*60*1000;
class NativeQueue{
 constructor({file,context,start,emit,onError,selection=()=>({})}){
  Object.assign(this,{file,context,startTurn:start,emit,onError,selection});this.timer=null;
  this.active=new Map();this.recent=new Map();
  this.data={};if(fs.existsSync(file))this.data=JSON.parse(fs.readFileSync(file,'utf8'));
 }
 // Any conversation is sending a queued message (connection-wide gates).
 get starting(){return this.active.size>0;}
 startingFor(threadId){return [...this.active.values()].some(a=>a.threadId===threadId);}
 key(profile,threadId){return JSON.stringify([profile,threadId]);}
 entry(profile,threadId){return this.data[this.key(profile,threadId)]??={profile,threadId,items:[],paused:false,inflight:null};}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 changed(threadId){this.emit({method:'thread/queue/changed',params:{threadId}});}
 clean(item){const {id,clientUserMessageId,input}=item;return {id,clientUserMessageId,input};}
 sending(e){const a=this.active.get(this.key(e.profile,e.threadId));return a?a.id:null;}
 // Listed items exclude the one being sent right now: it belongs to the conversation already.
 visible(e){const id=this.sending(e);return e.items.filter(i=>i.id!==id);}
 async request(method,p,profile){
  if(!profile||!p.threadId)throw Error('佇列缺少主機或對話。');
  const e=this.entry(profile,p.threadId),find=()=>{const item=e.items.find(i=>i.id===p.queuedSubmissionId);if(!item)throw Error('排隊訊息不存在或已送出。');return item;};
  if(method==='thread/queue/list'){
   const items=this.visible(e);
   const n=p.cursor?items.findIndex(i=>i.id===p.cursor)+1:0;if(p.cursor&&!n)throw Error('無效佇列分頁。');
   const limit=Math.max(1,Math.min(100,p.limit||100)),data=items.slice(n,n+limit).map(i=>this.clean(i));
   return {data,nextCursor:n+data.length<items.length?data.at(-1).id:null};
  }
  if(method==='thread/queue/start')return this.dispatch(e,p.queuedSubmissionId);
  if(method==='thread/queue/add'){
   if(!p.clientUserMessageId||!Array.isArray(p.input)||!p.input.length)throw Error('排隊訊息內容不完整。');
   const previous=e.items.find(i=>i.clientUserMessageId===p.clientUserMessageId);
   if(previous)return {queuedSubmission:this.clean(previous)};
   const item={id:crypto.randomUUID(),clientUserMessageId:p.clientUserMessageId,input:p.input,selection:structuredClone(this.selection(p.threadId))};e.items.push(item);this.save();this.changed(e.threadId);this.kick();return {queuedSubmission:this.clean(item)};
  }
  if(method==='thread/queue/delete'){
   const id=p.queuedSubmissionId;
   // Sent, or being sent: the window removes the entry after 引導; nothing is left to delete.
   if(this.sending(e)===id){await this.active.get(this.key(e.profile,e.threadId)).promise.catch(()=>{});}
   const index=e.items.findIndex(i=>i.id===id);
   if(index<0)return {deleted:this.recent.has(id)};
   e.items.splice(index,1);if(e.inflight===id)e.inflight=null;this.save();this.changed(e.threadId);return {deleted:true};
  }
  if(method==='thread/queue/update'){
   const item=find();if(e.inflight===item.id)throw Error('訊息可能已送出，請先檢查對話再刪除或重新加入。');
   if(!Array.isArray(p.input)||!p.input.length)throw Error('訊息內容不可為空。');
   item.input=p.input;this.save();this.changed(e.threadId);return {queuedSubmission:this.clean(item)};
  }
  if(method==='thread/queue/reorder'){
   const ids=p.queuedSubmissionIds,items=this.visible(e);
   if(!Array.isArray(ids)||new Set(ids).size!==items.length||ids.length!==items.length||ids.some(id=>!items.some(i=>i.id===id)))throw Error('重新排序必須包含每一則排隊訊息，且不可重複。');
   const sendingId=this.sending(e);
   e.items=[...e.items.filter(i=>i.id===sendingId),...ids.map(id=>items.find(i=>i.id===id))];this.save();this.changed(e.threadId);return {};
  }
  throw Error('不支援的排隊操作。');
 }
 kick(){
  clearTimeout(this.timer);this.timer=setTimeout(()=>{
   // busy may be per conversation: parallel conversations dispatch independently.
   const c=this.context();if(!c.connected)return;
   const busy=id=>typeof c.busy==='function'?c.busy(id):c.busy;
   for(const e of Object.values(this.data)){
    if(e.profile!==c.profile||!e.items.length||e.paused||e.inflight||this.sending(e)||busy(e.threadId)||!c.ready(e.threadId))continue;
    void this.dispatch(e).catch(error=>this.onError?.(error));
   }
  },50);this.timer.unref?.();
 }
 async dispatch(e,id){
  const key=this.key(e.profile,e.threadId),active=this.active.get(key);
  // The same message is already on its way: share that outcome rather than failing.
  if(active&&(!id||active.id===id))return active.promise;
  if(id&&this.recent.has(id))return this.recent.get(id).result;
  const c=this.context();
  if(!c.connected||c.profile!==e.profile)throw Error('請先連接此佇列的 SSH 主機。');
  if(active||(typeof c.busy==='function'?c.busy(e.threadId):c.busy))throw Error('目前工作尚未結束，排隊訊息已保留。');
  if(!c.ready(e.threadId))throw Error('請先重新開啟此對話，再開始排隊訊息。');
  if(e.inflight)throw Error('上一則訊息可能已送出。請檢查對話，刪除該排隊項目後再開始，避免重複執行。');
  const item=id?e.items.find(i=>i.id===id):e.items[0];if(!item)throw Error(id?'排隊訊息不存在或已送出。':'沒有待執行的排隊訊息。');
  const promise=this.run(e,item);
  this.active.set(key,{id:item.id,threadId:e.threadId,promise});
  try{return await promise;}finally{this.active.delete(key);this.kick();}
 }
 async run(e,item){
  e.inflight=item.id;e.paused=false;this.save();this.changed(e.threadId);
  try{
   // The window recognises its own message by clientUserMessageId; without it the entry stays
   // listed as queued after the turn started, and 引導 would send it a second time.
   const result=await this.startTurn(e.threadId,item.input,item.selection||{},item.clientUserMessageId);
   e.items=e.items.filter(i=>i.id!==item.id);e.inflight=null;this.save();
   this.recent.set(item.id,{at:Date.now(),result});for(const [id,r] of this.recent)if(Date.now()-r.at>RECENT_MS)this.recent.delete(id);
   this.changed(e.threadId);return result;
  }catch(error){
   // A transport failure may follow successful acceptance. Never auto-retry.
   e.paused=true;this.save();this.changed(e.threadId);throw error;
  }
 }
 completed(profile,threadId,status){
  const e=this.data[this.key(profile,threadId)];
  if(e&&status!=='completed'){e.paused=true;this.save();}
  this.kick();
 }
 pause(profile,threadId){const e=this.entry(profile,threadId);e.paused=true;this.save();}
 close(){clearTimeout(this.timer);}
}
module.exports={NativeQueue};
