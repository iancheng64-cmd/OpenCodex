'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),EventEmitter=require('node:events');
const {NativeHooksService}=require('../src/native-hooks-service.cjs');
function fixture(){
 const calls=[],runtime={closed:false,executor:{isRunning:true,environmentId:'mac'},mcp:{name:'mac'},snapshot:{executorEnvironment:{}},localCwd:'/local',permissionMode:'full',openCodexThreads:new Set(['own']),rpc:{request:async(method,params)=>{
  calls.push({method,params});if(method==='config/read')return {config:{}};
  if(method==='thread/start')return {thread:{id:'new',environments:[{environmentId:'mac'}]}};
  if(method==='thread/fork')return {thread:{id:'fork',environments:[]}};
  if(method==='thread/resume')return {thread:{id:params.threadId,environments:[{environmentId:'mac'}]}};
  if(method==='turn/start')return {turn:{id:'turn'}};return {};
 }}};
 const ctx={exports:{},require:id=>{assert.equal(id,'../../../app.asar/opencodex/native-agent-runs.cjs');return require('../src/native-agent-runs.cjs');},runtimes:new Map(),refreshMacExtensions:async()=>{},runtime_policy_1:{macThreadConfig:()=>({safe:true})},permission_policy_1:{codexPermissionPolicy:()=>({sandbox:'read-only',approvalPolicy:'untrusted'})},runtime_extensions_1:{macRuntimeInstructions:()=>'local'},verifyThreadMcp:async()=>{},node_crypto_1:require('node:crypto')};
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../src/bridge-adapter.cjs'),'utf8'),ctx);
 return {runtime,calls,ctx,request:(deps,method,p)=>ctx.exports.openCodexRequest(runtime,deps,method,p)};
}
test('thread prepare uses Hooks config and commits only after Mac isolation',async()=>{
 const f=fixture(),seen=[];f.ctx.verifyThreadMcp=async()=>seen.push('verify');
 const deps={prepareNativeHooks:async()=>({config:{'features.hooks':true,hooks:{fixture:true}},commit:async id=>seen.push('commit:'+id),abort:async()=>seen.push('abort')})};
 await f.request(deps,'thread/start',{});assert.deepEqual(seen,['verify','commit:new']);assert.equal(f.calls[1].params.config.hooks.fixture,true);assert(f.runtime.openCodexThreads.has('new'));
});
test('failed resumed isolation aborts Hooks and invalidates prior admission',async()=>{
 const f=fixture(),seen=[];f.ctx.verifyThreadMcp=async()=>{throw Error('foreign tools');};
 await assert.rejects(f.request({prepareNativeHooks:async()=>({config:{},commit:async()=>seen.push('commit'),abort:async()=>seen.push('abort')})},'thread/resume',{threadId:'own'}),/foreign tools/);
 assert.deepEqual(seen,['abort']);assert(!f.runtime.openCodexThreads.has('own'));
});
test('stop during preparation prevents Hooks commit and thread admission',async()=>{
 const f=fixture(),seen=[];f.ctx.verifyThreadMcp=async()=>{f.runtime.openCodexPreparing={cancelled:true};};
 await assert.rejects(f.request({prepareNativeHooks:async()=>({config:{},commit:async()=>seen.push('commit'),abort:async()=>seen.push('abort')})},'thread/start',{}),/取消/);
 assert.deepEqual(seen,['abort']);assert(!f.runtime.openCodexThreads.has('new'));
});
test('changed Hook settings prevent model turn and review dispatch',async()=>{
 for(const method of ['turn/start','review/start']){
  const f=fixture();
  await assert.rejects(f.request({validateNativeHooks:async(rt,id)=>{assert.equal(rt,f.runtime);assert.equal(id,'own');throw Error('changed Hooks');}},method,{threadId:'own',input:[]}),/changed Hooks/);
  assert.equal(f.calls.length,0);assert.equal(f.runtime.run,undefined);
 }
});
test('fork commits the destination identity and preserves source admission',async()=>{
 const f=fixture(),ids=[];
 await f.request({prepareNativeHooks:async()=>({config:{},commit:async id=>ids.push(id),abort:async()=>{throw Error('unexpected abort')}})},'thread/fork',{threadId:'own'});
 assert.deepEqual(ids,['fork']);assert(f.runtime.openCodexThreads.has('own'));assert(f.runtime.openCodexThreads.has('fork'));
});
function serviceFixture(){
 const configs=[],entries=[];
 class Runtime{
  constructor(options){this.options=options;configs.push(options);entries.push(this);}
  prepare(){return 'prepared';}validate(id){return 'valid:'+id;}cancelRun(run){this.cancelled=run;}async close(){this.closed=true;}
 }
 const runtime={localCwd:'/mac',rpc:new EventEmitter};
 const owner={cwd:'/mac',ready:async()=>{},rpc:{request:async method=>method==='hooks/list'?{data:[{cwd:'/mac',hooks:[],errors:[]}]}:{config:{features:{hooks:false}}}}};
 let current=owner;
 const service=new NativeHooksService({Runtime,owner:()=>current,onRequest:()=>{}});
 return {service,runtime,owner,configs,entries,setOwner:o=>current=o};
}
test('service fails when native UI and helper inventories differ',async()=>{
 const f=serviceFixture();f.service.prepare(f.runtime);
 await f.configs[0].inventoryCheck({featureEnabled:false,hooks:[]},'/mac');
 await assert.rejects(f.configs[0].inventoryCheck({featureEnabled:true,hooks:[]},'/mac'),/不一致/);
 await f.service.close();
});
test('workspace switch during inventory refuses stale native owner',async()=>{
 const f=serviceFixture();f.service.prepare(f.runtime);f.owner.ready=async()=>f.setOwner({...f.owner});
 await assert.rejects(f.configs[0].inventoryCheck({featureEnabled:false,hooks:[]},'/mac'),/歸屬/);
 await f.service.close();
});
test('connection close removes only its Hooks owner and notifications follow current attachment',async()=>{
 const f=serviceFixture(),other={localCwd:'/mac',rpc:new EventEmitter},seen=[];
 f.service.prepare(f.runtime);f.service.prepare(other);
 f.runtime.openCodexHooksNotification=m=>seen.push(m);
 f.configs[0].onNotification('message');assert.deepEqual(seen,['message']);
 f.runtime.rpc.emit('closed');await new Promise(r=>setImmediate(r));
 assert(f.entries[0].closed);assert(!f.entries[1].closed);assert.equal(f.runtime.openCodexHooks,undefined);assert.equal(f.service.validate(other,'thread'),'valid:thread');
 assert.throws(()=>f.service.validate(f.runtime,'thread'),/重新/);await f.service.close();assert(f.entries[1].closed);
});
