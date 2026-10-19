'use strict';
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {EventEmitter}=require('node:events');
const MAX_LINE=2*1024*1024;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// A private stdio channel owns one native Hooks session and its descendants.
// The generated remote relay never receives this control interface.
class NativeHooksClient extends EventEmitter {
 constructor({binary,cwd,codexHome,threadId,sessionId=threadId,env=process.env,mcpCall}){
  super();Object.assign(this,{cwd,codexHome,threadId,sessionId,mcpCall});
  this.pending=new Map();this.callbacks=new Map();this.buffer='';this.stderr='';this.serial=0;
  this.process=spawn(binary,[],{cwd,env:{...env,CODEX_HOME:codexHome},stdio:['pipe','pipe','pipe']});
  this.exit=new Promise(resolve=>this.process.once('close',(code,signal)=>{
   this.closed=true;this.fail(Error('Hooks helper closed ('+code+', '+signal+')'));
   resolve({code,signal});
  }));
  this.process.on('error',error=>this.fail(error));
  this.process.stdin.on('error',error=>this.fail(error));
  this.process.stderr.on('data',data=>{this.stderr=(this.stderr+data).slice(-8192);});
  this.process.stdout.setEncoding('utf8');
  this.process.stdout.on('data',data=>{
   this.buffer+=data;
   for(;;){
    const end=this.buffer.indexOf('\n');
    if(end<0){if(Buffer.byteLength(this.buffer)>MAX_LINE)this.fail(Error('Hooks output exceeds limit'));break;}
    const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
    if(Buffer.byteLength(line)>MAX_LINE){this.fail(Error('Hooks output exceeds limit'));break;}
    try{this.message(JSON.parse(line));}catch(error){this.fail(error);break;}
   }
  });
  this.ready=this.call('init',{threadId,sessionId,cwd,codexHome},15000);
  this.ready.catch(()=>{});
 }
 fail(error){
  if(!this.failure)this.failure=error;
  for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}
  this.pending.clear();
  for(const call of this.callbacks.values())call.abort();this.callbacks.clear();
  // EOF lets the native library join foreground/background command groups.
  if(!this.process.stdin.destroyed)this.process.stdin.end();
 }
 message(message){
  if(message.id!=null){
   const p=this.pending.get(message.id);if(!p)return;
   this.pending.delete(message.id);clearTimeout(p.timer);
   message.error?p.reject(Error(message.error.message)):p.resolve(message.result);return;
  }
  if(message.method==='hooks/mcp')void this.callback(message.params);
  if(message.method==='hooks/mcpCancelled'){
   this.callbacks.get(message.params?.id)?.abort();this.callbacks.delete(message.params?.id);
  }
  this.emit('notification',message);
 }
 async callback(p){
  const controller=new AbortController();
  if(!p||p.threadId!==this.threadId||p.metadata?.threadId!==this.threadId||this.callbacks.has(p.id)){
   this.fail(Error('Invalid Hooks callback owner'));return;
  }
  this.callbacks.set(p.id,controller);
  try{
   if(!this.mcpCall)throw Error('Mac MCP Hooks execution is unavailable');
   const output=await this.mcpCall(p,controller.signal);
   if(typeof output!=='string')throw Error('MCP hook must return a text result');
   if(!controller.signal.aborted&&!this.closing)await this.call('mcp/response',{callbackId:p.id,output},5000);
  }catch(error){
   if(!controller.signal.aborted&&!this.closing&&!this.failure)
    await this.call('mcp/response',{callbackId:p.id,error:error.message},5000).catch(()=>{});
  }finally{if(this.callbacks.get(p.id)===controller)this.callbacks.delete(p.id);}
 }
 call(method,params={},timeoutMs=650000){
  if(this.closed||this.failure)return Promise.reject(this.failure||Error('Hooks helper closed'));
  const id='hooks-'+(++this.serial)+'-'+randomUUID();
  const line=JSON.stringify({id,method,params})+'\n';
  if(Buffer.byteLength(line)>1024*1024)return Promise.reject(Error('Hooks input exceeds 1 MiB'));
  const result=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>this.fail(Error('Hooks control timeout: '+method)),timeoutMs);
   this.pending.set(id,{resolve,reject,timer});
   this.process.stdin.write(line,error=>{if(error)this.fail(error);});
  });
  result.id=id;result.catch(()=>{});return result;
 }
 async execute(params,{signal}={}){
  await this.ready;
  if(this.closing||signal?.aborted)throw Error('Hook execution cancelled');
  if(this.active)throw Error('Hook execution already active');
  const work=this.call('execute',{...params,threadId:this.threadId,cwd:this.cwd});
  const active={id:work.id,turnId:params.turnId};this.active=active;
  const abort=()=>{void this.cancel(active.id).catch(error=>this.fail(error));};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{return await work;}
  finally{signal?.removeEventListener('abort',abort);if(this.active===active)this.active=null;}
 }
 cancel(executionId=this.active?.id){
  return executionId?this.call('cancel',{executionId},5000):Promise.resolve({cancelled:false});
 }
 async reload(){await this.ready;if(this.active)throw Error('Cannot reload active Hooks');return this.call('reload',{},15000);}
 close(){
  if(this.closing)return this.closing;
  this.closing=(async()=>{
   if(this.closed)return this.exit;
   try{if(!this.failure)await this.call('shutdown',{},5000);}catch{}
   if(!this.process.stdin.destroyed)this.process.stdin.end();
   await Promise.race([this.exit,pause(3000)]);
   if(!this.closed){this.process.kill('SIGTERM');await Promise.race([this.exit,pause(2000)]);}
   if(!this.closed){this.process.kill('SIGKILL');await this.exit;}
   return this.exit;
  })();return this.closing;
 }
}
module.exports={NativeHooksClient};
