'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {cdp,wait}=require('./qa-client.cjs');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'evidence');
const report={version:'0.4.8',at:new Date().toISOString(),passed:false};
let c;
(async()=>{
 const live=JSON.parse(fs.readFileSync(path.join(dir,'native-subagents-live.json')));
 report.asarSHA256=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar'))).digest('hex');
 assert(live.passed&&live.asarSHA256===report.asarSHA256);
 const marker=fs.readFileSync(path.join(live.fixture,'marker.txt'),'utf8');
 c=await cdp();await c.call('Runtime.discardConsoleEntries');await c.call('Runtime.enable');
 await wait(()=>c.evaluate('window.openCodexRuntime.status().then(s=>!s.permissionBusy)'),30000);
 const selector='[data-app-action-sidebar-thread-id="local:'+live.rootId+'"]';
 await c.evaluate('(()=>{const row=document.querySelector('+JSON.stringify(selector)+');if(!row)throw Error("QA root absent from native sidebar");row.click()})()');
 await wait(()=>c.evaluate('document.body.innerText.includes('+JSON.stringify(marker)+')&&document.body.innerText.includes("ROOT-ISOLATED")'),30000);
 const failure=()=>c.evaluate('/無法恢復聊天|Something went wrong|e is not iterable/.test(document.body.innerText)');
 assert.equal(await failure(),false);
 let overview=await c.evaluate('!!document.querySelector(\'button[aria-label="開啟子智慧體概覽"]\')');
 if(!overview)await c.evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.innerText==="子代理");if(!b)throw Error("Native child section missing");b.click()})()');
 await wait(()=>c.evaluate('!!document.querySelector(\'button[aria-label="開啟子智慧體概覽"]\')'),10000);
 await c.evaluate('document.querySelector(\'button[aria-label="開啟子智慧體概覽"]\').click()');
 report.children=[];
 for(const name of ['Qa one','Qa two']){
  await wait(()=>c.evaluate('([...document.querySelectorAll("button")].some(b=>b.getBoundingClientRect().width&&b.innerText.startsWith('+JSON.stringify(name+'\n')+')))'),10000);
  await c.evaluate('([...document.querySelectorAll("button")].find(b=>b.getBoundingClientRect().width&&b.innerText.startsWith('+JSON.stringify(name+'\n')+'))).click()');
  await wait(()=>c.evaluate('document.body.innerText.split('+JSON.stringify(marker)+').length>=3&&!!document.querySelector(\'button[aria-label="返回子智慧體"]\')'),20000);
  assert.equal(await failure(),false);
  report.children.push({name,realChildReplyVisible:true});
  await c.evaluate('document.querySelector(\'button[aria-label="返回子智慧體"]\').click()');
 }
 assert.equal(await c.evaluate('document.body.innerText.includes("已完成 2 項")'),true);
 report.runtimeExceptions=c.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.text);
 assert.deepEqual(report.runtimeExceptions,[]);
 report.rootRestored=true;report.overview=true;report.childDetails=true;report.returnNavigation=true;report.passed=true;
})().catch(e=>{report.error=e.stack;process.exitCode=1}).finally(()=>{c?.close();fs.writeFileSync(path.join(dir,'native-subagents-ui.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))});
