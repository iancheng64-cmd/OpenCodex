'use strict';
// Launch the signed app without invoking any renderer connection action.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {cdp,wait}=require('./qa-client.cjs');
const root=path.resolve(__dirname,'..'),app=path.join(root,'build/OpenCodex.app'),base=path.join(os.homedir(),'Library/Application Support/OpenCodex');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const report={at:new Date().toISOString(),version:'0.4.10',passed:false,checks:[]};
let client;
(async()=>{
 const processes=cp.execFileSync('ps',['-axo','comm='],{encoding:'utf8'}).split('\n');
 assert(!processes.some(s=>s.trim().includes('/OpenCodex.app/Contents/MacOS/')),'Close OpenCodex before testing a fresh launch');
 cp.execFileSync('codesign',['--verify','--deep','--strict',app]);
 const settings=JSON.parse(fs.readFileSync(path.join(base,'opencodex.json')));
 assert.equal(settings.mode,'ssh');assert.equal(settings.sshAgent,'codex');assert(settings.profileId);
 report.asarSHA256=sha(fs.readFileSync(path.join(app,'Contents/Resources/app.asar')));
 cp.execFileSync('open',[app,'--args','--remote-debugging-port=9325','--opencodex-test']);
 await wait(async()=>{try{client=await cdp();return true;}catch{return false;}},30000);
 let state;
 await wait(async()=>{
  try{
   state=await client.evaluate('window.openCodexRuntime?.status()');
  }catch(error){
   // The native frontend can navigate once while restoring its saved route.
   // Retry that transient CDP context loss, but retain all product failures.
   if(!/Execution context was destroyed|Cannot find context with specified id/.test(error.message))throw error;
   return false;
  }
  if(!state)return false;
  return state.connected&&state.toolsReady&&!state.permissionBusy;
 },180000);
 assert.equal(state.version,report.version);assert.equal(state.connectionStage,'ready');assert.equal(state.diagnostic,null);
 // The saved per-thread selection remains intact while the global full-access
 // switch overrides the executor's effective mode.
 assert.equal(state.permissionMode,settings.fullAccess===true?'full':settings.permissionMode);assert.equal(state.fullAccess,settings.fullAccess);
 assert.equal(await client.evaluate('window.openCodexRuntime.canSubmit()'),true);
 assert.equal(sha(fs.readFileSync(path.join(app,'Contents/Resources/app.asar'))),report.asarSHA256);
 const events=fs.readFileSync(path.join(base,'adapter-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  .filter(e=>Date.parse(e.at)>=Date.parse(report.at)&&/^(shell-ready|ssh-autoconnect-|ssh-connected)/.test(e.type));
 assert.equal(events.filter(e=>e.type==='shell-ready').length,1);
 const starts=events.filter(e=>e.type==='ssh-autoconnect-start'),finished=events.filter(e=>e.type==='ssh-autoconnect-finished');
 assert(starts.length>=1&&starts.length<=3);assert.equal(finished.length,1);assert.equal(finished[0].connected,true);
 assert(!events.some(e=>e.type==='ssh-autoconnect-failed'));
 report.events=events;
 report.status={connected:state.connected,toolsReady:state.toolsReady,connectionStage:state.connectionStage,permissionMode:state.permissionMode,fullAccess:state.fullAccess,canSubmit:true};
 report.checks=['Fresh signed app starts SSH without a renderer connect action','Saved permission selection survives initialization','SSH and Mac tools become ready with an enabled composer'];
 report.passed=true;
})().catch(error=>{report.error=error.stack;process.exitCode=1;}).finally(()=>{
 client?.close();report.completedAt=new Date().toISOString();
 fs.writeFileSync(path.join(root,'evidence/native-startup-live.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
 // CDP/HTTP keep-alive handles must not keep a completed CLI check alive.
 process.exit(process.exitCode||0);
});
