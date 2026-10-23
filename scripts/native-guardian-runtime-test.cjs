'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const guardian=require('../src/native-guardian-runtime.cjs'),policy=require('../src/native-policy.cjs');
const tests=[];
async function test(name,fn){await fn();tests.push(name);}
function fixture(){
 const calls=[],state={cancel:false,responseReviewer:'auto_review',responsePolicy:'on-request',refresh:false};
 const runtime={closed:false,openCodexInitialized:{userAgent:'codex OpenCodexGuardian/1'},localCwd:'/mac/project',permissionMode:'project',openCodexReviewer:'auto_review',
  executor:{isRunning:true,environmentId:'mac'},mcp:{name:'mac'},snapshot:{runtimeVersion:'0.160.0',executorEnvironment:{}},
  toolHost:{server:{},generation:1,status:()=>({tools:[]})},openCodexThreads:new Set()};
 runtime.rpc={request:async(method,params)=>{
  calls.push({method,params:structuredClone(params)});
  if(method==='config/read')return {config:{mcp_servers:{mac:{tools:{exempt:{approval_mode:'approve'}}}}}};
  if(['thread/start','thread/resume','thread/fork'].includes(method)){
   if(state.cancel)runtime.openCodexPreparing={cancelled:true};
   return {thread:{id:method==='thread/fork'?'fork':params.threadId||'root',environments:[{environmentId:'mac'}]},
    approvalsReviewer:state.responseReviewer,approvalPolicy:state.responsePolicy};
  }
  if(method==='turn/start')return {turn:{id:'turn'}};
  return {};
 }};
 const ctx={exports:{},runtimes:new Map(),node_crypto_1:require('node:crypto'),
  require:id=>{
   if(id.endsWith('/native-input.cjs'))return {convertInput:async(r,input)=>{calls.push({method:'convertInput'});return input;}};
   if(id.endsWith('/native-agent-runs.cjs'))return {guardianRuntime:guardian,
    NativeAgentRuns:class {constructor(){throw Error('Fixture owner initialization failed');}},
    configureSubagents:(r,b,c)=>{c['features.multi_agent_v2']=true;},receiptFor:()=>null};
   throw Error('Unexpected module '+id);
  },
  refreshMacExtensions:async()=>{if(state.refresh)runtime.toolHost.generation++;},
  runtime_policy_1:{macThreadConfig:()=>({mcp_servers:{mac:{environment_id:'mac'}}})},
  permission_policy_1:{codexPermissionPolicy:()=>({approvalPolicy:'untrusted',sandbox:'read-only'})},
  runtime_extensions_1:{macRuntimeInstructions:()=>''},verifyThreadMcp:async()=>{}
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bridge-adapter.cjs'),'utf8'),ctx);
 return {runtime,state,calls,request:(m,p)=>ctx.exports.openCodexRequest(runtime,{},m,p)};
}
(async()=>{
 await test('selection persists per thread, explicit choice wins, and highest access preserves restore choice',()=>{
  const remembered={permissionMode:'ask',approvalsReviewer:'auto_review'},settings={permissionMode:'project',approvalsReviewer:'user'};
  assert.equal(policy.resolveSelection({},remembered,settings).reviewer,'auto_review');
  assert.equal(policy.resolveSelection({approvalsReviewer:'user'},remembered,settings).reviewer,'user');
  assert.throws(()=>policy.resolveSelection({approvalsReviewer:'invalid'},remembered,settings));
  const selection=policy.resolveSelection({},remembered,{...settings,fullAccess:true});
  assert.deepEqual(selection,{requested:'ask',effective:'full',reviewer:'auto_review'});
  assert.equal(policy.localSnapshot({sandbox:{}},selection,'/mac/project').approvalsReviewer,'auto_review');
  assert.equal(guardian.effective({permissionMode:'full',openCodexReviewer:'auto_review'}),'user');
 });
 await test('native picker receives Guardian policy and round trips the reviewer',()=>{
  const selection=policy.resolveSelection({permissions:':workspace',approvalsReviewer:'guardian_subagent'},null,{});
  assert.equal(selection.reviewer,'auto_review');
  const snapshot=policy.localSnapshot({sandboxPolicy:{}},selection,'/mac/project');
  assert.equal(snapshot.approvalPolicy,'on-request');assert.equal(snapshot.approvalsReviewer,'auto_review');
  assert.equal(policy.resolveSelection(snapshot,null,{}).reviewer,'auto_review');
 });
 await test('unsupported engines, agent roles and foreign Mac environments reject before admission',()=>{
  for(const mutate of [
   (r,c)=>{r.snapshot.runtimeVersion='0.159.0';},
   (r,c)=>{r.openCodexInitialized={userAgent:'codex OpenCodexGuardian/10'};},
   (r,c)=>{delete r.openCodexInitialized;},
   (r,c)=>{c['features.multi_agent_v2']=false;},
   (r,c)=>{c.mcp_servers.mac.environment_id='foreign';}
  ]){
   const {runtime}=fixture(),config={'features.multi_agent_v2':true,mcp_servers:{mac:{environment_id:'mac'}}};
   mutate(runtime,config);assert.throws(()=>guardian.prepare(runtime,{},config));
   assert.equal(runtime.openCodexGuardianReceipts,undefined);
  }
 });
 await test('per-tool exemptions are replaced by native review requests',()=>{
  const {runtime}=fixture(),config={'features.multi_agent_v2':true,mcp_servers:{mac:{environment_id:'mac'}}};
  const prepared=guardian.prepare(runtime,{mcp_servers:{mac:{tools:{free:{approval_mode:'approve'},disabled:{enabled:false}}}}},config);
  assert.equal(config.mcp_servers.mac.default_tools_approval_mode,'prompt');
  assert.deepEqual(config.mcp_servers.mac.tools,{free:{approval_mode:'prompt'},disabled:{approval_mode:'prompt'}});
  assert.deepEqual(prepared.parameters,{approvalsReviewer:'auto_review',approvalPolicy:'on-request'});
 });
 await test('new, resumed and forked threads require acknowledged Guardian settings',async()=>{
  for(const method of ['thread/start','thread/resume','thread/fork']){
   const f=fixture(),result=await f.request(method,{threadId:'saved',approvalsReviewer:'user',approvalPolicy:'never'});
   assert(guardian.receiptFor(f.runtime,result.thread.id));
   for(const call of f.calls.filter(c=>['thread/start','thread/resume','thread/fork'].includes(c.method))){
    assert.equal(call.params.approvalsReviewer,'auto_review');assert.equal(call.params.approvalPolicy,'on-request');
    assert.equal(call.params.config['features.guardian_approval'],true);
    assert.equal(call.params.config.mcp_servers.mac.tools.exempt.approval_mode,'prompt');
   }
  }
 });
 await test('wrong or absent native acknowledgement cannot admit a thread',async()=>{
  for(const response of [{responseReviewer:'user'},{responsePolicy:'never'},{responseReviewer:undefined}]){
   const f=fixture();Object.assign(f.state,response);
   await assert.rejects(f.request('thread/start',{}),/Guardian/);
   assert.equal(f.runtime.openCodexThreads.size,0);assert.equal(f.runtime.openCodexGuardianReceipts?.size||0,0);
  }
 });
 await test('cancelled setup cannot retain Guardian authorization',async()=>{
  const f=fixture();f.state.cancel=true;await assert.rejects(f.request('thread/start',{}),/取消/);
  assert.equal(f.runtime.openCodexGuardianReceipts?.size||0,0);assert.equal(f.runtime.openCodexThreads.size,0);
 });
 await test('endpoint, generation, project and policy changes invalidate before reading inputs',async()=>{
  for(const mutate of [
   r=>{r.toolHost.server={};},r=>{r.toolHost.generation++;},r=>{r.localCwd='/other';},
   r=>{r.permissionMode='ask';},r=>{r.openCodexGuardianReceipts.clear();}
  ]){
   const f=fixture();await f.request('thread/start',{});mutate(f.runtime);const before=f.calls.length;
   await assert.rejects(f.request('turn/start',{threadId:'root',input:[]}),/Guardian/);
   assert.equal(f.calls.length,before);assert.equal(f.runtime.run,undefined);
  }
 });
 await test('a host refresh during turn setup also blocks model dispatch',async()=>{
  const f=fixture();await f.request('thread/start',{});f.state.refresh=true;
  await assert.rejects(f.request('turn/start',{threadId:'root',input:[]}),/Guardian/);
  assert(!f.calls.some(c=>c.method==='turn/start'));assert.equal(f.runtime.run,undefined);
 });
 await test('model turns and settings updates cannot downgrade Guardian',async()=>{
  for(const method of ['turn/start','thread/settings/update']){
   const f=fixture();await f.request('thread/start',{});
   await f.request(method,{threadId:'root',input:[],approvalsReviewer:'user',approvalPolicy:'never'});
   const call=f.calls.at(-1);assert.equal(call.params.approvalsReviewer,'auto_review');assert.equal(call.params.approvalPolicy,'on-request');
  }
 });
 await test('owner initialization failure releases the run before any model request',async()=>{
  const f=fixture();await f.request('thread/start',{});
  f.runtime.openCodexAgentReceipts=new Map([['root',{}]]);
  await assert.rejects(f.request('turn/start',{threadId:'root',input:[]}),/owner initialization failed/);
  assert.equal(f.runtime.run,undefined);assert(!f.calls.some(c=>c.method==='turn/start'));
 });
 await test('switching to user closes agent authority and the resumed thread disables Guardian',async()=>{
  const f=fixture();await f.request('thread/start',{});let closed=0;
  f.runtime.openCodexSubagents={close:()=>closed++};guardian.select(f.runtime,'user');
  assert.equal(closed,1);assert.equal(f.runtime.openCodexThreads.size,0);assert.equal(f.runtime.openCodexGuardianReceipts.size,0);
  f.state.responseReviewer='user';await f.request('thread/resume',{threadId:'root'});
  assert.equal(guardian.receiptFor(f.runtime,'root'),null);
  assert.equal(f.calls.at(-1).params.config['features.guardian_approval'],false);
  assert.equal(f.calls.at(-1).params.approvalsReviewer,'user');
 });
 await test('active, closed and cancelled runtimes cannot switch reviewer',()=>{
  for(const changed of [{run:{}},{closed:true},{openCodexPreparing:{cancelled:true}}]){
   const {runtime}=fixture();Object.assign(runtime,changed);assert.throws(()=>guardian.select(runtime,'user'));
   assert.equal(runtime.openCodexReviewer,'auto_review');
  }
 });
 await test('prepared receipts cannot commit after lifecycle changes or commit twice',()=>{
  for(const mutate of [r=>{r.toolHost.generation++;},r=>{r.closed=true;},r=>{r.openCodexReviewer='user';}]){
   const {runtime}=fixture(),p=guardian.prepare(runtime,{}, {'features.multi_agent_v2':true,mcp_servers:{mac:{environment_id:'mac'}}});
   mutate(runtime);assert.throws(()=>p.commit({thread:{id:'root'},approvalsReviewer:'auto_review',approvalPolicy:'on-request'}));
  }
  const {runtime}=fixture(),p=guardian.prepare(runtime,{}, {'features.multi_agent_v2':true,mcp_servers:{mac:{environment_id:'mac'}}});
  p.commit({thread:{id:'root'},approvalsReviewer:'auto_review',approvalPolicy:'on-request'});
  assert.throws(()=>p.commit({thread:{id:'root'}}));
 });
 const report={at:new Date().toISOString(),passed:true,tests,scope:'Actual Guardian runtime, native policy and adapter with isolated transport'};
 fs.writeFileSync(path.join(__dirname,'../evidence/native-guardian-runtime-test.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
