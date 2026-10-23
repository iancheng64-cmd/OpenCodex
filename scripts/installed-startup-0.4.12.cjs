'use strict';
// Normal installed launch: no CDP, test flag, renderer connection action or approvals.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto'),net=require('node:net'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),app='/Applications/OpenCodex.app',base=path.join(os.homedir(),'Library/Application Support/OpenCodex');
const report={version:'0.4.12',at:new Date().toISOString(),passed:false,scope:'Normal installed startup and automatic SSH; native window content not inspected'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const processes=()=>cp.execFileSync('ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').filter(s=>s.includes('/OpenCodex.app/Contents/MacOS/'));
const portOpen=(host,port)=>new Promise(resolve=>{const socket=net.connect({host,port});const done=value=>{socket.destroy();resolve(value);};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.setTimeout(1000,()=>done(false));});
(async()=>{
 const release=JSON.parse(fs.readFileSync(path.join(root,'evidence/release-0.4.12.json')));
 assert(release.dmgVerified&&release.installedSignatureVerified);
 assert.equal(processes().length,0,'Close the App before checking a fresh normal launch');
 const settings=JSON.parse(fs.readFileSync(path.join(base,'opencodex.json')));
 assert.equal(settings.mode,'ssh');assert.equal(settings.sshAgent,'codex');
 report.asarSHA256=sha(path.join(app,'Contents/Resources/app.asar'));
 assert.equal(report.asarSHA256,release.asarSHA256);
 const info=JSON.parse(cp.execFileSync('plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')],{encoding:'utf8'}));
 assert.equal(info.OpenCodexVersion,report.version);
 cp.execFileSync('codesign',['--verify','--deep','--strict',app]);
 const auditPath=path.join(base,'adapter-events.jsonl'),offset=fs.statSync(auditPath).size;
 cp.execFileSync('open',['-n',app]);
 const deadline=Date.now()+180000;
 let events=[];
 while(Date.now()<deadline){
  events=fs.readFileSync(auditPath).subarray(offset).toString().trim().split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  if(events.some(e=>e.type==='ssh-autoconnect-finished'&&e.connected))break;
  assert(!events.some(e=>e.type==='fatal'||e.type==='ssh-autoconnect-failed'),'Normal startup reported failure');
  await pause(500);
 }
 const relevant=events.filter(e=>/^(shell-ready|ssh-autoconnect-|ssh-connected)/.test(e.type));
 assert.equal(relevant.filter(e=>e.type==='shell-ready').length,1);
 const starts=relevant.filter(e=>e.type==='ssh-autoconnect-start'),finished=relevant.filter(e=>e.type==='ssh-autoconnect-finished');
 assert(starts.length>=1&&starts.length<=3);
 assert.equal(finished.length,1);assert.equal(finished[0].connected,true);assert.equal(finished[0].confirmationRequired,false);
 assert(relevant.some(e=>e.type==='ssh-connected'&&e.executor===true));
 const running=processes();
 assert.equal(running.length,1);assert(running[0].includes(app+'/Contents/MacOS/'));
 assert(!running.some(s=>/--opencodex-test|--remote-debugging/.test(s)));
 for(const host of ['127.0.0.1','::1'])assert.equal(await portOpen(host,9325),false,'Development debug port remains open on '+host);
 assert.equal(sha(path.join(app,'Contents/Resources/app.asar')),report.asarSHA256);
 report.events=relevant.map(e=>({type:e.type,connected:e.connected,confirmationRequired:e.confirmationRequired,executor:e.executor}));report.normalProcess=true;report.debugPortClosed=true;report.executorRegistered=true;
 report.nativeWindowInspected=false;report.nativeApprovalAcceptanceVerified=false;report.passed=true;
 report.completedAt=new Date().toISOString();
 release.normalInstalledStartup=report;release.phase='package verified and normal installed automatic SSH verified';
 for(const target of [path.join(root,'evidence/release-0.4.12.json'),path.join(os.homedir(),'Downloads/OpenCodex-0.4.12-verification.json')])
  fs.writeFileSync(target,JSON.stringify(release,null,2)+'\n');
})().catch(error=>{report.error=error.stack;process.exitCode=1;}).finally(()=>{
 report.completedAt??=new Date().toISOString();
 fs.writeFileSync(path.join(root,'evidence/installed-startup-0.4.12.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
});
