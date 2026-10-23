'use strict';
// Real pinned engine, isolated HOME, local mock Responses/MCP; no product settings changed.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process'),{EventEmitter}=require('node:events'),{randomUUID}=require('node:crypto');
const {AppServerRpc}=require('../vendor/agentbridge/dist-main/app-server-rpc');
const {LocalExecServer}=require('../vendor/agentbridge/dist-main/local-exec-server');
const environmentScoped=process.argv.includes('--environment');
const root=path.resolve(__dirname,'..'),binary=path.join(root,'build/OpenCodex.app/Contents/Resources/agentbridge/codex/bin/codex');
const report={at:new Date().toISOString(),fixtureOnly:true,externalModel:false,productHooksEnabled:false,environmentScoped,checks:[],calls:[],events:[],modelRequests:[],errors:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await pause(20);}throw Error(label);}
function listen(s){return new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});}
function body(req,res,fn){let data='';req.on('data',d=>{data+=d;if(data.length>1024*1024)req.destroy();});req.on('end',()=>{Promise.resolve().then(()=>fn(JSON.parse(data||'{}'))).catch(e=>{report.errors.push(e.stack);if(!res.headersSent)res.writeHead(500);res.end();});});}
function json(res,id,result){if(res.writableEnded||res.destroyed)return;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id,result}));}
let temp,rpc,child,model,mcp,executor,activeEnvironment,mode='block',held,hiddenTools=false;
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
function hookHash(event,handler){return 'sha256:'+require('node:crypto').createHash('sha256').update(JSON.stringify(canonical({event_name:event,hooks:[handler]}))).digest('hex');}
const {relayConfig,NativeHooksBinding}=require('../src/native-hooks-relay.cjs');
const bindings=new Map();let helperOptions;
const completions=new Map();
function output(res,input){
 const item={id:'msg_'+randomUUID(),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'HOOK-FIXTURE-REPLY',annotations:[]}]};
 const response={id:'resp_'+randomUUID(),object:'response',created_at:Math.floor(Date.now()/1000),model:input.model,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
 res.writeHead(200,{'Content-Type':'text/event-stream'});let n=0;
 const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:n++,...data})+'\n\n');
 emit('response.created',{response:{...response,status:'in_progress',output:[]}});
 emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress'}});
 const part=item.content[0];
 emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
 emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:part.text});
 emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:part.text});
 emit('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part});
 emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response});res.end();
}
async function stopEngine(){executor?.stop();executor=null;activeEnvironment=null;rpc?.close();rpc=null;if(child){const c=child;child=null;c.kill('SIGTERM');await Promise.race([new Promise(r=>c.once('close',r)),pause(1500)]);}}
async function engine(home,workspace){
 await stopEngine();
 const env={PATH:process.env.PATH,HOME:temp,TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',CODEX_HOME:home,CODEX_EXEC_SERVER_URL:'none',OPENCODEX_HOOK_FIXTURE_KEY:'fixture-only'};
 if(environmentScoped){executor=new LocalExecServer({codexExecutable:binary,version:'0.160.0'},()=>{});await executor.start(workspace,env);}
 child=spawn(binary,['app-server','--listen','stdio://',...(environmentScoped?['-c','features.deferred_executor=true']:[])],{cwd:environmentScoped?home:workspace,env,stdio:['pipe','pipe','pipe']});
 const c=child,transport=new EventEmitter();transport.write=s=>c.stdin.write(s);transport.close=()=>c.kill('SIGTERM');
 c.stdout.on('data',d=>transport.emit('data',d));c.stderr.on('data',d=>{report.stderr=(report.stderr||'').concat(d.toString()).slice(-10000);});
 c.on('error',e=>transport.emit('error',e));c.on('close',()=>transport.emit('close'));rpc=new AppServerRpc(transport);
 rpc.on('notification',m=>{if(m.method.startsWith('hook/')||m.method==='turn/started'||m.method==='turn/completed'){report.events.push(m);if(m.method==='turn/completed')completions.set(m.params.turn.id,m.params.turn);}});
 rpc.on('request',m=>{report.errors.push('Unexpected request '+m.method);rpc.reject(m.id,'Unexpected fixture request');});
 await rpc.request('initialize',{clientInfo:{name:'opencodex-hook-probe',version:'1'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
 if(executor){await executor.register(rpc,executor.localUrl);activeEnvironment={environmentId:executor.environmentId,cwd:workspace};}
}
async function thread(workspace,config,ephemeral=true){
 if(activeEnvironment)config={...config,mcp_servers:{fixture:{url:'http://127.0.0.1:'+mcp.address().port+'/mcp',environment_id:activeEnvironment.environmentId,enabled:true,required:true,startup_timeout_sec:10,tool_timeout_sec:30}}};
 const t=await rpc.request('thread/start',{cwd:workspace,...(activeEnvironment?{environments:[activeEnvironment]}:{}),ephemeral,approvalPolicy:'never',sandbox:'read-only',...(config?{config}:{})});
 const inv=await rpc.request('mcpServerStatus/list',{threadId:t.thread.id,limit:100});
 assert.equal(inv.data.find(x=>x.name==='fixture')?.runtimeStatus,'connected');return t.thread.id;
}
async function turn(threadId,prompt){return rpc.request('turn/start',{threadId,input:[{type:'text',text:prompt}],...(activeEnvironment?{environments:[activeEnvironment]}:{})});}
async function main(){
 report.engine=execFileSync(binary,['--version'],{encoding:'utf8'}).trim();assert.equal(report.engine,'codex-cli 0.160.0');
 temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-hook-probe-')));fs.writeFileSync(path.join(temp,'owned-fixture'),'OpenCodex');
 const home=path.join(temp,'home'),workspace=path.join(temp,'workspace');fs.mkdirSync(home);fs.mkdirSync(workspace);
 mcp=http.createServer((req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);return res.end();}
  body(req,res,async m=>{
   if(m.id===undefined){res.writeHead(202);return res.end();}
   if(m.method==='initialize')return json(res,m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'opencodex-hook-fixture',version:'1'}});
   if(m.method==='tools/list')return json(res,m.id,{tools:hiddenTools?[]:[{name:'hook',description:'Isolated synchronous hook probe',inputSchema:{type:'object',additionalProperties:true}}]});
   if(m.method==='tools/call'){
    if(m.params.name==='opencodex_native_hook'){
     const args=m.params.arguments,id=m.params._meta?.threadId;
     assert.equal(args.sessionId,id);
     const snapshot=await rpc.request('thread/read',{threadId:id,includeTurns:true},3000);
     assert.equal(snapshot.thread.id,id);
     if(activeEnvironment)assert.deepEqual(snapshot.thread.environments,[{...activeEnvironment,runtimeWorkspaceRoots:[activeEnvironment.cwd]}]);
     (report.ownerReads??=[]).push({event:args.event,threadId:id,parent:snapshot.thread.parentThreadId,source:snapshot.thread.source,turns:snapshot.thread.turns.map(t=>({id:t.id,status:t.status})),environments:snapshot.thread.environments});
     let binding=bindings.get(id);
     if(!binding){
      assert(helperOptions,'Unexpected helper relay');
      binding=new NativeHooksBinding({...helperOptions,threadId:id});
      bindings.set(id,binding);
     }
     report.calls.push({mode:'native-helper',event:args.event,source:args.source,threadId:id,turnId:args.turnId});
     try{
      const result=await binding.invoke(args,m.params._meta);
      return json(res,m.id,{content:[{type:'text',text:JSON.stringify(result)}]});
     }catch(error){
      return json(res,m.id,{content:[{type:'text',text:JSON.stringify({continue:false,stopReason:error.message})}]});
     }
    }
    assert.equal(m.params.name,'hook');
    const call={mode,arguments:m.params.arguments,metadata:m.params._meta,modelCountAtCall:report.modelRequests.length,closed:false};report.calls.push(call);
    const answer=()=>json(res,m.id,{content:[{type:'text',text:JSON.stringify(mode==='context'?{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'HOOK-FIXTURE-CONTEXT'}}:{decision:'block',reason:'HOOK-FIXTURE-BLOCK'})}]});
    res.on('close',()=>{call.closed=true;});
    if(mode==='hold'){held={call,release:answer};return;}
    answer();return;
   }
   json(res,m.id,{});
  });
 });await listen(mcp);
 model=http.createServer((req,res)=>{
  if(req.method!=='POST'||!req.url.startsWith('/v1/responses')){res.writeHead(404);return res.end();}
  body(req,res,input=>{report.modelRequests.push({metadata:JSON.parse(req.headers['x-codex-turn-metadata']||'{}'),hasHookContext:JSON.stringify(input).includes('HOOK-FIXTURE-CONTEXT')});output(res,input);});
 });await listen(model);
 const config=[
 'model="gpt-6.1-sol"','model_provider="fixture"','approval_policy="never"','sandbox_mode="read-only"',
 '[features]','hooks=true','skip_host_skill_discovery=true',
 '[mcp_servers.fixture]','url="http://127.0.0.1:'+mcp.address().port+'/mcp"','required=true','startup_timeout_sec=10','tool_timeout_sec=10',
 '[model_providers.fixture]','name="Isolated hook fixture"','base_url="http://127.0.0.1:'+model.address().port+'/v1"','wire_api="responses"','env_key="OPENCODEX_HOOK_FIXTURE_KEY"','request_max_retries=0','stream_max_retries=0','stream_idle_timeout_ms=10000'
 ].join('\n');
 const configPath=path.join(home,'config.toml'),hooksPath=path.join(home,'hooks.json');
 fs.writeFileSync(configPath,config);
 fs.writeFileSync(hooksPath,JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[{type:'mcp_tool',server:'fixture',tool:'hook',timeout:10,input:{session_id:'${session_id}',turn_id:'${turn_id}',cwd:'${cwd}',hook_event_name:'${hook_event_name}',prompt:'${prompt}'}}]}]}}));
 await engine(home,workspace);
 const listing=await rpc.request('hooks/list',{cwds:[workspace]});report.initialListing=listing;
 const hook=listing.data.flatMap(e=>e.hooks).find(h=>h.sourcePath===hooksPath&&h.tool==='hook');
 assert(hook,'Own MCP hook missing from real engine listing');report.checks.push('Native 0.160 discovers MCP UserPromptSubmit hook');
 let id=await thread(workspace);
 if(hook.trustStatus!=='trusted'){
  const t=await turn(id,'UNTRUSTED-HOOK-FIXTURE');await until(()=>completions.has(t.turn.id),'Untrusted turn did not complete');
  assert.equal(report.calls.length,0);assert.equal(report.modelRequests.length,1);report.checks.push('Untrusted hook does not execute');
 }
 fs.writeFileSync(configPath,config+'\n[hooks.state.'+JSON.stringify(hook.key)+']\nenabled=true\ntrusted_hash='+JSON.stringify(hook.currentHash)+'\n');
 await engine(home,workspace);
 report.trustedListing=await rpc.request('hooks/list',{cwds:[workspace]});
 const trusted=report.trustedListing.data.flatMap(e=>e.hooks).find(h=>h.key===hook.key);assert.equal(trusted.trustStatus,'trusted');
 id=await thread(workspace);
 const before=report.modelRequests.length;
 const blocked=await turn(id,'BLOCK-HOOK-FIXTURE');await until(()=>completions.has(blocked.turn.id),'Blocked turn did not complete');
 const blockedCall=report.calls.at(-1);assert(blockedCall);
 assert.equal(blockedCall.arguments.session_id,id);assert.equal(blockedCall.arguments.turn_id,blocked.turn.id);
 assert.equal(blockedCall.arguments.cwd,workspace);assert.equal(blockedCall.metadata.threadId,id);
 assert.equal(report.modelRequests.length,before);report.blockedTurn=completions.get(blocked.turn.id);
 report.checks.push('Synchronous block prevents model request and uses native thread/turn IDs');
 mode='context';const contextual=await turn(id,'CONTEXT-HOOK-FIXTURE');await until(()=>completions.has(contextual.turn.id),'Context turn did not complete');
 assert.equal(report.modelRequests.length,before+1);assert.equal(report.modelRequests.at(-1).hasHookContext,true);
 report.checks.push('Native engine injects hook context into model request');
 mode='hold';held=null;
 const heldStart=turn(id,'HOLD-HOOK-FIXTURE');let startResolved=false;heldStart.then(()=>{startResolved=true;});
 await until(()=>held,'Held hook missing');await pause(200);assert.equal(report.modelRequests.length,before+1);
 report.turnStartResolvedWhileHookPending=startResolved;
 const started=await heldStart;assert.equal(held.call.arguments.turn_id,started.turn.id);
 await rpc.request('turn/interrupt',{threadId:id,turnId:started.turn.id});
 await until(()=>completions.has(started.turn.id),'Interrupted hook turn did not complete');
 report.interruptedTurn=completions.get(started.turn.id);assert.equal(report.interruptedTurn.status,'interrupted');
 report.hookTransportClosedAtInterrupt=held.call.closed;
 held.release();await pause(250);assert.equal(report.modelRequests.length,before+1);
 report.checks.push('Interrupt completes held hook turn without model inference');
 // The product cannot trust arbitrary user hooks or mutate the remote account config.
 // Only its generated bridge transport receives a per-thread trust entry.
 const handler=JSON.parse(fs.readFileSync(hooksPath,'utf8')).hooks.UserPromptSubmit[0].hooks[0];
 assert.equal(hookHash('user_prompt_submit',handler),hook.currentHash);
 report.checks.push('Generated trust hash agrees with pinned native engine');
 hiddenTools=true;mode='block';
 await engine(home,workspace);
 const scopedHandler={...handler,input:{...handler.input,relayNonce:randomUUID()}};
 const sessionKey='/<session-flags>/config.toml:user_prompt_submit:0:0';
 const scopedConfig={hooks:{UserPromptSubmit:[{hooks:[scopedHandler]}],state:{[hook.key]:{enabled:false},[sessionKey]:{enabled:true,trusted_hash:hookHash('user_prompt_submit',scopedHandler)}}}};
 const scopedThread=await thread(workspace,scopedConfig);
 const priorCalls=report.calls.length,priorModels=report.modelRequests.length;
 const scopedTurn=await turn(scopedThread,'SCOPED-HIDDEN-HOOK-FIXTURE');
 await until(()=>completions.has(scopedTurn.turn.id),'Scoped hook turn did not complete');
 assert.equal(report.calls.length,priorCalls+1,'Exactly the per-thread relay should run');
 assert.equal(report.calls.at(-1).arguments.relayNonce,scopedHandler.input.relayNonce);
 assert.equal(report.calls.at(-1).metadata.threadId,scopedThread);
 assert.equal(report.modelRequests.length,priorModels,'Scoped hook must block before inference');
 report.checks.push('Per-thread trusted relay executes while remote user hook is disabled');
 const inv=await rpc.request('mcpServerStatus/list',{threadId:scopedThread,limit:100});
 assert.deepEqual(inv.data.find(x=>x.name==='fixture').tools,{});
 report.checks.push('Native hooks call hidden relay without exposing it in model tool inventory');
 const unchanged=await rpc.request('hooks/list',{cwds:[workspace]});
 assert.equal(unchanged.data.flatMap(x=>x.hooks).find(x=>x.key===hook.key).enabled,true);
 report.checks.push('Per-thread isolation leaves account hook configuration unchanged');
 // The same real engine now calls the native Mac helper instead of a canned hook.
 const helperHome=path.join(temp,'mac-home');fs.mkdirSync(helperHome);
 const fixture=path.join(temp,'mac-hook.cjs'),commandLog=path.join(temp,'mac-hooks.jsonl'),pidsPath=path.join(temp,'mac-hook-pids.json');
 fs.writeFileSync(fixture,[
 "const fs=require('node:fs'),{spawn}=require('node:child_process');",
 "const [log,pids]=process.argv.slice(2),p=JSON.parse(fs.readFileSync(0,'utf8'));",
 "fs.appendFileSync(log,JSON.stringify(p)+'\\n');",
 "if(p.prompt==='SLOW-HELPER'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(pids,JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);}",
 "else process.stdout.write(JSON.stringify(p.prompt==='BLOCK-HELPER'?{decision:'block',reason:'REAL-MAC-BLOCK'}:p.prompt==='CONTEXT-HELPER'?{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'HOOK-FIXTURE-CONTEXT'}}:{}));"
 ].join('\n'));
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 const command=[process.execPath,fixture,commandLog,pidsPath].map(quote).join(' ');
 const localHooks={hooks:{UserPromptSubmit:[{hooks:[{type:'command',command,timeout:30}]}],SessionStart:[{hooks:[{type:'command',command,timeout:30}]}],Stop:[{hooks:[{type:'command',command,timeout:30}]}]}};
 const helperConfig=path.join(helperHome,'config.toml'),helperHooks=path.join(helperHome,'hooks.json');
 fs.writeFileSync(helperConfig,'[features]\nhooks=true\n');fs.writeFileSync(helperHooks,JSON.stringify(localHooks));
 const generated=relayConfig({server:'fixture',events:['UserPromptSubmit','SessionStart','Stop'],remoteHooks:[trusted]});
 helperOptions={binary:process.env.OPENCODEX_HOOKS_HELPER||path.join(root,'build/hooks-target/debug/opencodex-hooks-helper'),cwd:workspace,codexHome:helperHome,nonce:generated.nonce,events:generated.events,
  env:{PATH:process.env.PATH,HOME:temp,CODEX_HOME:helperHome,TMPDIR:temp,LANG:'en_US.UTF-8',ELECTRON_RUN_AS_NODE:'1'}};
 const realThread=await thread(workspace,generated.config,false);
 let modelCount=report.modelRequests.length;
 const untrustedTurn=await turn(realThread,'BLOCK-HELPER');await until(()=>completions.has(untrustedTurn.turn.id),'Untrusted helper turn');
 assert.equal(report.modelRequests.length,modelCount+1);assert.equal(fs.existsSync(commandLog),false);
 const binding=bindings.get(realThread);assert(binding);const inventory=await binding.ready;
 assert.equal(inventory.hooks.length,3);
 report.checks.push('Real engine-to-Mac relay preserves untrusted local hook skip');
 fs.writeFileSync(helperConfig,'[features]\nhooks=true\n'+inventory.hooks.map(h=>'\n[hooks.state.'+JSON.stringify(h.key)+']\nenabled=true\ntrusted_hash='+JSON.stringify(h.currentHash)+'\n').join(''));
 await binding.client.reload();modelCount=report.modelRequests.length;
 const realBlocked=await turn(realThread,'BLOCK-HELPER');await until(()=>completions.has(realBlocked.turn.id),'Native command block');
 assert.equal(report.modelRequests.length,modelCount);
 const callInput=fs.readFileSync(commandLog,'utf8').trim().split('\n').map(JSON.parse).find(x=>x.prompt==='BLOCK-HELPER');
 assert.equal(callInput.session_id,realThread);assert.equal(callInput.turn_id,realBlocked.turn.id);assert.equal(callInput.cwd,workspace);assert.equal(callInput.transcript_path,null);
 report.checks.push('Native Mac command blocks real engine inference with exact thread/turn/workspace');
 const realContext=await turn(realThread,'CONTEXT-HELPER');await until(()=>completions.has(realContext.turn.id),'Native command context');
 assert.equal(report.modelRequests.length,modelCount+1);assert.equal(report.modelRequests.at(-1).hasHookContext,true);
 assert(fs.readFileSync(commandLog,'utf8').includes('"hook_event_name":"Stop"'));
 report.checks.push('Native context reaches model and Stop command executes after response');
 const slow=await turn(realThread,'SLOW-HELPER');await until(()=>fs.existsSync(pidsPath),'Native command process group');
 const ownedPids=JSON.parse(fs.readFileSync(pidsPath,'utf8'));
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
 assert(ownedPids.every(alive));
 // Native turn/interrupt does not cancel the held MCP HTTP request by itself.
 await binding.cancel(slow.turn.id);await rpc.request('turn/interrupt',{threadId:realThread,turnId:slow.turn.id});
 await until(()=>completions.has(slow.turn.id),'Native helper cancelled turn');
 await until(()=>ownedPids.every(pid=>!alive(pid)),'Native helper command descendants cleanup');
 assert.equal(report.modelRequests.length,modelCount+1);
 report.checks.push('Scoped relay cancellation removes Mac command and descendants before another turn');
 const recovery=await turn(realThread,'BLOCK-HELPER');await until(()=>completions.has(recovery.turn.id),'Native helper recovery');
 assert.equal(report.modelRequests.length,modelCount+1);
 localHooks.hooks.UserPromptSubmit[0].hooks[0].command+=' # changed';
 fs.writeFileSync(helperHooks,JSON.stringify(localHooks));const changed=await binding.client.reload();
 assert.equal(changed.hooks.find(h=>h.key.endsWith(':user_prompt_submit:0:0')).trustStatus,'modified');
 const changedTurn=await turn(realThread,'BLOCK-HELPER');await until(()=>completions.has(changedTurn.turn.id),'Modified local hook turn');
 assert.equal(report.modelRequests.length,modelCount+2);
 report.checks.push('Changed local command remains untrusted through remote relay; next turn recovers');
 report.sessionStartRelayCalls=report.calls.filter(c=>c.mode==='native-helper'&&c.event==='SessionStart').length;
 assert(report.sessionStartRelayCalls>0,'Native SessionStart relay missing');
 report.checks.push('SessionStart relay executes during actual thread initialization without deadlock');
 report.checks.push('Thread ownership and Mac environment readable during all relay events');
 // Resume follows the product's dormant-MCP path: the protocol does not accept
 // environments until turn/start. SessionStart must wait for that selected Mac.
 await Promise.all([...bindings.values()].map(b=>b.close()));bindings.clear();
 localHooks.hooks.UserPromptSubmit[0].hooks[0].command=command;
 fs.writeFileSync(helperHooks,JSON.stringify(localHooks));
 await engine(home,workspace);
 const resumeConfig=activeEnvironment?{...generated.config,mcp_servers:{fixture:{url:'http://127.0.0.1:'+mcp.address().port+'/mcp',environment_id:activeEnvironment.environmentId,enabled:true,required:true,startup_timeout_sec:10,tool_timeout_sec:30}}}:generated.config;
 const resumeStart=report.calls.length;
 const resumed=await rpc.request('thread/resume',{threadId:realThread,config:resumeConfig,approvalPolicy:'never',sandbox:'read-only'});
 report.resumedEnvironments=resumed.thread.environments;
 const resumeInventory=await rpc.request('mcpServerStatus/list',{threadId:realThread,limit:100});
 report.resumedMcpStatus=resumeInventory.data.find(x=>x.name==='fixture').runtimeStatus;
 if(activeEnvironment){assert.deepEqual(resumed.thread.environments,[]);assert.equal(report.resumedMcpStatus,'disabled');}
 assert.equal(report.calls.length,resumeStart,'Hooks must not execute during an unselected dormant resume');
 modelCount=report.modelRequests.length;
 const resumedTurn=await turn(realThread,'BLOCK-HELPER');
 await until(()=>completions.has(resumedTurn.turn.id),'Resumed native hook block');
 assert.equal(report.modelRequests.length,modelCount);
 const resumedCalls=report.calls.slice(resumeStart);
 assert(resumedCalls.some(c=>c.event==='SessionStart'&&c.source==='resume'));
 assert(resumedCalls.some(c=>c.event==='UserPromptSubmit'&&c.turnId===resumedTurn.turn.id));
 const resumedLog=fs.readFileSync(commandLog,'utf8').trim().split('\n').map(JSON.parse);
 assert(resumedLog.some(c=>c.hook_event_name==='SessionStart'&&c.source==='resume'&&c.session_id===realThread&&c.cwd===workspace));
 report.checks.push('Resume defers SessionStart until Mac selection, then runs trusted command and blocks inference');
 report.passed=true;
}
main().catch(e=>{report.errors.push(e.stack);process.exitCode=1;}).finally(async()=>{
 held?.release();await stopEngine();
 await Promise.allSettled([...bindings.values()].map(b=>b.close()));
 for(const s of [model,mcp])if(s){s.closeAllConnections();await new Promise(r=>s.close(r));}
 if(temp&&fs.existsSync(path.join(temp,'owned-fixture'))&&fs.readFileSync(path.join(temp,'owned-fixture'),'utf8')==='OpenCodex')fs.rmSync(temp,{recursive:true,force:true});
 fs.writeFileSync(path.join(root,'evidence/native-hooks-relay-probe'+(environmentScoped?'-environment':'')+'.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:report.passed,environmentScoped,checks:report.checks,turnStartResolvedWhileHookPending:report.turnStartResolvedWhileHookPending,hookTransportClosedAtInterrupt:report.hookTransportClosedAtInterrupt,errors:report.errors}));
});
