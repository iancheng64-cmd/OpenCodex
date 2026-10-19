'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),crypto=require('crypto');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const {url}=JSON.parse(fs.readFileSync(path.join(os.homedir(),'Library/Application Support/OpenCodex/test-endpoint.json')));
 const ws=new WebSocket(url),pending=new Map(),events=[];let seq=0,threadId;
 const report={version:'0.4.1',at:new Date().toISOString()};
 const watchdog=setTimeout(()=>{console.error('Native queue test timed out');process.exit(1)},180000);
 ws.onmessage=e=>{
  const m=JSON.parse(e.data),p=pending.get(m.id);
  if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);return;}
  if(m.id!==undefined&&m.method){ws.send(JSON.stringify({id:m.id,error:{code:-32000,message:'QA does not authorize interactive approval'}}));return;}
  if(m.params?.threadId===threadId)events.push(m);
 };
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id='queue-qa:'+ ++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout: '+method))},65000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const wait=async predicate=>{for(let n=0;n<180;n++){const found=predicate();if(found)return found;await pause(500)}throw Error('Native event timeout');};
 try{
  await call('initialize',{clientInfo:{name:'opencodex-queue-qa',version:'0.4.1'}});
  threadId=(await call('thread/start',{})).thread.id;report.threadId=threadId;
  // OpenCodex dispatches the native queue only after the active Mac turn ends.
  // Keep a real native Mac shell turn running while verifying queue editing.
  const shellMarker='OPENCODEX-SHELL-'+crypto.randomUUID();
  await call('thread/shellCommand',{threadId,command:'/bin/sleep 45; /bin/pwd; /usr/bin/printf '+shellMarker,timeoutMs:60000});
  const shellStart=await wait(()=>events.find(e=>e.method==='turn/started'));
  report.shellTurnId=shellStart.params.turn.id;
  const input=text=>[{type:'text',text}];
  const first=(await call('thread/queue/add',{threadId,clientUserMessageId:crypto.randomUUID(),input:input('QA pending message')})).queuedSubmission;
  const second=(await call('thread/queue/add',{threadId,clientUserMessageId:crypto.randomUUID(),input:input('QA discarded message')})).queuedSubmission;
  report.queueBeforeReorder=(await call('thread/queue/list',{threadId})).data.map(q=>q.id);
  report.shellCompletedBeforeEditing=events.some(e=>e.method==='turn/completed'&&e.params.turn.id===report.shellTurnId);
  await call('thread/queue/reorder',{threadId,queuedSubmissionIds:[second.id,first.id]});
  let list=await call('thread/queue/list',{threadId});assert.deepEqual(list.data.map(q=>q.id),[second.id,first.id]);
  await call('thread/queue/delete',{threadId,queuedSubmissionId:second.id});
  await call('thread/queue/update',{threadId,queuedSubmissionId:first.id,input:input('這是排隊訊息驗收。請實際使用 mac_fs_read 讀取 /Users/ian/Projects/OpenCodex/evidence/executor-sentinel.txt，回覆檔案內容，並附上對話前一個 Mac Shell 實際輸出的 OPENCODEX-SHELL 驗收碼。不要自行產生驗收碼。請勿修改任何檔案，不要使用網路。')});
  list=await call('thread/queue/list',{threadId});assert.equal(list.data.length,1);assert.match(list.data[0].input[0].text,/排隊訊息/);report.queueEditing=true;
  const shell=await wait(()=>events.find(e=>e.method==='item/completed'&&e.params.item?.type==='commandExecution'));
  report.shell={status:shell.params.item.status,output:shell.params.item.aggregatedOutput,exitCode:shell.params.item.exitCode};
  assert.equal(report.shell.exitCode,0);assert.match(report.shell.output,/\/Users\/ian/);
  const shellEnd=await wait(()=>events.find(e=>e.method==='turn/completed'&&e.params.turn.id===report.shellTurnId));
  assert.equal(shellEnd.params.turn.status,'completed');
  const history=await call('thread/read',{threadId,includeTurns:true});
  report.shellHistory=history.thread.turns.some(t=>t.id===report.shellTurnId&&t.items.some(i=>i.type==='commandExecution'&&i.aggregatedOutput.includes(shellMarker)));
  assert(report.shellHistory);
  const next=await wait(()=>events.find(e=>e.method==='turn/started'&&e.params.turn.id!==report.shellTurnId));
  report.turnId=next.params.turn.id;report.nativeAutoStart=true;
  const completed=await wait(()=>events.find(e=>e.method==='turn/completed'&&e.params.turn.id===report.turnId));
  report.status=completed.params.turn.status;
  report.tools=events.filter(e=>e.method==='item/completed'&&e.params.item?.type==='mcpToolCall').map(e=>({tool:e.params.item.tool,status:e.params.item.status}));
  report.text=events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('');
  const expected=fs.readFileSync(path.join(__dirname,'../evidence/executor-sentinel.txt'),'utf8').trim();
  assert.equal(report.status,'completed');assert(report.text.includes(expected));assert(report.text.includes(shellMarker));report.shellContextVerified=true;assert(report.tools.some(t=>t.tool==='mac_fs_read'&&t.status==='completed'));
  assert.equal((await call('thread/queue/list',{threadId})).data.length,0);
  report.passed=true;
 }catch(e){report.passed=false;report.error=e.message;process.exitCode=1;}
 finally{clearTimeout(watchdog);ws.close();fs.writeFileSync(path.join(__dirname,'../evidence/native-queue-test.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
})().catch(e=>{console.error(e.stack);process.exit(1)});
