'use strict';
const {createHash,randomUUID,timingSafeEqual}=require('node:crypto');
const {NativeHooksClient}=require('./native-hooks-client.cjs');
const EVENTS={
 UserPromptSubmit:{snake:'user_prompt_submit',fields:{prompt:'prompt'}},
 PreToolUse:{snake:'pre_tool_use',fields:{toolName:'tool_name',toolUseId:'tool_use_id',toolInput:'tool_input'}},
 PostToolUse:{snake:'post_tool_use',fields:{toolName:'tool_name',toolUseId:'tool_use_id',toolInput:'tool_input',toolResponse:'tool_response'}},
 PermissionRequest:{snake:'permission_request',fields:{toolName:'tool_name',toolInput:'tool_input'}},
 PreCompact:{snake:'pre_compact',fields:{trigger:'trigger'},permission:false},
 PostCompact:{snake:'post_compact',fields:{trigger:'trigger'},permission:false},
 SessionStart:{snake:'session_start',fields:{source:'source'},turn:false},
 SubagentStart:{snake:'subagent_start',fields:{agentId:'agent_id',agentType:'agent_type'}},
 Stop:{snake:'stop',fields:{stopHookActive:'stop_hook_active',lastAssistantMessage:'last_assistant_message'}},
 SubagentStop:{snake:'subagent_stop',fields:{agentId:'agent_id',agentType:'agent_type',stopHookActive:'stop_hook_active',lastAssistantMessage:'last_assistant_message'}},
 Interrupt:{snake:'interrupt',fields:{},timeout:3}
};
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
function hookHash(event,handler){
 return 'sha256:'+createHash('sha256').update(JSON.stringify(canonical({event_name:event,hooks:[handler]}))).digest('hex');
}
function field(name){return '$'+'{'+name+'}';}
// Trust only generated transport handlers. Local commands retain their own native
// content hashes. The remote account's files are never written.
function relayConfig({server,events=Object.keys(EVENTS),remoteHooks=[],platform='linux',nonce=randomUUID()}){
 if(!server||!Array.isArray(remoteHooks))throw Error('Invalid Hooks relay configuration');
 const state=Object.create(null),hooks=Object.create(null);
 for(const hook of remoteHooks){
  if(!hook||typeof hook.key!=='string')throw Error('Invalid remote Hooks inventory');
  if(hook.enabled&&hook.isManaged)throw Error('Managed remote Hooks cannot be relocated to this Mac');
  state[hook.key]={enabled:false};
 }
 const source=['win32','windows'].includes(platform)?['C:', '<session-flags>', 'config.toml'].join(String.fromCharCode(92)):'/<session-flags>/config.toml';
 for(const event of new Set(events)){
  const spec=EVENTS[event];if(!spec)throw Error('Unsupported relay event: '+event);
  const input={relayNonce:nonce,event,sessionId:field('session_id'),model:field('model')};
  if(spec.turn!==false)input.turnId=field('turn_id');
  if(spec.permission!==false)input.permissionMode=field('permission_mode');
  for(const [key,value]of Object.entries(spec.fields))input[key]=field(value);
  const handler={type:'mcp_tool',server,tool:'opencodex_native_hook',timeout:spec.timeout||600,input};
  hooks[event]=[{hooks:[handler]}];
  state[source+':'+spec.snake+':0:0']={enabled:true,trusted_hash:hookHash(spec.snake,handler)};
 }
 return {nonce,source,events:new Set(events),config:{'features.hooks':true,hooks:{...hooks,state}}};
}
function nativeOutput(event,result){
 const output={},specific={hookEventName:event};
 if(result.should_stop){output.continue=false;output.stopReason=result.stop_reason||'Mac hook stopped execution';}
 if(result.additional_contexts?.length)specific.additionalContext=result.additional_contexts.join('\n\n');
 if(event==='PreToolUse'){
  if(result.should_block){specific.permissionDecision='deny';specific.permissionDecisionReason=result.block_reason||'Mac hook blocked the tool';}
  else if(result.updated_input!=null){specific.permissionDecision='allow';specific.updatedInput=result.updated_input;}
 }
 if(event==='PostToolUse'){
  if(result.should_block){output.decision='block';output.reason=result.feedback_message||'Mac hook rejected the tool result';}
  else if(result.feedback_message){output.continue=false;output.stopReason=result.feedback_message;}
 }
 if(event==='PermissionRequest'&&result.decision)specific.decision=result.decision;
 if((event==='Stop'||event==='SubagentStop')&&result.should_block&&!result.should_stop){
  output.decision='block';
  output.reason=(result.continuation_fragments||[]).map(f=>f.text).filter(Boolean).join('\n\n')||result.block_reason||'Mac hook requested continuation';
 }
 if(Object.keys(specific).length>1)output.hookSpecificOutput=specific;
 return output;
}
function equalNonce(a,b){
 if(typeof a!=='string'||typeof b!=='string')return false;
 const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);
}
// A binding is owned by a validated engine thread. Its caller must verify any
// child/review ancestry before constructing a separate child binding.
class NativeHooksBinding{
 constructor({binary,cwd,codexHome,threadId,sessionId=threadId,subagent=null,nonce,events,env,mcpCall,onNotification=()=>{}}){
  Object.assign(this,{threadId,sessionId,subagent,cwd,nonce,events:new Set(events),ended:new Set()});
  this.client=new NativeHooksClient({binary,cwd,codexHome,threadId,sessionId,env,mcpCall});
  this.client.on('notification',onNotification);this.ready=this.client.ready;
 }
 async invoke(args,metadata,{signal,authorizeInterrupt}={}){
  if(this.closed||!equalNonce(args?.relayNonce,this.nonce)||args.sessionId!==this.sessionId||metadata?.threadId!==this.threadId||!this.events.has(args.event))
   throw Error('Unverified native Hooks relay owner');
  const interrupt=args.event==='Interrupt';
  if(interrupt&&authorizeInterrupt?.()!==true)throw Error('Unverified Interrupt Hook lease');
  if(args.event!=='SessionStart'&&(typeof args.turnId!=='string'||!args.turnId||(!interrupt&&this.ended.has(args.turnId))))
   throw Error('Native Hooks turn has ended');
  const input={...args,threadId:this.threadId,sessionId:this.sessionId,subagent:this.subagent};delete input.relayNonce;
  // Never forward the remote transcript path or remote cwd to a Mac command.
  delete input.transcriptPath;delete input.agentTranscriptPath;delete input.cwd;
  if(input.event==='PermissionRequest')input.toolUseId=randomUUID();
  const result=await this.client.execute(input,{signal});
  if(this.closed||signal?.aborted||(interrupt?authorizeInterrupt?.()!==true:this.ended.has(args.turnId)))throw Error('Native Hooks turn has ended');
  return nativeOutput(args.event,result);
 }
 async cancel(turnId){
  if(this.ended.has(turnId))return;
  this.ended.add(turnId);
  if(this.client.active?.turnId===turnId)await this.client.cancel();
 }
 async close(){this.closed=true;return this.client.close();}
}
module.exports={EVENTS,hookHash,relayConfig,nativeOutput,NativeHooksBinding};
