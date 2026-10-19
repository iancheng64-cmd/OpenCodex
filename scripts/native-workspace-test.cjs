'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const workspace=require('../src/native-workspace.cjs'),routing=require('../src/native-routing.cjs'),tests=[];
async function test(name,fn){await fn();tests.push(name);}
(async()=>{
 const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'opencodex-workspace-')));
 try{
  const a=path.join(temp,'a'),b=path.join(temp,'b'),alias=path.join(temp,'alias');
  await fs.mkdir(a);await fs.mkdir(b);await fs.symlink(a,alias);await fs.writeFile(path.join(a,'file'),'test');
  await test('native project selection resolves Mac directories and rejects invalid or foreign paths',async()=>{
   assert.equal(await workspace.resolveCwd({cwd:alias},{localCwd:b},b),a);
   assert.equal(await workspace.resolveCwd({}, {localCwd:b},a),b);
   assert.equal(await workspace.resolveCwd({}, {summary:{cwd:'C:\\peer'}},a),a);
   for(const cwd of ['C:\\peer','relative',path.join(a,'file'),path.join(a,'missing')])await assert.rejects(workspace.resolveCwd({cwd},null,a));
  });
  await test('workspace preparation prevents parallel starts and honors cancellation',async()=>{
   const rt={};const lease=workspace.acquire(rt);assert.throws(()=>workspace.acquire(rt),/執行/);
   rt.openCodexPreparing.cancelled=true;assert.throws(()=>lease.check(),/取消/);lease.release();assert.equal(rt.openCodexPreparing,null);
   rt.run={};assert.throws(()=>workspace.acquire(rt),/執行/);delete rt.run;
   const next=workspace.acquire(rt);rt.closed=true;assert.throws(()=>next.check(),/取消/);next.release();
  });
  await test('native parent and child history restores queue behind preparation without allowing parallel turns',async()=>{
   const rt={};const parent=await workspace.acquireAsync(rt,{threadId:'parent',restore:true});
   const next=workspace.acquireAsync(rt,{threadId:'child',restore:true});
   await assert.rejects(workspace.acquireAsync(rt,{threadId:'new-turn'}),/執行/);
   parent.release();const child=await next;assert.equal(rt.openCodexPreparing.threadId,'child');child.release();
   rt.run={threadId:'parent'};await assert.rejects(workspace.acquireAsync(rt,{threadId:'child',restore:true}),/執行/);
  });
  await test('ephemeral title preparation cannot drop a concurrent user submission',async()=>{
   const rt={};const title=await workspace.acquireAsync(rt,{ephemeral:true});
   const userPromise=workspace.acquireAsync(rt,{threadId:'user'});
   title.release();const user=await userPromise;assert.equal(rt.openCodexPreparing.threadId,'user');
   const backgroundPromise=workspace.acquireAsync(rt,{threadId:'title',ephemeral:true});
   rt.run={threadId:'user',ephemeral:false};user.release();
   await new Promise(r=>setTimeout(r,35));assert.equal(rt.openCodexPreparing,null);
   rt.run=null;const background=await backgroundPromise;assert.equal(rt.openCodexPreparing.ephemeral,true);background.release();
  });
  await test('queued requests prioritize user work and cancel without touching an active turn',async()=>{
   const rt={run:{threadId:'title',ephemeral:true}};
   const backgroundPromise=workspace.acquireAsync(rt,{threadId:'title-next',ephemeral:true});
   const userPromise=workspace.acquireAsync(rt,{threadId:'user'});
   rt.run=null;const user=await userPromise;assert.equal(rt.openCodexPreparing.threadId,'user');
   assert.equal(workspace.cancelPending(rt,'title-next'),true);
   await assert.rejects(backgroundPromise,/取消/);user.release();
   rt.run={threadId:'user',ephemeral:false};
   await assert.rejects(workspace.acquireAsync(rt,{threadId:'other'}),/執行/);
   const cancelled=workspace.acquireAsync(rt,{threadId:'title',ephemeral:true});
   workspace.cancelPending(rt,'title');await assert.rejects(cancelled,/取消/);
   assert.equal(rt.run.threadId,'user');
  });
  await test('queued title work is bounded and fails when its frontend disconnects',async()=>{
   const rt={run:{threadId:'user'}};
   await assert.rejects(workspace.acquireAsync(rt,{ephemeral:true,timeoutMs:5}),/逾時/);
   let current=true;const disconnected=workspace.acquireAsync(rt,{ephemeral:true,isCurrent:()=>current});current=false;
   await assert.rejects(disconnected,/取消/);
   const closed=workspace.acquireAsync(rt,{ephemeral:true});rt.closed=true;await assert.rejects(closed,/取消/);
  });
  await test('title unsubscribe cancels queued and preparing work without cancelling the user turn',async()=>{
   const rt={run:{threadId:'user',ephemeral:false}},calls=[];
   const title=workspace.acquireAsync(rt,{threadId:'title',ephemeral:true});
   assert(await workspace.cancelEphemeral(rt,'title',async id=>calls.push(id)));
   await assert.rejects(title,/取消/);assert.equal(rt.run.threadId,'user');assert.deepEqual(calls,[]);
   rt.run=null;const lease=await workspace.acquireAsync(rt,{threadId:'title',ephemeral:true});
   assert(await workspace.cancelEphemeral(rt,'title',async id=>calls.push(id)));
   assert.throws(()=>lease.check(),/取消/);assert(rt.openCodexPreparing);lease.release();
   rt.run={threadId:'title',ephemeral:true,requestId:'request-title'};
   assert(await workspace.cancelEphemeral(rt,'title',async id=>calls.push(id)));
   assert.deepEqual(calls,['request-title']);
   assert.equal(await workspace.cancelEphemeral(rt,'user',async()=>{throw Error('foreign run')}),false);
   rt.run={threadId:'user',ephemeral:false};
   assert.equal(await workspace.cancelEphemeral(rt,'user',async()=>{throw Error('user run')}),false);
  });
  await test('runtime cancellation releases missing remote threads and never interrupts a managed root twice',async()=>{
   const patch=require('./subagent-patches.cjs').backend;
   const source=patch(await fs.readFile(path.join(__dirname,'../build/OpenCodex.app/Contents/Resources/agentbridge/app/dist-main/runtime-backend.js'),'utf8'));
   assert.equal(patch(source),source,'patch must remain idempotent on refreshed builds');
   const begin=source.indexOf('    electron_1.ipcMain.handle("runtime:cancel"');
   const end=source.indexOf('    electron_1.ipcMain.handle("runtime:respond"',begin);
   assert(begin>=0&&end>begin);
   for(const managed of [false,true]){
    const run={openCodex:true,requestId:'r',threadId:'title',turnId:'t',turnStarting:true,messages:new Map()};
    let handler,cleanup,interrupts=0,managedStops=0;
    const rt={run,requests:new Map(),rpc:{request:async()=>{interrupts++;throw Error('thread not found');}},toolHost:{cancelActive(){}}};
    if(managed)rt.openCodexSubagents={cancel:async()=>{assert(!run.cancelled,'coordinator must receive an active root');managedStops++;run.cancelled=true;}};
    vm.runInNewContext(source.slice(begin,end),{electron_1:{ipcMain:{handle:(_name,fn)=>handler=fn}},getRuntime:()=>rt,deps:{},emitForRun(){},clearTimeout,setTimeout:fn=>{cleanup=fn;return{unref(){}};}});
    if(managed)assert.equal((await handler({},'runtime','r')).cancelled,true);
    else await assert.rejects(handler({},'runtime','r'),/thread not found/);
    assert(run.cancelled);assert.equal(interrupts,managed?0:1);assert.equal(managedStops,managed?1:0);
    assert.equal(typeof cleanup,'function');cleanup();assert.equal(rt.run,undefined);
    const replacement={requestId:'new'};rt.run=replacement;cleanup();assert.equal(rt.run,replacement);
   }
  });
  await test('project filter traverses remote pages using local ownership and Mac cwd',async()=>{
   const known={a:{profile:'p',localCwd:a},b:{profile:'p',localCwd:b},foreign:{profile:'else',localCwd:a}};
   const seen=[];const result=await routing.ownedPage({request:async(_m,p)=>{assert.equal(p.cwd,undefined);seen.push(p.cursor);return p.cursor?{data:[{thread:{id:'a',cwd:'C:\\peer'}}],nextCursor:null}:{data:[{thread:{id:'b'}},{thread:{id:'foreign'}}],nextCursor:'two'};}},'thread/search',{cwd:a},known,'p');
   assert.deepEqual(seen,[null,'two']);assert.equal(result.data.length,1);assert.equal(result.data[0].thread.cwd,a);
   assert.equal(workspace.localThread({id:'a',cwd:'C:\\peer'},known).cwd,a);
   assert.equal(workspace.localThread({id:'a'},known,b).cwd,b);
  });
  await test('detached reviews inherit project and permission selection',async()=>{
   const calls=[];await require('../src/native-review.cjs').detachedReview({threadId:'source',cwd:b,permissions:':workspace'},async(m,p)=>{calls.push([m,p]);return m==='thread/start'?{thread:{id:'review'}}:{reviewThreadId:'review'};});
   assert.deepEqual(calls[0][1],{cwd:b,permissions:':workspace'});assert.equal(calls[1][1].cwd,b);
  });
  await test('tool host changes writable root, default cwd and all project extension clients together',async()=>{
   const {LocalToolHost}=require('../build/OpenCodex.app/Contents/Resources/agentbridge/app/dist-main/local-tool-host.js');
   const host=Object.create(LocalToolHost.prototype),stopped=[];
   Object.assign(host,{active:new Map(),roots:[a],readonlyRoots:[],options:{allowedRoots:[a],extensionServers:[]},core:{config:{cwd:a},jobs:new Map()},extensionClients:new Map([['old',{stop:async()=>stopped.push('old')}]]),entries:new Map([['base',{category:'fs'}],['extension',{extensionId:'old'}]]),extensionStatuses:[{id:'old'}]});
   host.registerExtension=async spec=>{host.extensionClients.set(spec.id,{stop:async()=>{}});host.entries.set(spec.id,{extensionId:spec.id});host.extensionStatuses.push({id:spec.id});};
   await host.setWorkspace(b,[{id:'new'}]);assert.deepEqual(stopped,['old']);assert.deepEqual(host.roots,[b]);assert.equal(host.core.config.cwd,b);assert.deepEqual([...host.entries.keys()],['base','new']);
   assert.equal(await host.guard(b),b);await assert.rejects(host.guard(path.join(a,'file')));
   host.active.set('running',{});await assert.rejects(host.setWorkspace(a,[]),/執行/);assert.deepEqual(host.roots,[b]);host.active.clear();
   host.core.jobs.set('process',{state:'running'});await assert.rejects(host.setWorkspace(a,[]),/執行/);assert.deepEqual(host.roots,[b]);
  });
  const report={version:'0.4.1',at:new Date().toISOString(),passed:true,tests,scope:'Local filesystem and packaged host; live SSH is tested separately'};
  await fs.writeFile(path.join(__dirname,'../evidence/native-workspace-unit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await fs.rm(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1)});
