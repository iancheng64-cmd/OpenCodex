'use strict';
// Exercise the actual adapter and permission receipts; the remote transport is isolated.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {NativePermissionRuntime}=require('../src/native-permissions-runtime.cjs');
const tests=[];
async function test(name,fn){await fn();tests.push(name);}
function fixture(){
 const calls=[],state={valid:true,profile:'audit',cancel:false,inventoryError:null,hookError:null};
 const runtime={closed:false,localCwd:'/mac/project',permissionMode:'custom:audit',
  openCodexInitialized:{userAgent:'codex OpenCodexPermissions/1'},executor:{isRunning:true,environmentId:'mac'},
  mcp:{name:'mac'},snapshot:{executorEnvironment:{}},toolHost:{server:{},status:()=>({tools:[]})},
  openCodexThreads:new Set(),openCodexPermissionReceipts:new Map()};
 const entry={profile:'audit',cwd:runtime.localCwd,valid:()=>state.valid&&!runtime.closed,
  validate:async()=>{if(!state.valid)throw Error('revoked');},
  snapshot:{definitions:{audit:{filesystem:{':root':'read'}}},permissionContext:{cwd:'file:///mac/project',home:'file:///mac/home'}}};
 runtime.openCodexPermissions=entry;
 const manager=new NativePermissionRuntime({service:{},owners:{}});
 const deps={prepareNativePermissions:r=>manager.prepare(r),validateNativePermissions:(r,id)=>manager.validate(r,id),
  prepareNativeHooks:async()=>({config:{hooks:{bridge:true}},commit:async()=>{if(state.hookError)throw Error(state.hookError);},abort:async()=>{}})};
 runtime.rpc={request:async(method,params)=>{
  calls.push({method,params:structuredClone(params)});
  if(method==='config/read')return {config:{}};
  if(['thread/start','thread/resume','thread/fork'].includes(method)){
   if(state.cancel)runtime.openCodexPreparing={cancelled:true};
   return {thread:{id:method==='thread/fork'?'fork':params.threadId||'thread',environments:[{environmentId:'mac'}]},activePermissionProfile:{id:state.profile}};
  }
  if(method==='turn/start'||method==='review/start')return {turn:{id:'turn'}};
  return {};
 }};
 const ctx={exports:{},runtimes:new Map(),node_crypto_1:require('node:crypto'),
  require:id=>{
   if(id.endsWith('/native-input.cjs'))return {convertInput:async(r,input)=>{calls.push({method:'convertInput'});return input;}};
   if(id.endsWith('/native-agent-runs.cjs'))return {configureSubagents:()=>{},receiptFor:()=>null,guardianRuntime:require('../src/native-guardian-runtime.cjs')};
   throw Error('Unexpected module '+id);
  },refreshMacExtensions:async()=>{},runtime_policy_1:{macThreadConfig:()=>({safe:true})},
  permission_policy_1:{codexPermissionPolicy:()=>{throw Error('custom must not fall back');}},
  runtime_extensions_1:{macRuntimeInstructions:()=>'Mac only'},
  verifyThreadMcp:async()=>{if(state.inventoryError)throw Error(state.inventoryError);}
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bridge-adapter.cjs'),'utf8'),ctx);
 return {runtime,state,calls,entry,manager,request:(m,p)=>ctx.exports.openCodexRequest(runtime,deps,m,p)};
}
(async()=>{
 await test('new thread replaces caller policy and config with trusted Mac definition',async()=>{
  const f=fixture();await f.request('thread/start',{cwd:'C:\\foreign',permissions:':danger-full-access',sandbox:'danger-full-access',sandboxPolicy:{type:'dangerFullAccess'},approvalPolicy:'never',approvalsReviewer:'guardian_subagent',config:{permissions:{evil:{}}},runtimeWorkspaceRoots:['/']});
  const p=f.calls.find(x=>x.method==='thread/start').params;
  assert.equal(p.permissions,'audit');assert.equal(p.approvalPolicy,'untrusted');assert.equal(p.approvalsReviewer,'user');
  assert.equal(p.cwd,undefined);assert.equal(p.sandbox,undefined);assert.equal(p.sandboxPolicy,undefined);assert.equal(p.runtimeWorkspaceRoots,undefined);
  assert.deepEqual(p.config.permissions,f.entry.snapshot.definitions);assert.equal(p.config.default_permissions,'audit');assert.deepEqual(p.config.opencodex_permission_context,f.entry.snapshot.permissionContext);
  assert.deepEqual(p.environments,[{environmentId:'mac',cwd:'/mac/project'}]);assert(f.runtime.openCodexThreads.has('thread'));assert(f.runtime.openCodexPermissionReceipts.has('thread'));
 });
 await test('resume and fork each admit only the returned thread with current profile',async()=>{
  for(const method of ['thread/resume','thread/fork']){
   const f=fixture();const result=await f.request(method,{threadId:'saved'});
   assert(f.runtime.openCodexPermissionReceipts.has(result.thread.id));
   assert.equal(f.runtime.openCodexPermissionReceipts.size,1);
   const sent=f.calls.filter(x=>x.method.startsWith('thread/'));assert.equal(sent.length,method==='thread/fork'?2:1);
   for(const {params}of sent)assert.equal(params.permissions,'audit');
  }
 });
 await test('wrong remote profile cannot create an admission',async()=>{
  const f=fixture();f.state.profile='full';await assert.rejects(f.request('thread/start',{}),/所選/);
  assert.equal(f.runtime.openCodexThreads.size,0);assert.equal(f.runtime.openCodexPermissionReceipts.size,0);
 });
 await test('late cancellation does not retain thread authority',async()=>{
  const f=fixture();f.state.cancel=true;await assert.rejects(f.request('thread/start',{}),/取消/);
  assert.equal(f.runtime.openCodexThreads.size,0);assert.equal(f.runtime.openCodexPermissionReceipts.size,0);
 });
 await test('inventory and hook failures revoke partial admissions',async()=>{
  for(const failure of ['inventoryError','hookError']){
   const f=fixture();f.state[failure]='fixture failure';await assert.rejects(f.request('thread/start',{}),/fixture failure/);
   assert.equal(f.runtime.openCodexThreads.size,0);assert.equal(f.runtime.openCodexPermissionReceipts.size,0);
  }
 });
 await test('turn uses the admitted profile and rejects caller escalation',async()=>{
  const f=fixture();await f.request('thread/start',{});await f.request('turn/start',{threadId:'thread',input:[],permissions:':danger-full-access',approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});
  const p=f.calls.at(-1).params;assert.equal(p.permissions,'audit');assert.equal(p.approvalPolicy,'untrusted');assert.equal(p.sandboxPolicy,undefined);assert.equal(await f.runtime.run.toolGate,true);
 });
 await test('revoked policy blocks attachments and model dispatch',async()=>{
  const f=fixture();await f.request('thread/start',{});f.state.valid=false;const count=f.calls.length;
  for(const method of ['turn/start','turn/steer','review/start','thread/settings/update'])
   await assert.rejects(f.request(method,{threadId:'thread',input:[{type:'localImage',path:'/private/file'}],permissions:'audit'}),/未就緒|revoked/);
  assert.equal(f.calls.length,count);assert.equal(f.runtime.run,undefined);
 });
 await test('foreign or stale endpoint receipts cannot start a turn',async()=>{
  for(const mutate of [f=>{f.runtime.toolHost.server={};},f=>{f.runtime.localCwd='/other';},f=>{f.runtime.openCodexPermissionReceipts.clear();}]){
   const f=fixture();await f.request('thread/start',{});mutate(f);const count=f.calls.length;
   await assert.rejects(f.request('turn/start',{threadId:'thread',input:[]}),/重新開啟/);assert.equal(f.calls.length,count);
  }
 });
 await test('settings updates preserve native profile and user approvals',async()=>{
  const f=fixture();await f.request('thread/start',{});await f.request('thread/settings/update',{threadId:'thread',permissions:':danger-full-access',sandboxPolicy:{type:'dangerFullAccess'},approvalPolicy:'never',cwd:'/other'});
  const p=f.calls.at(-1).params;assert.equal(p.permissions,'audit');assert.equal(p.approvalPolicy,'untrusted');assert.equal(p.approvalsReviewer,'user');assert.equal(p.sandboxPolicy,undefined);assert.equal(p.cwd,undefined);
 });
 await test('unready workspace or permissions blocks execution before RPC',async()=>{
  for(const field of ['openCodexWorkspaceFailed','openCodexPermissionChanging','openCodexPermissionFailed']){
   const f=fixture();f.runtime[field]=true;await assert.rejects(f.request('thread/start',{}));assert.equal(f.calls.length,0);
  }
 });
 const report={at:new Date().toISOString(),passed:true,tests,scope:'Actual adapter and receipt validation with mocked SSH transport; no live model'};
 fs.writeFileSync(path.join(__dirname,'../evidence/native-permissions-adapter-test.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
