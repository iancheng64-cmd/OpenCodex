'use strict';
// Real pinned engine, real Mac tool host and a mock Responses provider: shows why a resumed goal
// had no Mac tools and that the guard fixes it. No external model, credentials or network.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),Module=require('node:module'),vm=require('node:vm');
const {spawn,execFileSync}=require('node:child_process'),EventEmitter=require('node:events'),crypto=require('node:crypto');
const {AppServerRpc}=require('../vendor/agentbridge/dist-main/app-server-rpc');
const patches=require('./subagent-patches.cjs'),{GoalGuard}=require('../src/native-goal-guard.cjs');
const root=path.resolve(__dirname,'..'),binary=process.env.OPENCODEX_FIXTURE_ENGINE||path.join(root,'build/OpenCodex.app/Contents/Resources/agentbridge/codex/bin/codex');
function compiled(name,patch){const f=path.join(root,'vendor/agentbridge/dist-main',name+'.js'),m=new Module(f,module);m.filename=f;m.paths=Module._nodeModulePaths(path.dirname(f));m._compile(patch(fs.readFileSync(f,'utf8')),f);require.cache[f]=m;return m.exports;}
const {LocalExecServer}=compiled('local-exec-server',patches.executor);
compiled('agent-core-tools',patches.core);
const {LocalToolHost}=compiled('local-tool-host',patches.host);
const MARKER='OPENCODEX-GOAL-MARKER',pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,message,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await test())return;await pause(25);}throw Error('Timed out: '+message);}
const report={at:new Date().toISOString(),version:'0.4.14',fixtureOnly:true,externalModel:false,phases:{},errors:[]};
const adapterExports=()=>{
 const context={exports:{},require:id=>require(path.join(__dirname,'../src',path.basename(id))),runtimes:new Map(),refreshMacExtensions:async()=>{},verifyThreadMcp:async()=>{},
  runtime_policy_1:require('../vendor/agentbridge/dist-main/runtime-policy.js'),permission_policy_1:require('../vendor/agentbridge/dist-main/permission-policy.js'),runtime_extensions_1:require('../vendor/agentbridge/dist-main/runtime-extensions.js'),node_crypto_1:crypto};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bridge-adapter.cjs'),'utf8'),context);
 return context.exports;
};
const adapter=adapterExports();
let temp,macCwd,codexHome,runtimeCwd,executor,host,endpoint,model,env,current;
const records=[];const control={hold:false,holdAfterFinals:Infinity,finals:0,held:[]};
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
// Calls the Mac tool the way this engine offers it: directly, or from code mode.
function macToolCall(tools,args){
 const space=tools.find(t=>t.type==='namespace'&&t.name==='mcp__fixture');
 if(space?.tools?.some(t=>t.name==='mac_fs_read'))return {id:'fc_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),type:'function_call',namespace:'mcp__fixture',name:'mac_fs_read',arguments:JSON.stringify(args),status:'completed'};
 const exec=tools.find(t=>t.type==='namespace'&&t.name==='functions')?.tools?.find(t=>t.name==='exec');
 if(!exec?.description?.includes('ALL_TOOLS'))return null;
 const code='const t=ALL_TOOLS.find(t=>t.name==="mcp__fixture__mac_fs_read"); if(!t)throw Error("NO-MAC-TOOL"); text(await tools[t.name]('+JSON.stringify(args)+'));';
 return {id:'ct_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),type:'custom_tool_call',namespace:'functions',name:'exec',input:code,status:'completed'};
}
function startModel(){
 model=http.createServer((req,res)=>{
  if(req.method!=='POST'||!req.url.startsWith('/v1/responses')){res.writeHead(404);return res.end();}
  let body='';req.on('data',d=>{body+=d;});req.on('end',()=>{
   try{
    const input=JSON.parse(body),metadata=JSON.parse(req.headers['x-codex-turn-metadata']||'{}');
    input.tools=input.tools||input.input?.filter(i=>i.type==='additional_tools').flatMap(i=>i.tools)||[];
    const last=input.input.at(-1),afterTool=['function_call_output','custom_tool_call_output'].includes(last?.type);
    const record={phase:current?.name,turnId:metadata.turn_id,afterTool};
    records.push(record);
    if(afterTool){
     record.macToolWorked=JSON.stringify(last).includes(MARKER);
     control.finals++;if(control.finals>=control.holdAfterFinals)control.hold=true;
     return send(res,input,final('FIXTURE-DONE'));
    }
    if(control.hold){record.held=true;control.held.push(res);return;}
    const call=macToolCall(input.tools,{path:path.join(macCwd,'marker.txt')});
    record.offeredMacTool=!!call;
    if(!call){control.finals++;if(control.finals>=control.holdAfterFinals)control.hold=true;return send(res,input,final('NO-MAC-TOOLS'));}
    send(res,input,call);
   }catch(e){report.errors.push(e.stack);res.writeHead(500);res.end();}
  });
 });
 return new Promise((resolve,reject)=>{model.on('error',reject);model.listen(0,'127.0.0.1',resolve);});
}
async function session(name,{guard,watch}={}){
 const child=spawn(binary,['app-server','--listen','stdio://'],{cwd:runtimeCwd,env,stdio:['pipe','pipe','pipe']});
 const transport=new EventEmitter();transport.write=s=>child.stdin.write(s);transport.close=()=>child.kill('SIGTERM');
 child.stdout.on('data',d=>transport.emit('data',d));child.stderr.resume();
 child.on('error',e=>transport.emit('error',e));child.on('close',()=>transport.emit('close'));
 const rpc=new AppServerRpc(transport);
 rpc.on('request',m=>rpc.reject(m.id,'Unexpected request in isolated fixture'));
 const self={name,child,rpc,completions:[],started:[]};
 const runtime={id:'fixture',closed:false,snapshot:{runtimeVersion:'0.160.0',profileId:'fixture',executorEnvironment:{}},mcp:{name:'fixture',url:endpoint.url,token:endpoint.token,environmentId:executor.environmentId},executor,localCwd:macCwd,permissionMode:'full',requests:new Map(),toolHost:host,rpc,openCodexThreads:new Set()};
 self.runtime=runtime;current=self;
 const deps={emit:()=>{},goalGuard:guard,agentInstructions:async()=>'Isolated fixture.'};
 self.request=(method,params)=>adapter.openCodexRequest(runtime,deps,method,params);
 self.notes=[];
 const observer=watch?adapter.openCodexWatchServerTurns(runtime,deps,{notify:type=>self.notes.push(type)}):null;
 rpc.on('notification',m=>{
  if(m.method==='turn/started')self.started.push(m.params.turn.id);
  observer?.(m);
  runtime.openCodexSubagents?.notification(m);
  if(m.method==='turn/completed'){self.completions.push(m.params.turn);if(runtime.run?.threadId===m.params.threadId){runtime.openCodexSubagents?.close();runtime.openCodexSubagents=undefined;runtime.run=undefined;}}
 });
 await rpc.request('initialize',{clientInfo:{name:'opencodex-goal-fixture',version:'0.4.14'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
 await executor.register(rpc,executor.localUrl);
 runtime.snapshot.executorEnvironment={environmentId:executor.environmentId};
 return self;
}
async function drop(self){
 self.runtime.closed=true;self.runtime.openCodexSubagents?.close();self.runtime.run=undefined;host.cancelActive?.();
 const closed=self.child.exitCode==null?new Promise(r=>self.child.once('close',r)):Promise.resolve();
 self.child.kill('SIGKILL');await closed;
 try{self.rpc.close();}catch{}
 for(const res of control.held.splice(0))res.destroy();
 control.hold=false;control.holdAfterFinals=Infinity;control.finals=0;
}
const goalStatus=async(self,threadId)=>(await self.rpc.request('thread/goal/get',{threadId},10000)).goal?.status;
const ofPhase=name=>records.filter(r=>r.phase===name);
const text=value=>[{type:'text',text:value,text_elements:[]}];
async function main(){
 report.engine=execFileSync(binary,['--version'],{encoding:'utf8'}).trim();assert.equal(report.engine,'codex-cli 0.160.0');
 temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-goal-e2e-')));
 codexHome=path.join(temp,'home');runtimeCwd=path.join(temp,'runtime');macCwd=path.join(temp,'mac');
 for(const d of [codexHome,runtimeCwd,macCwd])fs.mkdirSync(d);
 fs.writeFileSync(path.join(macCwd,'marker.txt'),MARKER);
 // The real gate: a Mac tool is refused unless a run owns the turn.
 let owner;
 host=new LocalToolHost({allowedRoots:[macCwd],fullFilesystemAccess:true,authorize:()=>!!owner?.run&&!owner.run.cancelled});
 endpoint=await host.start();
 await startModel();
 fs.writeFileSync(path.join(codexHome,'config.toml'),['model="gpt-6.1-sol"','model_provider="fixture"','[features]','deferred_executor=true','skip_host_skill_discovery=true','[model_providers.fixture]','name="Isolated protocol fixture"','base_url="http://127.0.0.1:'+model.address().port+'/v1"','wire_api="responses"','env_key="OPENCODEX_FIXTURE_KEY"','request_max_retries=0','stream_max_retries=0','stream_idle_timeout_ms=20000'].join('\n'));
 env={PATH:process.env.PATH,HOME:temp,TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',CODEX_HOME:codexHome,CODEX_EXEC_SERVER_URL:'none',OPENCODEX_FIXTURE_KEY:'fixture-only'};
 executor=new LocalExecServer({codexExecutable:binary,version:'0.160.0'},()=>{});await executor.start(macCwd,env);
 const goalGuard=new GoalGuard({file:path.join(temp,'holds.json')});

 // A: a user turn, then the peer's own goal turns on a thread that has the Mac environment.
 let s=await session('continuation',{guard:goalGuard,watch:true});owner=s.runtime;
 const threadId=(await s.request('thread/start',{})).thread.id;
 await s.request('turn/start',{threadId,input:text('hello')});
 await until(()=>s.completions.length>=1,'first user turn');
 assert.equal(ofPhase('continuation').find(r=>r.afterTool)?.macToolWorked,true,'user turn must reach the Mac tool');
 const beforeGoal=s.completions.length;control.finals=0;control.holdAfterFinals=2;
 await s.rpc.request('thread/goal/set',{threadId,objective:'Finish the fixture',status:'active'},10000);
 await until(()=>s.completions.length>beforeGoal,'server-started goal turn');
 const adoptedTurn=ofPhase('continuation').filter(r=>r.afterTool).at(-1);
 assert.equal(adoptedTurn.macToolWorked,true,'a server-started goal turn must reach the Mac tool');
 assert(s.notes.includes('server-turn-adopted'));
 report.phases.continuation={serverTurnReachedMacTool:adoptedTurn.macToolWorked,notes:s.notes};
 await until(()=>control.held.length>=1,'next goal turn before the drop');
 assert.equal(await goalStatus(s,threadId),'active');

 // B: the reported failure. The connection drops, the thread resumes, and the peer continues
 // the goal at once with no Mac environment. Nothing guards this session.
 await drop(s);
 s=await session('unguarded',{});owner=s.runtime;control.holdAfterFinals=1;
 await s.request('thread/resume',{threadId});
 await until(()=>ofPhase('unguarded').length>=1,'unguarded goal turn');
 assert(s.runtime.openCodexDormantThreads.has(threadId));
 await until(()=>ofPhase('unguarded').some(r=>r.offeredMacTool===false||r.macToolWorked===false),'turn with no Mac tool');
 report.phases.unguarded={startedWithoutUser:s.started.length>=1,reachedMacTool:ofPhase('unguarded').some(r=>r.macToolWorked===true)};
 assert.equal(report.phases.unguarded.reachedMacTool,false,'the unguarded turn is the reported bug');

 // C: the fix. Resume holds the goal, nothing runs until the user acts, then every turn has tools.
 await drop(s);
 s=await session('guarded',{guard:goalGuard,watch:true});owner=s.runtime;
 await s.request('thread/resume',{threadId});
 await pause(2500);
 assert.equal(ofPhase('guarded').length,0,'no turn may start before the Mac environment is selected');
 assert.equal(s.started.length,0);assert.equal(await goalStatus(s,threadId),'paused');assert.equal(goalGuard.held(threadId),true);
 assert.equal(new GoalGuard({file:path.join(temp,'holds.json')}).held(threadId),true);
 control.finals=0;control.holdAfterFinals=2;
 await s.request('turn/start',{threadId,input:text('please continue')});
 await until(async()=>!goalGuard.held(threadId)&&await goalStatus(s,threadId)==='active','goal restored after the turn selected the Mac');
 await until(()=>control.held.length>=1,'continuation after the restored goal');
 const reached=ofPhase('guarded').filter(r=>r.afterTool);
 assert(reached.length>=2,'user turn and goal turn');assert(reached.every(r=>r.macToolWorked===true),'every guarded turn must reach the Mac tool');
 report.phases.guarded={quietBeforeUser:true,turnsReachingMacTool:reached.length};

 // D: Stop reaches a server-started turn, and steering is not refused.
 assert.equal(s.runtime.run?.serverInitiated,true);
 const stopping=s.runtime.run.turnId;
 await s.rpc.request('thread/goal/set',{threadId,status:'paused'},10000);
 await s.request('turn/interrupt',{threadId,turnId:stopping});
 await until(()=>s.completions.some(t=>t.id===stopping),'interrupted server turn');
 assert.equal(s.completions.find(t=>t.id===stopping).status,'interrupted');
 report.phases.stop={interrupted:true};
 for(const res of control.held.splice(0))res.destroy();
 control.hold=false;control.holdAfterFinals=Infinity;

 // E: the safety net. If the hold could not be placed, the turn is ended before it can do anything.
 await s.rpc.request('thread/goal/set',{threadId,status:'active'},10000);
 await until(()=>s.started.length>=1,'goal running before the second drop');
 control.hold=true;
 await until(()=>control.held.length>=1,'held turn before the second drop');
 assert.equal(await goalStatus(s,threadId),'active');
 await drop(s);
 let refused=false;
 const flaky={hold:async(rpc,id)=>{if(!refused){refused=true;return false;}return goalGuard.hold(rpc,id);},release:(...a)=>goalGuard.release(...a),forget:(...a)=>goalGuard.forget(...a)};
 s=await session('net',{guard:flaky,watch:true});owner=s.runtime;control.hold=true;
 await s.request('thread/resume',{threadId});
 await until(()=>s.completions.some(t=>t.status==='interrupted'),'unguarded turn interrupted by the safety net');
 assert.equal(await goalStatus(s,threadId),'paused');assert(s.notes.includes('server-turn-stopped'));assert.equal(s.runtime.run,undefined);
 await pause(1500);
 assert.equal(s.completions.filter(t=>t.status!=='interrupted').length,0,'no further turn after the safety net');
 report.phases.safetyNet={interrupted:true,goalPaused:true};
 await drop(s);current=null;
 report.passed=true;
}
main().catch(e=>{report.errors.push(e.stack);process.exitCode=1;}).finally(async()=>{
 if(current)await drop(current).catch(()=>{});
 try{executor?.stop();await host?.stop();model?.closeAllConnections();if(model)await new Promise(r=>model.close(r));}catch(e){report.errors.push(e.stack);}
 await fs.promises.rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100}).catch(()=>{});
 fs.mkdirSync(path.join(root,'evidence'),{recursive:true});fs.writeFileSync(path.join(root,'evidence/native-goal-guard-e2e.json'),JSON.stringify({...report,records},null,2)+'\n');
 console.log(JSON.stringify({passed:report.passed,engine:report.engine,phases:report.phases,errors:report.errors.map(e=>e.slice(0,700))},null,1));
 process.exit(process.exitCode||0);
});
