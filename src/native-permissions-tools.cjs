'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
const inputMethod='opencodex/input/read',maxResponseBytes=32*1048576;
// One fixed permission profile, workspace and agent owner per sandbox process.
// validate must check the current owner and local configuration before any dispatch.
class NativePermissionTools{
 constructor({binary,node,worker=path.join(__dirname,'native-permissions-worker.cjs'),abRoot,resourcesPath,cwd,profile,env,validate,timeoutMs=180000,startupTimeoutMs=20000}){
  if(typeof validate!=='function'||typeof profile!=='string'||!profile||profile.length>200||profile.includes('\0')||!path.isAbsolute(cwd))throw Error('Invalid sandbox authority');
  Object.assign(this,{binary,node,worker,abRoot,resourcesPath,cwd,profile,validate,timeoutMs,startupTimeoutMs});
  this.env={...env};this.calls=new Map();this.jobs=new Map();this.serial=0;this.closed=false;
 }
 async current(){
  if(this.closed)throw Error('權限工具工作階段已關閉。');
  let valid;
  try{valid=await this.validate();}catch(error){this.close(error);throw error;}
  if(this.closed||valid!==true){const error=Error('權限設定或工具歸屬已變更，請重新開啟對話。');this.close(error);throw error;}
 }
 async ready(){
  await this.current();
  if(!this.pending)this.pending=this.start();
  return this.pending;
 }
 async start(){
  await this.current();
  const env={...this.env};delete env.CODEX_APP_SERVER_WS_URL;delete env.CODEX_EXEC_SERVER_URL;
  const child=spawn(this.binary,['sandbox','--include-managed-config','--permission-profile',this.profile,'-C',this.cwd,'--',this.node,this.worker,JSON.stringify({abRoot:this.abRoot,resourcesPath:this.resourcesPath})],
   {cwd:this.cwd,env,detached:true,stdio:'pipe'});
  this.child=child;this.stderr='';let buffer=Buffer.alloc(0);
  const ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
  this.startupTimer=setTimeout(()=>this.close(Error('權限工具啟動逾時。')),this.startupTimeoutMs);
  child.stderr.on('data',data=>{this.stderr=(this.stderr+data).slice(-8000);});
  child.stdin.on('error',error=>this.close(error));child.on('error',error=>this.close(error));
  child.on('close',(code,signal)=>this.close(Error('權限工具程序已結束：'+(signal||code)+(this.stderr?'\n'+this.stderr:''))));
  child.stdout.on('data',chunk=>{
   if(this.closed)return;buffer=Buffer.concat([buffer,chunk]);
   for(;;){
    const end=buffer.indexOf(10);
    if(end<0){if(buffer.length>maxResponseBytes)this.close(Error('權限工具回應過大。'));return;}
    if(end>maxResponseBytes){this.close(Error('權限工具回應過大。'));return;}
    const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
    try{this.receive(JSON.parse(line.toString('utf8')));}catch(error){this.close(error);return;}
    if(this.closed)return;
   }
  });
  const result=await ready;await this.current();return result;
 }
 receive(message){
  if(message?.ready===true){
   if(this.tools||message.cwd!==this.cwd||!Array.isArray(message.tools)||message.tools.some(n=>typeof n!=='string'||!/^mac_(fs|process)_/.test(n)))throw Error('Invalid sandbox startup');
   this.tools=new Set(message.tools);clearTimeout(this.startupTimer);this.resolveReady(message);return;
  }
  if(message?.event){
   const {id,pid}=message;
   if(typeof id!=='string'||!Number.isInteger(pid)||pid<=1)throw Error('Invalid sandbox process identity');
   if(message.event==='process/started'){
    if(this.jobs.has(id))throw Error('Duplicate sandbox process identity');
    this.jobs.set(id,pid);
    // Record ownership before the worker is allowed to release its launch gate.
    this.child.stdin.write(JSON.stringify({event:'process/registered',id,pid})+'\n',error=>{if(error)this.close(error);});
   }else if(message.event==='process/ended'){
    if(this.jobs.get(id)!==pid)throw Error('Unknown sandbox process identity');this.jobs.delete(id);
   }else throw Error('Invalid sandbox event');
   return;
  }
  const request=this.calls.get(message?.id);
  if(!request)throw Error('Unknown sandbox response');
  this.calls.delete(message.id);request.cleanup();
  if(message.error)request.reject(Object.assign(Error(message.error.message),{code:message.error.code}));
  else if(!Object.hasOwn(message,'result'))request.reject(Error('Invalid sandbox result'));
  else request.resolve(message.result);
 }
 async call(name,args={},signal){
  if(signal?.aborted)throw Error('權限工具已取消。');
  const abort=()=>this.close(Error('權限工具已取消。'));
  signal?.addEventListener('abort',abort,{once:true});
  try{
   await this.ready();await this.current();
   if(signal?.aborted)throw Error('權限工具已取消。');
   if((!this.tools.has(name)&&name!==inputMethod)||!args||typeof args!=='object'||Array.isArray(args)||args.administrator===true)throw Error('此工具無法在目前的權限沙盒執行。');
   const id=String(++this.serial),frame=JSON.stringify({id,name,args})+'\n';
   if(Buffer.byteLength(frame)>1048576)throw Error('權限工具請求過大。');
   const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>this.close(Error('權限工具執行逾時。')),this.timeoutMs);
    this.calls.set(id,{resolve,reject,cleanup:()=>clearTimeout(timer)});
    this.child.stdin.write(frame,error=>{if(error)this.close(error);});
   });
   await this.current();return result;
  }finally{signal?.removeEventListener('abort',abort);}
 }
 async readInput(kind,file,signal){
  if(!['localImage','localAudio','skill'].includes(kind))throw Error('Invalid attachment kind');
  return this.call(inputMethod,{kind,path:file},signal);
 }
 close(reason=Error('權限工具工作階段已關閉。')){
  if(this.closed)return;this.closed=true;clearTimeout(this.startupTimer);
  this.rejectReady?.(reason);
  for(const call of this.calls.values()){call.cleanup();call.reject(reason);}this.calls.clear();
  // Only groups reported by this private worker belong to this owner.
  for(const pid of this.jobs.values())try{process.kill(-pid,'SIGKILL');}catch{}
  this.jobs.clear();
  const child=this.child;
  if(!child||child.exitCode!==null||child.signalCode)return;
  child.stdin.end();
  const stop=signal=>{if(child.exitCode===null&&!child.signalCode)try{process.kill(-child.pid,signal);}catch{}};
  const terminate=setTimeout(()=>stop('SIGTERM'),1200),kill=setTimeout(()=>stop('SIGKILL'),2200);
  terminate.unref();kill.unref();child.once('close',()=>{clearTimeout(terminate);clearTimeout(kill);});
 }
}
module.exports={NativePermissionTools};
