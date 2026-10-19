'use strict';
// Connection status is observational. It must never start, retry or replay work.
const stages={'executor-start':'Mac 執行器啟動','executor-register':'Mac 執行環境註冊','tool-host':'Mac 工具通道','workspace':'專案工具'};
const reasons=['連線逾時','權限不足','找不到執行程式或檔案','工具通道中斷','執行環境設定不相容','工具程序已結束','初始化失敗'];
function failureReason(error){
 const message=error instanceof Error?error.message:String(error||'');
 // Never expose arbitrary process output, URLs or credentials in connection status.
 if(/timeout|timed out|逾時/i.test(message))return reasons[0];
 if(/EACCES|EPERM|permission denied|權限/i.test(message))return reasons[1];
 if(/ENOENT|not found|找不到/i.test(message))return reasons[2];
 if(/ECONN|EPIPE|socket|closed|中斷/i.test(message))return reasons[3];
 if(/environment|version|configuration|設定|環境|版本/i.test(message))return reasons[4];
 if(/exited|terminated|結束/i.test(message))return reasons[5];
 return reasons[6];
}
function initializationFailure(stage,error){return (stages[stage]||'Mac 工具')+'：'+failureReason(error)+'。';}
function safeDiagnostic(value){
 for(const label of Object.values(stages))for(const reason of reasons){
  const expected=label+'：'+reason+'。';if(value===expected)return expected;
 }
 return value?initializationFailure('tool-host',value):null;
}
function connectionState(runtime){
 const connected=!!runtime&&!runtime.closed&&!runtime.rpc?.isClosed;
 const executor=connected&&runtime.executor?.isRunning===true;
 let host,hostError;
 if(connected)try{host=runtime.toolHost?.status();}catch(error){hostError=error;}
 const id=runtime?.executor?.environmentId,registration=runtime?.executor?.registrations?.get(id);
 const registered=executor&&!!id&&runtime.snapshot?.executorEnvironment?.environmentId===id&&registration?.rpc===runtime.rpc;
 const toolsReady=!!(connected&&registered&&host?.ok===true&&runtime.mcp?.environmentId===id&&runtime.mcp?.name&&runtime.mcp?.url&&runtime.mcp?.token&&!runtime.openCodexWorkspaceFailed);
 let diagnostic=null,connectionStage=connected?'ready':'disconnected';
 if(connected&&!toolsReady){
  connectionStage=runtime.openCodexWorkspaceFailed?'workspace':!executor?'executor-start':!registered?'executor-register':'tool-host';
  diagnostic=safeDiagnostic(runtime.snapshot?.diagnostic)||initializationFailure(connectionStage,hostError);
 }
 return {connected,executor,toolsReady,connectionStage,diagnostic,tools:host?.tools?.length||0};
}
module.exports={connectionState,initializationFailure,failureReason};
