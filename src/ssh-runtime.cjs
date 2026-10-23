'use strict';
// OpenCodex-owned SSH service. Reuses MIT-licensed transport/tool modules,
// without loading AgentBridge main.js, its renderer, relay or application.
module.exports=function({root,abRoot,emit,onNativeRequest,agentTools}){
 const {app,BrowserWindow,ipcMain,safeStorage}=require('electron');
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const mod=n=>require(path.join(abRoot,'dist-main',n));
 const credentials=mod('profile-credentials.js');
 const profileFile=path.join(root,'profiles.json');
 const read=()=>{try{return JSON.parse(fs.readFileSync(profileFile,'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 const write=p=>{fs.writeFileSync(profileFile+'.tmp',JSON.stringify(p,null,2),{mode:0o600});fs.renameSync(profileFile+'.tmp',profileFile);};
 ipcMain.handle('profiles:list',()=>read().map(credentials.publicProfile));
 ipcMain.handle('profiles:save',(_event,input)=>{
  const items=read(),i=items.findIndex(p=>p.id===input.id);
  const p=credentials.saveCredentialProfile(require('./ssh-profiles.cjs').validateProfile(input),items[i],v=>safeStorage.encryptString(v).toString('base64'),safeStorage.isEncryptionAvailable());
  if(i<0)items.unshift(p);else items[i]=p;write(items);return items.map(credentials.publicProfile);
 });
 ipcMain.handle('profiles:delete',(_event,id)=>{const items=read().filter(p=>p.id!==id);write(items);return items.map(credentials.publicProfile);});
 function connectConfig({profile:p,password}){
  const cfg={host:p.host,port:p.port||22,username:p.username,readyTimeout:15000,keepaliveInterval:15000,keepaliveCountMax:3};
  if(p.authType==='agent'){if(!process.env.SSH_AUTH_SOCK)throw Error('找不到 SSH Agent；請改用私鑰或密碼。');cfg.agent=process.env.SSH_AUTH_SOCK;}
  else if(p.authType==='key'){if(!p.keyPath)throw Error('請選擇 SSH 私鑰。');cfg.privateKey=fs.readFileSync(p.keyPath);}
  else {const saved=credentials.savedCredentialFor(p,read());cfg.password=password||(saved?safeStorage.decryptString(Buffer.from(saved.encryptedPassword,'base64')):undefined);if(!cfg.password)throw Error('請輸入 SSH 密碼。');}
  return cfg;
 }
 const codec={available:()=>safeStorage.isEncryptionAvailable(),encrypt:v=>safeStorage.encryptString(v).toString('base64'),decrypt:v=>safeStorage.decryptString(Buffer.from(v,'base64'))};
 const discover=mod('mac-extension-servers.js').discoverMacCodexServers;
 const composio=new (require('./composio.cjs').ComposioConnection)({root,codec,auth:mod('mac-mcp-auth.js'),Client:mod('mac-extension-servers.js').MacExtensionClient,open:url=>require('electron').shell.openExternal(url),onChange:()=>emit('opencodex:composio',composio.state())});
 const provider=new (mod('computer-provider.js').ComputerProviderStore)(path.join(root,'computer-provider.json'),path.join(process.resourcesPath,'agentbridge/computer-use/claudex-computer-use'),os.homedir());
 const extensionHome=process.env.OPENCODEX_EXTENSION_HOME||path.join(os.homedir(),'.codex');
 const {NativeTools}=require('./native-tools.cjs');
 const nativeBinary=path.join(process.resourcesPath,'opencodex-permission-engine');
 const {routeNativeRequest}=require('./native-request.cjs');
 const owners=new (require('./native-tool-owners.cjs').NativeToolOwners)((cwd,runtime)=>{
  const custom=typeof runtime?.permissionMode==='string'&&runtime.permissionMode.startsWith('custom:');
  const permission=runtime?.openCodexPermissions;
  if(custom&&(!permission?.valid()||permission.profile!==runtime.permissionMode.slice(7)))throw Error('自訂權限工作階段未就緒。');
  if(permission&&!custom)throw Error('權限工作階段與所選模式不一致。');
  const options={binary:nativeBinary,cwd,env:{...process.env},config:{'features.hooks':false},AppServerRpc:mod('app-server-rpc.js').AppServerRpc,getApp:()=>require('./native-app-context.cjs').scopedApp(next.runtime),getRun:()=>require('./native-run-context.cjs').scopedRun(next.runtime)||next.runtime?.run,onRequest:(message,rpc,owner)=>{
   const run=owner.getRun?.();
   if(run?.parentThreadId&&!next.runtime?.openCodexSubagents?.isActive(run))return false;
   const routed=routeNativeRequest(message,owner.threadId,run);
   return routed?onNativeRequest?.(routed,rpc,{run,owner:next.runtime}):false;
  }};
  const next=custom?permission.native(options):new NativeTools(options);
  if(!custom){const nativeSpecs=next.specs.bind(next);next.specs=async()=>[...await nativeSpecs(),...agentTools()];}
  return next;
 });
 const hooks=new (require('./native-hooks-service.cjs').NativeHooksService)({
  binary:path.join(process.resourcesPath,'opencodex-hooks-helper'),nativeBinary,
  codexHome:process.env.CODEX_HOME,env:{...process.env},AppServerRpc:mod('app-server-rpc.js').AppServerRpc,
  owner:runtime=>owners.owner(runtime),onRequest:onNativeRequest,onError:(error,runtime)=>runtime.openCodexHooksError?.(error)
 });
 const permissionService=new (require('./native-permissions-service.cjs').NativePermissionService)({
  binary:nativeBinary,
  node:path.join(process.resourcesPath,'cua_node/bin/node'),abRoot,resourcesPath:process.resourcesPath,
  env:{...process.env},AppServerRpc:mod('app-server-rpc.js').AppServerRpc
 });
 const permissions=new (require('./native-permissions-runtime.cjs').NativePermissionRuntime)({service:permissionService,owners,closeHooks:runtime=>hooks.closeRuntime(runtime)});
 async function selectWorkspace(runtime,cwd,mode=runtime.permissionMode){
  if(runtime.openCodexWorkspaceTransition)throw Error('專案或權限正在更新，請稍候。');
  if(runtime.localCwd===cwd&&runtime.permissionMode===mode&&!runtime.openCodexWorkspaceFailed&&(!runtime.openCodexExtensionsDirty||runtime.run))return;
  if(runtime.run||runtime.closed)throw Error('請先停止工作，再切換專案或權限。');
  if(mode.startsWith('custom:'))permissions.capable(runtime);
  const operation={},extensionsRevision=runtime.openCodexExtensionsDirty;runtime.openCodexWorkspaceTransition=operation;
  runtime.openCodexWorkspaceFailed=true;let specs;
  const check=()=>{if(runtime.closed||runtime.openCodexPreparing?.cancelled||runtime.openCodexWorkspaceTransition!==operation)throw Error('專案切換已取消。');};
  try{
   await permissions.closeRuntime(runtime);check();
   specs=await deps.extensionServers(cwd,mode);check();
   await runtime.toolHost.setWorkspace(cwd,specs);check();
   runtime.localCwd=cwd;
   await permissions.select(runtime,mode);check();
   runtime.snapshot.permissionMode=runtime.permissionMode;runtime.snapshot.macTools=runtime.toolHost.status();
   runtime.openCodexWorkspaceFailed=false;
   if(runtime.openCodexExtensionsDirty===extensionsRevision)delete runtime.openCodexExtensionsDirty;
  }catch(error){specs?.openCodexNativeOwner?.close();await permissions.closeRuntime(runtime);throw error;}
  finally{if(runtime.openCodexWorkspaceTransition===operation)delete runtime.openCodexWorkspaceTransition;}
 }
 async function extensionTiming(stage,operation){
  const start=Date.now();let passed=false;
  try{const value=await operation();passed=true;return value;}
  finally{try{emit?.('opencodex:latency',{method:'extensions/refresh',stage,ms:Date.now()-start,passed});}catch{}}
 }
 const deps={
  stateDirectory:path.join(root,'agent-task-checkpoints'),connectConfig,emit,window:()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('app://')),
  extensions:async(cwd,runtime)=>{
   const catalog=await extensionTiming('disk-catalogue',()=>mod('extensions.js').localExtensions({cwd,agent:'codex'})),discovery=await extensionTiming('configured-servers',()=>discover({cwd}));
   for(const s of discovery.statuses){const item=catalog.items.find(i=>i.id===s.id);if(item){item.status=s.status;item.enabled=s.status!=='disabled';}}
   const nativeOwner=runtime?owners.owner(runtime):owners.inventory(cwd);
   if(nativeOwner){
    await extensionTiming('native-ready',()=>nativeOwner.ready());
    const skills=await extensionTiming('native-skills',()=>nativeOwner.rpc.request('skills/list',{cwds:[cwd],forceReload:true}));
    const byPath=new Map(catalog.items.filter(i=>i.path).map(i=>[i.path,i]));
    for(const group of skills.data||[])for(const skill of group.skills||[]){
     const entry=byPath.get(skill.path);
     const value={id:'native-skill:'+skill.path,kind:'skill',name:skill.name,description:skill.description,path:skill.path,enabled:skill.enabled===true,source:'Codex native',agent:'codex',executionLocation:'local'};
     if(entry)Object.assign(entry,value);else catalog.items.push(value);
    }
    for(const s of nativeOwner.statuses||[])catalog.items.push({id:'opencodex-native:'+s.name,name:s.name,kind:'mcp',enabled:s.status==='connected',status:s.status,source:'Codex native',executionLocation:'local'});
   }
   return {items:catalog.items.map(i=>({...i,enabled:i.enabled===true,executionLocation:'local'})),warnings:catalog.warnings};
  },
  readOnlyExtensionRoots:[path.join(os.homedir(),'.agents/skills'),path.join(extensionHome,'skills'),path.join(extensionHome,'plugins/cache'),path.join(process.env.CODEX_HOME,'skills'),path.join(process.env.CODEX_HOME,'plugins')].filter(p=>fs.existsSync(p)).map(p=>fs.realpathSync(p)),
  extensionServers:async(cwd,mode)=>{
   // A custom owner is created only after its catalogue and peer capability are verified.
   if(typeof mode==='string'&&mode.startsWith('custom:'))return [];
   const native=await owners.specs(cwd),names=new Set(native.map(s=>s.id.slice('opencodex-native:'.length)));
   const configured=(await discover({cwd})).servers.filter(s=>!names.has(s.name)).map(spec=>{if(spec.transport!=='http'||!spec.url)return spec;const authProvider=new (mod('mac-mcp-auth.js').MacMcpOAuthProvider)(path.join(root,'mac-mcp-auth.json'),spec.url,codec);return authProvider.tokens()?{...spec,authProvider}:spec;});
   return owners.tag([...native,...configured,...composio.specs().filter(s=>!configured.some(c=>c.url===s.url))],native);
  },
  refreshNativeTools:runtime=>extensionTiming('native-owner',()=>owners.refresh(runtime)),
  nativePermissionMode:value=>{require('./native-permissions-runtime.cjs').profileFor(value);return value;},
  initializeNativePermissions:async runtime=>{await permissions.select(runtime,runtime.permissionMode);await owners.refresh(runtime);},
  selectNativePermissions:(runtime,mode)=>mode===runtime.permissionMode&&!runtime.openCodexWorkspaceFailed&&!runtime.openCodexExtensionsDirty?permissions.select(runtime,mode):selectWorkspace(runtime,runtime.localCwd,mode),
  prepareNativePermissions:runtime=>permissions.prepare(runtime),
  validateNativePermissions:(runtime,threadId)=>permissions.validate(runtime,threadId),
  closeNativePermissions:runtime=>permissions.closeRuntime(runtime),
  nativePermissionSnapshot:runtime=>permissions.snapshot(runtime),
  prepareNativeHooks:runtime=>hooks.prepare(runtime),
  validateNativeHooks:(runtime,threadId)=>hooks.validate(runtime,threadId),
  cancelNativeRun:(runtime,run)=>{owners.owner(runtime)?.cancelRun(run);runtime.openCodexPermissions?.cancelRun(run);hooks.cancel(runtime,run);},
  libraryRoot:path.join(root,'library/files'),
  localTools:()=>({nativeCommand:provider.command(),browserCommand:{command:path.join(process.resourcesPath,'cua_node/bin/node'),args:[path.join(abRoot,'node_modules/@playwright/mcp/cli.js'),...mod('browser-runtime.js').browserRuntimeArgs(path.join(process.resourcesPath,'agentbridge/browser')),'--caps','vision,pdf,devtools','--snapshot-boxes','--user-data-dir',path.join(root,'runtime-browser-profile'),'--output-dir',path.join(root,'runtime-browser-output')],env:{ELECTRON_RUN_AS_NODE:'1'}}})
 };
 const backend=mod('runtime-backend.js');backend.registerRuntimeBackend(deps);
 const claudeBackend=mod('claude-local-backend.js');claudeBackend.registerClaudeLocalBackend(deps);
 mod('agent-orchestrator.js').registerAgentOrchestrator({emit});
 return {composio,runtimeDependencies:deps,claudeBackend,selectClaudeWorkspace:async(runtime,cwd)=>{
   if(runtime.cwd===cwd&&!runtime.openCodexWorkspaceFailed&&(!runtime.openCodexExtensionsDirty||runtime.run||runtime.cli.busy))return;
   if(runtime.run||runtime.cli.busy||runtime.closed)throw Error('請先停止工作，再切換專案。');
   const previous=owners.owner(runtime),extensionsRevision=runtime.openCodexExtensionsDirty;let specs;runtime.openCodexWorkspaceFailed=true;
   try{specs=await deps.extensionServers(cwd);if(runtime.closed)throw Error('Claude 連線已中斷。');await runtime.host.setWorkspace(cwd,specs);runtime.cwd=cwd;runtime.localCwd=cwd;runtime.cli.options.cwd=cwd;runtime.cli.permissionChanged=true;owners.bind(runtime,specs);previous?.close();runtime.openCodexWorkspaceFailed=false;if(runtime.openCodexExtensionsDirty===extensionsRevision)delete runtime.openCodexExtensionsDirty;}
   catch(e){specs?.openCodexNativeOwner?.close();throw e;}
  },selectWorkspace,invalidateNativeTools:()=>{
   owners.invalidate();
   for(const runtime of new Set([...permissions.pending.keys(),...permissionService.entries.keys()]))void permissions.closeRuntime(runtime,
    Object.assign(Error('工具或權限設定已變更，請重新連線。'),{code:'OPENCODEX_PERMISSION_CONFIG_CHANGED'}));
   void hooks.close();
  },closeNativeTools:async()=>{composio.close();await permissions.close();owners.close();await hooks.close();}};
};
