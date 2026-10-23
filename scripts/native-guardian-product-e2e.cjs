'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {cdp,rpc,wait}=require('./qa-client.cjs');
const root=path.resolve(__dirname,'..'),s=JSON.parse(fs.readFileSync(path.join(root,'build/guardian-product-state.json')));
assert(!s.restoredAt,'Guardian fixture is not active');
const report={at:new Date().toISOString(),version:'0.4.10',passed:false,scope:'Actual SSH model and Guardian, Mac tool execution, reviewer persistence and switching',fixture:s.fixture,checks:[],asarSHA256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar'))).digest('hex')};
let c,r,active;
function passed(name){report.checks.push(name);console.log(JSON.stringify({phase:name}));}
(async()=>{
 c=await cdp();r=await rpc();
 await wait(async()=>{const t=await c.evaluate('window.openCodexRuntime.status()');return t.connected&&t.toolsReady&&!t.permissionBusy;});
 const state=await c.evaluate('window.openCodexRuntime.status()');assert.equal(state.fullAccess,false);assert.equal(state.version,report.version);assert.equal(state.guardianAvailable,true);
 assert.equal(await c.evaluate('window.openCodexRuntime.guardianAvailable()'),true);
 await r.call('initialize',{clientInfo:{name:'native-guardian-product-qa',version:report.version},capabilities:{experimentalApi:true}});
 const t=await r.call('thread/start',{cwd:s.cwd,permissions:':workspace',approvalsReviewer:'guardian_subagent',persistExtendedHistory:true},180000);
 const id=t.thread.id;report.threadId=id;assert.equal(t.thread.cwd,s.cwd);assert.equal(t.approvalsReviewer,'auto_review');assert.equal(t.approvalPolicy,'on-request');
 passed('Native Guardian selection reaches the capable SSH engine and acknowledges automatic review');
 const listed=await r.call('mcpServerStatus/list',{threadId:id},90000);let target;
 for(const server of listed.data||[])for(const [key,value]of Object.entries(server.tools||{})){
  const name=value.name||key;if(name==='mac_fs_write')target={server:server.name,tool:name,schema:value.inputSchema};
 }
 assert(target,'Actual mac_fs_write inventory entry missing');report.target=target;
 const marker=path.join(s.cwd,'guardian-'+crypto.randomUUID()+'.txt'),contents='OPENCODEX_GUARDIAN_ACTUAL_SSH_OK';assert(!fs.existsSync(marker));
 const from=r.events.length;
 const started=await r.call('turn/start',{threadId:id,effort:'low',input:[{type:'text',text:'這是 OpenCodex 自有測試工作區的 Guardian 自動審查驗收。我明確授權你使用 '+target.tool+'，以 path='+JSON.stringify(marker)+' 和 text='+JSON.stringify(contents)+' 建立這個全新的文字檔。請先從目前工具目錄搜尋或檢查 functions.exec 的 ALL_TOOLS，找出 '+target.server+' 中的 mac_fs_write；工具可能以伺服器前綴名稱延後載入，必須先探索，不能因為短名稱未直接列出就判定不存在。允許探索工具，但實際寫入只呼叫這個檔案寫入工具一次，不使用 Shell、不要求提高權限，完成後只回覆 GUARDIAN_DONE。'}]},180000);
 active={threadId:id,turnId:started.turn.id};report.turnId=started.turn.id;
 const done=await wait(()=>r.events.slice(from).find(e=>e.method==='turn/completed'&&e.params.threadId===id&&e.params.turn.id===started.turn.id),240000);active=null;
 report.events=r.events.slice(from).filter(e=>e.params?.threadId===id);assert.equal(done.params.turn.status,'completed');
 const history=(await r.call('thread/read',{threadId:id,includeTurns:true})).thread;
 const actual=history.turns.find(x=>x.id===started.turn.id)?.items.filter(i=>i.type==='mcpToolCall'&&i.tool===target.tool)||[];
 report.toolCalls=actual;assert.equal(actual.length,1,'Exactly one requested Mac tool call must execute');assert.equal(actual[0].status,'completed');
 assert.equal(fs.readFileSync(marker,'utf8'),contents);
 const starts=report.events.filter(e=>e.method==='item/autoApprovalReview/started');
 const ends=report.events.filter(e=>e.method==='item/autoApprovalReview/completed');
 report.reviews={starts,ends};assert(starts.length>=1,'Actual Guardian start event missing');assert.equal(starts.length,ends.length);
 for(const start of starts){
  const matches=ends.filter(e=>e.params.reviewId===start.params.reviewId);assert.equal(matches.length,1);
  const end=matches[0];assert.equal(end.params.targetItemId,start.params.targetItemId);assert.equal(end.params.turnId,started.turn.id);
  assert.equal(end.params.review.status,'approved');assert(Number.isFinite(start.params.startedAtMs));assert(Number.isFinite(end.params.completedAtMs));assert(end.params.completedAtMs>=start.params.startedAtMs);
 }
 assert(starts.some(e=>e.params.targetItemId===actual[0].id),'Guardian must assess the actual executed tool');
 passed('Real Guardian approves the explicitly authorized write, emits matching native events, and the Mac file is created');
 const resumed=await r.call('thread/resume',{threadId:id},180000);assert.equal(resumed.approvalsReviewer,'auto_review');assert.equal(resumed.approvalPolicy,'on-request');
 passed('Resuming preserves automatic review');
 const forked=await r.call('thread/fork',{threadId:id},180000);report.forkId=forked.thread.id;assert.equal(forked.approvalsReviewer,'auto_review');
 passed('Forking preserves automatic review');
 await r.call('thread/settings/update',{threadId:id,approvalsReviewer:'user'},180000);
 const manual=await r.call('thread/resume',{threadId:id},180000);assert.equal(manual.approvalsReviewer,'user');
 await r.call('thread/settings/update',{threadId:id,approvalsReviewer:'guardian_subagent'},180000);
 const automatic=await r.call('thread/resume',{threadId:id},180000);assert.equal(automatic.approvalsReviewer,'auto_review');assert.equal(automatic.approvalPolicy,'on-request');
 passed('Switching to manual and back updates the same persistent thread');
 await wait(async()=>{const v=await c.evaluate('window.openCodexRuntime.status()');return !v.permissionBusy&&v.toolsReady;},30000);
 report.passed=true;
})().catch(error=>{report.error=error.stack;process.exitCode=1;}).finally(async()=>{
 if(active&&r)try{await r.call('turn/interrupt',active,10000)}catch{}
 if(r&&!report.events)report.events=r.events;
 c?.close();r?.close();report.completedAt=new Date().toISOString();
 fs.writeFileSync(path.join(root,'evidence/native-guardian-product-e2e.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error}));
 process.exit(process.exitCode||0);
});
