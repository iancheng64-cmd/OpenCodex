'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),bundle=process.argv[2];
let source,asarSHA256;
if(bundle){const a=require('./asar-reader.cjs').archive(bundle);source=a.read('opencodex/bootstrap.cjs').toString();a.close();asarSHA256=crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');}
else source=fs.readFileSync(path.join(root,'src/bootstrap.cjs'),'utf8');
const connect=source.slice(source.indexOf('async function connectBridge('),source.indexOf('async function disconnectPeer('));
const startup=source.slice(source.indexOf(' // Keep native startup independent'),source.indexOf(" app.on('browser-window-created'"));
assert(connect&&startup,'Startup wiring absent');
const tests=[];
function fixture(){
 const selected={id:'saved',name:'Saved',host:'host.invalid',port:22,runtimePlatform:'windows'};
 const c={peerReconnect:{cancel(){},schedule(){}},mainReconnect:{cancel(){},schedule(){}},pendingDefault:null,applyPendingDefault(){},work:()=>false,settings:{mode:'ssh',profileId:'saved',profileName:'Saved',cwd:'/workspace',codexConnections:{saved:{executable:'C:\\OpenCodex\\codex.exe'}}},connecting:false,permissionChanging:false,pendingConnection:null,hostConfirmation:null,agents:null,claude:{queue:{starting:false},connected:false,runtime:null},runtime:null,peer:null,handoff:null,localTurns:new Set(),nativeShell:{},nativeQueue:{},bridgeError:null,shuttingDown:false,crypto,
 profiles:[{id:'other',name:'Other'},selected],calls:[],events:[],jobs:[],publications:[],saves:0};
 c.isRemote=()=>c.settings.mode==='ssh';c.isClaude=()=>c.settings.sshAgent==='claude';
 c.nativePolicy={resolveMode:()=>({effective:'project'})};
 c.validateProfile=()=>{};c.validateCwd=x=>x;c.codexConnection=x=>x||{};c.claudeConnection=x=>x||{};
 c.publicState=()=>({connected:!!(c.runtime&&!c.runtime.closed||c.claude.connected),error:c.bridgeError,connecting:c.connecting});
 c.publish=()=>c.publications.push(c.publicState());c.save=()=>c.saves++;c.notifyRemoteState=()=>{};c.disconnectPeer=async()=>{};
 c.attach=r=>c.runtime=r;c.claude.attach=r=>{c.claude.runtime=r;c.claude.connected=true;};
 c.backend={openCodexRuntimes:new Map([['r',{id:'r',closed:false}]])};
 c.bridge={claudeBackend:{openCodexClaudeRuntimes:new Map([['r',{id:'r',closed:false}]])}};
 c.handlers=new Map([['profiles:list',async()=>c.profiles],['runtime:connect',async(_,params)=>{c.calls.push(params);return {runtimeId:'r'};}],['claude:connect',async(_,params)=>{c.calls.push(params);return {runtimeId:'r'};}],['runtime:disconnect',async()=>{}]]);
 c.audit=(type,data)=>c.events.push({type,...data});c.app={whenReady:()=>Promise.resolve()};
 c.connectionIntent=0;c.nativeConfigMutations={settled:async()=>{}};c.setTimeout=fn=>fn();
 c.quotaMonitor={reset(){}};c.claude.disconnect=async()=>{c.claude.connected=false;};
 c.external={closeAll:async()=>{}};c.connectProviders=async()=>{};c.restorePeer=async()=>{};c.refreshQuotas=async()=>{};
 c.handle=(name,fn)=>c.handlers.set(name,fn);
 c.setImmediate=fn=>c.jobs.push(fn);
 vm.createContext(c);vm.runInContext(connect,c);
 vm.runInContext(source.split('\n').find(line=>line.startsWith("handle('opencodex:disconnect'")),c);
 return c;
}
function enablePeer(c){delete c.restorePeer;vm.runInContext(source.slice(source.indexOf('let restoring=null;'),source.indexOf('\nconst clients=new Set()')),c);}
async function settlePeer(c){for(let i=0;i<50;i++){await new Promise(r=>setImmediate(r));if(vm.runInContext('restoring===null',c))return;}throw Error('Peer restoration did not settle');}
async function start(c){vm.runInContext(startup,c);await Promise.resolve();assert.equal(c.calls.length,0,'SSH must not block ready callback');const jobs=c.jobs.splice(0);await Promise.all(jobs.map(fn=>fn()));if(c.handoff)await settlePeer(c);}
async function check(name,fn){await fn();tests.push(name);}
(async()=>{
 await check('saved host, engine, workspace and permission are reused instead of the first host',async()=>{const c=fixture();await c.connectBridge({automatic:true});assert.equal(c.calls.length,1);assert.equal(c.calls[0].profile.id,'saved');assert.equal(c.calls[0].executable,c.settings.codexConnections.saved.executable);assert.equal(c.calls[0].localCwd,'/workspace');assert.equal(c.calls[0].permissionMode,'project');assert.equal(c.connecting,false);});
 await check('legacy saved name is resolved without arbitrary fallback',async()=>{const c=fixture();delete c.settings.profileId;await c.connectBridge({automatic:true});assert.equal(c.calls[0].profile.id,'saved');});
 await check('deleted saved host is reported and never replaced by another host',async()=>{const c=fixture();c.settings.profileId='deleted';await assert.rejects(c.connectBridge({automatic:true}),/已儲存的 SSH 主機不存在/);assert.equal(c.calls.length,0);assert.equal(c.connecting,false);assert.match(c.bridgeError,/不存在/);});
 await check('fresh profile with no selected host remains usable offline',async()=>{const c=fixture();delete c.settings.profileId;c.settings.profileName='missing';await c.connectBridge({automatic:true});assert.equal(c.calls.length,0);assert.equal(c.bridgeError,null);assert.equal(c.connecting,false);});
 await check('concurrent manual connect cannot race an asynchronous profile lookup',async()=>{const c=fixture();let release;c.handlers.set('profiles:list',()=>new Promise(r=>release=r));const first=c.connectBridge({automatic:true});assert.equal(c.connecting,true);await assert.rejects(c.connectBridge({profileId:'other'}),/連線或權限/);release(c.profiles);await first;assert.equal(c.calls.length,1);});
 await check('profile lookup failure releases the connection lock and permits retry',async()=>{const c=fixture();c.handlers.set('profiles:list',async()=>{throw Error('profile unavailable');});await assert.rejects(c.connectBridge({automatic:true}),/profile unavailable/);assert.equal(c.connecting,false);c.handlers.set('profiles:list',async()=>c.profiles);await c.connectBridge();assert.equal(c.calls.length,1);});
 await check('invalid workspace releases the connection lock and preserves saved settings',async()=>{const c=fixture();c.validateCwd=()=>{throw Error('invalid workspace');};await assert.rejects(c.connectBridge({automatic:true}),/invalid workspace/);assert.equal(c.connecting,false);assert.equal(c.saves,0);});
 await check('unknown host key requires confirmation without auto-trust',async()=>{const c=fixture();c.handlers.set('runtime:connect',async(_,params)=>{c.calls.push(params);return {status:'host-confirmation',hostFingerprint:'SHA256:fixture'};});await c.connectBridge({automatic:true});assert(c.hostConfirmation);assert.equal(c.calls[0].trustedFingerprint,undefined);assert.equal(c.connecting,false);assert.equal(c.saves,0);});
 await check('failed authentication leaves a visible error and manual retry works',async()=>{const c=fixture();c.handlers.set('runtime:connect',async()=>{throw Error('authentication required');});await start(c);assert.equal(c.bridgeError,'authentication required');assert.equal(c.connecting,false);assert(c.events.some(e=>e.type==='ssh-autoconnect-failed'));c.handlers.set('runtime:connect',async(_,p)=>{c.calls.push(p);return {runtimeId:'r'};});await c.connectBridge({password:'test-only'});assert.equal(c.runtime.id,'r');assert.equal(c.bridgeError,null);});
 for(const mode of ['official','custom'])await check(mode+' mode does not initiate SSH',async()=>{const c=fixture();c.settings.mode=mode;await start(c);assert.equal(c.calls.length,0);assert.equal(c.events[0].autoConnect,false);});
 await check('startup automatically connects without any renderer connect action',async()=>{const c=fixture();await start(c);assert.equal(c.calls.length,1);assert.equal(c.runtime.id,'r');assert(c.events.some(e=>e.type==='ssh-autoconnect-finished'&&e.connected));});
 for(const state of ['connecting','permissionChanging','shuttingDown','hostConfirmation','runtime','claude'])await check('startup respects '+state,async()=>{const c=fixture();if(state==='runtime')c.runtime={closed:false};else if(state==='claude')c.claude.connected=true;else c[state]=true;await start(c);assert.equal(c.calls.length,0);});
 await check('closed previous runtime does not suppress startup',async()=>{const c=fixture();c.runtime={id:'old',closed:true};await start(c);assert.equal(c.calls.length,1);});
 await check('manual disconnect is not followed by a retry timer',async()=>{const c=fixture();await start(c);c.runtime=null;for(let n=0;n<5;n++)await Promise.resolve();assert.equal(c.calls.length,1);assert.equal(c.jobs.length,0);});
 await check('configuration migration retries only after pending native writes settle',async()=>{
  const c=fixture();let attempts=0,settles=0;
  c.nativeConfigMutations.settled=async()=>{settles++;};
  c.handlers.set('runtime:connect',async(_,params)=>{c.calls.push(params);if(++attempts===1)throw Object.assign(Error('configuration changed'),{code:'OPENCODEX_PERMISSION_CONFIG_CHANGED'});assert.equal(settles,2);return {runtimeId:'r'};});
  await start(c);assert.equal(attempts,2);assert(c.runtime);assert.equal(c.events.filter(e=>e.type==='ssh-autoconnect-config-retry').length,1);
 });
 await check('continuous config changes stop after three attempts and leave an actionable error',async()=>{
  const c=fixture();let attempts=0;c.handlers.set('runtime:connect',async()=>{attempts++;throw Object.assign(Error('configuration changed'),{code:'OPENCODEX_PERMISSION_CONFIG_CHANGED'});});
  await start(c);assert.equal(attempts,3);assert.equal(c.bridgeError,'configuration changed');assert(!c.runtime);assert.equal(c.events.filter(e=>e.type==='ssh-autoconnect-failed').length,1);
 });
 for(const message of ['authentication required','connection timeout','configuration changed'])await check('unclassified '+message+' does not retry',async()=>{
  const c=fixture();let attempts=0;c.handlers.set('runtime:connect',async()=>{attempts++;throw Error(message);});await start(c);assert.equal(attempts,1);
 });
 for(const action of ['disconnect','manual-connect','shutdown','mode-change'])await check(action+' cancels a pending startup retry',async()=>{
  const c=fixture();let attempts=0;c.handlers.set('runtime:connect',async()=>{if(++attempts===1)throw Object.assign(Error('configuration changed'),{code:'OPENCODEX_PERMISSION_CONFIG_CHANGED'});return {runtimeId:'r'};});
  c.setTimeout=resolve=>{Promise.resolve().then(async()=>{
   if(action==='disconnect')await c.handlers.get('opencodex:disconnect')();
   else if(action==='manual-connect'){await c.connectBridge();await c.handlers.get('opencodex:disconnect')();}
   else if(action==='shutdown')c.shuttingDown=true;
   else c.settings.mode='official';
   resolve();
  });};
  await start(c);assert.equal(attempts,action==='manual-connect'?2:1);assert(!c.runtime);
 });
 await check('sidebar Claude choice with an offline saved collaborator reconnects instead of relaunching',async()=>{
  const c=fixture(),block=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
  c.settings.peerProfileId='saved';c.runtime={id:'main',closed:false};c.clients=new Set();c.send=()=>{};c.relaunched=false;c.app.relaunch=()=>{c.relaunched=true;};
  c.handoff={providers:new Map(),attach(r){this.runtime=r;},detach(){},get connected(){return !!this.runtime;},setDefault(e){if(e==='claude'&&!this.runtime)throw Error('offline');this.engine=e;},get defaultEngine(){return this.engine||'codex';}};
  c.handoff.providers.set('claude',{models:()=>c.handoff.runtime?[{id:'model'}]:[]});
  delete c.applyPendingDefault;delete c.restorePeer;
  vm.runInContext(block('let restoring=null;','\nconst clients=new Set()'),c);
  vm.runInContext(block('function modelsChanged(',"handle('opencodex:mode'"),c);
  await c.handlers.get('opencodex:handoff-default')({},{engine:'claude'});
  for(let i=0;i<10&&c.pendingDefault;i++)await new Promise(r=>setImmediate(r));
  assert.equal(c.relaunched,false);assert.equal(c.handoff.runtime.id,'r');assert.equal(c.handoff.engine,'claude');assert.equal(c.pendingDefault,null);
  assert(c.events.some(e=>e.type==='handoff-default'&&e.applied));
 });
 await check('saved Claude peer reconnects after GPT startup for same-thread handoff',async()=>{const c=fixture();c.settings.peerProfileId='saved';c.handoff={attach(r){this.runtime=r;},detach(){},get connected(){return !!this.runtime;}};enablePeer(c);await start(c);assert.equal(c.calls.length,2);assert.equal(c.handoff.runtime.id,'r');assert(c.events.some(e=>e.type==='ssh-peer-restored'&&e.connected));});
 await check('a failed Claude peer reconnect keeps GPT usable and reports an actionable collaborator error',async()=>{const c=fixture();c.settings.peerProfileId='saved';c.handoff={attach(){},detach(){}};c.handlers.set('claude:connect',async()=>{throw Error('peer down');});enablePeer(c);await start(c);assert(c.runtime);assert.match(c.bridgeError,/協作 Claude 自動重連失敗/);assert.equal(c.events.filter(e=>e.type==='ssh-peer-restore-failed').length,3);});
 await check('a collaborator connection is published separately and never marks the main connection busy',async()=>{const c=fixture();c.settings.peerProfileId='saved';c.handoff={attach(r){this.runtime=r;},detach(){},get connected(){return !!this.runtime;}};const seen=[];c.handlers.set('runtime:connect',async(_,params)=>{seen.push(['main',c.connecting,c.connectingPeer]);c.calls.push(params);return {runtimeId:'r'};});c.handlers.set('claude:connect',async(_,params)=>{seen.push(['peer',c.connecting,c.connectingPeer]);c.calls.push(params);return {runtimeId:'r'};});enablePeer(c);await start(c);assert.deepEqual(seen,[['main',true,false],['peer',true,true]]);assert.equal(c.connecting,false);assert.equal(c.connectingPeer,false);});
 await check('saved Claude mode uses its own connection handler',async()=>{const c=fixture();c.settings.sshAgent='claude';await start(c);assert.equal(c.claude.connected,true);assert.equal(c.calls[0].executable,undefined);});
 const report={at:new Date().toISOString(),passed:true,sourceSHA256:crypto.createHash('sha256').update(source).digest('hex'),asarSHA256,tests};
 fs.writeFileSync(path.join(root,'evidence/native-startup-'+(bundle?'bundle':'source')+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;});
