'use strict';
// Codex app-server on the SSH host; commands, files and MCP tools run through the Mac executor.
// Mirrors vendor/agentbridge runtime-backend.js without Electron.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const cfg=require('../config.cjs');
const {AppServerRpc,appServerCommand,chooseStdioFlag,accountSummary,modelSummary}=cfg.mod('app-server-rpc.js');
const {captureRemote,remoteLaunchError}=cfg.mod('remote-shell.js');
const {parseCodexVersion,findHostInstallation}=cfg.mod('local-code-mode-host.js');
const {LocalExecServer}=cfg.mod('local-exec-server.js');
const {isolatedRuntimeArgs,macThreadConfig,validateMacMcpInventory,isVerifiedExecutorVersion,VERIFIED_EXECUTOR_VERSIONS}=cfg.mod('runtime-policy.js');
const {macRuntimeInstructions,writeExtensionManifest}=cfg.mod('runtime-extensions.js');
const {codexPermissionPolicy}=cfg.mod('permission-policy.js');
const {rateLimitSummary,mergeRateLimitSummary}=cfg.mod('runtime-usage.js');
const {runtimeFailure}=cfg.mod('runtime-errors.js');
const {startToolHost}=require('../mac-tools.cjs');
class CodexDriver{
 constructor({ssh,cwd,executable,permissionMode,resources,toolOptions,onEvent,approve,askUser,authorizeTool,version}){
  Object.assign(this,{ssh,cwd,executable:executable||'codex',permissionMode,resources,toolOptions,onEvent,approve,askUser,authorizeTool,version});
  this.id='codex';this.label='Codex';this.runtimeId=crypto.randomUUID();this.closed=false;this.run=null;this.quota=null;this.catalog={items:[],warnings:[]};
  this.manifestPath=path.join(cfg.cliRoot,'runtime-extensions',this.runtimeId+'.json');
 }
 get busy(){return !!this.run;}
 emit(e){this.onEvent({provider:'codex',runtimeId:this.runtimeId,...e});}
 async start(){
  const {conn,platform}=this.ssh;
  const preflight=async args=>{try{return await captureRemote(conn,appServerCommand(platform,this.executable,args));}catch(e){throw remoteLaunchError(platform,e?.message||String(e));}};
  const version=parseCodexVersion(await preflight(['--version']));
  if(!version)throw Error('無法識別遠端 Codex CLI 版本。');
  const help=await preflight(['app-server','--help']);
  const flag=chooseStdioFlag(help);
  if(!isVerifiedExecutorVersion(version))throw Error('遠端 Codex '+version+' 尚未完成 Mac 工具路由驗證；目前支援 '+VERIFIED_EXECUTOR_VERSIONS.join('、')+'。');
  // Mac executor: the same Codex version bundled in OpenCodex.app runs commands/files on this Mac.
  const installation=await findHostInstallation(version,path.join(this.resources,'agentbridge'),process.env.OPENCODEX_CODE_MODE_HOST);
  this.executor=new LocalExecServer(installation,reason=>this.fail(reason));
  await this.executor.start(this.cwd);
  const executorUrl=await this.executor.reverseForward(conn);
  // The Mac MCP host is reached by the remote app-server through the executor environment, so no loopback forward is needed.
  this.tools=await startToolHost({conn,cwd:this.cwd,agentRole:'codex',permissionMode:this.permissionMode,resources:this.resources,options:{...this.toolOptions,forward:false},authorize:call=>this.authorize(call)});
  this.mcp={name:'agentbridge_mac_'+crypto.randomUUID().replaceAll('-',''),url:this.tools.endpoint.url,token:this.tools.endpoint.token,environmentId:this.executor.environmentId};
  const args=['app-server',...(flag==='--stdio'?['--stdio']:['--listen','stdio://']),...isolatedRuntimeArgs()];
  const channel=await new Promise((resolve,reject)=>conn.exec(appServerCommand(platform,this.executable,args,true),{pty:false},(e,s)=>e?reject(e):resolve(s)));
  let stderr='';channel.stderr.on('data',b=>{stderr=(stderr+b).slice(-2000);});
  this.rpc=new AppServerRpc(channel);
  this.rpc.on('request',m=>this.request(m));
  this.rpc.on('notification',m=>this.notification(m));
  this.rpc.on('closed',e=>{if(!this.closed)this.fail((e?.message||'App Server 已關閉。')+(stderr.includes('environments.toml')?' 遠端主機有 environments.toml 覆蓋設定，請先停用。':''));});
  try{
   await this.rpc.request('initialize',{clientInfo:{name:'opencodex_cli',title:'OpenCodex CLI',version:this.version},capabilities:{experimentalApi:true,requestAttestation:false}});
   this.rpc.notify('initialized');
   this.environment=await this.executor.register(this.rpc,executorUrl);
   const [account,models]=await Promise.all([this.rpc.request('account/read',{refreshToken:false}),this.listModels()]);
   this.account=accountSummary(account);this.modelList=models;this.runtimeVersion=version;
  }catch(e){await this.stop();throw e;}
  return this.status();
 }
 // Threads stored on the runtime host (created by this CLI, the App or the host's own Codex CLI).
 async listThreads(limit=60){
  const data=[];let cursor;
  for(let i=0;i<10&&data.length<limit;i++){
   let r;const params={limit:Math.min(50,limit-data.length),...(cursor?{cursor}:{})};
   try{r=await this.rpc.request('thread/list',{...params,sortKey:'updated_at'});}catch{r=await this.rpc.request('thread/list',params);}
   data.push(...(r.data||[]));if(!r.nextCursor||r.nextCursor===cursor||!(r.data||[]).length)break;cursor=r.nextCursor;
  }
  return data.filter(t=>t&&typeof t.id==='string'&&!t.ephemeral&&!t.parentThreadId).map(t=>({id:t.id,title:(t.name||String(t.preview||'').replace(/^# Files mentioned by the user:[\s\S]*?## My request:\s*/,'').trim().split('\n')[0]||'（無標題）').slice(0,80),model:t.model||null,effort:t.reasoningEffort||null,updatedAt:Number(t.updatedAt||t.createdAt||0)*1000,cwd:t.cwd||null,source:t.source||t.threadSource||null}));
 }
 async readThread(threadId){const r=await this.rpc.request('thread/read',{threadId,includeTurns:true},30000);return r.thread;}
 async listModels(){const data=[];let cursor;for(let i=0;i<20;i++){const r=await this.rpc.request('model/list',cursor?{cursor}:{});data.push(...(r.data||[]));if(!r.nextCursor||r.nextCursor===cursor)break;cursor=r.nextCursor;}return modelSummary({data});}
 status(){return {provider:'codex',connected:!this.closed,runtimeVersion:this.runtimeVersion,account:{...this.account,authenticated:this.account?.authenticated===true&&this.account?.type==='chatgpt',authMethod:this.account?.type==='chatgpt'?'ChatGPT'+(this.account.planType?' · '+this.account.planType:''):this.account?.type||'未登入'},models:this.modelList||[],quota:this.quota,tools:this.tools?.host.status().tools||[],executor:this.environment?.shell?.path};}
 models(){return (this.modelList||[]).map(m=>({...m,provider:'codex'}));}
 async refreshQuota(){try{const raw=await this.rpc.request('account/rateLimits/read',{},15000);this.quota=rateLimitSummary(raw);}catch(e){this.quota={...(this.quota||{}),error:e.message};}return this.quota;}
 async authorize(call){
  if(!this.run||this.run.cancelled)return false;
  if(call.category==='agent-bridge'||this.permissionMode==='full'||(this.permissionMode==='project'&&call.category==='filesystem-read'))return true;
  return this.authorizeTool({provider:'codex',name:call.name,arguments:call.arguments,signal:call.signal});
 }
 request(m){
  const p=m.params||{};
  if(m.method==='currentTime/read')return this.rpc.respond(m.id,{currentTimeAt:Math.floor(Date.now()/1000)});
  if(m.method==='account/chatgptAuthTokens/refresh'||m.method==='attestation/generate')return this.rpc.reject(m.id,'Account credentials remain managed on the Runtime host.');
  if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput'].includes(m.method))return this.rpc.reject(m.id,'This client has no verified local executor for the requested capability.');
  const run=this.run;
  if(!run||run.cancelled||(p.threadId&&p.threadId!==run.threadId))return this.rpc.reject(m.id,'The request does not belong to an active client turn.');
  if(m.method==='item/commandExecution/requestApproval'&&p.environmentId!==this.executor?.environmentId)return this.rpc.reject(m.id,'Command approval is not bound to the Mac executor.');
  if(m.method==='item/tool/requestUserInput'){
   Promise.resolve(this.askUser(p.questions||[])).then(answers=>{if(!this.rpc.isClosed)this.rpc.respond(m.id,{answers});}).catch(()=>{if(!this.rpc.isClosed)this.rpc.reject(m.id,'declined');});
   return;
  }
  if(this.permissionMode==='full')return this.rpc.respond(m.id,{decision:'accept'});
  const title=m.method.includes('fileChange')?'允許 Codex 修改 Mac 檔案？':'允許 Codex 在 Mac 執行命令？';
  const detail=m.method.includes('fileChange')?(p.changes||[]).map(c=>c.path).filter(Boolean).join('\n')||p.reason||'':[Array.isArray(p.command)?p.command.join(' '):p.command,p.cwd?'工作目錄：'+p.cwd:'',p.reason].filter(Boolean).join('\n');
  Promise.resolve(this.approve({provider:'codex',title,detail})).then(decision=>{if(!this.rpc.isClosed)this.rpc.respond(m.id,{decision:decision==='acceptForSession'?'acceptForSession':decision==='accept'?'accept':'decline'});}).catch(()=>{if(!this.rpc.isClosed)this.rpc.respond(m.id,{decision:'decline'});});
 }
 notification(m){
  const p=m.params||{};
  if(m.method==='account/rateLimits/updated'){this.quota=mergeRateLimitSummary(this.quota,p);return;}
  if(m.method==='account/updated'){this.account=accountSummary({account:typeof p.authMode==='string'?{type:p.authMode,planType:p.planType}:null});return;}
  if(m.method==='thread/compacted'){this.emit({type:'activity',text:'Codex 對話上下文已自動壓縮'});return;}
  const run=this.run;if(!run)return;
  if(p.threadId&&run.threadId&&p.threadId!==run.threadId)return;
  const turnId=p.turnId||p.turn?.id;if(turnId&&run.turnId&&turnId!==run.turnId)return;
  if(m.method==='turn/started'){run.turnId=p.turn?.id;this.emit({type:'activity',text:'Codex 正在思考'});}
  else if(m.method==='item/agentMessage/delta'){const id=p.itemId||'assistant';run.messages.set(id,(run.messages.get(id)||'')+(p.delta||''));this.emit({type:'message',text:[...run.messages.values()].join('\n\n')});}
  else if(m.method==='item/completed'&&p.item?.type==='agentMessage'){run.messages.set(p.item.id,p.item.text||'');this.emit({type:'message',text:[...run.messages.values()].join('\n\n')});}
  else if(['item/started','item/completed'].includes(m.method)&&['commandExecution','fileChange','mcpToolCall'].includes(p.item?.type)){
   const item=p.item,end=m.method==='item/completed';const content=Array.isArray(item.result?.content)?item.result.content:[];
   const text=typeof item.aggregatedOutput==='string'?item.aggregatedOutput.slice(-16000):content.filter(b=>b?.type==='text').map(b=>b.text).join('\n').slice(-16000);
   const title=item.type==='commandExecution'?(Array.isArray(item.command)?item.command.join(' '):item.command||'shell'):item.type==='fileChange'?'修改檔案 '+(item.changes||[]).map(c=>c.path).filter(Boolean).join(', '):(item.tool||item.server||'tool')+(item.server&&!String(item.server).startsWith('agentbridge_mac')?' ('+item.server+')':'');
   this.emit({type:'tool',itemId:item.id,tool:item.tool||item.type,title,text:end?text:JSON.stringify(item.arguments||{}),status:end?(item.status==='failed'||item.error||item.result?.isError?'error':'completed'):'running'});
  }
  else if(m.method==='item/started'&&p.item?.type==='reasoning')this.emit({type:'activity',text:'正在思考'});
  else if(m.method==='item/started'&&p.item?.type==='webSearch')this.emit({type:'activity',text:'正在搜尋'});
  else if(m.method==='error'){if(p.willRetry===true){this.emit({type:'activity',text:'Runtime 正在重試連線'});return;}const f=runtimeFailure(p.error||p);run.error=f.text;this.emit({type:'error',text:f.text});}
  else if(m.method==='turn/completed'){
   const turn=p.turn||{};const raw=turn.error||p.error;const failed=turn.status==='failed'||turn.status==='error';
   const failure=raw||failed?runtimeFailure(raw||turn.statusDetails?.message||turn.failureReason):undefined;
   if(failure?.text){run.error=failure.text;this.emit({type:'error',text:failure.text});}
   this.tools?.host.cancelActive();
   const status=run.cancelled||turn.status==='interrupted'?'cancelled':failed||run.error?'error':'completed';
   this.run=null;this.emit({type:'done',status,conversationId:run.threadId,error:run.error,requestId:run.requestId});
  }
 }
 async send(input){
  if(this.closed)throw Error('Codex 尚未連線。');
  if(this.run)throw Error('Codex 仍在處理上一則訊息。');
  if(!this.account?.authenticated||this.account.type!=='chatgpt')throw Error('遠端 Codex 尚未登入 ChatGPT；請在主機執行 codex login。');
  if(!this.environment)throw Error('Mac Executor 尚未就緒；不會改在遠端主機執行工具。');
  const run={requestId:input.requestId||crypto.randomUUID(),cancelled:false,messages:new Map(),threadId:input.conversationId||null};
  this.run=run;
  setImmediate(async()=>{
   try{
    await writeExtensionManifest(this.manifestPath,this.catalog);
    const configuration=await this.rpc.request('config/read',{includeLayers:false});
    if(this.run!==run)return;
    const config=macThreadConfig(configuration.config,this.mcp,70);
    const base={developerInstructions:[macRuntimeInstructions(this.cwd,this.manifestPath,this.tools.host.status().tools,this.catalog),input.systemPrompt].filter(Boolean).join('\n\n'),model:input.model||undefined,config,...codexPermissionPolicy(this.permissionMode)};
    const thread=await this.rpc.request(input.conversationId?'thread/resume':'thread/start',input.conversationId?{threadId:input.conversationId,...base}:{...base,environments:[{environmentId:this.executor.environmentId,cwd:this.cwd}]});
    if(this.run!==run)return;
    run.threadId=thread.thread.id;
    // Codex 0.160 resumes a thread with no selected environment; the environment-scoped Mac MCP
    // stays disabled until turn/start selects this Mac. Verify isolation accordingly.
    const envs=thread.thread.environments;
    const dormant=!!input.conversationId&&!(Array.isArray(envs)&&envs.some(e=>e?.environmentId===this.executor.environmentId));
    await this.verifyThreadMcp(run.threadId,dormant);
    if(this.run!==run)return;
    this.emit({type:'session',conversationId:run.threadId});
    if(run.cancelled){this.run=null;this.emit({type:'done',status:'cancelled',conversationId:run.threadId,requestId:run.requestId});return;}
    const text=[input.prompt];
    const result=await this.rpc.request('turn/start',{threadId:run.threadId,environments:[{environmentId:this.executor.environmentId,cwd:this.cwd}],input:text.map(t=>({type:'text',text:t,text_elements:[]})),model:input.model||undefined,effort:input.effort||undefined});
    if(this.run!==run)return;
    run.turnId=result.turn.id;
    if(run.cancelled)await this.rpc.request('turn/interrupt',{threadId:run.threadId,turnId:run.turnId});
   }catch(e){
    if(this.run!==run)return;
    const f=/already has an active writer/i.test(e?.message||'')?{text:'這個對話目前正被另一個用戶端（例如 OpenCodex App）使用；請先在那邊結束或關閉它，再於此接續。'}:runtimeFailure(e);this.run=null;
    this.emit({type:'error',text:f.text});this.emit({type:'done',status:'error',error:f.text,conversationId:run.threadId,requestId:run.requestId});
   }
  });
  return {requestId:run.requestId};
 }
 async verifyThreadMcp(threadId,dormant=false){
  const inventory=[];let cursor;
  for(let i=0;i<100;i++){
   const r=await this.rpc.request('mcpServerStatus/list',{threadId,detail:'toolsAndAuthOnly',limit:100,...(cursor?{cursor}:{})},60000);
   if(!Array.isArray(r.data))throw Error('Runtime 未提供有效的 MCP 工具清單。');inventory.push(...r.data);
   if(!r.nextCursor){
    if(dormant){const selected=inventory.find(s=>s.name===this.mcp.name);if(!selected)throw Error('Runtime 未登記 Mac 工具；請重新連線。');validateMacMcpInventory(inventory,selected.runtimeStatus==='disabled'?undefined:this.mcp.name);return;}
    validateMacMcpInventory(inventory,this.mcp.name);return;
   }
   if(r.nextCursor===cursor)break;cursor=r.nextCursor;
  }
  throw Error('Runtime MCP 工具清單無法完整驗證。');
 }
 async cancel(){
  const run=this.run;if(!run)return {cancelled:false};
  run.cancelled=true;this.tools?.host.cancelActive();
  if(run.threadId&&run.turnId){try{await this.rpc.request('turn/interrupt',{threadId:run.threadId,turnId:run.turnId});}catch{}}
  return {cancelled:true};
 }
 fail(reason){
  if(this.closed)return;this.closed=true;
  const run=this.run;this.run=null;
  if(run)this.emit({type:'done',status:'error',error:reason,conversationId:run.threadId,requestId:run.requestId});
  this.emit({type:'closed',text:reason});
  void this.cleanup();
 }
 async cleanup(){try{this.rpc?.close();}catch{}this.executor?.stop();await this.tools?.stop().catch(()=>{});try{fs.rmSync(this.manifestPath,{force:true});}catch{}}
 async stop(){if(this.closed)return;this.closed=true;const run=this.run;this.run=null;if(run)this.emit({type:'done',status:'cancelled',conversationId:run.threadId,requestId:run.requestId});await this.cleanup();}
}
module.exports={CodexDriver};
