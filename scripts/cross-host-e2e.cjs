'use strict';
// Cross-host continuation: a conversation run on host "alpha" is continued on host "beta". While
// alpha is connected the adapter mirrors its rollout; when the next message is sent while beta is
// connected, the rollout is uploaded into beta's CODEX_HOME/sessions and beta's engine resumes it
// with the full history. A conversation without a mirror continues from a rollout synthesized out
// of the cached history. Two loopback profiles with separate CODEX_HOMEs stand in for two hosts.
// Evidence: evidence/cross-host-e2e.json
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {launch}=require('./qa-isolated-app.cjs');
const report={version:'0.4.16',at:new Date().toISOString(),checks:{},errors:[]};
const key=(profile,id)=>crypto.createHash('sha256').update(JSON.stringify([profile,id])).digest('hex');
function walk(dir){try{return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}catch{return [];}}
(async()=>{
 const h=await launch({label:'crosshost',profiles:[{name:'alpha'},{name:'beta'}]});
 const [alpha,beta]=h.profiles;
 const dump=()=>{report.records=h.records.map(r=>({text:r.text.slice(0,60),inputItems:r.inputItems,afterTool:r.afterTool}));report.events=h.events().filter(e=>!['rpc','latency','tool-policy'].includes(e.type)).slice(-150);};
 const completed=id=>h.client.events.find(e=>e.method==='turn/completed'&&e.params?.turn?.id===id);
 const turn=async(threadId,text)=>{const t=(await h.client.call('turn/start',{threadId,input:h.text(text)},180000)).turn.id;await h.until(()=>completed(t),'turn '+text,180000);return t;};
 const connect=async profile=>{const state=await h.client.call('opencodex/test/connect',{profileId:profile.id},240000);assert.equal(state.profileId,profile.id,'connected profile');assert.equal(state.connected,true,'connected');return state;};
 const listed=async()=>{const ids=[];let cursor=null;do{const page=await h.client.call('thread/list',{limit:50,cursor,sortKey:'updated_at',useStateDbOnly:true});ids.push(...page.data.map(t=>t.id));cursor=page.nextCursor;}while(cursor);return ids;};
 const known=()=>JSON.parse(fs.readFileSync(path.join(h.support,'native-threads.json'),'utf8'));
 const lastRecord=text=>h.records.filter(r=>r.text.includes(text)&&!r.afterTool).at(-1);
 try{
  // 1. Two turns on alpha; the rollout is mirrored to this Mac while alpha is connected.
  const T=(await h.client.call('thread/start',{cwd:h.project})).thread.id;
  await turn(T,'CROSS-HOST alpha first');
  await turn(T,'CROSS-HOST alpha second');
  await h.until(()=>h.events().some(e=>e.type==='rollout-mirrored'&&e.threadId===T),'rollout mirrored',120000);
  const mirror=JSON.parse(fs.readFileSync(path.join(h.support,'native-rollouts',key(alpha.id,T)+'.json'),'utf8'));
  assert.equal(mirror.id,T);assert.ok(mirror.remotePath.startsWith(alpha.remoteHome+'/sessions/'),'mirror path '+mirror.remotePath);
  assert.ok(mirror.bytes>0&&fs.existsSync(path.join(h.support,'native-rollouts',key(alpha.id,T)+'.jsonl.gz')));
  report.mirror={bytes:mirror.bytes,basename:mirror.basename};
  report.checks.mirroredWhileConnected=true;

  // 2. Switch the main host to beta; alpha's conversation stays listed from the cache. A beta
  //    conversation of its own gives the adapter beta's sessions directory (as any used host has).
  await connect(beta);
  assert.ok((await listed()).includes(T),'foreign conversation listed on beta');
  report.checks.foreignListedOnBeta=true;
  const U=(await h.client.call('thread/start',{cwd:h.project})).thread.id;
  await turn(U,'CROSS-HOST beta origin');

  // 3. The next message on beta moves the conversation there and runs with the full history.
  await turn(T,'CROSS-HOST beta third');
  const uploaded=h.events().find(e=>e.type==='handover-uploaded'&&e.threadId===T),done=h.events().find(e=>e.type==='handover-done'&&e.threadId===T);
  assert.ok(uploaded,'handover-uploaded audit');assert.ok(done,'handover-done audit');
  assert.equal(uploaded.source,'mirror');assert.equal(done.from,alpha.id);assert.equal(done.to,beta.id);
  assert.equal(known()[T].profile,beta.id);assert.equal(known()[T].handover,undefined);
  const betaFiles=walk(path.join(beta.remoteHome,'sessions')).filter(f=>f.includes(T));
  assert.ok(betaFiles.length>=1,'rollout present in beta sessions');
  assert.equal(path.basename(betaFiles[0]),mirror.basename);
  report.checks.handoverViaMirror=true;
  const read=await h.client.call('thread/read',{threadId:T,includeTurns:true});
  const texts=JSON.stringify(read.thread.turns);
  assert.ok(read.thread.turns.length>=3,'turns on beta: '+read.thread.turns.length);
  assert.ok(texts.includes('alpha first')&&texts.includes('alpha second')&&texts.includes('beta third'),'all three user messages readable on beta');
  const third=lastRecord('beta third');
  assert.ok(third&&third.inputItems>=5,'model saw the earlier turns: '+third?.inputItems);
  report.checks.historyContinuesOnBeta=true;
  assert.ok((await listed()).includes(T),'beta engine lists the continued conversation');
  report.checks.listedByBetaEngine=true;

  // 4. Without a mirror the cached history is synthesized into a rollout (conversations cached
  //    before this version). A beta conversation continues on alpha.
  await h.client.call('thread/read',{threadId:U,includeTurns:true});
  await h.until(()=>{try{return JSON.parse(fs.readFileSync(path.join(h.support,'native-history',key(beta.id,U)+'.json'),'utf8')).result.openCodexHistoryComplete===true;}catch{return false;}},'history cached',60000);
  for(const ext of ['.json','.jsonl.gz'])fs.rmSync(path.join(h.support,'native-rollouts',key(beta.id,U)+ext),{force:true});
  await connect(alpha);
  await turn(U,'CROSS-HOST alpha continues');
  const up2=h.events().filter(e=>e.type==='handover-uploaded'&&e.threadId===U).at(-1),done2=h.events().find(e=>e.type==='handover-done'&&e.threadId===U);
  assert.ok(up2&&done2,'synthesized handover audits');assert.equal(up2.source,'synthesized');
  const readU=await h.client.call('thread/read',{threadId:U,includeTurns:true});
  const textsU=JSON.stringify(readU.thread.turns);
  assert.ok(readU.thread.turns.length>=2,'turns on alpha: '+readU.thread.turns.length);
  assert.ok(textsU.includes('beta origin')&&textsU.includes('alpha continues'),'both user messages readable on alpha');
  const cont=lastRecord('alpha continues');
  assert.ok(cont&&cont.inputItems>=3,'model saw the earlier turn: '+cont?.inputItems);
  assert.equal(known()[U].profile,alpha.id);
  report.checks.handoverViaSynthesizedRollout=true;
 }catch(error){report.errors.push(error.stack||String(error));}
 finally{
  dump();report.passed=report.errors.length===0&&Object.keys(report.checks).length===6;
  fs.mkdirSync(path.join(__dirname,'../evidence'),{recursive:true});
  fs.writeFileSync(path.join(__dirname,'../evidence/cross-host-e2e.json'),JSON.stringify(report,null,1));
  console.log(JSON.stringify({passed:report.passed,checks:report.checks,errors:report.errors.map(e=>e.split('\n')[0])}));
  await h.stop();process.exit(report.passed?0:1);
 }
})();
