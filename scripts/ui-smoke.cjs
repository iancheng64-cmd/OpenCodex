'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 let target;for(let n=0;n<60;n++){try{const targets=await(await fetch('http://127.0.0.1:9325/json/list',{signal:AbortSignal.timeout(1000)})).json();target=targets.find(t=>t.type==='page'&&t.url==='app://-/index.html');if(target)break;}catch{}await pause(500);}assert(target,'Native frontend did not start');
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 const pending=new Map();let seq=0;
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},8000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const click=async selector=>{console.log(JSON.stringify({click:selector,at:new Date().toISOString()}));const r=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("Missing element");e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r});await pause(350);};
 const capture=async name=>{const r=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(__dirname,'../evidence/'+name+'.png'),Buffer.from(r.data,'base64'));};
 const state=()=>evaluate('window.openCodexRuntime.status()');
 const wait=async(predicate,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await pause(500)}throw Error('UI state timed out');};
 const results={at:new Date().toISOString(),version:'0.4.10'};
 try{
  const s=await state();assert.equal(s.mode,'ssh');assert.equal(s.connected,false);assert.equal(s.connecting,false);assert.equal(s.agentBridgeAppLoaded,false);
  await wait(()=>evaluate('!!document.querySelector("aside #opencodex-ssh")'));
  assert(await evaluate('!document.querySelector("#opencodex-toolbar")'));
  if(await evaluate('document.querySelector("#oc-connections").open'))await click('#oc-close');
  assert(await evaluate('document.querySelector("#opencodex-connection-hint").innerText.includes("尚未連線")'));
  results.opensOffline=true;results.sidebar=true;results.agentBridgeMainLoaded=false;
  await capture('offline-native-v03');
  await click('#opencodex-ssh');
  assert(await evaluate('document.querySelector("#oc-connections").open'));results.connectionDialog=true;
  if(process.argv.includes('--connect')){
   await click('#oc-connect');
   await wait(async()=>!(await state()).connecting,90000);
   const next=await state();results.sshAttempt={connected:next.connected,error:next.error};
   if(next.connected){await wait(async()=>(await state()).quota.status!=='loading');const q=(await state()).quota;assert.equal(q.status,'available');assert.equal(q.stale,false);results.liveQuotaAvailable=true;assert(!(await evaluate('document.body.innerText')).includes('無法載入你的帳戶'));assert(await evaluate('window.openCodexRuntime.canSubmit()'));results.nativeSessionSurvivesConnection=true;}
   if(!next.connected){assert.equal(next.quota.account,null);assert.equal(next.quota.quota,null);assert.equal(await evaluate('window.openCodexRuntime.canSubmit()'),false);results.failureKeepsShell=true}
  }
  await click('#oc-close');
  await wait(()=>evaluate('!!document.querySelector(\'button[aria-label="開啟個人檔案選單"],button[aria-label="Open profile menu"]\')'));await click('button[aria-label="開啟個人檔案選單"],button[aria-label="Open profile menu"]');
  await wait(()=>evaluate('!!document.querySelector("[data-opencodex-quota]")'));
  const quota=await evaluate('(()=>{const e=document.querySelector("[data-opencodex-quota]");return {text:e.innerText,inMenu:!!e.closest("[role=menu]")}})()');
  assert(quota.inMenu);results.nativeQuotaMenu=true;results.quotaText=quota.text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[account]');
  await capture('native-quota-v03');
  const menus=await evaluate('[...document.querySelectorAll("[role=menuitem]")].map(e=>({text:e.innerText,id:e.id}))');
  results.menuItems=menus.map(e=>e.text);
  console.log(JSON.stringify({menus}));
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  results.passed=true;fs.writeFileSync(path.join(__dirname,'../evidence/ui-smoke.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }finally{ws.close();}
})().then(()=>process.exit(0)).catch(e=>{console.error(e.stack);process.exit(1)});
