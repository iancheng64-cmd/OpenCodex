'use strict';
// Refresh only OpenCodex-owned code in a previously verified native bundle.
// This avoids mixing an auto-updated ChatGPT ASAR with the pinned framework.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {archive}=require('./asar-reader.cjs'),{patchAsar}=require('./patch-asar.cjs');
const root=path.resolve(__dirname,'..'),app=path.join(root,'build/OpenCodex.app'),res=path.join(app,'Contents/Resources'),file=path.join(res,'app.asar');
cp.execFileSync('codesign',['--verify','--deep','--strict',app]);
const running=cp.execFileSync('ps',['-axo','comm='],{encoding:'utf8'}).split('\n');
if(running.some(s=>s.trim().startsWith(app+'/')))throw Error('Close the development app before refreshing its bundle.');
const a=archive(file),pkg=JSON.parse(a.read('package.json'));
if(pkg.name!=='opencodex-desktop'||!['0.4.1','0.4.2','0.4.3','0.4.4','0.4.5','0.4.6','0.4.7','0.4.8','0.4.9','0.4.10','0.4.11'].includes(pkg.openCodexVersion)||pkg.codexBuildNumber!=='20398')throw Error('Unrecognized native baseline');
const nativePreload=a.read('.vite/build/preload.js').toString();
const marker=";(()=>{\n const {ipcRenderer,contextBridge}=require('electron');";
const offset=nativePreload.indexOf(marker);
if(offset<0||offset!==nativePreload.lastIndexOf(marker))throw Error('OpenCodex preload boundary missing');
let preload=fs.readFileSync(path.join(root,'src/native-preload.cjs'),'utf8');
preload=preload.replace("/*OPEN_CODEX_STYLES*/''",JSON.stringify(fs.readFileSync(path.join(root,'src/connections.css'),'utf8')));
preload=preload.replace("/*OPEN_CODEX_PANEL*/''",JSON.stringify(fs.readFileSync(path.join(root,'src/connections.html'),'utf8')));
pkg.openCodexVersion='0.4.11';
const changes={'package.json':JSON.stringify(pkg),'.vite/build/preload.js':nativePreload.slice(0,offset)+preload};
for(const name of fs.readdirSync(path.join(root,'src'))){
 if(['bridge-adapter.cjs','native-preload.cjs'].includes(name))continue;
 if(!a.entries['opencodex/'+name]&&!['credential-migrate.c','native-claude.cjs','native-profile.cjs','native-agents.cjs','native-tool-owners.cjs','native-helper-cleanup.cjs','native-history.cjs','native-organization.cjs','native-mcp.cjs','native-subagents.cjs','native-run-context.cjs','native-agent-runs.cjs','native-connection.cjs','native-hooks-client.cjs','native-hooks-inventory.cjs','native-hooks-mcp.cjs','native-hooks-relay.cjs','native-hooks-runtime.cjs','native-hooks-service.cjs','native-permission-catalog.cjs','native-permissions-input.cjs','native-permissions-process-gate.cjs','native-permissions-tools.cjs','native-permissions-service.cjs','native-permissions-worker.cjs','native-permissions-dispatch.cjs','native-permissions-runtime.cjs','native-app-context.cjs','native-input.cjs','native-config-mutations.cjs','native-guardian.cjs','native-guardian-runtime.cjs','native-handoff.cjs','native-peer-reconnect.cjs','unified-handoff.cjs','external-providers.cjs','composio.cjs'].includes(name))throw Error('Unexpected new bundled source: '+name);
 changes['opencodex/'+name]=fs.readFileSync(path.join(root,'src',name));
}
const rendererPath='webview/assets/app-primary-2a670e99a60c.js';
changes[rendererPath]=require('./native-model-patches.cjs').refreshPrimaryModelLabel(a.read(rendererPath).toString());
const initialPath='webview/assets/app-initial-1ab6fbe93c4f.js';
changes[initialPath]=require('./native-guardian-patches.cjs').initial(require('./native-model-patches.cjs').refreshNativeModels(a.read(initialPath).toString()));
const sharedPath='webview/assets/app-shared-8340f229c2b3.js';
changes[sharedPath]=require('./native-steer-patches.cjs').shared(require('./native-guardian-patches.cjs').shared(a.read(sharedPath).toString()));
const widgetPath='webview/assets/widget-338e9f889b2d.js';
changes[widgetPath]=require('./native-mcp-patches.cjs').patchWidget(a.read(widgetPath).toString());
const profilePath='webview/assets/profile-dropdown-items-4aea5fc452e5.js';
changes[profilePath]=a.read(profilePath).toString().replace('if(window.openCodexRuntime?.isRemote())Hn=','Hn=');
const runtimeChanges=[];
for(const [source,relative] of [['bridge-adapter.cjs','dist-main/runtime-backend.js'],['workspace-host.cjs','dist-main/local-tool-host.js']]){
 const code=fs.readFileSync(path.join(root,'src',source),'utf8'),target=path.join(res,'agentbridge/app',relative);
 const bundled=fs.readFileSync(target,'utf8'),marker='\n'+code.split('\n')[0],offset=bundled.indexOf(marker);
 if(offset<0||offset!==bundled.lastIndexOf(marker))throw Error(source+' requires a full compatible rebuild');
 let prefix=bundled.slice(0,offset);
 if(source==='bridge-adapter.cjs'){const patches=require('./runtime-patches.cjs');prefix=patches.initializationDiagnostics(patches.sharedHostTrust(patches.inventoryDeadline(prefix)));}
 if(source==='workspace-host.cjs')prefix=require('./runtime-patches.cjs').discussionDeadline(prefix);
 prefix=require('./subagent-patches.cjs')[source==='bridge-adapter.cjs'?'backend':'host'](prefix);
 if(source==='workspace-host.cjs')prefix=require('./subagent-patches.cjs').hooksHost(prefix);
 if(source==='bridge-adapter.cjs')prefix=require('./permission-patches.cjs').backend(prefix);
 runtimeChanges.push([target,prefix+'\n'+code]);
}
const extensionsPath=path.join(res,'agentbridge/app/dist-main/extensions.js');
runtimeChanges.push([extensionsPath,require('./extension-scan-patches.cjs').extensionScan(fs.readFileSync(extensionsPath,'utf8'))]);
const executorPath=path.join(res,'agentbridge/app/dist-main/local-exec-server.js');
runtimeChanges.push([executorPath,require('./subagent-patches.cjs').executor(fs.readFileSync(executorPath,'utf8'))]);
const corePath=path.join(res,'agentbridge/app/dist-main/agent-core-tools.js');
runtimeChanges.push([corePath,require('./subagent-patches.cjs').core(fs.readFileSync(corePath,'utf8'))]);
const policyPath=path.join(res,'agentbridge/app/dist-main/runtime-policy.js');
runtimeChanges.push([policyPath,require('./runtime-patches.cjs').discussionTransportDeadline(fs.readFileSync(policyPath,'utf8'))]);
const claudePath=path.join(res,'agentbridge/app/dist-main/claude-local-backend.js');
runtimeChanges.push([claudePath,require('./claude-patches.cjs').patchClaudeBackend(fs.readFileSync(claudePath,'utf8'))]);
const claudeRuntimePath=path.join(res,'agentbridge/app/dist-main/claude-local-runtime.js');
runtimeChanges.push([claudeRuntimePath,require('./claude-patches.cjs').patchClaudeRuntime(fs.readFileSync(claudeRuntimePath,'utf8'))]);
const claudeAuthPath=path.join(res,'agentbridge/app/dist-main/claude-auth-probe.js');
runtimeChanges.push([claudeAuthPath,require('./claude-patches.cjs').patchClaudeAuthProbe(fs.readFileSync(claudeAuthPath,'utf8'))]);
a.close();
// Refresh JS without rebuilding unchanged native components after build-cache cleanup.
// The entire starting bundle was signature-verified above; also verify each component's signature and architecture.
for(const [source,destination,report,moduleName,method] of [
 ['opencodex-hooks-helper','opencodex-hooks-helper','hooks-bundle.json','bundle-native-hooks.cjs','bundleNativeHooks'],
 ['codex','opencodex-permission-engine','permission-engine-bundle.json','bundle-permission-engine.cjs','bundlePermissionEngine']
]){
 if(fs.existsSync(path.join(root,'build/hooks-target/debug',source)))require('./'+moduleName)[method](res);
 else{
  const binary=path.join(res,destination);
  cp.execFileSync('codesign',['--verify','--strict',binary]);
  const kind=cp.execFileSync('/usr/bin/file',['-b',binary],{encoding:'utf8'});
  if(!kind.includes('Mach-O 64-bit executable arm64'))throw Error('Unexpected retained architecture: '+destination);
  if(source==='codex')cp.execFileSync(process.execPath,[path.join(__dirname,'permission-engine-check.cjs'),binary],{timeout:20000});
  console.log('Retained verified native component: '+destination);
 }
}
const before=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const header=patchAsar(file,changes);
fs.writeFileSync(path.join(root,'build/asar-hash.txt'),header);
for(const [target,code] of runtimeChanges)fs.writeFileSync(target,code);
for(const name of ['controls.html','controls.js','controls-preload.cjs'])fs.copyFileSync(path.join(root,'src',name),path.join(res,'opencodex-ui',name));
const report={at:new Date().toISOString(),version:'0.4.11',nativeBuild:pkg.codexBuildNumber,before,after:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),updated:Object.keys(changes),requiresSigning:true};
fs.writeFileSync(path.join(root,'evidence/refresh-build.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
