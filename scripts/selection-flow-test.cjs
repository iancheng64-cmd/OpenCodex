'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {UnifiedHandoff}=require('../src/unified-handoff.cjs'),{NativeQueue}=require('../src/native-queue.cjs'),{grokModels}=require('../src/external-providers.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-selection-'));
let count=0;
const test=async(name,fn)=>{await fn();count++;console.log('PASS '+name);};
const provider={provider:'claude',newThread:null,threads:{},claude:{},selectedModel:()=>null,
 isModel:m=>m?.startsWith('opencodex-claude:'),effortFor:(_m,e)=>e||'medium',save(){},flush:async()=>{}};
const u=new UnifiedHandoff(provider,{root});
(async()=>{try{
 await test('Grok slider orders light through high, independent of ACP enumeration',()=>{
  const models=grokModels({availableModels:[{modelId:'grok',_meta:{reasoningEfforts:['xhigh','high','medium','low'].map(value=>({value}))}}]});
  assert.deepEqual(models[0].supportedReasoningEfforts.map(e=>e.reasoningEffort),['low','medium','high','xhigh']);
 });
 await test('GPT effort survives settings notifications, restart and model changes',()=>{
  u.choose('t','gpt','high');u.codexTurn('t');assert.deepEqual(u.snapshot('t'),{model:'gpt',effort:'high'});
  assert.equal(u.settings({params:{threadId:'t',threadSettings:{model:'old',effort:'low'}}}).params.threadSettings.effort,'high');
  const restored=new UnifiedHandoff(provider,{root});assert.deepEqual(restored.snapshot('t'),u.snapshot('t'));
  u.choose('t','opencodex-claude:sonnet');assert.equal(u.selectedEffort('t'),'medium');
  provider.threads.t={effort:'high'};u.choose('t','opencodex-claude:sonnet',null);assert.equal(u.selectedEffort('t'),'medium');
 });
 await test('native default model and explicit effort reset are captured for queueing',()=>{
  u.started(null,{thread:{id:'native'},model:'gpt-default',reasoningEffort:'high'});
  assert.deepEqual(u.snapshot('native'),{model:'gpt-default',effort:'high'});
  provider.requested=p=>p?.model||null;
  u.strip('thread/settings/update',{threadId:'native',effort:null});
  assert.deepEqual(u.snapshot('native'),{model:'gpt-default',effort:null});
 });
 await test('explicit null resets an external turn to its model default',async()=>{
  let sent;provider.start=async p=>{sent=p;return {turn:{id:'reset'}};};
  u.choose('reset','opencodex-claude:sonnet','high');
  await u.start({threadId:'reset',model:'opencodex-claude:sonnet',effort:null},{});
  assert.equal(sent.effort,'medium');assert.equal(u.activeChoices.get('reset').effort,'medium');
 });
 await test('new-model defaults do not inherit previous model effort',()=>{
  provider.newThread={model:'opencodex-claude:sonnet',effort:'high'};
  u.configWrite('config/value/write',{keyPath:'model',value:'opencodex-claude:opus'});
  assert.equal(provider.newThread.effort,null);
  assert.equal(u.readConfig({config:{model:'gpt',model_reasoning_effort:'high'}}).config.model_reasoning_effort,null);
  u.configWrite('config/value/write',{keyPath:'model_reasoning_effort',value:'low'});
  assert.equal(u.readConfig({config:{model_reasoning_effort:'high'}}).config.model_reasoning_effort,'low');
  u.configWrite('config/value/write',{keyPath:'model_reasoning_effort',value:null});
  assert.equal(u.readConfig({config:{model_reasoning_effort:'high'}}).config.model_reasoning_effort,null);
 });
 await test('steering snapshots the chosen model before stopping and waits for completion',async()=>{
  u.choose('t','gpt','high');u.codexTurn('t');u.choose('t','opencodex-claude:opus','low');
  assert(u.changedForActive('t'));
  let run={turnId:'old'},sent;
  const result=await u.replaceActiveTurn({threadId:'t',expectedTurnId:'old',input:[{type:'text',text:'next'}]},{
   active:()=>run,check(){},
   interrupt:async()=>{u.choose('t','gpt','low');setTimeout(()=>{run=null;},80);},
   start:async p=>{assert.equal(run,null);sent=p;return {turn:{id:'new'}};}
  });
  assert.equal(result.turnId,'new');assert.equal(sent.model,'opencodex-claude:opus');assert.equal(sent.effort,'low');
 });
 await test('stale turns, connection changes and stop timeout never send the new message',async()=>{
  let started=0;
  const options={active:()=>({turnId:'active'}),check(){},interrupt:async()=>{},start:async()=>{started++;}};
  await assert.rejects(u.replaceActiveTurn({threadId:'t',expectedTurnId:'old'},options),/回合已改變/);
  await assert.rejects(u.replaceActiveTurn({threadId:'t',expectedTurnId:'active'},{...options,timeout:0}),/尚未停止/);
  await assert.rejects(u.replaceActiveTurn({threadId:'t',expectedTurnId:'active'},{...options,check(){throw Error('connection changed');}}),/connection changed/);
  let run={turnId:'active'};
  await assert.rejects(u.replaceActiveTurn({threadId:'t',expectedTurnId:'active'},{...options,active:()=>run,interrupt:async()=>{run={turnId:'different'};}}),/回合已改變/);
  assert.equal(started,0);assert.equal(u.redirecting.size,0);
 });
 await test('double steering is rejected while a handoff is pending',async()=>{
  let release,run={turnId:'active'};
  const options={active:()=>run,check(){},interrupt:()=>new Promise(r=>{release=r;}),start:async()=>({turn:{id:'new'}})};
  const first=u.replaceActiveTurn({threadId:'t',expectedTurnId:'active'},options);
  await assert.rejects(u.replaceActiveTurn({threadId:'t',expectedTurnId:'active'},options),/正在切換/);
  run=null;release();await first;
 });
 await test('queue persists the selected model and effort, independently of later selection',async()=>{
  const file=path.join(root,'queue.json');let selected={model:'opencodex-claude:opus',effort:'high'},sent;
  const options={file,context:()=>({profile:'host',connected:true,busy:true,ready:()=>true}),selection:()=>selected,emit(){},start:async(id,input,selection)=>{sent={id,input,selection};}};
  const q=new NativeQueue(options);
  const added=await q.request('thread/queue/add',{threadId:'t',clientUserMessageId:'one',input:[{type:'text',text:'initial'}]},'host');
  selected.effort='low';selected.model='gpt';q.close();
  const restored=new NativeQueue({...options,context:()=>({profile:'host',connected:true,busy:false,ready:()=>true})});
  await restored.request('thread/queue/update',{threadId:'t',queuedSubmissionId:added.queuedSubmission.id,input:[{type:'text',text:'edited'}]},'host');
  await restored.dispatch(restored.entry('host','t'));restored.close();
  assert.deepEqual(sent.selection,{model:'opencodex-claude:opus',effort:'high'});assert.equal(sent.input[0].text,'edited');
  assert.equal(restored.entry('host','t').items.length,0);
 });
 await test('queue keeps uncertain submissions paused and blocks automatic duplicates',async()=>{
  const q=new NativeQueue({file:path.join(root,'failed.json'),context:()=>({profile:'host',connected:true,busy:false,ready:()=>true}),emit(){},start:async()=>{throw Error('transport lost');}});
  await q.request('thread/queue/add',{threadId:'t',clientUserMessageId:'two',input:[{type:'text',text:'work'}]},'host');
  const e=q.entry('host','t');await assert.rejects(q.dispatch(e),/transport lost/);
  assert(e.paused);assert(e.inflight);assert.equal(e.items.length,1);
  await assert.rejects(q.dispatch(e),/可能已送出/);q.close();
 });
 console.log(count+' selection flow tests passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
