'use strict';
// Live acceptance: one native GPT Codex thread continues with Claude and back,
// without changing engines or relaunching. Requires a running --opencodex-test app
// in SSH · GPT Codex mode with the Claude collaborator connected.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const out=path.join(__dirname,'../evidence/native-handoff-live.json');
(async()=>{
 const {url,pid}=JSON.parse(fs.readFileSync(path.join(os.homedir(),'Library/Application Support/OpenCodex/test-endpoint.json')));
 const ws=new WebSocket(url),pending=new Map(),events=[];let seq=0;
 const report={at:new Date().toISOString(),appPid:pid,passed:false,steps:[]};
 ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);
  if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);return;}
  if(m.id!==undefined&&m.method){report.steps.push({unexpectedServerRequest:m.method});ws.send(JSON.stringify({id:m.id,error:{code:-32000,message:'live test does not approve interactive requests'}}));return;}
  events.push(m);};
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 const call=(method,params={},ms=120000)=>new Promise((resolve,reject)=>{const id='handoff-live:'+ ++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('timeout '+method));},ms);pending.set(id,{resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});ws.send(JSON.stringify({id,method,params}));});
 const completed=async(threadId,turnId)=>{for(let i=0;i<600;i++){const e=events.find(e=>e.method==='turn/completed'&&e.params?.threadId===threadId&&e.params.turn?.id===turnId);if(e)return e.params.turn;await new Promise(r=>setTimeout(r,500));}throw Error('turn did not complete');};
 const answer=(threadId,turnId)=>events.filter(e=>e.params?.threadId===threadId&&e.params?.turnId===turnId&&e.method==='item/completed'&&e.params.item?.type==='agentMessage').map(e=>e.params.item.text).join('\n');
 const send=async(threadId,model,text)=>{
  const started=Date.now(),r=await call('turn/start',{threadId,model,input:[{type:'text',text,text_elements:[]}]});
  const turn=await completed(threadId,r.turn.id);const reply=answer(threadId,r.turn.id);
  report.steps.push({model,turnId:r.turn.id,status:turn.status,error:turn.error?.message||null,reply,ms:Date.now()-started});
  if(turn.status!=='completed')throw Error(model+' turn '+turn.status+': '+(turn.error?.message||''));
  return reply;
 };
 try{
  await call('initialize',{clientInfo:{name:'opencodex-handoff-live',version:'1'}});
  const models=(await call('model/list',{})).data;
  const gpt=models.find(m=>m.isDefault&&!m.model.startsWith('opencodex-claude:'))||models.find(m=>!m.model.startsWith('opencodex-claude:'));
  const claude=models.find(m=>m.model.startsWith('opencodex-claude:'));
  report.models={gpt:gpt?.model,claude:claude?.model,claudeCount:models.filter(m=>m.model.startsWith('opencodex-claude:')).length};
  if(!gpt||!claude)throw Error('model list lacks GPT or Claude handoff models');
  const alpha='ALPHA-'+crypto.randomBytes(3).toString('hex').toUpperCase(),beta='BETA-'+crypto.randomBytes(3).toString('hex').toUpperCase();
  const threadId=(await call('thread/start',{model:gpt.model})).thread.id;report.threadId=threadId;
  const r1=await send(threadId,gpt.model,'這是 OpenCodex 模型交接驗收。請記住代碼 '+alpha+'。不要使用任何工具，只回覆 OK。');
  const r2=await send(threadId,claude.model,'不要使用任何工具。上一輪我要你記住的代碼是什麼？另外請記住新代碼 '+beta+'。只回覆兩個代碼，以空格分隔。');
  const r3=await send(threadId,gpt.model,'不要使用任何工具。上一輪（由 Claude 回答）新增的代碼是什麼？只回覆該代碼。');
  report.checks={claudeSawGpt:r2.includes(alpha),gptSawClaude:r3.includes(beta)};
  const read=await call('thread/read',{threadId,includeTurns:true});
  report.history=read.thread.turns.map(t=>({id:t.id,status:t.status,agent:t.items.filter(i=>i.type==='agentMessage').map(i=>i.text).join(' ').slice(0,80)}));
  report.checks.historyOrdered=report.history.length===3&&report.history.map(t=>t.id).join()===report.steps.filter(s=>s.turnId).map(s=>s.turnId).join();
  report.passed=Object.values(report.checks).every(Boolean);
 }catch(e){report.error=e.message;}
 finally{fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,1));ws.close();process.exitCode=report.passed?0:1;}
})();
