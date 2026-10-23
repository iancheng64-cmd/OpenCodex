'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
(async()=>{
 const root=path.join(os.homedir(),'Library/Application Support/OpenCodex'),{url}=JSON.parse(fs.readFileSync(path.join(root,'test-endpoint.json')));
 const ws=new WebSocket(url),pending=new Map();let seq=0,threadId,turnId;
 const native=process.argv.includes('--native');
 const results={version:'0.4.1',at:new Date().toISOString(),events:[],tools:[],text:''};
 const timer=setTimeout(()=>{console.error('Test timed out');ws.close();process.exitCode=1;},150000);
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id='qa:'+ ++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 let doneResolve;const done=new Promise(r=>doneResolve=r);
 ws.onmessage=e=>{
  const m=JSON.parse(e.data);
  if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);return;}
  if(m.method&&m.id!==undefined){ws.send(JSON.stringify({id:m.id,error:{code:-32000,message:'QA does not authorize interactive approval'}}));return;}
  const p=m.params||{};
  if(p.threadId&&threadId&&p.threadId!==threadId)return;
  if(m.method==='item/agentMessage/delta')results.text+=p.delta||'';
  if(m.method==='item/started'||m.method==='item/completed'){const i=p.item;results.events.push({method:m.method,type:i?.type});if(i?.type==='mcpToolCall')results.tools.push({tool:i.tool,status:i.status});}
  if(m.method==='turn/completed'){results.turn=p.turn;doneResolve();}
 };
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 results.initialized=!!(await call('initialize',{clientInfo:{name:'opencodex-qa',version:'0.4.1'}}));
 const models=await call('model/list');results.models=models.data.map(m=>m.id);
 const resumeId=process.argv.includes('--resume')?Object.keys(JSON.parse(fs.readFileSync(path.join(root,'native-threads.json')))).at(-1):null;
 const thread=await call(resumeId?'thread/resume':'thread/start',resumeId?{threadId:resumeId}:{model:models.data.find(m=>m.isDefault)?.id||models.data[0].id});
 results.resumed=!!resumeId;
 threadId=thread.thread.id;results.threadId=threadId;
 const response=await call('turn/start',{threadId,input:[{type:'text',text:native?'這是 OpenCodex 原生外掛驗收。請從目前工具目錄找到描述為 Codex 原生 · node_repl 的 js 工具，實際呼叫它執行 console.log("OPENCODEX-NATIVE-SSH-"+(6*7))。不要改用 shell 或其他 Node 工具，不要修改檔案或上網；只回覆該工具輸出的驗收碼。':'這是 OpenCodex 整合驗收。請實際使用 Mac 工具讀取 '+require('node:path').resolve(__dirname,'../evidence/executor-sentinel.txt')+'。只回覆檔案裡的驗收碼。請勿修改任何檔案，也不要使用網路。'}],effort:'low'});
 turnId=response.turn.id;results.turnId=turnId;
 await done;clearTimeout(timer);
 const expected=native?'OPENCODEX-NATIVE-SSH-42':fs.readFileSync(path.join(__dirname,'../evidence/executor-sentinel.txt'),'utf8').trim();
 const nativePrefix='mac_ext_'+require('crypto').createHash('sha256').update('opencodex-native:node_repl').digest('hex').slice(0,12)+'_js_';
 results.passed=results.turn?.status==='completed'&&results.text.includes(expected)&&results.tools.some(t=>(native?t.tool.startsWith(nativePrefix):t.tool==='mac_fs_read')&&t.status==='completed');
 fs.writeFileSync(path.join(__dirname,native?'../evidence/native-ssh-test.json':resumeId?'../evidence/resume-tools-test.json':'../evidence/protocol-test.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results));ws.close();if(!results.passed)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exit(1);});
