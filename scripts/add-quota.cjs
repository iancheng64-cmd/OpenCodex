const fs=require('fs');
const f='src/bootstrap.cjs';let s=fs.readFileSync(f,'utf8');
function replace(a,b){if(s.split(a).length!==2)throw Error('Anchor '+a);s=s.replace(a,b);}
replace("process.env.CODEX_ELECTRON_USER_DATA_PATH=root;","process.env.CODEX_ELECTRON_USER_DATA_PATH=root;\nfor(const key of ['CODEX_ELECTRON_DEV_PARENT_PID','CODEX_ELECTRON_DEV_WEBVIEW_PID','CODEX_ELECTRON_DEV_RELAUNCH_MARKER_PATH'])delete process.env[key];");
replace("version:app.getVersion()","version:'0.1.0',quota:quotaMonitor.snapshot()");
replace("function send(ws,value)","const {rateLimitSummary}=require(path.join(abRoot,'dist-main/runtime-usage.js'));\nconst quotaMonitor=require('./quota.cjs')({normalize:rateLimitSummary,publish,getSource:()=>settings.mode==='bridge'?(runtime&&!runtime.closed?{key:runtime.id,rpc:runtime.rpc,label:'SSH Runtime · '+runtime.snapshot.hostName}:null):(localRpc&&!localRpc.isClosed?{key:settings.mode,rpc:localRpc,label:settings.mode==='official'?'本機官方登入':'自訂 API'}:null)});\nfunction send(ws,value)");
replace("if(settings.mode!=='bridge')for(const ws of clients)send(ws,m);","if(settings.mode!=='bridge'){for(const ws of clients)send(ws,m);if(m.method==='account/updated')quotaMonitor.invalidate();else if(m.method==='account/rateLimits/updated'||m.method==='turn/completed')quotaMonitor.refresh();}");
replace("localRpc.notify('initialized');return r;","localRpc.notify('initialized');if(settings.mode!=='bridge')quotaMonitor.refresh();return r;");
replace("runtime=value;bridgeError=null;","runtime=value;bridgeError=null;const attached=runtime;quotaMonitor.reset();");
replace("runtime.rpc.on('notification',m=>{if(settings.mode==='bridge')for(const ws of clients)send(ws,m);});","runtime.rpc.on('notification',m=>{if(runtime!==attached||settings.mode!=='bridge')return;for(const ws of clients)send(ws,m);if(m.method==='account/updated')quotaMonitor.invalidate();else if(m.method==='account/rateLimits/updated'||m.method==='turn/completed')quotaMonitor.refresh();});");
replace("runtime.rpc.on('closed',()=>{bridgeError=","runtime.rpc.on('closed',()=>{if(runtime!==attached)return;quotaMonitor.reset(null,'disconnected');bridgeError=");
replace("version:runtime.snapshot.runtimeVersion});publish();","version:runtime.snapshot.runtimeVersion});publish();quotaMonitor.refresh();");
replace("width:630,height:640","width:680,height:820");
replace("handle('opencodex:status',()=>publicState());","handle('opencodex:status',()=>publicState());\nhandle('opencodex:quota',async()=>{if(settings.mode!=='bridge')await readyLocal();await quotaMonitor.refresh();return publicState();});");
replace("label:'AgentBridge 管理…'","label:'SSH 連線／AgentBridge 管理…'");
replace("app.on('before-quit',()=>{localChild?.kill('SIGTERM');server.close();});","const quotaTimer=setInterval(()=>quotaMonitor.refresh(),30000);quotaTimer.unref();\n app.on('before-quit',()=>{clearInterval(quotaTimer);localChild?.kill('SIGTERM');server.close();});");
fs.writeFileSync(f,s);console.log('Quota source integration complete');
