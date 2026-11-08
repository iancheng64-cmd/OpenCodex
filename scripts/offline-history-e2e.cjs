'use strict';
// Offline history: a conversation read while connected stays listed after the App restarts with
// no SSH connection, opens from the local cache without the error page, its per-thread requests
// answer benignly, and Markdown export works from the cache. Evidence: evidence/offline-history-e2e.json
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {launch}=require('./qa-isolated-app.cjs');
const {writeMarkdown}=require('../src/native-export.cjs');
const ROW='OFFLINE-A';
const report={version:'0.4.15',at:new Date().toISOString(),checks:{},errors:[]};
(async()=>{
 const h=await launch({label:'offline'});
 let view;
 try{
  const A=(await h.client.call('thread/start',{cwd:h.project})).thread.id;
  const completed=id=>h.client.events.find(e=>e.method==='turn/completed'&&e.params?.turn?.id===id);
  for(const text of [ROW+' first message',ROW+' second message']){const id=(await h.client.call('turn/start',{threadId:A,input:h.text(text)})).turn.id;await h.until(()=>completed(id),'turn: '+text);}
  // The live mirror keeps the cache current while this Mac watches the turns.
  const key=crypto.createHash('sha256').update(JSON.stringify([h.profiles[0].id,A])).digest('hex');
  const cacheFile=path.join(h.support,'native-history',key+'.json');
  const cachedTurns=()=>{try{return JSON.parse(fs.readFileSync(cacheFile,'utf8')).result?.thread?.turns?.length||0;}catch{return 0;}};
  await h.until(()=>cachedTurns()>=2,'live mirror cached the turns',30000);
  report.checks.liveMirrorCachesTurns=true;
  // A Mac that never cached this conversation: restart online with the cache wiped; the background sync fetches it.
  await h.restart({mutate:({support})=>fs.rmSync(path.join(support,'native-history'),{recursive:true,force:true})});
  await h.until(()=>h.events().some(e=>e.type==='history-synced'&&e.threadId===A),'background history sync',70000);
  await h.until(()=>cachedTurns()>=2,'cache rebuilt by the sync',15000);
  report.checks.historySyncedWhileOnline=true;

  await h.restart({offline:true});
  report.offlineEvents=h.events().filter(e=>/ssh-autoconnect|shell-ready/.test(e.type)).slice(-4).map(e=>e.type);
  const list=await h.client.call('thread/list',{});
  assert.ok(list.data.some(t=>t.id===A),'offline list still shows the conversation');
  assert.ok(list.data.every(t=>Array.isArray(t.turns)),'cached rows carry a turns array like engine rows');
  assert.deepEqual(await h.client.call('thread/goal/get',{threadId:A}),{goal:null});
  assert.deepEqual(await h.client.call('thread/attachment/list',{threadId:A}),{data:[],nextCursor:null});
  assert.equal((await h.client.call('thread/timeline/list',{threadId:A})).data.length,0);
  const read=await h.client.call('thread/read',{threadId:A,includeTurns:true});
  assert.equal(read.thread.turns.length,2,'cached turns served offline');
  assert.equal((await h.client.call('thread/resume',{threadId:A})).thread.id,A);
  report.checks.offlineRequestsAnswerFromCache=true;

  const pages=await h.pages();view=pages.find(p=>p.info.href==='app://-/index.html')||pages[0];
  const row=`[...document.querySelectorAll('a,button,[role=button],[role=link],[role=option],li,div,span')].filter(e=>e.innerText?.trim().startsWith(${JSON.stringify(ROW)})).filter(e=>{const r=e.getBoundingClientRect();return e.offsetParent&&r.width>0&&r.height>0;}).sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return ra.width*ra.height-rb.width*rb.height;})[0]`;
  await h.until(()=>view.run(`(()=>{const r=${row};if(!r)return false;r.click();return true;})()`),'sidebar row offline',60000);
  const shown=await h.until(async()=>{const t=await view.run('document.body.innerText');return t.includes(ROW+' second message')&&t.includes('DONE')?t:null;},'conversation text offline',30000);
  assert.doesNotMatch(shown,/遇到問題|再試一次以繼續|無法恢復聊天/,'no error page offline');
  report.checks.conversationOpensOffline=true;

  const out=fs.mkdtempSync(path.join(h.home,'export-'));
  const md=fs.readFileSync(writeMarkdown(out,JSON.parse(fs.readFileSync(cacheFile,'utf8')).result.thread,{host:'loopback'}),'utf8');
  assert.ok(md.includes(ROW+' first message')&&md.includes(ROW+' second message')&&md.includes('DONE'),'markdown export from the offline cache');
  report.checks.markdownExportOffline=true;
  report.passed=true;
 }catch(e){report.passed=false;report.errors.push(e.stack);report.events=h.events().filter(e=>!['rpc','latency'].includes(e.type)).slice(-40);try{report.windowTail=(await view?.run('document.body.innerText'))?.slice(-600);}catch{}process.exitCode=1;}
 finally{await h.stop();}
 fs.writeFileSync(path.join(__dirname,'../evidence/offline-history-e2e.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:report.passed,checks:report.checks,errors:report.errors.map(e=>e.split('\n')[0]),offlineEvents:report.offlineEvents}));
})();
