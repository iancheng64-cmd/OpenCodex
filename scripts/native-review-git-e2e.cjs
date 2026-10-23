'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto'),cp=require('child_process');
const {cdp,rpc,wait}=require('./qa-client.cjs');
(async()=>{
 const report={version:'0.4.10',at:new Date().toISOString(),target:'uncommittedChanges',delivery:'detached'};
 const fixture=fs.realpathSync(fs.mkdtempSync(path.join(__dirname,'../evidence/review-git-qa-')));
 const file=path.join(fixture,'total.cjs'),digest=x=>crypto.createHash('sha256').update(x).digest('hex');
 report.fixture=fixture;report.asarSha256=digest(fs.readFileSync(path.join(__dirname,'../build/OpenCodex.app/Contents/Resources/app.asar')));
 const c=await cdp(),r=await rpc();let active;
 const watchdog=setTimeout(()=>{console.error('Native Git review watchdog expired');process.exit(1)},600000);
 try{
  const state=await c.evaluate('window.openCodexRuntime.status()');assert(state.connected&&state.toolsReady);
  assert((await c.worker('git-init-repo',{cwd:fixture})).success);
  const git=(...args)=>cp.execFileSync('/usr/bin/git',['-C',fixture,...args],{encoding:'utf8'});
  git('config','user.name','OpenCodex QA');git('config','user.email','qa@example.invalid');
  fs.writeFileSync(file,"'use strict';\n// Both inputs are positive integers. Return the combined price in cents.\nfunction totalCents(unitPriceCents, quantity) {\n  return unitPriceCents * quantity;\n}\nmodule.exports = {totalCents};\n");
  fs.writeFileSync(path.join(fixture,'README.md'),'This isolated fixture computes an order total in cents by multiplying unit price by quantity. For example totalCents(600, 3) must equal 1800. Review only; do not change files.\n');
  git('add','total.cjs','README.md');git('commit','-m','Add price calculation');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('unitPriceCents * quantity','unitPriceCents / quantity'));
  const before=digest(fs.readFileSync(file)),beforeStatus=git('status','--porcelain=v1');
  assert.equal(beforeStatus.trim(),'M total.cjs');
  report.patch=(await c.worker('review-patch',{cwd:fixture,source:'unstaged',includeUntrackedFiles:true}));
  assert(JSON.stringify(report.patch).includes('+  return unitPriceCents / quantity'));
  await r.call('initialize',{clientInfo:{name:'native-git-review-qa',version:report.version}});
  const source=(await r.call('thread/start',{cwd:fixture,permissions:':read-only'})).thread;
  report.sourceThreadId=source.id;assert.equal(source.cwd,fixture);
  const beforeThread=(await r.call('thread/read',{threadId:source.id,includeTurns:true})).thread;
  const from=r.events.length;
  const result=await r.call('review/start',{threadId:source.id,delivery:'detached',target:{type:'uncommittedChanges'}});
  report.reviewThreadId=result.reviewThreadId;report.turnId=result.turn.id;
  assert.notEqual(result.reviewThreadId,source.id);active={threadId:result.reviewThreadId,turnId:result.turn.id};
  console.log(JSON.stringify({phase:'review-started',threadId:active.threadId,turnId:active.turnId}));
  const done=await wait(()=>r.events.slice(from).find(e=>e.method==='turn/completed'&&e.params.threadId===active.threadId&&e.params.turn.id===active.turnId),360000);
  report.status=done.params.turn.status;
  const events=r.events.slice(from).filter(e=>e.params?.threadId===active.threadId);
  const items=events.filter(e=>e.method==='item/completed').map(e=>e.params.item);
  report.itemTypes=items.map(i=>i.type);
  report.tools=items.filter(i=>i.type==='mcpToolCall').map(i=>({tool:i.tool,status:i.status,arguments:i.arguments,result:i.result,error:i.error}));
  report.review=items.find(i=>i.type==='exitedReviewMode')?.review;
  report.agentText=items.filter(i=>i.type==='agentMessage').map(i=>i.text).join('\n');
  report.errors=events.filter(e=>e.method==='error').map(e=>e.params);
  const history=(await r.call('thread/read',{threadId:active.threadId,includeTurns:true})).thread;
  report.reviewCwd=history.cwd;
  report.historyItemTypes=history.turns.flatMap(t=>t.items.map(i=>i.type));
  const afterThread=(await r.call('thread/read',{threadId:source.id,includeTurns:true})).thread;
  report.sourceUnchanged=JSON.stringify(beforeThread.turns)===JSON.stringify(afterThread.turns);
  report.fixtureUnchanged=before===digest(fs.readFileSync(file))&&beforeStatus===git('status','--porcelain=v1');
  assert.equal(report.status,'completed');active=null;
  assert.equal(report.reviewCwd,fixture);
  assert(report.tools.some(t=>t.tool.startsWith('mac_')&&t.status==='completed'),'Review did not execute a Mac tool');
  assert(report.itemTypes.includes('enteredReviewMode')&&report.itemTypes.includes('exitedReviewMode'),'Native review item pair is missing');
  assert(report.historyItemTypes.includes('exitedReviewMode'),'Review result not retained in history');
  // The pinned engine renders structured findings into a native review string.
  // Verify a concrete finding at the changed file, not just any completed text.
  assert.equal(typeof report.review,'string');
  report.findingAtChangedLine=report.review.includes(file+':4')&&/\[P[0-3]\]/.test(report.review);
  report.identifiesArithmeticBug=/(multipl|乘)/i.test(report.review)&&/(divid|divis|除)/i.test(report.review);
  assert(report.findingAtChangedLine&&report.identifiesArithmeticBug,'Review did not identify the changed arithmetic bug and its location');
  assert(report.sourceUnchanged&&report.fixtureUnchanged);
  report.passed=true;
 }catch(e){report.passed=false;report.error=e.stack;process.exitCode=1;}
 finally{
  if(active)try{await r.call('turn/interrupt',active,10000)}catch{}
  clearTimeout(watchdog);c.close();r.close();
  report.completedAt=new Date().toISOString();
  fs.writeFileSync(path.join(__dirname,'../evidence/native-review-git-e2e-0.4.10.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,error:report.error,status:report.status,tools:report.tools?.map(t=>({tool:t.tool,status:t.status})),review:report.review,sourceUnchanged:report.sourceUnchanged,fixtureUnchanged:report.fixtureUnchanged}));
 }
})().catch(e=>{console.error(e.stack);process.exit(1)}).finally(()=>process.exit(process.exitCode||0));
