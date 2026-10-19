'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
(async()=>{
 const kind=process.argv[2]||'computer';
 const root=path.join(os.homedir(),'Library/Application Support/OpenCodex');
 const {url}=JSON.parse(fs.readFileSync(path.join(root,'test-endpoint.json')));
 const ws=new WebSocket(url),pending=new Map();let seq=0;
 const timeout=setTimeout(()=>{console.error('capture timeout');process.exit(1)},30000);
 ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 await call('initialize',{clientInfo:{name:'opencodex-cua-evidence',version:'0.4.1'}});
 const list=await call('thread/list',{limit:50});
 const marker=kind==='computer'?'請驗收 Codex 原生 Computer Use':'請驗收 Codex 原生瀏覽器';
 const thread=list.data.find(t=>(t.preview||'').includes(marker));
 if(!thread)throw Error('CUA verification conversation not found');
 const full=await call('thread/read',{threadId:thread.id,includeTurns:true});
 const turns=full.thread.turns||[];
 const prefix='mac_ext_'+crypto.createHash('sha256').update('opencodex-native:cua_repl').digest('hex').slice(0,12)+'_';
 const items=turns.flatMap(t=>t.items||[]);
 const calls=items.filter(i=>i.type==='mcpToolCall').map(i=>({tool:i.tool,status:i.status,arguments:i.arguments,result:i.result,error:i.error}));
 // Keep text evidence and omit potentially large screenshot bytes.
 const sanitize=v=>{
  if(typeof v==='string'){
   if(v.startsWith('data:image/')||v.length>4096&&/^[A-Za-z0-9+/=]+$/.test(v))return '[image bytes omitted]';
   if((v.startsWith('{')||v.startsWith('['))&&v.length>4096){try{return JSON.stringify(sanitize(JSON.parse(v)))}catch{}}
   return v;
  }
  if(Array.isArray(v))return v.map(sanitize);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,sanitize(x)]));
  return v;
 };
 const messages=items.filter(i=>i.type==='agentMessage').map(i=>i.text);
 const report={version:'0.4.1',at:new Date().toISOString(),kind,threadId:thread.id,status:turns.at(-1)?.status,calls:sanitize(calls),messages,
 passed:turns.at(-1)?.status==='completed'&&calls.some(c=>c.tool.startsWith(prefix)&&c.status==='completed')&&messages.some(t=>/驗收通過/.test(t))};
 fs.writeFileSync(path.join(__dirname,'../evidence/native-'+kind+'-e2e.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({version:report.version,kind,threadId:thread.id,status:report.status,calls:report.calls.map(c=>({tool:c.tool,status:c.status,arguments:c.arguments,error:c.error})),passed:report.passed}));
 clearTimeout(timeout);ws.close();if(!report.passed)process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exit(1)});
