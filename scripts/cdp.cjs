'use strict';
(async()=>{
 const targets=await(await fetch('http://127.0.0.1:9325/json/list')).json();
 const target=targets.find(t=>t.type==='page'&&(!process.env.TARGET_URL||t.url.includes(process.env.TARGET_URL)));
 if(!target)throw Error('No matching page');
 const ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 const pending=new Map();let seq=0;
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}};
 const call=(method,params)=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method,params}));});
 const expression=process.argv[2]||'JSON.stringify({url:location.href,title:document.title,text:document.body.innerText,inputs:[...document.querySelectorAll("input,textarea,[contenteditable=true]")].map(e=>({tag:e.tagName,placeholder:e.getAttribute("placeholder"),role:e.getAttribute("role"),class:e.className}))})';
 const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});console.log(JSON.stringify(r));ws.close();
})().catch(e=>{console.error(e.message);process.exitCode=1;});
