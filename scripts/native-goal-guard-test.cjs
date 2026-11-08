'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {GoalGuard,activatesGoal,continueInterruptedGoal}=require('../src/native-goal-guard.cjs');
const tests=[];async function test(name,fn){await fn();tests.push(name);}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ocx-goal-guard-')),file=name=>path.join(dir,name+'.json');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
// A peer with one stored goal; records every request in order.
function peer({status='active',environments=[],failGet,failSet}={}){
 const calls=[],goal={status};
 return {calls,goal,rpc:{request:async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/goal/get'){if(failGet)throw Error('goals feature is disabled');return {goal:status==null?null:goal};}
  if(method==='thread/goal/set'){if(failSet)throw Error('set failed');if(params.status)goal.status=params.status;return {goal};}
  if(method==='config/read')return {config:{}};
  if(method==='thread/resume')return {thread:{id:params.threadId,environments}};
  if(method==='thread/start')return {thread:{id:'new',environments:[{environmentId:'mac'}]}};
  if(method==='turn/start')return {turn:{id:'turn-1'}};
  if(method==='mcpServerStatus/list')return {data:[{name:'mac',runtimeStatus:'disabled',tools:{}}],nextCursor:null};
  return {};
 }}};
}
function adapter(extra={}){
 const context={exports:{},require:id=>require(path.join(__dirname,'../src',path.basename(id))),runtimes:new Map(),refreshMacExtensions:async()=>{},verifyThreadMcp:async()=>{},
  runtime_policy_1:{macThreadConfig:()=>({safe:true}),validateMacMcpInventory:()=>{}},permission_policy_1:{codexPermissionPolicy:()=>({})},runtime_extensions_1:{macRuntimeInstructions:()=>'fallback instructions'},node_crypto_1:require('node:crypto'),...extra};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bridge-adapter.cjs'),'utf8'),context);
 return context.exports;
}
const makeRuntime=(rpc,overrides={})=>({id:'runtime',closed:false,rpc,executor:{isRunning:true,environmentId:'mac'},mcp:{name:'mac'},snapshot:{executorEnvironment:{},runtimeVersion:'test',profileId:'profile'},localCwd:'/local',permissionMode:'full',openCodexThreads:new Set(),...overrides});
(async()=>{
 try{
  await test('an active goal is held and the hold survives a restart',async()=>{
   const p=peer(),guard=new GoalGuard({file:file('a')});
   assert.equal(await guard.hold(p.rpc,'t'),true);assert.equal(p.goal.status,'paused');
   assert.equal(new GoalGuard({file:file('a')}).held('t'),true);
   assert.equal(await guard.release(p.rpc,'t'),true);assert.equal(p.goal.status,'active');
   assert.equal(new GoalGuard({file:file('a')}).held('t'),false);
  });
  await test('a paused, finished or absent goal is left alone',async()=>{
   for(const status of ['paused','complete','blocked','usageLimited',null]){
    const p=peer({status}),guard=new GoalGuard({file:file('b')});
    assert.equal(await guard.hold(p.rpc,'t'),false);assert.equal(p.calls.filter(c=>c.method==='thread/goal/set').length,0);
    assert.equal(await guard.release(p.rpc,'t'),false);
   }
  });
  await test('a peer without goals never blocks opening a conversation',async()=>{
   const events=[],guard=new GoalGuard({file:file('c'),audit:type=>events.push(type)});
   assert.equal(await guard.hold(peer({failGet:true}).rpc,'t'),false);
   assert.equal(await guard.hold(peer({failSet:true}).rpc,'t'),false);assert.deepEqual(events,['goal-hold-failed']);
  });
  await test('a failed release keeps the hold for the next turn',async()=>{
   const guard=new GoalGuard({file:file('d')});guard.note('t');
   assert.equal(await guard.release(peer({failSet:true}).rpc,'t'),false);assert.equal(guard.held('t'),true);
   guard.forget('t');assert.equal(guard.held('t'),false);
  });
  await test('only a status of active, or an objective for a new goal, activates',()=>{
   assert.equal(activatesGoal({status:'active'},null),true);assert.equal(activatesGoal({objective:'x'},null),true);
   assert.equal(activatesGoal({objective:'x'},{status:'paused'}),false);assert.equal(activatesGoal({status:'paused'},null),false);assert.equal(activatesGoal({},null),false);
  });
  await test('a dropped connection continues only an unfinished goal',async()=>{
   const started=[],start=async params=>{started.push(params);};
   assert.equal(await continueInterruptedGoal({rpc:peer().rpc,threadId:'t',start}),true);
   assert.equal(started[0].threadId,'t');assert.match(started[0].input[0].text,/繼續目前目標/);
   for(const status of ['paused','complete',null])assert.equal(await continueInterruptedGoal({rpc:peer({status}).rpc,threadId:'t',start}),false);
   assert.equal(await continueInterruptedGoal({rpc:peer().rpc,threadId:null,start}),false);assert.equal(started.length,1);
  });
  await test('resume pauses the goal before the peer can continue it, and the next turn restores it',async()=>{
   const p=peer(),goalGuard=new GoalGuard({file:file('e')}),runtime=makeRuntime(p.rpc),{openCodexRequest}=adapter();
   const deps={goalGuard,emit:()=>{}};
   await openCodexRequest(runtime,deps,'thread/resume',{threadId:'t'});
   const order=p.calls.map(c=>c.method),resume=order.indexOf('thread/resume');
   assert(order.indexOf('thread/goal/set')<resume);assert.equal(p.goal.status,'paused');assert(runtime.openCodexDormantThreads.has('t'));
   await openCodexRequest(runtime,deps,'turn/start',{threadId:'t',input:[]});await tick();
   const started=p.calls.findIndex(c=>c.method==='turn/start'),restored=p.calls.findLastIndex(c=>c.method==='thread/goal/set');
   assert.equal(JSON.stringify(p.calls[started].params.environments),JSON.stringify([{environmentId:'mac',cwd:'/local'}]));
   assert(restored>started);assert.equal(p.goal.status,'active');assert.equal(goalGuard.held('t'),false);
  });
  await test('a thread that already has the Mac environment keeps running its goal',async()=>{
   const p=peer({environments:[{environmentId:'mac'}]}),goalGuard=new GoalGuard({file:file('f')}),runtime=makeRuntime(p.rpc,{openCodexThreads:new Set(['t']),openCodexDormantThreads:new Set()}),{openCodexRequest}=adapter();
   await openCodexRequest(runtime,{goalGuard,emit:()=>{}},'thread/resume',{threadId:'t'});await tick();
   assert.equal(p.calls.filter(c=>c.method==='thread/goal/set').length,0);assert.equal(p.goal.status,'active');
  });
  await test('a hold from an earlier session is released once the environment is present',async()=>{
   const p=peer({status:'paused',environments:[{environmentId:'mac'}]}),goalGuard=new GoalGuard({file:file('g')});goalGuard.note('t');
   const runtime=makeRuntime(p.rpc),{openCodexRequest}=adapter();
   await openCodexRequest(runtime,{goalGuard,emit:()=>{}},'thread/resume',{threadId:'t'});await tick();
   assert.equal(p.goal.status,'active');assert.equal(goalGuard.held('t'),false);
  });
  await test('the user pausing or clearing a goal replaces the hold',async()=>{
   for(const [method,params]of [['thread/goal/set',{threadId:'t',status:'paused'}],['thread/goal/clear',{threadId:'t'}]]){
    const p=peer(),goalGuard=new GoalGuard({file:file('h')});goalGuard.note('t');
    await adapter().openCodexRequest(makeRuntime(p.rpc),{goalGuard,emit:()=>{}},method,params);
    assert.equal(goalGuard.held('t'),false);
   }
  });
  await test('new threads get the app instructions when the workspace provides them',async()=>{
   const p=peer(),{openCodexRequest}=adapter();
   await openCodexRequest(makeRuntime(p.rpc),{emit:()=>{},agentInstructions:async()=>'OpenCodex workspace'},'thread/start',{developerInstructions:'user'});
   assert.equal(p.calls.find(c=>c.method==='thread/start').params.developerInstructions,'user\n\nOpenCodex workspace');
   const q=peer();await openCodexRequest(makeRuntime(q.rpc),{emit:()=>{}},'thread/start',{});
   assert.equal(q.calls.find(c=>c.method==='thread/start').params.developerInstructions,'fallback instructions');
  });
  await test('threads search the live web unless the host chose otherwise',async()=>{
   const p=peer(),{openCodexRequest}=adapter();
   await openCodexRequest(makeRuntime(p.rpc),{emit:()=>{}},'thread/start',{});
   assert.equal(p.calls.find(c=>c.method==='thread/start').params.config.web_search,'live');
   const chosen={...peer()};const request=chosen.rpc.request;chosen.rpc.request=async(method,params)=>method==='config/read'?{config:{web_search:'disabled'}}:request(method,params);
   await openCodexRequest(makeRuntime(chosen.rpc),{emit:()=>{}},'thread/start',{});
   assert.equal(chosen.calls.find(c=>c.method==='thread/start').params.config.web_search,undefined);
  });
  const started=(threadId,turnId)=>({method:'turn/started',params:{threadId,turn:{id:turnId}}});
  await test('a turn with no Mac environment is ended after its goal is held',async()=>{
   const p=peer(),goalGuard=new GoalGuard({file:file('i')}),notes=[],runtime=makeRuntime(p.rpc,{openCodexThreads:new Set(['t']),openCodexDormantThreads:new Set(['t'])});
   adapter().openCodexWatchServerTurns(runtime,{goalGuard},{notify:type=>notes.push(type)})(started('t','server'));
   await tick();await tick();await tick();
   const order=p.calls.map(c=>c.method);
   assert(order.indexOf('thread/goal/set')<order.indexOf('turn/interrupt'));assert.equal(p.goal.status,'paused');
   assert.equal(p.calls.find(c=>c.method==='turn/interrupt').params.turnId,'server');assert.equal(runtime.run,undefined);assert.deepEqual(notes,['server-turn-stopped']);
  });
  await test('a goal continuation with the environment runs as our own turn',async()=>{
   const p=peer(),validated=[],adopted=[],runtime=makeRuntime(p.rpc,{openCodexThreads:new Set(['t']),openCodexDormantThreads:new Set(),openCodexAgentReceipts:new Map()});
   const exports=adapter(),deps={emit:()=>{},validateNativePermissions:async(_r,id)=>{validated.push(id);},validateNativeHooks:async()=>{}};
   exports.openCodexWatchServerTurns(runtime,deps,{onAdopt:id=>adopted.push(id)})(started('t','server'));
   assert.equal(runtime.run.turnId,'server');assert.equal(runtime.run.threadId,'t');assert.equal(runtime.run.openCodex,true);assert.equal(runtime.run.serverInitiated,true);
   assert.deepEqual(adopted,['t']);assert.equal(await runtime.run.toolGate,true);assert.deepEqual(validated,['t']);
   await exports.openCodexRequest(runtime,deps,'turn/interrupt',{threadId:'t',turnId:'server'});
   assert.equal(runtime.run.cancelled,true);assert.equal(p.calls.at(-1).method,'turn/interrupt');
  });
  await test('a continuation keeps sub-agents and tool ownership working',async()=>{
   const p=peer(),host={cancelRun(){}},runtime=makeRuntime(p.rpc,{toolHost:host,requests:new Map(),openCodexThreads:new Set(['t']),openCodexDormantThreads:new Set(),openCodexAgentReceipts:new Map([['t',{version:'0.160.0',rootThreadId:'t',inventoryVerified:true,v2ConfigVerified:true}]])});
   adapter().openCodexWatchServerTurns(runtime,{emit:()=>{}},{})(started('t','server'));
   assert.equal(await runtime.run.toolGate,true);assert.equal(runtime.openCodexSubagents.root,runtime.run);
   assert.equal(host.openCodexCurrentRun!==undefined,true);assert.equal(runtime.openCodexSubagents.current(),true);
   runtime.openCodexSubagents.close();
  });
  await test('a continuation that fails validation is ended, not left without tools',async()=>{
   const p=peer(),goalGuard=new GoalGuard({file:file('j')}),runtime=makeRuntime(p.rpc,{openCodexThreads:new Set(['t']),openCodexDormantThreads:new Set()});
   adapter().openCodexWatchServerTurns(runtime,{goalGuard,validateNativePermissions:async()=>{throw Error('policy changed');}},{})(started('t','server'));
   const gate=runtime.run.toolGate;assert.equal(await gate,false);await tick();await tick();await tick();
   assert.equal(runtime.run,undefined);assert(p.calls.some(c=>c.method==='turn/interrupt'));assert.equal(p.goal.status,'paused');
  });
  await test('our own turns, sub-agent threads and compaction are not touched',async()=>{
   const p=peer(),own={threadId:'t',turnId:'mine'},runtime=makeRuntime(p.rpc,{run:own,openCodexThreads:new Set(['t','u'])});
   const exports=adapter();let watch=exports.openCodexWatchServerTurns(runtime,{},{});
   watch(started('t','mine'));watch(started('child','x'));await tick();
   assert.equal(runtime.run,own);assert.equal(p.calls.length,0);
   const q=peer(),idle=makeRuntime(q.rpc,{openCodexThreads:new Set(['t'])});
   watch=exports.openCodexWatchServerTurns(idle,{},{});
   await idle.rpc.request('thread/compact/start',{threadId:'t'});watch(started('t','compact'));await tick();
   assert.equal(idle.run,undefined);assert.equal(q.calls.filter(c=>c.method==='turn/interrupt').length,0);
   watch(started('t','later'));assert.equal(idle.run.turnId,'later');
  });
  await test('a second thread cannot start while another turn holds the tool host',async()=>{
   const p=peer(),goalGuard=new GoalGuard({file:file('k')}),own={threadId:'other',turnId:'mine'},runtime=makeRuntime(p.rpc,{run:own,openCodexThreads:new Set(['t','other']),openCodexDormantThreads:new Set()});
   adapter().openCodexWatchServerTurns(runtime,{goalGuard},{})(started('t','server'));await tick();await tick();await tick();
   assert.equal(runtime.run,own);assert(p.calls.some(c=>c.method==='turn/interrupt'&&c.params.threadId==='t'));
  });
  await test('a continuation for a workspace the tool host has not opened is ended',async()=>{
   const p=peer(),runtime=makeRuntime(p.rpc,{openCodexThreads:new Set(['t']),openCodexDormantThreads:new Set()});
   adapter().openCodexWatchServerTurns(runtime,{},{adoptable:()=>false})(started('t','server'));await tick();await tick();
   assert.equal(runtime.run,undefined);assert(p.calls.some(c=>c.method==='turn/interrupt'));
  });
  console.log(JSON.stringify({passed:tests.length,tests},null,2));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
