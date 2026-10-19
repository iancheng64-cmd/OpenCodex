'use strict';
const {NativeTools}=require('./native-tools.cjs');
const {routeNativeRequest}=require('./native-request.cjs');
// Each validated Hook session owns its MCP host. Cancelling this host cannot
// reset the user's primary tools or another agent's REPL.
class NativeHooksMcp{
 constructor({record,runtime,binary,env,AppServerRpc,onRequest,Tools=NativeTools}){
  Object.assign(this,{record,runtime,onRequest});this.closed=false;
  this.tools=new Tools({binary,cwd:record.plan.cwd,env,AppServerRpc,config:{'features.hooks':false},
   onRequest:(message,rpc,host)=>{
    const active=this.active;if(!active?.authorized()||active.owner.run.cancelled)return false;
    const routed=routeNativeRequest(message,host.threadId,active.owner.run);
    return routed?onRequest?.(routed,rpc,{run:active.owner.run,owner:runtime}):false;
   }});
 }
 async call(call,signal,active){
  if(this.closed||this.active||signal?.aborted||!active?.authorized())throw Error('MCP Hook owner ended or busy');
  const {owner}=active;
  if(call?.threadId!==owner.threadId||call.metadata?.threadId!==owner.threadId||call.environmentId!=null)throw Error('MCP Hook ownership mismatch');
  if(typeof call.server!=='string'||typeof call.tool!=='string')throw Error('Invalid MCP Hook tool');
  const control=new AbortController(),abort=()=>{control.abort();this.tools.reset();};
  signal?.addEventListener('abort',abort,{once:true});this.active=active;this.control=control;
  const valid=()=>{if(this.closed||control.signal.aborted||!active.authorized())throw Error('MCP Hook owner ended');};
  try{
   valid();await this.tools.ready();valid();
   const inventory=await this.tools.inventory();valid();
   const server=inventory.find(s=>s.name===call.server&&s.runtimeStatus==='connected');
   if(!server?.tools?.[call.tool])throw Error('MCP Hook 工具未連線或已停用：'+call.server+'/'+call.tool);
   const run=owner.run;
   const meta={...call.metadata,threadId:owner.threadId,sessionId:owner.sessionId,
    'x-codex-turn-metadata':JSON.stringify({session_id:owner.sessionId,thread_id:owner.threadId,turn_id:owner.turnId,
     thread_source:run.parentThreadId?'subagent':'user',...(run.parentThreadId?{parent_thread_id:run.parentThreadId,subagent_kind:'thread_spawn'}:{})})};
   const result=await this.tools.operation('mcpServer/tool/call',{server:call.server,tool:call.tool,arguments:call.arguments,_meta:meta},control.signal);
   valid();
   if(!Array.isArray(result?.content))throw Error('Invalid MCP Hook result');
   const text=result.content.filter(c=>c.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n');
   if(result.isError===true||result.is_error===true)throw Error('MCP tool returned an error: '+text);
   return text;
  }finally{signal?.removeEventListener('abort',abort);if(this.active===active)this.active=null;if(this.control===control)this.control=null;}
 }
 cancel(){this.control?.abort();this.tools.reset();}
 close(){if(this.closed)return;this.closed=true;this.control?.abort();this.tools.close();}
}
module.exports={NativeHooksMcp};
