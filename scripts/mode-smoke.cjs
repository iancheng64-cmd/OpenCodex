'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),assert=require('assert/strict');
const root=path.join(os.homedir(),'Library/Application Support/OpenCodex');
const results={version:'0.4.1',at:new Date().toISOString(),mockRequests:0};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function evaluate(target,expression){
 const ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.close();reject(Error('CDP timeout'))},8000);
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id!==1)return;clearTimeout(timer);ws.close();if(m.result?.exceptionDetails)reject(Error(m.result.exceptionDetails.exception?.description||m.result.exceptionDetails.text));else resolve(m.result?.result?.value);};
  ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
 });
}
async function controls(){
 for(let n=0;n<70;n++){
  try{
   const pages=await(await fetch('http://127.0.0.1:9325/json/list',{signal:AbortSignal.timeout(1500)})).json();
   const native=pages.find(p=>p.type==='page'&&p.url==='app://-/index.html');
   if(native&&await evaluate(native,'typeof window.openCodexRuntime==="object"&&!!document.getElementById("oc-apply-mode")')){
    await evaluate(native,'window.openCodexRuntime.openConnections().then(()=>true)');return native;
   }
  }catch{}
  await pause(500);
 }
 throw Error('Connection panel unavailable');
}
const applyExpression=input=>'(()=>{const input='+JSON.stringify(input)+';for(const [key,id]of Object.entries({mode:"oc-mode",baseUrl:"oc-baseUrl",model:"oc-model",apiKey:"oc-apiKey"})){if(input[key]!==undefined){const e=document.getElementById(id);e.value=input[key];e.dispatchEvent(new Event("change",{bubbles:true}));}}document.getElementById("oc-apply-mode").click();return true;})()';
async function mode(input){
 const c=await controls();
 // The native persistent CUA helper inherits the test CDP fd; stop only OpenCodex's helper.
 for(const row of require('child_process').execFileSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n')){const m=row.trim().match(/^(\d+)\s+(.+)$/);if(m&&m[2].startsWith(root+'/')&&m[2].endsWith('/Contents/MacOS/SkyComputerUseService')){try{process.kill(Number(m[1]),'SIGTERM')}catch{}}}
 await evaluate(c,applyExpression(input));
 await pause(3500);
 for(let n=0;n<15;n++){
  const next=await controls();
  const s=await evaluate(next,'window.openCodexRuntime.status().then(s=>({mode:s.mode}))');
  if(s.mode===input.mode)return next;
  await pause(500);
 }
 throw Error('Mode change failed: '+input.mode);
}
async function rpc(){
 const {url}=JSON.parse(fs.readFileSync(path.join(root,'test-endpoint.json')));
 const ws=new WebSocket(url);let seq=0;const pending=new Map();let onEvent=()=>{};
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 ws.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else onEvent(m);};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 await call('initialize',{clientInfo:{name:'opencodex-mode-qa',version:'0.4.1'}});
 return {call,ws,setEvent:fn=>onEvent=fn};
}
function mock(req,res){
 if(req.method!=='POST'||!req.url.startsWith('/v1/responses')){res.writeHead(404);res.end();return;}
 let body='';req.on('data',d=>body+=d);req.on('end',()=>{
  results.mockRequests++;const input=JSON.parse(body);results.model=input.model;
  results.authHeader=req.headers.authorization==='Bearer opencodex-local-test-key';
  const id='resp_opencodex_local_mock',item={id:'msg_local_mock',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'OPENCODEX-CUSTOM-API-VERIFIED',annotations:[]}]};
  const response={id,object:'response',created_at:Math.floor(Date.now()/1000),model:input.model,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  let sequence_number=0;
  const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:sequence_number++,...data})+'\n\n');
  emit('response.created',{response:{...response,status:'in_progress',output:[]}});
  emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});
  emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});
  emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:item.content[0].text});
  emit('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});
  emit('response.output_item.done',{output_index:0,item});
  emit('response.completed',{response});res.end();
 });
}
(async()=>{
 const backup=new Map(['api-key.bin','codex-custom/config.toml'].map(n=>{const f=path.join(root,n);return[f,fs.existsSync(f)?fs.readFileSync(f):null]}));
 const server=http.createServer(mock);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  await mode({mode:'official'});
  const off=await rpc();const account=await off.call('account/read',{refreshToken:false});
  results.official={initialized:true,independentAccount:account.account===null};off.ws.close();
  const c=await controls();
  await evaluate(c,applyExpression({mode:'custom',baseUrl:'http://example.com/v1',model:'test',apiKey:'local-test'}));
  await pause(400);
  results.rejectUnsafeUrl=await evaluate(c,'document.getElementById("oc-error").innerText.includes("HTTPS")');
  assert.equal(results.rejectUnsafeUrl,true);
  await mode({mode:'custom',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',model:'opencodex-test-model',apiKey:'opencodex-local-test-key'});
  const api=await rpc();let text='';
  const complete=new Promise(resolve=>api.setEvent(m=>{if(m.method==='item/agentMessage/delta')text+=m.params.delta||'';if(m.method==='turn/completed')resolve(m.params.turn);}));
  const t=await api.call('thread/start',{cwd:os.homedir(),approvalPolicy:'never',sandbox:'read-only'});
  await api.call('turn/start',{threadId:t.thread.id,input:[{type:'text',text:'Local mock transport verification. Reply only with the test marker. Do not call tools.'}]});
  const completed=await Promise.race([complete,pause(45000).then(()=>{throw Error('Custom API turn timed out')})]);
  results.custom={status:completed.status,text,mock:true};api.ws.close();
  assert.equal(completed.status,'completed');assert.equal(text,'OPENCODEX-CUSTOM-API-VERIFIED');assert(results.mockRequests>0);assert(results.authHeader);
 }finally{
  await mode({mode:'ssh'});
  for(const[f,b]of backup){if(b)fs.writeFileSync(f,b,{mode:0o600});else if(fs.existsSync(f))fs.unlinkSync(f);}
  server.close();
  results.restoredSSH=true;fs.writeFileSync(path.join(__dirname,'../evidence/mode-smoke.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
