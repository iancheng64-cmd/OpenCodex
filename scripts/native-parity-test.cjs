'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const routing=require('../src/native-routing.cjs'),workspace=require('../src/native-workspace.cjs'),policy=require('../src/native-policy.cjs'),{NativeTools}=require('../src/native-tools.cjs');
const tests=[],test=async(name,fn)=>{await fn();tests.push(name);};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
(async()=>{
 await test('resource-only and template-only native plugins remain discoverable and readable',async()=>{
  const owner=new NativeTools({});owner.ready=async()=>[
   {name:'resources',runtimeStatus:'connected',resources:[{uri:'test://one',name:'one'}]},
   {name:'templates',runtimeStatus:'connected',tools:{},resourceTemplates:[{uriTemplate:'test://{id}',name:'ids'}]},
   {name:'disabled',runtimeStatus:'disabled',resources:[{uri:'hidden'}]}];
  owner.resource=async(server,uri)=>({contents:[{uri,text:server}]});
  const specs=await owner.specs();assert.equal(specs.length,2);
  const client=specs[0].createClient();assert.deepEqual(await client.start(),[]);
  assert.equal((await client.resource('resources/list',{})).resources[0].uri,'test://one');
  assert.equal((await client.resource('resources/read',{uri:'test://one'})).contents[0].text,'resources');
  assert.equal((await specs[1].createClient().resource('resources/templates/list',{})).resourceTemplates.length,1);
  owner.close();
 });
 await test('capabilities and realtime voices use the same remote provider as inference',async()=>{
  assert(routing.reads.has('modelProvider/capabilities/read'));assert(routing.reads.has('thread/realtime/listVoices'));
 });
 await test('stream ids are isolated per frontend; stop returns to the originating host',async()=>{
  const calls=[],events=[],streams=new routing.NativeEventStreams({send:(client,m)=>events.push([client,m])});
  const a={},b={},rt={rpc:{request:async(method,p)=>{calls.push([method,p]);return {};}}};
  await streams.start(rt,a,{threadId:'t',subscriptionId:'same'});await streams.start(rt,b,{threadId:'t',subscriptionId:'same'});
  const first=calls[0][1].subscriptionId,second=calls[1][1].subscriptionId;assert.notEqual(first,second);
  streams.notification(rt,{method:'mcpServer/event/stream/notification',params:{subscriptionId:first,notification:{method:'update',params:{ok:true}}}});
  assert.equal(events.length,1);assert.equal(events[0][0],a);assert.equal(events[0][1].params.subscriptionId,'same');
  streams.notification({}, {method:'mcpServer/event/stream/notification',params:{subscriptionId:first}});
  assert.equal(events.length,1);
  await streams.stop(a,'same');assert.equal(calls.at(-1)[1].subscriptionId,first);
  assert.throws(()=>streams.stop(a,'same'),/不存在/);
  await streams.closeClient(b);assert.equal(calls.at(-1)[1].subscriptionId,second);assert.equal(streams.entries.size,0);
 });
 await test('terminal stream events release only their owner and allow immediate resubscription',async()=>{
  const calls=[],events=[],client={},other={},rt={rpc:{request:async(m,p,timeout)=>{calls.push({m,p,timeout});return {};}}};
  const streams=new routing.NativeEventStreams({send:(c,m)=>events.push([c,m])});
  await streams.start(rt,client,{subscriptionId:'reusable'});
  assert(calls[0].timeout>90000,'bridge timeout must exceed engine activation timeout');
  const id=calls[0].p.subscriptionId;
  const terminal={method:'mcpServer/event/stream/notification',params:{subscriptionId:id,notification:{method:'notifications/events/terminated',params:{}}}};
  streams.notification(other,terminal);assert.equal(streams.entries.size,1);assert.equal(events.length,0);
  streams.notification(rt,terminal);assert.equal(streams.entries.size,0);assert.equal(events.length,1);
  assert.equal(events[0][0],client);assert.equal(events[0][1].params.subscriptionId,'reusable');
  await streams.start(rt,client,{subscriptionId:'reusable'});
  assert.notEqual(calls[1].p.subscriptionId,id);
  streams.notification(rt,terminal);assert.equal(streams.entries.size,1);assert.equal(events.length,1);
  await streams.closeClient(client);assert.equal(streams.entries.size,0);
 });
 await test('termination during close releases the lease without duplicate stop or delivery',async()=>{
  const gate=deferred(),calls=[],client={},rt={rpc:{request:async(m,p)=>{calls.push([m,p]);return m.endsWith('/start')?gate.promise:{};}}};
  const streams=new routing.NativeEventStreams({send:()=>assert.fail('closed frontend received event')});
  const start=streams.start(rt,client,{subscriptionId:'closing'});await Promise.resolve();
  const close=streams.closeClient(client);
  streams.notification(rt,{method:'mcpServer/event/stream/notification',params:{subscriptionId:calls[0][1].subscriptionId,notification:{method:'notifications/events/terminated'}}});
  assert.equal(streams.entries.size,0);gate.resolve({});await start;await close;
  assert.equal(calls.length,1);
 });
 await test('closing a frontend during stream startup waits then cancels without leaking events',async()=>{
  const gate=deferred(),calls=[],events=[];
  const rt={rpc:{request:async(m,p)=>{calls.push([m,p]);if(m.endsWith('/start'))return gate.promise;return {};}}};
  const client={},streams=new routing.NativeEventStreams({send:(c,m)=>events.push(m)});
  const start=streams.start(rt,client,{subscriptionId:'pending'});await Promise.resolve();
  const close=streams.closeClient(client);
  streams.notification(rt,{method:'mcpServer/event/stream/notification',params:{subscriptionId:calls[0][1].subscriptionId}});
  gate.resolve({});await start;await close;
  assert.equal(events.length,0);assert.equal(calls[1][0],'mcpServer/event/stream/stop');assert.equal(streams.entries.size,0);
 });
 await test('failed stream startup is cleaned on its peer and disconnected host events are discarded',async()=>{
  const calls=[],errors=[],rt={rpc:{request:async(m,p)=>{calls.push(m);if(m.endsWith('/start'))throw Error('start timeout');return {};}}};
  const streams=new routing.NativeEventStreams({send:()=>assert.fail('stale event'),onError:e=>errors.push(e)}),client={};
  await assert.rejects(streams.start(rt,client,{subscriptionId:'failed'}),/timeout/);
  assert.deepEqual(calls,['mcpServer/event/stream/start','mcpServer/event/stream/stop']);assert.equal(streams.entries.size,0);
  rt.rpc.request=async()=>({});await streams.start(rt,client,{subscriptionId:'gone'});const id=[...streams.entries.keys()][0];
  streams.disconnect(rt);assert.equal(streams.entries.size,0);
  assert.equal(streams.notification(rt,{method:'mcpServer/event/stream/notification',params:{subscriptionId:id}}),true);
 });
 await test('concurrent explicit stop and frontend close share one remote cancellation',async()=>{
  const gate=deferred(),calls=[],client={},rt={rpc:{request:async(m,p)=>{calls.push(m);return m.endsWith('/stop')?gate.promise:{};}}};
  const streams=new routing.NativeEventStreams({send:()=>assert.fail('closing stream delivered an event')});
  await streams.start(rt,client,{subscriptionId:'shared-stop'});
  const stop=streams.stop(client,'shared-stop'),close=streams.closeClient(client);
  await Promise.resolve();await Promise.resolve();
  gate.resolve({});await Promise.all([stop,close]);
  assert.equal(calls.filter(m=>m.endsWith('/stop')).length,1);assert.equal(streams.entries.size,0);
 });
 await test('failed startup and simultaneous close share cleanup while preserving the startup error',async()=>{
  const startup=deferred(),cleanup=deferred(),calls=[],client={},errors=[];
  const rt={rpc:{request:async(m,p)=>{calls.push(m);return m.endsWith('/start')?startup.promise:cleanup.promise;}}};
  const streams=new routing.NativeEventStreams({send:()=>assert.fail('closing stream delivered an event'),onError:e=>errors.push(e)});
  const start=assert.rejects(streams.start(rt,client,{subscriptionId:'startup-race'}),/activation failed/);
  await Promise.resolve();const close=streams.closeClient(client);startup.reject(Error('activation failed'));
  await Promise.resolve();await Promise.resolve();await Promise.resolve();cleanup.resolve({});
  await Promise.all([start,close]);
  assert.equal(calls.filter(m=>m.endsWith('/stop')).length,1);assert.equal(streams.entries.size,0);assert.deepEqual(errors,[]);
 });
 await test('failed stop remains retryable without forwarding events or changing owner',async()=>{
  let attempts=0;const client={},rt={rpc:{request:async(m)=>{if(m.endsWith('/stop')&&++attempts===1)throw Error('temporary stop failure');return {};}}};
  const streams=new routing.NativeEventStreams({send:()=>assert.fail('closing stream delivered an event')});
  await streams.start(rt,client,{subscriptionId:'retry'});
  const id=[...streams.entries.keys()][0];await assert.rejects(streams.stop(client,'retry'),/temporary stop failure/);
  assert.equal(streams.entries.size,1);
  streams.notification(rt,{method:'mcpServer/event/stream/notification',params:{subscriptionId:id,notification:{method:'update'}}});
  await streams.stop(client,'retry');assert.equal(attempts,2);assert.equal(streams.entries.size,0);
 });
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-parity-')));
 try{
  const a=path.join(temp,'a'),b=path.join(temp,'b');fs.mkdirSync(a);fs.mkdirSync(b);
  const calls=[],runtime={closed:false,localCwd:a,permissionMode:'project',snapshot:{profileId:'p'},rpc:{request:async(m,p)=>{
   calls.push([m,p]);if(m==='thread/start')return {thread:{id:'new',cwd:'C:\\peer'},cwd:'C:\\peer'};
   return {};
  }}};
  const adapter={exports:{},runtimes:new Map()};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bridge-adapter.cjs'),'utf8'),adapter);
  const ws={readyState:1};
  const context={clients:new Set([ws]),isRemote:()=>true,isClaude:()=>false,runtime,settings:{cwd:a,permissionMode:'project'},known:{t:{profile:'p',localCwd:a,summary:{id:'t',cwd:a}}},
   routing,workspace,nativePolicy:policy,pendingPermissions:new WeakMap(),organization:new (require('../src/native-organization.cjs').NativeOrganization)(path.join(temp,'organization.json')),nativeQueue:{starting:false,pause:()=>{}},nativeShell:new (require('../src/native-shell.cjs').NativeShell)({file:path.join(temp,'shell-history.json')}),
   bridge:{selectWorkspace:async(rt,cwd)=>{rt.localCwd=cwd;},runtimeDependencies:{}},
   backend:adapter.exports,handlers:new Map(),permissionChanging:false,agents:null,fs,knownFile:path.join(temp,'known.json'),remoteThreadCache:new Map(),
   audit:()=>{},publish:()=>{},save:()=>{},localRequest:()=>{throw Error('unexpected local route');}};
  const code=fs.readFileSync(path.join(__dirname,'../src/bootstrap.cjs'),'utf8');
  vm.runInNewContext(code.slice(code.indexOf('async function request(ws,'),code.indexOf('function openManager()')),context);
  await test('thread/settings/update moves the Mac executor, preserves model and strips Mac cwd from remote request',async()=>{
   await context.request(ws,'thread/settings/update',{threadId:'t',cwd:b,model:'chosen'});
   assert.equal(runtime.localCwd,b);assert.equal(context.known.t.localCwd,b);assert.equal(context.known.t.summary.cwd,b);
   assert.equal(calls.at(-1)[0],'thread/settings/update');assert.equal(calls.at(-1)[1].cwd,undefined);assert.equal(calls.at(-1)[1].model,'chosen');
   assert.equal(runtime.openCodexPreparing,null);
   runtime.run={};await assert.rejects(context.request(ws,'thread/settings/update',{threadId:'t',cwd:a}),/執行/);
   await context.request(ws,'thread/settings/update',{threadId:'t',model:'active-model'});assert.equal(calls.at(-1)[1].model,'active-model');runtime.run=null;
  });
  await test('settings permission downgrade respects the executor policy without forwarding unrestricted sandbox',async()=>{
   runtime.permissionMode='ask';
   await adapter.exports.openCodexRequest(runtime,{},'thread/settings/update',{threadId:'t',cwd:b,sandboxPolicy:{type:'dangerFullAccess'}});
   assert.equal(calls.at(-1)[1].sandboxPolicy.type,'readOnly');assert.equal(calls.at(-1)[1].approvalPolicy,'untrusted');
  });
  await test('failed native permission update restores the executor and never persists a rejected choice',async()=>{
   const original=runtime.rpc.request,changes=[];runtime.permissionMode='project';context.settings.permissionMode='project';context.known.t.permissionMode='project';
   context.handlers.set('runtime:permission',async(_event,_id,mode)=>{changes.push(mode);runtime.permissionMode=mode;});
   runtime.rpc.request=async()=>{throw Error('peer settings rejected');};
   await assert.rejects(context.request(ws,'thread/settings/update',{threadId:'t',permissions:':danger-full-access'}),/peer settings rejected/);
   assert.deepEqual(changes,['full','project']);assert.equal(runtime.permissionMode,'project');
   assert.equal(context.settings.permissionMode,'project');assert.equal(context.known.t.permissionMode,'project');assert.equal(context.pendingPermissions.get(runtime).size,0);
   runtime.rpc.request=original;
  });
  await test('accepted native permission snapshots preserve Mac selection with highest override independent',async()=>{
   const original=runtime.rpc.request;
   runtime.rpc.request=async()=>({sandbox:{type:'readOnly'},approvalPolicy:'untrusted',activePermissionProfile:{id:'peer-only'}});
   context.settings.fullAccess=true;runtime.permissionMode='full';
   const value=await context.request(ws,'thread/settings/update',{threadId:'t',permissions:':workspace'});
   assert.equal(value.sandbox.type,'workspaceWrite');assert.equal(value.activePermissionProfile.id,':workspace');
   assert.equal(runtime.permissionMode,'full');assert.equal(context.settings.permissionMode,'project');assert.equal(context.known.t.permissionMode,'project');
   delete context.settings.fullAccess;runtime.permissionMode='project';runtime.rpc.request=original;
  });
  await test('concurrent setting changes cannot alter an already pending permission selection',async()=>{
   const original=runtime.rpc.request,gate=deferred();runtime.permissionMode='project';
   runtime.rpc.request=async()=>gate.promise;
   const first=context.request(ws,'thread/settings/update',{threadId:'t',permissions:':danger-full-access'});
   await Promise.resolve();await Promise.resolve();
   assert.equal(context.pendingPermissions.get(runtime).get('t').requested,'full');
   await assert.rejects(context.request(ws,'thread/settings/update',{threadId:'t',permissions:':read-only'}),/正在更新/);
   assert.equal(runtime.permissionMode,'full');gate.resolve({sandbox:{type:'dangerFullAccess'}});await first;
   assert.equal(context.known.t.permissionMode,'full');assert.equal(context.pendingPermissions.get(runtime).size,0);
   runtime.rpc.request=original;
  });
  await test('post-turn MCP app calls restore the thread workspace and stop with its lease',async()=>{
   const mcp=require('../src/native-mcp.cjs');
   context.require=name=>require(path.join(__dirname,'../src',name));context.AbortController=AbortController;context.setInterval=setInterval;context.clearInterval=clearInterval;
   context.settings.fullAccess=true;runtime.permissionMode='full';runtime.mcp={name:'mac'};
   const uri=mcp.namespaceUri('fixture','ui://app');
   const params={threadId:'t',server:'mac',tool:'click',arguments:{},_meta:{'opencodex/resourceUri':uri}};
   let called=false;runtime.toolHost={openCodexMcpToolCall:async(p,options)=>{called=true;assert.equal(p,params);assert(options.isAuthorized());assert.equal(runtime.localCwd,b);assert(runtime.openCodexPreparing);return {content:[]};}};
   assert.deepEqual(await context.request(ws,'mcpServer/tool/call',params),{content:[]});assert(called);assert.equal(runtime.openCodexPreparing,null);
   runtime.toolHost.openCodexMcpToolCall=async(p,{signal,isAuthorized})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{assert.equal(isAuthorized(),false);reject(Error('app aborted'));},{once:true});});
   const pending=context.request(ws,'mcpServer/tool/call',params);
   while(!runtime.openCodexPreparing)await new Promise(r=>setTimeout(r,1));
   await new Promise(r=>setTimeout(r,10));
   await context.request(ws,'turn/interrupt',{threadId:'t'});await assert.rejects(pending,/app aborted/);assert.equal(runtime.openCodexPreparing,null);
   await assert.rejects(context.request(ws,'mcpServer/tool/call',{...params,server:'foreign'}),/不屬於/);
   delete context.settings.fullAccess;
  });
  await test('automation receives a Mac cwd in both locations and can start its next native step',async()=>{
   const original={thread:{id:'new',cwd:'C:\\peer'},cwd:'C:\\peer',model:'chosen'};
   const mapped=workspace.localResult(original,{},b);
   assert.equal(mapped.cwd,b);assert.equal(mapped.thread.cwd,b);assert.equal(original.cwd,'C:\\peer');
   assert.equal(await workspace.resolveCwd({cwd:mapped.cwd},{},a),b);
   assert.equal(workspace.localResult({thread:{id:'t',cwd:'C:\\peer'},cwd:'C:\\peer'},context.known).cwd,b);
  });
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
 const report={version:'0.4.3',at:new Date().toISOString(),passed:true,tests,scope:'Regression tests with temporary Mac directories and mocked SSH; no live provider claim'};
 fs.writeFileSync(path.join(__dirname,'../evidence/native-parity-test.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.stack);process.exitCode=1});
