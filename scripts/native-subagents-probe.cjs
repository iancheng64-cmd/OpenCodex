'use strict';
// Isolated engine protocol fixture. No user credentials, external model or installed App changes.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn,execFileSync}=require('node:child_process'),EventEmitter=require('node:events'),crypto=require('node:crypto');
const {AppServerRpc}=require('../vendor/agentbridge/dist-main/app-server-rpc');
const {LocalExecServer}=require('../vendor/agentbridge/dist-main/local-exec-server');
const root=path.resolve(__dirname,'..'),binary=path.join(root,'build/OpenCodex.app/Contents/Resources/agentbridge/codex/bin/codex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const scenario=process.argv.includes('--cancel-root')?'cancel-root':'metadata';
const report={at:new Date().toISOString(),scenario,fixtureOnly:true,externalModel:false,events:[],requests:[],mcpCalls:[],mcpNotifications:[],serverRequests:[],errors:[]};
let rpc,executor,child,model,mcp,temp,pendingToolResponse;
let resolveToolStarted;const toolStarted=new Promise(resolve=>resolveToolStarted=resolve);
const completions=new Map(),modelSteps=new Map();
function call(namespace,name,args,tools){
 const space=tools.find(t=>t.type==='namespace'&&t.name===namespace);
 if(!space?.tools?.some(t=>t.name===name))throw Error('Missing advertised fixture tool '+namespace+'.'+name);
 return {id:'fc_'+crypto.randomUUID(),call_id:'call_'+crypto.randomUUID(),type:'function_call',namespace,name,arguments:JSON.stringify(args),status:'completed'};
}
function send(res,input,item){
 const response={id:'resp_'+crypto.randomUUID(),object:'response',created_at:Math.floor(Date.now()/1000),model:input.model,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
 let seq=0;const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:seq++,...data})+'\n\n');
 emit('response.created',{response:{...response,status:'in_progress',output:[]}});
 emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress'}});
 if(item.type==='function_call')emit('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:item.arguments});
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
 report.version=execFileSync(binary,['--version'],{encoding:'utf8'}).trim();
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-subagent-probe-'));
 const codexHome=path.join(temp,'home'),runtimeCwd=path.join(temp,'runtime'),macCwd=path.join(temp,'mac');
 for(const d of [codexHome,runtimeCwd,macCwd])fs.mkdirSync(d);
 fs.writeFileSync(path.join(temp,'owned-probe-marker'),'OpenCodex engine fixture');
 const token=crypto.randomBytes(24).toString('hex');
 mcp=http.createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);return res.end();}
  if(req.method!=='POST'){res.writeHead(405);return res.end();}
  readBody(req,async msg=>{
   let result;
   if(msg.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'isolated-mac-fixture',version:'1'}};
   else if(msg.method==='tools/list')result={tools:[{name:'mac_fs_read',description:'Return the isolated fixture marker; no filesystem access.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
   else if(msg.method==='tools/call'){
    const entry={name:msg.params.name,meta:msg.params._meta||null};report.mcpCalls.push(entry);
    resolveToolStarted(entry);
    if(scenario==='cancel-root'){
     pendingToolResponse={res,msg};
     res.on('close',()=>entry.responseClosedAt=new Date().toISOString());
     return;
    }
    const id=entry.meta?.threadId;entry.inFlightChecks={};
    await Promise.all(['thread/read','mcpServerStatus/list'].map(async method=>{
     const started=Date.now();try{const value=await rpc.request(method,{threadId:id,...(method==='thread/read'?{includeTurns:false}:{limit:100})},2000);entry.inFlightChecks[method]={ok:true,ms:Date.now()-started,value};}
     catch(e){entry.inFlightChecks[method]={ok:false,ms:Date.now()-started,error:e.message};}
    }));
    result={content:[{type:'text',text:'OPENCODEX-CHILD-FIXTURE'}]};
   }
   else if(msg.id===undefined){report.mcpNotifications.push(msg);res.writeHead(202);return res.end();}
   else result={};
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}));
  });
 });
 model=http.createServer((req,res)=>{
  if(req.method!=='POST'||!req.url.startsWith('/v1/responses')){res.writeHead(404);return res.end();}
  readBody(req,input=>{
   if(report.requests.length>20){res.writeHead(429);res.end();return;}
   const metadata=JSON.parse(req.headers['x-codex-turn-metadata']||'{}');
   report.requests.push({metadata,tools:input.tools,input:input.input});
   const step=(modelSteps.get(metadata.thread_id)||0)+1;modelSteps.set(metadata.thread_id,step);
   let item;
   if(metadata.agent_name==='/root'&&step===1)item=call('collaboration','spawn_agent',{task_name:'fixture_child',fork_turns:'none',message:'Call the isolated mac_fs_read fixture once, then return the fixture marker. No other work.'},input.tools);
   else if(metadata.agent_name==='/root'&&step===2)item=call('collaboration','wait_agent',{timeout_ms:10000},input.tools);
   else if(metadata.agent_name!=='/root'&&step===1)item=call('mcp__fixture','mac_fs_read',{},input.tools);
   else item=final('OPENCODEX-PROTOCOL-FIXTURE-DONE');
   send(res,input,item);
  });
 });
 await listen(mcp);await listen(model);
 fs.writeFileSync(path.join(codexHome,'config.toml'),[
 'model="gpt-5.4"','model_provider="fixture"','approval_policy="never"','sandbox_mode="read-only"',
 '[features]','multi_agent=true','multi_agent_v2=true','deferred_executor=true','skip_host_skill_discovery=true',
 '[model_providers.fixture]','name="Isolated protocol fixture"','base_url="http://127.0.0.1:'+model.address().port+'/v1"','wire_api="responses"','env_key="OPENCODEX_FIXTURE_KEY"','request_max_retries=0','stream_max_retries=0','stream_idle_timeout_ms=15000'
 ].join('\n'));
 // Deliberate allowlist; no inherited login/API credentials.
 const env={PATH:process.env.PATH,HOME:temp,TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',CODEX_HOME:codexHome,CODEX_EXEC_SERVER_URL:'none',OPENCODEX_FIXTURE_KEY:'fixture-only'};
 executor=new LocalExecServer({codexExecutable:binary,version:'0.160.0'},()=>{});
 await executor.start(macCwd,env);
 child=spawn(binary,['app-server','--listen','stdio://'],{cwd:runtimeCwd,env,stdio:['pipe','pipe','pipe']});
 const transport=new EventEmitter();transport.write=s=>child.stdin.write(s);transport.close=()=>child.kill('SIGTERM');
 child.stdout.on('data',d=>transport.emit('data',d));child.stderr.on('data',d=>{report.stderr=(report.stderr||'').concat(d.toString()).slice(-12000);});
 child.on('error',e=>transport.emit('error',e));child.on('close',()=>transport.emit('close'));
 rpc=new AppServerRpc(transport);
 rpc.on('notification',m=>{report.events.push(m);if(m.method==='turn/completed')completions.set(m.params.threadId,m.params.turn);});
 rpc.on('request',m=>{report.serverRequests.push(m);rpc.reject(m.id,'Unexpected request in isolated fixture');});
 await rpc.request('initialize',{clientInfo:{name:'opencodex-protocol-fixture',version:'0.4.3'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
 report.environment=await executor.register(rpc,executor.localUrl);
 const config={mcp_servers:{fixture:{url:'http://127.0.0.1:'+mcp.address().port,environment_id:executor.environmentId,http_headers:{Authorization:'Bearer '+token},enabled:true,required:true}}};
 const t=await rpc.request('thread/start',{cwd:macCwd,environments:[{environmentId:executor.environmentId,cwd:macCwd}],ephemeral:false,config,approvalPolicy:'never',sandbox:'read-only'},30000);
 report.parent=t.thread;
 report.inventory=await rpc.request('mcpServerStatus/list',{threadId:t.thread.id,limit:100},30000);
 const started=await rpc.request('turn/start',{threadId:t.thread.id,input:[{type:'text',text:'Isolated deterministic engine fixture. No external work.'}],environments:[{environmentId:executor.environmentId,cwd:macCwd}]},30000);
 report.turnId=started.turn.id;
 if(scenario==='cancel-root'){
  const active=await Promise.race([toolStarted,pause(15000).then(()=>{throw Error('Child fixture tool did not start');})]);
  report.rootInterrupt=await rpc.request('turn/interrupt',{threadId:t.thread.id,turnId:started.turn.id},5000);
  await pause(1000);
  report.childAfterRootInterrupt=await rpc.request('thread/read',{threadId:active.meta.threadId,includeTurns:true},5000);
  report.completedAfterRootInterrupt=[...completions].map(([threadId,turn])=>({threadId,turnId:turn.id,status:turn.status}));
  report.mcpCancellationObservedBeforeCleanup=report.mcpNotifications.some(n=>n.method==='notifications/cancelled');
  report.toolResponseClosedBeforeCleanup=!!active.responseClosedAt;
  const childTurn=report.childAfterRootInterrupt.thread.turns.at(-1);
  if(childTurn?.status==='inProgress')report.cleanupChildInterrupt=await rpc.request('turn/interrupt',{threadId:active.meta.threadId,turnId:childTurn.id},5000);
  if(pendingToolResponse&&!pendingToolResponse.res.destroyed){
   const {res,msg}=pendingToolResponse;res.writeHead(200,{'Content-Type':'application/json'});
   res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{isError:true,content:[{type:'text',text:'Cancelled isolated fixture; no work executed.'}]}}));
  }
 }
 for(let n=0;n<600&&!completions.has(t.thread.id);n++)await pause(100);
 if(!completions.has(t.thread.id))throw Error('Fixture parent turn did not complete in 60 seconds');
 report.completion=completions.get(t.thread.id);
 report.children=[];
 for(const id of [...modelSteps.keys()].filter(id=>id!==t.thread.id)){
  const snapshot=await rpc.request('thread/read',{threadId:id,includeTurns:true});
  const inventory=await rpc.request('mcpServerStatus/list',{threadId:id,limit:100},15000);
  report.children.push({snapshot,inventory});
 }
 report.probeCompleted=report.completion.status===(scenario==='cancel-root'?'interrupted':'completed')&&report.children.length===1&&report.mcpCalls.length===1;
 if(!report.probeCompleted)throw Error('Unexpected fixture completion; inspect evidence');
}
main().catch(e=>{report.errors.push(e.stack);process.exitCode=1;}).finally(async()=>{
 rpc?.close();executor?.stop();child?.kill('SIGTERM');model?.closeAllConnections();mcp?.closeAllConnections();
 await Promise.all([model&&new Promise(r=>model.close(r)),mcp&&new Promise(r=>mcp.close(r))]);
 if(temp&&fs.existsSync(path.join(temp,'owned-probe-marker')))fs.rmSync(temp,{recursive:true,force:true});
 fs.writeFileSync(path.join(root,'evidence/native-subagents-probe'+(scenario==='metadata'?'':'-'+scenario)+'.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({version:report.version,completed:report.probeCompleted,requests:report.requests.length,mcpCalls:report.mcpCalls,errors:report.errors,eventMethods:[...new Set(report.events.map(e=>e.method))],children:report.children?.map(c=>({id:c.snapshot.thread.id,parent:c.snapshot.thread.parentThreadId,source:c.snapshot.thread.source,environments:c.snapshot.thread.environments,turns:c.snapshot.thread.turns?.map(t=>({id:t.id,status:t.status}))}))}));
});
