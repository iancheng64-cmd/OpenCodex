'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {rpc,wait,cdp}=require('./qa-client.cjs');
(async()=>{
 const asar=path.join(__dirname,'../build/OpenCodex.app/Contents/Resources/app.asar');
 const digest=()=>crypto.createHash('sha256').update(fs.readFileSync(asar)).digest('hex');
 const report={version:'0.4.12',asarSHA256:digest(),at:new Date().toISOString(),passed:false,steps:[],checks:{}};
 const r=await rpc();let threadId,c;
 const answer=id=>r.events.filter(e=>e.method==='item/completed'&&e.params?.threadId===threadId&&e.params?.turnId===id&&e.params.item?.type==='agentMessage').map(e=>e.params.item.text).join('\n');
 const send=async(model,text)=>{const start=Date.now();const turn=(await r.call('turn/start',{threadId,model,effort:'low',input:[{type:'text',text,text_elements:[]}]})).turn;
  const done=(await wait(()=>r.events.find(e=>e.method==='turn/completed'&&e.params?.threadId===threadId&&e.params.turn?.id===turn.id),240000)).params.turn;
  const reply=answer(turn.id);report.steps.push({model,id:turn.id,status:done.status,error:done.error,reply,ms:Date.now()-start});
  assert.equal(done.status,'completed',JSON.stringify(done.error));return reply;
 };
 const fixture=path.join(__dirname,'../.opencodex-qa-unified-'+crypto.randomBytes(4).toString('hex'));
 try{
  await r.call('initialize',{clientInfo:{name:'unified-providers-live',version:'1'}});
  const models=(await r.call('model/list')).data;
  const gpt=models.find(m=>m.model==='gpt-6.1-sol')||models.find(m=>!m.model.startsWith('opencodex-'));
  const grok=models.find(m=>m.model==='opencodex-grok:grok-4.7-build-fast')||models.find(m=>m.model.startsWith('opencodex-grok:'));
  assert(gpt&&grok);report.models={gpt:gpt.model,grok:grok.model};
  threadId=(await r.call('thread/start',{model:gpt.model,cwd:path.join(__dirname,'..')})).thread.id;
  report.threadId=threadId;
  const alpha='ALPHA-'+crypto.randomBytes(4).toString('hex'),beta='BETA-'+crypto.randomBytes(4).toString('hex'),secret='FILE-'+crypto.randomBytes(8).toString('hex');
  await send(gpt.model,'請記住 '+alpha+'，不要使用工具，只回覆 OK。');
  const second=await send(grok.model,'上一輪我要你記住什麼代碼？另外記住 '+beta+'。不要使用工具，只回覆兩個代碼。');
  report.checks.grokSawGpt=second.includes(alpha);assert(report.checks.grokSawGpt);
  const third=await send(gpt.model,'上一輪由 Grok 新增的 BETA 代碼是什麼？不要使用工具，只回覆該代碼。');
  report.checks.gptSawGrok=third.includes(beta);assert(report.checks.gptSawGrok);
  const history=(await r.call('thread/read',{threadId,includeTurns:true})).thread.turns;
  report.checks.historyOrdered=history.length===3&&history.map(t=>t.id).join()===report.steps.map(s=>s.id).join();assert(report.checks.historyOrdered);
  fs.writeFileSync(fixture,secret,{mode:0o600});
  const fourth=await send(grok.model,'使用 agentbridge_mac MCP 讀取使用者 Mac 這個檔案：'+fixture+'。只回覆檔案中的代碼。必須實際使用工具。');
  report.checks.grokMacTool=fourth.includes(secret);assert(report.checks.grokMacTool);
  // Save the queue's selection, then change the composer again before dispatch.
  const queuedMarker='QUEUED-'+crypto.randomBytes(4).toString('hex'),eventOffset=r.events.length;
  const preceding=(await r.call('turn/start',{threadId,model:grok.model,effort:'low',input:[{type:'text',text:'只列出編號 1 到 200，每個編號附上一句至少十個字的自然科學事實，不要用工具。',text_elements:[]}]})).turn;
  // Native model-picker persistence must remain available during an active turn.
  await r.call('config/batchWrite',{edits:[{keyPath:'model',value:gpt.model,mergeStrategy:'replace'},{keyPath:'model_reasoning_effort',value:'high',mergeStrategy:'replace'}]});
  let selected=(await r.call('config/read')).config;assert.equal(selected.model,gpt.model);assert.equal(selected.model_reasoning_effort,'high');
  await r.call('config/batchWrite',{edits:[{keyPath:'model',value:grok.model,mergeStrategy:'replace'},{keyPath:'model_reasoning_effort',value:'low',mergeStrategy:'replace'}]});
  selected=(await r.call('config/read')).config;assert.equal(selected.model,grok.model);assert.equal(selected.model_reasoning_effort,'low');
  report.checks.nativeSelectionWhileBusyPersists=true;
  await r.call('thread/resume',{threadId,model:grok.model,effort:'high'});
  await r.call('thread/queue/add',{threadId,clientUserMessageId:crypto.randomUUID(),input:[{type:'text',text:'忽略先前長篇要求。不要用工具，只回覆 '+queuedMarker,text_elements:[]}]});
  await r.call('thread/resume',{threadId,model:gpt.model,effort:'low'});
  const queuedTurn=(await wait(()=>r.events.slice(eventOffset).find(e=>e.method==='turn/started'&&e.params?.threadId===threadId&&e.params.turn?.id!==preceding.id),240000)).params.turn;
  const queuedDone=(await wait(()=>r.events.find(e=>e.method==='turn/completed'&&e.params?.threadId===threadId&&e.params.turn?.id===queuedTurn.id),180000)).params.turn;
  assert.equal(queuedDone.status,'completed');assert(answer(queuedTurn.id).includes(queuedMarker));
  const stored=JSON.parse(fs.readFileSync(path.join(require('os').homedir(),'Library/Application Support/OpenCodex/unified-model-selection.json')));
  assert.equal(stored.choices[threadId].model,grok.model);assert.equal(stored.choices[threadId].effort,'high');
  assert.equal((await r.call('thread/queue/list',{threadId})).data.length,0);
  report.checks.queuedModelAndEffortPreserved=true;
  // Queue a different provider while Grok owns the active turn; Stop must target Grok.
  const active=(await r.call('turn/start',{threadId,model:grok.model,input:[{type:'text',text:'請詳細逐步解釋 500 個不同排序演算法案例。',text_elements:[]}]})).turn;
  await r.call('thread/resume',{threadId,model:gpt.model});
  await r.call('turn/interrupt',{threadId,turnId:active.id});
  const stopped=(await wait(()=>r.events.find(e=>e.method==='turn/completed'&&e.params?.threadId===threadId&&e.params.turn?.id===active.id),20000)).params.turn;
  report.checks.stopOriginalProvider=stopped.status==='interrupted';assert(report.checks.stopOriginalProvider);
  // The native steer action must stop the old provider and use the newly selected one.
  const steering=(await r.call('turn/start',{threadId,model:grok.model,effort:'low',input:[{type:'text',text:'請列出 500 個排序演算法案例並逐項詳細解釋。',text_elements:[]}]})).turn;
  await r.call('thread/resume',{threadId,model:gpt.model,effort:'low'});
  const steerMarker='STEER-'+crypto.randomBytes(4).toString('hex');
  const redirected=await r.call('turn/steer',{threadId,expectedTurnId:steering.id,input:[{type:'text',text:'停止上一個要求。不要用工具，只回覆 '+steerMarker,text_elements:[]}]});
  const steered=(await wait(()=>r.events.find(e=>e.method==='turn/completed'&&e.params?.threadId===threadId&&e.params.turn?.id===redirected.turnId),180000)).params.turn;
  assert.equal(steered.status,'completed');assert(answer(redirected.turnId).includes(steerMarker));
  assert(r.events.some(e=>e.method==='turn/completed'&&e.params?.turn?.id===steering.id&&e.params.turn.status==='interrupted'));
  report.checks.activeSteerUsesSelectedProvider=true;
  c=await cdp();const state=await c.evaluate('window.openCodexRuntime.status()');
  report.accounts=(state.quotas||[]).map(q=>({id:q.id,status:q.status,hasUsage:!!(q.quota?.buckets?.length||q.quota?.raw)}));
  assert.equal(digest(),report.asarSHA256,'Bundle changed during acceptance');
  report.passed=true;
 }catch(e){report.error=e.stack;}
 finally{
  try{if(threadId){const t=(await r.call('thread/read',{threadId,includeTurns:true},10000)).thread.turns.at(-1);if(t?.status==='inProgress')await r.call('turn/interrupt',{threadId,turnId:t.id},10000);await r.call('thread/archive',{threadId},10000);}}catch{}
  fs.rmSync(fixture,{force:true});c?.close();r.close();
  fs.writeFileSync(path.join(__dirname,'../evidence/unified-providers-live.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,1));process.exitCode=report.passed?0:1;
 }
})();
