'use strict';
// Run the bundled Codex plugin host on this Mac. No model turn or peer credentials.
const {spawn}=require('node:child_process'),EventEmitter=require('node:events');
class NativeTools {
 constructor({binary,cwd,env,AppServerRpc,onRequest,getRun,config={}}){Object.assign(this,{binary,cwd,env,AppServerRpc,onRequest,getRun,config});this.references=0;this.clients=new Set();this.closed=false;this.generation=0;this.runOwners=new Map();}
 async ready(){
  if(this.closed)throw Error('原生外掛工作階段已關閉。');
  if(this.rpc?.isClosed)this.reset();
  if(this.pending)return this.pending;
  const generation=this.generation;
  this.pending=this.start().catch(e=>{if(generation===this.generation)this.reset();throw e;});return this.pending;
 }
 async start(){
  const env={...this.env};delete env.CODEX_APP_SERVER_WS_URL;delete env.CODEX_EXEC_SERVER_URL;
  const child=spawn(this.binary,['app-server','--listen','stdio://','-c','features.code_mode_host=true'],{cwd:this.cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
  this.child=child;const transport=new EventEmitter();
  transport.write=s=>child.stdin.write(s);transport.close=()=>this.kill(child);
  child.stdout.on('data',d=>transport.emit('data',d));child.stderr.resume();
  child.on('error',e=>transport.emit('error',e));child.on('close',()=>transport.emit('close'));
  const rpc=new this.AppServerRpc(transport);this.rpc=rpc;
  rpc.on('request',m=>{if(!this.onRequest?.(m,rpc,this))rpc.reject(m.id,'OpenCodex frontend unavailable');});
  await rpc.request('initialize',{clientInfo:{name:'opencodex-native-tools',version:'0.4.1'},capabilities:{experimentalApi:true}});
  rpc.notify('initialized');
  const result=await rpc.request('thread/start',{cwd:this.cwd,ephemeral:true,config:this.config},60000);
  this.threadId=result.thread.id;
  // A starting plugin may already advertise tools, but is not callable yet.
  // Wait for terminal startup states before freezing the bridge tool catalogue.
  const deadline=Date.now()+60000;
  for(;;){
   const data=await this.inventory(Math.max(1,deadline-Date.now()));
   if(!data.some(s=>s.runtimeStatus==='starting'))return data;
   if(Date.now()>=deadline)throw Error('Mac 原生外掛啟動逾時，請重新連線。');
   await new Promise(resolve=>setTimeout(resolve,250));
   if(this.closed)throw Error('原生外掛工作階段已關閉。');
  }
 }
 async inventory(timeout=60000){
  const data=[];let cursor;
  for(let i=0;i<100;i++){
   const p=await this.rpc.request('mcpServerStatus/list',{threadId:this.threadId,limit:100,...(cursor?{cursor}:{})},timeout).catch(e=>{throw Error('Mac 原生外掛清單：'+e.message,{cause:e});});
   if(!Array.isArray(p.data))throw Error('原生外掛清單無效。');data.push(...p.data);
   if(!p.nextCursor)return data;if(cursor===p.nextCursor)break;cursor=p.nextCursor;
  }
  throw Error('原生外掛清單無法完整讀取。');
 }
 async specs(){
  const data=await this.ready();
  this.statuses=data.map(s=>({name:s.name,status:s.runtimeStatus,tools:Object.keys(s.tools||{})}));
  return data.filter(s=>s.runtimeStatus==='connected'&&(Object.keys(s.tools||{}).length||(s.resources||[]).length||(s.resourceTemplates||[]).length)).map(s=>{
   const owner=this;return {id:'opencodex-native:'+s.name,name:'Codex 原生 · '+s.name,transport:'native',startupTimeoutMs:60000,
    createClient(){let stopped=false;owner.references++;
     const client={get running(){return !stopped&&!owner.closed;},
      async start(){return Object.values(s.tools||{});},
      call(tool,args,signal){if(stopped)throw Error('原生外掛已停止。');return owner.call(s.name,tool,args,signal);},
      async resource(method,params,signal){
       if(method==='resources/list')return {resources:s.resources||[]};
       if(method==='resources/templates/list')return {resourceTemplates:s.resourceTemplates||[]};
       if(method==='resources/read')return owner.resource(s.name,params.uri,signal);
       throw Error('此 Codex 原生版本未提供 MCP prompts 轉接介面。');
      },
      async stop(){if(stopped)return;stopped=true;owner.clients.delete(client);if(--owner.references===0)owner.close();}
     };owner.clients.add(client);return client;
    }};
  });
 }
 async operation(method,params,signal){
  if(signal?.aborted)throw Error('原生工具已取消。');
  await this.ready();
  if(signal?.aborted)throw Error('原生工具已取消。');
  const generation=this.generation;
  const abort=()=>this.reset();signal?.addEventListener('abort',abort,{once:true});
  try{
   const result=await this.rpc.request(method,{...params,threadId:this.threadId},180000);
   if(signal?.aborted||generation!==this.generation)throw Error('原生工具已取消，結果未採用。');
   return result;
  }catch(e){if(/逾時/.test(e.message))this.reset();throw e;}
  finally{signal?.removeEventListener('abort',abort);}
 }
 ownerFor(run){
  if(!run?.parentThreadId)return this;
  if(run.cancelled||this.closed)throw Error('原生工具已取消。');
  let owner=this.runOwners.get(run.requestId);
  if(!owner){
   if(this.runOwners.size>=16)throw Error('同時執行的原生工具工作階段已達上限。');
   owner=new NativeTools({binary:this.binary,cwd:this.cwd,env:this.env,AppServerRpc:this.AppServerRpc,config:this.config,onRequest:this.onRequest,getRun:()=>run});
   this.runOwners.set(run.requestId,owner);
  }
  return owner;
 }
 cancelRun(run){const owner=this.runOwners.get(run.requestId);if(owner){this.runOwners.delete(run.requestId);owner.close();}}
 async call(server,tool,args,signal){
  const run=this.getRun?.();
  const selected=this.ownerFor(run);
  if(selected!==this)return selected.callOwn(server,tool,args,signal,run);
  return this.callOwn(server,tool,args,signal,run);
 }
 async callOwn(server,tool,args,signal,run){
  if(this.getRun)require('./native-request.cjs').nativeTurnMeta(run);
  await this.ready();
  const current=await this.inventory(),entry=current.find(s=>s.name===server&&s.runtimeStatus==='connected');
  if(!entry?.tools?.[tool])throw Error('原生外掛工具已停用或無法使用：'+server+'/'+tool);
  if(this.getRun&&this.getRun()!==run)throw Error('原生工具所屬回合已變更，請重新執行。');
  const metadata=this.getRun?{_meta:require('./native-request.cjs').nativeTurnMeta(run)}:{};
  return this.operation('mcpServer/tool/call',{server,tool,arguments:args,...metadata},signal);
 }
 resource(server,uri,signal){const owner=this.ownerFor(this.getRun?.());return owner.operation('mcpServer/resource/read',{server,uri},signal);}
 kill(child){
  if(!child?.pid||child.exitCode!==null)return;
  try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}
  const timer=setTimeout(()=>{if(child.exitCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}},1000);timer.unref();
 }
 reset(){this.generation++;const rpc=this.rpc,child=this.child;this.rpc=null;this.child=null;this.pending=null;this.threadId=null;rpc?.close();this.kill(child);}
 close(){this.closed=true;for(const owner of this.runOwners.values())owner.close();this.runOwners.clear();this.reset();}
}
module.exports={NativeTools};
