'use strict';process.noAsar=true;
const fs=require('node:fs'),path=require('node:path'),{patchAsar}=require('./patch-asar.cjs'),{archive}=require('./asar-reader.cjs');
const root=path.resolve(__dirname,'..'),app=path.join(root,'build/OpenCodex.app'),res=path.join(app,'Contents/Resources');
const original='/Applications/ChatGPT.app/Contents/Resources/app.asar';
const baseline=archive(original);
try{if(JSON.parse(baseline.read('package.json')).codexBuildNumber!=='20398')throw Error('ChatGPT native baseline changed. Use refresh-build.cjs for the verified OpenCodex bundle, or port and test every native patch before a full rebuild.');}finally{baseline.close();}
fs.mkdirSync(path.join(res,'opencodex-ui'),{recursive:true});
require('./bundle-native-hooks.cjs').bundleNativeHooks(res);
require('./bundle-permission-engine.cjs').bundlePermissionEngine(res);
for(const n of ['controls.html','controls.js','controls-preload.cjs'])fs.copyFileSync(path.join(root,'src',n),path.join(res,'opencodex-ui',n));
function replace(s,a,b){if(!s.includes(a))throw Error('Patch anchor missing: '+a.slice(0,100));if(s.indexOf(a)!==s.lastIndexOf(a))throw Error('Non-unique patch: '+a.slice(0,60));return s.replace(a,b);}
const a=archive(original),changes={},pkg=JSON.parse(a.read('package.json'));
pkg.name='opencodex-desktop';pkg.productName='OpenCodex';pkg.main='opencodex/bootstrap.cjs';pkg.openCodexVersion='0.4.11';
changes['package.json']=JSON.stringify(pkg,null,2);
for(const n of fs.readdirSync(path.join(root,'src')))if(n!=='bridge-adapter.cjs'&&n!=='native-preload.cjs')changes['opencodex/'+n]=fs.readFileSync(path.join(root,'src',n));
let boot=a.read('.vite/build/bootstrap-DOZRFVdo.js').toString();
boot=replace(boot,'f.app.setName(r.Ut(Hk))','f.app.setName("OpenCodex")');
boot=replace(boot,'enableUpdater:l.t.shouldIncludeUpdater(m,process.platform,process.env)','enableUpdater:false');
// This fork must never relocate, overwrite or update the user's official app.
boot=replace(boot,'if(u!==`darwin`||!s)return!1;if(y())','return!1;if(u!==`darwin`||!s)return!1;if(y())');
boot=replace(boot,'function rr(e){switch(e){','function rr(e){return `io.opencodex.desktop`;switch(e){');
changes['.vite/build/bootstrap-DOZRFVdo.js']=boot;
let nativeMain=a.read('.vite/build/main-CwxgTOle.js').toString();
nativeMain=replace(nativeMain,'D=p.t.shouldIncludeSparkle(o,process.platform,process.env),O=p.t.shouldIncludeUpdater(o,process.platform,process.env)','D=false,O=false');
changes['.vite/build/main-CwxgTOle.js']=nativeMain;
let preload=fs.readFileSync(path.join(root,'src/native-preload.cjs'),'utf8');
preload=replace(preload,"/*OPEN_CODEX_STYLES*/''",JSON.stringify(fs.readFileSync(path.join(root,'src/connections.css'),'utf8')));
preload=replace(preload,"/*OPEN_CODEX_PANEL*/''",JSON.stringify(fs.readFileSync(path.join(root,'src/connections.html'),'utf8')));
changes['.vite/build/preload.js']=a.read('.vite/build/preload.js').toString()+'\n'+preload;
// Only the local Codex composer uses SSH readiness. The remote server still enforces
// its account, quota and policy; no peer OAuth token is copied to the Mac.
const rendererPath='webview/assets/app-primary-2a670e99a60c.js';
let renderer=a.read(rendererPath).toString();
renderer=replace(renderer,'fe=q(V),pe;','fe=useOpenCodexBridgeReady(q(V)),pe;');
renderer+='\nfunction useOpenCodexBridgeReady(localAllowed){const api=window.openCodexRuntime;const [ready,setReady]=P9.useState(()=>api?.canSubmit()===true);P9.useEffect(()=>api?.subscribe(setReady),[]);return api?.isRemote()?ready:localAllowed;}\n';
changes[rendererPath]=require('./native-model-patches.cjs').refreshPrimaryModelLabel(renderer);
// SSH Codex is not a local ChatGPT Work account. Do not wait for a local Work
// enrollment/policy fetch that requires copying the peer's OAuth token.
const initialPath='webview/assets/app-initial-1ab6fbe93c4f.js';
let initial=a.read(initialPath).toString();
initial=replace(initial,'function Khi(e,{disableExposureLog:t=!1}={}){','function Khi(e,{disableExposureLog:t=!1}={}){if(window.openCodexRuntime?.isBridge())return!1;');
changes[initialPath]=require('./native-guardian-patches.cjs').initial(require('./native-model-patches.cjs').refreshNativeModels(initial));
const sharedPath='webview/assets/app-shared-8340f229c2b3.js';
changes[sharedPath]=require('./native-steer-patches.cjs').shared(require('./native-guardian-patches.cjs').shared(a.read(sharedPath).toString()));
const profilePath='webview/assets/profile-dropdown-items-4aea5fc452e5.js';
let profile=a.read(profilePath).toString();
profile=replace(profile,'}):null;if(n!=null){let e=n.profileIdentity','}):null;Hn=(0,$.jsx)(`div`,{\"data-opencodex-quota\":true});if(n!=null){let e=n.profileIdentity');
changes[profilePath]=profile;
a.close();
fs.copyFileSync(original,path.join(res,'app.asar'));
const hash=patchAsar(path.join(res,'app.asar'),changes);
fs.writeFileSync(path.join(root,'build/asar-hash.txt'),hash);
const ab=archive('/Applications/AgentBridge Studio.app/Contents/Resources/app.asar'),out=path.join(res,'agentbridge/app');
for(const[n,e]of Object.entries(ab.entries)){if(e.link)continue;const dest=path.join(out,n);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,ab.read(n),{mode:e.executable?0o755:0o644});}
for(const[n,e]of Object.entries(ab.entries)){if(!e.link)continue;const dest=path.join(out,n);fs.mkdirSync(path.dirname(dest),{recursive:true});try{fs.symlinkSync(path.relative(path.dirname(n),e.link),dest);}catch(error){if(error.code!=='EEXIST')throw error;}}
ab.close();
const mainPath=path.join(out,'dist-main/main.js');let main=fs.readFileSync(mainPath,'utf8');
main=replace(main,'const primaryInstance = electron_1.app.requestSingleInstanceLock();','const primaryInstance = true;\nconst openCodexBridgeWindows = new Set();');
main=replace(main,'if (primaryInstance)\n    electron_1.app.whenReady().then(createWindow);','// OpenCodex owns application startup.');
main=replace(main,'const windows = electron_1.BrowserWindow.getAllWindows().filter(window => !historyCloseAllowed.has(window.id));','const windows = electron_1.BrowserWindow.getAllWindows().filter(window => openCodexBridgeWindows.has(window.id) && !historyCloseAllowed.has(window.id));');
main=replace(main,'    mainWindow = window;','    openCodexBridgeWindows.add(window.id);\n    mainWindow = window;');
main=replace(main,'mainWindow = electron_1.BrowserWindow.getAllWindows()[0] || null;','mainWindow = electron_1.BrowserWindow.getAllWindows().find(w=>openCodexBridgeWindows.has(w.id)) || null;');
main=replace(main,'await window.loadFile(node_path_1.default.join(__dirname, "../dist-renderer/index.html"));','await window.loadFile(node_path_1.default.join(__dirname, "../dist-renderer/index.html"));\n    return window;');
main=main.replaceAll('process.resourcesPath','node_path_1.default.join(process.resourcesPath, "agentbridge")');
main=main.replaceAll('electron_1.app.getAppPath()','node_path_1.default.join(__dirname, "..")');
main=main.replaceAll('process.execPath','node_path_1.default.join(process.resourcesPath, "cua_node/bin/node")');
main=main.replaceAll('process.env.CODEX_HOME','process.env.OPENCODEX_EXTENSION_HOME');
main+='\nexports.createWindow=createWindow;exports.runtimeDependencies=runtimeDependencies;\n';
fs.writeFileSync(mainPath,main);
const runtimePath=path.join(out,'dist-main/runtime-backend.js');let runtime=fs.readFileSync(runtimePath,'utf8');
runtime=replace(runtime,'runtime = { id, conn, rpc, host, executor,','runtime = { openCodexInitialized: initialized, id, conn, rpc, host, executor,');
runtime=replace(runtime,"    if (runtime.permissionMode === 'full' && request.method !== 'item/tool/requestUserInput') {","    if (runtime.run?.openCodex && runtime.openCodexServerRequest?.(request)) return;\n    if (runtime.permissionMode === 'full' && request.method !== 'item/tool/requestUserInput') {");
runtime=replace(runtime,'async function refreshMacExtensions(runtime, deps) {','async function refreshMacExtensions(runtime, deps) {\n    await deps.refreshNativeTools?.(runtime);');
runtime=replace(runtime,'function authorizeMacTool(runtime, deps, call) {','async function authorizeMacTool(runtime, deps, call) {\n    deps.emit(\"opencodex:tool-policy\",{tool:call.name,category:call.category,mode:runtime?.permissionMode});\n    if(runtime?.run?.openCodex && !(await runtime.run.toolGate))return false;');
runtime=runtime.replaceAll('process.resourcesPath','node_path_1.default.join(process.resourcesPath, "agentbridge")');
runtime=require('./runtime-patches.cjs').sharedHostTrust(require('./runtime-patches.cjs').inventoryDeadline(runtime));
runtime=require('./runtime-patches.cjs').initializationDiagnostics(runtime);
runtime=require('./subagent-patches.cjs').backend(runtime);
runtime=require('./permission-patches.cjs').backend(runtime);
runtime+='\n'+fs.readFileSync(path.join(root,'src/bridge-adapter.cjs'),'utf8');fs.writeFileSync(runtimePath,runtime);
const claudePath=path.join(out,'dist-main/claude-local-backend.js');fs.writeFileSync(claudePath,require('./claude-patches.cjs').patchClaudeBackend(fs.readFileSync(claudePath,'utf8')));
const claudeRuntimePath=path.join(out,'dist-main/claude-local-runtime.js');fs.writeFileSync(claudeRuntimePath,require('./claude-patches.cjs').patchClaudeRuntime(fs.readFileSync(claudeRuntimePath,'utf8')));
const claudeAuthPath=path.join(out,'dist-main/claude-auth-probe.js');fs.writeFileSync(claudeAuthPath,require('./claude-patches.cjs').patchClaudeAuthProbe(fs.readFileSync(claudeAuthPath,'utf8')));
const executorPath=path.join(out,'dist-main/local-exec-server.js');
fs.writeFileSync(executorPath,require('./subagent-patches.cjs').executor(fs.readFileSync(executorPath,'utf8')));
const policyPath=path.join(out,'dist-main/runtime-policy.js');fs.writeFileSync(policyPath,replace(fs.readFileSync(policyPath,'utf8'),'startup_timeout_sec: 20','startup_timeout_sec: 45'));
for(const n of ['extensions.js','mac-extension-servers.js']){const f=path.join(out,'dist-main',n);fs.writeFileSync(f,fs.readFileSync(f,'utf8').replaceAll('process.env.CODEX_HOME','process.env.OPENCODEX_EXTENSION_HOME').replaceAll('os.environ.get("CODEX_HOME")','os.environ.get("OPENCODEX_EXTENSION_HOME")'));}
const extensionsPath=path.join(out,'dist-main/extensions.js');fs.writeFileSync(extensionsPath,require('./extension-scan-patches.cjs').extensionScan(fs.readFileSync(extensionsPath,'utf8')));
for(const n of ['agent-core-tools.js','admin-file-access.js']){const f=path.join(out,'dist-main',n);fs.writeFileSync(f,fs.readFileSync(f,'utf8').replaceAll('process.execPath',`require('node:path').join(process.resourcesPath,'cua_node/bin/node')`));}
// Native plugin clients retain the existing Mac approval and cancellation path.
const hostPath=path.join(out,'dist-main/local-tool-host.js');let host=fs.readFileSync(hostPath,'utf8');
host=replace(host,'const client = new mac_extension_servers_js_1.MacExtensionClient(spec);','const client = spec.createClient ? spec.createClient() : new mac_extension_servers_js_1.MacExtensionClient(spec);');
host=replace(host,'category: "extension", available: () => client.running','category: "extension", extensionId: spec.id, available: () => client.running');
host=replace(host,'    async registerExtension(spec) {',`    async replaceNativeExtensions(specs) {
        if (this.active.size) throw Error('請先停止工具，再更新原生外掛。');
        for (const [id, client] of this.extensionClients) if (id.startsWith('opencodex-native:')) {
            await client.stop(); this.extensionClients.delete(id);
        }
        for (const [name, entry] of this.entries) if (entry.extensionId?.startsWith('opencodex-native:')) this.entries.delete(name);
        this.extensionStatuses = this.extensionStatuses.filter(s => !s.id.startsWith('opencodex-native:'));
        await Promise.all(specs.map(spec => this.registerExtension(spec)));
    }
    async registerExtension(spec) {`);
host=require('./runtime-patches.cjs').discussionDeadline(host);
fs.writeFileSync(policyPath,require('./runtime-patches.cjs').discussionTransportDeadline(fs.readFileSync(policyPath,'utf8')));
const corePath=path.join(out,'dist-main/agent-core-tools.js');fs.writeFileSync(corePath,require('./subagent-patches.cjs').core(fs.readFileSync(corePath,'utf8')));
host=require('./subagent-patches.cjs').hooksHost(require('./subagent-patches.cjs').host(host));
host+='\n'+fs.readFileSync(path.join(root,'src/workspace-host.cjs'),'utf8');
fs.writeFileSync(hostPath,host);
// Retain third-party notices, licenses and original source separately.
fs.copyFileSync(path.join(root,'vendor/agentbridge/LICENSE'),path.join(res,'agentbridge/LICENSE'));
console.log(JSON.stringify({app,asarHeaderSHA256:hash,bridgeFiles:Object.keys(archive('/Applications/AgentBridge Studio.app/Contents/Resources/app.asar').entries).length}));
