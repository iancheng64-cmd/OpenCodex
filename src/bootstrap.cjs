'use strict';
const Module=require('node:module'),nativeLoad=Module._load;
const safeStorage=require('./safe-storage.cjs');
Module._load=function(name,...args){const result=nativeLoad.call(this,name,...args);return name==='electron'?new Proxy(result,{get(target,key){return key==='safeStorage'?safeStorage:Reflect.get(target,key);}}):result;};
const {app,ipcMain,BrowserWindow,Menu,dialog}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process'),EventEmitter=require('node:events');
const openCodexVersion=require('../package.json').openCodexVersion;
const root=path.join(app.getPath('appData'),'OpenCodex');
fs.mkdirSync(root,{recursive:true,mode:0o700});
const {ApprovalGrants,approvalScope,appScope}=require('./native-approvals.cjs');
const approvalGrants=new ApprovalGrants(path.join(root,'tool-approvals.json'));
app.setName('OpenCodex');
for(const key of ['CODEX_ELECTRON_DEV_PARENT_PID','CODEX_ELECTRON_DEV_WEBVIEW_PID','CODEX_ELECTRON_DEV_RELAUNCH_MARKER_PATH'])delete process.env[key];
const configFile=path.join(root,'opencodex.json');
let settings={mode:'ssh',sshAgent:'codex',profileName:'msi',cwd:os.homedir(),permissionMode:'project',fullAccess:false};
try{settings={...settings,...JSON.parse(fs.readFileSync(configFile,'utf8'))};}catch{}
const save=()=>{const tmp=configFile+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(settings,null,2),{mode:0o600,flag:'wx'});fs.renameSync(tmp,configFile);}finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}};
if(settings.mode==='bridge'){settings.mode='ssh';save();}
const isRemote=()=>settings.mode==='ssh';
const isClaude=()=>isRemote()&&settings.sshAgent==='claude';
const {nativeProfile,prepareProfile,codexConnection,claudeConnection}=require('./native-profile.cjs');
const profilePaths=nativeProfile(root,settings),codexHome=profilePaths.home;
fs.mkdirSync(profilePaths.userData,{recursive:true,mode:0o700});
app.setPath('userData',profilePaths.userData);app.setPath('sessionData',profilePaths.userData);
process.env.CODEX_ELECTRON_USER_DATA_PATH=profilePaths.userData;
process.env.CODEX_HOME=codexHome;process.env.CODEX_SQLITE_HOME=path.join(codexHome,'sqlite');
process.env.OPENCODEX_EXTENSION_HOME=path.join(os.homedir(),'.codex');
const register=app.setAsDefaultProtocolClient.bind(app);
app.setAsDefaultProtocolClient=(scheme,...args)=>register(scheme==='codex'?'opencodex':scheme,...args);
const remove=app.removeAsDefaultProtocolClient.bind(app);
app.removeAsDefaultProtocolClient=(scheme,...args)=>scheme==='codex'?false:remove(scheme,...args);
const abRoot=path.join(process.resourcesPath,'agentbridge','app');
prepareProfile(root,profilePaths,require(path.join(abRoot,'node_modules/smol-toml')));
const {WebSocketServer}=require(path.join(abRoot,'node_modules/ws'));
const {AppServerRpc}=require(path.join(abRoot,'dist-main/app-server-rpc.js'));
const handlers=new Map(),handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(name,fn)=>{if(!name.startsWith('codex:'))handlers.set(name,fn);return handle(name,fn);};
let bridge,backend,runtime,claude,agents,peer,bridgeError,localRpc,localChild;
let connecting=false,hostConfirmation=null,pendingConnection=null,permissionChanging=false;
const {validateProfile,validateCwd}=require('./ssh-profiles.cjs');
const clients=new Set(),pendingServer=new Map(),knownFile=path.join(root,'native-threads.json');
let known={};try{known=JSON.parse(fs.readFileSync(knownFile,'utf8'));}catch{}
const auditFile=path.join(root,'adapter-events.jsonl');
function audit(type,data={}){fs.appendFileSync(auditFile,JSON.stringify({at:new Date().toISOString(),type,...data})+'\n',{mode:0o600});}
const {connectionState}=require('./native-connection.cjs');
function publicState(){const grants=approvalGrants.list();return {agents:agents?.state()||null,fullAccess:settings.fullAccess===true,permissionBusy:!!agents?.active||permissionChanging||!!runtime?.run||!!runtime?.openCodexPreparing||localTurns.size>0||!!nativeShell.active||!!nativeQueue.starting,approvalGrants:grants,codexConnections:settings.codexConnections||{},claudeConnections:settings.claudeConnections||{},approvalError:approvalGrants.error,mode:settings.mode,sshAgent:settings.sshAgent,profile:runtime?.snapshot?.hostName||settings.profileName,transport:runtime?.snapshot?.transport||null,cwd:runtime?.localCwd||settings.cwd,...connectionState(runtime),error:bridgeError||null,version:openCodexVersion,quota:quotaMonitor.snapshot(),connecting,hostConfirmation,profileId:runtime?.snapshot?.profileId||settings.profileId||null,permissionMode:runtime?.permissionMode||settings.permissionMode,runtimeVersion:runtime?.snapshot?.runtimeVersion||null,engine:'opencodex-direct-ssh',agentBridgeAppLoaded:Object.keys(require.cache).some(k=>k===path.join(abRoot,'dist-main/main.js')),...(isClaude()&&claude?{...claude.state(),permissionBusy:!!agents?.active||permissionChanging||claude.busy||claude.queue.starting}: {})};}
const {rateLimitSummary}=require(path.join(abRoot,'dist-main/runtime-usage.js'));
const quotaMonitor=require('./quota.cjs')({normalize:rateLimitSummary,publish,getSource:()=>isRemote()?(runtime&&!runtime.closed?{key:runtime.id,rpc:runtime.rpc,label:(runtime.snapshot.transport==='https-relay'?'HTTPS/WSS Runtime · ':'SSH Runtime · ')+runtime.snapshot.hostName}:null):(localRpc&&!localRpc.isClosed?{key:settings.mode,rpc:localRpc,label:settings.mode==='official'?'本機官方登入':'自訂 API'}:null)});
function send(ws,value){if(ws.readyState===1)ws.send(JSON.stringify(value));}
function forwardNativeRequest(message,rpc,scope={}){
 const ws=[...clients].find(w=>w.readyState===1);if(!ws)return false;
 const id='native:'+crypto.randomUUID();pendingServer.set(id,{rpc,id:message.id,ws,...scope});
 send(ws,{...message,id});return true;
}
async function localRequest(method,params,timeout=60000){
 const mutation=/^(plugin\/(install|uninstall|enable|disable)|skills\/config\/write|config\/(value\/write|batchWrite|mcpServer\/reload)|mcpServer\/reload)$/.test(method);
 if(mutation&&(agents?.active||claude?.busy||claude?.queue.starting||runtime?.run||runtime?.openCodexPreparing||nativeShell.active||nativeQueue.starting))throw Error('請先停止工作，再變更工具或外掛設定。');
 const result=await localRpc.request(method,params,timeout);
 if(mutation)bridge?.invalidateNativeTools();
 return result;
}
function publish(){for(const w of BrowserWindow.getAllWindows())w.webContents.send('opencodex:status',publicState());}
function local(){
 if(localRpc&&!localRpc.isClosed)return localRpc;
 localChild=cp.spawn(path.join(process.resourcesPath,'codex-cli/CodexCLI.app/Contents/MacOS/codex'),['app-server','--listen','stdio://','-c','features.code_mode_host=true'],{env:{...process.env,CODEX_INTERNAL_ORIGINATOR_OVERRIDE:'OpenCodex'},stdio:['pipe','pipe','pipe']});
 const transport=new EventEmitter();transport.write=s=>localChild.stdin.write(s);transport.close=()=>localChild.kill('SIGTERM');
 localChild.stdout.on('data',d=>transport.emit('data',d));
 localChild.on('error',e=>transport.emit('error',e));localChild.on('close',()=>transport.emit('close'));
 localChild.stderr.on('data',()=>{}); // Authenticated provider output is deliberately not logged.
 localRpc=new AppServerRpc(transport);
 localRpc.on('notification',m=>{if(m.method==='turn/started')localTurns.add(m.params.threadId);if(m.method==='turn/completed')localTurns.delete(m.params.threadId);if(m.method==='turn/started'||m.method==='turn/completed')setImmediate(publish);if(isRemote()&&nativeShell.notification(m))return;if(!isRemote()||!(/^(thread\/|turn\/|item\/|account\/)/.test(m.method))){for(const ws of clients)send(ws,m);if(!isRemote()&&m.method==='account/updated')quotaMonitor.invalidate();else if(!isRemote()&&(m.method==='account/rateLimits/updated'||m.method==='turn/completed'))quotaMonitor.refresh();}});
 localRpc.on('request',m=>{const ws=[...clients][0];if(ws){const id='local:'+m.id;pendingServer.set(id,{rpc:localRpc,id:m.id,ws});send(ws,{...m,id});}else localRpc.reject(m.id,'Frontend disconnected');});
 return localRpc;
}
let localReady;const localTurns=new Set();
const nativeShell=new (require('./native-shell.cjs').NativeShell)({file:path.join(root,'native-shell-history.json'),ready:readyLocal,getRpc:()=>localRpc,emit:message=>{for(const ws of clients)send(ws,message);if(message.method==='turn/completed'){if(runtime)void refreshHistory(runtime,message.params.threadId);nativeQueue.completed(runtime?.snapshot?.profileId,message.params.threadId,message.params.turn.status);}},onError:error=>audit('native-shell-error',{message:error.message})});
const nativeQueue=new (require('./native-queue.cjs').NativeQueue)({file:path.join(root,'native-queue.json'),context:()=>({profile:runtime?.snapshot?.profileId,connected:isRemote()&&!!runtime&&!runtime.closed&&clients.size>0,busy:!!runtime?.run||!!runtime?.openCodexPreparing||!!nativeShell.active,ready:id=>runtime?.openCodexThreads?.has(id)&&known[id]?.profile===runtime?.snapshot?.profileId}),start:(threadId,input)=>request([...clients][0],'turn/start',{threadId,input},true),emit:message=>{for(const ws of clients)send(ws,message);},onError:error=>{bridgeError='排隊訊息未確認送出：'+error.message;audit('native-queue-error',{message:error.message});publish();}});
function readyLocal(){if(localRpc?.isClosed)localReady=null;if(!localReady){const rpc=local();localReady=rpc.request('initialize',{clientInfo:{name:'opencodex',title:'OpenCodex',version:openCodexVersion},capabilities:{experimentalApi:true}}).then(r=>{rpc.notify('initialized');if(!isRemote())quotaMonitor.refresh();return r;}).catch(e=>{localReady=null;throw e;});}return localReady;}
async function connectBridge(input={}){
 if(!isRemote())throw Error('請先切換至 SSH 模式。');
 if(connecting||permissionChanging)throw Error('連線或權限正在更新，請稍候。');
 if(agents?.active||claude?.busy||claude?.queue.starting||runtime?.run||runtime?.openCodexPreparing||localTurns.size||nativeShell.active||nativeQueue.starting)throw Error('請先停止目前工作再切換主機。');
 const asPeer=input.confirmationId?pendingConnection?.asPeer===true:input.peer===true;
 if(asPeer&&!(isClaude()?claude.connected:runtime&&!runtime.closed))throw Error('請先連接主要 Agent，再連接協作 Agent。');
 const targetClaude=asPeer?!isClaude():isClaude();
 const profiles=await handlers.get('profiles:list')({});
 const profile=profiles.find(p=>p.id===(input.profileId||settings.profileId))||(!input.profileId?profiles.find(p=>p.name===settings.profileName)||profiles[0]:null);
 if(!profile)throw Error('請在側邊欄 SSH 連線新增主機。');
 validateProfile(profile);const localCwd=validateCwd(input.cwd||settings.cwd);
 let params={profile:{...profile,networkMode:'direct'},platform:profile.runtimePlatform||'auto',localCwd,permissionMode:nativePolicy.resolveMode({},null,settings).effective,autoCompactPercent:70,password:input.password,...(targetClaude?claudeConnection(input.claude||settings.claudeConnections?.[profile.id]):codexConnection(settings.codexConnections?.[profile.id]))};
 if(input.confirmationId){
  if(!pendingConnection||pendingConnection.id!==input.confirmationId||pendingConnection.expires<Date.now()||pendingConnection.params.profile.id!==profile.id)throw Error('主機金鑰確認已過期，請重新連線。');
  params={...pendingConnection.params,trustedFingerprint:pendingConnection.fingerprint};
 }
 pendingConnection=null;hostConfirmation=null;connecting=true;bridgeError=null;publish();
 try{
  const previous=asPeer?peer:isClaude()?claude.runtime:runtime,result=await handlers.get(targetClaude?'claude:connect':'runtime:connect')({sender:null},params);
  if(!result.runtimeId){
   if(result.status==='host-confirmation'){
    const id=crypto.randomUUID();pendingConnection={id,params,asPeer,fingerprint:result.hostFingerprint,expires:Date.now()+300000};
    hostConfirmation={id,peer:asPeer,profileId:profile.id,host:profile.host,port:profile.port,...result};publish();return publicState();
   }
   throw Error('遠端 Agent 未成功啟動。');
  }
  const next=targetClaude?bridge.claudeBackend.openCodexClaudeRuntimes.get(result.runtimeId):backend.openCodexRuntimes.get(result.runtimeId);
  if(asPeer){peer=next;if(targetClaude){peer.localCwd=peer.cwd;peer.toolHost=peer.host;}else peer.rpc.on('closed',publish);settings.peerProfileId=profile.id;}
  else {await disconnectPeer();if(isClaude())claude.attach(next,result);else attach(next);settings.profileId=profile.id;settings.profileName=profile.name;settings.cwd=localCwd;}
  if(targetClaude)settings.claudeConnections={...settings.claudeConnections,[profile.id]:claudeConnection(params)};
  save();
  if(previous&&previous!==next&&!previous.closed)await handlers.get(targetClaude?'claude:disconnect':'runtime:disconnect')({},targetClaude?previous.cli.id:previous.id);
  notifyRemoteState();
  return publicState();
 }catch(e){bridgeError=e.message;throw e;}finally{connecting=false;publish();}
}
async function disconnectPeer(){
 const previous=peer;peer=null;
 if(previous&&!previous.closed)await handlers.get(previous.cli?'claude:disconnect':'runtime:disconnect')({},previous.cli?.id||previous.id);
}
function attach(value){
 if(!value||value===runtime)return;
 if(runtime?.run)throw Error('請先停止目前工作再切換 Runtime。');
 runtime=value;bridgeError=null;const attached=runtime;quotaMonitor.reset();
 runtime.openCodexServerRequest=(request,run)=>{
  const ws=[...clients][0];if(!ws)return false;
  const id='remote:'+request.id;pendingServer.set(id,{rpc:attached.rpc,id:request.id,ws,run,owner:attached});
  send(ws,{...request,id});return true;
 };
 runtime.openCodexCloseRun=run=>{
  for(const [id,pending]of pendingServer)if(pending.owner===attached&&pending.run===run){
   pendingServer.delete(id);pending.rpc.reject(pending.id,'The turn has ended.');
   send(pending.ws,{method:'serverRequest/resolved',params:{requestId:id}});
  }
 };
 runtime.openCodexChildThread=(thread,parent)=>{
  if(runtime!==attached||attached.closed)return;
  const previous=known[thread.id];if(previous&&previous.profile!==attached.snapshot.profileId)throw Error('Subagent history owner changed');
  const {turns,...summary}=workspace.localThread(thread,known,attached.localCwd);
  known[thread.id]={...previous,profile:attached.snapshot.profileId,localCwd:attached.localCwd,environmentId:attached.executor.environmentId,permissionMode:known[parent.threadId]?.permissionMode||settings.permissionMode,emptyHistory:false,summary};
  remoteThreadCache.set(thread.id,{thread:{...summary,turns}},attached.snapshot.profileId,{complete:true});
  fs.writeFileSync(knownFile,JSON.stringify(known),{mode:0o600});
 };
 const notifyRemote=m=>{if(eventStreams.notification(attached,m))return;if(runtime!==attached||!isRemote())return;if(m.method==='turn/started'||m.method==='turn/completed')setImmediate(publish);if(m.method==='turn/started'&&known[m.params.threadId]){known[m.params.threadId].emptyHistory=false;fs.writeFileSync(knownFile,JSON.stringify(known),{mode:0o600});}if(!m.method.startsWith('account/')&&m.method!=='thread/queue/changed'){if(m.method==='thread/settings/updated'){const choice=pendingPermissions.get(attached)?.get(m.params?.threadId)||nativePolicy.resolveMode({},known[m.params?.threadId]?.permissionMode,settings);m={...m,params:nativePolicy.localSnapshot(m.params,choice,known[m.params?.threadId]?.localCwd||attached.localCwd)};}const mapped=organization.projectNotification(attached.snapshot.profileId,m.params?.thread?{...m,params:{...m.params,thread:workspace.localThread(m.params.thread,known,m.method==='thread/started'?attached.localCwd:undefined)}}:m);for(const ws of clients)send(ws,mapped);}if(m.method==='turn/completed'){void refreshHistory(attached,m.params.threadId);nativeQueue.completed(attached.snapshot.profileId,m.params.threadId,m.params.turn.status);}if(m.method==='account/updated')quotaMonitor.invalidate();else if(m.method==='account/rateLimits/updated'||m.method==='turn/completed')quotaMonitor.refresh();};
 runtime.openCodexHooksNotification=notifyRemote;
 runtime.openCodexHooksError=error=>{if(runtime!==attached||attached.closed)return;bridgeError='Mac Hooks：'+error.message;audit('hooks-error',{message:error.message});publish();};
 runtime.rpc.on('notification',m=>{if(!attached.openCodexHooks?.suppress(m))notifyRemote(m);});
 runtime.rpc.on('closed',()=>{eventStreams.disconnect(attached);if(runtime!==attached)return;quotaMonitor.reset(null,'disconnected');bridgeError='連線已中斷；指令不會自動重送。';publish();notifyRemoteState();});
 audit('ssh-connected',{executor:!!runtime.executor?.isRunning,version:runtime.snapshot.runtimeVersion});publish();quotaMonitor.refresh();
}
function notifyRemoteState(){
 // A peer's ChatGPT account is not a login to this Mac's native cloud UI.
 // Keep the native app-server transport alive across SSH state changes.
 // Closing it here races native background queries and opens a fatal dialog.
 // The quota monitor and publish update the remote identity and sidebar separately.
 for(const ws of clients)send(ws,{method:'opencodex/models/updated',params:{}});
 publish();
}
const remoteThreadCache=new (require('./native-history.cjs').NativeHistory)(path.join(root,'native-history'),{onError:error=>audit('native-history-error',{message:error.message})});
async function refreshHistory(owner,threadId){
 const profile=owner.snapshot.profileId;
 if(owner.closed||known[threadId]?.profile!==profile||known[threadId]?.deleted)return;
 try{
  const result=workspace.localResult(await nativeShell.readThread(owner.rpc,{threadId,includeTurns:true},known[threadId]?.emptyHistory===true),known,known[threadId]?.localCwd);
  result.thread=nativeShell.merge(result.thread);
  if(!owner.closed&&known[threadId]?.profile===profile&&!known[threadId]?.deleted)remoteThreadCache.set(threadId,organization.projectResult(profile,result),profile,{complete:true});
 }catch(error){audit('native-history-refresh-error',{message:error.message});}
}

