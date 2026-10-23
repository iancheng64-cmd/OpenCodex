'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {cdp,rpc,wait}=require('./qa-client.cjs');
const {namespaceUri}=require('../src/native-mcp.cjs');
const profilesOnly=process.argv.includes('--profiles-only');
const modelOnly=process.argv.includes('--model-only');
const modelTools=process.argv.includes('--model-tools');
assert([profilesOnly,modelOnly,modelTools].filter(Boolean).length<=1,'Select only one verification scope');
const root=path.resolve(__dirname,'..'),s=JSON.parse(fs.readFileSync(path.join(root,'build/permissions-product-state.json')));
assert(!s.restoredAt,'Permission fixture is not active');
const report={at:new Date().toISOString(),version:'0.4.10',scope:profilesOnly?'SSH profile reload only; no tool enforcement or model validation':modelOnly?'SSH profile reload, real model turn, resume and fork; no tool enforcement validation':modelTools?'SSH profiles and actual model-invoked Node restrictions; widget approval is verified separately':'SSH profiles, actual Node restrictions and real model turn',fixture:s.fixture,checks:[],results:[],asarSHA256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar'))).digest('hex')};
let c,r,active;
function passed(name){report.checks.push(name);console.log(JSON.stringify({phase:name}));}
(async()=>{
 c=await cdp();r=await rpc();
 await wait(async()=>{const t=await c.evaluate('window.openCodexRuntime.status()');return t.connected&&t.toolsReady&&!t.permissionBusy;});
 const state=await c.evaluate('window.openCodexRuntime.status()');assert.equal(state.fullAccess,false);assert.equal(state.version,report.version);
 await r.call('initialize',{clientInfo:{name:'native-permissions-product-qa',version:report.version},capabilities:{experimentalApi:true}});
 const listed=await r.call('permissionProfile/list',{cwd:s.cwd});
 report.profiles=listed;
 const t=await r.call('thread/start',{cwd:s.cwd,permissions:s.audit,persistExtendedHistory:true},180000);
 const id=t.thread.id;report.threadId=id;
 assert.equal(t.activePermissionProfile.id,s.audit);assert.equal(t.thread.cwd,s.cwd);assert.equal(t.sandbox.type,'readOnly');
 passed('App creates SSH thread with the actual Mac read-only custom profile');
 // Capture the actual resource tool while its environment is selected. The
 // native UI retains this descriptor across resume; the remote MCP channel is
 // dormant after resume until turn/start selects the Mac environment again.
 const target=profilesOnly||modelOnly?null:await tools(id);
 async function select(profile,sandbox){
  assert.deepEqual(await r.call('thread/settings/update',{threadId:id,permissions:profile},180000),{});
  const actual=await r.call('thread/resume',{threadId:id},180000);
  assert.equal(actual.thread.id,id);assert.equal(actual.activePermissionProfile.id,profile);assert.equal(actual.sandbox.type,sandbox);
  return actual;
 }
 for(const [profile,sandbox]of [[s.dev,'workspaceWrite'],[s.audit,'readOnly']]){
  const actual=await select(profile,sandbox);assert.deepEqual(actual.thread.turns,[]);
 }
 passed('Empty persistent thread switches read-only to writable and back with the same identity and no added turns');
 if(profilesOnly){report.passed=true;return;}
 async function tools(threadId){
  const listed=await r.call('mcpServerStatus/list',{threadId},90000);
  for(const server of listed.data||[])for(const [key,value]of Object.entries(server.tools||{})){
   const name=value.name||key;
   if(/_js_[0-9a-f]+$/.test(name)&&JSON.stringify(value).includes('node_repl'))return {server:server.name,tool:name,schema:value.inputSchema};
  }
  throw Error('Native node_repl js tool absent from actual inventory');
 }
 async function probe(threadId,write,label){
  const marker=path.join(s.cwd,label+'.txt'),outside=path.join(s.fixture,label+'-outside.txt');
  const code=`{const fs=await import('node:fs/promises');const out={};const check=async(k,fn)=>{try{out[k]={ok:true,value:await fn()}}catch(e){out[k]={ok:false,code:e.code}}};await check('read',()=>fs.readFile(${JSON.stringify(path.join(s.cwd,'readme.txt'))},'utf8'));await check('secret',()=>fs.readFile(${JSON.stringify(path.join(s.cwd,'secret/private.txt'))},'utf8'));await check('write',()=>fs.writeFile(${JSON.stringify(marker)},'PERMISSION_WRITE_OK'));await check('outside',()=>fs.writeFile(${JSON.stringify(outside)},'FORBIDDEN'));await check('symlink',()=>fs.writeFile(${JSON.stringify(path.join(s.cwd,'outside-link',label+'-symlink.txt'))},'FORBIDDEN'));console.log('PERMISSION_PRODUCT_RESULT='+JSON.stringify(out));}`;
  let result;
  if(modelTools){
   console.log(JSON.stringify({phase:'model-tool-probe',label,tool:target.tool}));
   const from=r.events.length;
   const prompt='這是 OpenCodex 自有權限驗收，只操作已建立的測試目錄。請在目前目錄尋找描述「Codex 原生 · node_repl」的 js 工具（'+target.tool+'），實際呼叫一次並完整執行下列程式碼；程式會捕捉預期的沙盒拒絕。請勿使用其他工具代替、勿改寫程式、勿要求提升權限。最後只回覆已完成。程式碼：\n'+code;
   const started=await r.call('turn/start',{threadId,effort:'low',input:[{type:'text',text:prompt}]},180000);
   active={threadId,turnId:started.turn.id};
   const done=await wait(()=>r.events.slice(from).find(e=>e.method==='turn/completed'&&e.params.threadId===threadId&&e.params.turn.id===started.turn.id),180000);
   active=null;assert.equal(done.params.turn.status,'completed');
   const history=(await r.call('thread/read',{threadId,includeTurns:true})).thread;
   const actual=history.turns.find(t=>t.id===started.turn.id)?.items.filter(i=>i.type==='mcpToolCall'&&i.tool===target.tool&&i.status==='completed')||[];
   assert.equal(actual.length,1,'Expected one actual native Node model tool call');
   result=actual[0].result;
   (report.toolTurns||(report.toolTurns=[])).push({label,threadId,turnId:started.turn.id,tool:actual[0].tool,status:actual[0].status});
  }else{
  console.log(JSON.stringify({phase:'awaiting-native-tool-approval',label,tool:target.tool}));
  result=await r.call('mcpServer/tool/call',{threadId,server:target.server,tool:target.tool,arguments:{code,title:'OpenCodex 自訂權限驗收 '+label,timeout_ms:10000},_meta:{'opencodex/resourceUri':namespaceUri('opencodex-native:node_repl','ui://opencodex-permission-qa/view')}},180000);
  }
  report.results.push({label,result});
  const text=(result.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
  const match=/PERMISSION_PRODUCT_RESULT=(\{[^\n]*\})/.exec(text);assert(match,'Actual Node result missing: '+text.slice(0,1000));
  const value=JSON.parse(match[1]);assert.equal(value.read.value,'PERMISSION_READ_OK');assert.equal(value.secret.ok,false);assert.equal(value.write.ok,write);assert.equal(value.outside.ok,false);assert.equal(value.symlink.ok,false);
  assert.equal(fs.existsSync(marker),write);assert(!fs.existsSync(outside));assert(!fs.existsSync(path.join(s.fixture,label+'-symlink.txt')));
  if(write)assert.equal(fs.readFileSync(marker,'utf8'),'PERMISSION_WRITE_OK');
  passed(label+': actual Node read/write, denied directory, outside path and symlink restrictions');
 }
 if(!modelOnly)await probe(id,false,'audit-initial');
 await select(s.dev,'workspaceWrite');
 passed('Native thread settings switch applies selected Mac writable profile');
 if(!modelOnly)await probe(id,true,'dev-switched');
 const from=r.events.length,{turn}=await r.call('turn/start',{threadId:id,effort:'low',input:[{type:'text',text:'這是 OpenCodex 自訂權限驗收，請勿使用工具，只回覆 PERMISSION_MODEL_READY。'}]},180000);
 active={threadId:id,turnId:turn.id};
 const done=await wait(()=>r.events.slice(from).find(e=>e.method==='turn/completed'&&e.params.threadId===id&&e.params.turn.id===turn.id),180000);active=null;
 assert.equal(done.params.turn.status,'completed');
 report.modelEvents=r.events.slice(from).filter(e=>e.params?.threadId===id);
 assert(report.modelEvents.some(e=>e.method==='item/completed'&&e.params.item?.type==='agentMessage'&&e.params.item.text.includes('PERMISSION_MODEL_READY')));
 passed('Real SSH model turn completes under custom permissions');
 if(!modelOnly)await probe(id,true,'dev-post-turn');
 const resumed=await r.call('thread/resume',{threadId:id},180000);assert.equal(resumed.activePermissionProfile.id,s.dev);
 passed('Resuming the thread preserves its actual custom profile');
 const forked=await r.call('thread/fork',{threadId:id},180000);report.forkId=forked.thread.id;assert.equal(forked.activePermissionProfile.id,s.dev);
 passed('Forking the thread preserves its actual custom profile');
 if(!modelOnly)await probe(forked.thread.id,true,'dev-fork');
 await select(s.audit,'readOnly');
 if(!modelOnly)await probe(id,false,'audit-restored');
 await wait(async()=>{const state=await c.evaluate('window.openCodexRuntime.status()');return !state.permissionBusy&&state.toolsReady;},30000);
 passed(modelOnly?'Returning to read-only selects the expected profile and composer returns idle':'Returning to read-only revokes writable state and composer returns idle');
 report.passed=true;
})().catch(e=>{report.passed=false;report.error=e.stack;process.exitCode=1;}).finally(async()=>{
 if(active&&r)try{await r.call('turn/interrupt',active,10000)}catch{}
 c?.close();r?.close();report.completedAt=new Date().toISOString();
 fs.writeFileSync(path.join(root,profilesOnly?'evidence/native-permissions-profile-e2e.json':modelOnly?'evidence/native-permissions-model-e2e.json':modelTools?'evidence/native-permissions-model-tools-e2e.json':'evidence/native-permissions-product-e2e.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error}));
 process.exit(process.exitCode||0);
});
