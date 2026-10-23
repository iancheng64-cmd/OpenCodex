'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
// A remote app-server drains queue/add itself, bypassing the Mac run/tool gate.
// Keep the native protocol, but dispatch through the same validated turn/start.
class NativeQueue{
 constructor({file,context,start,emit,onError,selection=()=>({})}){
  Object.assign(this,{file,context,startTurn:start,emit,onError,selection});this.starting=false;this.timer=null;
  this.data={};if(fs.existsSync(file))this.data=JSON.parse(fs.readFileSync(file,'utf8'));
 }
 key(profile,threadId){return JSON.stringify([profile,threadId]);}
 entry(profile,threadId){return this.data[this.key(profile,threadId)]??={profile,threadId,items:[],paused:false,inflight:null};}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 changed(threadId){this.emit({method:'thread/queue/changed',params:{threadId}});}
 clean(item){const {id,clientUserMessageId,input}=item;return {id,clientUserMessageId,input};}
 async request(method,p,profile){
  if(!profile||!p.threadId)throw Error('佇列缺少主機或對話。');
  const e=this.entry(profile,p.threadId),find=()=>{const item=e.items.find(i=>i.id===p.queuedSubmissionId);if(!item)throw Error('排隊訊息不存在或已送出。');return item;};
  if(method==='thread/queue/list'){
   const n=p.cursor?e.items.findIndex(i=>i.id===p.cursor)+1:0;if(p.cursor&&!n)throw Error('無效佇列分頁。');
   const limit=Math.max(1,Math.min(100,p.limit||100)),data=e.items.slice(n,n+limit).map(i=>this.clean(i));
   return {data,nextCursor:n+data.length<e.items.length?data.at(-1).id:null};
  }
  if(method==='thread/queue/start')return this.dispatch(e,p.queuedSubmissionId);
  if(method==='thread/queue/add'){
   if(!p.clientUserMessageId||!Array.isArray(p.input)||!p.input.length)throw Error('排隊訊息內容不完整。');
   const previous=e.items.find(i=>i.clientUserMessageId===p.clientUserMessageId);
   if(previous)return {queuedSubmission:this.clean(previous)};
   const item={id:crypto.randomUUID(),clientUserMessageId:p.clientUserMessageId,input:p.input,selection:structuredClone(this.selection(p.threadId))};e.items.push(item);this.save();this.changed(e.threadId);this.kick();return {queuedSubmission:this.clean(item)};
  }
  if(method==='thread/queue/delete'){
   const index=e.items.findIndex(i=>i.id===p.queuedSubmissionId);
   if(index<0)return {deleted:false};
   if(this.starting&&e.inflight===p.queuedSubmissionId)throw Error('訊息正在送出，請使用停止工作。');
   e.items.splice(index,1);if(e.inflight===p.queuedSubmissionId)e.inflight=null;this.save();this.changed(e.threadId);return {deleted:true};
  }
  if(method==='thread/queue/update'){
   const item=find();if(e.inflight===item.id)throw Error('訊息可能已送出，請先檢查對話再刪除或重新加入。');
   if(!Array.isArray(p.input)||!p.input.length)throw Error('訊息內容不可為空。');
   item.input=p.input;this.save();this.changed(e.threadId);return {queuedSubmission:this.clean(item)};
  }
  if(method==='thread/queue/reorder'){
   const ids=p.queuedSubmissionIds;
   if(!Array.isArray(ids)||new Set(ids).size!==e.items.length||ids.length!==e.items.length||ids.some(id=>!e.items.some(i=>i.id===id)))throw Error('重新排序必須包含每一則排隊訊息，且不可重複。');
   e.items=ids.map(id=>e.items.find(i=>i.id===id));this.save();this.changed(e.threadId);return {};
  }
  throw Error('不支援的排隊操作。');
 }
 kick(){
  clearTimeout(this.timer);this.timer=setTimeout(()=>{
   const c=this.context();if(!c.connected||c.busy||this.starting)return;
   const e=Object.values(this.data).find(e=>e.profile===c.profile&&e.items.length&&!e.paused&&!e.inflight&&c.ready(e.threadId));
   if(e)void this.dispatch(e).catch(error=>this.onError?.(error));
  },50);this.timer.unref?.();
 }
 async dispatch(e,id){
  const c=this.context();
  if(!c.connected||c.profile!==e.profile)throw Error('請先連接此佇列的 SSH 主機。');
  if(c.busy||this.starting)throw Error('目前工作尚未結束，排隊訊息已保留。');
  if(!c.ready(e.threadId))throw Error('請先重新開啟此對話，再開始排隊訊息。');
  if(e.inflight)throw Error('上一則訊息可能已送出。請檢查對話，刪除該排隊項目後再開始，避免重複執行。');
  const item=id?e.items.find(i=>i.id===id):e.items[0];if(!item)throw Error('沒有待執行的排隊訊息。');
  this.starting=true;e.inflight=item.id;e.paused=false;this.save();
  try{
   const result=await this.startTurn(e.threadId,item.input,item.selection||{});
   e.items=e.items.filter(i=>i.id!==item.id);e.inflight=null;this.save();this.changed(e.threadId);return result;
  }catch(error){
   // A transport failure may follow successful acceptance. Never auto-retry.
   e.paused=true;this.save();this.changed(e.threadId);throw error;
  }finally{this.starting=false;this.kick();}
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
