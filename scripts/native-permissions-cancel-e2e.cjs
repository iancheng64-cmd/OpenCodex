'use strict';
// Interrupt an actual pending tool approval without approving or executing it.
// Then read its history and start another turn under the same custom profile.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {cdp,rpc,wait}=require('./qa-client.cjs');
const root=path.resolve(__dirname,'..'),fixture=JSON.parse(fs.readFileSync(path.join(root,'build/permissions-product-state.json')));
assert(!fixture.restoredAt,'Permission fixture is not active');
const auditPath=path.join(os.homedir(),'Library/Application Support/OpenCodex/adapter-events.jsonl');
const report={at:new Date().toISOString(),version:'0.4.10',scope:'Actual pending approval cancellation, history and next-turn recovery; no tool enforcement assertion',checks:[],asarSHA256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar'))).digest('hex')};
let c,r,active;
const eventsSince=time=>fs.readFileSync(auditPath,'utf8').trim().split('\n').map(JSON.parse).filter(e=>Date.parse(e.at)>=time);
const passed=name=>{report.checks.push(name);console.log(JSON.stringify({phase:name}));};
(async()=>{
 c=await cdp();r=await rpc();
 await wait(async()=>{const state=await c.evaluate('window.openCodexRuntime.status()');return state.connected&&state.toolsReady&&!state.permissionBusy;});
 assert.equal((await c.evaluate('window.openCodexRuntime.status()')).fullAccess,false);
 await r.call('initialize',{clientInfo:{name:'native-permissions-cancel-qa',version:report.version},capabilities:{experimentalApi:true}});
 const created=await r.call('thread/start',{cwd:fixture.cwd,permissions:fixture.audit,persistExtendedHistory:true},180000);
 const id=created.thread.id;report.threadId=id;
 assert.equal(created.activePermissionProfile.id,fixture.audit);assert.equal(created.sandbox.type,'readOnly');
 const inventory=await r.call('mcpServerStatus/list',{threadId:id});
 let tool;
 for(const server of inventory.data||[])for(const [key,value]of Object.entries(server.tools||{})){
  if(/_js_[0-9a-f]+$/.test(value.name||key)&&JSON.stringify(value).includes('node_repl'))tool=value.name||key;
 }
 assert(tool,'Actual native Node tool must be advertised');
 const from=r.events.length,startedAt=Date.now();
 const code="console.log(await(await import('node:fs/promises')).readFile("+JSON.stringify(path.join(fixture.cwd,'readme.txt'))+",'utf8'))";
 const turn=await r.call('turn/start',{threadId:id,effort:'low',input:[{type:'text',text:'這是自有測試。請實際呼叫一次描述「Codex 原生 · node_repl」的 js 工具 '+tool+'，執行以下唯讀程式，不要使用其他工具，也不要要求提升權限：\n'+code}]},180000);
 active={threadId:id,turnId:turn.turn.id};report.cancelledTurnId=turn.turn.id;
 await wait(()=>eventsSince(startedAt).find(e=>e.type==='tool-approval-shown'),90000);
 passed('Actual model tool reaches the native approval dialog under the read-only profile');
 await r.call('turn/interrupt',active,30000);
 const done=await wait(()=>r.events.slice(from).find(e=>e.method==='turn/completed'&&e.params.threadId===id&&e.params.turn.id===turn.turn.id),30000);
 active=null;
 assert.equal(done.params.turn.status,'interrupted');
 assert(!eventsSince(startedAt).some(e=>e.type==='tool-approval-result'&&e.decision==='accept'),'Test must not approve the pending tool');
 const history=await r.call('thread/read',{threadId:id,includeTurns:true});
 // thread/read returns history only; permission snapshots are returned by
 // thread/resume. Do not mistake the absence of those fields for a failure.
 assert.equal(history.thread.cwd,fixture.cwd);
 assert(history.thread.turns.some(t=>t.id===turn.turn.id&&t.status==='interrupted'));
 passed('Interrupted tool history remains readable without requiring a live native owner');
 const resumedAt=r.events.length;
 const resumed=await r.call('turn/start',{threadId:id,effort:'low',input:[{type:'text',text:'取消測試已結束。不要使用任何工具，只回覆 PERMISSION_RECOVERED。'}]},180000);
 active={threadId:id,turnId:resumed.turn.id};
 const completed=await wait(()=>r.events.slice(resumedAt).find(e=>e.method==='turn/completed'&&e.params.threadId===id&&e.params.turn.id===resumed.turn.id),180000);
 active=null;assert.equal(completed.params.turn.status,'completed');
 const final=await r.call('thread/read',{threadId:id,includeTurns:true});
 const items=final.thread.turns.find(t=>t.id===resumed.turn.id).items;
 assert(items.some(i=>i.type==='agentMessage'&&i.text.includes('PERMISSION_RECOVERED')));
 assert(!items.some(i=>i.type==='mcpToolCall'));
 const settings=await r.call('thread/resume',{threadId:id},180000);
 assert.equal(settings.activePermissionProfile.id,fixture.audit);assert.equal(settings.sandbox.type,'readOnly');
 await wait(async()=>{const state=await c.evaluate('window.openCodexRuntime.status()');return state.toolsReady&&!state.permissionBusy&&state.fullAccess===false;},30000);
 passed('Next real model turn recovers the native owner and completes under the same read-only profile');
 report.passed=true;
})().catch(error=>{report.passed=false;report.error=error.stack;process.exitCode=1;}).finally(async()=>{
 if(active&&r)try{await r.call('turn/interrupt',active,10000);}catch{}
 c?.close();r?.close();report.completedAt=new Date().toISOString();
 fs.writeFileSync(path.join(root,'evidence/native-permissions-cancel-e2e.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(report));
 process.exit(process.exitCode||0);
});
