// Appended inside the original AgentBridge runtime module; reuse its policies.
exports.openCodexRuntimes = runtimes;
async function openCodexInput(runtime,input){
 return await Promise.all((input||[]).map(async item=>{
   if(item.type==='localImage'){
    const file=await node_fs_1.default.promises.realpath(item.path);
    const stat=await node_fs_1.default.promises.stat(file);
    if(stat.size>20*1024*1024)throw new Error('圖片超過 20 MiB。');
    const b=await node_fs_1.default.promises.readFile(file);
    const ext=node_path_1.default.extname(file).toLowerCase();
    const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}[ext];
    if(!mime)throw new Error('不支援的圖片格式。');
    return {type:'image',url:'data:'+mime+';base64,'+b.toString('base64')};
   }
   if(item.type==='localAudio'){
    const file=await node_fs_1.default.promises.realpath(item.path),stat=await node_fs_1.default.promises.stat(file);
    if(stat.size>20*1024*1024)throw Error('音訊超過 20 MiB。');
    const mime={'.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.ogg':'audio/ogg','.webm':'audio/webm'}[node_path_1.default.extname(file).toLowerCase()];
    if(!mime)throw Error('不支援的音訊格式。');
    return {type:'audio',url:'data:'+mime+';base64,'+(await node_fs_1.default.promises.readFile(file)).toString('base64')};
   }
   if(item.type==='skill'){
    const entry=runtime.extensionCatalog?.items.find(s=>s.kind==='skill'&&s.enabled&&s.path===item.path);
    if(!entry)throw Error('此 Mac Skill 未啟用，請先重新載入 Skills。');
    const stat=await node_fs_1.default.promises.stat(item.path);
    if(stat.size>1024*1024)throw Error('Skill 檔案超過 1 MiB。');
    const content=await node_fs_1.default.promises.readFile(item.path,'utf8');
    return {type:'text',text:'使用者選取的 Mac Skill：'+item.name+'\n位置：'+item.path+'\n相對路徑以該 Mac 目錄為準。\n\n'+content,text_elements:[]};
   }
   return item;
  }));
}

