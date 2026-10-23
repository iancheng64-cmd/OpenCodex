'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const {cdp,rpc,wait,pause}=require('./qa-client.cjs');
const root=path.resolve(__dirname,'..'),s=JSON.parse(fs.readFileSync(path.join(root,'build/hooks-product-state.json')));
const report={version:'0.4.10',at:new Date().toISOString(),fixture:s.fixture,checks:[],asarSHA256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar'))).digest('hex')};
const logs=()=>fs.existsSync(path.join(s.fixture,'calls.jsonl'))?fs.readFileSync(path.join(s.fixture,'calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
let c,r,active;
(async()=>{
 c=await cdp();r=await rpc();
 const state=await c.evaluate('window.openCodexRuntime.status()');assert(state.connected&&state.toolsReady);
 await r.call('initialize',{clientInfo:{name:'native-hooks-product-qa',version:report.version}});
 const listed=await r.call('hooks/list',{cwds:[s.cwd]});const hooks=listed.data.find(x=>x.cwd===s.cwd);
 assert.equal(hooks.hooks.length,6);assert(hooks.hooks.every(h=>h.enabled&&h.trustStatus==='trusted'));
 report.checks.push('native hooks/list shows six explicitly trusted Mac handlers');
 const t=(await r.call('thread/start',{cwd:s.cwd,permissions:':workspace'})).thread;report.threadId=t.id;
 async function turn(text){
  const from=r.events.length,n=logs().length;
  const {turn}=await r.call('turn/start',{threadId:t.id,effort:'low',input:[{type:'text',text}]});
  active={threadId:t.id,turnId:turn.id};
  const done=await wait(()=>r.events.slice(from).find(e=>e.method==='turn/completed'&&e.params.threadId===t.id&&e.params.turn.id===turn.id),180000);
  active=null;
  return {id:turn.id,status:done.params.turn.status,events:r.events.slice(from).filter(e=>e.params?.threadId===t.id),calls:logs().slice(n)};
 }
 const blocked=await turn('OPENCODEX_HOOK_QA_BLOCK');
 report.block={id:blocked.id,status:blocked.status,events:blocked.events,calls:blocked.calls};
 assert(blocked.calls.some(p=>p.hook_event_name==='UserPromptSubmit'&&p.prompt==='OPENCODEX_HOOK_QA_BLOCK'&&p.session_id===t.id&&p.turn_id===blocked.id&&p.cwd===s.cwd));
 assert(JSON.stringify(blocked.events).includes('OPENCODEX_HOOK_QA_BLOCKED'),'Hook did not block the prompt');
 assert(!blocked.events.some(e=>e.method==='item/completed'&&['mcpToolCall','commandExecution'].includes(e.params.item?.type)));
 report.checks.push('UserPromptSubmit blocks before model tools with actual thread/turn/Mac cwd');
 console.log(JSON.stringify({phase:'prompt-block-passed',threadId:t.id}));
 const context=await turn('OPENCODEX_HOOK_QA_CONTEXT: reply only with the verification token supplied by the native Hook.');
 const reply=context.events.filter(e=>e.method==='item/completed'&&e.params.item?.type==='agentMessage').map(e=>e.params.item.text).join('\n');
 report.context={id:context.id,status:context.status,reply,calls:context.calls,hookEvents:context.events.filter(e=>e.method.startsWith('hook/'))};
 assert.equal(context.status,'completed');assert(reply.includes(s.token));
 assert(context.calls.some(p=>p.hook_event_name==='Stop'&&p.turn_id===context.id));
 report.checks.push('real SSH GPT receives Hook-only context and Stop executes on this Mac');
 console.log(JSON.stringify({phase:'model-context-passed'}));
 const denied=await turn('OpenCodex Hooks 自有驗收。請先從目前工具目錄尋找描述為「Codex 原生 · node_repl」的 js 工具，使用該工具的 Node fs.writeFileSync 寫入 '+s.denyFile+'，內容為 HOOK_SHOULD_BLOCK。探索工具不算寫入嘗試；必須實際呼叫一次這個 js 工具，程式碼內包含完整檔案路徑。這是已授權的測試檔案。若 Hook 拒絕該呼叫，回報拒絕，不要重試或改用其他工具。');
 report.deny={id:denied.id,status:denied.status,calls:denied.calls,events:denied.events};
 assert(denied.calls.some(p=>p.hook_event_name==='PreToolUse'&&JSON.stringify(p.tool_input).includes('hook-denied-marker.txt')));
 assert(!fs.existsSync(s.denyFile),'Denied tool created the fixture');
 assert(JSON.stringify(denied.events).includes('OPENCODEX_HOOK_QA_DENIED'));
 report.checks.push('PreToolUse denies real model tool execution; target file remains absent');
 console.log(JSON.stringify({phase:'tool-deny-passed'}));
 const from=r.events.length,n=logs().length,pidFile=path.join(s.fixture,'pids.json');
 if(fs.existsSync(pidFile)){
  const previous=JSON.parse(fs.readFileSync(pidFile));
  assert(previous.every(pid=>!alive(pid)),'Previous fixture Hook is still alive');
  fs.unlinkSync(pidFile);
 }
 const slow=await r.call('turn/start',{threadId:t.id,effort:'low',input:[{type:'text',text:'OPENCODEX_HOOK_QA_SLOW'}]});
 active={threadId:t.id,turnId:slow.turn.id};
 const pids=await wait(()=>fs.existsSync(pidFile)&&JSON.parse(fs.readFileSync(pidFile)),30000);assert(pids.every(alive));
 await r.call('turn/interrupt',active,15000);
 await wait(()=>pids.every(pid=>!alive(pid)),15000);
 const done=await wait(()=>r.events.slice(from).find(e=>e.method==='turn/completed'&&e.params.threadId===t.id&&e.params.turn.id===slow.turn.id),15000);
 active=null;assert.equal(done.params.turn.status,'interrupted');
 try {
  await wait(()=>logs().slice(n).some(p=>p.hook_event_name==='Interrupt'),10000);
 } finally {
  report.interrupt={turnId:slow.turn.id,pids,descendantsStopped:true,calls:logs().slice(n),events:r.events.slice(from).filter(e=>e.params?.threadId===t.id)};
 }
 report.checks.push('interrupt joins running command descendants and invokes native Interrupt');
 const recovered=await turn('OPENCODEX_HOOK_QA_CONTEXT: reply only with the native Hook token after cancellation.');
 assert(recovered.events.some(e=>e.method==='item/completed'&&e.params.item?.type==='agentMessage'&&e.params.item.text.includes(s.token)));
 report.checks.push('next turn recovers after cancelling a running Hook');
 report.passed=true;
})().catch(e=>{report.passed=false;report.error=e.stack;process.exitCode=1;}).finally(async()=>{
 if(active&&r)try{await r.call('turn/interrupt',active,10000);}catch{}
 c?.close();r?.close();report.completedAt=new Date().toISOString();
 fs.writeFileSync(path.join(root,'evidence/native-hooks-product-e2e.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({passed:report.passed,error:report.error,checks:report.checks,threadId:report.threadId}));
 process.exit(process.exitCode||0);
});
