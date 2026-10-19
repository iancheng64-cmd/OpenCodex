'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const r=require('../src/native-routing.cjs'),tests=[];
async function test(name,fn){await fn();tests.push(name);}
(async()=>{
 const known={own:{profile:'a',summary:{id:'own',name:'Alpha',preview:'file edit',updatedAt:2}},other:{profile:'b',summary:{id:'other'}},archived:{profile:'a',archived:true,summary:{id:'archived',preview:'Archive'}}};
 await test('search filters peer private sessions across pages',async()=>{
  const calls=[];const rpc={request:async(m,p)=>{calls.push(p.cursor);return p.cursor?{data:[{thread:{id:'own'},snippet:'OK'}],nextCursor:null}:{data:[{thread:{id:'other'},snippet:'PRIVATE'}],nextCursor:'next'};}};
  const result=await r.ownedPage(rpc,'thread/search',{},known,'a');assert.deepEqual(result.data,[{thread:{id:'own'},snippet:'OK'}]);assert.deepEqual(calls,[null,'next']);
 });
 await test('attachments and loaded IDs respect host ownership',async()=>{
  for(const values of [[{threadId:'own'},{threadId:'other'}],['own','other']]){
   const got=await r.ownedPage({request:async()=>({data:values,nextCursor:null})},'thread/attachmentOwner/list',{},known,'a');
   assert.deepEqual(got.data,[values[0]]);
  }
 });
 await test('repeating cursor terminates instead of looping',async()=>assert.rejects(r.ownedPage({request:async()=>({data:[],nextCursor:'same'})},'thread/list',{},known,'a'),/游標/));
 await test('offline search and archive filters',async()=>{
  assert.deepEqual(r.cachedPage('thread/list',{},known,'a').data.map(t=>t.id),['own']);
  assert.deepEqual(r.cachedPage('thread/list',{archived:true},known,'a').data.map(t=>t.id),['archived']);
  assert.equal(r.cachedPage('thread/search',{searchTerm:'ALPHA'},known,'a').data[0].thread.id,'own');
  assert.equal(r.cachedPage('thread/search',{searchTerm:'missing'},known,'a').data.length,0);
 });
 await test('thread tools and turn settings route remotely; files and processes stay local',async()=>{
  for(const method of ['turn/settings/update','thread/queue/add','thread/realtime/start','mcpServer/tool/call','review/start'])assert(r.threadScoped(method,{threadId:'own'}));
  for(const method of ['fs/readFile','process/spawn','config/read','skills/list'])assert(!r.threadScoped(method,{threadId:'own'}));
 });
 const calls=[],runtime={closed:false,executor:{isRunning:true,environmentId:'mac'},mcp:{name:'mac'},snapshot:{executorEnvironment:{}},localCwd:'/local',permissionMode:'full',openCodexThreads:new Set(['own']),rpc:{request:async(method,params)=>{
  calls.push({method,params});if(method==='config/read')return {config:{}};
  if(method==='thread/fork')return {thread:{id:'fork',environments:[]}};
  if(method==='thread/resume')return {thread:{id:'fork',environments:[{environmentId:'mac'}]}};
  if(method==='review/start')return {turn:{id:'review'}};
  return {};
 }}};
 let verified=0;
 const ctx={exports:{},require:id=>{assert.equal(id,'../../../app.asar/opencodex/native-agent-runs.cjs');return require('../src/native-agent-runs.cjs');},runtimes:new Map(),refreshMacExtensions:async()=>{},runtime_policy_1:{macThreadConfig:()=>({safe:true})},permission_policy_1:{codexPermissionPolicy:()=>({sandbox:'read-only',approvalPolicy:'untrusted'})},runtime_extensions_1:{macRuntimeInstructions:()=>'local'},verifyThreadMcp:async()=>{verified++},node_crypto_1:require('node:crypto')};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bridge-adapter.cjs'),'utf8'),ctx);
 await test('fork reinitializes executor before a new turn',async()=>{
  const out=await ctx.exports.openCodexRequest(runtime,{},'thread/fork',{threadId:'own',cwd:'C:\\foreign'});
  assert.equal(out.thread.id,'fork');assert(runtime.openCodexThreads.has('fork'));assert.equal(verified,1);
  assert.deepEqual(calls.map(c=>c.method),['config/read','thread/fork','thread/resume']);
  assert.equal(calls[1].params.cwd,undefined);assert.equal(calls[2].params.threadId,'fork');
 });
 await test('inline review uses verified Mac tool gate',async()=>{
  await ctx.exports.openCodexRequest(runtime,{},'review/start',{threadId:'own',target:{type:'uncommittedChanges'}});
  assert.equal(await runtime.run.toolGate,true);assert.equal(runtime.run.threadId,'own');assert.equal(verified,2);runtime.run=undefined;
  await assert.rejects(ctx.exports.openCodexRequest(runtime,{},'review/start',{threadId:'own',delivery:'detached'}),/分支/);
 });
 const policy=require('../src/native-policy.cjs');
 await test('native permission selections map to executor policy and reject unknown profiles',async()=>{
  assert.equal(policy.selectedMode({permissions:':workspace'}),'project');
  assert.equal(policy.selectedMode({permissions:':danger-full-access'}),'full');
  assert.equal(policy.selectedMode({sandboxPolicy:{type:'readOnly'}}),'ask');
  assert.equal(policy.selectedMode({}),null);
  assert.throws(()=>policy.selectedMode({permissions:'unknown'}),/權限/);
  assert.throws(()=>policy.selectedMode({approvalsReviewer:'guardian_subagent'}),/使用者/);
 });
 await test('Mac tool approvals decline by default and cannot approve a stopped run',async()=>{
  const active={openCodex:true},rt={run:active},decisions=[];
  const input={event:{type:'approval',title:'Tool'},runtime:rt,isPending:()=>true,respond:d=>decisions.push(d)};
  await policy.localApproval({...input,show:async options=>{assert.equal(options.defaultId,0);return {response:0}}});
  await policy.localApproval({...input,show:async()=>({response:1})});
  active.cancelled=true;
  await policy.localApproval({...input,show:async()=>({response:1})});
  await policy.localApproval({...input,isPending:()=>false,show:()=>{throw Error('expired approval must not be shown')}});
  assert.deepEqual(decisions,['decline','accept','decline']);
 });
 await test('turn permission downgrade reaches remote policy',async()=>{
  runtime.permissionMode='ask';runtime.run=undefined;
  runtime.rpc.request=async(method,params)=>{calls.push({method,params});return {turn:{id:'restricted'}}};
  await ctx.exports.openCodexRequest(runtime,{},'turn/start',{threadId:'own',input:[],sandboxPolicy:{type:'dangerFullAccess'}});
  const sent=calls.at(-1);assert.equal(sent.params.sandboxPolicy.type,'readOnly');assert.equal(sent.params.approvalPolicy,'untrusted');
 });
 await test('isolation runs before inference to avoid MCP inventory/tool deadlock',async()=>{
  runtime.run=undefined;let checked=false;
  ctx.verifyThreadMcp=async()=>{assert.equal(runtime.run,undefined);checked=true;};
  runtime.rpc.request=async(method)=>{assert.equal(method,'turn/start');assert(checked);return {turn:{id:'ordered'}};};
  await ctx.exports.openCodexRequest(runtime,{},'turn/start',{threadId:'own',input:[]});
  assert.equal(await runtime.run.toolGate,true);runtime.run=undefined;
  ctx.verifyThreadMcp=async()=>{throw Error('foreign tool detected')};
  runtime.rpc.request=async()=>{throw Error('inference must not start')};
  await assert.rejects(ctx.exports.openCodexRequest(runtime,{},'turn/start',{threadId:'own',input:[]}),/foreign tool/);
  assert.equal(runtime.run,undefined);
 });
 await test('resumed dormant MCP validates isolation before selecting the Mac',async()=>{
  ctx.runtime_policy_1.validateMacMcpInventory=require('../vendor/agentbridge/dist-main/runtime-policy.js').validateMacMcpInventory;
  runtime.openCodexDormantThreads=new Set(['own']);let started=false;
  runtime.rpc.request=async(method,p)=>{
   if(method==='mcpServerStatus/list')return {data:[{name:'mac',runtimeStatus:'disabled',tools:{}}]};
   assert.equal(method,'turn/start');assert.equal(p.environments[0].environmentId,'mac');started=true;return {turn:{id:'resumed'}};
  };
  await ctx.exports.openCodexRequest(runtime,{},'turn/start',{threadId:'own',input:[]});assert(started);assert.equal(await runtime.run.toolGate,true);runtime.run=undefined;
  runtime.openCodexDormantThreads.add('own');
  runtime.rpc.request=async(method)=>{assert.equal(method,'mcpServerStatus/list');return {data:[{name:'mac',runtimeStatus:'disabled',tools:{}},{name:'foreign',runtimeStatus:'connected',tools:{run:{}}}]};};
  await assert.rejects(ctx.exports.openCodexRequest(runtime,{},'turn/start',{threadId:'own',input:[]}),/非 Mac 工具/);assert.equal(runtime.run,undefined);
 });
 await test('detached review creates an isolated native thread and never reviews the source',async()=>{
  const {detachedReview}=require('../src/native-review.cjs'),seen=[];
  const target={type:'uncommittedChanges'};
  const out=await detachedReview({threadId:'source',target,delivery:'detached'},async(method,p)=>{seen.push({method,p});return method==='thread/start'?{thread:{id:'review-thread'}}:{reviewThreadId:p.threadId,turn:{id:'review-turn'}};});
  assert.equal(out.reviewThreadId,'review-thread');assert.deepEqual(seen.map(x=>x.method),['thread/start','review/start']);assert.equal(seen[1].p.delivery,'inline');assert.equal(seen[1].p.threadId,'review-thread');assert.equal(seen[1].p.target,target);
  await assert.rejects(detachedReview({threadId:'source'},async()=>({thread:{id:'source'}})),/獨立/);
  await assert.rejects(detachedReview({threadId:'source'},async method=>method==='thread/start'?{thread:{id:'new'}}:{reviewThreadId:'source'}),/非預期/);
 });
 await test('remote queue bypass is rejected so every dispatch uses the Mac turn gate',async()=>{
  runtime.run=undefined;runtime.openCodexDormantThreads=new Set();ctx.verifyThreadMcp=async()=>{};
  runtime.rpc.request=async()=>{throw Error('remote queue must not receive requests');};
  for(const method of ['thread/queue/add','thread/queue/update','thread/queue/start']){
   await assert.rejects(ctx.exports.openCodexRequest(runtime,{},method,{threadId:'own',input:[]}),/OpenCodex 排程/);
  }
  assert.equal(runtime.run,undefined);
 });
 await test('steering local attachments are serialized on the Mac before remote dispatch',async()=>{
  ctx.node_fs_1={default:fs};ctx.node_path_1={default:path};
  const temp=fs.mkdtempSync(path.join(require('os').tmpdir(),'opencodex-input-'));
  const file=path.join(temp,'qa.png');fs.writeFileSync(file,Buffer.from([137,80,78,71]));
  try{
   for(const method of ['turn/steer']){
    runtime.rpc.request=async(m,p)=>{assert.equal(m,method);assert.equal(p.input[0].type,'image');assert.equal(p.input[0].url,'data:image/png;base64,iVBORw==');assert.equal(p.input[0].path,undefined);return {};};
    await ctx.exports.openCodexRequest(runtime,{},method,{threadId:'own',input:[{type:'localImage',path:file}]});
   }
  }finally{fs.unlinkSync(file);fs.rmdirSync(temp);}
 });
 const report={at:new Date().toISOString(),version:'0.4.1',passed:true,tests,remoteTransport:'mocked; no live SSH claim'};
 fs.writeFileSync(path.join(__dirname,'../evidence/native-routing-test.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exit(1)});
