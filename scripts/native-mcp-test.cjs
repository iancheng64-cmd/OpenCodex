'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {NativeMcpBridge,namespaceUri,isProjectedUri,projectTool,projectResult,bridgeToolName}=require('../src/native-mcp.cjs');
const {MacExtensionClient}=require('../vendor/agentbridge/dist-main/mac-extension-servers.js');
const vm=require('node:vm'),{createRequire}=require('node:module');
function fixtureHostClass(resourcesPath){
 const filename=path.resolve(__dirname,'../vendor/agentbridge/dist-main/local-tool-host.js'),nativeRequire=createRequire(filename),module={exports:{}};
 const source=fs.readFileSync(filename,'utf8'),before='{ category: "extension", available: () => client.running, tool: { ...original, name,';
 assert.equal(source.split(before).length,2,'same unique extension owner patch as the production build');
 const patched=source.replace(before,'{ category: "extension", extensionId: spec.id, available: () => client.running, tool: { ...original, name,');
 const helper=path.join(resourcesPath,'app.asar','opencodex','native-mcp.cjs');
 vm.runInNewContext(patched+'\n'+fs.readFileSync(path.resolve(__dirname,'../src/workspace-host.cjs'),'utf8'),{
  module,exports:module.exports,require:specifier=>specifier===helper?require('../src/native-mcp.cjs'):nativeRequire(specifier),
  process:{...process,resourcesPath},Buffer,AbortController,setTimeout,clearTimeout,console,URL
 },{filename});
 return module.exports.LocalToolHost;
}
function pinnedRendererFunctions(){
 const archive=require('./asar-reader.cjs').archive(path.resolve(__dirname,'../build/OpenCodex.app/Contents/Resources/app.asar'));
 try{
  const shared=archive.read('webview/assets/app-shared-8340f229c2b3.js').toString(),initial=archive.read('webview/assets/app-initial-1ab6fbe93c4f.js').toString(),widget=archive.read('webview/assets/widget-338e9f889b2d.js').toString();
  const take=(source,start,end)=>{const i=source.indexOf(start),j=source.indexOf(end,i+start.length);assert(i>=0&&j>i,'pinned renderer function anchors');return source.slice(i,j);};
  const functions=vm.runInNewContext([
   take(shared,'function Whn(','function sU('),
   take(shared,'function Mhn(','function Nhn('),
   take(shared,'function Phn(','function aU('),
   take(shared,'function Rhn(','var zhn'),
   take(initial,'async function Yva(','async function Xva('),
   take(initial,'function Gva(','async function Kva('),
   '({catalog:Whn,resolveTool:Mhn,scopeResource:Fhn,read:Yva,query:Gva})'
  ].join('\n'),{nU:e=>e==='codex_apps',Du:e=>e==='codex_apps',ma:()=>false,qva:()=>({}),pTn:async(_scope,_context,identity,read)=>({resource:await read(),identitySnapshot:{identity}})});
  return {functions,widget};
 }finally{archive.close();}
}
const tests=[],test=async(name,fn)=>{await fn();tests.push(name);};
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
(async()=>{
 const uri='ui://sample/view.html?name=測試&v=1',id='opencodex-native:sample';
 await test('MCP Apps metadata variants and embedded resources are namespaced without mutating tool content',async()=>{
  const original={name:'show/view',inputSchema:{type:'object'},_meta:{ui:{resourceUri:uri,visibility:['model','app']},'ui/resourceUri':uri,'openai/outputTemplate':uri,custom:{keep:true}}};
  const copy=structuredClone(original),a=projectTool(id,original),b=projectTool('other',original);
  assert.notEqual(a._meta.ui.resourceUri,b._meta.ui.resourceUri);assert(isProjectedUri(a._meta.ui.resourceUri));
  assert.equal(a._meta.ui.resourceUri,a._meta['ui/resourceUri']);assert.equal(a._meta.ui.resourceUri,a._meta['openai/outputTemplate']);
  assert.deepEqual(a._meta.ui.visibility,['model','app']);assert.deepEqual(original,copy);assert.equal(a.name,original.name);
  assert.match(bridgeToolName(id,'show/view'),/^mac_ext_[a-f0-9]{12}_show_view_[a-f0-9]{8}$/);
  const result=projectResult(id,{_meta:original._meta,content:[{type:'text',text:uri},{type:'resource_link',uri,name:'view'},{type:'resource',resource:{uri,text:'<h1>sample</h1>'}}]});
  assert.equal(result.content[0].text,uri);assert.equal(result.content[1].uri,a._meta.ui.resourceUri);assert.equal(result.content[2].resource.uri,a._meta.ui.resourceUri);
 });
 await test('identical URI on two servers routes only to its owning client after the inference turn',async()=>{
  const calls=[],clients=new Map(['one','two'].map(id=>[id,{running:true,resource:async(method,params)=>{calls.push({id,method,params});return {contents:[{uri:params.uri,mimeType:'text/html;profile=mcp-app',text:id}]};}}]));
  const contexts=[],bridge=new NativeMcpBridge({getClients:()=>clients,authorizeResource:async request=>{contexts.push(request.context);return request.context.authenticated;}});
  const a=await bridge.read(namespaceUri('one',uri),{context:{authenticated:true,threadId:'completed-turn-thread'}});
  const b=await bridge.read(namespaceUri('two',uri),{context:{authenticated:true}});
  assert.deepEqual(calls.map(c=>c.id),['one','two']);assert.equal(calls[0].method,'resources/read');assert.equal(calls[0].params.uri,uri);
  assert.equal(a.contents[0].text,'one');assert.equal(b.contents[0].text,'two');assert.equal(contexts[0].threadId,'completed-turn-thread');
  assert.equal(a.contents[0].uri,namespaceUri('one',uri));assert.equal(bridge.active.size,0);
 });
 await test('authorization, namespace validation, disabled clients and foreign-host URIs fail before invocation',async()=>{
  let invoked=0;const client={running:true,resource:async()=>{invoked++;return {contents:[]};}},clients=new Map([['one',client]]);
  assert.throws(()=>new NativeMcpBridge({getClients:()=>clients}),/authorization/);
  const bridge=new NativeMcpBridge({getClients:()=>clients,authorizeResource:async()=>false});
  await assert.rejects(bridge.read(namespaceUri('one',uri)),/permission denied/);
  await assert.rejects(bridge.read(namespaceUri('foreign-host',uri)),/Unknown/);
  await assert.rejects(bridge.read(namespaceUri('one',uri).replace('ui%3A','ui%3a')),/Invalid/);
  await assert.rejects(bridge.read('ui://sample/unprojected'),/namespace/);
  client.running=false;await assert.rejects(bridge.read(namespaceUri('one',uri)),/unavailable/);assert.equal(invoked,0);
 });
 await test('replacement during authorization or response invalidates the old client and result',async()=>{
  const gate=deferred();let called=0,generation=0;const client={running:true,resource:async()=>{called++;return {contents:[]};}},clients=new Map([['one',client]]);
  const bridge=new NativeMcpBridge({getClients:()=>clients,getGeneration:()=>generation,authorizeResource:async()=>gate.promise});
  const pending=bridge.read(namespaceUri('one',uri));clients.set('one',{...client});gate.resolve(true);await assert.rejects(pending,/owner changed/);assert.equal(called,0);
  const result=deferred();clients.set('one',{running:true,resource:()=>result.promise});bridge.authorizeResource=async()=>true;
  const read=bridge.read(namespaceUri('one',uri));await Promise.resolve();generation++;result.resolve({contents:[{uri,text:'stale'}]});
  await assert.rejects(read,/owner changed/);assert.equal(bridge.active.size,0);
 });
 await test('frontend cancellation and host cancelActive abort pending reads with no late accepted response',async()=>{
  const gate=deferred(),clients=new Map([['one',{running:true,resource:()=>gate.promise}]]),active=new Set();
  const bridge=new NativeMcpBridge({getClients:()=>clients,active,authorizeResource:async()=>true});
  const controller=new AbortController(),pending=bridge.read(namespaceUri('one',uri),{signal:controller.signal});
  controller.abort();await assert.rejects(pending,/cancelled/);assert.equal(active.size,0);
  const pending2=bridge.read(namespaceUri('one',uri));for(const c of active)c.abort();await assert.rejects(pending2,/cancelled/);
  gate.resolve({contents:[{uri,text:'late'}]});assert.equal(active.size,0);
 });
 await test('resource payload limit and malformed results never reach the frontend',async()=>{
  const client={running:true,resource:async()=>({contents:[{uri,text:'x'.repeat(4*1024*1024)}]})},clients=new Map([['one',client]]);
  const bridge=new NativeMcpBridge({getClients:()=>clients,authorizeResource:async()=>true});
  await assert.rejects(bridge.read(namespaceUri('one',uri)),/exceeds/);
  client.resource=async()=>({unexpected:true});await assert.rejects(bridge.read(namespaceUri('one',uri)),/Invalid.*response/);
 });
 await test('app actions require owning resource, actual catalog approval and fresh owner without a model run',async()=>{
  let invoked=0,owner=true,approved=true,received,receivedArgs;
  const name=bridgeToolName('one','show'),tool={name,inputSchema:{type:'object'},annotations:{readOnlyHint:true}};
  const clients=new Map([['one',{running:true,resource:async()=>({contents:[]})}],['two',{running:true,resource:async()=>({contents:[]})}]]);
  const entry={extensionId:'one',category:'extension',tool,available:()=>true,invoke:async args=>{invoked++;receivedArgs=args;return {content:[{type:'text',text:'one'}]};}};
  const entries=new Map([[name,entry]]),active=new Set();
  const bridge=new NativeMcpBridge({getClients:()=>clients,getEntries:()=>entries,active,authorizeResource:()=>owner,authorizeTool:call=>{received=call;call.arguments.value='approval mutation';return approved;}});
  const params={tool:'show',arguments:{value:'original'},_meta:{'opencodex/resourceUri':namespaceUri('one',uri)}};
  assert.equal((await bridge.call(params,{context:{threadId:'completed-thread'}})).content[0].text,'one');
  assert.equal(received.tool,tool);assert.equal(received.name,name);assert.equal(received.category,'extension');assert.equal(received.serverId,'one');
  assert.equal(received.context.threadId,'completed-thread');assert.equal(receivedArgs.value,'original');assert.equal(params.arguments.value,'original');assert.equal(active.size,0);
  await assert.rejects(bridge.call({...params,_meta:{}}),/Invalid|namespace/);
  await assert.rejects(bridge.call({...params,tool:name,_meta:{'opencodex/resourceUri':namespaceUri('two',uri)}}),/another server/);
  owner=false;await assert.rejects(bridge.call(params),/owner permission denied/);owner=true;
  approved=false;await assert.rejects(bridge.call(params),/tool permission denied/);assert.equal(invoked,1);
  clients.set('opencodex-native:test',{running:true,resource:async()=>({contents:[]})});
  await assert.rejects(bridge.call({...params,_meta:{'opencodex/resourceUri':namespaceUri('opencodex-native:test',uri)}}),/explicit native approval context/);
  bridge.authorizeTool=undefined;await assert.rejects(bridge.call(params),/authorization is required/);
 });
 await test('app cancellation, host replacement and ownership revocation reject before invocation or after late completion',async()=>{
  const name=bridgeToolName('one','show'),clients=new Map([['one',{running:true,resource:async()=>({contents:[]})}]]),active=new Set();
  let invoked=0,owner=true,generation=0;
  const entry={extensionId:'one',category:'extension',tool:{name},available:()=>true,invoke:async()=>{invoked++;return {content:[]};}},entries=new Map([[name,entry]]);
  const gate=deferred(),bridge=new NativeMcpBridge({getClients:()=>clients,getEntries:()=>entries,getGeneration:()=>generation,active,authorizeResource:()=>owner,authorizeTool:()=>gate.promise});
  const params={tool:'show',_meta:{'opencodex/resourceUri':namespaceUri('one',uri)}};
  const controller=new AbortController(),pending=bridge.call(params,{signal:controller.signal});controller.abort();
  await assert.rejects(pending,/cancelled/);gate.resolve(true);await new Promise(r=>setImmediate(r));assert.equal(invoked,0);assert.equal(active.size,0);
  const gate2=deferred();bridge.authorizeTool=()=>gate2.promise;
  const pending2=bridge.call(params);await new Promise(r=>setImmediate(r));entries.set(name,{...entry});gate2.resolve(true);
  await assert.rejects(pending2,/owner changed/);assert.equal(invoked,0);entries.set(name,entry);
  const gate3=deferred();bridge.authorizeTool=()=>gate3.promise;
  const pending3=bridge.call(params);await new Promise(r=>setImmediate(r));owner=false;gate3.resolve(true);
  await assert.rejects(pending3,/owner permission denied/);assert.equal(invoked,0);owner=true;
  const completion=deferred();bridge.authorizeTool=()=>true;entry.invoke=async(_args,signal)=>{invoked++;assert.equal(signal.aborted,false);return completion.promise;};
  const pending4=bridge.call(params);await new Promise(r=>setImmediate(r));generation++;completion.resolve({content:[{type:'text',text:'stale'}]});
  await assert.rejects(pending4,/owner changed/);assert.equal(invoked,1);assert.equal(active.size,0);
 });
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-mcp-')),clients=new Map();
 try{
  const fixture=path.join(temp,'fixture.cjs');
  fs.writeFileSync(fixture,`'use strict';
const readline=require('node:readline'),label=process.argv[2],uri='ui://fixture/view.html';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result;
 if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{},resources:{}},serverInfo:{name:label,version:'1'}};
 else if(m.method==='tools/list')result={tools:[{name:'show',inputSchema:{type:'object'},_meta:{ui:{resourceUri:uri}}}]};
 else if(m.method==='tools/call')result={content:[{type:'text',text:label}],_meta:{ui:{resourceUri:uri}}};
 else if(m.method==='resources/read'&&m.params.uri===uri)result={contents:[{uri,mimeType:'text/html;profile=mcp-app',text:'<!doctype html><title>'+label+'</title><h1>'+label+'</h1>'}]};
 else if(m.method==='resources/list')result={resources:[{uri,name:label,mimeType:'text/html;profile=mcp-app'}]};
 else return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unsupported'}})+'\\n');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`,{mode:0o600});
  await test('real Mac stdio MCP roundtrip preserves two app resources with the same URI and cleans owned child processes',async()=>{
   const catalogs=new Map();
   for(const label of ['native-fixture-a','native-fixture-b']){
    const client=new MacExtensionClient({id:label,transport:'stdio',command:{command:process.execPath,args:[fixture,label],cwd:temp},toolTimeoutMs:10000});
    clients.set(label,client);catalogs.set(label,await client.start());
   }
   const bridge=new NativeMcpBridge({getClients:()=>clients,authorizeResource:async({context})=>context?.authenticated===true});
   for(const [label,client]of clients){
    const tool=projectTool(label,catalogs.get(label)[0]);
    const called=projectResult(label,await client.call('show',{}));assert.equal(called._meta.ui.resourceUri,tool._meta.ui.resourceUri);
    const actual=await bridge.read(tool._meta.ui.resourceUri,{context:{authenticated:true}});
    assert.equal(actual.contents[0].mimeType,'text/html;profile=mcp-app');assert(actual.contents[0].text.includes('<h1>'+label+'</h1>'));
    assert.equal(actual.contents[0].uri,tool._meta.ui.resourceUri);
    const other=label.endsWith('-a')?'native-fixture-b':'native-fixture-a';assert(!actual.contents[0].text.includes(other));
   }
   for(const client of clients.values()){await client.stop();assert.equal(client.running,false);}
   await assert.rejects(bridge.read(namespaceUri('native-fixture-a','ui://fixture/view.html'),{context:{authenticated:true}}),/unavailable/);
  });
  await test('production LocalToolHost wrapper projects the real catalog and invocation and authorizes its resource route before and after reading',async()=>{
   const Host=fixtureHostClass(temp),host=new Host({requestTimeoutMs:10000,allowedRoots:[temp]});
   try{
    for(const label of ['native-fixture-a','native-fixture-b'])await host.registerExtension({id:label,name:label,transport:'stdio',command:{command:process.execPath,args:[fixture,label],cwd:temp},toolTimeoutMs:10000});
    assert.equal(host.entries.size,2);assert.equal(host.extensionClients.size,2);
    for(const label of ['native-fixture-a','native-fixture-b']){
     const entry=host.entries.get(bridgeToolName(label,'show'));assert(entry.available());
     const uri=entry.tool._meta.ui.resourceUri;assert.equal(uri,namespaceUri(label,'ui://fixture/view.html'));
     const invoked=await entry.invoke({});assert.equal(invoked._meta.ui.resourceUri,uri);
     await assert.rejects(host.openCodexMcpResourceRead(uri),/authorization/);
     await assert.rejects(host.openCodexMcpResourceRead(uri,{isAuthorized:()=>false}),/permission denied/);
     let checked=0;const actual=await host.openCodexMcpResourceRead(uri,{isAuthorized:()=>{checked++;return true;}});
     assert.equal(checked,2);assert.equal(actual.contents[0].uri,uri);assert(actual.contents[0].text.includes('<h1>'+label+'</h1>'));
     let revoked=0;await assert.rejects(host.openCodexMcpResourceRead(uri,{isAuthorized:()=>++revoked===1}),/permission denied/);
     assert.equal(revoked,2);assert.equal(host.active.size,0);
    }
   }finally{for(const client of host.extensionClients.values())await client.stop();}
  });
  await test('pinned native renderer resolves projected catalog and resource through real host and after-turn app actions stay with their own extension',async()=>{
   const {functions:f,widget}=pinnedRendererFunctions(),Host=fixtureHostClass(temp),host=new Host({requestTimeoutMs:10000,allowedRoots:[temp]}),server='opencodex_mac',threadId='fixture-completed-thread';
   try{
    for(const label of ['native-fixture-a','native-fixture-b'])await host.registerExtension({id:label,name:label,transport:'stdio',command:{command:process.execPath,args:[fixture,label],cwd:temp},toolTimeoutMs:10000});
    const tools=Object.fromEntries([...host.entries].map(([name,entry])=>[name,entry.tool])),mcpServerStatuses={data:[{name:server,tools}]};
    let actions=0;
    for(const label of ['native-fixture-a','native-fixture-b']){
     const name=bridgeToolName(label,'show'),catalog=f.catalog({mcpServerStatuses,server,tool:name}),uri=catalog._meta.ui.resourceUri;
     assert.equal(catalog,host.entries.get(name).tool);assert.equal(f.catalog({mcpServerStatuses,server:'wrong-server',tool:name}),null);
     assert.doesNotThrow(()=>f.scopeResource({mcpAppScope:{originResourceUri:uri},server,uri}));
     const query=f.query({scope:{},identityContext:{server},identity:{kind:'local',server},uri,version:'0.162.0-alpha',enabled:true,originCallId:'completed-tool-call',requestKey:['fallback'],read:async(_context,reusable)=>{
      assert.equal(reusable,true);
      return f.read({sendRequest:async(method,params)=>{
       assert.equal(method,'mcpServer/resource/read');assert.equal(params.server,server);assert.equal(params.threadId,threadId);assert.equal(params.originCallId,undefined);
       return host.openCodexMcpResourceRead(params.uri,{isAuthorized:()=>true});
      }},'unknown',{server,threadId,uri,originCallId:reusable?null:'completed-tool-call'},{});
     }});
     assert.equal(query.enabled,true);const resource=await query.queryFn({});assert.equal(resource.resourceIdentityVerified,true);
     assert(resource.resource.contents[0].text.includes('<h1>'+label+'</h1>'));
     const resolved=f.resolveTool({server,toolName:'show',toolArguments:{},tools:Object.values(tools)});
     assert.equal(resolved.name,'show');
     const params={server,threadId,tool:resolved.name,arguments:{},_meta:{'opencodex/resourceUri':uri}};
     await assert.rejects(host.openCodexMcpToolCall(params,{isAuthorized:()=>true}),/authorization/);
     await assert.rejects(host.openCodexMcpToolCall(params,{isAuthorized:()=>true,authorizeTool:()=>false}),/permission denied/);
     const result=await host.openCodexMcpToolCall(params,{isAuthorized:()=>true,authorizeTool:call=>{
      actions++;assert.equal(call.tool,host.entries.get(name).tool);assert.equal(call.serverId,label);assert.equal(call.name,name);return true;
     }});
     assert.equal(result.content[0].text,label);assert.equal(result._meta.ui.resourceUri,uri);
     const other=label.endsWith('-a')?'native-fixture-b':'native-fixture-a';
     await assert.rejects(host.openCodexMcpToolCall({...params,tool:bridgeToolName(other,'show')},{isAuthorized:()=>true,authorizeTool:()=>true}),/another server/);
    }
    assert.equal(actions,2);assert.equal(host.active.size,0);
    assert(widget.includes('Nt=G(M)&&re(we,`mcpEventStream`)'),'pinned native stream UI is explicitly gated to codex_apps');
    assert(widget.includes('mt=e=>{if(!G(M))return null;'),'generic extension has no trusted connector event-stream scope');
   }finally{for(const client of host.extensionClients.values())await client.stop();}
  });
 }finally{for(const client of clients.values())await client.stop();fs.rmSync(temp,{recursive:true,force:true});}
 const report={version:'0.4.3',at:new Date().toISOString(),passed:true,tests,scope:'Unit regressions, pinned native renderer catalog/query/read functions and actual LocalToolHost with two owned Mac stdio MCP servers: resource routing and authorized after-turn extension app actions. No GUI rendering or remote model claim. Pinned renderer event streams remain codex_apps-only; native tool app actions require a separate native approval context.'};
 fs.mkdirSync(path.join(__dirname,'../evidence'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../evidence/native-mcp-test.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
