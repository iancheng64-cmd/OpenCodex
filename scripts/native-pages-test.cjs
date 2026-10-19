'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const targets=await(await fetch('http://127.0.0.1:9325/json/list',{signal:AbortSignal.timeout(3000)})).json();
 const target=targets.find(t=>t.type==='page'&&t.url==='app://-/index.html');assert(target);
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 const pending=new Map();let seq=0;
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},8000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const click=async selector=>{const r=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("Missing element");e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...r});await pause(350);};
 const capture=async name=>{const r=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(__dirname,'../evidence/'+name+'.png'),Buffer.from(r.data,'base64'));};
 const state=()=>evaluate('window.openCodexRuntime.status()');
 const wait=async predicate=>{for(let n=0;n<60;n++){if(await predicate())return;await pause(500)}throw Error('UI state timed out');};
 const results={version:'0.4.3',scope:'Native settings page rendering only; functional capabilities are checked independently',renderedOnly:true,at:new Date().toISOString()};
 try{
  if(await evaluate('document.querySelector("#oc-connections").open'))await click('#oc-close');
  await click('button[aria-label="開啟個人檔案選單"],button[aria-label="Open profile menu"]');
  await evaluate('(()=>{const e=[...document.querySelectorAll("[role=menuitem]")].find(e=>/^(設定|Settings)/.test(e.innerText));if(!e)throw Error("No settings item");e.setAttribute("data-qa-settings","true");return true})()');
  await click('[data-qa-settings]');
  await wait(()=>evaluate('/一般|General/.test(document.body.innerText)'));
  const page=await evaluate('({text:document.body.innerText,buttons:[...document.querySelectorAll("button,[role=tab],a")].map(e=>({text:e.innerText,aria:e.getAttribute("aria-label"),href:e.getAttribute("href")}))})');
  results.nativeSettings=true;results.sections=['一般','外觀','組態','個人化','鍵盤快捷鍵','外掛程式','Computer use','Appshots','瀏覽器','掛勾','連線','Git','環境','Worktrees'].filter(s=>page.buttons.some(b=>b.aria===s));
  results.pages={};
  await capture('native-settings-v03');
  for(const label of ['Computer use','瀏覽器','Git','環境','Worktrees','外掛程式']){
   await click('button[aria-label="'+label+'"]');
   const content=await evaluate('document.body.innerText');
   results.pages[label]={functionalVerified:false,rendered:content.includes(label),authRequired:/登入.*(需要|才能)|請.*登入|需要.*登入/.test(content),error:/發生錯誤|無法載入/.test(content)};
   assert(results.pages[label].rendered);
   if(label==='Computer use')await capture('native-computer-use-v03');
  }
  results.passed=true;
  fs.writeFileSync(path.join(__dirname,'../evidence/native-pages.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }finally{ws.close()}
})().then(()=>process.exit(0)).catch(e=>{console.error(e.stack);process.exit(1)});
