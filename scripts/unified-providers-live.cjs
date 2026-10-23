'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {rpc,wait,cdp}=require('./qa-client.cjs');
(async()=>{
 const asar=path.join(__dirname,'../build/OpenCodex.app/Contents/Resources/app.asar');
 const digest=()=>crypto.createHash('sha256').update(fs.readFileSync(asar)).digest('hex');
 const report={version:'0.4.11',asarSHA256:digest(),at:new Date().toISOString(),passed:false,steps:[],checks:{}};
 const r=await rpc();let threadId,c;
 const answer=id=>r.events.filter(e=>e.method==='item/completed'&&e.params?.threadId===threadId&&e.params?.turnId===id&&e.params.item?.type==='agentMessage').map(e=>e.params.item.text).join('\n');
 const send=async(model,text)=>{const start=Date.now();const turn=(await r.call('turn/start',{threadId,model,input:[{type:'text',text,text_elements:[]}]})).turn;
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
  // Queue a different provider while Grok owns the active turn; Stop must target Grok.
  const active=(await r.call('turn/start',{threadId,model:grok.model,input:[{type:'text',text:'請詳細逐步解釋 500 個不同排序演算法案例。',text_elements:[]}]})).turn;
  await r.call('thread/resume',{threadId,model:gpt.model});
  await r.call('turn/interrupt',{threadId,turnId:active.id});
  const stopped=(await wait(()=>r.events.find(e=>e.method==='turn/completed'&&e.params?.threadId===threadId&&e.params.turn?.id===active.id),20000)).params.turn;
  report.checks.stopOriginalProvider=stopped.status==='interrupted';assert(report.checks.stopOriginalProvider);
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
