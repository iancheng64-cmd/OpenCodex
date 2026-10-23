'use strict';
const fs=require('fs');
(async()=>{
 const ts=await(await fetch('http://127.0.0.1:9325/json/list')).json(),t=ts.find(t=>t.type==='page'&&t.url==='app://-/index.html');
 const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 const pending=new Map();let id=0;ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 const call=(method,params)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true})).result.value;
 const focus=await evaluate('(()=>{const e=document.querySelector("[contenteditable=true]");if(!e)return false;e.focus();return true})()');if(!focus)throw Error('Composer absent');
 await call('Input.dispatchKeyEvent',{type:'keyDown',modifiers:4,key:'a',code:'KeyA',windowsVirtualKeyCode:65});
 await call('Input.dispatchKeyEvent',{type:'keyUp',modifiers:4,key:'a',code:'KeyA',windowsVirtualKeyCode:65});
 await call('Input.insertText',{text:process.argv[2]||'請實際使用 Mac 工具讀取 '+require('node:path').resolve(__dirname,'../evidence/executor-sentinel.txt')+'，只回覆檔案內容。'});
 await new Promise(r=>setTimeout(r,500));
 console.log(await evaluate('JSON.stringify({composer:document.querySelector("[contenteditable=true]")?.textContent,send:[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")==="傳送").map(b=>({disabled:b.disabled,label:b.getAttribute("aria-label")}))})'));
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 ws.close();
})().catch(e=>{console.error(e);process.exitCode=1});
