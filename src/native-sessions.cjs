'use strict';
// Parallel conversations. Every SSH runtime runs one model turn at a time, so the pool opens
// extra runtimes ("workers") to the same host and routes each conversation to a runtime that
// is free for it. The primary runtime keeps its other roles (quota, providers, listing, peers).
// A conversation is admitted on at most one runtime: moving it releases it from the previous
// owner first, and the engine keeps that idle copy only until its unload delay elapses.
const LEASE=new Set(['thread/start','thread/resume','thread/fork','thread/shellCommand','turn/start','review/start','thread/settings/update']);
const limitError=total=>Object.assign(Error('已達並行對話上限（'+total+'）；請等其中一個對話完成，或在 opencodex.json 調高 maxParallelSessions。'),{code:'OPENCODEX_PARALLEL_LIMIT'});
class SessionPool{
 constructor({primary,limit,spawn,release,audit=()=>{}}){
  Object.assign(this,{primary,limit,spawn,release,audit});
  this.workers=new Set();this.spawning=0;this.migrating=new Map();
 }
 live(){const p=this.primary();return [p,...this.workers].filter(r=>r&&!r.closed);}
 alive(r){return !!r&&!r.closed&&(r===this.primary()||this.workers.has(r));}
 ownerOf(id){return id?this.live().find(r=>r.openCodexThreads?.has(id))||null:null;}
 // Non-ephemeral work for another conversation occupies a runtime. Ephemeral title work is
 // short and the workspace lease already queues behind it.
 occupied(r,id){
  const run=r.run,prep=r.openCodexPreparing;
  return !!(run&&!run.ephemeral&&run.threadId!==id)||!!(prep&&!prep.ephemeral&&prep.threadId!==id);
 }
 running(r,id){return !!r.run&&!r.run.ephemeral&&r.run.threadId!==id;}
 free(id,{resume=false}={}){const open=this.live().filter(r=>resume?!this.running(r,id):!this.occupied(r,id));return open.find(r=>r.openCodexThreads?.has(id))||open.sort((a,b)=>(a.openCodexThreads?.size||0)-(b.openCodexThreads?.size||0))[0]||null;}
 capacity(){return this.workers.size+this.spawning<this.limit();}
 canStart(id){const owner=this.ownerOf(id);return !!(owner&&!this.occupied(owner,id))||!!this.free(id)||this.capacity();}
 idleWorkers(){return [...this.workers].filter(r=>!r.closed&&!r.run&&!r.openCodexPreparing&&!r.openCodexWorkspaceTransition);}
 state(){return {workers:[...this.workers].filter(r=>!r.closed).length,spawning:this.spawning,limit:this.limit()+1,running:this.live().filter(r=>r.run&&!r.run.ephemeral).length};}
 async open(){
  this.spawning++;
  try{
   const r=await this.spawn();
   if(!r||r.closed)throw Error('並行對話的 SSH 連線未成功建立。');
   this.workers.add(r);this.audit('session-worker-opened',{runtimeId:r.id,workers:this.workers.size});
   return r;
  }finally{this.spawning--;}
 }
 forget(r){if(this.workers.delete(r))this.audit('session-worker-closed',{runtimeId:r.id,workers:this.workers.size});}
 needsRouting(method,params){return LEASE.has(method)||!!params?.threadId;}
 // Chooses the runtime for one native request. `lease` methods start or load work and need a
 // runtime that is free for this conversation; other thread requests follow the conversation.
 async select(method,params,{lease=false,ephemeral=false}={}){
  const primary=this.primary();
  if(!primary||primary.closed)return {runtime:primary};
  const id=params?.threadId,owner=this.ownerOf(id);
  if(!lease)return {runtime:owner||primary};
  if(method==='thread/resume'){
   // The conversation stays where it is loaded. Its owner running another conversation can
   // still show it read-only; the next turn moves it.
   if(owner)return this.running(owner,id)?{runtime:owner,attach:true}:{runtime:owner};
   const free=this.free(id,{resume:true});
   if(free)return {runtime:free};
   if(this.capacity())return {runtime:await this.open()};
   return {runtime:primary,cached:true};
  }
  if(owner&&!this.occupied(owner,id))return {runtime:owner};
  const free=this.free(id);
  const target=free||(ephemeral?primary:this.capacity()?await this.open():null);
  if(!target)throw limitError(this.limit()+1);
  if(owner&&owner!==target)await this.release(owner,id);
  return {runtime:target};
 }
}
module.exports={SessionPool,LEASE,limitError};
