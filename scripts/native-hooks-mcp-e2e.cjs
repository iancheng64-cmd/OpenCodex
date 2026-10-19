'use strict';
// Actual native MCP server + native Hooks helper, isolated settings. No model/API calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
if(process.argv[2]==='serve'){
 const log=process.argv[3],rl=require('node:readline').createInterface({input:process.stdin});
 rl.on('line',s=>{
  const m=JSON.parse(s);if(m.id==null)return;
  let result;
  if(m.method==='initialize')result={protocolVersion:'2025-03-26',serverInfo:{name:'hooks-fixture',version:'1'},capabilities:{tools:{}}};
  else if(m.method==='tools/list')result={tools:[{name:'hook',description:'Isolated Hook fixture',inputSchema:{type:'object',additionalProperties:true}}]};
  else if(m.method==='tools/call'){
   fs.appendFileSync(log,JSON.stringify(m.params)+'\n');
   result={content:[{type:'text',text:JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'native-mcp-rewritten'}}})}]};
  }else if(m.method==='resources/list')result={resources:[]};
  else if(m.method==='resources/templates/list')result={resourceTemplates:[]};
  else result={};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
 });
}else{
 const {NativeHooksBinding}=require('../src/native-hooks-relay.cjs');
 const {NativeHooksMcp}=require('../src/native-hooks-mcp.cjs');
 const {NativeTools}=require('../src/native-tools.cjs');
 const {nativeInventory,compareInventory}=require('../src/native-hooks-inventory.cjs');
 const {AppServerRpc}=require('../vendor/agentbridge/dist-main/app-server-rpc.js');
 const root=path.resolve(__dirname,'..'),binary=process.env.OPENCODEX_HOOKS_HELPER||path.join(root,'build/hooks-target/debug/opencodex-hooks-helper');
 const nativeBinary=path.join(root,'build/OpenCodex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-mcp-hooks-')));
 const home=path.join(temp,'home'),codexHome=path.join(home,'.codex'),cwd=path.join(temp,'project'),log=path.join(temp,'calls.jsonl');
 for(const p of [codexHome,cwd])fs.mkdirSync(p,{recursive:true});
 const env={PATH:process.env.PATH,HOME:home,CODEX_HOME:codexHome,TMPDIR:temp,LANG:'en_US.UTF-8',ELECTRON_RUN_AS_NODE:'1'};
 const baseConfig='[features]\nhooks = true\n[mcp_servers.fixture]\ncommand = '+JSON.stringify(process.execPath)+'\nargs = '+JSON.stringify([__filename,'serve',log])+'\n[mcp_servers.fixture.env]\nELECTRON_RUN_AS_NODE = "1"\n';
 const field=name=>'$'+'{'+name+'}';
 fs.writeFileSync(path.join(codexHome,'hooks.json'),JSON.stringify({hooks:{PreToolUse:[{matcher:'fixture',hooks:[{type:'mcp_tool',server:'fixture',tool:'hook',timeout:30,input:{session_id:field('session_id'),turn_id:field('turn_id'),cwd:field('cwd'),tool_input:field('tool_input')}}]}]}}));
 fs.writeFileSync(path.join(codexHome,'config.toml'),baseConfig);
 const threadId=randomUUID(),turnId=randomUUID(),nonce=randomUUID(),notifications=[];
 const owner={threadId,sessionId:threadId,turnId,run:{threadId,turnId,requestId:randomUUID()}};
 const active={owner,authorized:()=>true},record={plan:{cwd}};
 const report={at:new Date().toISOString(),passed:false,fixtureOnly:true,productHooksEnabled:false,checks:[]};
 let seed,binding,mcp,host;
 (async()=>{
  assert(fs.existsSync(nativeBinary),'native binary');
  seed=new NativeHooksBinding({binary,cwd,codexHome,env,threadId,nonce,events:['PreToolUse']});
  let inventory=await seed.ready;assert.equal(inventory.hooks.length,1);assert.equal(inventory.hooks[0].trustStatus,'untrusted');
  await seed.close();
  fs.writeFileSync(path.join(codexHome,'config.toml'),baseConfig+inventory.hooks.map(h=>'\n[hooks.state.'+JSON.stringify(h.key)+']\nenabled = true\ntrusted_hash = '+JSON.stringify(h.currentHash)+'\n').join(''));
  mcp=new NativeHooksMcp({record,runtime:{},binary:nativeBinary,env,AppServerRpc,onRequest:()=>false});
  binding=new NativeHooksBinding({binary,cwd,codexHome,env,threadId,nonce,events:['PreToolUse'],mcpCall:(call,signal)=>mcp.call(call,signal,active),onNotification:m=>notifications.push(m)});
  inventory=await binding.ready;assert.equal(inventory.hooks[0].trustStatus,'trusted');
  host=new NativeTools({binary:nativeBinary,cwd,env,AppServerRpc,config:{'features.hooks':false},onRequest:()=>false});
  await host.ready();
  const [list,config]=await Promise.all([host.rpc.request('hooks/list',{cwds:[cwd]},15000),host.rpc.request('config/read',{cwd,includeLayers:false},15000)]);
  report.inventory={helper:inventory,native:nativeInventory(list,config,cwd)};
  report.inventoryFingerprint=compareInventory(inventory,report.inventory.native);
  report.checks.push('native UI inventory and helper agree on enabled Hook and trust');
  const input={command:'original'},result=await binding.invoke({relayNonce:nonce,event:'PreToolUse',sessionId:threadId,turnId,toolName:'fixture',toolUseId:'fixture-tool',toolInput:input,model:'fixture',permissionMode:'default'},{threadId});
  assert.deepEqual(result.hookSpecificOutput.updatedInput,{command:'native-mcp-rewritten'});
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,1);
  const call=calls[0];report.call=call;
  assert.equal(call.arguments.session_id,threadId);assert.equal(call.arguments.turn_id,turnId);assert.equal(call.arguments.cwd,cwd);assert.deepEqual(call.arguments.tool_input,input);
  // The native engine stamps its isolated local host threadId; turn metadata carries the validated remote owner.
  const meta=call._meta;assert.equal(meta.threadId,mcp.tools.threadId);assert.notEqual(meta.threadId,threadId);assert.equal(meta.sessionId,threadId);
  const turn=typeof meta['x-codex-turn-metadata']==='string'?JSON.parse(meta['x-codex-turn-metadata']):meta['x-codex-turn-metadata'];
  assert.equal(turn.thread_id,threadId);assert.equal(turn.turn_id,turnId);
  report.checks.push('actual MCP Hook rewrites input with verified Mac session and turn');
  assert.equal(notifications.filter(m=>m.method==='hooks/completed').length,1);
  report.checks.push('completion emitted once');
  report.passed=true;
 })().catch(e=>{report.error=e.stack;process.exitCode=1;console.error(e);}).finally(async()=>{
  await binding?.close();await seed?.close();mcp?.close();host?.close();
  report.binarySha256=createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  fs.writeFileSync(path.join(root,'evidence/native-hooks-mcp-e2e.json'),JSON.stringify(report,null,2)+'\n');
  fs.rmSync(temp,{recursive:true,force:true});
  console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error}));
 });
}
