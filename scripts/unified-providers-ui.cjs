'use strict';
// Inspect the actual native renderer; no simulated DOM or provider credentials.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {cdp,pause,wait}=require('./qa-client.cjs'),root=path.resolve(__dirname,'..');
const report={version:'0.4.11',at:new Date().toISOString(),passed:false,checks:{}};
let c;
(async()=>{
 c=await cdp();
 report.asarSHA256=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar'))).digest('hex');
 const epoch=await c.evaluate('performance.timeOrigin');
 await c.evaluate("document.querySelector('#oc-close')?.click()");
 const ids=await c.evaluate("[...document.querySelectorAll('#opencodex-sidebar-quota details[data-provider]')].filter(e=>e.getBoundingClientRect().height>0).map(e=>e.dataset.provider)");
 assert.deepEqual(ids,['codex','claude','antigravity','grok']);report.checks.allProviderQuotasVisible=true;
 assert.equal(await c.evaluate("document.querySelector('#opencodex-default-provider')?.getAttribute('aria-label')"),'新對話預設模型供應商');
 report.checks.compactDefaultSelector=true;
 await c.evaluate('openCodexRuntime.openConnections()');
 await wait(()=>c.evaluate("!!document.querySelector('#oc-composio-check')"),10000);
 await c.evaluate("document.querySelector('#oc-composio-check').click()");
 await wait(()=>c.evaluate('(async()=>{const s=await openCodexRuntime.status();return s.composio.toolCount>0&&!s.composio.error;})()'),60000);
 const status=await c.evaluate('openCodexRuntime.status()');
 assert(status.composio.authenticated&&status.composio.toolCount>0&&!status.composio.error);
 await c.evaluate("document.querySelector('#oc-close')?.click()");
 report.checks.composioConnected=true;report.composioToolCount=status.composio.toolCount;
 const escape=async()=>{for(const type of ['keyDown','keyUp'])await c.call('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await pause(300);};
 await escape();
 // A new unsent draft avoids altering a user's existing conversation or consuming a model turn.
 await c.evaluate("[...document.querySelectorAll('button')].find(e=>e.innerText==='新對話')?.click()");
 await pause(400);
 for(const [label,expected] of [['Grok · Grok 4.7 Fast','Grok'],['6.1 Sol','6.1']]){
  await c.evaluate("document.querySelector('[data-codex-intelligence-trigger]').click()");
  const expression="[...document.querySelectorAll('[role=menuitemradio]')].find(e=>e.innerText==="+JSON.stringify(label)+")";
  await wait(()=>c.evaluate("!!("+expression+")"),10000);
  assert.equal(await c.evaluate("("+expression+").getAttribute('aria-disabled')"),null);
  await c.evaluate("("+expression+").click()");await escape();
  await wait(()=>c.evaluate("document.querySelector('[data-codex-intelligence-trigger]').innerText.includes("+JSON.stringify(expected)+")"),15000);
 }
 report.checks.nativeModelSelection=true;
 assert.equal(await c.evaluate('performance.timeOrigin'),epoch);report.checks.noAppRestart=true;
 // Check layout and accessibility preferences on the renderer actually being released.
 for(const dark of [false,true]){
  await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:dark?'dark':'light'},{name:'prefers-reduced-motion',value:'reduce'}]});
  assert(await c.evaluate("document.querySelector('#opencodex-sidebar-quota').getBoundingClientRect().width>100"));
 }
 await c.call('Emulation.setEmulatedMedia',{features:[]});report.checks.preferenceLayoutsVisible=true;
 report.passed=true;
})().catch(e=>{report.error=e.stack;process.exitCode=1;}).finally(()=>{
 c?.close();report.completedAt=new Date().toISOString();
 fs.writeFileSync(path.join(root,'evidence/unified-providers-ui.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
});
