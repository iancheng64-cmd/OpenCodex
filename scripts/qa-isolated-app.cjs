'use strict';
// Shared harness: the built app in an isolated home, SSH to this Mac's own loopback, real pinned
// engines and a mock Responses model whose answers follow the user message:
//   [hold:X]  keep the model request open until release(X)
//   [tool]    call mac_fs_read on the project marker file, then answer TOOL-DONE
//   otherwise answer DONE
// Needs Remote Login and an authorized key: OPENCODEX_E2E_KEY (default ~/.ssh/ian-remote_ed25519).
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),app=path.join(root,'build/OpenCodex.app');
const engine=path.join(app,'Contents/Resources/agentbridge/codex/bin/codex'),key=process.env.OPENCODEX_E2E_KEY||path.join(os.homedir(),'.ssh/ian-remote_ed25519');
const MARKER='OPENCODEX-ISOLATED-MARKER',pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,message,ms=60000){const end=Date.now()+ms;while(Date.now()<end){const value=await test();if(value)return value;await pause(100);}throw Error('Timed out: '+message);}
function send(res,input,item){
 const response={id:'resp_'+crypto.randomUUID(),object:'response',created_at:Math.floor(Date.now()/1000),model:input.model,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
 let seq=0;const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:seq++,...data})+'\n\n');
 emit('response.created',{response:{...response,status:'in_progress',output:[]}});
 emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress'}});
 if(item.type==='function_call')emit('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:item.arguments});
 else if(item.type==='custom_tool_call')emit('response.custom_tool_call_input.done',{item_id:item.id,output_index:0,input:item.input});
 else{
  const part=item.content[0];
  emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:part.text});
  emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:part.text});
  emit('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part});
 }
 emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response});res.end();
}
const final=text=>({id:'msg_'+crypto.randomUUID(),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]});
function macCall(input,name,args){
 const space=input.tools.find(t=>t.type==='namespace'&&/^mcp__opencodex_mac_/.test(t.name));
 if(space?.tools?.some(t=>t.name===name))return {id:'fc_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),type:'function_call',namespace:space.name,name,arguments:JSON.stringify(args),status:'completed'};
 const exec=input.tools.find(t=>t.type==='namespace'&&t.name==='functions')?.tools?.find(t=>t.name==='exec');
 if(!exec)return null;
 const code='const t=ALL_TOOLS.find(t=>t.name.startsWith("mcp__opencodex_mac_")&&t.name.endsWith("__'+name+'")); if(!t)throw Error("NO-MAC-TOOL"); text(await tools[t.name]('+JSON.stringify(args)+'));';
 return {id:'ct_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),type:'custom_tool_call',namespace:'functions',name:'exec',input:code,status:'completed'};
}
function userText(input){
 for(let i=input.input.length-1;i>=0;i--){const item=input.input[i];if(item?.type==='message'&&item.role==='user')return (item.content||[]).map(c=>c.text||c.input_text||'').join('\n');}
 return '';
}
// profiles: [{name, remoteHome}] — each loopback profile gets its own CODEX_HOME, like two hosts.
async function launch({settings={},profiles=[{name:'loopback'}],label='isolated'}={}){
 const home=fs.realpathSync(fs.mkdtempSync(path.join('/tmp','ocx-'+label+'-'))),support=path.join(home,'Library/Application Support/OpenCodex'),project=path.join(home,'project');
 const records=[],held=new Map();
 const model=http.createServer((req,res)=>{
  if(req.method!=='POST'||!req.url.startsWith('/v1/responses')){res.writeHead(404);return res.end();}
  let body='';req.on('data',d=>{body+=d;});req.on('end',()=>{
   try{
    const input=JSON.parse(body),metadata=JSON.parse(req.headers['x-codex-turn-metadata']||'{}');
    input.tools=input.tools||input.input?.filter(i=>i.type==='additional_tools').flatMap(i=>i.tools)||[];
    const last=input.input.at(-1),afterTool=['function_call_output','custom_tool_call_output'].includes(last?.type);
    const text=userText(input),hold=/\[hold:([A-Za-z0-9-]+)\]/.exec(text)?.[1]||null;
    const record={turnId:metadata.turn_id,afterTool,hold,tool:/\[tool\]/.test(text),text:text.slice(0,120),at:Date.now()};records.push(record);
    if(afterTool){record.output=JSON.stringify(last).slice(0,1200);return send(res,input,final('TOOL-DONE'));}
    if(hold){if(held.has(hold))held.get(hold).res.destroy();held.set(hold,{res,input,at:Date.now()});return;}
    if(record.tool){const call=macCall(input,'mac_fs_read',{path:path.join(project,'marker.txt')});record.offered=!!call;return send(res,input,call||final('NO-MAC-TOOLS'));}
    send(res,input,final('DONE'));
   }catch(e){records.push({error:e.stack});res.writeHead(500);res.end();}
  });
 });
 await new Promise((resolve,reject)=>{model.on('error',reject);model.listen(0,'127.0.0.1',resolve);});
 fs.mkdirSync(path.join(support,'codex-official'),{recursive:true});
 fs.writeFileSync(path.join(support,'codex-official/.codex-global-state.json'),JSON.stringify({'electron-persisted-atom-state':{'electron:onboarding-welcome-v2-role-state':{completedConversationalOnboarding:true,conversationalOnboardingSkipped:true,personalizedSuggestionsEnabled:false},'electron:onboarding-projectless-completed':true,'electron:onboarding-primary-runtime-install-ready':true,last_completed_onboarding:Math.floor(Date.now()/1000)}}));
 fs.mkdirSync(support,{recursive:true,mode:0o700});fs.mkdirSync(project);fs.mkdirSync(path.join(home,'.codex'),{recursive:true});
 fs.writeFileSync(path.join(project,'marker.txt'),MARKER);
 const scan=execFileSync('ssh-keyscan',['-t','ed25519','127.0.0.1'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
 const fingerprint=spawnSync('ssh-keygen',['-lf','-'],{input:scan,encoding:'utf8'}).stdout.split(' ')[1];
 fs.writeFileSync(path.join(support,'runtime-known-hosts.json'),JSON.stringify({'127.0.0.1:22':fingerprint}),{mode:0o600});
 const list=[],connections={};
 for(const p of profiles){
  const id=crypto.randomUUID(),remoteHome=path.join(home,'remote-home-'+p.name),wrapper=path.join(home,'remote-codex-'+p.name+'.sh');
  fs.mkdirSync(remoteHome,{recursive:true});
  fs.writeFileSync(wrapper,`#!/bin/bash\nexport CODEX_HOME=${remoteHome}\nexport OPENCODEX_FIXTURE_KEY=fixture-only\nif [ "$1" = "app-server" ] && [ "$2" != "--help" ]; then echo $$ >> ${home}/engines.pid; fi\nexec "${engine}" "$@"\n`,{mode:0o700});
  fs.writeFileSync(path.join(remoteHome,'config.toml'),['model="gpt-6.1-sol"','model_provider="fixture"','[model_providers.fixture]','name="Isolated protocol fixture"','base_url="http://127.0.0.1:'+model.address().port+'/v1"','wire_api="responses"','env_key="OPENCODEX_FIXTURE_KEY"','request_max_retries=0','stream_max_retries=0','stream_idle_timeout_ms=600000'].join('\n')+'\n');
  list.push({id,name:p.name,host:'127.0.0.1',port:22,username:os.userInfo().username,authType:'key',keyPath:key,networkMode:'direct',savePassword:false});
  connections[id]={executable:wrapper};
  p.id=id;p.remoteHome=remoteHome;
 }
 fs.writeFileSync(path.join(support,'profiles.json'),JSON.stringify(list),{mode:0o600});
 fs.writeFileSync(path.join(support,'opencodex.json'),JSON.stringify({mode:'ssh',sshAgent:'codex',profileName:profiles[0].name,profileId:profiles[0].id,cwd:project,permissionMode:'full',approvalsReviewer:'user',fullAccess:true,maxParallelSessions:3,parallelPrewarm:false,...settings,codexConnections:connections}),{mode:0o600});
 const openArgs=['-g','-n','-a',app,'--env','HOME='+home,'--env','CFFIXED_USER_HOME='+home,'--env','OPENCODEX_TEST_NO_PEERS=1','--args','--opencodex-test','--remote-debugging-port=9325','--use-mock-keychain'];
 const spawnApp=()=>execFileSync('/usr/bin/open',openArgs);spawnApp();
 const endpoint=path.join(support,'test-endpoint.json');
 let info=await until(()=>{try{return JSON.parse(fs.readFileSync(endpoint,'utf8'));}catch{return null;}},'test endpoint');
 const events=()=>{try{return fs.readFileSync(path.join(support,'adapter-events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));}catch{return [];}};
 const seen=type=>events().some(event=>event.type===type);
 await until(()=>seen('shell-ready'),'shell ready');
 await until(()=>{const failed=events().find(e=>e.type==='ssh-autoconnect-failed');if(failed)throw Error('SSH loopback did not connect; see adapter-events.jsonl');return seen('ssh-connected');},'loopback SSH',90000);
 const {socket}=require('./qa-client.cjs');let client=await socket(info.url);
 await client.call('initialize',{clientInfo:{name:label,version:'1'}});
 const lastWrite=()=>Math.max(0,...events().filter(e=>['plugin/install','config/batchWrite'].includes(e.method)).map(e=>Date.parse(e.at)));
 const startedAt=Date.now();
 await until(()=>Date.now()-Math.max(lastWrite(),startedAt)>8000,'plugins settled',60000);
 const enginePids=()=>{try{return fs.readFileSync(path.join(home,'engines.pid'),'utf8').split('\n').map(s=>Number(s.trim())).filter(Boolean);}catch{return [];}};
 const release=(marker,text='RELEASED-'+marker)=>{const h=held.get(marker);if(!h)throw Error('nothing held for '+marker);held.delete(marker);send(h.res,h.input,final(text));};
 async function pages(){
  const out=[];
  for(const target of (await (await fetch('http://127.0.0.1:9325/json/list')).json()).filter(t=>t.url.startsWith('app://-/index.html'))){
   const page=await socket(target.webSocketDebuggerUrl);
   const run=async(expression,timeout=30000)=>{const r=await page.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},timeout);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
   out.push({page,run,info:await run('({href:location.href,text:document.body.innerText.length})')});
  }
  out.sort((a,b)=>b.info.text-a.info.text);return out;
 }
 // Relaunch the same isolated home. offline:true points every saved host at a closed port, so the
 // App starts with no SSH connection and must work from its local history cache.
 async function restart({offline=false,mutate=null}={}){
  try{client.close();}catch{}
  const pid=info.pid;try{process.kill(pid,'SIGTERM');}catch{}
  await until(()=>{try{process.kill(pid,0);return false;}catch{return true;}},'app exit',20000).catch(()=>{try{process.kill(pid,'SIGKILL');}catch{}});
  for(const p of enginePids()){try{process.kill(p,'SIGKILL');}catch{}}
  fs.rmSync(path.join(home,'engines.pid'),{force:true});
  if(mutate)await mutate({support,home});
  if(offline){const saved=JSON.parse(fs.readFileSync(path.join(support,'profiles.json'),'utf8'));for(const p of saved)p.port=1;fs.writeFileSync(path.join(support,'profiles.json'),JSON.stringify(saved),{mode:0o600});}
  fs.rmSync(endpoint,{force:true});
  const mark=events().length;
  spawnApp();
  info=await until(()=>{try{return JSON.parse(fs.readFileSync(endpoint,'utf8'));}catch{return null;}},'test endpoint after restart');
  const fresh=()=>events().slice(mark);
  await until(()=>fresh().some(e=>e.type==='shell-ready'),'shell ready after restart');
  if(offline)await until(()=>fresh().some(e=>e.type==='ssh-autoconnect-failed'||(e.type==='ssh-autoconnect-finished'&&e.connected===false)),'offline start',60000);
  else await until(()=>fresh().some(e=>e.type==='ssh-connected'),'ssh after restart',90000);
  client=await socket(info.url);await client.call('initialize',{clientInfo:{name:label,version:'1'}});
  return info;
 }
 async function stop(){
  for(const h of held.values())h.res.destroy();held.clear();
  try{client.close();}catch{}
  try{process.kill(info.pid,'SIGTERM');}catch{}await pause(3000);try{process.kill(info.pid,'SIGKILL');}catch{}
  for(const pid of enginePids()){try{process.kill(pid,'SIGKILL');}catch{}}
  for(const pattern of [path.basename(home),path.join(app,'Contents/Resources/native/bare-modifier-monitor'),engine+' exec-server'])spawnSync('/usr/bin/pkill',['-f',pattern]);
  await pause(1000);spawnSync('/usr/bin/pkill',['-f',path.basename(home)]);
  model.closeAllConnections();await new Promise(r=>model.close(r));
  fs.rmSync(home,{recursive:true,force:true,maxRetries:4,retryDelay:200});
 }
 return {home,support,project,profiles,get client(){return client;},events,seen,records,held,release,enginePids,pages,restart,stop,until,pause,MARKER,text:value=>[{type:'text',text:value,text_elements:[]}],get mainPid(){return info.pid;}};
}
module.exports={launch,until,pause,MARKER};
