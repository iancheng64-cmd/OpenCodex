'use strict';
const {NativePermissionCatalog}=require('./native-permission-catalog.cjs');
const {NativePermissionTools}=require('./native-permissions-tools.cjs');
const {NativeTools}=require('./native-tools.cjs');
const {scopedRun}=require('./native-run-context.cjs');
// The SSH bridge supplies authenticated run objects; neither tool arguments nor
// profile names supplied by a model can select a permission owner.
class NativePermissionSession{
 constructor({runtime,profile,catalog,snapshot,options,current}){
  Object.assign(this,{runtime,profile,catalog,snapshot,options,active:current});
  this.cwd=runtime.localCwd;this.workers=new Map();this.retired=new WeakSet();
  this.nativeOwners=new Set();this.closed=false;this.validation=Promise.resolve();
 }
 valid(){
  return !this.closed&&!this.runtime.closed&&this.runtime.localCwd===this.cwd&&this.active();
 }
 runActive(run){
  return this.valid()&&!!run?.openCodex&&!run.cancelled&&!this.retired.has(run)&&
   !!run.threadId&&!!run.turnId&&(run.parentThreadId?
    this.runtime.openCodexSubagents?.isActive(run)===true:this.runtime.run===run);
 }
 async validate(){
  // Serialize reloads so a shared app-server never mixes catalogue snapshots.
  const check=async()=>{
   if(!this.valid())throw Error('自訂權限的工作區或連線已變更。');
   const next=await this.catalog.read(this.cwd);
   if(!this.valid())throw Error('自訂權限的工作區或連線已變更。');
   if(next.fingerprint!==this.snapshot.fingerprint)throw Object.assign(Error('自訂權限設定已變更，請重新開啟對話。'),{code:'OPENCODEX_PERMISSION_CONFIG_CHANGED'});
   return true;
  };
  const result=this.validation.then(check);
  this.validation=result.catch(()=>{});
  try{return await result;}catch(error){this.close();throw error;}
 }
 newWorker(run){
  const {binary,node,worker,abRoot,resourcesPath,env}=this.options;
  return new NativePermissionTools({binary,node,worker,abRoot,resourcesPath,env,cwd:this.cwd,profile:this.profile,
   validate:async()=>{await this.validate();return run?this.runActive(run):this.valid();}});
 }
 workerFor(run){
  if(!this.runActive(run))throw Error('自訂權限工具所屬回合已結束。');
  let worker=this.workers.get(run);
  if(!worker){
   for(const [old,value]of this.workers)if(!this.runActive(old)){value.close();this.workers.delete(old);this.retired.add(old);}
   if(this.workers.size>=16)throw Error('同時執行的權限工具工作階段已達上限。');
   worker=this.newWorker(run);this.workers.set(run,worker);
  }
  return worker;
 }
 async call(name,args,signal){
  const run=scopedRun(this.runtime);
  return this.workerFor(run).call(name,args,signal);
 }
 async readInput(kind,file,signal){
  await this.validate();
  if(!this.input)this.input=this.newWorker();
  return this.input.readInput(kind,file,signal);
 }
 native({onRequest,getRun=()=>scopedRun(this.runtime)||this.runtime.run,config={}}={}){
  if(!this.valid())throw Error('自訂權限工作階段已關閉。');
  const {binary,env,AppServerRpc}=this.options;
  const authenticatedRun=()=>{
   const run=getRun();if(!this.runActive(run))throw Error('原生工具所屬自訂權限回合已結束。');return run;
  };
  const owner=new NativeTools({binary,cwd:this.cwd,env,AppServerRpc,config,permissionProfile:this.profile,
   validate:()=>this.validate(),getRun:authenticatedRun,getApp:()=>require('./native-app-context.cjs').scopedApp(this.runtime),onRequest});
  this.nativeOwners.add(owner);return owner;
 }
 cancelRun(run){
  if(!run||typeof run!=='object')return;
  this.retired.add(run);
  for(const [candidate,worker]of this.workers){
   if(candidate===run||!run.parentThreadId){worker.close();this.workers.delete(candidate);this.retired.add(candidate);}
  }
  for(const owner of this.nativeOwners){
   owner.cancelRun(run);
   if(!run.parentThreadId){
    for(const child of owner.runOwners.values())child.close();
    owner.runOwners.clear();owner.reset();
   }
  }
 }
 close(){
  if(this.closed)return;this.closed=true;this.catalog.close();this.input?.close();
  for(const worker of this.workers.values())worker.close();this.workers.clear();
  for(const owner of this.nativeOwners)owner.close();this.nativeOwners.clear();
 }
}
class NativePermissionService{
 constructor(options){this.options=options;this.entries=new Map();this.preparing=new Map();this.closed=false;}
 async prepare(runtime,profile,signal){
  if(this.closed||runtime.closed||runtime.run||runtime.openCodexPreparing?.cancelled)throw Error('請先停止工作，再變更自訂權限。');
  if(typeof profile!=='string'||!profile||profile.startsWith(':')||profile.includes('\0'))throw Error('無效的自訂權限設定檔。');
  this.preparing.get(runtime)?.abort();
  const {binary,env,AppServerRpc}=this.options,cwd=runtime.localCwd;
  const catalog=new NativePermissionCatalog({binary,env,AppServerRpc,cwd});
  let entry,committed=false,cancelled=false;
  const abort=()=>{
   cancelled=true;entry?.close();catalog.close();
   if(this.preparing.get(runtime)===ticket)this.preparing.delete(runtime);
   signal?.removeEventListener('abort',abort);
  };
  const ticket={abort};this.preparing.set(runtime,ticket);
  const current=()=>!cancelled&&!this.closed&&!runtime.closed&&runtime.localCwd===cwd&&
   (committed?this.entries.get(runtime)===entry:this.preparing.get(runtime)===ticket);
  signal?.addEventListener('abort',abort,{once:true});
  try{
   if(signal?.aborted)throw Error('自訂權限設定已取消。');
   const snapshot=await catalog.read(cwd,signal);
   if(!current())throw Error('自訂權限設定已取消。');
   const selected=snapshot.profiles.find(p=>p.id===profile);
   if(!selected?.allowed)throw Error('自訂權限設定檔不存在，或不符合管理員要求。');
   entry=new NativePermissionSession({runtime,profile,catalog,snapshot,options:this.options,current});
   return {entry,snapshot,abort,commit:async()=>{
    if(committed)throw Error('自訂權限設定已套用。');
    try{
     await entry.validate();
     if(!current()||runtime.run)throw Error('自訂權限設定已取消，或對話已開始。');
     const previous=this.entries.get(runtime);
     this.entries.set(runtime,entry);committed=true;this.preparing.delete(runtime);
     runtime.openCodexPermissions=entry;previous?.close();
     signal?.removeEventListener('abort',abort);
     runtime.rpc?.once('closed',()=>{if(this.entries.get(runtime)===entry)this.closeRuntime(runtime);});
     return entry;
    }catch(error){abort();throw error;}
   }};
  }catch(error){abort();throw error;}
 }
 get(runtime){return this.entries.get(runtime);}
 cancel(runtime,run){this.entries.get(runtime)?.cancelRun(run);}
 closeRuntime(runtime){
  this.preparing.get(runtime)?.abort();
  const entry=this.entries.get(runtime);this.entries.delete(runtime);entry?.close();
  if(runtime.openCodexPermissions===entry)delete runtime.openCodexPermissions;
 }
 close(){
  if(this.closed)return;this.closed=true;
  for(const ticket of this.preparing.values())ticket.abort();
  for(const runtime of this.entries.keys())this.closeRuntime(runtime);
 }
}
module.exports={NativePermissionService,NativePermissionSession};
