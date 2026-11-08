'use strict';
// Queue parity through the real window, like the ChatGPT app: Enter during a running turn queues
// the message (nothing is sent), the queued message is sent exactly once when the turn ends and
// leaves the list, and 引導 on a queued message sends it once and removes it.
// Evidence: evidence/queue-ui-e2e.json
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch}=require('./qa-isolated-app.cjs');
const ROW='QUEUE-UI-A';
const report={version:'0.4.15',at:new Date().toISOString(),checks:{},errors:[]};
(async()=>{
 const h=await launch({label:'queueui'});
 let view;
 const dump=()=>{report.records=h.records.map(r=>({hold:r.hold,text:r.text.slice(0,60),afterTool:r.afterTool}));report.events=h.events().filter(e=>!['rpc','latency'].includes(e.type)||/queue|turn\//.test(e.method||'')).slice(-80);};
 try{
  const A=(await h.client.call('thread/start',{cwd:h.project})).thread.id;
  const turnOf=async text=>(await h.client.call('turn/start',{threadId:A,input:h.text(text)})).turn.id;
  const started=()=>h.client.events.filter(e=>e.method==='turn/started'&&e.params?.threadId===A).map(e=>e.params.turn.id);
  const completed=id=>h.client.events.find(e=>e.method==='turn/completed'&&e.params?.turn?.id===id);
  const inProgress=()=>started().filter(id=>!completed(id));
  const first=await turnOf(ROW+' first message');
  await h.until(()=>completed(first),'first turn');
  const pages=await h.pages();
  view=pages.find(p=>p.info.href==='app://-/index.html')||pages[0];
  const row=`[...document.querySelectorAll('a,button,[role=button],[role=link],[role=option],li,div,span')].filter(e=>e.innerText?.trim().startsWith(${JSON.stringify(ROW)})).filter(e=>{const r=e.getBoundingClientRect();return e.offsetParent&&r.width>0&&r.height>0;}).sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return ra.width*ra.height-rb.width*rb.height;})[0]`;
  await h.until(()=>view.run(`(()=>{const r=${row};if(!r)return false;r.click();return true;})()`),'sidebar row',60000);
  await h.until(()=>view.run(`!!document.querySelector('.ProseMirror')`),'composer',30000);
  const ui=async()=>view.run(`(()=>{const q=s=>[...document.querySelectorAll(s)].filter(e=>{const r=e.getBoundingClientRect();return e.offsetParent&&r.width&&r.height;});const by=l=>q('button,[role=button]').filter(b=>(b.getAttribute('aria-label')||'')===l||(b.innerText||'').trim()===l).length;return {steer:by('引導'),remove:by('刪除已排入佇列的訊息'),queueAdd:by('加入佇列'),stop:by('停止'),text:(document.querySelector('main')||document.body).innerText};})()`);
  const type=async text=>{await view.run(`(()=>{document.querySelector('.ProseMirror').focus();return true;})()`);await view.page.call('Input.insertText',{text});await h.pause(500);};
  const enter=async()=>{for(const type of ['keyDown','keyUp'])await view.page.call('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});};
  const click=async label=>view.run(`(()=>{const b=[...document.querySelectorAll('button,[role=button]')].find(b=>(b.getAttribute('aria-label')||'')==='${label}'||(b.innerText||'').trim()==='${label}');if(!b)return false;b.click();return true;})()`);
  const mentions=text=>h.records.filter(r=>r.text.includes(text)&&!r.afterTool).length;
  const queue=async()=>(await h.client.call('thread/queue/list',{threadId:A})).data;
  const queueErrors=()=>h.events().filter(e=>e.type==='rpc-error'&&/thread\/queue|turn\/steer|turn\/start/.test(e.method||''));
  const release=m=>{try{if(h.held.has(m))h.release(m);}catch(e){report.errors.push('release '+m+': '+e.message);}};

  // 1. Enter while a turn runs: queued, not sent.
  const second=await turnOf(ROW+' second [hold:A]');
  await h.until(()=>h.held.has('A'),'A held');
  await h.pause(1500);
  await type('FOLLOW-UP-ONE');
  const typed=await ui();
  report.composerWhileRunning={queueAdd:typed.queueAdd,steer:typed.steer,stop:typed.stop};
  await enter();
  await h.until(async()=>(await queue()).length===1,'queued on the adapter',15000);
  await h.pause(2500);
  const queued=await ui();
  assert.equal(mentions('FOLLOW-UP-ONE'),0,'Enter during a running turn must not send');
  assert.equal(queued.steer,1,'queued entry shows 引導');
  assert.equal(queued.remove,1,'queued entry shows delete');
  report.checks.enterQueuesInsteadOfSending=true;

  // 2. Turn ends: sent exactly once, entry leaves the list, no renderer start error.
  release('A');
  await h.until(()=>completed(second),'second turn completes');
  await h.until(()=>mentions('FOLLOW-UP-ONE')>=1,'queued message dispatched',20000);
  await h.until(()=>started().length>=3&&inProgress().length===0,'third turn completes',60000);
  await h.pause(3000);
  const after=await ui();
  report.afterDispatch={steer:after.steer,remove:after.remove,mentions:mentions('FOLLOW-UP-ONE'),queue:(await queue()).length,errors:queueErrors()};
  assert.equal(mentions('FOLLOW-UP-ONE'),1,'queued message sent exactly once');
  assert.equal((await queue()).length,0,'adapter queue drained');
  assert.equal(after.steer+after.remove,0,'queued entry removed from the window: '+after.text.slice(-300));
  assert.deepEqual(queueErrors(),[],'no queue/steer errors');
  report.checks.queuedMessageSentOnceAndRemoved=true;

  // 3. 引導 on a queued message while running: sent once, removed, no duplicate.
  const fourth=await turnOf(ROW+' fourth [hold:B]');
  await h.until(()=>h.held.has('B'),'B held');
  await h.pause(1500);
  await type('FOLLOW-UP-TWO');
  await enter();
  await h.until(async()=>(await queue()).length===1,'second queued',15000);
  await h.pause(1500);
  assert(await click('引導'),'引導 button present');
  const beforeRelease=await h.until(()=>mentions('FOLLOW-UP-TWO')>=1||null,'steer reaches the model',15000).catch(()=>null);
  report.steerPath=beforeRelease?'restart-or-steer-before-release':'after-release';
  release('B');
  if(!beforeRelease)await h.until(()=>mentions('FOLLOW-UP-TWO')>=1,'steer delivered after release',30000);
  await h.until(async()=>(await queue()).length===0,'queue cleared after 引導',15000);
  await h.until(()=>started().length>=4&&inProgress().length===0,'all turns complete',60000);
  await h.pause(3000);
  const final=await ui();
  report.afterSteer={steer:final.steer,remove:final.remove,mentions:mentions('FOLLOW-UP-TWO'),errors:queueErrors()};
  assert.equal(mentions('FOLLOW-UP-TWO'),1,'引導 sent the message exactly once');
  assert.equal(final.steer+final.remove,0,'no queued entry remains: '+final.text.slice(-300));
  assert.deepEqual(queueErrors(),[],'no queue/steer errors');
  report.checks.steerSendsOnceAndRemovesEntry=true;
  dump();report.passed=true;
 }catch(e){report.passed=false;report.errors.push(e.stack);dump();try{report.windowTail=(await view?.run('document.body.innerText'))?.slice(-800);}catch{}process.exitCode=1;}
 finally{await h.stop();}
 fs.mkdirSync(path.join(__dirname,'../evidence'),{recursive:true});
 fs.writeFileSync(path.join(__dirname,'../evidence/queue-ui-e2e.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:report.passed,checks:report.checks,errors:report.errors.map(e=>e.split('\n')[0]),composer:report.composerWhileRunning,afterDispatch:report.afterDispatch,afterSteer:report.afterSteer,steerPath:report.steerPath}));
})();
