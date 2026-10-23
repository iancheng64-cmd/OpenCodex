'use strict';
const verified=new WeakSet();
function reviewer(value='user'){
 // The native desktop calls this mode guardian_subagent; the pinned peer
 // protocol uses auto_review. This module runs only for remote conversations.
 if(value==='guardian_subagent')value='auto_review';
 if(value!=='user'&&value!=='auto_review')throw Error('請選擇使用者審批或 Guardian 審查。');
 return value;
}
function capable(runtime){
 return !!runtime&&!runtime.closed&&runtime.snapshot?.runtimeVersion==='0.160.0'&&
  String(runtime.openCodexInitialized?.userAgent||'').split(/\s+/).includes('OpenCodexGuardian/1');
}
function effective(runtime){return runtime.permissionMode==='full'?'user':reviewer(runtime.openCodexReviewer);}
function select(runtime,value){
 value=reviewer(value);
 if(reviewer(runtime.openCodexReviewer)===value)return;
 if(runtime.closed||runtime.run||runtime.openCodexPreparing?.cancelled)throw Error('請先停止工作，再切換審查模式。');
 runtime.openCodexSubagents?.close();
 runtime.openCodexThreads?.clear();runtime.openCodexDormantThreads?.clear();
 runtime.openCodexAgentReceipts?.clear();runtime.openCodexGuardianReceipts?.clear();
 runtime.openCodexReviewer=value;
}
function binding(runtime){
 return {rpc:runtime.rpc,host:runtime.toolHost,endpoint:runtime.toolHost?.server,
  generation:runtime.toolHost?.generation,cwd:runtime.localCwd,mode:runtime.permissionMode,
  reviewer:effective(runtime),requested:reviewer(runtime.openCodexReviewer)};
}
function current(runtime,receipt){
 return !!receipt&&!runtime.closed&&Object.entries(binding(runtime)).every(([key,value])=>receipt[key]===value);
}
function validate(runtime,threadId){
 const receipt=runtime.openCodexGuardianReceipts?.get(threadId);
 if(effective(runtime)==='auto_review'&&(!current(runtime,receipt)||receipt.threadId!==threadId))
  throw Error('請重新開啟對話，套用目前的 Guardian 審查設定。');
 return receipt;
}
function prepare(runtime,base,config){
 const owner=binding(runtime),enabled=owner.reviewer==='auto_review';
 if(enabled){
  if(!capable(runtime)||config['features.multi_agent_v2']!==true)
   throw Error('此 SSH 引擎或子代理設定尚未通過 Guardian 驗證。');
  const server=config.mcp_servers?.[runtime.mcp.name];
  if(!server||server.environment_id!==runtime.executor.environmentId)throw Error('Guardian 缺少已驗證的 Mac 工具通道。');
  server.default_tools_approval_mode='prompt';
  // Config maps merge recursively. Override every existing per-tool exemption.
  const tools=base?.mcp_servers?.[runtime.mcp.name]?.tools;
  if(tools!=null&&(typeof tools!=='object'||Array.isArray(tools)))throw Error('無效的 MCP 工具審查設定。');
  server.tools=Object.fromEntries(Object.keys(tools||{}).map(name=>[name,{approval_mode:'prompt'}]));
 }
 config['features.guardian_approval']=enabled;
 let settled=false;
 return {
  parameters:{approvalsReviewer:owner.reviewer,...(enabled?{approvalPolicy:'on-request'}:{})},
  commit(result){
   if(settled)throw Error('Guardian 設定已結束。');settled=true;
   const threadId=result?.thread?.id;
   if(!current(runtime,owner)||!threadId||
     (enabled&&(result.approvalsReviewer!=='auto_review'||result.approvalPolicy!=='on-request')))
    throw Error('SSH 對話未套用所選的 Guardian 審查設定。');
   if(!enabled){runtime.openCodexGuardianReceipts?.delete(threadId);return;}
   const receipt=Object.freeze({...owner,threadId});verified.add(receipt);
   runtime.openCodexGuardianReceipts??=new Map();runtime.openCodexGuardianReceipts.set(threadId,receipt);
   return receipt;
  },
  abort(){settled=true;}
 };
}
function receiptFor(runtime,threadId){
 if(effective(runtime)!=='auto_review')return null;
 const receipt=validate(runtime,threadId);
 if(!verified.has(receipt))throw Error('缺少已驗證的 Guardian 對話設定。');
 return receipt;
}
module.exports={reviewer,capable,effective,select,current,validate,prepare,receiptFor};
