'use strict';
const {createHash}=require('node:crypto');
const {turnMetadata}=require('./native-run-context.cjs');
const id=value=>typeof value==='string'&&value.length>0&&value.length<=1024;
const key=(thread,turn,call)=>JSON.stringify([thread,turn,call]);
function argumentsHash(value){
 let size=0;
 const visit=(v,depth)=>{
  if(depth>64||++size>100000)throw Error('Guardian arguments exceed limits');
  if(v===null||typeof v==='boolean'||typeof v==='string')return v;
  if(typeof v==='number'&&Number.isFinite(v))return v;
  if(Array.isArray(v))return v.map(x=>visit(x,depth+1));
  if(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v))){
   const out=Object.create(null);
   for(const name of Object.keys(v).sort())out[name]=visit(v[name],depth+1);
   return out;
  }
  throw Error('Invalid Guardian arguments');
 };
 const text=JSON.stringify(visit(value,0));
 if(Buffer.byteLength(text)>1024*1024)throw Error('Guardian arguments exceed limits');
 return createHash('sha256').update(text).digest('hex');
}
// Events enter only from the authenticated app-server connection. A tool's
// metadata identifies a call; it never supplies its own approval decision.
// Keep consumed/denied entries until the owner closes, preventing event replays.
class NativeGuardian{
 constructor({sessionId,server,current,active,waitMs=3000,maxEntries=4096}){
  if(!id(sessionId)||!id(server))throw Error('Missing Guardian owner');
  Object.assign(this,{sessionId,server,current,active,waitMs,maxEntries});
  this.records=new Map();this.ended=new Set();this.waiters=new Set();this.closed=false;
 }
 live(){return !this.closed&&this.current();}
 wake(){for(const check of [...this.waiters])check();}
 record(thread,turn,call){
  if(!this.live()||![thread,turn,call].every(id)||this.ended.has(key(thread,turn,null)))return;
  const k=key(thread,turn,call);
  if(!this.records.has(k)){
   // Never evict a consumed receipt to make room for a replay.
   if(this.records.size>=this.maxEntries){this.close();return;}
   this.records.set(k,{thread,turn,call});
  }
  return this.records.get(k);
 }
 notification({method,params:p={}}){
  if(!this.live())return;
  if(method==='turn/completed'){this.cancel(p.threadId,p.turn?.id||p.turnId);return;}
  if(!['item/started','item/completed','item/autoApprovalReview/started','item/autoApprovalReview/completed'].includes(method))return;
  const item=p.item,review=method.startsWith('item/autoApprovalReview/');
  if(review?p.action?.type!=='mcpToolCall':item?.type!=='mcpToolCall')return;
  const r=this.record(p.threadId,p.turnId,review?p.targetItemId:item.id);if(!r)return;
  if(r.invalid||r.used||r.finished)return;
  try{
   if(!review){
    if(method==='item/completed')r.finished=true;
    else{
     const hash=argumentsHash(item.arguments),same=item.server===this.server&&id(item.tool);
     if(!same||(r.hash&&(r.hash!==hash||r.tool!==item.tool)))r.invalid=true;
     else{r.hash=hash;r.tool=item.tool;}
    }
   }else{
    const a=p.action;
    if(a.server!==this.server||!id(a.toolName)||!id(p.reviewId)||
      (r.reviewId&&r.reviewId!==p.reviewId)||(r.reviewTool&&r.reviewTool!==a.toolName))r.invalid=true;
    else if(method==='item/autoApprovalReview/started'){
     if(p.review?.status!=='inProgress'||r.decision)r.invalid=true;
     else{r.reviewId=p.reviewId;r.reviewTool=a.toolName;r.started=true;}
    }else{
     if(!r.started||r.decision||p.decisionSource!=='agent')r.invalid=true;
     else r.decision=p.review?.status==='approved'?'approved':'denied';
    }
   }
   if(r.tool&&r.reviewTool&&r.tool!==r.reviewTool)r.invalid=true;
  }catch{r.invalid=true;}
  this.wake();
 }
 async authorize(run,call,identity={threadId:run?.threadId,turnId:run?.turnId},eventIdentity=identity){
  if(!this.live()||!this.active(run)||call.signal?.aborted)return false;
  let value,hash;
  try{value=turnMetadata(call.metadata);hash=argumentsHash(call.arguments);}
  catch{return false;}
  const meta=call.metadata,thread=identity.threadId,turn=identity.turnId;
  if(value.session_id!==this.sessionId||value.thread_id!==thread||value.turn_id!==turn||
    value.auto_review_enabled!==true||!id(meta.callId)||!id(call.name))return false;
  // Inline reviews forward authenticated events on the parent turn, while
  // MCP metadata retains the verified review delegate's thread and turn.
  // This mapping is supplied by the owner registry, never by tool metadata.
  const eventThread=eventIdentity.threadId,eventTurn=eventIdentity.turnId;
  const r=this.record(eventThread,eventTurn,meta.callId);
  if(!r||r.claimed||r.used||r.invalid||r.finished)return false;
  r.claimed=true;
  return new Promise(resolve=>{
   let timer,monitor,done=false;
   const finish=allowed=>{
    if(done)return;done=true;r.used=true;
    clearTimeout(timer);clearInterval(monitor);this.waiters.delete(check);
    call.signal?.removeEventListener('abort',abort);resolve(allowed);
   };
   const check=()=>{
    if(!this.live()||!this.active(run)||call.signal?.aborted||r.invalid||r.finished||
      this.ended.has(key(thread,turn,null))||this.ended.has(key(eventThread,eventTurn,null))||r.decision==='denied')return finish(false);
    if(r.hash&&(r.hash!==hash||r.tool!==call.name))return finish(false);
    if(r.hash&&r.started&&r.decision==='approved')finish(true);
   };
   const abort=()=>finish(false);
   timer=setTimeout(abort,this.waitMs);
   monitor=setInterval(check,100);
   this.waiters.add(check);call.signal?.addEventListener('abort',abort,{once:true});check();
  });
 }
 cancel(thread,turn){
  if(!id(thread)||!id(turn))return;
  this.ended.add(key(thread,turn,null));
  for(const r of this.records.values())if(r.thread===thread&&r.turn===turn)r.finished=true;
  this.wake();
 }
 close(){this.closed=true;this.wake();this.records.clear();this.ended.clear();}
}
module.exports={NativeGuardian};
