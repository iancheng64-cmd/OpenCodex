'use strict';
const fs=require('fs'),path=require('path'),os=require('os');
(async()=>{
 const root=path.join(os.homedir(),'Library/Application Support/OpenCodex');
 const {url}=JSON.parse(fs.readFileSync(path.join(root,'test-endpoint.json')));
 const originalId=JSON.parse(fs.readFileSync(path.join(__dirname,'../evidence/native-ssh-test.json'))).threadId;
 const ws=new WebSocket(url),pending=new Map(),turns=new Map(),tools=[];let seq=0,doneResolve;
 const completed=new Promise(r=>doneResolve=r);
 const timer=setTimeout(()=>{console.error('Review verification timeout');process.exit(1)},150000);
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);return;}
  if(m.method==='item/completed'&&m.params.item.type==='mcpToolCall')tools.push({threadId:m.params.threadId,tool:m.params.item.tool,status:m.params.item.status});
  if(m.method==='turn/completed'){turns.set(m.params.threadId,m.params.turn);doneResolve(m.params);}
 };
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 await call('initialize',{clientInfo:{name:'opencodex-review-qa',version:'0.4.1'}});
 const result=await call('review/start',{threadId:originalId,delivery:'detached',target:{type:'custom',instructions:'這是 Mac 執行器審查驗收。請實際使用 mac_fs_read 讀取 /Users/ian/Projects/OpenCodex/evidence/executor-sentinel.txt，檢查其內容是否為 OPENCODEX-MAC-EXECUTOR-20261013-VERIFIED。內容正確就回報沒有發現問題；不要修改檔案，也不要使用網路。'}});
 if(!turns.has(result.reviewThreadId))await completed;
 const turn=turns.get(result.reviewThreadId);
 const report={version:'0.4.1',at:new Date().toISOString(),originalId,reviewThreadId:result.reviewThreadId,turnId:result.turn.id,status:turn?.status,tools,passed:result.reviewThreadId!==originalId&&turn?.status==='completed'&&tools.some(t=>t.threadId===result.reviewThreadId&&t.tool==='mac_fs_read'&&t.status==='completed')};
 clearTimeout(timer);fs.writeFileSync(path.join(__dirname,'../evidence/review-test.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));ws.close();if(!report.passed)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exit(1)});
