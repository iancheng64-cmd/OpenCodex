'use strict';
// Routing of conversations across the primary runtime and extra runtimes to the same host.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {SessionPool,LEASE}=require('../src/native-sessions.cjs');
const tests=[];
async function test(name,fn){await fn();tests.push(name);}
let counter=0;
const runtime=(threads=[],extra={})=>({id:'rt'+(++counter),closed:false,openCodexThreads:new Set(threads),...extra});
function pool({primary,limit=3,spawn,release}={}){
 const released=[],opened=[],audits=[];
 const p=new SessionPool({primary:()=>primary,limit:()=>limit,spawn:spawn||(async()=>{const r=runtime();opened.push(r);return r;}),release:release||(async(owner,id)=>{released.push([owner.id,id]);owner.openCodexThreads.delete(id);}),audit:(type,data)=>audits.push({type,...data})});
 return {p,released,opened,audits};
}
(async()=>{
 await test('non-lease thread requests follow the conversation; others stay on the primary',async()=>{
  const primary=runtime(['a']),worker=runtime(['b']);const {p}=pool({primary});p.workers.add(worker);
  assert.equal((await p.select('turn/interrupt',{threadId:'b'})).runtime,worker);
  assert.equal((await p.select('thread/read',{threadId:'a'})).runtime,primary);
  assert.equal((await p.select('thread/read',{threadId:'unknown'})).runtime,primary);
  assert.equal((await p.select('model/list',{})).runtime,primary);
  assert.equal(p.ownerOf('b'),worker);assert.equal(p.ownerOf(undefined),null);
  worker.closed=true;assert.equal((await p.select('turn/interrupt',{threadId:'b'})).runtime,primary);
  assert.equal(p.alive(worker),false);assert.equal(p.alive(primary),true);
 });
 await test('an idle primary takes new conversations and turns without opening a runtime',async()=>{
  const primary=runtime(['a']);const {p,opened}=pool({primary});
  assert.equal((await p.select('thread/start',{},{lease:true})).runtime,primary);
  assert.equal((await p.select('turn/start',{threadId:'a'},{lease:true})).runtime,primary);
  assert.equal((await p.select('turn/start',{threadId:'new'},{lease:true})).runtime,primary);
  assert.equal(opened.length,0);
 });
 await test('a primary running one conversation sends the next one to a new runtime',async()=>{
  const primary=runtime(['a'],{run:{threadId:'a'}});const {p,opened,audits}=pool({primary});
  const second=await p.select('thread/start',{},{lease:true});
  assert.equal(opened.length,1);assert.equal(second.runtime,opened[0]);assert(p.workers.has(opened[0]));
  assert.equal(audits.at(-1).type,'session-worker-opened');
  // The same conversation's own turn stays with its busy owner; the lease reports it later.
  assert.equal((await p.select('turn/start',{threadId:'a'},{lease:true})).runtime,primary);
  // Ephemeral title threads queue on the primary instead of opening runtimes.
  const ephemeral=await p.select('thread/start',{ephemeral:true},{lease:true,ephemeral:true});
  assert.equal(ephemeral.runtime,opened[0],'an idle worker is preferred when one exists');
  opened[0].run={threadId:'x'};
  assert.equal((await p.select('thread/start',{ephemeral:true},{lease:true,ephemeral:true})).runtime,primary);
  assert.equal(opened.length,1);
 });
 await test('restoring a conversation waits behind a runtime that is only preparing another one',async()=>{
  const primary=runtime(['a'],{openCodexPreparing:{threadId:'a',ephemeral:false}}),worker=runtime([]);const {p,opened}=pool({primary});p.workers.add(worker);
  // The emptiest runtime that is not running a turn takes the restore; preparation only queues it.
  assert.equal((await p.select('thread/resume',{threadId:'b'},{lease:true})).runtime,worker);
  p.workers.delete(worker);
  assert.equal((await p.select('thread/resume',{threadId:'b'},{lease:true})).runtime,primary,'preparation never opens a runtime');
  primary.run={threadId:'a'};primary.openCodexPreparing=null;
  assert.equal((await p.select('thread/resume',{threadId:'b'},{lease:true})).runtime,opened[0],'a running turn sends the restore to a new runtime');
  assert.equal(opened.length,1);
 });
 await test('ephemeral work does not occupy a runtime',async()=>{
  const primary=runtime(['t'],{run:{threadId:'t',ephemeral:true}});const {p,opened}=pool({primary});
  assert.equal((await p.select('turn/start',{threadId:'b'},{lease:true})).runtime,primary);
  primary.run=null;primary.openCodexPreparing={threadId:'t',ephemeral:true};
  assert.equal((await p.select('thread/start',{},{lease:true})).runtime,primary);
  primary.openCodexPreparing={threadId:'other',ephemeral:false};
  assert.notEqual((await p.select('thread/start',{},{lease:true})).runtime,primary);
  assert.equal(opened.length,1);
 });
 await test('a conversation loaded on a busy runtime moves: released there, loaded on a free one',async()=>{
  const primary=runtime(['a','b'],{run:{threadId:'a'}}),worker=runtime([]);const {p,released,opened}=pool({primary});p.workers.add(worker);
  const chosen=await p.select('turn/start',{threadId:'b'},{lease:true});
  assert.equal(chosen.runtime,worker);assert.deepEqual(released,[[primary.id,'b']]);assert.equal(opened.length,0);
  assert.equal(primary.openCodexThreads.has('b'),false);
  // Viewing it while its owner runs another conversation attaches read-only instead.
  primary.openCodexThreads.add('b');worker.openCodexThreads.clear();
  const view=await p.select('thread/resume',{threadId:'b'},{lease:true});
  assert.equal(view.runtime,primary);assert.equal(view.attach,true);
  assert.equal(p.running(primary,'b'),true);assert.equal(p.running(primary,'a'),false);
  primary.run=null;
  const reload=await p.select('thread/resume',{threadId:'b'},{lease:true});
  assert.equal(reload.runtime,primary);assert.equal(reload.attach,undefined);
 });
 await test('the limit holds: a running primary with no capacity reports the limit or the cache',async()=>{
  const primary=runtime([],{run:{threadId:'a'}});const {p,opened}=pool({primary,limit:0});
  await assert.rejects(p.select('turn/start',{threadId:'b'},{lease:true}),/並行對話上限（1）/);
  await assert.rejects(p.select('thread/start',{},{lease:true}),e=>e.code==='OPENCODEX_PARALLEL_LIMIT');
  const view=await p.select('thread/resume',{threadId:'b'},{lease:true});
  assert.equal(view.runtime,primary);assert.equal(view.cached,true);
  assert.equal(opened.length,0);assert.equal(p.capacity(),false);assert.equal(p.canStart('b'),false);
  primary.run=null;assert.equal(p.canStart('b'),true);
 });
 await test('capacity counts runtimes being opened, and failed openings are not kept',async()=>{
  const primary=runtime([],{run:{threadId:'a'}});let fail=true;
  const {p}=pool({primary,limit:1,spawn:async()=>{if(fail)throw Error('ssh down');return runtime();}});
  await assert.rejects(p.select('thread/start',{},{lease:true}),/ssh down/);
  assert.equal(p.workers.size,0);assert.equal(p.spawning,0);
  fail=false;
  const opening=p.select('thread/start',{},{lease:true});
  assert.equal(p.spawning,1);assert.equal(p.capacity(),false);
  await assert.rejects(p.select('thread/start',{},{lease:true}),/並行對話上限/);
  const worker=(await opening).runtime;assert(p.workers.has(worker));assert.equal(p.spawning,0);
  assert.deepEqual(p.state(),{workers:1,spawning:0,limit:2,running:1});
  p.forget(worker);assert.equal(p.workers.size,0);
 });
 await test('a closed primary routes everything to it so the usual disconnected errors apply',async()=>{
  const primary=runtime([],{closed:true}),worker=runtime(['b']);const {p}=pool({primary});p.workers.add(worker);
  assert.equal((await p.select('turn/start',{threadId:'b'},{lease:true})).runtime,primary);
  assert.deepEqual(p.live(),[worker]);
 });
 await test('idle workers are listed oldest first for maintenance',async()=>{
  const primary=runtime();const {p}=pool({primary});
  const busy=runtime([],{run:{threadId:'x'}}),idle=runtime([]),preparing=runtime([],{openCodexPreparing:{threadId:'y'}});
  for(const r of [busy,idle,preparing])p.workers.add(r);
  assert.deepEqual(p.idleWorkers(),[idle]);
  assert.equal(LEASE.has('turn/start'),true);assert.equal(LEASE.has('turn/interrupt'),false);
  assert.equal(p.needsRouting('thread/start',{}),true);assert.equal(p.needsRouting('model/list',{}),false);assert.equal(p.needsRouting('turn/steer',{threadId:'a'}),true);
 });
 const report={version:'0.4.15',at:new Date().toISOString(),passed:true,tests,scope:'Pure routing with mock runtimes; real engines are covered by parallel-sessions-e2e'};
 fs.writeFileSync(path.join(__dirname,'../evidence/native-sessions-unit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exit(1);});
