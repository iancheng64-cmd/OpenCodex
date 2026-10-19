'use strict';
const {randomUUID}=require('node:crypto');
const {NativeSubagents}=require('./native-subagents.cjs');
const {withRun,scopedRun,turnMetadata}=require('./native-run-context.cjs');
// Enabled only for the tested 0.160 v2 protocol. A receipt records root checks;
// child authorization is based on config inheritance plus live thread/read.
const verifiedConfigs=new WeakSet();
function configureSubagents(runtime,base,config){
 // V2 also applies agents.default.config_file to fresh children. Such remote
 // role layers may replace the isolated MCP map before any Mac request arrives.
 const agents=base?.agents;
 const rolesSafe=agents==null||(typeof agents==='object'&&!Array.isArray(agents)&&Object.values(agents).every(role=>!role||typeof role!=='object'||!role.config_file));
 const enabled=runtime.snapshot.runtimeVersion==='0.160.0'&&rolesSafe;
 config['features.multi_agent']=enabled;config['features.multi_agent_v2']=enabled;
 if(enabled)verifiedConfigs.add(config);
 return enabled;
}
function receiptFor(runtime,threadId,config){
 if(runtime.snapshot.runtimeVersion!=='0.160.0'||config['features.multi_agent']!==true||config['features.multi_agent_v2']!==true)return null;
 if(!verifiedConfigs.has(config))throw Error('Subagent role configuration was not verified');
 if(config.mcp_servers?.[runtime.mcp.name]?.environment_id!==runtime.executor.environmentId)throw Error('Unbound Mac MCP configuration');
 for(const [name,value]of Object.entries(config.mcp_servers||{}))if(name!==runtime.mcp.name&&value.enabled!==false)throw Error('Peer MCP configuration is enabled');
 return Object.freeze({version:'0.160.0',rootThreadId:threadId,inventoryVerified:true,v2ConfigVerified:true});
}
class NativeAgentRuns{
 constructor(runtime,deps,run,receipt){
  if(!receipt||receipt.rootThreadId!==run.threadId)throw Error('Missing verified root configuration');
  Object.assign(this,{runtime,deps,root:run,receipt});this.pending=new Map();this.discovering=new Map();this.ended=new Set();this.closed=false;this.stopRoot=false;
  this.registry=new NativeSubagents({runtimeId:runtime.id,profileId:runtime.snapshot.profileId,environmentId:runtime.executor.environmentId,cwd:runtime.localCwd,mcpName:runtime.mcp.name,owner:runtime.toolHost,approvalPolicy:runtime.permissionMode==='full'?'never':'untrusted',sandbox:{type:runtime.permissionMode==='full'?'dangerFullAccess':'readOnly'},workspaceRoots:[runtime.localCwd]});
  const host=runtime.toolHost;
  host.openCodexCurrentRun=()=>scopedRun(runtime);
  host.openCodexResolveRun=async(meta,signal)=>{
   try{return await this.resolve(meta,signal);}
   catch(error){
    // Only constant ownership errors may reach tool output; RPC errors can
    // contain remote paths or configuration and keep the host's generic error.
    const known=/^(Unverified review owner|Review turn ended|Review identity changed|Unverified review transcript|Invalid bound root|Subagent must select exactly one Mac environment|Subagent environment differs from its Mac owner|Missing tool turn metadata|Malformed tool turn metadata|Conflicting tool thread metadata|Conflicting tool session metadata|Invalid tool turn metadata|Tool belongs to another session|Wrong root turn|Root turn ended|Subagent turn ended|Tool turn is no longer active|Tool parent differs from its owner)$/;
    if(known.test(error.message))throw Error('Local tool permission denied: '+error.message);
    throw error;
   }
  };
  host.openCodexWithRun=(active,work)=>withRun(runtime,active,work);
 }
 current(){return !this.closed&&!this.stopRoot&&!this.runtime.closed&&!this.root.cancelled&&this.runtime.run===this.root;}
 isActive(run){const record=this.registry.records.get(run?.threadId);return this.current()&&record?.run===run&&this.registry.live(record)&&record.admitted&&record.phase==='active';}
 emit(run,event){this.deps.emit('runtime:event',{runtimeId:this.runtime.id,requestId:run.requestId,threadId:run.threadId,turnId:run.turnId,...event});}
 async ensure(threadId,turnId,ancestors=new Set()){
  if(ancestors.has(threadId)||ancestors.size>16)throw Error('Invalid subagent ancestry');
  if(!this.current()||this.ended.has(threadId+':'+turnId))throw Error('Subagent turn ended');
  const existing=this.registry.records.get(threadId);
  if(existing?.run?.turnId===turnId&&this.isActive(existing.run))return existing.run;
  const key=threadId+':'+turnId;
  if(this.pending.has(key))return this.pending.get(key);
  const work=this.admit(threadId,turnId,new Set([...ancestors,threadId]));
  this.pending.set(key,work);
  try{return await work;}finally{if(this.pending.get(key)===work)this.pending.delete(key);}
 }
 async admit(threadId,turnId,ancestors){
  if(!(await this.root.toolGate)||!this.current())throw Error('Root turn ended');
  if(!this.registry.records.has(this.root.threadId)){
   if(!this.initializing)this.initializing=(async()=>{
    const {thread}=await this.runtime.rpc.request('thread/read',{threadId:this.root.threadId,includeTurns:false},10000);
    if(!this.current())throw Error('Root turn ended');
    this.registry.registerConfiguredRoot(this.root,thread,this.receipt);
    this.rootTranscriptCwd=thread.cwd;
   })();
   await this.initializing;
  }
  if(threadId===this.root.threadId){
   if(turnId!==this.root.turnId)throw Error('Wrong root turn');
   return this.root;
  }
  const {thread}=await this.runtime.rpc.request('thread/read',{threadId,includeTurns:true},10000);
  const source=thread?.source?.subAgent?.thread_spawn;
  if(!source||thread.parentThreadId!==source.parent_thread_id)throw Error('Unverified subagent');
  this.registry.environment(thread);
  const actual=thread.turns?.at(-1);
  if(!actual?.id||actual.id!==turnId||actual.status!=='inProgress')throw Error('Subagent turn is not running');
  if(!this.current()||this.ended.has(threadId+':'+turnId))throw Error('Subagent turn ended');
  if(!this.registry.records.has(source.parent_thread_id)){
   const parent=await this.runtime.rpc.request('thread/read',{threadId:source.parent_thread_id,includeTurns:true},10000);
   await this.ensure(source.parent_thread_id,parent.thread?.turns?.at(-1)?.id,ancestors);
  }
  let record=this.registry.records.get(threadId);
  if(!record)this.registry.stageChild(thread);
  const run=this.registry.startTurn(threadId,turnId);
  this.registry.admitInheritedChild(threadId,thread,this.receipt);
  run.nativeHookSubagent=Object.freeze({agentId:threadId,agentType:source.agent_role||'default'});
  if(!this.current()||this.ended.has(threadId+':'+turnId)){await this.cancel(threadId,turnId);throw Error('Subagent turn ended');}
  this.runtime.openCodexChildThread?.(thread,this.root);
  return run;
 }
 // History visibility is independent of tool admission. The native UI reads a
 // child as soon as it sees the parent activity, before the first tool/turn gate.
 // Verify the entire source chain and executor; this never grants a tool scope.
 async discover(threadId){
  if(this.closed||this.runtime.closed||this.runtime.openCodexSubagents!==this)throw Error('Subagent session is no longer available');
  if(this.discovering.has(threadId))return this.discovering.get(threadId);
  const work=(async()=>{
   const {thread}=await this.runtime.rpc.request('thread/read',{threadId,includeTurns:true},10000);
   if(thread?.id!==threadId)throw Error('Mismatched subagent history');
   let cursor=thread;const seen=new Set();
   while(cursor?.id!==this.root.threadId){
    if(!cursor?.id||seen.has(cursor.id)||seen.size>=16)throw Error('Invalid subagent ancestry');
    seen.add(cursor.id);this.registry.environment(cursor);
    const parent=cursor.source?.subAgent?.thread_spawn?.parent_thread_id;
    if(!parent||parent!==cursor.parentThreadId)throw Error('Unverified subagent history');
    if(parent===this.root.threadId)break;
    cursor=(await this.runtime.rpc.request('thread/read',{threadId:parent,includeTurns:false},10000)).thread;
   }
   if(thread.id===this.root.threadId||this.closed||this.runtime.closed||this.runtime.openCodexSubagents!==this)throw Error('Subagent history owner changed');
   this.runtime.openCodexChildThread?.(thread,this.root);
   return thread;
  })();
  this.discovering.set(threadId,work);
  try{return await work;}finally{if(this.discovering.get(threadId)===work)this.discovering.delete(threadId);}
 }
 // 0.160 review/start owns an internal, non-collaboration agent. Its
 // thread/read is persisted history (environments=null, status notLoaded), not
 // a live actor. Bind it to the live review notification and verified root;
 // never admit that transcript as an independently running child. Its cwd is
 // the remote engine's primary directory; Mac execution is separately bound
 // by the root's verified environments. Match the two remote transcripts.
 async reviewOwner(value,signal){
  if(!this.root.nativeReview||value.thread_source!=='subagent'||value.subagent_kind!=='review'||value.codex_version!=='0.160.0'||value.parent_thread_id!==this.root.threadId||value.thread_id===this.root.threadId||value.turn_id!==this.reviewTurnId)throw Error('Unverified review owner');
  return this.reviewThreadOwner(value.thread_id,value.turn_id,signal);
 }
 async reviewThreadOwner(threadId,turnId,signal){
  if(!this.root.nativeReview||typeof threadId!=='string'||threadId===this.root.threadId||turnId!==this.reviewTurnId)throw Error('Unverified review owner');
  const value={thread_id:threadId,turn_id:turnId};
  if(!(await this.root.toolGate)||!this.current())throw Error('Review turn ended');
  const root=await this.ensure(this.root.threadId,this.root.turnId);
  if(this.reviewThreadId&&this.reviewThreadId!==value.thread_id)throw Error('Review identity changed');
  if(!this.reviewThreadId){
   const {thread}=await this.runtime.rpc.request('thread/read',{threadId:value.thread_id,includeTurns:true},10000);
   const turn=thread?.turns?.at(-1);
   if(thread?.id!==value.thread_id||thread.parentThreadId!==root.threadId||thread.source?.subAgent!=='review'||thread.cliVersion!=='0.160.0'||typeof this.rootTranscriptCwd!=='string'||!this.rootTranscriptCwd||thread.cwd!==this.rootTranscriptCwd||turn?.id!==value.turn_id||turn.completedAt!=null)throw Error('Unverified review transcript');
   if(this.reviewThreadId&&this.reviewThreadId!==value.thread_id)throw Error('Review identity changed');
   this.reviewThreadId=value.thread_id;
  }
  if(!this.isActive(root)||signal?.aborted||value.turn_id!==this.reviewTurnId)throw Error('Review turn ended');
  return root;
 }
 // Hooks use the engine's authenticated MCP thread ID and a root session ID,
 // but do not carry tool turn metadata. Verify the actual transcript ancestry
 // and selected Mac environment instead of synthesizing missing tool metadata.
 // A stopped turn may run exactly one native Interrupt hook. This lease never
 // restores tool admission, and dies on completion, replacement or host restart.
 interruptHookActive(lease){
  return this.interruptHook===lease&&!this.closed&&!this.runtime.closed&&this.runtime.run===this.root&&this.runtime.openCodexSubagents===this&&this.runtime.toolHost===lease.host&&lease.host.generation===lease.generation&&Date.now()<lease.expiresAt;
 }
 async resolveInterruptHook(args,meta,signal){
  const lease=this.interruptHook;
  if(!lease||lease.used||!this.interruptHookActive(lease)||meta.threadId!==this.root.threadId||args.turnId!==lease.turnId)throw Error('Invalid Interrupt Hook owner');
  // Consume before awaiting, so duplicate requests cannot race this lease.
  lease.used=true;
  if(!(await this.root.toolGate)||signal?.aborted||!this.interruptHookActive(lease))throw Error('Interrupt Hook ended');
  if(!this.registry.records.has(this.root.threadId)){
   const {thread}=await this.runtime.rpc.request('thread/read',{threadId:this.root.threadId,includeTurns:false},2000);
   if(thread?.id!==this.root.threadId)throw Error('Invalid Interrupt Hook root');
   this.registry.environment(thread);
  }
  if(signal?.aborted||!this.interruptHookActive(lease))throw Error('Interrupt Hook ended');
  return {run:this.root,threadId:this.root.threadId,sessionId:this.root.threadId,turnId:lease.turnId,subagent:null,interruptLease:lease};
 }
 async resolveHook(args,meta,signal){
  if(args?.sessionId!==this.root.threadId||typeof meta?.threadId!=='string'||!meta.threadId||signal?.aborted)throw Error('Unverified Hook owner');
  if(meta.sessionId!=null&&meta.sessionId!==this.root.threadId)throw Error('Unverified Hook session');
  if(args.event==='Interrupt')return this.resolveInterruptHook(args,meta,signal);
  if(!(await this.root.toolGate)||!this.current())throw Error('Hook turn ended');
  const threadId=meta.threadId;
  if(args.event==='SessionStart'&&threadId!==this.root.threadId)throw Error('Invalid Hook lifecycle owner');
  const turnId=args.event==='SessionStart'?this.root.turnId:args.turnId;
  if(typeof turnId!=='string'||!turnId)throw Error('Missing Hook turn');
  const review=this.root.nativeReview&&threadId!==this.root.threadId;
  const run=review?await this.reviewThreadOwner(threadId,turnId,signal):await this.ensure(threadId,turnId);
  const subagent=run.nativeHookSubagent||null;
  if(args.event==='SubagentStart'||args.event==='SubagentStop'){
   if(!subagent||args.agentId!==threadId||args.agentType!==subagent.agentType)throw Error('Invalid Hook subagent');
  }
  if((args.event==='Stop'&&(review||subagent))||(review&&args.event==='SessionStart'))throw Error('Invalid Hook lifecycle owner');
  if(!this.isActive(run)||signal?.aborted)throw Error('Hook turn ended');
  return {run,threadId,sessionId:this.root.threadId,turnId,subagent};
 }
 async resolve(meta,signal){
  const value=turnMetadata(meta);
  if(value.session_id!==this.root.threadId||signal?.aborted)throw Error('Tool belongs to another session');
  if(value.subagent_kind==='review')return this.reviewOwner(value,signal);
  const run=await this.ensure(value.thread_id,value.turn_id);
  if(value.thread_source==='subagent'&&value.parent_thread_id!==run.parentThreadId)throw Error('Tool parent differs from its owner');
  if((run.parentThreadId?'subagent':'user')!==value.thread_source||!this.isActive(run)||signal?.aborted)throw Error('Tool turn is no longer active');
  return run;
 }
 async authorize(call){
  const run=scopedRun(this.runtime);
  if(!this.isActive(run)||call.signal?.aborted)return false;
  const mode=this.runtime.permissionMode;
  if(call.category==='agent-bridge'||mode==='full'||(mode==='project'&&call.category==='filesystem-read'))return true;
  const id=randomUUID();
  return new Promise(resolve=>{
   const finish=allowed=>{clearTimeout(timer);call.signal?.removeEventListener('abort',abort);this.runtime.requests.delete(id);this.emit(run,{type:'requestClosed',approvalId:id});resolve(allowed&&this.isActive(run));};
   const abort=()=>finish(false),timer=setTimeout(abort,120000);
   this.runtime.requests.set(id,{request:{id,method:'local/tool',params:call},requestId:run.requestId,openCodexRun:run,localResolve:finish,timer});
   call.signal?.addEventListener('abort',abort,{once:true});
   this.emit(run,{type:'approval',approvalId:id,executionLocation:'local',title:'允許在這台 Mac 使用 '+call.name+'？',detail:(run.parentThreadId?'子代理：'+run.threadId+'\n':'')+JSON.stringify(call.arguments??{}).slice(0,8000)});
  });
 }
 serverRequest(request){
  const {method,params:p={}}=request;
  if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput'].includes(method))return false;
  void (async()=>{
   const review=this.root.nativeReview&&p.threadId===this.root.threadId&&p.turnId===this.reviewTurnId;
   if(review&&(!(await this.root.toolGate)||!this.current()))throw Error('Review turn ended');
   const run=await this.ensure(p.threadId,review?this.root.turnId:p.turnId);
   if(!this.isActive(run)||!this.runtime.executor?.isRunning)throw Error('Mac executor turn ended');
   if(method==='item/commandExecution/requestApproval'&&p.environmentId!==this.runtime.executor.environmentId)throw Error('Command is not bound to Mac');
   if(!this.runtime.openCodexServerRequest?.(request,run))throw Error('Native frontend unavailable');
  })().catch(error=>this.runtime.rpc.reject(request.id,error.message));
  return true;
 }
 notification(message){
  const p=message.params||{},turnId=p.turn?.id||p.turnId;
  if(message.method==='turn/started'&&this.root.nativeReview&&p.threadId===this.root.threadId&&this.runtime.run===this.root&&!this.runtime.closed&&!this.reviewTurnId)this.reviewTurnId=turnId;
  if(message.method==='turn/started'&&p.threadId!==this.root.threadId){
   void this.ensure(p.threadId,turnId).catch(()=>this.interruptLate(p.threadId,turnId));
  }
  if(message.method==='turn/completed'){
   if(p.threadId===this.root.threadId&&(turnId===this.root.turnId||turnId===this.reviewTurnId))this.interruptHook=null;
   this.ended.add(p.threadId+':'+turnId);
   if(p.threadId===this.root.threadId&&(!this.root.turnId||turnId===this.root.turnId))this.stopRoot=true;
   const result=this.registry.finish(p.threadId,turnId);
   if(result){this.cleanup(result.run);void this.interruptTargets(result.cancelled);}
  }
 }
 async interruptLate(threadId,turnId){
  // A notification alone never grants ownership or authority to interrupt a peer.
  try{
   const {thread}=await this.runtime.rpc.request('thread/read',{threadId,includeTurns:true},5000);
   this.registry.environment(thread);
   let cursor=thread,depth=0;
   while(cursor?.source?.subAgent?.thread_spawn&&depth++<16){
    const parent=cursor.source.subAgent.thread_spawn.parent_thread_id;
    if(parent!==cursor.parentThreadId)return;
    if(parent===this.root.threadId){
     if(thread.turns?.at(-1)?.id===turnId&&thread.turns.at(-1).status==='inProgress')await this.runtime.rpc.request('turn/interrupt',{threadId,turnId},5000);
     return;
    }
    cursor=(await this.runtime.rpc.request('thread/read',{threadId:parent,includeTurns:false},5000)).thread;this.registry.environment(cursor);
   }
  }catch{}
 }
 cleanup(run){
  this.runtime.toolHost?.cancelRun(run);this.deps.cancelNativeRun?.(this.runtime,run);this.runtime.openCodexCloseRun?.(run);
  for(const [id,pending]of this.runtime.requests)if(pending.requestId===run.requestId){clearTimeout(pending.timer);this.runtime.requests.delete(id);pending.localResolve?.(false);this.emit(run,{type:'requestClosed',approvalId:id});}
 }
 async interruptTargets(targets){
  await Promise.allSettled(targets.map(async target=>{
   const run=this.registry.records.get(target.threadId)?.run;if(run)this.cleanup(run);
   // review/start returns an outer receipt ID, but the live root actor uses
   // the internal review turn ID reported by turn/started for interruption.
   const turnId=target.threadId===this.root.threadId&&this.root.nativeReview&&this.reviewTurnId?this.reviewTurnId:target.turnId;
   if(turnId&&!this.runtime.closed)await this.runtime.rpc.request('turn/interrupt',{threadId:target.threadId,turnId},5000);
  }));
 }
 async cancel(threadId,turnId){
  const record=this.registry.records.get(threadId);
  if(record&&record.run.turnId!==turnId)throw Error('Stale subagent interrupt');
  if(threadId===this.root.threadId){
   if(turnId!==this.root.turnId)throw Error('Stale root interrupt');
   if(this.current()&&typeof turnId==='string'&&turnId)this.interruptHook={turnId,used:false,expiresAt:Date.now()+5000,host:this.runtime.toolHost,generation:this.runtime.toolHost.generation};
   this.stopRoot=true;
  }
  else if(!record)throw Error('Unknown subagent interrupt');
  const targets=this.registry.cancel(threadId);
  // Stop may arrive before the first tool has lazily registered the root.
  if(threadId===this.root.threadId&&!record){this.root.cancelled=true;this.cleanup(this.root);targets.push({threadId,turnId});}
  await this.interruptTargets(targets);
 }
 close(){
  if(this.closed)return;this.closed=true;this.stopRoot=true;
  const targets=this.registry.cancel(this.root.threadId);
  if(!this.registry.records.has(this.root.threadId)&&!this.root.cancelled){
   this.root.cancelled=true;this.cleanup(this.root);
   if(this.root.turnId)targets.push({threadId:this.root.threadId,turnId:this.root.turnId});
  }
  void this.interruptTargets(targets);
  // Leave this closed gate in place until a new verified turn owns the host.
 }
}
module.exports={NativeAgentRuns,receiptFor,configureSubagents};