const routing=require('./native-routing.cjs'),nativePolicy=require('./native-policy.cjs'),workspace=require('./native-workspace.cjs');
const pendingPermissions=new WeakMap();
const organization=new (require('./native-organization.cjs').NativeOrganization)(path.join(root,'native-organization.json'),{
 localRequest:async(method,params)=>{await readyLocal();return localRequest(method,params);},
 owns:(profile,threadId)=>known[threadId]?.profile===profile&&!known[threadId]?.deleted,
 getThreads:profile=>Object.values(known).filter(t=>t.profile===profile),
 notify:(profile,message)=>{if(isRemote()&&!isClaude()&&profile===(runtime?.snapshot?.profileId||settings.profileId))for(const ws of clients)send(ws,message);}
});
const eventStreams=new routing.NativeEventStreams({send,onError:error=>audit('mcp-stream-cleanup-error',{message:error.message})});
function runtimeEvent(event,payload){
 if(event==='orchestrator:event'){agents?.event(payload);return;}
 if(event==='claude:event'){claude?.event(payload);if(payload.type==='closed')publish();return;}
 if(event==='opencodex:tool-policy'){if(process.argv.includes('--opencodex-test'))audit('tool-policy',payload);return;}
 for(const w of BrowserWindow.getAllWindows())w.webContents.send(event,payload);
 if(event!=='runtime:event'||payload.type!=='approval')return;
 const owner=backend.openCodexRuntimes.get(payload.runtimeId);
 if(!owner?.requests.get(payload.approvalId)?.localResolve)return;
 const parent=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('app://'));
 void nativePolicy.localApproval({event:payload,runtime:owner,isPending:()=>!!owner.requests.get(payload.approvalId)?.localResolve,
  grants:approvalGrants,getScope:()=>approvalScope(owner,payload.approvalId),onChange:publish,onError:error=>{bridgeError='工具權限未保存或操作未允許：'+error.message;publish();},
  show:async options=>{if(!parent||parent.isDestroyed())return {response:0};audit('tool-approval-shown',{scoped:options.buttons.length===3});const result=await dialog.showMessageBox(parent,options);audit('tool-approval-choice',{response:result.response});return result;},
  respond:decision=>{audit('tool-approval-result',{decision});return handlers.get('runtime:respond')({},{runtimeId:owner.id,approvalId:payload.approvalId,decision});}});
}
async function request(ws,method,params,fromQueue=false){
 if(!isRemote()){const init=await readyLocal();return method==='initialize'?init:localRequest(method,params,120000);}
 if(method==='initialize')return readyLocal();
 if(method==='mcpServer/event/stream/stop')return eventStreams.stop(ws,params?.subscriptionId);
 if(method==='turn/interrupt'&&agents?.active)await agents.cancel();
 if(isClaude()&&claude.handles(method))return claude.request(method,params||{},fromQueue);
 const connected=runtime&&!runtime.closed;
 const profileId=runtime?.snapshot?.profileId||settings.profileId;
 if(organization.handles(method))return organization.request(profileId,method,params||{});
 // SSH authenticates its runtime separately; this frontend has no local
 // ChatGPT cloud session. Never present the peer's identity as that login.
 // The quota monitor reads and displays the remote account independently.
 if(method==='account/read')return {account:null,requiresOpenaiAuth:false};
 if(method.startsWith('thread/queue/')){
  if(known[params?.threadId]?.profile!==profileId)throw Error('此佇列不屬於目前 OpenCodex 主機。');
  return nativeQueue.request(method,params,profileId);
 }
 if(!connected){
  if(method==='account/rateLimits/read')return {rateLimits:null,rateLimitsByLimitId:null};
  if(method==='thread/list'||method==='thread/search')return organization.listPage(profileId,method,params||{},query=>routing.cachedPage(method,query,known,profileId));
  if(method==='thread/attachmentOwner/list')return {data:[],nextCursor:null};
  if(method==='thread/loaded/list'||method==='mcpServerStatus/list')return {data:[],nextCursor:null};
  if(known[params?.threadId]?.profile===profileId&&!known[params.threadId]?.deleted&&remoteThreadCache.has(params.threadId,profileId)){
   const cached=remoteThreadCache.get(params.threadId,profileId);
   cached.thread=nativeShell.merge(cached.thread);
   if(['thread/turns/list','thread/items/list'].includes(method))return nativeShell.listCached(method,params,cached.thread,{complete:cached.openCodexHistoryComplete===true});
   if(method==='thread/read'||method==='thread/resume')return organization.projectResult(profileId,nativePolicy.localSnapshot(cached,nativePolicy.resolveMode({},known[params.threadId]?.permissionMode,settings),known[params.threadId]?.localCwd));
  }
  if(routing.threadScoped(method,params)||method.startsWith('thread/')||method.startsWith('turn/'))throw Error(bridgeError||'SSH 尚未連線；請開啟側邊欄 SSH 連線。');
 }
 if(routing.collections.has(method)){
  const owner=runtime;
  if(method==='thread/list'||method==='thread/search')return organization.listPage(profileId,method,params||{},query=>routing.ownedPage(owner.rpc,method,query,known,profileId));
  return routing.ownedPage(owner.rpc,method,params,known,profileId);
 }
 if(routing.threadScoped(method,params)){
  if(permissionChanging)throw Error('操作權限正在更新，請稍候。');
  if(params?.threadId&&!known[params.threadId]&&method==='thread/read'&&runtime.openCodexSubagents){
   await runtime.openCodexSubagents.discover(params.threadId);
  }
  if(params?.threadId&&(known[params.threadId]?.profile!==runtime.snapshot.profileId||known[params.threadId]?.deleted))throw Error('此對話不屬於目前 OpenCodex 主機或已刪除。');
  if(!fromQueue&&nativeQueue.starting&&workspace.needsLease(method,params))throw Error('排隊訊息正在啟動，請稍候或停止目前工作。');
  if(method==='turn/interrupt')nativeQueue.pause(profileId,params.threadId);
  if(nativeShell.active){
   if(method==='turn/interrupt'&&params.threadId===nativeShell.active.remoteThreadId){await nativeShell.interrupt();return {};}
   if(workspace.needsLease(method,params)||method==='thread/queue/start')throw Error('Mac 指令仍在執行，請先停止目前工作。');
  }
  if(method==='thread/unsubscribe'&&known[params.threadId]?.summary?.ephemeral===true){
   const owner=runtime;
   await workspace.cancelEphemeral(owner,params.threadId,requestId=>handlers.get('runtime:cancel')({},owner.id,requestId));
  }
  if(method==='turn/interrupt'&&workspace.cancelPending(runtime,params.threadId))return {};
  if(method==='turn/interrupt'&&runtime.openCodexPreparing?.threadId===params.threadId){runtime.openCodexPreparing.cancelled=true;return {};}
  if(method==='review/start'&&params.delivery==='detached'){
   const cwd=await workspace.resolveCwd(params,known[params.threadId],settings.cwd);
   const mode=nativePolicy.resolveMode(params,known[params.threadId]?.permissionMode,settings).requested;
   return require('./native-review.cjs').detachedReview({...params,cwd,permissions:{ask:':read-only',project:':workspace',full:':danger-full-access'}[mode]},(name,input)=>request(ws,name,input));
  }
  if(method==='mcpServer/resource/read'&&require('./native-mcp.cjs').isProjectedUri(params?.uri)){
   const owner=runtime;
   if(!params.threadId||params.server!==owner.mcp?.name||!owner.toolHost?.openCodexMcpResourceRead)throw Error('此 Mac 外掛資源不屬於目前連線。');
   return owner.toolHost.openCodexMcpResourceRead(params.uri,{isAuthorized:()=>runtime===owner&&!owner.closed&&clients.has(ws)&&ws.readyState===1&&known[params.threadId]?.profile===owner.snapshot.profileId&&!known[params.threadId]?.deleted});
  }
  if(method==='mcpServer/event/stream/start')return eventStreams.start(runtime,ws,params);
  const leaseOwner=runtime;
  const lease=workspace.needsLease(method,params)?await workspace.acquireAsync(leaseOwner,{threadId:params?.threadId,restore:method==='thread/resume',ephemeral:params?.ephemeral===true||known[params?.threadId]?.summary?.ephemeral===true,isCurrent:()=>runtime===leaseOwner&&clients.has(ws)&&ws.readyState===1}):null;
  let selectedCwd,pendingPermission,backendAccepted=false;const requestOwner=runtime,previousPermission=runtime.permissionMode;
  try{
  if(lease){
   selectedCwd=await workspace.resolveCwd(params,known[params?.threadId],settings.cwd);lease.check();
   await bridge.selectWorkspace(runtime,selectedCwd);lease.check();
  }
  if(method==='thread/resume'){
   const previous=known[params.threadId]?.environmentId;
   if(previous&&previous!==runtime.executor.environmentId){
    const environment=await runtime.executor.register(runtime.rpc,runtime.executorUrl,previous);
    runtime.snapshot.executorEnvironment=environment;
    if(runtime.mcp)runtime.mcp.environmentId=environment.environmentId;
   }
  }
  if(method==='turn/interrupt'&&runtime.run?.threadId===params.threadId){await handlers.get('runtime:cancel')({},runtime.id,runtime.run.requestId);return {};}
  const explicitPermission=nativePolicy.selectedMode(params||{});
  const selection=nativePolicy.resolveMode(params||{},known[params?.threadId]?.permissionMode,settings);
  if(method==='thread/settings/update'){
   let entries=pendingPermissions.get(requestOwner);if(!entries){entries=new Map();pendingPermissions.set(requestOwner,entries);}
   if(entries.has(params.threadId))throw Error('對話設定正在更新，請稍候。');
   pendingPermission=selection;entries.set(params.threadId,selection);
  }
  const permissionMode=(explicitPermission||lease)?selection.effective:null;
  if(permissionMode&&permissionMode!==runtime.permissionMode){
   if(runtime.run||(!lease&&runtime.openCodexPreparing))throw Error('請先停止工作，再變更操作權限。');
   await handlers.get('runtime:permission')({},runtime.id,permissionMode);
   publish();
  }
  lease?.check();
  if(method==='thread/shellCommand'){
   if(runtime.run)throw Error('請先停止目前工作再執行 Mac 指令。');
   if(known[params.threadId]){known[params.threadId].localCwd=selectedCwd;known[params.threadId].permissionMode=selection.requested;if(known[params.threadId].summary)known[params.threadId].summary.cwd=selectedCwd;fs.writeFileSync(knownFile,JSON.stringify(known),{mode:0o600});}
   const history=await nativeShell.readThread(runtime.rpc,{threadId:params.threadId,includeTurns:true},known[params.threadId]?.emptyHistory===true);
   return nativeShell.start(params,{cwd:runtime.localCwd,remoteRpc:runtime.rpc,anchor:history.thread.turns?.at(-1)?.id||null});
  }
  if(method==='mcpServer/tool/call'&&require('./native-mcp.cjs').isProjectedUri(params?._meta?.['opencodex/resourceUri'])){
   const owner=requestOwner;
   if(!params.threadId||params.server!==owner.mcp?.name||!owner.toolHost?.openCodexMcpToolCall)throw Error('此 Mac 外掛操作不屬於目前連線。');
   const controller=new AbortController();
   const current=()=>{try{lease?.check();return runtime===owner&&!owner.closed&&clients.has(ws)&&ws.readyState===1&&known[params.threadId]?.profile===owner.snapshot.profileId&&!known[params.threadId]?.deleted;}catch{return false;}};
   const monitor=setInterval(()=>{if(!current())controller.abort();},100);
   try{
    return await owner.toolHost.openCodexMcpToolCall(params,{signal:controller.signal,isAuthorized:current,authorizeTool:call=>nativePolicy.appApproval({
     call,current,fullAccess:()=>settings.fullAccess===true||owner.permissionMode==='full',grants:approvalGrants,getScope:()=>appScope(owner,call),onChange:publish,
     show:async options=>{const parent=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('app://'));if(!parent||parent.isDestroyed())return {response:0};return dialog.showMessageBox(parent,options);}
    })});
   }finally{clearInterval(monitor);}
  }
  const remoteParams=await organization.prepareThread(profileId,method,params||{});
  lease?.check();
  const wireMethod=organization.remoteMethod(method,params||{});
  const knownEmpty=known[params.threadId]?.emptyHistory===true;
  const mutationSource=nativeShell.hasHistory(params.threadId)&&['thread/fork','thread/revert'].includes(method)?(await nativeShell.readThread(requestOwner.rpc,{threadId:params.threadId,includeTurns:true},knownEmpty)).thread:null;
  const historyPlan=nativeShell.prepareHistoryMutation(method,params,mutationSource);
  lease?.check();
  const raw=wireMethod==='thread/read'?await nativeShell.readThread(requestOwner.rpc,remoteParams,knownEmpty):['thread/turns/list','thread/items/list'].includes(wireMethod)?await nativeShell.list(requestOwner.rpc,wireMethod,remoteParams,{knownEmpty}):await backend.openCodexRequest(requestOwner,bridge.runtimeDependencies,wireMethod,remoteParams);
  backendAccepted=true;
  const result=workspace.localResult(nativePolicy.localSnapshot(await nativeShell.commitHistoryMutation(historyPlan,raw,requestOwner.rpc,{knownEmpty}),selection,selectedCwd||known[params?.threadId]?.localCwd||requestOwner.localCwd),known,selectedCwd);
  if(explicitPermission&&settings.permissionMode!==selection.requested){settings.permissionMode=selection.requested;save();}
  if(result.thread?.id){result.thread=organization.captureThread(profileId,method,params,workspace.localThread(result.thread,known,selectedCwd));if(['thread/read','thread/resume'].includes(method)||(method==='thread/fork'&&!params.excludeTurns))result.thread=nativeShell.merge(result.thread);const {turns,...summary}=result.thread;known[result.thread.id]={...known[result.thread.id],emptyHistory:method==='thread/start'?true:turns?.length?false:known[result.thread.id]?.emptyHistory,profile:requestOwner.snapshot.profileId,localCwd:selectedCwd||known[result.thread.id]?.localCwd,permissionMode:selectedCwd?selection.requested:known[result.thread.id]?.permissionMode,environmentId:requestOwner.executor?.environmentId,summary};remoteThreadCache.set(result.thread.id,result,requestOwner.snapshot.profileId,require('./native-history.cjs').snapshotOptions(method,params));fs.writeFileSync(knownFile,JSON.stringify(known),{mode:0o600});}
  const entry=known[params?.threadId];
  if(entry){
   if(selectedCwd){entry.localCwd=selectedCwd;if(entry.summary)entry.summary.cwd=selectedCwd;}if(selectedCwd||explicitPermission)entry.permissionMode=selection.requested;
   if(method==='thread/name/set'&&entry.summary)entry.summary.name=params.name;
   if(method==='thread/archive')entry.archived=true;
   if(method==='thread/unarchive')entry.archived=false;
   if(method==='thread/delete'){entry.deleted=true;remoteThreadCache.delete(params.threadId,profileId);organization.removeThread(profileId,params.threadId);}
   fs.writeFileSync(knownFile,JSON.stringify(known),{mode:0o600});
  }
  if(method==='thread/revert'||(['thread/resume','thread/fork'].includes(method)&&params.excludeTurns))void refreshHistory(requestOwner,result.thread.id);
  audit('rpc',{method,success:true});return result;
  }catch(error){
   if(pendingPermission&&!backendAccepted&&!requestOwner.closed&&requestOwner.permissionMode!==previousPermission){
    try{await handlers.get('runtime:permission')({},requestOwner.id,previousPermission);publish();}
    catch(restore){audit('permission-restore-error',{message:restore.message});}
   }
   throw error;
  }finally{if(pendingPermission&&pendingPermissions.get(requestOwner)?.get(params.threadId)===pendingPermission)pendingPermissions.get(requestOwner).delete(params.threadId);lease?.release();if(lease)publish();}
 }
 if(connected&&routing.reads.has(method))return runtime.rpc.request(method,params||{});
 // Settings, local skills, file browsing and auth flows never reach the peer computer.
 if((method.startsWith('account/')&&method!=='account/gatewayOAuth/read')||method.startsWith('attestation/'))throw Error('SSH 模式的帳號由遠端主機擁有者管理。請切換官方登入模式。');
 await readyLocal();
 return localRequest(method,params||{},60000);
}
function openManager(){for(const w of BrowserWindow.getAllWindows())if(w.webContents.getURL().startsWith('app://')){w.show();w.focus();w.webContents.send('opencodex:open-connections');}}
const showControls=openManager;
ipcMain.on('opencodex:initial-state',event=>{event.returnValue=publicState();});
handle('opencodex:status',()=>publicState());
handle('opencodex:approval-revoke',(event,id)=>{
 if(!event.senderFrame||event.senderFrame!==event.sender.mainFrame||event.senderFrame.url!=='app://-/index.html')throw Error('權限管理僅限 OpenCodex 主視窗。');
 if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('無效的工具權限。');
 approvalGrants.revoke(id);publish();return publicState();
});
handle('opencodex:full-access',async(event,enabled)=>{
 if(!event.senderFrame||event.senderFrame!==event.sender.mainFrame||event.senderFrame.url!=='app://-/index.html')throw Error('權限管理僅限 OpenCodex 主視窗。');
 if(!isRemote())throw Error('最高權限開關適用於 SSH 模式。');
 const busy=connecting||permissionChanging||agents?.active||claude?.busy||claude?.queue.starting||runtime?.run||runtime?.openCodexPreparing||localTurns.size||nativeShell.active||nativeQueue.starting;
 if(busy)throw Error('請先停止目前工作，再切換最高權限。');
 permissionChanging=true;publish();
 try{
  await nativePolicy.setFullAccess({enabled,settings,busy:false,save,apply:async mode=>{
   const changed=[];try{for(const r of [runtime,claude?.runtime,peer].filter(r=>r&&!r.closed)){const old=r.permissionMode;await handlers.get(r.cli?'claude:permission':'runtime:permission')({},r.cli?.id||r.id,mode);changed.push([r,old]);}}
   catch(e){for(const [r,old]of changed)await handlers.get(r.cli?'claude:permission':'runtime:permission')({},r.cli?.id||r.id,old);throw e;}
  }});
  audit('full-access-changed',{enabled:settings.fullAccess===true});
 }finally{permissionChanging=false;publish();}
 return publicState();
});
handle('opencodex:claude-status',async()=>{const r=isClaude()?claude?.runtime:peer;if(!r?.cli||r.closed)throw Error('請先連線至遠端 Claude。');await r.cli.refreshAccount();publish();return publicState();});
handle('opencodex:peer-disconnect',async()=>{if(connecting||permissionChanging||agents?.active||claude?.busy||claude?.queue.starting||runtime?.run||runtime?.openCodexPreparing||localTurns.size||nativeShell.active||nativeQueue.starting)throw Error('請先停止目前工作。');await disconnectPeer();publish();return publicState();});
handle('opencodex:agents-cancel',async()=>{await agents?.cancel();publish();return publicState();});
handle('opencodex:quota',async()=>{if(isClaude())await claude.quota();else{if(!isRemote())await readyLocal();await quotaMonitor.refresh();}return publicState();});
handle('opencodex:controls',()=>showControls());
handle('opencodex:manager',()=>openManager());
handle('opencodex:profiles',()=>handlers.get('profiles:list')({}));
handle('opencodex:profile-save',async(_event,input)=>{if(connecting)throw Error('請等候連線完成。');pendingConnection=null;hostConfirmation=null;const next=Object.hasOwn(input,'codexExecutable')?codexConnection({executable:input.codexExecutable}):null;const result=await handlers.get('profiles:save')({},validateProfile(input));if(next){const previous=settings.codexConnections;settings.codexConnections={...previous,[input.id]:next};try{save();}catch(error){settings.codexConnections=previous;throw error;}}publish();return result;});
handle('opencodex:profile-delete',async(_event,id)=>{if(connecting||claude?.connected&&claude.profile===id||runtime&&!runtime.closed&&runtime.snapshot.profileId===id||peer&&!peer.closed&&(peer.network?.profileId||peer.snapshot?.profileId)===id)throw Error('請先中斷此主機的連線。');pendingConnection=null;hostConfirmation=null;return handlers.get('profiles:delete')({},id);});
handle('opencodex:connect',async(_event,input)=>{await connectBridge(input||{});return publicState();});
handle('opencodex:cancel-confirmation',()=>{pendingConnection=null;hostConfirmation=null;publish();return publicState();});
handle('opencodex:disconnect',async()=>{if(connecting||permissionChanging||agents?.active||claude?.busy||claude?.queue.starting||runtime?.run||runtime?.openCodexPreparing||localTurns.size||nativeShell.active||nativeQueue.starting)throw Error('請先等候連線完成或停止目前工作。');await disconnectPeer();if(isClaude())await claude.disconnect();const previous=runtime;runtime=null;pendingConnection=null;hostConfirmation=null;quotaMonitor.reset(null,'disconnected');if(previous&&!previous.closed)await handlers.get('runtime:disconnect')({},previous.id);bridgeError=null;publish();notifyRemoteState();return publicState();});
handle('opencodex:reconnect',async()=>{await connectBridge();return publicState();});
handle('opencodex:mode',async(_event,input)=>{
 if(input.engine){const next=require('./native-profile.cjs').engineTransition(settings,input);input={...input,mode:next.mode,sshAgent:next.sshAgent};}
 if(input.mode==='bridge')input={...input,mode:'ssh'};
 if(!['official','custom','ssh'].includes(input.mode))throw Error('無效模式。');
 if(connecting||permissionChanging||agents?.active||claude?.busy||claude?.queue.starting||runtime?.run||runtime?.openCodexPreparing||localTurns.size||nativeShell.active||nativeQueue.starting)throw Error('請先停止工作，再切換模式。');
 if(input.sshAgent&&!['codex','claude'].includes(input.sshAgent))throw Error('無效的遠端 Agent。');
 if(input.mode==='custom'&&!input.engine){
  const url=new URL(input.baseUrl);if(url.username||url.password||url.search||url.hash)throw Error('API 網址不可包含密碼、查詢參數或片段。');if(!input.apiKey&&!fs.existsSync(path.join(root,'api-key.bin')))throw Error('請輸入 API Key。');if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('API 必須使用 HTTPS，或本機 HTTP。');
  if(!input.model?.trim())throw Error('請輸入模型名稱。');
  const home=path.join(root,'codex-custom');fs.mkdirSync(home,{recursive:true,mode:0o700});
  const q=JSON.stringify;
  const toml=require(path.join(abRoot,'node_modules/smol-toml')),configPath=path.join(home,'config.toml');
  const config=fs.existsSync(configPath)?toml.parse(fs.readFileSync(configPath,'utf8')):{};
  config.model=input.model.trim();config.model_provider='opencodex_custom';
  config.model_providers={...config.model_providers,opencodex_custom:{name:'OpenCodex Custom API',base_url:url.href.replace(/\/$/,''),wire_api:'responses',env_key:'OPENCODEX_API_KEY'}};
  fs.writeFileSync(configPath+'.tmp',toml.stringify(config),{mode:0o600});fs.renameSync(configPath+'.tmp',configPath);
  if(input.apiKey)fs.writeFileSync(path.join(root,'api-key.bin'),safeStorage.encryptString(input.apiKey),{mode:0o600});
 }
 settings=require('./native-profile.cjs').engineTransition(settings,input);save();app.relaunch({execPath:path.join(process.resourcesPath,'../MacOS/OpenCodex'),args:process.argv.includes('--opencodex-test')?['--opencodex-test','--remote-debugging-port=9325']:[]});app.quit();return true;
});
if(settings.mode==='custom'&&fs.existsSync(path.join(root,'api-key.bin'))){
 app.whenReady().then(()=>{process.env.OPENCODEX_API_KEY=safeStorage.decryptString(fs.readFileSync(path.join(root,'api-key.bin')));});
}
async function start(){
 const token=crypto.randomBytes(32).toString('hex');
 const server=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:32*1024*1024,verifyClient:info=>info.req.url==='/'+token&&!info.origin});
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 process.env.CODEX_APP_SERVER_WS_URL='ws://127.0.0.1:'+server.address().port+'/'+token;
 delete process.env.CODEX_APP_SERVER_FORCE_CLI;
 if(process.argv.includes('--opencodex-test'))fs.writeFileSync(path.join(root,'test-endpoint.json'),JSON.stringify({url:process.env.CODEX_APP_SERVER_WS_URL,pid:process.pid}),{mode:0o600});
 server.on('connection',ws=>{
  clients.add(ws);audit('frontend-connected');
  ws.on('message',async data=>{
   let m;try{m=JSON.parse(data.toString());}catch{ws.close(1007);return;}
   if(typeof m.method!=='string'){
    const pending=pendingServer.get(m.id);if(pending?.ws===ws){pendingServer.delete(m.id);if(pending.run&&pending.owner?.openCodexSubagents&&!pending.owner.openCodexSubagents.isActive(pending.run))pending.rpc.reject(pending.id,'The turn has ended.');else if(m.error)pending.rpc.reject(pending.id,m.error.message);else pending.rpc.respond(pending.id,m.result);}return;
   }
   if(m.id===undefined)return; // initialized is already sent once per real transport.
   try{send(ws,{id:m.id,result:await request(ws,m.method,m.params)});}
   catch(e){audit('rpc-error',{method:m.method,message:String(e.message).slice(0,500)});send(ws,{id:m.id,error:{code:e.code||-32000,message:e.message||'OpenCodex adapter error'}});}
  });
  ws.on('close',()=>{
   clients.delete(ws);
   void eventStreams.closeClient(ws);
   for(const[id,p]of pendingServer){if(p.ws===ws){p.rpc.reject(p.id,'Frontend disconnected');pendingServer.delete(id);}}
   if(!clients.size)agents?.cancel().catch(()=>{});
   if(!clients.size&&claude?.runtime?.run)claude.request('turn/interrupt',{threadId:claude.runtime.run.threadId}).catch(()=>{});
   if(!clients.size&&claude?.preparing?.threadId)claude.preparing.cancelled=true;
   if(!clients.size&&nativeShell.active)nativeShell.interrupt().catch(()=>{});
   if(!clients.size&&runtime?.run)handlers.get('runtime:cancel')({},runtime.id,runtime.run.requestId).catch(()=>{});
   audit('frontend-disconnected');
  });
 });
 backend=require(path.join(abRoot,'dist-main/runtime-backend.js'));
 agents=new (require('./native-agents.cjs').NativeAgents)({reservePeers:(peers,id)=>require('./native-agents.cjs').reserveAgentRoots(peers,id,{codex:backend,claude:bridge.claudeBackend}),getPeers:()=>isClaude()?{codex:peer,claude:claude?.runtime}:{codex:runtime,claude:peer},invoke:(name,...args)=>handlers.get(name)({},...args),onState:publish});
 bridge=require('./ssh-runtime.cjs')({root,abRoot,emit:runtimeEvent,onNativeRequest:forwardNativeRequest,agentTools:()=>[agents.spec()]});
 claude=new (require('./native-claude.cjs').NativeClaude)({root,settings,saveSettings:save,invoke:(name,...args)=>handlers.get(name)({},...args),emit:message=>{for(const ws of clients)send(ws,message);},onState:publish,selectWorkspace:bridge.selectClaudeWorkspace,refreshTools:bridge.runtimeDependencies.refreshNativeTools,forwardRequest:forwardNativeRequest,grants:approvalGrants,onError:error=>{bridgeError=error.message;audit('claude-error',{message:error.message});publish();},showApproval:async options=>{const parent=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('app://'));if(!parent||parent.isDestroyed())return {response:0};return dialog.showMessageBox(parent,options);}});
 // Open the native shell first. SSH is an explicit user action from the sidebar.
 app.whenReady().then(()=>{audit('shell-ready',{mode:settings.mode,autoConnect:false});publish();});
 app.on('browser-window-created',(_event,w)=>{
  w.webContents.on('did-finish-load',()=>{if(w.webContents.getURL().includes('/dist-renderer/'))return;w.webContents.send('opencodex:status',publicState());});
 });
 app.whenReady().then(()=>{
  setTimeout(()=>{const menu=Menu.getApplicationMenu();if(menu){const {MenuItem}=require('electron');menu.append(new MenuItem({label:'OpenCodex',submenu:[{label:'模式與連線設定…',click:showControls},{label:'SSH 連線…',accelerator:'CmdOrCtrl+Shift+B',click:openManager},{label:'顯示資料目錄',click:()=>require('electron').shell.openPath(root)}]}));Menu.setApplicationMenu(menu);}},2500);
 });
 const quotaTimer=setInterval(()=>{if(isClaude())claude.quota().catch(()=>{});else quotaMonitor.refresh();},30000);quotaTimer.unref();
 let shuttingDown=false;
 app.on('before-quit',event=>{
  if(shuttingDown)return;shuttingDown=true;event.preventDefault();
  clearInterval(quotaTimer);agents?.cancel().catch(()=>{});nativeQueue.close();claude?.close();bridge?.claudeBackend.stopAllClaudeLocalRuntimes();backend?.stopAllRuntimes(bridge.runtimeDependencies);bridge?.closeNativeTools();localChild?.kill('SIGTERM');server.close();
  require('./native-helper-cleanup.cjs').closeOwnedHelpers(root).catch(error=>audit('helper-cleanup-error',{message:error.message})).finally(()=>app.quit());
 });
 require(path.join(app.getAppPath(),'.vite/build/early-bootstrap.js'));
}
start().catch(e=>{audit('fatal',{message:e.message});dialog.showErrorBox('OpenCodex 啟動失敗',e.message);app.quit();});
