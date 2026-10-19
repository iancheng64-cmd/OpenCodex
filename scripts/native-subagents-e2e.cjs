'use strict';
// Real pinned engine, patched Mac host and mock Responses provider; no external model or credentials.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),Module=require('node:module');
const {spawn,execFileSync}=require('node:child_process'),EventEmitter=require('node:events'),crypto=require('node:crypto');
const {AppServerRpc}=require('../vendor/agentbridge/dist-main/app-server-rpc');
// Load the same bounded executor transport patch used by the app.
let LocalExecServer;
const {NativeAgentRuns,receiptFor,configureSubagents}=require('../src/native-agent-runs.cjs'),{scopedRun}=require('../src/native-run-context.cjs');
const patches=require('./subagent-patches.cjs');
const root=path.resolve(__dirname,'..'),binary=process.env.OPENCODEX_FIXTURE_ENGINE||path.join(root,'build/OpenCodex.app/Contents/Resources/agentbridge/codex/bin/codex');
function compiled(name,patch){const f=path.join(root,'vendor/agentbridge/dist-main',name+'.js'),m=new Module(f,module);m.filename=f;m.paths=Module._nodeModulePaths(path.dirname(f));m._compile(patch(fs.readFileSync(f,'utf8')),f);require.cache[f]=m;return m.exports;}
const hooksProbe=process.argv.includes('--hooks');
const hookRewrite=process.argv.includes('--hook-rewrite');
if(hookRewrite&&(!hooksProbe||process.argv[2]!=='review'))throw Error('Hook rewrite fixture requires review --hooks');
const hookFailure=process.argv.find(a=>a.startsWith('--hook-failure='))?.split('=')[1];
if(hookFailure&&(!hooksProbe||process.argv[2]!=='review'||!['throw','malformed','cancel','generation'].includes(hookFailure)))throw Error('Hook failure fixture requires review --hooks and a supported failure mode');
({LocalExecServer}=compiled('local-exec-server',patches.executor));
compiled('agent-core-tools',patches.core);const {LocalToolHost}=compiled('local-tool-host',s=>hooksProbe?patches.hooksHost(patches.host(s)):patches.host(s));
const pause=ms=>new Promise(r=>setTimeout(r,ms)),scenario=process.argv[2]||'normal';
if(!['normal','cancel-root','cancel-child','parent-complete','review','review-cancel'].includes(scenario))throw Error('Unknown fixture scenario');
const isReview=scenario.startsWith('review');
const report={at:new Date().toISOString(),version:'0.4.7',scenario,fixtureOnly:true,externalModel:false,events:[],requests:[],mcpCalls:[],errors:[],activity:[]};
let rpc,executor,child,model,host,temp,manager,runtime,releaseGate,hookOptions,hookLog,hooksRuntime;

