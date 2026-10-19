'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {NativeTools}=require('../src/native-tools.cjs');
const root=path.resolve(__dirname,'..'),res=path.join(root,'build/OpenCodex.app/Contents/Resources');
const {AppServerRpc}=require(path.join(root,'vendor/agentbridge/dist-main/app-server-rpc.js'));
const owner=new NativeTools({binary:path.join(res,'codex-cli/CodexCLI.app/Contents/MacOS/codex'),cwd:root,env:{...process.env,CODEX_HOME:path.join(os.homedir(),'Library/Application Support/OpenCodex/codex-official')},AppServerRpc});
(async()=>{
 const out={version:'0.4.1',at:new Date().toISOString(),tests:[]};
 try{
  const specs=await owner.specs();out.servers=owner.statuses;console.log(JSON.stringify({servers:out.servers}));
  assert(!out.servers.some(s=>s.status==='starting'),'Startup must finish before publishing native tools');
  assert(specs.some(s=>s.id==='opencodex-native:cua_repl'),'Enabled native Computer Use plugin must not be omitted during startup');
  out.tests.push('native plugin startup completes before catalogue is published');
  const native=specs.find(s=>s.id==='opencodex-native:node_repl');assert(native);
  const client=native.createClient();const catalog=await client.start();assert(catalog.some(t=>t.name==='js'));out.tests.push('native plugin tool discovery');
  const result=await client.call('js',{title:'OpenCodex native integration verification',code:"console.log('OPENCODEX-NATIVE-TOOL-'+(6*7))"});
  assert(!result.isError);assert(JSON.stringify(result).includes('OPENCODEX-NATIVE-TOOL-42'));out.tests.push('native Node tool executes on Mac');
  const cua=specs.find(s=>s.id==='opencodex-native:cua_repl');
  if(cua){
   const computer=cua.createClient();await computer.start();
   const result=await computer.call('js',{title:'Read native Computer Use API',code:"console.log('OPENCODEX-CUA-READY')"});
   out.cuaInitializationError=!!result.isError;
   fs.writeFileSync(path.join(root,'evidence/native-cua-api.txt'),(result.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'));
   assert(!result.isError);out.tests.push('native Computer Use plugin initializes');
  }
  const abort=new AbortController();abort.abort();
  await assert.rejects(client.call('js',{title:'Cancelled call',code:"console.log('SHOULD NOT RUN')"},abort.signal),/取消/);out.tests.push('cancelled tool rejected');
  const pendingAbort=new AbortController();
  const pending=client.call('js',{title:'Cancellation verification',code:'await new Promise(r=>setTimeout(r,30000)); console.log("SHOULD NOT COMPLETE")'},pendingAbort.signal);
  setTimeout(()=>pendingAbort.abort(),1200);
  await assert.rejects(pending);out.tests.push('active tool cancellation stops native host');
  const recovered=await client.call('js',{title:'Restart after cancellation',code:"console.log('OPENCODEX-NATIVE-RECOVERED')"});
  assert(!recovered.isError&&JSON.stringify(recovered).includes('OPENCODEX-NATIVE-RECOVERED'));out.tests.push('native host recovers after cancellation');
  out.passed=true;
 }finally{
  owner.close();
 }
 fs.writeFileSync(path.join(root,'evidence/native-tools-test.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out));
})().catch(e=>{console.error(e.stack);process.exitCode=1;owner.close()});
