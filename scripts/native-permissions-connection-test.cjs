'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const root=path.resolve(__dirname,'..'),patch=require('./permission-patches.cjs').backend;
const original=fs.readFileSync(path.join(root,'build/OpenCodex.app/Contents/Resources/agentbridge/app/dist-main/runtime-backend.js'),'utf8'),source=patch(original);
assert.equal(patch(source),source,'repeated builds must remain idempotent');
const start=source.indexOf('    const connectRuntime = async'),end=source.indexOf('    electron_1.ipcMain.handle("runtime:connect"',start);
assert(start>=0&&end>start);
function fixture({preflightFailure,permissionFailure,cleanupFailure}={}){
 const calls=[],conn=new EventEmitter(),channel={stderr:new EventEmitter()},runtimes=new Map();
 conn.end=()=>calls.push('connection:close');
 const toolHost={async start(){return {url:'http://fixture.invalid',token:'fixture'};},status(){return {ready:true};},async stop(){calls.push('tools:stop');}};
 class Rpc extends EventEmitter{
  async request(method){calls.push(method);return method==='initialize'?{platformOs:'windows'}:{};}
  notify(){} close(){calls.push('rpc:close');}
 }
 class Executor{installation={version:'fixture'};environmentId='mac';isRunning=true;async start(){}async reverseForward(){return 'ws://fixture.invalid';}async register(){return {id:'mac'};}stop(){calls.push('executor:stop');}}
 const context={Error,Map,Set,Promise,Boolean,String,Date,process:{resourcesPath:'/fixture'},runtimes,
  deps:{nativePermissionMode:value=>value,emit:(_name,event)=>calls.push(['diagnostic',event.message]),extensionServers:async()=>[],
   async initializeNativePermissions(runtime){assert.equal(runtime.id,'fixture-id');calls.push('permissions:initialize');if(permissionFailure)throw permissionFailure;},
   async closeNativePermissions(runtime){assert.equal(runtime.id,'fixture-id');calls.push('permissions:close');if(cleanupFailure)throw cleanupFailure;}},
  connection_network_1:{connectNetwork:async()=>({conn,key:'fixture',fingerprint:'fixture',transport:'ssh'})},
  remote_shell_1:{resolveRemotePlatform:async()=>{if(preflightFailure)throw preflightFailure;return 'windows';},captureRemote:async()=> '--code-mode-host',remoteLaunchError:e=>e},
  app_server_rpc_1:{AppServerRpc:Rpc,appServerCommand:()=>'',chooseStdioFlag:()=>'--stdio',accountSummary:x=>x},
  local_code_mode_host_1:{parseCodexVersion:()=>'fixture',findHostInstallation:async()=>({})},
  local_exec_server_1:{LocalExecServer:Executor},local_tool_host_1:{LocalToolHost:function(){return toolHost;}},
  runtime_policy_1:{isVerifiedExecutorVersion:()=>true,isolatedRuntimeArgs:()=>[]},
  node_fs_1:{default:{promises:{realpath:async p=>p,stat:async()=>({isDirectory:()=>true}),mkdir:async()=>{}}}},
  node_os_1:{default:{homedir:()=>'/fixture'}},node_path_1:{default:path},node_crypto_1:{randomUUID:()=>'fixture-id'},
  electron_1:{app:{getPath:()=>'/fixture',getVersion:()=>'fixture'}},
  execChannel:async()=>channel,listModels:async()=>[],localToolCapability:()=>({localTools:true}),
  routeServerRequest(){},routeNotification(){},closeRuntime(){},authorizeMacTool(){},connectTrustedRuntimeSsh(){},
 };
 const connect=vm.runInNewContext(source.slice(start,end)+'\nconnectRuntime;',context);
 return {calls,runtimes,connect:()=>connect({}, {platform:'auto',localCwd:'/fixture',permissionMode:'custom:audit',profile:{id:'fixture',host:'fixture',networkMode:'direct'}})};
}
(async()=>{
 const tests=[];
 {
  const error=Error('preflight failed'),f=fixture({preflightFailure:error});
  await assert.rejects(f.connect(),e=>e===error);
  assert.deepEqual(f.calls,['connection:close']);tests.push('pre-runtime failure preserves the original error and closes SSH');
 }
 for(const cleanupFailure of [undefined,Error('cleanup failed')]){
  const error=Error('permission initialization failed'),f=fixture({permissionFailure:error,cleanupFailure});
  await assert.rejects(f.connect(),e=>e===error);
  for(const action of ['permissions:close','rpc:close','executor:stop','tools:stop','connection:close'])assert(f.calls.includes(action),action);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='diagnostic').length,cleanupFailure?1:0);
  tests.push(cleanupFailure?'cleanup failure is diagnostic and preserves original initialization error':'permission initialization failure revokes authority and closes owned resources');
 }
 {
  const f=fixture(),result=await f.connect();assert.equal(result.runtimeId,'fixture-id');assert.equal(result.permissionMode,'custom:audit');
  assert(!f.calls.includes('permissions:close'));assert(!f.calls.includes('connection:close'));
  tests.push('successful connection remains active with its custom permission selection');
 }
 const report={at:new Date().toISOString(),passed:true,tests,scope:'Pinned production connectRuntime function with isolated transport and resources'};
 fs.writeFileSync(path.join(root,'evidence/native-permissions-connection-test.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