const {EVENTS,NativeHooksBinding,relayConfig}=require('../src/native-hooks-relay.cjs');
const {NativeHooksRuntime}=require('../src/native-hooks-runtime.cjs');
async function prepareHooks(macCwd){
 const home=path.join(temp,'mac-hooks-home');fs.mkdirSync(home);
 hookLog=path.join(temp,'native-hooks.jsonl');
 const script=path.join(temp,'native-hook.cjs');
 const hookProgram=`const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(process.argv[2],JSON.stringify(p)+'\\n');let output={};if(${JSON.stringify(hookRewrite)}&&p.hook_event_name==='PreToolUse'&&p.tool_name?.includes('mac_fs_read'))output={hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...p.tool_input,path:${JSON.stringify(path.join(macCwd,'marker.txt'))}}}};process.stdout.write(JSON.stringify(output));`;
 fs.writeFileSync(script,hookProgram);
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 const command=[process.execPath,script,hookLog].map(quote).join(' ');
 fs.writeFileSync(path.join(home,'hooks.json'),JSON.stringify({hooks:Object.fromEntries(Object.keys(EVENTS).map(event=>[event,[{hooks:[{type:'command',command,timeout:10}]}]]))}));
 const config=path.join(home,'config.toml');fs.writeFileSync(config,'[features]\nhooks=true\n');
 const relay=relayConfig({server:'fixture'});report.hooksNonce=relay.nonce;
 hookOptions={binary:path.join(root,'build/hooks-target/debug/opencodex-hooks-helper'),cwd:macCwd,codexHome:home,nonce:relay.nonce,events:relay.events,
  env:{PATH:process.env.PATH,HOME:temp,CODEX_HOME:home,TMPDIR:temp,LANG:'en_US.UTF-8',ELECTRON_RUN_AS_NODE:'1'}};
 const seed=new NativeHooksBinding({...hookOptions,threadId:crypto.randomUUID()});
 try{const inventory=await seed.ready;assert.equal(inventory.hooks.length,Object.keys(EVENTS).length);
  fs.writeFileSync(config,'[features]\nhooks=true\n'+inventory.hooks.map(h=>'\n[hooks.state.'+JSON.stringify(h.key)+']\nenabled=true\ntrusted_hash='+JSON.stringify(h.currentHash)+'\n').join(''));
 }finally{await seed.close();}
 return relay;
}
function verifyHooks(){
 if(!hooksProbe)return;
 assert((report.hooks||[]).length>0,'No native Hooks completed');
 const completed=(report.hookEvents||[]).filter(m=>m.method==='hook/completed');
 report.nativeHookFailures=completed.filter(m=>m.params.run.status!=='completed');
 const cancelled=(report.hookAttempts||[]).filter(a=>a.error);
 for(const attempt of cancelled){
  assert.notEqual(scenario,'normal');assert.equal(attempt.error,'hook execution cancelled');
  assert.equal(completions.get(attempt.metadata.threadId)?.status,'interrupted');
 }
 for(const event of report.nativeHookFailures){
  assert.equal(event.params.run.status,'blocked');
  assert(cancelled.some(a=>a.metadata.threadId===event.params.threadId&&a.turnId===event.params.turnId));
  assert(event.params.run.entries.some(e=>e.text==='Mac native Hooks relay did not complete'));
 }
 assert.equal(report.nativeHookFailures.length,cancelled.length);
 assert.equal(completed.length,report.hooks.length,'Every native Hook must reach its Mac relay');
 const logs=fs.readFileSync(hookLog,'utf8').trim().split('\n').map(JSON.parse);report.nativeHookInputs=logs;
 assert(logs.length<=report.hooks.length&&logs.length>=report.hooks.length-cancelled.length,'Only interrupted Hooks may stop before writing the command log');
 const macCompleted=(report.macHookEvents||[]).filter(m=>m.method==='hook/completed');
 const macStarted=(report.macHookEvents||[]).filter(m=>m.method==='hook/started');
 assert.equal(macCompleted.length,report.hooks.length,'Every started Mac Hook must finish in the native UI');
 for(const m of macCompleted)if(m.params.run.status!=='completed'){
  assert.equal(m.params.run.status,'stopped');
  assert(cancelled.some(a=>a.metadata.threadId===m.params.threadId&&a.turnId===m.params.turnId));
 }
 assert.equal(macStarted.length,macCompleted.length,'Every Mac Hook start must have an outcome');
 assert.deepEqual(macStarted.map(m=>[m.params.threadId,m.params.turnId,m.params.run.id]).sort(),macCompleted.map(m=>[m.params.threadId,m.params.turnId,m.params.run.id]).sort(),'Hook UI lifecycle identities must match');
 for(const input of logs){assert.equal(input.session_id,runtime.run.threadId);assert.equal(input.cwd,runtime.localCwd);assert(!input.transcript_path);}
 if(isReview){assert(report.hooks.some(h=>h.event==='PreToolUse'&&h.threadId===manager.reviewThreadId));assert(report.hooks.some(h=>h.event==='PostToolUse'&&h.threadId===manager.reviewThreadId));}
 else if(scenario==='normal'){
  for(const c of report.children){for(const event of ['SubagentStart','PreToolUse','PostToolUse','SubagentStop'])assert(report.hooks.some(h=>h.threadId===c.threadId&&h.event===event),c.name+' missing '+event);assert(logs.some(i=>i.agent_id===c.threadId&&i.agent_type==='default'));}
  for(const event of ['SessionStart','Stop'])assert(report.hooks.some(h=>h.threadId===runtime.run.threadId&&h.event===event));
 }
 const interrupts=report.hooks.filter(h=>h.event==='Interrupt');
 assert.equal(interrupts.length,['cancel-root','review-cancel'].includes(scenario)?1:0);
 for(const h of interrupts){assert.equal(h.threadId,runtime.run.threadId);assert.equal(h.turnId,runtime.run.turnId);}
 report.nativeHooksPassed=true;
}
const completions=new Map(),modelSteps=new Map(),held=new Map(),names=new Map();
async function until(test,message,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(test())return;await pause(25);}throw Error(message);}
function call(namespace,name,args,tools){
 const space=tools.find(t=>t.type==='namespace'&&t.name===namespace);
 if(!space?.tools?.some(t=>t.name===name)){
  const exec=tools.find(t=>t.type==='namespace'&&t.name==='functions')?.tools?.find(t=>t.name==='exec');
  const helper=namespace+'__'+name;
  if(!exec?.description?.includes('ALL_TOOLS'))throw Error('Missing advertised fixture tool '+namespace+'.'+name);
  const code='const t=ALL_TOOLS.find(t=>t.name==='+JSON.stringify(helper)+'); if(!t)throw Error("Fixture tool unavailable"); if(ALL_TOOLS.some(t=>t.name.startsWith("mcp__peer__")))throw Error("Peer tool leaked"); text(await tools[t.name]('+JSON.stringify(args)+'));';
  return {id:'ct_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),type:'custom_tool_call',namespace:'functions',name:'exec',input:code,status:'completed'};
 }
 return {id:'fc_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),type:'function_call',namespace,name,arguments:JSON.stringify(args),status:'completed'};
}
function send(res,input,item){
 const response={id:'resp_'+crypto.randomUUID(),object:'response',created_at:Math.floor(Date.now()/1000),model:input.model,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
 let seq=0;const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:seq++,...data})+'\n\n');
 emit('response.created',{response:{...response,status:'in_progress',output:[]}});
 emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress'}});
 if(item.type==='function_call')emit('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:item.arguments});
 else if(item.type==='custom_tool_call')emit('response.custom_tool_call_input.done',{item_id:item.id,output_index:0,input:item.input});
 else {
  const part=item.content[0];
  emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:part.text});
  emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:part.text});
  emit('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part});
 }
 emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response});res.end();
}
function final(text){return {id:'msg_'+crypto.randomUUID(),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};}
function readBody(req,fn){let body='';req.on('data',d=>{body+=d;if(body.length>2*1024*1024)req.destroy();});req.on('end',()=>{try{fn(JSON.parse(body||'{}'));}catch(e){report.errors.push(e.message);}});}
function listen(server){return new Promise((r,j)=>{server.on('error',j);server.listen(0,'127.0.0.1',r);});}

