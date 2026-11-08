'use strict';
// Parallel conversations, end to end: the built app in an isolated home, SSH to this Mac's own
// loopback, real pinned engines with a mock model that can hold a turn open on request.
// Needs Remote Login and an authorized key: OPENCODEX_E2E_KEY (default ~/.ssh/ian-remote_ed25519).
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),app=path.join(root,'build/OpenCodex.app'),realHome=os.homedir();
const engine=path.join(app,'Contents/Resources/agentbridge/codex/bin/codex'),key=process.env.OPENCODEX_E2E_KEY||path.join(realHome,'.ssh/ian-remote_ed25519');
const home=fs.realpathSync(fs.mkdtempSync(path.join('/tmp','ocx-parallel-'))),support=path.join(home,'Library/Application Support/OpenCodex'),project=path.join(home,'project'),remoteHome=path.join(home,'remote-home');
const MARKER='OPENCODEX-PARALLEL-MARKER',pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,message,ms=60000){const end=Date.now()+ms;while(Date.now()<end){const value=await test();if(value)return value;await pause(100);}throw Error('Timed out: '+message);}
const report={at:new Date().toISOString(),version:'0.4.15',isolatedHome:true,externalModel:false,checks:{},errors:[]};
const records=[];
// Held turns are keyed by the marker in the user message; release(marker) lets the model answer.
const held=new Map();
let model,mainPid,client;
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
// The last user message decides: [hold:X] waits for release(X); [tool] reads the marker file.
function userText(input){
 for(let i=input.input.length-1;i>=0;i--){
  const item=input.input[i];
  if(item?.type==='message'&&item.role==='user')return (item.content||[]).map(c=>c.text||c.input_text||'').join('\n');
 }
 return '';
}
function startModel(){
 model=http.createServer((req,res)=>{
  if(req.method!=='POST'||!req.url.startsWith('/v1/responses')){res.writeHead(404);return res.end();}
  let body='';req.on('data',d=>{body+=d;});req.on('end',()=>{
   try{
    const input=JSON.parse(body),metadata=JSON.parse(req.headers['x-codex-turn-metadata']||'{}');
    input.tools=input.tools||input.input?.filter(i=>i.type==='additional_tools').flatMap(i=>i.tools)||[];
    const last=input.input.at(-1),afterTool=['function_call_output','custom_tool_call_output'].includes(last?.type);
    const text=userText(input),hold=/\[hold:([A-Za-z0-9-]+)\]/.exec(text)?.[1]||null;
    const record={turnId:metadata.turn_id,afterTool,hold,tool:/\[tool\]/.test(text),text:text.slice(0,80),at:Date.now()};records.push(record);
    if(afterTool){record.output=JSON.stringify(last).slice(0,1200);return send(res,input,final('TOOL-DONE'));}
    if(hold){if(held.has(hold))held.get(hold).res.destroy();held.set(hold,{res,input,at:Date.now()});return;}
    if(record.tool){const call=macCall(input,'mac_fs_read',{path:path.join(project,'marker.txt')});record.offered=!!call;return send(res,input,call||final('NO-MAC-TOOLS'));}
    send(res,input,final('DONE'));
   }catch(e){report.errors.push(e.stack);res.writeHead(500);res.end();}
  });
 });
 return new Promise((resolve,reject)=>{model.on('error',reject);model.listen(0,'127.0.0.1',resolve);});
}
function release(marker,text='RELEASED-'+marker){const h=held.get(marker);if(!h)throw Error('nothing held for '+marker);held.delete(marker);send(h.res,h.input,final(text));}
const events=()=>{try{return fs.readFileSync(path.join(support,'adapter-events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));}catch{return [];}};
const count=type=>events().filter(event=>event.type===type).length;
const seen=type=>count(type)>0;
const enginePids=()=>{try{return fs.readFileSync(path.join(home,'engines.pid'),'utf8').split('\n').map(s=>Number(s.trim())).filter(Boolean);}catch{return [];}};
const text=value=>[{type:'text',text:value,text_elements:[]}];
function prepare(){
 fs.mkdirSync(path.join(support,'codex-official'),{recursive:true});
 fs.writeFileSync(path.join(support,'codex-official/.codex-global-state.json'),JSON.stringify({'electron-persisted-atom-state':{'electron:onboarding-welcome-v2-role-state':{completedConversationalOnboarding:true,conversationalOnboardingSkipped:true,personalizedSuggestionsEnabled:false},'electron:onboarding-projectless-completed':true,'electron:onboarding-primary-runtime-install-ready':true,last_completed_onboarding:Math.floor(Date.now()/1000)}}));
 fs.mkdirSync(support,{recursive:true,mode:0o700});fs.mkdirSync(project);fs.mkdirSync(remoteHome);
 fs.writeFileSync(path.join(project,'marker.txt'),MARKER);
 fs.mkdirSync(path.join(home,'.codex'),{recursive:true});
 const id=crypto.randomUUID(),wrapper=path.join(home,'remote-codex.sh');
 fs.writeFileSync(wrapper,`#!/bin/bash\nexport CODEX_HOME=${remoteHome}\nexport OPENCODEX_FIXTURE_KEY=fixture-only\nif [ "$1" = "app-server" ] && [ "$2" != "--help" ]; then echo $$ >> ${home}/engines.pid; fi\nexec "${engine}" "$@"\n`,{mode:0o700});
 fs.writeFileSync(path.join(remoteHome,'config.toml'),['model="gpt-6.1-sol"','model_provider="fixture"','[model_providers.fixture]','name="Isolated protocol fixture"','base_url="http://127.0.0.1:'+model.address().port+'/v1"','wire_api="responses"','env_key="OPENCODEX_FIXTURE_KEY"','request_max_retries=0','stream_max_retries=0','stream_idle_timeout_ms=600000'].join('\n')+'\n');
 fs.writeFileSync(path.join(support,'profiles.json'),JSON.stringify([{id,name:'loopback',host:'127.0.0.1',port:22,username:os.userInfo().username,authType:'key',keyPath:key,networkMode:'direct',savePassword:false}]),{mode:0o600});
 fs.writeFileSync(path.join(support,'opencodex.json'),JSON.stringify({mode:'ssh',sshAgent:'codex',profileName:'loopback',profileId:id,cwd:project,permissionMode:'full',approvalsReviewer:'user',fullAccess:true,maxParallelSessions:3,parallelPrewarm:true,codexConnections:{[id]:{executable:wrapper}}}),{mode:0o600});
 const scan=execFileSync('ssh-keyscan',['-t','ed25519','127.0.0.1'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
 const fingerprint=spawnSync('ssh-keygen',['-lf','-'],{input:scan,encoding:'utf8'}).stdout.split(' ')[1];
 fs.writeFileSync(path.join(support,'runtime-known-hosts.json'),JSON.stringify({'127.0.0.1:22':fingerprint}),{mode:0o600});
}
async function main(){
 await startModel();prepare();
 execFileSync('/usr/bin/open',['-g','-n','-a',app,'--env','HOME='+home,'--env','CFFIXED_USER_HOME='+home,'--env','OPENCODEX_TEST_NO_PEERS=1','--args','--opencodex-test','--remote-debugging-port=9325','--use-mock-keychain']);
 const endpoint=path.join(support,'test-endpoint.json');
 const info=await until(()=>{try{return JSON.parse(fs.readFileSync(endpoint,'utf8'));}catch{return null;}},'test endpoint');
 mainPid=info.pid;report.checks.appStarted=true;
 await until(()=>seen('shell-ready'),'shell ready');
 assert.equal(seen('engine-blocked'),false);
 await until(()=>{const failed=events().find(e=>e.type==='ssh-autoconnect-failed');if(failed)throw Error('SSH loopback did not connect; see adapter-events.jsonl');return seen('ssh-connected');},'loopback SSH',90000);
 const {socket}=require('./qa-client.cjs');client=await socket(info.url);
 await client.call('initialize',{clientInfo:{name:'parallel-sessions',version:'1'}});
 const completed=id=>client.events.filter(e=>e.method==='turn/completed'&&e.params?.threadId===id);
 const started=id=>client.events.filter(e=>e.method==='turn/started'&&e.params?.threadId===id);
 const lastWrite=()=>Math.max(0,...events().filter(e=>['plugin/install','config/batchWrite'].includes(e.method)).map(e=>Date.parse(e.at)));
 await until(()=>Date.now()-Math.max(lastWrite(),Date.parse(report.at))>8000,'plugins settled',60000);

 // A spare runtime is opened in the background so the first parallel conversation starts at once.
 await until(()=>seen('session-worker-connected'),'spare runtime',90000);
 assert.equal(enginePids().length,2,'two remote engines: primary and spare');
 report.checks.spareRuntimeOpened=true;

 // A runs on the primary and is held open by the model.
 const A=(await client.call('thread/start',{cwd:project})).thread.id;
 const turnA1=(await client.call('turn/start',{threadId:A,input:text('PARALLEL-A [hold:A]')})).turn.id;
 await until(()=>held.has('A'),'A held');
 // B starts and runs a Mac tool while A is still running; this used to fail with the busy error.
 const B=(await client.call('thread/start',{cwd:project})).thread.id;
 const turnB1=(await client.call('turn/start',{threadId:B,input:text('PARALLEL-B [tool]')})).turn.id;
 await until(()=>completed(B).some(e=>e.params.turn.id===turnB1),'B completes beside A',120000);
 assert.equal(completed(B).at(-1).params.turn.status,'completed');
 assert(records.find(r=>r.afterTool&&r.output?.includes(MARKER)),'B reached the Mac tool: '+JSON.stringify(records.slice(-3)));
 assert(held.has('A'),'A still running');
 assert.equal(completed(A).length,0);
 assert.equal((await client.call('thread/read',{threadId:A,includeTurns:false})).thread.status.type,'active');
 assert.equal(enginePids().length,2,'B used the spare runtime');
 report.checks.turnRunsWhileAnotherConversationRuns=true;

 // Queued message on A dispatches by itself once A's turn ends.
 const queued=await client.call('thread/queue/add',{threadId:A,clientUserMessageId:crypto.randomUUID(),input:text('PARALLEL-A2 [hold:AQ]')});
 assert(queued.queuedSubmission?.id);
 await pause(1500);assert(!held.has('AQ'),'queued message waits for the running turn');
 release('A');
 await until(()=>completed(A).some(e=>e.params.turn.id===turnA1),'A completes');
 await until(()=>held.has('AQ'),'queued message started its own turn',30000);
 assert.equal((await client.call('thread/queue/list',{threadId:A})).data.length,0);
 report.checks.queuedMessageDispatchesWhenItsTurnEnds=true;
 release('AQ');
 await until(()=>completed(A).length===2,'queued turn completes');

 // C takes the spare runtime that B used, so B's next turn must move to a third runtime.
 const C=(await client.call('thread/start',{cwd:project})).thread.id;
 await client.call('turn/start',{threadId:C,input:text('PARALLEL-C [hold:C]')});
 await until(()=>held.has('C'),'C held');
 await client.call('turn/start',{threadId:A,input:text('PARALLEL-A3 [hold:A3]')});
 await until(()=>held.has('A3'),'A3 held');
 // Opening B in the sidebar while its runtime runs C attaches read-only instead of failing.
 const view=await client.call('thread/resume',{threadId:B,excludeTurns:true});
 assert.equal(view.thread.id,B);
 assert(events().some(e=>e.type==='thread-attached'&&e.threadId===B&&e.readOnly===true),'read-only attach');
 report.checks.busyConversationViewAttachesReadOnly=true;
 const turnB2=(await client.call('turn/start',{threadId:B,input:text('PARALLEL-B2 [hold:B]')})).turn.id;
 await until(()=>held.has('B'),'B held on a third runtime',120000);
 assert(events().some(e=>e.type==='session-thread-released'&&e.threadId===B),'B was released from its busy runtime');
 assert.equal(enginePids().length,3,'a third remote engine was opened for B');
 assert.equal(count('session-worker-opened'),2);
 report.checks.conversationMovesOffBusyRuntime=true;

 // Three runtimes busy, limit three: the next conversation is refused with a clear message.
 const D=(await client.call('thread/start',{cwd:project}).catch(e=>e));
 assert(D instanceof Error?/並行對話上限（3）/.test(D.message):false,'limit message: '+(D.message||JSON.stringify(D)));
 report.checks.limitIsEnforcedWithAMessage=true;

 // Stop reaches the turn on a worker; the others keep running.
 await client.call('turn/interrupt',{threadId:B,turnId:turnB2});
 await until(()=>completed(B).some(e=>e.params.turn.id===turnB2),'B interrupted');
 assert.equal(completed(B).at(-1).params.turn.status,'interrupted');
 assert(held.has('C')&&held.has('A3'));
 held.get('B')?.res.destroy();held.delete('B');
 report.checks.stopReachesWorkerTurn=true;
 release('C');release('A3');
 await until(()=>completed(C).length===1&&completed(A).length===3,'all released');
 assert.equal(events().filter(e=>e.type==='rpc-error'&&/工作仍在啟動或執行/.test(e.message)).length,0,'no busy refusals');

 // What the user sees: another conversation opens from the sidebar while one is running.
 await client.call('turn/start',{threadId:A,input:text('PARALLEL-A4 [hold:A4]')});
 await until(()=>held.has('A4'),'A4 held');
 const pages=[];
 for(const target of (await (await fetch('http://127.0.0.1:9325/json/list')).json()).filter(t=>t.url.startsWith('app://-/index.html'))){
  const page=await require('./qa-client.cjs').socket(target.webSocketDebuggerUrl);
  const run=async expression=>(await page.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  pages.push({page,run,info:await run('({href:location.href,text:document.body.innerText.length})')});
 }
 const view2=pages.slice().sort((a,b)=>b.info.text-a.info.text)[0];
 await until(()=>view2.run(`(()=>{const hits=[...document.querySelectorAll('a,button,[role=button],[role=link],li,div,span')].filter(e=>e.innerText?.trim().startsWith('PARALLEL-B'));const row=hits.at(-1);if(!row)return false;row.click();return true;})()`),'sidebar row for B',30000);
 await pause(3000);
 const shown=await view2.run('document.body.innerText');
 report.windowText=shown.slice(-300);
 assert.doesNotMatch(shown,/無法開始此對話|工作仍在啟動或執行|無法恢復聊天/,shown.slice(0,600));
 for(const {page} of pages)page.close();
 release('A4');
 await until(()=>completed(A).length===4,'A4 completes');
 report.checks.windowOpensAnotherConversationWhileOneRuns=true;
 report.passed=true;
}
main().catch(e=>{report.errors.push(e.stack);process.exitCode=1;}).finally(async()=>{
 for(const h of held.values())h.res.destroy();held.clear();
 report.events=events().filter(e=>!['rpc','latency'].includes(e.type)).slice(-60);report.records=records.slice(-30);
 try{client?.close();}catch{}
 if(mainPid){try{process.kill(mainPid,'SIGTERM');}catch{}await pause(3000);try{process.kill(mainPid,'SIGKILL');}catch{}}
 for(const pid of enginePids()){try{process.kill(pid,'SIGKILL');}catch{}}
 for(const pattern of [path.basename(home),path.join(app,'Contents/Resources/native/bare-modifier-monitor'),engine+' exec-server'])spawnSync('/usr/bin/pkill',['-f',pattern]);
 await pause(1000);spawnSync('/usr/bin/pkill',['-f',path.basename(home)]);
 model?.closeAllConnections();if(model)await new Promise(r=>model.close(r));
 fs.mkdirSync(path.join(root,'evidence'),{recursive:true});fs.writeFileSync(path.join(root,'evidence/parallel-sessions-e2e.json'),JSON.stringify(report,null,2)+'\n');
 fs.rmSync(home,{recursive:true,force:true,maxRetries:4,retryDelay:200});
 console.log(JSON.stringify({passed:report.passed,checks:report.checks,errors:report.errors.map(e=>e.slice(0,900))},null,1));
});
