'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {NativeAgents,reserveAgentRoots}=require('../src/native-agents.cjs'),{NativeToolOwners}=require('../src/native-tool-owners.cjs');
const tests=[];async function test(name,fn){await fn();tests.push({name,passed:true});console.log('PASS '+name);}
function setup(){
 const calls=[],peers={codex:{id:'codex',snapshot:{hostName:'Host A'}},claude:{cli:{id:'claude',status:()=>({account:{verified:true,authenticated:true}})},hostName:'Host B'}};
 const agents=new NativeAgents({getPeers:()=>peers,invoke:async(name,input)=>{calls.push([name,input]);return {runId:input.requestId};}});
 return {agents,calls,peers,event:e=>agents.event({runId:agents.active.id,...e})};
}
(async()=>{
 await test('dual readiness uses actual peers and verified Claude login',async()=>{
  const f=setup();assert(f.agents.state().ready);f.peers.claude.cli.status=()=>({account:{verified:false,authenticated:true}});
  assert(!f.agents.state().ready);await assert.rejects(f.agents.discuss({topic:'test'}),/登入/);assert.equal(f.calls.length,0);
  f.peers.claude.cli.status=()=>({account:{verified:true,authenticated:true}});f.peers.codex.closed=true;
  await assert.rejects(f.agents.discuss({topic:'test'}),/連接/);assert.equal(f.calls.length,0);
 });
 await test('native MCP preserves actionable authentication errors without starting models',async()=>{
  const f=setup();f.peers.claude.cli.status=()=>({account:{verified:true,authenticated:false}});
  const result=await f.agents.spec().createClient().call('opencodex_agents_discuss',{topic:'test'});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/登入/);assert.equal(f.calls.length,0);assert(!f.agents.active);
 });
 await test('native MCP returns both agents transcript and final, and ignores unrelated events',async()=>{
  const f=setup(),client=f.agents.spec().createClient();assert.equal((await client.start()).length,2);
  const result=client.call('opencodex_agents_discuss',{topic:'test',rounds:2,leadAgent:'claude'},new AbortController().signal);
  await new Promise(r=>setImmediate(r));
  const input=f.calls[0][1];assert.equal(input.codexRuntimeId,'codex');assert.equal(input.claudeRuntimeId,'claude');assert.equal(input.rounds,2);
  f.agents.event({runId:'unrelated',type:'done',status:'completed'});assert(f.agents.active);
  f.event({type:'turn',round:1,agent:'codex',text:'analysis'});f.event({type:'turn',round:1,agent:'claude',text:'critique'});
  f.event({type:'done',status:'completed',final:'synthesis'});
  const body=JSON.parse((await result).content[0].text);assert.equal(body.turns.length,2);assert.equal(body.final,'synthesis');assert(!f.agents.active);
 });
 await test('Stop cancels acquisition and retains run ownership until backend cleanup',async()=>{
  const f=setup(),abort=new AbortController(),result=f.agents.discuss({topic:'test'},abort.signal);
  await new Promise(r=>setImmediate(r));abort.abort();await assert.rejects(result,/取消/);
  assert.equal(f.calls.at(-1)[0],'orchestrator:cancel');assert(f.agents.active.cancelled);
  await assert.rejects(f.agents.discuss({topic:'second'}),/進行中/);
  f.event({type:'done',status:'cancelled'});assert(!f.agents.active);
 });
 await test('orchestrator failure returns real error and releases wrapper state',async()=>{
  const f=setup(),result=f.agents.discuss({topic:'test'});await new Promise(r=>setImmediate(r));
  f.event({type:'error',text:'remote unavailable'});f.event({type:'done',status:'error'});
  await assert.rejects(result,/remote unavailable/);assert(!f.agents.active);
  await assert.rejects(f.agents.discuss({topic:'test',rounds:9}),/設定/);
 });
 await test('nested discussion leases separate vendor processes and releases roots',async()=>{
  const {TaskRuntimePool}=require('../vendor/agentbridge/dist-main/task-runtime-pool.js');
  const pools={};for(const name of ['codex','claude']){const pool=pools[name]=new TaskRuntimePool(async()=>{});pool.register({runtimeId:name},async()=>({runtimeId:name+'-discussion'}));}
  const f=setup(),backends={codex:{acquireCodexTask:(...a)=>pools.codex.acquire(...a),releaseCodexTask:(...a)=>pools.codex.release(...a)},claude:{acquireClaudeTask:(...a)=>pools.claude.acquire(...a),releaseClaudeTask:(...a)=>pools.claude.release(...a)}};
  const release=await reserveAgentRoots(f.peers,'native-turn',backends);
  for(const name of ['codex','claude']){const lease=await pools[name].acquire(name,'discussion','discussion');assert.equal(lease.runtimeId,name+'-discussion');pools[name].release(lease.runtimeId,'discussion');}
  release();release();
  for(const name of ['codex','claude']){assert.equal(pools[name].tasks.size,0);assert([...pools[name].roots.values()].every(root=>[...root.entries.values()].every(e=>!e.requestId)));}
 });
 await test('Stop while reserving roots releases leases without starting models',async()=>{
  const f=setup();let resume,released=0;f.agents.reservePeers=()=>new Promise(r=>resume=r);
  const result=f.agents.discuss({topic:'test'});await new Promise(r=>setImmediate(r));await f.agents.cancel();
  resume(()=>released++);await assert.rejects(result,/取消/);assert.equal(released,1);assert(!f.calls.some(c=>c[0]==='orchestrator:start'));assert(!f.agents.active);
 });
 await test('two simultaneous hosts in one directory retain distinct native runtimes',async()=>{
  let sequence=0;const owners=new NativeToolOwners(cwd=>({id:++sequence,cwd,closed:false,ready:async()=>{},specs:async()=>[{id:'native'}],close(){this.closed=true;}}));
  const specA=await owners.specs('/same'),specB=await owners.specs('/same');
  const a={localCwd:'/same',run:{id:'a'},toolHost:{options:{extensionServers:specA},replaceNativeExtensions:async()=>{throw Error('unexpected reload');}}};
  const b={localCwd:'/same',run:{id:'b'},toolHost:{options:{extensionServers:specB},replaceNativeExtensions:async()=>{throw Error('unexpected reload');}}};
  await Promise.all([owners.refresh(a),owners.refresh(b)]);
  assert.notEqual(owners.owner(a),owners.owner(b));assert.equal(owners.owner(a).runtime.run.id,'a');assert.equal(owners.owner(b).runtime.run.id,'b');
  owners.invalidate();a.toolHost.replaceNativeExtensions=async()=>{};
  const oldA=owners.owner(a),oldB=owners.owner(b);await owners.refresh(a);
  assert(oldA.closed);assert(!oldB.closed);assert.equal(owners.owner(b),oldB);assert.equal(oldB.runtime,b);
  owners.close();assert(oldB.closed);
 });
 await test('failed native refresh closes only the failed replacement, leaving peer usable',async()=>{
  const all=[],owners=new NativeToolOwners(cwd=>{const o={cwd,closed:false,specs:async()=>[],close(){this.closed=true;}};all.push(o);return o;});
  const specs=await owners.specs('/one'),a={localCwd:'/one',toolHost:{options:{extensionServers:specs},replaceNativeExtensions:async()=>{throw Error('replace failed');}}};
  const specsB=await owners.specs('/two'),b={localCwd:'/two',host:{options:{extensionServers:specsB}}};owners.owner(b);owners.invalidate();
  await assert.rejects(owners.refresh(a),/replace failed/);assert(all.at(-1).closed);assert(!owners.owner(b).closed);owners.close();
 });
 await test('same-profile selection reinitializes a cancelled native host and propagates recovery failures',async()=>{
  const {NativeTools}=require('../src/native-tools.cjs');
  let starts=0,valid=true;
  const owners=new NativeToolOwners(cwd=>{
   const owner=new NativeTools({cwd,permissionProfile:'audit',validate:async()=>valid});
   owner.start=async()=>{starts++;owner.permissionSnapshot={cwd,activePermissionProfile:{id:'audit'},sandbox:{type:'readOnly'}};return [];};
   return owner;
  });
  const specs=await owners.specs('/same'),runtime={localCwd:'/same',openCodexPermissions:{profile:'audit'},toolHost:{options:{extensionServers:specs},replaceNativeExtensions:async()=>{throw Error('unexpected replacement');}}};
  const owner=owners.owner(runtime);assert.equal(starts,1);
  owner.reset();assert.equal(owner.permissionSnapshot,null);
  await owners.refresh(runtime);
  assert.equal(owners.owner(runtime),owner);assert.equal(starts,2);assert.equal(owner.permissionSnapshot.activePermissionProfile.id,'audit');
  valid=false;await assert.rejects(owners.refresh(runtime),/權限設定/);assert(owner.closed);owners.close();
 });
 fs.writeFileSync(path.join(__dirname,'../evidence/native-agents-unit.json'),JSON.stringify({at:new Date().toISOString(),tests,passed:true},null,2)+'\n');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