async function main(){
 report.engine=execFileSync(binary,['--version'],{encoding:'utf8'}).trim();assert.equal(report.engine,'codex-cli 0.160.0');
 temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-subagent-e2e-')));
 const codexHome=path.join(temp,'home'),runtimeCwd=path.join(temp,'runtime'),macCwd=path.join(temp,'mac');
 for(const d of [codexHome,runtimeCwd,macCwd])fs.mkdirSync(d);
 fs.writeFileSync(path.join(temp,'owned-fixture'),'OpenCodex');fs.writeFileSync(path.join(macCwd,'marker.txt'),'OPENCODEX-MAC-FIXTURE');
 host=new LocalToolHost({allowedRoots:[macCwd],authorize:call=>manager.authorize(call),onActivity:e=>{report.activity.push(e);console.log('TOOL '+JSON.stringify(e));}});
 const endpoint=await host.start();
 let relay=hooksProbe?await prepareHooks(macCwd):null;
 const observedHookRelay=async({arguments:args,metadata,signal,claim})=>{
  const attempt={event:args.event,sessionId:args.sessionId,turnId:args.turnId,toolName:args.toolName,toolInput:args.toolInput,metadata};
  (report.hookAttempts||(report.hookAttempts=[])).push(attempt);
  try {
  assert.equal(args.sessionId,runtime.run.threadId);assert.equal(args.relayNonce,report.hooksNonce);
  assert.equal(typeof metadata?.threadId,'string');
  const {thread}=await rpc.request('thread/read',{threadId:metadata.threadId,includeTurns:true},5000);
  assert.equal(thread.id,metadata.threadId);
  (report.hooks||(report.hooks=[])).push({event:args.event,sessionId:args.sessionId,threadId:metadata.threadId,turnId:args.turnId,metadata,source:thread.source,parent:thread.parentThreadId,cwd:thread.cwd,environments:thread.environments,status:thread.status,turns:thread.turns?.map(t=>({id:t.id,status:t.status,completedAt:t.completedAt})),reviewTurnId:manager?.reviewTurnId,rootTurnId:runtime?.run?.turnId});
  if(hookFailure&&args.event==='PreToolUse'&&(args.toolName?.includes('mac_fs_read')||JSON.stringify(args.toolInput).includes('mac_fs_read'))){
   const owner=await manager.resolveHook(args,metadata,signal);claim(owner.run);
   report.injectedHookFailure={mode:hookFailure,threadId:owner.threadId,turnId:owner.turnId};
   if(hookFailure==='throw')throw Error('Intentional isolated relay failure');
   if(hookFailure==='malformed')return [];
   if(hookFailure==='cancel')host.cancelRun(owner.run);
   if(hookFailure==='generation')host.generation++;
   return {};
  }
  const output=await hooksRuntime.dispatch({arguments:args,metadata,signal,claim});
  attempt.completed=true;return output;
  }catch(error){attempt.error=error.message;throw error;}
 };
 const read=host.entries.get('mac_fs_read'),readInvoke=read.invoke;
 read.invoke=async(args,signal)=>{const run=scopedRun(runtime);assert(run);report.mcpCalls.push({threadId:run.threadId,turnId:run.turnId,parentThreadId:run.parentThreadId||null,name:names.get(run.threadId)});try{const result=await readInvoke(args,signal);assert(JSON.stringify(result).includes('OPENCODEX-MAC-FIXTURE'));return result;}catch(e){console.log('READERROR '+JSON.stringify({args,error:e.message}));throw e;}};
 host.entries.set('mac_fixture_hold',{category:'filesystem-read',tool:{name:'mac_fixture_hold',description:'Wait for the isolated cancellation fixture.',annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},inputSchema:{type:'object',properties:{},additionalProperties:false}},invoke:async(args,signal)=>{
  const run=scopedRun(runtime);assert(manager.isActive(run));const name=run.nativeReview?'review':names.get(run.threadId);
  report.mcpCalls.push({threadId:run.threadId,turnId:run.turnId,parentThreadId:run.parentThreadId,name});
  return new Promise((resolve,reject)=>{const end=()=>resolve({content:[{type:'text',text:'FIXTURE-RELEASED'}]});held.set(name,{run,signal,release:end});signal.addEventListener('abort',()=>reject(Error('Request cancelled')),{once:true});});
 }});
 model=http.createServer((req,res)=>{
  if(req.method!=='POST'||!req.url.startsWith('/v1/responses')){res.writeHead(404);return res.end();}
  readBody(req,async input=>{
   try{
    if(report.requests.length>80)throw Error('Too many fixture model requests');
    input.tools=input.tools||input.input?.filter(i=>i.type==='additional_tools').flatMap(i=>i.tools)||[];
    if(!input.tools.length)throw Error('Fixture request lacks advertised tools');
    if(!report.requests.length)fs.writeFileSync(path.join(root,'evidence/subagent-fixture-model-tools.json'),JSON.stringify({tools:input.tools,instructions:input.instructions,input:input.input.filter(i=>i.type==='message')},null,2));
    const metadata=JSON.parse(req.headers['x-codex-turn-metadata']||'{}'),name=metadata.agent_name;
    names.set(metadata.thread_id,name);const step=(modelSteps.get(metadata.thread_id)||0)+1;modelSteps.set(metadata.thread_id,step);
    report.requests.push({metadata,step,toolNames:input.tools.map(t=>t.name),results:input.input.filter(i=>i.type==='function_call_output'||i.type==='custom_tool_call_output')});console.log('MODEL '+name+' '+step);
    assert(!input.tools.some(t=>t.name==='mcp__peer'),'Peer MCP leaked into child model tools');
    const collaboration=input.tools.find(t=>t.name==='collaboration');
    if(collaboration){const props=collaboration.tools.find(t=>t.name==='spawn_agent').parameters.properties;assert(!props.agent_type&&!props.config);report.v2NoRoleOverride=true;}
    let item;
    if(isReview){
     if(step===1)item={id:'ct_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),type:'custom_tool_call',namespace:'functions',name:'exec',input:'text(await tools.exec_command({cmd:"pwd\\ncat marker.txt\\nprintenv OPENCODEX_EXECUTOR_FIXTURE",max_output_tokens:500}));',status:'completed'};
     else if(step===2)item=call('mcp__fixture',scenario==='review-cancel'?'mac_fixture_hold':'mac_fs_read',scenario==='review-cancel'?{}:{path:path.join(macCwd,hookRewrite?'missing-before-hook.txt':'marker.txt')},input.tools);
     else if(scenario==='review-cancel'){res.on('close',()=>{report.reviewModelRequestClosed=true;});return;}
     else item=final(JSON.stringify({findings:[],overall_correctness:'patch is correct',overall_explanation:'Isolated tool fixture completed.',overall_confidence_score:1}));
    }else if(name==='/root'){
     if(step===1)item=call('mcp__fixture','mac_fs_read',{path:path.join(macCwd,'marker.txt')},input.tools);
     else if(step===2)item=call('collaboration','spawn_agent',{task_name:'branch',fork_turns:'none',message:'Isolated branch fixture.'},input.tools);
     else if(step===3)item=call('collaboration','spawn_agent',{task_name:'sibling',fork_turns:'none',message:'Isolated sibling fixture.'},input.tools);
     else if(scenario==='parent-complete'){await until(()=>manager.registry.records.size===4&&held.has('/root/branch'),'Missing active tree');item=final('PARENT-COMPLETED');}
     else if([...names].filter(([id,n])=>n!=='/root').length>=3&&[...names].filter(([id,n])=>n!=='/root').every(([id])=>completions.has(id)))item=final('ROOT-FIXTURE-DONE');
     else item=call('collaboration','wait_agent',{timeout_ms:10000},input.tools);
    }else if(name.endsWith('/branch')){
     if(step===1)item=call('collaboration','spawn_agent',{task_name:'grand',fork_turns:'none',message:'Isolated grandchild fixture.'},input.tools);
     else if(step===2)item=call('mcp__fixture',scenario==='normal'?'mac_fs_read':'mac_fixture_hold',scenario==='normal'?{path:path.join(macCwd,'marker.txt')}:{},input.tools);
     else if([...names].some(([id,n])=>n.endsWith('/grand')&&completions.has(id)))item=final('BRANCH-FIXTURE-DONE');
     else item=call('collaboration','wait_agent',{timeout_ms:10000},input.tools);
    }else if(step===1){if(scenario!=='normal')await until(()=>held.has('/root/branch'),'Branch hold missing');item=call('mcp__fixture',scenario==='normal'?'mac_fs_read':'mac_fixture_hold',scenario==='normal'?{path:path.join(macCwd,'marker.txt')}:{},input.tools);}
    else item=final('CHILD-FIXTURE-DONE');
    send(res,input,item);
   }catch(e){report.errors.push(e.stack);res.writeHead(500);res.end();}
  });
 });await listen(model);
 fs.writeFileSync(path.join(codexHome,'config.toml'),[
 'model="gpt-6.1-sol"','model_provider="fixture"','approval_policy="never"','sandbox_mode="read-only"',
 '[features]','multi_agent=true','multi_agent_v2=true','deferred_executor=true','skip_host_skill_discovery=true',
 '[mcp_servers.peer]','url="'+endpoint.url+'"','enabled=true','[mcp_servers.peer.http_headers]','Authorization="Bearer '+endpoint.token+'"',
 '[model_providers.fixture]','name="Isolated protocol fixture"','base_url="http://127.0.0.1:'+model.address().port+'/v1"','wire_api="responses"','env_key="OPENCODEX_FIXTURE_KEY"','request_max_retries=0','stream_max_retries=0','stream_idle_timeout_ms=20000'
 ].join('\n'));
 const env={PATH:process.env.PATH,HOME:temp,TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',CODEX_HOME:codexHome,CODEX_EXEC_SERVER_URL:'none',OPENCODEX_FIXTURE_KEY:'fixture-only'};
 executor=new LocalExecServer({codexExecutable:binary,version:'0.160.0'},()=>{});await executor.start(macCwd,{...env,OPENCODEX_EXECUTOR_FIXTURE:'MAC-EXECUTOR-'+report.at});
 child=spawn(binary,['app-server','--listen','stdio://'],{cwd:runtimeCwd,env,stdio:['pipe','pipe','pipe']});
 const transport=new EventEmitter();transport.write=s=>child.stdin.write(s);transport.close=()=>child.kill('SIGTERM');
 child.stdout.on('data',d=>transport.emit('data',d));child.stderr.on('data',d=>{report.stderr=(report.stderr||'').concat(d.toString()).slice(-8000);});
 child.on('error',e=>transport.emit('error',e));child.on('close',()=>transport.emit('close'));rpc=new AppServerRpc(transport);
 rpc.on('notification',m=>{if(hooksProbe&&/hook/i.test(m.method))(report.hookEvents||(report.hookEvents=[])).push(m);report.events.push({method:m.method,threadId:m.params?.threadId,turnId:m.params?.turn?.id});manager?.notification(m);if(m.method==='turn/completed')completions.set(m.params.threadId,m.params.turn);});
 rpc.on('request',m=>{report.errors.push('Unexpected server request '+m.method);rpc.reject(m.id,'Unexpected request in isolated fixture');});
 const initialized=await rpc.request('initialize',{clientInfo:{name:'opencodex-subagent-fixture',version:'0.4.7'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
 await executor.register(rpc,executor.localUrl);
 const config={'features.multi_agent':true,'features.multi_agent_v2':true,mcp_servers:{fixture:{url:endpoint.url,environment_id:executor.environmentId,http_headers:{Authorization:'Bearer '+endpoint.token},enabled:true,required:true},peer:{enabled:false}}};
 runtime={id:'fixture',snapshot:{runtimeVersion:'0.160.0',profileId:'fixture'},mcp:{name:'fixture'},executor,localCwd:macCwd,permissionMode:'project',requests:new Map(),toolHost:host,rpc,openCodexInitialized:initialized,openCodexChildThread:t=>{report.history=(report.history||[]).concat(t.id);}};
 if(hooksProbe){
  hooksRuntime=new NativeHooksRuntime({...hookOptions,runtime,onNotification:m=>(report.macHookEvents||(report.macHookEvents=[])).push(m),onError:e=>report.errors.push(e.message)});
  relay=await hooksRuntime.prepare();report.hooksNonce=[...hooksRuntime.pending][0].nonce;
  host.openCodexHooksRelay=observedHookRelay;Object.assign(config,relay.config);
 }
 const t=await rpc.request('thread/start',{cwd:macCwd,environments:[{environmentId:executor.environmentId,cwd:macCwd}],ephemeral:false,config,approvalPolicy:'never',sandbox:'read-only'},30000);
 if(relay)await relay.commit(t.thread.id);
 report.rootId=t.thread.id;report.inventory=await rpc.request('mcpServerStatus/list',{threadId:t.thread.id,limit:100},30000);
 assert.equal(report.inventory.data.find(s=>s.name==='peer').runtimeStatus,'disabled');assert.equal(report.inventory.data.find(s=>s.name==='fixture').runtimeStatus,'connected');
 const run={openCodex:true,nativeReview:isReview,requestId:crypto.randomUUID(),threadId:t.thread.id,cancelled:false,toolGate:new Promise(r=>releaseGate=r)};
 runtime.run=run;
 runtime.openCodexCloseRun=run=>hooksRuntime?.cancelRun(run);
 configureSubagents(runtime,{},config);
 manager=new NativeAgentRuns(runtime,{emit:(_,event)=>report.activity.push(event)},run,receiptFor(runtime,t.thread.id,config));runtime.openCodexSubagents=manager;

 const resolveRun=host.openCodexResolveRun;host.openCodexResolveRun=async(meta,signal)=>{console.log('ADMIT-START '+JSON.stringify(meta));try{const run=await resolveRun(meta,signal);console.log('ADMIT-DONE '+run.threadId);return run;}catch(e){const record=manager.registry.records.get(meta.threadId);const denied={threadId:meta.threadId,turnId:meta['x-codex-turn-metadata']?.turn_id,error:e.message};if(isReview)try{denied.snapshot=await rpc.request('thread/read',{threadId:meta.threadId,includeTurns:true},2000);}catch(readError){denied.snapshotError=readError.message;}if(scenario!=='normal'&&record?.run?.signal?.aborted&&record.run.turnId===denied.turnId&&['Subagent turn ended','Subagent turn cancelled','Subagent run is no longer active','Subagent turn is not active'].includes(e.message.replace(/^Local tool permission denied: /,''))){report.cancelledAdmissions=(report.cancelledAdmissions||[]).concat(denied);}else report.errors.push(denied);console.log('ADMISSION '+JSON.stringify(denied));throw e;}};
 const started=await rpc.request(isReview?'review/start':'turn/start',{threadId:t.thread.id,...(isReview?{delivery:'inline',target:{type:'custom',instructions:'Read the isolated Mac marker once, then return an empty structured review.'}}:{input:[{type:'text',text:'Isolated deterministic fixture.'}]}),environments:[{environmentId:executor.environmentId,cwd:macCwd}]},30000);
 run.turnId=started.turn.id;releaseGate(true);
 if(scenario==='review-cancel'){await until(()=>held.has('review'),'Review tool hold missing');await manager.cancel(run.threadId,run.turnId);assert(held.get('review').signal.aborted);report.reviewCancelled=true;}
 if(scenario==='cancel-root'||scenario==='cancel-child'){
  await until(()=>manager.registry.records.size===4&&['/root/branch','/root/branch/grand','/root/sibling'].every(n=>held.has(n)),'Expected active branch, grandchild and sibling');
  const branch=held.get('/root/branch'),grand=manager.registry.records.get([...names].find(([id,n])=>n==='/root/branch/grand')?.[0])?.run,sibling=manager.registry.records.get([...names].find(([id,n])=>n==='/root/sibling')?.[0])?.run;
  assert(branch&&grand&&sibling);report.concurrentWireCallsAtCancel=host.active.size;
  if(scenario==='cancel-root'){await manager.cancel(run.threadId,run.turnId);assert(branch.signal.aborted&&grand.signal.aborted&&sibling.signal.aborted);}
  else{
   await manager.cancel(branch.run.threadId,branch.run.turnId);assert(branch.signal.aborted&&grand.signal.aborted);assert(!sibling.signal.aborted);assert(manager.isActive(sibling));
   await until(()=>held.has('/root/sibling'),'Sibling did not resume after subtree cancellation');held.get('/root/sibling').release();report.siblingSurvived=true;
  }
 }
 await until(()=>completions.has(run.threadId),'Root completion missing',60000);
 if(!isReview)await until(()=>[...names].every(([id])=>completions.has(id)),'Child completion missing');
 assert.equal(completions.get(run.threadId).status,['cancel-root','review-cancel'].includes(scenario)?'interrupted':'completed');
 report.children=[];
 if(isReview){
  report.reviewCompletion=completions.get(run.threadId);
  report.reviewSnapshots=[];for(const id of names.keys())report.reviewSnapshots.push(await rpc.request('thread/read',{threadId:id,includeTurns:true},5000));
  const command=report.reviewSnapshots[0]?.thread.turns.at(-1)?.items.find(i=>i.type==='commandExecution');
  assert.equal(command?.exitCode,0);assert.equal(command?.cwd,macCwd);assert(command?.aggregatedOutput.includes('OPENCODEX-MAC-FIXTUREMAC-EXECUTOR-'+report.at));report.nativeShellOnMac=true;
  if(scenario==='review-cancel'){assert.equal(report.reviewSnapshots[0].thread.turns.at(-1).status,'interrupted');assert(report.requests.length<=3);if(report.requests.length===3)await until(()=>report.reviewModelRequestClosed,'Cancelled review kept its model request open');}
  await until(()=>host.active.size===0,'Review wire call remained active');
  assert.equal(report.errors.length,0);assert.equal(host.active.size,0);
  if(hookFailure){
   assert.equal(report.injectedHookFailure?.mode,hookFailure,'Failure was never injected');
   assert.equal(report.mcpCalls.length,0,'Failed Hook permitted the guarded Mac tool');
   assert(report.requests.some(r=>JSON.stringify(r.results).includes('Mac native Hooks relay did not complete')),'Model did not receive the native deny decision');
   const completed=(report.hookEvents||[]).filter(m=>m.method==='hook/completed');
   assert(completed.some(m=>m.params.run.eventName==='preToolUse'),'No native PreToolUse result');
   assert(!completed.some(m=>m.params.run.status==='failed'),'Engine ignored a failed Hook instead of applying deny');
   report.failedRelayBlocksTool=true;
  }else{assert.equal(report.mcpCalls.length,1);assert.equal(report.mcpCalls[0].threadId,run.threadId);verifyHooks();
   if(hookRewrite){assert(report.nativeHookInputs.some(i=>i.hook_event_name==='PreToolUse'&&i.tool_input?.path===path.join(macCwd,'missing-before-hook.txt')));assert(report.requests.some(r=>JSON.stringify(r.results).includes('OPENCODEX-MAC-FIXTURE')));report.hookRewroteInput=true;}
  }
  report.passed=true;return;
 }
 for(const [id,name]of names)if(id!==run.threadId){
  const snapshot=await rpc.request('thread/read',{threadId:id,includeTurns:true}),inventory=await rpc.request('mcpServerStatus/list',{threadId:id,limit:100},15000);
  manager.registry.environment(snapshot.thread);assert.equal(inventory.data.find(s=>s.name==='peer').runtimeStatus,'disabled');
  report.children.push({name,threadId:id,parentId:snapshot.thread.parentThreadId,environment:snapshot.thread.environments,turnStatus:snapshot.thread.turns.at(-1).status,peerStatus:'disabled'});
 }
 assert.equal(report.children.length,3);assert.equal(report.mcpCalls.filter(c=>c.name==='/root').length,1);if(scenario==='normal')assert.equal(report.mcpCalls.length,4);assert.equal(report.errors.length,0);
 if(scenario==='cancel-child')assert(report.children.filter(c=>c.name!=='/root/sibling').every(c=>c.turnStatus==='interrupted'));
 if(scenario==='parent-complete'||scenario==='cancel-root')assert(report.children.every(c=>c.turnStatus==='interrupted'));
 if(scenario==='normal')assert(report.children.every(c=>c.turnStatus==='completed'));
 assert.equal(host.active.size,0);assert.equal(runtime.requests.size,0);assert.equal(new Set(report.history).size,3);
 verifyHooks();report.passed=true;
}
main().catch(e=>{report.errors.push(e.stack);process.exitCode=1;}).finally(async()=>{
 releaseGate?.(false);manager?.close();
 const exited=child&&child.exitCode==null?new Promise(r=>child.once('close',r)):Promise.resolve();
 rpc?.close();executor?.stop();child?.kill('SIGTERM');await host?.stop();await hooksRuntime?.close();model?.closeAllConnections();if(model)await new Promise(r=>model.close(r));
 await Promise.race([exited,pause(3000)]);
 if(child&&child.exitCode==null&&child.signalCode==null){child.kill('SIGKILL');await exited;}
 try{if(temp&&fs.existsSync(path.join(temp,'owned-fixture')))await fs.promises.rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100});}
 catch(error){report.errors.push('Fixture cleanup failed: '+error.message);report.passed=false;process.exitCode=1;}
 fs.writeFileSync(path.join(root,'evidence/native-subagents-e2e-'+scenario+(hooksProbe?'-hooks':'')+(hookFailure?'-failure-'+hookFailure:'')+(hookRewrite?'-rewrite':'')+(process.env.OPENCODEX_FIXTURE_ENGINE?'-patched-engine':'')+'.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:report.passed,scenario,engine:report.engine,requests:report.requests.length,hookCount:report.hooks?.length,calls:report.mcpCalls,children:report.children,errors:report.errors}));
});
