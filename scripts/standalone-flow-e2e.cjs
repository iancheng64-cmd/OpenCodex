'use strict';
// Drives the built app end to end in an isolated home: SSH to this Mac's own loopback, a real
// remote engine with a mock model, then a real connection drop. No real account, data or quota.
// Needs Remote Login and an authorized key: OPENCODEX_E2E_KEY (default ~/.ssh/ian-remote_ed25519).
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),app=path.join(root,'build/OpenCodex.app'),realHome=os.homedir();
const engine=path.join(app,'Contents/Resources/agentbridge/codex/bin/codex'),key=process.env.OPENCODEX_E2E_KEY||path.join(realHome,'.ssh/ian-remote_ed25519');
const home=fs.realpathSync(fs.mkdtempSync(path.join('/tmp','ocx-flow-'))),support=path.join(home,'Library/Application Support/OpenCodex'),project=path.join(home,'project'),remoteHome=path.join(home,'remote-home');
const MARKER='OPENCODEX-FLOW-MARKER',pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,message,ms=60000){const end=Date.now()+ms;while(Date.now()<end){const value=await test();if(value)return value;await pause(100);}throw Error('Timed out: '+message);}
const report={at:new Date().toISOString(),version:'0.4.14',isolatedHome:true,externalModel:false,checks:{},errors:[]};
const records=[];const control={plan:[],hold:false,held:[]};
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
 const body=JSON.stringify(input.tools),server=/mcp__(opencodex_mac_[0-9a-f]{32})/.exec(body)?.[1]||/(opencodex_mac_[0-9a-f]{32})/.exec(body)?.[1];
 const space=input.tools.find(t=>t.type==='namespace'&&/^mcp__opencodex_mac_/.test(t.name));
 if(space?.tools?.some(t=>t.name===name))return {id:'fc_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),type:'function_call',namespace:space.name,name,arguments:JSON.stringify(args),status:'completed'};
 const exec=input.tools.find(t=>t.type==='namespace'&&t.name==='functions')?.tools?.find(t=>t.name==='exec');
 if(!exec)return null;
 const code='const t=ALL_TOOLS.find(t=>t.name.startsWith("mcp__opencodex_mac_")&&t.name.endsWith("__'+name+'")); if(!t)throw Error("NO-MAC-TOOL"); text(await tools[t.name]('+JSON.stringify(args)+'));';
 return {server,id:'ct_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),type:'custom_tool_call',namespace:'functions',name:'exec',input:code,status:'completed'};
}
function startModel(){
 model=http.createServer((req,res)=>{
  if(req.method!=='POST'||!req.url.startsWith('/v1/responses')){res.writeHead(404);return res.end();}
  let body='';req.on('data',d=>{body+=d;});req.on('end',()=>{
   try{
    const input=JSON.parse(body),metadata=JSON.parse(req.headers['x-codex-turn-metadata']||'{}');
    input.tools=input.tools||input.input?.filter(i=>i.type==='additional_tools').flatMap(i=>i.tools)||[];
    const last=input.input.at(-1),afterTool=['function_call_output','custom_tool_call_output'].includes(last?.type);
    const record={turnId:metadata.turn_id,afterTool,step:control.step};
    records.push(record);
    report.lastRequest=body;
    if(afterTool){record.output=JSON.stringify(last).slice(0,1500);const next=control.plan.shift();if(next){const call=macCall(input,next[0],next[1]);record.tool=next[0];return send(res,input,call||final('NO-MAC-TOOLS'));}return send(res,input,final('FLOW-DONE'));}
    if(control.hold){record.held=true;control.held.push(res);return;}
    const next=control.plan.shift()||['mac_fs_read',{path:path.join(project,'marker.txt')}];
    const call=macCall(input,next[0],next[1]);record.tool=next[0];record.offered=!!call;
    send(res,input,call||final('NO-MAC-TOOLS'));
   }catch(e){report.errors.push(e.stack);res.writeHead(500);res.end();}
  });
 });
 return new Promise((resolve,reject)=>{model.on('error',reject);model.listen(0,'127.0.0.1',resolve);});
}
const events=()=>{try{return fs.readFileSync(path.join(support,'adapter-events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));}catch{return [];}};
const seen=type=>events().some(event=>event.type===type);
const enginePid=()=>Number(fs.readFileSync(path.join(home,'engine.pid'),'utf8').trim());
const killEngine=()=>{const pid=enginePid();process.kill(pid,'SIGKILL');return pid;};
const text=value=>[{type:'text',text:value,text_elements:[]}];
function prepare(){
 // Past the first-run questions, like an existing profile: only then does a window open conversations.
 fs.mkdirSync(path.join(support,'codex-official'),{recursive:true});
 fs.writeFileSync(path.join(support,'codex-official/.codex-global-state.json'),JSON.stringify({'electron-persisted-atom-state':{'electron:onboarding-welcome-v2-role-state':{completedConversationalOnboarding:true,conversationalOnboardingSkipped:true,personalizedSuggestionsEnabled:false},'electron:onboarding-projectless-completed':true,'electron:onboarding-primary-runtime-install-ready':true,last_completed_onboarding:Math.floor(Date.now()/1000)}}));
 fs.mkdirSync(support,{recursive:true,mode:0o700});fs.mkdirSync(project);fs.mkdirSync(remoteHome);
 fs.writeFileSync(path.join(project,'marker.txt'),MARKER);
 const skill=path.join(home,'.codex/skills/flow-fixture-skill');fs.mkdirSync(skill,{recursive:true});
 fs.writeFileSync(path.join(skill,'SKILL.md'),'---\nname: flow-fixture-skill\ndescription: Isolated fixture skill for the flow test\n---\n\nFIXTURE-SKILL-BODY\n');
 fs.writeFileSync(path.join(home,'.codex/AGENTS.md'),'FIXTURE-GLOBAL-AGENTS\n');
 const id=crypto.randomUUID(),wrapper=path.join(home,'remote-codex.sh');
 fs.writeFileSync(wrapper,`#!/bin/bash\nexport CODEX_HOME=${remoteHome}\nexport OPENCODEX_FIXTURE_KEY=fixture-only\nif [ "$1" = "app-server" ] && [ "$2" != "--help" ]; then echo $$ > ${home}/engine.pid; fi\nexec "${engine}" "$@"\n`,{mode:0o700});
 fs.writeFileSync(path.join(remoteHome,'config.toml'),['model="gpt-6.1-sol"','model_provider="fixture"','[model_providers.fixture]','name="Isolated protocol fixture"','base_url="http://127.0.0.1:'+model.address().port+'/v1"','wire_api="responses"','env_key="OPENCODEX_FIXTURE_KEY"','request_max_retries=0','stream_max_retries=0','stream_idle_timeout_ms=20000'].join('\n'));
 fs.writeFileSync(path.join(support,'profiles.json'),JSON.stringify([{id,name:'loopback',host:'127.0.0.1',port:22,username:os.userInfo().username,authType:'key',keyPath:key,networkMode:'direct',savePassword:false}]),{mode:0o600});
 fs.writeFileSync(path.join(support,'opencodex.json'),JSON.stringify({mode:'ssh',sshAgent:'codex',profileName:'loopback',profileId:id,cwd:project,permissionMode:'full',approvalsReviewer:'user',fullAccess:true,parallelPrewarm:false,maxParallelSessions:1,codexConnections:{[id]:{executable:wrapper}}}),{mode:0o600});
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
 report.checks.connectedWithoutOtherApp=true;
 const {socket}=require('./qa-client.cjs');client=await socket(info.url);
 await client.call('initialize',{clientInfo:{name:'standalone-flow',version:'1'}});

 // The tools a model reaches, through the app's real request path.
 // A fresh profile installs bundled plugins at startup, which can change the Hooks a thread is bound to.
 const lastWrite=()=>Math.max(0,...events().filter(e=>['plugin/install','config/batchWrite'].includes(e.method)).map(e=>Date.parse(e.at)));
 await until(()=>Date.now()-Math.max(lastWrite(),Date.parse(report.at))>8000,'plugins settled',60000);
 const threadId=(await client.call('thread/start',{cwd:project})).thread.id;
 control.plan=[['mac_skill_search',{query:'flow fixture'}],['mac_skill_view',{name:'flow-fixture-skill'}],['mac_memory_write',{action:'add',text:'Flow fixture fact'}],['mac_memory_read',{}],['mac_session_search',{query:'nothing-matches-this'}],['mac_fs_read',{path:path.join(project,'marker.txt')}]];
 const firstTurn=(await client.call('turn/start',{threadId,input:text('hello')})).turn.id;
 await until(()=>client.events.some(e=>e.method==='turn/completed'&&e.params?.turn?.id===firstTurn),'first turn');
 const outputs=records.filter(r=>r.output).map(r=>r.output);
 assert(outputs[0].includes('flow-fixture-skill'),'skill search: '+outputs[0]);assert(outputs[1].includes('FIXTURE-SKILL-BODY'),'skill view: '+outputs[1]);
 assert(outputs[2].includes('saved'),'memory write: '+outputs[2]);assert(outputs[3].includes('Flow fixture fact'),'memory read: '+outputs[3]);
 assert(outputs[4].includes('scannedConversations'),'session search: '+outputs[4]);assert(outputs[5].includes(MARKER),'file read: '+outputs[5]);
 assert.equal(fs.readFileSync(path.join(support,'agent-memory/MEMORY.md'),'utf8').trim(),'Flow fixture fact');
 report.checks.newToolsWorkInTheApp=true;

 // What the model is told about this app.
 const sent=report.lastRequest;delete report.lastRequest;
 assert.match(sent,/You are the assistant in OpenCodex/);assert.match(sent,/FIXTURE-GLOBAL-AGENTS/);assert.match(sent,/Flow fixture fact|mac_memory_write/);
 assert.doesNotMatch(sent,/agentbridge_mac|agentbridge_peer|You are the Codex assistant in AgentBridge|AgentBridge-Mac/);
 assert.equal((sent.match(/AgentBridge/g)||[]).length,(sent.match(/such as AgentBridge Studio/g)||[]).length,'only the sentence forbidding it may name it');
 assert.match(JSON.parse(fs.readFileSync(path.join(support,'native-threads.json'),'utf8'))[threadId].environmentId,/^opencodex-mac-[0-9a-f-]{36}$/);
 report.checks.modelSeesOpenCodexOnly=true;

 // A goal running by itself: tools work, and steering is accepted.
 records.length=0;control.plan=[];
 const countCompleted=()=>client.events.filter(e=>e.method==='turn/completed').length,before=countCompleted();
 await client.call('thread/goal/set',{threadId,objective:'Finish the flow fixture',status:'active'});
 await until(()=>countCompleted()>before,'goal turn');
 assert(records.find(r=>r.afterTool)?.output?.includes(MARKER),'goal turn must reach the Mac tool');
 await until(()=>seen('server-turn-adopted'),'server turn adopted');
 report.checks.goalTurnHasTools=true;
 control.hold=true;
 const held=await until(()=>{const r=records.filter(item=>item.held).at(-1);return r&&client.events.filter(e=>e.method==='turn/started').at(-1)?.params?.turn?.id===r.turnId?r:null;},'running goal turn');
 await client.call('turn/steer',{threadId,expectedTurnId:held.turnId,input:text('steering into a goal turn')});
 report.checks.steerReachesGoalTurn=true;
 // A window opened after the turn began attaches to it instead of showing a resume error.
 const pages=[];
 for(const target of (await (await fetch('http://127.0.0.1:9325/json/list')).json()).filter(t=>t.url.startsWith('app://-/index.html'))){
  const page=await require('./qa-client.cjs').socket(target.webSocketDebuggerUrl);
  const run=async expression=>(await page.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  pages.push({page,run,info:await run('({href:location.href,visibility:document.visibilityState,focus:document.hasFocus(),text:document.body.innerText.length})')});
 }
 report.windows=pages.map(p=>p.info);
 // The primary window shows the app's navigation; the other frontend is a compact panel.
 const view=pages.slice().sort((a,b)=>b.info.text-a.info.text)[0];
 // The user's action: choose the conversation in the sidebar.
 await until(()=>view.run(`(()=>{const hits=[...document.querySelectorAll('a,button,[role=button],[role=link],li,div,span')].filter(e=>e.innerText?.trim()==='hello');const row=hits.at(-1);if(!row)return false;row.click();return true;})()`),'conversation in the sidebar',20000);
 try{await until(()=>seen('thread-attached'),'window attached to the running turn',30000);}
 catch(error){report.attachState=await view.run('({href:location.href,visibility:document.visibilityState,text:document.body.innerText.slice(0,500)})');throw error;}
 await pause(3000);
 const shown=await view.run('document.body.innerText');
 report.attachedView=shown.slice(-400);
 assert.doesNotMatch(shown,/無法恢復聊天|工作仍在啟動或執行|Loading model/,shown.slice(0,800));
 assert(!events().some(e=>e.type==='rpc-error'&&e.method==='thread/resume'),'the window must not be refused');
 for(const {page} of pages)page.close();
 const attached=await client.call('thread/resume',{threadId});
 assert.equal(attached.thread?.status?.type,'active');
 assert.equal(attached.thread?.turns?.at(-1)?.status,'inProgress');
 assert(seen('thread-attached'));
 await client.call('turn/steer',{threadId,expectedTurnId:held.turnId,input:text('steering after attaching')});
 report.checks.windowAttachesToRunningTurn=true;

 // The reported failure: the connection drops while the goal is running.
 const dropped=killEngine();for(const res of control.held.splice(0))res.destroy();control.hold=false;records.length=0;
 await until(()=>seen('ssh-closed'),'drop detected');
 await until(()=>{try{return enginePid()!==dropped;}catch{return false;}},'reconnected engine',60000);
 await until(()=>seen('goal-continued-after-reconnect'),'goal continued after reconnect',60000);
 await until(()=>records.some(r=>r.afterTool),'tool result after reconnect');
 assert(records.filter(r=>r.afterTool).every(r=>r.output.includes(MARKER)),'every turn after the drop must reach the Mac tool: '+JSON.stringify(records).slice(0,800));
 assert(seen('goal-held')&&seen('goal-released'));
 report.checks.goalContinuesAfterDropWithTools=true;

 // Stop reaches a running goal turn.
 await client.call('thread/goal/set',{threadId,status:'paused'});
 control.hold=true;
 const settled=async()=>{for(let i=0;i<50;i++){const status=await client.call('thread/read',{threadId,includeTurns:false});if(status.thread?.status?.type!=='active')return;await pause(100);}};
 await settled();
 report.checks.goalPauseSettles=true;
 control.hold=false;

 // A message sent after a drop with nothing running starts the next turn instead of failing.
 const stale=client.events.filter(e=>e.method==='turn/started').at(-1)?.params?.turn?.id;
 const second=enginePid();killEngine();records.length=0;
 await until(()=>{try{return enginePid()!==second;}catch{return false;}},'second reconnect',60000);
 await until(async()=>{const state=await client.call('thread/loaded/list',{}).catch(()=>null);return !!state;},'connection ready',30000);
 const steered=await until(async()=>{try{return await client.call('turn/steer',{threadId,expectedTurnId:stale,input:text('message after the drop')});}catch(error){if(/連線|尚未|請稍候/.test(error.message))return null;throw error;}},'message after the drop',30000);
 assert(steered.turnId);
 await until(()=>records.some(r=>r.afterTool),'message reached the model');
 assert(records.find(r=>r.afterTool).output.includes(MARKER));
 report.checks.messageAfterDropStartsNextTurn=true;
 await pause(500);

 // What the user sees.
 const {cdp}=require('./qa-client.cjs');const page=await cdp();
 const html=await page.evaluate('document.documentElement.outerHTML'),visible=await page.evaluate('document.body.innerText');
 assert.doesNotMatch(visible,/AgentBridge/);assert.doesNotMatch(html,/不需開啟 AgentBridge/);
 report.checks.windowShowsNoOtherApp=true;
 page.close?.();
 report.passed=true;
}
main().catch(e=>{report.errors.push(e.stack);process.exitCode=1;}).finally(async()=>{
 report.lastRequest=undefined;report.events=events().filter(e=>!['rpc'].includes(e.type)).slice(-40);
 try{client?.close();}catch{}
 if(mainPid){try{process.kill(mainPid,'SIGTERM');}catch{}await pause(3000);try{process.kill(mainPid,'SIGKILL');}catch{}}
 try{process.kill(enginePid(),'SIGKILL');}catch{}
 // Helpers outlive the app; nothing else may be running from this build during the test.
 for(const pattern of [path.basename(home),path.join(app,'Contents/Resources/native/bare-modifier-monitor'),engine+' exec-server'])spawnSync('/usr/bin/pkill',['-f',pattern]);
 await pause(1000);spawnSync('/usr/bin/pkill',['-f',path.basename(home)]);
 model?.closeAllConnections();if(model)await new Promise(r=>model.close(r));
 fs.mkdirSync(path.join(root,'evidence'),{recursive:true});fs.writeFileSync(path.join(root,'evidence/standalone-flow-e2e.json'),JSON.stringify({...report,records:records.slice(-20)},null,2)+'\n');
 fs.rmSync(home,{recursive:true,force:true,maxRetries:4,retryDelay:200});
 console.log(JSON.stringify({passed:report.passed,checks:report.checks,errors:report.errors.map(e=>e.slice(0,900))},null,1));
 process.exit(process.exitCode||0);
});
