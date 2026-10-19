'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const {rpc,wait,cdp}=require('./qa-client.cjs');
(async()=>{
 const fixture=fs.realpathSync(fs.mkdtempSync(path.join(__dirname,'../evidence/queue-qa-')));
 const marker='QUEUE-FILE-'+crypto.randomUUID(),shellMarker='QUEUE-SHELL-'+crypto.randomUUID();
 fs.writeFileSync(path.join(fixture,'marker.txt'),marker);
 const report={version:'0.4.8',at:new Date().toISOString(),fixture,asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../build/OpenCodex.app/Contents/Resources/app.asar'))).digest('hex')};
 const c=await cdp(),r=await rpc();let threadId,active;
 const watchdog=setTimeout(()=>{console.error('Native queue watchdog expired');process.exit(1)},360000);
 try{
  const state=await c.evaluate('window.openCodexRuntime.status()');assert(state.connected&&state.toolsReady);
  await r.call('initialize',{clientInfo:{name:'native-queue-qa',version:report.version}});
  threadId=(await r.call('thread/start',{cwd:fixture,permissions:':workspace'})).thread.id;
  report.threadId=threadId;
  const events=()=>r.events.filter(e=>e.params?.threadId===threadId);
  await r.call('thread/shellCommand',{threadId,command:'/bin/sleep 30; /bin/pwd; /usr/bin/printf '+shellMarker,timeoutMs:60000});
  const start=await wait(()=>events().find(e=>e.method==='turn/started'));
  report.shellTurnId=start.params.turn.id;active={threadId,turnId:report.shellTurnId};
  const input=text=>[{type:'text',text}];
  const first=(await r.call('thread/queue/add',{threadId,clientUserMessageId:crypto.randomUUID(),input:input('Pending queue fixture')})).queuedSubmission;
  const second=(await r.call('thread/queue/add',{threadId,clientUserMessageId:crypto.randomUUID(),input:input('Deleted queue fixture')})).queuedSubmission;
  assert.deepEqual((await r.call('thread/queue/list',{threadId})).data.map(q=>q.id),[first.id,second.id]);
  await r.call('thread/queue/reorder',{threadId,queuedSubmissionIds:[second.id,first.id]});
  assert.deepEqual((await r.call('thread/queue/list',{threadId})).data.map(q=>q.id),[second.id,first.id]);
  await r.call('thread/queue/delete',{threadId,queuedSubmissionId:second.id});
  await r.call('thread/queue/update',{threadId,queuedSubmissionId:first.id,input:input('這是 OpenCodex 排隊訊息驗收。請實際使用 mac_fs_read 讀取 '+path.join(fixture,'marker.txt')+'，回覆檔案內容，並附上前一個 Mac Shell 實際輸出的 QUEUE-SHELL 驗收碼。不要自行產生驗收碼。請勿修改任何檔案，不要使用網路。')});
  const queue=await r.call('thread/queue/list',{threadId});
  assert.equal(queue.data.length,1);assert(queue.data[0].input[0].text.includes('排隊訊息驗收'));
  assert(!events().some(e=>e.method==='turn/completed'&&e.params.turn.id===report.shellTurnId),'Queue edits did not occur while shell was running');
  report.queueEditing=true;
  const shell=await wait(()=>events().find(e=>e.method==='turn/completed'&&e.params.turn.id===report.shellTurnId));
  assert.equal(shell.params.turn.status,'completed');
  const shellItem=events().find(e=>e.method==='item/completed'&&e.params.item?.type==='commandExecution').params.item;
  assert.equal(shellItem.exitCode,0);assert(shellItem.aggregatedOutput.includes(fixture)&&shellItem.aggregatedOutput.includes(shellMarker));
  const next=await wait(()=>events().find(e=>e.method==='turn/started'&&e.params.turn.id!==report.shellTurnId));
  report.turnId=next.params.turn.id;active={threadId,turnId:report.turnId};
  const done=await wait(()=>events().find(e=>e.method==='turn/completed'&&e.params.turn.id===report.turnId),180000);
  assert.equal(done.params.turn.status,'completed');active=null;
  const items=events().filter(e=>e.method==='item/completed'&&e.params.turnId===report.turnId).map(e=>e.params.item);
  report.tools=items.filter(i=>i.type==='mcpToolCall').map(i=>({tool:i.tool,status:i.status}));
  report.text=items.filter(i=>i.type==='agentMessage').map(i=>i.text).join('\n');
  assert(report.tools.some(t=>t.tool==='mac_fs_read'&&t.status==='completed'));
  assert(report.text.includes(marker)&&report.text.includes(shellMarker),'Queued reply did not retain file and previous shell context');
  assert.equal((await r.call('thread/queue/list',{threadId})).data.length,0);
  const history=(await r.call('thread/read',{threadId,includeTurns:true})).thread;
  report.historyVerified=history.turns.some(t=>t.id===report.shellTurnId&&t.items.some(i=>i.type==='commandExecution'&&i.aggregatedOutput.includes(shellMarker)))&&history.turns.some(t=>t.id===report.turnId&&t.items.some(i=>i.type==='agentMessage'&&i.text.includes(marker)&&i.text.includes(shellMarker)));
  assert(report.historyVerified);assert.equal(fs.readFileSync(path.join(fixture,'marker.txt'),'utf8'),marker);
  report.automaticStart=true;report.passed=true;
 }catch(e){report.passed=false;report.error=e.stack;process.exitCode=1;}
 finally{
  if(active)try{await r.call('turn/interrupt',active,10000)}catch{}
  clearTimeout(watchdog);c.close();r.close();report.completedAt=new Date().toISOString();
  fs.writeFileSync(path.join(__dirname,'../evidence/native-queue-e2e-0.4.8.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }
})().catch(e=>{console.error(e.stack);process.exit(1)});
