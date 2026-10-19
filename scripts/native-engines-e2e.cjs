'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {cdp,rpc,wait,pause}=require('./qa-client.cjs');
const root=path.resolve(__dirname,'..'),report={version:'0.4.2',at:new Date().toISOString(),tests:[],passed:false};
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let c,r;
async function attach(engine){
 await wait(async()=>{let candidate;try{candidate=await cdp();const s=await candidate.evaluate('window.openCodexRuntime.status()');if(s.sshAgent===engine&&s.version===report.version&&await candidate.evaluate('!!document.querySelector("#opencodex-engine-codex")')){c=candidate;return true;}}catch{}candidate?.close();return false;},60000);
 r=await rpc();await r.call('initialize',{clientInfo:{name:'opencodex-engine-qa',version:report.version}});
}
const state=()=>c.evaluate('window.openCodexRuntime.status()');
async function entries(engine){
 const buttons=await c.evaluate('[...document.querySelectorAll("#opencodex-engines button")].map(e=>({id:e.id,text:e.textContent,pressed:e.getAttribute("aria-pressed"),visible:e.getBoundingClientRect().height>0}))');
 assert.equal(buttons.length,2);assert(buttons.every(b=>b.visible));assert.equal(buttons.find(b=>b.id==='opencodex-engine-'+engine).pressed,'true');
 assert(buttons.some(b=>b.text==='GPT Codex'));assert(buttons.some(b=>b.text==='Claude Code'));
}
async function connect(peer=false){
 await c.evaluate('window.openCodexRuntime.openConnections()');
 await c.evaluate('document.getElementById('+JSON.stringify(peer?'oc-peer-connect':'oc-connect')+').click()');
 await wait(async()=>!(await state()).connecting,150000);
 const s=await state();assert(s.connected,s.error);if(peer)assert(s.agents.peers.claude.connected,s.error);
 await c.evaluate('document.getElementById("oc-close").click()');return s;
}
async function switchTo(engine){
 assert(!(await state()).permissionBusy);
 await c.evaluate('document.getElementById("opencodex-engine-'+engine+'").click()');
 c.close();r.close();await pause(1500);await attach(engine);await entries(engine);
}
async function screenshot(name){const s=await c.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,'evidence',name+'.png'),Buffer.from(s.data,'base64'));}
(async()=>{
 const watchdog=setTimeout(()=>{console.error('Engine acceptance deadline exceeded');process.exit(1)},540000);
 try{
  report.asarSHA256=sha(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar'));
  await attach('codex');await entries('codex');
  // A resumed acceptance run may start connected; compare offline histories on both sides.
  const initial=await state();assert.equal(initial.permissionBusy,false,'Stop active work before engine acceptance');
  if(initial.connected){
   await c.evaluate('window.openCodexRuntime.openConnections()');
   await c.evaluate('document.getElementById("oc-disconnect").click()');
   await wait(async()=>!(await state()).connected,30000);
   await c.evaluate('document.getElementById("oc-close").click()');
  }
  const before=await state();assert.equal(before.connected,false);assert.equal(before.agentBridgeAppLoaded,false);assert.equal(before.fullAccess,true);
  const historyBefore=(await r.call('thread/list',{limit:100})).data.map(t=>t.id).sort();assert(historyBefore.length>0);
  report.codexHistoryCount=historyBefore.length;report.tests.push('both engine entries visible; existing Codex histories available offline');
  await connect();const models=(await r.call('model/list')).data.map(m=>m.id);assert(models.some(m=>/gpt/i.test(m)));
  report.codexModels=models;await screenshot('engines-codex-0.4.2');const codexState=await state();
  await switchTo('claude');assert.equal((await state()).fullAccess,true);
  const claudeHistory=(await r.call('thread/list',{limit:100})).data.map(t=>t.id).sort();assert(!claudeHistory.some(id=>historyBefore.includes(id)));
  const cs=await connect();report.claudeAuthentication=cs.authentication.status;
  const cm=(await r.call('model/list')).data.map(m=>m.id);assert(!cm.some(m=>/gpt/i.test(m)));report.claudeModels=cm;
  if(cs.authentication.status!=='authenticated')assert.equal(await c.evaluate('window.openCodexRuntime.canSubmit()'),false);
  await screenshot('engines-claude-0.4.2');
  report.tests.push('Claude workspace connects, isolates history and model list, and accurately gates missing login');
  await switchTo('codex');const returned=await state();
  assert.equal(returned.mode,codexState.mode);assert.equal(returned.profileId,codexState.profileId);assert.equal(returned.cwd,codexState.cwd);assert.equal(returned.fullAccess,true);
  assert.deepEqual((await r.call('thread/list',{limit:100})).data.map(t=>t.id).sort(),historyBefore);
  await connect();assert.deepEqual((await r.call('model/list')).data.map(m=>m.id),models);
  report.tests.push('return to Codex restores host, directory, full access, existing histories and GPT models');
  await connect(true);const dual=await state();assert(dual.agents.peers.codex.connected&&dual.agents.peers.claude.connected);report.dualConnected=true;report.dualReady=dual.agents.ready;
  report.tests.push('Codex and Claude SSH runtimes connected simultaneously');
  const thread=(await r.call('thread/start',{cwd:codexState.cwd,model:models.find(m=>/gpt/i.test(m)),permissions:':workspace'})).thread;
  const offset=r.events.length,marker='OPENCODEX-ENGINES-'+crypto.randomUUID();
  const started=await r.call('turn/start',{threadId:thread.id,effort:'low',input:[{type:'text',text:'OpenCodex 模式並存驗收。請使用描述為「Codex 原生 · node_repl」的 js 工具，實際執行 console.log('+JSON.stringify(marker)+')。只回覆工具輸出的驗收碼，不要修改檔案或使用網路。'}]});
  await wait(async()=>(await state()).permissionBusy,10000);
  assert(await c.evaluate('[...document.querySelectorAll("#opencodex-engines button")].every(e=>e.disabled)'));
  const done=await wait(()=>r.events.slice(offset).find(e=>e.method==='turn/completed'&&e.params.threadId===thread.id&&e.params.turn.id===started.turn.id),180000);
  assert.equal(done.params.turn.status,'completed');
  const events=r.events.slice(offset),text=events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('');
  assert(text.includes(marker));
  const prefix='mac_ext_'+crypto.createHash('sha256').update('opencodex-native:node_repl').digest('hex').slice(0,12)+'_js_';
  const calls=events.filter(e=>e.method==='item/completed'&&e.params.item?.type==='mcpToolCall').map(e=>e.params.item);
  assert(calls.some(t=>t.tool.startsWith(prefix)&&t.status==='completed'));
  await wait(async()=>!(await state()).permissionBusy);
  assert(await c.evaluate('[...document.querySelectorAll("#opencodex-engines button")].every(e=>!e.disabled)'));
  report.liveCodexTool={threadId:thread.id,completed:true,tools:calls.map(t=>({tool:t.tool,status:t.status}))};
  report.tests.push('real GPT turn calls the Mac native Node tool after roundtrip; engine switching disabled while work is active');
  await screenshot('engines-restored-0.4.2');
  report.passed=true;
 }catch(e){report.error=e.stack;process.exitCode=1;}
 finally{clearTimeout(watchdog);c?.close();r?.close();fs.writeFileSync(path.join(root,'evidence/native-engines-e2e.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