exports.openCodexRequest = async function(runtime, deps, method, params = {}) {
 if(runtime.closed) throw new Error('SSH 連線已中斷，請重新連線。');
 if(runtime.openCodexWorkspaceFailed)throw Error('專案工具初始化失敗，請重新選擇專案或重新連線。');
 if(method.startsWith('thread/queue/'))throw Error('排隊訊息必須由 OpenCodex 排程，不能交由遠端自動執行。');
 const p={...params};
 // Mac workspace roots belong to the registered executor, never the Windows Runtime.
 delete p.runtimeWorkspaceRoots;delete p.permissions;delete p.approvalsReviewer;
 if(method==='initialize') return runtime.openCodexInitialized;
 if(method==='thread/settings/update'){
  delete p.cwd; // The workspace lease updates the Mac host; never send its path to the peer.
  if(params.permissions!=null||params.sandboxPolicy!=null||params.approvalPolicy!=null){
   p.approvalPolicy=runtime.permissionMode==='full'?'never':'untrusted';
   p.sandboxPolicy={type:runtime.permissionMode==='full'?'dangerFullAccess':'readOnly'};
  }
 }
 if(method==='thread/start'||method==='thread/resume'||method==='thread/fork'){
  if(!runtime.executor?.isRunning||!runtime.mcp)throw new Error('Mac Executor 與工具通道尚未就緒。');
  if(runtime.run)throw new Error('Runtime 正在執行工作。');
  await refreshMacExtensions(runtime,deps);
  const configuration=await runtime.rpc.request('config/read',{includeLayers:false});
  const config=(0,runtime_policy_1.macThreadConfig)(configuration.config,runtime.mcp,runtime.autoCompactPercent);
  require('../../../app.asar/opencodex/native-agent-runs.cjs').configureSubagents(runtime,configuration.config,config);
  const hooks=await deps.prepareNativeHooks?.(runtime);let hookThreadId=p.threadId;
  try{
  if(hooks)Object.assign(config,hooks.config);
  delete p.cwd;delete p.sandboxPolicy; // Native dynamic tools execute through the frontend request handler.
  p.config=config;
  Object.assign(p,(0,permission_policy_1.codexPermissionPolicy)(runtime.permissionMode));
  p.developerInstructions=[p.developerInstructions,(0,runtime_extensions_1.macRuntimeInstructions)(runtime.localCwd,runtime.manifestPath,runtime.toolHost?.status().tools||[],runtime.extensionCatalog)].filter(Boolean).join('\n\n');
  if(method==='thread/start')p.environments=[{environmentId:runtime.executor.environmentId,cwd:runtime.localCwd}];
  if(runtime.closed||runtime.openCodexPreparing?.cancelled)throw Error('工作初始化已取消。');
  let result=await runtime.rpc.request(method,p,60000);hookThreadId=result.thread.id;
  if(method==='thread/fork')result=await runtime.rpc.request('thread/resume',{...p,threadId:result.thread.id},60000);
  // Codex 0.160 resumes with no selected environments. Its environment-scoped
  // MCP stays disabled until turn/start selects the Mac; all other servers must
  // remain disabled before a model turn may begin.
  const dormant=method!=='thread/start'&&Array.isArray(result.thread.environments)&&result.thread.environments.length===0;
  if(dormant){
   const inventory=[];let cursor;
   do{const page=await runtime.rpc.request('mcpServerStatus/list',{threadId:result.thread.id,limit:100,...(cursor?{cursor}:{})},60000).catch(error=>{throw Error('SSH Runtime 工具清單：'+error.message,{cause:error});});if(!Array.isArray(page.data))throw Error('無法驗證 Runtime 工具隔離。');inventory.push(...page.data);if(page.nextCursor===cursor&&cursor)throw Error('Runtime 工具分頁異常。');cursor=page.nextCursor;if(inventory.length>10000)throw Error('Runtime 工具清單過大。');}while(cursor);
   const selected=inventory.find(i=>i.name===runtime.mcp.name);
   if(!selected)throw Error('Runtime 未登記 Mac 工具。');
   if(selected.runtimeStatus==='disabled'){
    (0,runtime_policy_1.validateMacMcpInventory)(inventory,undefined);
   }else await verifyThreadMcp(runtime,result.thread.id,config);
  }else await verifyThreadMcp(runtime,result.thread.id,config);
  if(runtime.closed||runtime.openCodexPreparing?.cancelled)throw Error('工作初始化已取消。');
  await hooks?.commit(result.thread.id);
  runtime.openCodexDormantThreads??=new Set();
  if(dormant)runtime.openCodexDormantThreads.add(result.thread.id);else runtime.openCodexDormantThreads.delete(result.thread.id);
  runtime.openCodexThreads??=new Set();runtime.openCodexThreads.add(result.thread.id);
  runtime.openCodexAgentReceipts??=new Map();
  const receipt=require('../../../app.asar/opencodex/native-agent-runs.cjs').receiptFor(runtime,result.thread.id,config);
  if(receipt)runtime.openCodexAgentReceipts.set(result.thread.id,receipt);
  return result;
  }catch(error){
   await hooks?.abort();
   if(hookThreadId){runtime.openCodexThreads?.delete(hookThreadId);runtime.openCodexAgentReceipts?.delete(hookThreadId);}
   throw error;
  }
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
    const result=await runtime.rpc.request('mcpServerStatus/list',{threadId:p.threadId,limit:100,...(cursor?{cursor}:{})},60000).catch(error=>{throw Error('SSH Runtime 工具清單：'+error.message,{cause:error});});
    if(!Array.isArray(result.data))throw Error('無法驗證 Runtime 工具隔離。');inventory.push(...result.data);cursor=result.nextCursor;
    if(!cursor)break;if(page===99)throw Error('Runtime 工具清單過大。');
   }
   const selected=inventory.find(i=>i.name===runtime.mcp.name);if(!selected)throw Error('Runtime 未登記 Mac 工具。');
   (0,runtime_policy_1.validateMacMcpInventory)(inventory,selected.runtimeStatus==='disabled'?undefined:runtime.mcp.name);
  }else await verifyThreadMcp(runtime,p.threadId);
  let resolveTools;const toolGate=new Promise(resolve=>resolveTools=resolve);
  if(runtime.closed||runtime.openCodexPreparing?.cancelled)throw Error('工作初始化已取消。');
  const run={requestId:(0,node_crypto_1.randomUUID)(),cancelled:false,messages:new Map(),threadId:p.threadId,turnStarting:true,acceptUsage:true,openCodex:true,nativeReview:method==='review/start',ephemeral:runtime.openCodexPreparing?.ephemeral===true,toolGate};
  runtime.openCodexSubagents?.close();
  runtime.run=run;
  const receipt=runtime.openCodexAgentReceipts?.get(p.threadId);
  runtime.openCodexSubagents=receipt?new (require('../../../app.asar/opencodex/native-agent-runs.cjs').NativeAgentRuns)(runtime,deps,run,receipt):undefined;
  if(!receipt&&runtime.toolHost){delete runtime.toolHost.openCodexResolveRun;delete runtime.toolHost.openCodexWithRun;delete runtime.toolHost.openCodexCurrentRun;}
  try{
  delete p.cwd;delete p.sandboxPolicy;delete p.approvalPolicy;
  if(method==='turn/start')Object.assign(p,{approvalPolicy:runtime.permissionMode==='full'?'never':'untrusted',sandboxPolicy:{type:runtime.permissionMode==='full'?'dangerFullAccess':'readOnly'}});
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
