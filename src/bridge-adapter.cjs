// Appended inside the original AgentBridge runtime module; reuse its policies.
exports.openCodexRuntimes = runtimes;
async function openCodexInput(runtime,input){
 return require('../../../app.asar/opencodex/native-input.cjs').convertInput(runtime,input);
}

async function openCodexTimed(deps,method,stage,operation){
 const started=Date.now();let passed=false;
 try{const result=await operation();passed=true;return result;}
 finally{try{deps.emit?.('opencodex:latency',{method,stage,ms:Date.now()-started,passed});}catch{/* Diagnostics must not change request behavior. */}}
}
exports.openCodexRequest = async function(runtime, deps, method, params = {}) {
 if(runtime.closed) throw new Error('SSH 連線已中斷，請重新連線。');
 if(runtime.openCodexWorkspaceFailed)throw Error('專案工具初始化失敗，請重新選擇專案或重新連線。');
 if(method.startsWith('thread/queue/'))throw Error('排隊訊息必須由 OpenCodex 排程，不能交由遠端自動執行。');
 const custom=runtime.permissionMode?.startsWith('custom:');
 const executing=['thread/start','thread/resume','thread/fork','thread/settings/update','turn/start','turn/steer','review/start'].includes(method);
 if(executing&&(runtime.openCodexPermissionChanging||runtime.openCodexPermissionFailed))throw Error('操作權限尚未就緒，請重新選擇權限或連線。');
 if(executing&&custom&&(!deps.prepareNativePermissions||!deps.validateNativePermissions))throw Error('此連線缺少自訂權限執行元件。');
 const p={...params};
 const guardian=require('../../../app.asar/opencodex/native-agent-runs.cjs').guardianRuntime;
 // Mac workspace roots belong to the registered executor, never the Windows Runtime.
 delete p.runtimeWorkspaceRoots;delete p.permissions;delete p.approvalsReviewer;
 if(method==='initialize') return runtime.openCodexInitialized;
 if(method==='thread/settings/update'){
  delete p.cwd; // The workspace lease updates the Mac host; never send its path to the peer.
  if(params.permissions!=null||params.sandboxPolicy!=null||params.approvalPolicy!=null||params.approvalsReviewer!=null){
   p.approvalPolicy=runtime.permissionMode==='full'?'never':'untrusted';
   p.sandboxPolicy={type:runtime.permissionMode==='full'?'dangerFullAccess':'readOnly'};
   if(custom){delete p.sandboxPolicy;Object.assign(p,await deps.validateNativePermissions(runtime,p.threadId),{approvalsReviewer:'user'});}
   guardian.validate(runtime,p.threadId);
   if(guardian.effective(runtime)==='auto_review')Object.assign(p,{approvalsReviewer:'auto_review',approvalPolicy:'on-request'});
  }
 }
 if(method==='thread/start'||method==='thread/resume'||method==='thread/fork'){
  if(!runtime.executor?.isRunning||!runtime.mcp)throw new Error('Mac Executor 與工具通道尚未就緒。');
  if(runtime.run)throw new Error('Runtime 正在執行工作。');
  const timed=(stage,fn)=>openCodexTimed(deps,method,stage,fn);
  await timed('extensions',()=>refreshMacExtensions(runtime,deps));
  const configuration=await timed('config',()=>runtime.rpc.request('config/read',{includeLayers:false}));
  const config=(0,runtime_policy_1.macThreadConfig)(configuration.config,runtime.mcp,runtime.autoCompactPercent);
  require('../../../app.asar/opencodex/native-agent-runs.cjs').configureSubagents(runtime,configuration.config,config);
  const permissions=await timed('permissions',()=>deps.prepareNativePermissions?.(runtime));let hooks,review,hookThreadId=p.threadId;
  try{
  hooks=await timed('hooks',()=>deps.prepareNativeHooks?.(runtime));
  if(hooks)Object.assign(config,hooks.config);
  if(permissions)Object.assign(config,permissions.config);
  review=guardian.prepare(runtime,configuration.config,config);
  delete p.cwd;delete p.sandboxPolicy;if(permissions)delete p.sandbox; // Native dynamic tools execute through the frontend request handler.
  p.config=config;
  if(permissions)Object.assign(p,permissions.parameters);
  else Object.assign(p,(0,permission_policy_1.codexPermissionPolicy)(runtime.permissionMode));
  Object.assign(p,review.parameters);
  p.developerInstructions=[p.developerInstructions,(0,runtime_extensions_1.macRuntimeInstructions)(runtime.localCwd,runtime.manifestPath,runtime.toolHost?.status().tools||[],runtime.extensionCatalog)].filter(Boolean).join('\n\n');
  if(method==='thread/start')p.environments=[{environmentId:runtime.executor.environmentId,cwd:runtime.localCwd}];
  if(runtime.closed||runtime.openCodexPreparing?.cancelled)throw Error('工作初始化已取消。');
  let result=await timed('remote-thread',()=>runtime.rpc.request(method,p,60000));hookThreadId=result.thread.id;
  if(method==='thread/fork')result=await runtime.rpc.request('thread/resume',{...p,threadId:result.thread.id},60000);
  // Codex 0.160 resumes with no selected environments. Its environment-scoped
  // MCP stays disabled until turn/start selects the Mac; all other servers must
  // remain disabled before a model turn may begin.
  const dormant=method!=='thread/start'&&Array.isArray(result.thread.environments)&&result.thread.environments.length===0;
  if(dormant){
   const inventory=[];let cursor;
   do{const page=await runtime.rpc.request('mcpServerStatus/list',{threadId:result.thread.id,detail:'toolsAndAuthOnly',limit:100,...(cursor?{cursor}:{})},60000).catch(error=>{throw Error('SSH Runtime 工具清單：'+error.message,{cause:error});});if(!Array.isArray(page.data))throw Error('無法驗證 Runtime 工具隔離。');inventory.push(...page.data);if(page.nextCursor===cursor&&cursor)throw Error('Runtime 工具分頁異常。');cursor=page.nextCursor;if(inventory.length>10000)throw Error('Runtime 工具清單過大。');}while(cursor);
   const selected=inventory.find(i=>i.name===runtime.mcp.name);
   if(!selected)throw Error('Runtime 未登記 Mac 工具。');
   if(selected.runtimeStatus==='disabled'){
    (0,runtime_policy_1.validateMacMcpInventory)(inventory,undefined);
   }else await verifyThreadMcp(runtime,result.thread.id,config);
  }else await timed('inventory',()=>verifyThreadMcp(runtime,result.thread.id,config));
  if(runtime.closed||runtime.openCodexPreparing?.cancelled)throw Error('工作初始化已取消。');
  await permissions?.commit(result);
  await hooks?.commit(result.thread.id);
  review.commit(result);
  runtime.openCodexDormantThreads??=new Set();
  if(dormant)runtime.openCodexDormantThreads.add(result.thread.id);else runtime.openCodexDormantThreads.delete(result.thread.id);
  runtime.openCodexThreads??=new Set();runtime.openCodexThreads.add(result.thread.id);
  runtime.openCodexAgentReceipts??=new Map();
  const receipt=require('../../../app.asar/opencodex/native-agent-runs.cjs').receiptFor(runtime,result.thread.id,config);
  if(receipt)runtime.openCodexAgentReceipts.set(result.thread.id,receipt);
  return result;
  }catch(error){
   permissions?.abort();
   review?.abort();
   await hooks?.abort();
   if(hookThreadId){runtime.openCodexThreads?.delete(hookThreadId);runtime.openCodexAgentReceipts?.delete(hookThreadId);runtime.openCodexPermissionReceipts?.delete(hookThreadId);runtime.openCodexGuardianReceipts?.delete(hookThreadId);}
   throw error;
  }
 }
 let permissionParameters;
 if(['turn/start','turn/steer','review/start'].includes(method)){
  permissionParameters=await deps.validateNativePermissions?.(runtime,p.threadId);
  guardian.validate(runtime,p.threadId);
 }
 if(['turn/start','turn/steer'].includes(method))p.input=await openCodexInput(runtime,p.input);
 if(method==='turn/start'||method==='review/start'){
  if(method==='review/start'&&p.delivery==='detached')throw Error('請先建立分支，再於該對話執行審查。');
  if(runtime.run)throw new Error('Runtime 正在執行工作，訊息未重送。');
  if(!runtime.executor?.isRunning||!runtime.snapshot.executorEnvironment)throw new Error('Mac Executor 未連線。');
  if(!runtime.openCodexThreads?.has(p.threadId))throw Error('請先重新開啟此對話，驗證 Mac 工具環境。');
  await refreshMacExtensions(runtime,deps);
  await deps.validateNativeHooks?.(runtime,p.threadId);
  // Check isolation before starting inference. Codex serializes inventory queries
  // behind active MCP calls, so querying after turn/start deadlocks with toolGate.
  if(runtime.openCodexDormantThreads?.has(p.threadId)){
   const inventory=[];let cursor;const seen=new Set();
   for(let page=0;page<100;page++){
    if(cursor&&seen.has(cursor))throw Error('Runtime 工具分頁異常。');if(cursor)seen.add(cursor);
    const result=await runtime.rpc.request('mcpServerStatus/list',{threadId:p.threadId,detail:'toolsAndAuthOnly',limit:100,...(cursor?{cursor}:{})},60000).catch(error=>{throw Error('SSH Runtime 工具清單：'+error.message,{cause:error});});
    if(!Array.isArray(result.data))throw Error('無法驗證 Runtime 工具隔離。');inventory.push(...result.data);cursor=result.nextCursor;
    if(!cursor)break;if(page===99)throw Error('Runtime 工具清單過大。');
   }
   const selected=inventory.find(i=>i.name===runtime.mcp.name);if(!selected)throw Error('Runtime 未登記 Mac 工具。');
   (0,runtime_policy_1.validateMacMcpInventory)(inventory,selected.runtimeStatus==='disabled'?undefined:runtime.mcp.name);
  }else await verifyThreadMcp(runtime,p.threadId);
  guardian.validate(runtime,p.threadId);
  let resolveTools;const toolGate=new Promise(resolve=>resolveTools=resolve);
  if(runtime.closed||runtime.openCodexPreparing?.cancelled)throw Error('工作初始化已取消。');
  const run={requestId:(0,node_crypto_1.randomUUID)(),cancelled:false,messages:new Map(),threadId:p.threadId,turnStarting:true,acceptUsage:true,openCodex:true,nativeReview:method==='review/start',ephemeral:runtime.openCodexPreparing?.ephemeral===true,toolGate};
  runtime.openCodexSubagents?.close();
  runtime.run=run;
  try{
  const receipt=runtime.openCodexAgentReceipts?.get(p.threadId);
  runtime.openCodexSubagents=receipt?new (require('../../../app.asar/opencodex/native-agent-runs.cjs').NativeAgentRuns)(runtime,deps,run,receipt):undefined;
  if(!receipt&&runtime.toolHost){delete runtime.toolHost.openCodexResolveRun;delete runtime.toolHost.openCodexWithRun;delete runtime.toolHost.openCodexCurrentRun;}
  delete p.cwd;delete p.sandboxPolicy;delete p.approvalPolicy;
  if(method==='turn/start')Object.assign(p,permissionParameters||{approvalPolicy:runtime.permissionMode==='full'?'never':'untrusted',sandboxPolicy:{type:runtime.permissionMode==='full'?'dangerFullAccess':'readOnly'}});
  if(method==='turn/start'&&guardian.effective(runtime)==='auto_review')Object.assign(p,{approvalsReviewer:'auto_review',approvalPolicy:'on-request'});
  p.environments=[{environmentId:runtime.executor.environmentId,cwd:runtime.localCwd}];
   const result=await runtime.rpc.request(method,p,60000);run.turnId=result.turn.id;
   runtime.openCodexDormantThreads?.delete(p.threadId);
   resolveTools(!run.cancelled);
   if(run.cancelled)await runtime.rpc.request('turn/interrupt',{threadId:run.threadId,turnId:run.nativeReview?(runtime.openCodexSubagents?.reviewTurnId||run.turnId):run.turnId});
   return result;
  }catch(error){resolveTools(false);runtime.openCodexSubagents?.close();if(runtime.run===run)runtime.run=undefined;throw error;}
 }
 if(method==='turn/interrupt'){
  if(runtime.openCodexSubagents){await runtime.openCodexSubagents.cancel(p.threadId,p.turnId);return {};}
  if(runtime.run&&runtime.run.threadId===p.threadId&&runtime.run.turnId===p.turnId){runtime.run.cancelled=true;runtime.toolHost?.cancelActive();}
  else throw Error('此回合已結束或不屬於目前工作。');
 }
 return runtime.rpc.request(method,p,60000);
};
