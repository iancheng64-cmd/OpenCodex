'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {NativeAgentRuns,receiptFor,configureSubagents}=require('../src/native-agent-runs.cjs');
const {withRun,scopedRun,turnMetadata}=require('../src/native-run-context.cjs');
const {NativeTools}=require('../src/native-tools.cjs');
const patches=require('./subagent-patches.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[];
const test=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
function setup(){
 const threads=new Map(),interrupts=[],cleaned=[],events=[],history=[];
 const root={openCodex:true,requestId:'request-root',threadId:'root',turnId:'root-turn',toolGate:Promise.resolve(true),cancelled:false};
 const runtime={id:'runtime',snapshot:{profileId:'host',runtimeVersion:'0.160.0'},mcp:{name:'mac'},executor:{environmentId:'env',isRunning:true},permissionMode:'project',localCwd:'/tmp',requests:new Map(),run:root,toolHost:{cancelRun:r=>cleaned.push(r.threadId)},openCodexChildThread:t=>history.push(t.id)};
 function thread(id,parent=null,depth=0){const t={id,cwd:'/tmp',parentThreadId:parent,source:parent?{subAgent:{thread_spawn:{parent_thread_id:parent,depth}}}:'appServer',environments:[{environmentId:'env',cwd:'/tmp',runtimeWorkspaceRoots:['/tmp']}],turns:[{id:id+'-turn',status:'inProgress'}]};threads.set(id,t);return t;}
 thread('root');thread('child','root',1);thread('grand','child',2);thread('sibling','root',1);
 runtime.rpc={async request(method,p){if(method==='thread/read')return {thread:structuredClone(threads.get(p.threadId))};if(method==='turn/interrupt'){interrupts.push(p);return {};}throw Error(method);},reject(id,message){events.push({reject:id,message});}};
 const config={'features.multi_agent':true,'features.multi_agent_v2':true,mcp_servers:{mac:{environment_id:'env'},peer:{enabled:false}}};
 configureSubagents(runtime,{},config);
 const manager=new NativeAgentRuns(runtime,{emit:(_,e)=>events.push(e)},root,receiptFor(runtime,'root',config));runtime.openCodexSubagents=manager;
 const meta=(id,parent=null)=>({'x-codex-turn-metadata':{session_id:'root',thread_id:id,turn_id:id+'-turn',thread_source:parent?'subagent':'user',...(parent?{parent_thread_id:parent}:{})},threadId:id,sessionId:'root'});
 return {manager,runtime,root,threads,thread,interrupts,cleaned,events,history,meta,config};
}
function reviewSetup(){
 const x=setup();x.root.nativeReview=true;
 x.threads.set('review',{id:'review',parentThreadId:'root',source:{subAgent:'review'},cwd:'/tmp',cliVersion:'0.160.0',environments:null,status:{type:'notLoaded'},turns:[{id:'review-turn',status:'interrupted',completedAt:null}]});
 const meta=x.meta('review','root');Object.assign(meta['x-codex-turn-metadata'],{subagent_kind:'review',codex_version:'0.160.0'});
 x.manager.notification({method:'turn/started',params:{threadId:'root',turn:{id:'review-turn'}}});
 return {...x,reviewMeta:meta};
}
(async()=>{
 await test('product runtime cancellation preserves one Interrupt hook and scoped tool cleanup',async()=>{
  const source=patches.backend(fs.readFileSync(path.resolve(__dirname,'../build/OpenCodex.app/Contents/Resources/agentbridge/app/dist-main/runtime-backend.js'),'utf8'));
  assert.equal(patches.backend(source),source,'backend patches must be idempotent');
  const start=source.indexOf('    electron_1.ipcMain.handle("runtime:cancel",');
  const end=source.indexOf('    electron_1.ipcMain.handle("runtime:respond"',start);
  assert(start>=0&&end>start);
  for(const make of [setup,reviewSetup]){
   const x=make();let cancel,globalCancels=0,hookOwner;
   x.runtime.toolHost.generation=7;
   x.runtime.toolHost.cancelActive=()=>{globalCancels++;x.runtime.toolHost.generation++;};
   const request=x.runtime.rpc.request;
   x.runtime.rpc.request=async(method,p)=>{
    if(method==='turn/interrupt'){
     hookOwner=await x.manager.resolveHook({sessionId:'root',turnId:'root-turn',event:'Interrupt'},{threadId:'root'});
     assert(x.manager.interruptHookActive(hookOwner.interruptLease));
     await assert.rejects(()=>x.manager.resolve(x.meta('root')));
    }
    return request(method,p);
   };
   require('vm').runInNewContext(source.slice(start,end),{
    electron_1:{ipcMain:{handle:(name,fn)=>{assert.equal(name,'runtime:cancel');cancel=fn;}}},
    getRuntime:()=>x.runtime,deps:{},emitForRun:()=>{},clearTimeout,
    setTimeout:()=>({unref(){}})
   });
   assert.deepEqual(JSON.parse(JSON.stringify(await cancel({},'runtime','request-root'))),{cancelled:true});
   assert.equal(globalCancels,0);assert.equal(x.runtime.toolHost.generation,7);
   assert.equal(hookOwner.run,x.root);assert(x.cleaned.includes('root'));
   assert.equal(x.interrupts.length,1);assert.equal(x.interrupts[0].turnId,x.manager.reviewTurnId||'root-turn');
   x.manager.notification({method:'turn/completed',params:{threadId:'root',turn:{id:x.manager.reviewTurnId||'root-turn'}}});
   assert(!x.manager.interruptHookActive(hookOwner.interruptLease));x.manager.close();
  }
 });
 await test('cancel grants one Interrupt hook without restoring normal tools',async()=>{
  for(const make of [setup,reviewSetup]){
   const x=make(),args={sessionId:'root',turnId:'root-turn',event:'Interrupt'},meta={threadId:'root'};
   await assert.rejects(()=>x.manager.resolveHook(args,meta));
   await x.manager.cancel('root','root-turn');
   await assert.rejects(()=>x.manager.resolveHook({...args,turnId:'stale'},meta));
   await assert.rejects(()=>x.manager.resolveHook(args,{threadId:'child'}));
   const owner=await x.manager.resolveHook(args,meta);
   assert.equal(owner.run,x.root);assert(x.manager.interruptHookActive(owner.interruptLease));
   await assert.rejects(()=>x.manager.resolveHook(args,meta));
   await assert.rejects(()=>x.manager.resolve(x.meta('root')));
   x.manager.notification({method:'turn/completed',params:{threadId:'root',turn:{id:x.manager.reviewTurnId||'root-turn'}}});
   assert(!x.manager.interruptHookActive(owner.interruptLease));x.manager.close();
  }
 });
 await test('Interrupt leases expire on host change, replacement, shutdown and deadline',async()=>{
  for(const mutate of [
   x=>{x.runtime.toolHost.generation=1;},x=>{x.runtime.toolHost={};},
   x=>{x.runtime.run={...x.root};},x=>{x.runtime.openCodexSubagents=null;},
   x=>{x.runtime.closed=true;},x=>{x.manager.interruptHook.expiresAt=0;},x=>x.manager.close()
  ]){
   const x=setup();await x.manager.cancel('root','root-turn');mutate(x);
   await assert.rejects(()=>x.manager.resolveHook({sessionId:'root',turnId:'root-turn',event:'Interrupt'},{threadId:'root'}));x.manager.close();
  }
 });
 await test('Interrupt admission cannot race completion or duplicate gate waiters',async()=>{
  const x=setup();let release;x.root.toolGate=new Promise(r=>release=r);
  await x.manager.cancel('root','root-turn');
  const args={sessionId:'root',turnId:'root-turn',event:'Interrupt'},meta={threadId:'root'};
  const pending=x.manager.resolveHook(args,meta);
  await assert.rejects(()=>x.manager.resolveHook(args,meta));
  x.manager.notification({method:'turn/completed',params:{threadId:'root',turn:{id:'root-turn'}}});release(true);
  await assert.rejects(()=>pending);x.manager.close();
 });
 await test('Hooks verify root session separately from nested thread and inherit only verified subagent identity',async()=>{
  const x=setup(),args={sessionId:'root',turnId:'grand-turn',event:'PreToolUse'};
  const owner=await x.manager.resolveHook(args,{threadId:'grand'});
  assert.equal(owner.run.threadId,'grand');assert.equal(owner.sessionId,'root');assert.equal(owner.threadId,'grand');
  assert.deepEqual(owner.subagent,{agentId:'grand',agentType:'default'});
  assert.equal((await x.manager.resolveHook({sessionId:'root',event:'SessionStart'},{threadId:'root'})).turnId,'root-turn');
  assert.equal((await x.manager.resolveHook({...args,event:'SubagentStop',agentId:'grand',agentType:'default'},{threadId:'grand'})).run,owner.run);
  const invalid=[
   [{...args,sessionId:'grand'},{threadId:'grand'}],
   [args,{threadId:'grand',sessionId:'peer'}],
   [{...args,turnId:'old'},{threadId:'grand'}],
   [{...args,event:'SessionStart'},{threadId:'grand'}],
   [{...args,event:'Stop'},{threadId:'grand'}],
   [{...args,event:'SubagentStart',agentId:'root',agentType:'default'},{threadId:'grand'}],
   [{...args,event:'SubagentStop',agentId:'grand',agentType:'forged'},{threadId:'grand'}]
  ];
  for(const [a,m] of invalid)await assert.rejects(()=>x.manager.resolveHook(a,m));
  x.thread('foreign','peer',1);await assert.rejects(()=>x.manager.resolveHook({...args,turnId:'foreign-turn'},{threadId:'foreign'}));
  await x.manager.cancel('grand','grand-turn');await assert.rejects(()=>x.manager.resolveHook(args,{threadId:'grand'}));
  const sibling=await x.manager.resolveHook({...args,turnId:'sibling-turn'},{threadId:'sibling'});assert(x.manager.isActive(sibling.run));x.manager.close();
 });
 await test('Hook review routing checks real internal transcript and remains scoped to the outer review',async()=>{
  const x=reviewSetup(),args={sessionId:'root',turnId:'review-turn',event:'PreToolUse'};
  const owner=await x.manager.resolveHook(args,{threadId:'review'});
  assert.equal(owner.run,x.root);assert.equal(owner.threadId,'review');assert.equal(owner.turnId,'review-turn');assert.equal(owner.subagent,null);
  await assert.rejects(()=>x.manager.resolveHook({...args,event:'SubagentStop',agentId:'review',agentType:'default'},{threadId:'review'}));
  await assert.rejects(()=>x.manager.resolveHook({...args,event:'Stop'},{threadId:'review'}));
  await x.manager.cancel('root','root-turn');await assert.rejects(()=>x.manager.resolveHook(args,{threadId:'review'}));x.manager.close();
  const y=reviewSetup();y.threads.get('review').parentThreadId='peer';await assert.rejects(()=>y.manager.resolveHook(args,{threadId:'review'}));y.manager.close();
 });
 await test('a remote Mac engine review may adopt the declared Mac environment cwd but no other path',async()=>{
  const x=reviewSetup();x.threads.get('root').cwd='/Users/remote-home';
  assert.equal(await x.manager.resolve(x.reviewMeta),x.root,'review in the declared Mac environment is accepted');x.manager.close();
  const y=reviewSetup();y.threads.get('root').cwd='/Users/remote-home';y.threads.get('review').cwd='/Users/elsewhere';
  await assert.rejects(()=>y.manager.resolve(y.reviewMeta),/Unverified review transcript \(cwd\)/);y.manager.close();
 });
 await test('native review binds its internal identity to the verified outer turn and scoped approval',async()=>{
  const x=reviewSetup();const [a,b]=await Promise.all([x.manager.resolve(x.reviewMeta),x.manager.resolve(x.reviewMeta)]);
  assert.equal(a,x.root);assert.equal(a,b);assert.equal(x.manager.registry.records.size,1);assert.deepEqual(x.history,[]);
  x.runtime.permissionMode='ask';const pending=withRun(x.runtime,a,()=>x.manager.authorize({name:'read',category:'filesystem-read'}));
  assert.equal(x.runtime.requests.size,1);await x.manager.cancel('root','root-turn');assert.equal(await pending,false);
  assert.deepEqual(x.interrupts,[{threadId:'root',turnId:'review-turn'}]);await assert.rejects(()=>x.manager.resolve(x.reviewMeta));x.manager.close();
 });
 await test('SSH review matches remote transcript cwd while root retains the Mac executor binding',async()=>{
  const x=reviewSetup();x.threads.get('root').cwd='C:/remote';x.threads.get('review').cwd='C:/remote';
  assert.equal(await x.manager.resolve(x.reviewMeta),x.root);x.manager.close();
  for(const invalid of [null,undefined,'']){const y=reviewSetup();y.threads.get('root').cwd=invalid;y.threads.get('review').cwd=invalid;await assert.rejects(()=>y.manager.resolve(y.reviewMeta),/transcript/);y.manager.close();}
  const y=reviewSetup();y.threads.get('root').cwd='C:/remote';y.threads.get('review').cwd='C:/remote';y.threads.get('root').environments[0].cwd='/other';await assert.rejects(()=>y.manager.resolve(y.reviewMeta),/environment/);y.manager.close();
 });
 await test('review tool and approval wait for the start response before reading the root turn',async()=>{
  const x=reviewSetup();let release;x.root.turnId=undefined;x.root.toolGate=new Promise(r=>release=r);
  const forwarded=[];x.runtime.openCodexServerRequest=(request,run)=>{forwarded.push(run);return true;};
  const pending=x.manager.resolve(x.reviewMeta);
  x.manager.serverRequest({id:4,method:'item/commandExecution/requestApproval',params:{threadId:'root',turnId:'review-turn',environmentId:'env'}});
  await pause(1);assert.equal(x.manager.registry.records.size,0);assert.equal(forwarded.length,0);
  x.root.turnId='root-turn';release(true);assert.equal(await pending,x.root);await pause(1);assert.deepEqual(forwarded,[x.root]);x.manager.close();
 });
 await test('review cancellation before the start notification retains only its interrupt identity',async()=>{
  const x=reviewSetup();x.manager.reviewTurnId=undefined;x.root.turnId=undefined;await x.manager.cancel('root',undefined);
  x.manager.notification({method:'turn/started',params:{threadId:'root',turn:{id:'review-turn'}}});
  assert.equal(x.manager.reviewTurnId,'review-turn');await assert.rejects(()=>x.manager.resolve(x.reviewMeta),/ended/);x.manager.close();
 });
 await test('review admission rejects ordinary runs, stale events, foreign identity and altered transcript',async()=>{
  const mutations=[
   x=>{x.root.nativeReview=false;},x=>{x.manager.reviewTurnId=undefined;},
   x=>{x.reviewMeta['x-codex-turn-metadata'].parent_thread_id='peer';},
   x=>{x.reviewMeta['x-codex-turn-metadata'].codex_version='0.161.0';},
   x=>{x.reviewMeta['x-codex-turn-metadata'].turn_id='old';},
   x=>{x.threads.get('review').cwd='/remote';},x=>{x.threads.get('review').parentThreadId='peer';},
   x=>{x.threads.get('review').source={subAgent:'guardian'};},x=>{x.threads.get('review').cliVersion='0.161.0';},
   x=>{x.threads.get('review').turns[0].id='old';},x=>{x.threads.get('review').turns[0].completedAt=123;}
  ];
  for(const mutate of mutations){const x=reviewSetup();mutate(x);await assert.rejects(()=>x.manager.resolve(x.reviewMeta));x.manager.close();}
  const x=reviewSetup();await x.manager.resolve(x.reviewMeta);
  const next=structuredClone(x.reviewMeta);next.threadId='other';next['x-codex-turn-metadata'].thread_id='other';
  await assert.rejects(()=>x.manager.resolve(next),/identity changed/);x.manager.close();
 });
 await test('completion during review transcript verification cannot reopen tool access',async()=>{
  const x=reviewSetup(),request=x.runtime.rpc.request;let release,reading;
  const reached=new Promise(r=>reading=r),gate=new Promise(r=>release=r);
  x.runtime.rpc.request=async(method,p)=>{if(method==='thread/read'&&p.threadId==='review'){reading();await gate;}return request(method,p);};
  const pending=x.manager.resolve(x.reviewMeta);await reached;await x.manager.cancel('root','root-turn');release();
  await assert.rejects(()=>pending,/ended/);x.manager.close();
 });
 await test('review native approvals preserve outer ownership and require the Mac environment',async()=>{
  const x=reviewSetup(),forwarded=[];x.runtime.openCodexServerRequest=(request,run)=>{forwarded.push({request,run});return true;};
  x.manager.serverRequest({id:1,method:'item/commandExecution/requestApproval',params:{threadId:'root',turnId:'review-turn',environmentId:'env'}});await pause(1);
  assert.equal(forwarded.length,1);assert.equal(forwarded[0].run,x.root);
  x.manager.serverRequest({id:2,method:'item/commandExecution/requestApproval',params:{threadId:'root',turnId:'review-turn',environmentId:'peer'}});await pause(1);
  assert(x.events.some(e=>e.reject===2&&/bound to Mac/.test(e.message)));
  x.manager.serverRequest({id:3,method:'item/fileChange/requestApproval',params:{threadId:'root',turnId:'old'}});await pause(1);
  assert(x.events.some(e=>e.reject===3));assert.equal(forwarded.length,1);x.manager.close();
 });
 await test('early and completed child history verifies ancestry without granting tool authority',async()=>{
  const x=setup();x.threads.get('grand').turns[0].status='completed';
  const [a,b]=await Promise.all([x.manager.discover('grand'),x.manager.discover('grand')]);
  assert.equal(a,b);assert.deepEqual(x.history,['grand']);assert.equal(x.manager.registry.records.size,0);
  x.thread('foreign','else',1);await assert.rejects(()=>x.manager.discover('foreign'),/ancestry/);
  x.threads.get('child').environments[0].environmentId='else';await assert.rejects(()=>x.manager.discover('child'),/environment/);
  x.runtime.openCodexSubagents=null;await assert.rejects(()=>x.manager.discover('sibling'),/available/);x.manager.close();
 });
 await test('authenticated metadata validates root, child, session and parent conflicts',async()=>{const x=setup();assert.equal(await x.manager.resolve(x.meta('root')),x.root);const child=await x.manager.resolve(x.meta('child','root'));assert.equal(child.parentThreadId,'root');for(const meta of [undefined,{}, {...x.meta('child','root'),threadId:'peer'},x.meta('child','other')])await assert.rejects(()=>x.manager.resolve(meta));const bad=x.meta('child','root');bad['x-codex-turn-metadata'].session_id='peer';await assert.rejects(()=>x.manager.resolve(bad));x.manager.close();});
 await test('concurrent scopes never fall back to root and isolate host processes',async()=>{const x=setup(),a=await x.manager.ensure('child','child-turn'),b=await x.manager.ensure('sibling','sibling-turn');await Promise.all([a,b].map((r,i)=>withRun(x.runtime,r,async()=>{await pause(i?2:6);assert.equal(scopedRun(x.runtime),r);assert.equal(scopedRun({}),undefined);})));assert.equal(scopedRun(x.runtime),undefined);x.manager.close();});
 await test('duplicate child admission shares identity; nested admission verifies every ancestor',async()=>{const x=setup();const [a,b]=await Promise.all([x.manager.ensure('grand','grand-turn'),x.manager.ensure('grand','grand-turn')]);assert.equal(a,b);assert.deepEqual(x.history,['child','grand']);assert.equal(a.rootThreadId,'root');assert.equal(await a.toolGate,true);x.manager.close();});
 await test('foreign environment and unsupported engine cannot gain inherited authority',async()=>{const x=setup();x.threads.get('child').environments[0].environmentId='peer';await assert.rejects(()=>x.manager.ensure('child','child-turn'),/environment/);assert.equal(receiptFor({...x.runtime,snapshot:{runtimeVersion:'0.161.0'}},'root',x.config),null);const unsafe={...x.config,mcp_servers:{...x.config.mcp_servers,peer:{enabled:true}}};configureSubagents(x.runtime,{},unsafe);assert.throws(()=>receiptFor(x.runtime,'root',unsafe),/Peer/);x.manager.close();});
 await test('remote role layers cannot enable inherited subagent authority',()=>{const x=setup(),config={...x.config};assert.equal(configureSubagents(x.runtime,{agents:{default:{config_file:'/remote/role.toml'}}},config),false);assert.equal(receiptFor(x.runtime,'root',config),null);assert.throws(()=>receiptFor(x.runtime,'root',{...x.config}),/not verified/);x.manager.close();});
 await test('subtree cancellation closes only its approvals and descendants',async()=>{const x=setup(),child=await x.manager.ensure('child','child-turn'),grand=await x.manager.ensure('grand','grand-turn'),sibling=await x.manager.ensure('sibling','sibling-turn');x.runtime.permissionMode='ask';const approvals=[child,grand,sibling].map(r=>withRun(x.runtime,r,()=>x.manager.authorize({name:'write',category:'filesystem-write',signal:r.signal})));assert.equal(x.runtime.requests.size,3);await x.manager.cancel('child','child-turn');assert.deepEqual(x.interrupts.map(p=>p.threadId).sort(),['child','grand']);assert.equal(await approvals[0],false);assert.equal(await approvals[1],false);assert.equal(x.runtime.requests.size,1);assert(x.manager.isActive(sibling));const remaining=[...x.runtime.requests.values()][0];remaining.localResolve(true);assert.equal(await approvals[2],true);await assert.rejects(()=>x.manager.cancel('sibling','old'),/Stale/);x.manager.close();});
 await test('stop before the first tool interrupts the root and closes the gate',async()=>{const x=setup();await x.manager.cancel('root','root-turn');assert.deepEqual(x.interrupts,[{threadId:'root',turnId:'root-turn'}]);assert(x.cleaned.includes('root'));await assert.rejects(()=>x.manager.resolve(x.meta('root')),/ended/);x.manager.close();});
 await test('closing before lazy root admission interrupts the in-flight root',async()=>{const x=setup();x.manager.close();await pause(1);assert.deepEqual(x.interrupts,[{threadId:'root',turnId:'root-turn'}]);assert(x.cleaned.includes('root'));x.manager.close();assert.equal(x.interrupts.length,1);});
 await test('root completion closes all scopes and interrupts pending children',async()=>{const x=setup();await x.manager.ensure('grand','grand-turn');x.manager.notification({method:'turn/completed',params:{threadId:'root',turn:{id:'root-turn'}}});await pause(1);assert.deepEqual(x.interrupts.map(p=>p.threadId).sort(),['child','grand']);await assert.rejects(()=>x.manager.resolve(x.meta('grand','child')),/ended/);assert.equal(x.runtime.toolHost.openCodexCurrentRun(),undefined);x.manager.close();});
 await test('full mode still requires a current verified run',async()=>{const x=setup(),child=await x.manager.ensure('child','child-turn');x.runtime.permissionMode='full';assert.equal(await x.manager.authorize({category:'shell'}),false);assert.equal(await withRun(x.runtime,child,()=>x.manager.authorize({category:'shell'})),true);await x.manager.cancel('child','child-turn');assert.throws(()=>withRun(x.runtime,child,()=>true),/cancelled/);x.manager.close();});
 await test('native plugin owners are isolated and cancelling a child preserves its sibling',()=>{const parent=new NativeTools({});const a={requestId:'a',parentThreadId:'root'},b={requestId:'b',parentThreadId:'root'},first=parent.ownerFor(a),second=parent.ownerFor(b);assert.notEqual(first,second);assert.equal(parent.ownerFor(a),first);assert.equal(first.getRun(),a);parent.cancelRun(a);assert(first.closed);assert(!second.closed);assert.equal(parent.runOwners.size,1);parent.close();assert(second.closed);});
 await test('patched process tools enforce owner scope and cancel actual owned process only',async()=>{
  const filename=path.resolve(__dirname,'../vendor/agentbridge/dist-main/agent-core-tools.js'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(patches.core(fs.readFileSync(filename,'utf8')),filename);
  const runtime={},a={openCodex:true,requestId:'a',threadId:'a',turnId:'ta'},b={...a,requestId:'b',threadId:'b'};
  const core=new m.exports.AgentCoreTools({cwd:'/tmp',guard:async p=>p,getRun:()=>scopedRun(runtime),capabilities:()=>({})}),entries=core.entries();
  const invoke=(run,name,args)=>withRun(runtime,run,async()=>JSON.parse((await entries.get(name).invoke(args,new AbortController().signal)).content[0].text));
  try{
   const one=await invoke(a,'mac_process_start',{command:'setTimeout(()=>{},60000)',runtime:'node'}),two=await invoke(b,'mac_process_start',{command:'setTimeout(()=>{},60000)',runtime:'node'});
   await assert.rejects(()=>invoke(a,'mac_process_status',{id:two.id}),/Unknown/);
   core.cancel(a.requestId);await pause(100);
   assert.equal((await invoke(a,'mac_process_status',{id:one.id})).state,'cancelled');assert.equal((await invoke(b,'mac_process_status',{id:two.id})).state,'running');
  }finally{core.cancel();}
 });
 const report={at:new Date().toISOString(),version:'0.4.9',passed:true,checks,scope:'coordinator, scoped approvals, actual process cancellation, plugin owner isolation; not model or GUI E2E'};
 fs.writeFileSync(path.resolve(__dirname,'../evidence/native-agent-runs-test.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;});
