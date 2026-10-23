'use strict';
const assert=require('node:assert/strict');
const {NativePermissionRuntime,profileFor}=require('../src/native-permissions-runtime.cjs');
const {NativePermissionDispatch}=require('../src/native-permissions-dispatch.cjs');
const {convertInput}=require('../src/native-input.cjs');
let passed=0;
async function test(name,work){await work();passed++;console.log('PASS '+name);}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture(){
 const runtime={localCwd:'/workspace',permissionMode:'project',rpc:{},toolHost:{server:{},setFullFilesystemAccess:value=>{runtime.full=value;}},
  openCodexInitialized:{userAgent:'codex OpenCodexPermissions/1'},openCodexThreads:new Set(['old']),openCodexAgentReceipts:new Map([['old',{}]])};
 let refreshes=0,hookCloses=0,ownerCloses=0;
 const service={entries:new Map(),preparing:new Map(),async prepare(r,profile){
  await service.gate?.promise;
  if(profile==='missing')throw Error('missing profile');
  const entry={profile,cwd:r.localCwd,closed:false,snapshot:{definitions:{[profile]:{filesystem:{':root':'read'}}},permissionContext:{cwd:'file:///workspace'},fingerprint:'one'},
   valid(){return !entry.closed&&!r.closed&&r.localCwd===entry.cwd;},
   async validate(){await entry.gate?.promise;if(entry.changed){entry.closed=true;throw Error('configuration changed');}if(!entry.valid())throw Error('closed');},
   close(){entry.closed=true;}};
  return {entry,async commit(){await entry.validate();service.entries.get(r)?.close();service.entries.set(r,entry);r.openCodexPermissions=entry;return entry;},abort(){entry.close();}};
 },closeRuntime(r){service.entries.get(r)?.close();service.entries.delete(r);delete r.openCodexPermissions;},close(){}};
 const owners={async refresh(r){refreshes++;await owners.gate?.promise;if(owners.fail)throw Error('host failed');},closeRuntime(){ownerCloses++;}};
 const manager=new NativePermissionRuntime({service,owners,closeHooks:async()=>{hookCloses++;}});
 const result=()=>({thread:{id:'thread'},activePermissionProfile:{id:runtime.openCodexPermissions.profile}});
 return {runtime,service,owners,manager,result,counts:()=>({refreshes,hookCloses,ownerCloses})};
}
(async()=>{
 await test('profile validation keeps named and built-in modes distinct',async()=>{
  assert.equal(profileFor('custom:dev'),'dev');assert.equal(profileFor('full'),null);
  for(const mode of ['custom:', 'custom::workspace','dev','custom:bad\0name'])assert.throws(()=>profileFor(mode));
 });
 await test('requires explicit remote capability before creating local sandbox',async()=>{
  const f=fixture();f.runtime.openCodexInitialized.userAgent='OpenCodexPermissions/10';
  await assert.rejects(f.manager.select(f.runtime,'custom:dev'),/引擎/);assert.equal(f.service.entries.size,0);assert.equal(f.runtime.permissionMode,'project');
 });
 await test('commits host and mode together; invalidates old admissions and Hooks',async()=>{
  const f=fixture();await f.manager.select(f.runtime,'custom:dev');
  assert.equal(f.runtime.permissionMode,'custom:dev');assert.equal(f.runtime.openCodexPermissions.profile,'dev');
  assert.equal(f.runtime.openCodexThreads.size,0);assert.equal(f.runtime.openCodexAgentReceipts.size,0);
  assert.equal(f.runtime.full,false);assert.equal(f.counts().hookCloses,1);assert(!f.runtime.openCodexPermissionChanging);
 });
 await test('trusted configuration is cloned and wrong remote profile cannot admit thread',async()=>{
  const f=fixture();await f.manager.select(f.runtime,'custom:dev');const ticket=await f.manager.prepare(f.runtime);
  ticket.config.permissions.dev.filesystem[':root']='write';assert.equal(f.runtime.openCodexPermissions.snapshot.definitions.dev.filesystem[':root'],'read');
  await assert.rejects(ticket.commit({thread:{id:'bad'},activePermissionProfile:{id:':danger-full-access'}}),/未套用/);
  assert(!f.runtime.openCodexPermissionReceipts?.has('bad'));await assert.rejects(ticket.commit(f.result()),/結束/);
 });
 await test('receipt binds profile, connection endpoint and working directory',async()=>{
  const f=fixture();await f.manager.select(f.runtime,'custom:dev');await (await f.manager.prepare(f.runtime)).commit(f.result());
  assert.deepEqual(await f.manager.validate(f.runtime,'thread'),{permissions:'dev',approvalPolicy:'untrusted'});
  const endpoint=f.runtime.toolHost.server;f.runtime.toolHost.server={};
  await assert.rejects(f.manager.validate(f.runtime,'thread'),/重新開啟/);f.runtime.toolHost.server=endpoint;
  f.runtime.localCwd='/different';await assert.rejects(f.manager.validate(f.runtime,'thread'),/未就緒/);
 });
 await test('unchanged profile preserves admitted thread and reloads native configuration',async()=>{
  const f=fixture();await f.manager.select(f.runtime,'custom:dev');await (await f.manager.prepare(f.runtime)).commit(f.result());
  const receipt=f.runtime.openCodexPermissionReceipts.get('thread');await f.manager.select(f.runtime,'custom:dev');
  assert.equal(f.runtime.openCodexPermissionReceipts.get('thread'),receipt);assert.equal(f.counts().hookCloses,1);
 });
 await test('stale configuration closes authority without fallback',async()=>{
  const f=fixture();await f.manager.select(f.runtime,'custom:dev');const old=f.runtime.openCodexPermissions;old.changed=true;
  await assert.rejects(f.manager.select(f.runtime,'custom:dev'),/changed/);assert(old.closed);assert(f.runtime.openCodexPermissionFailed);
  assert.throws(()=>new NativePermissionDispatch(f.runtime).session(),/未就緒/);assert(!f.runtime.openCodexPermissions);
  await assert.rejects(convertInput(f.runtime,[{type:'localImage',path:'/never-read'}]),/未讀取/);
 });
 await test('failed native host refresh closes selected sandbox and blocks every dispatch',async()=>{
  const f=fixture();f.owners.fail=true;await assert.rejects(f.manager.select(f.runtime,'custom:dev'),/host failed/);
  assert(f.runtime.openCodexPermissionFailed);assert(!f.runtime.openCodexPermissions);
  assert.throws(()=>new NativePermissionDispatch(f.runtime).session(),/未就緒/);
  f.owners.fail=false;await f.manager.select(f.runtime,'project');assert(!f.runtime.openCodexPermissionFailed);assert.equal(f.runtime.permissionMode,'project');
 });
 await test('parallel selections rejected while attachments and tools stay blocked',async()=>{
  const f=fixture();f.service.gate=deferred();const pending=f.manager.select(f.runtime,'custom:dev');
  await assert.rejects(f.manager.select(f.runtime,'full'),/正在更新/);
  assert.throws(()=>new NativePermissionDispatch(f.runtime).session(),/未就緒/);
  await assert.rejects(convertInput(f.runtime,[{type:'skill',path:'/never-read'}]),/未讀取/);
  f.service.gate.resolve();await pending;
 });
 await test('disconnect during preparation cannot install a late sandbox',async()=>{
  const f=fixture();f.service.gate=deferred();const pending=f.manager.select(f.runtime,'custom:dev');
  await f.manager.closeRuntime(f.runtime);
  await assert.rejects(f.manager.select(f.runtime,'project'),/正在更新/);
  f.service.gate.resolve();await assert.rejects(pending,/取消/);
  await f.manager.select(f.runtime,'project');assert(!f.runtime.openCodexPermissionFailed);
  await f.manager.closeRuntime(f.runtime);
  assert.equal(f.service.entries.size,0);assert(f.runtime.openCodexPermissionFailed);
 });
 await test('workspace change during host refresh rolls back local execution authority',async()=>{
  const f=fixture();f.owners.gate=deferred();const pending=f.manager.select(f.runtime,'custom:dev');
  while(!f.runtime.openCodexPermissions)await new Promise(r=>setImmediate(r));
  const old=f.runtime.openCodexPermissions;f.runtime.localCwd='/new';f.owners.gate.resolve();await assert.rejects(pending,/取消/);
  assert(old.closed);assert(f.runtime.openCodexPermissionFailed);
 });
 await test('configuration revocation preserves its retry reason while ordinary cancellation does not',async()=>{
  for(const code of [undefined,'OPENCODEX_PERMISSION_CONFIG_CHANGED']){
   const f=fixture();f.service.gate=deferred();const pending=f.manager.select(f.runtime,'custom:dev');
   const reason=code?Object.assign(Error('configuration changed'),{code}):undefined;
   await f.manager.closeRuntime(f.runtime,reason);f.service.gate.resolve();
   await assert.rejects(pending,error=>error.code===code&&(reason?error===reason:/取消/.test(error.message)));
   assert(!f.runtime.openCodexPermissions);assert(f.runtime.openCodexPermissionFailed);
  }
 });
 await test('new model work or cancellation prevents pending permission activation',async()=>{
  for(const mutate of [r=>r.run={},r=>r.openCodexPreparing={cancelled:true}]){
   const f=fixture();f.service.gate=deferred();const pending=f.manager.select(f.runtime,'custom:dev');mutate(f.runtime);
   f.service.gate.resolve();await assert.rejects(pending,/取消/);assert.equal(f.service.entries.size,0);
  }
 });
 await test('switching to built-in closes custom session and invalidates prepared receipts',async()=>{
  const f=fixture();await f.manager.select(f.runtime,'custom:dev');const old=f.runtime.openCodexPermissions,ticket=await f.manager.prepare(f.runtime),result=f.result();
  await f.manager.select(f.runtime,'full');assert(old.closed);assert(!f.runtime.openCodexPermissions);assert.equal(f.runtime.full,true);
  await assert.rejects(ticket.commit(result),/未套用/);assert.equal(await f.manager.prepare(f.runtime),null);
 });
 await test('presentation snapshots require the current Mac native owner and are immutable copies',async()=>{
  const f=fixture();await f.manager.select(f.runtime,'custom:dev');
  const snapshot={cwd:'/workspace',sandbox:{type:'workspaceWrite',writableRoots:['/workspace/out']},activePermissionProfile:{id:'dev'},approvalPolicy:'untrusted'};
  const owner={permissionProfile:'dev',permissionSnapshot:snapshot};f.owners.owner=()=>owner;
  const first=f.manager.snapshot(f.runtime);first.sandbox.writableRoots.push('/changed');
  assert.equal(snapshot.sandbox.writableRoots.length,1);
  for(const change of [{closed:true},{permissionProfile:'other'},{permissionSnapshot:{...snapshot,cwd:'/other'}},{permissionSnapshot:{...snapshot,sandbox:null}}]){
   const previous={...owner};Object.assign(owner,change);assert.throws(()=>f.manager.snapshot(f.runtime),/未就緒/);
   for(const key of Object.keys(owner))delete owner[key];Object.assign(owner,previous);
  }
  f.runtime.openCodexPermissionChanging=true;assert.throws(()=>f.manager.snapshot(f.runtime),/未就緒/);
 });
 await test('missing custom session cannot cause unrestricted attachment reads',async()=>{
  await assert.rejects(convertInput({permissionMode:'custom:dev'},[{type:'localImage',path:'/never-read'}]),/未讀取/);
  await assert.rejects(convertInput({permissionMode:'full',openCodexPermissions:{}},[]),/未讀取/);
 });
 console.log(JSON.stringify({passed}));
})().catch(error=>{console.error(error);process.exitCode=1;});
