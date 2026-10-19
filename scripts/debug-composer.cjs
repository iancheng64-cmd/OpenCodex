'use strict';
(async()=>{
const ts=await(await fetch('http://127.0.0.1:9325/json/list')).json(),t=ts.find(t=>t.type==='page'&&t.url==='app://-/index.html');
const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let seq=0,script;const pending=new Map(),events=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else{if(m.method==='Debugger.scriptParsed'&&m.params.url.includes('app-primary-'))script=m.params;for(const f of [...events])f(m);}};
const call=(method,params={})=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method,params}));});
await call('Debugger.enable');await new Promise(r=>setTimeout(r,200));
const source=(await call('Debugger.getScriptSource',{scriptId:script.scriptId})).result.scriptSource;
const pos=source.indexOf('let Rs={agentMode:Xi'),before=source.slice(0,pos),line=before.split('\n').length-1,col=pos-before.lastIndexOf('\n')-1;
const bp=await call('Debugger.setBreakpoint',{location:{scriptId:script.scriptId,lineNumber:line,columnNumber:col}});
const paused=new Promise(resolve=>events.push(m=>{if(m.method==='Debugger.paused')resolve(m.params)}));
await call('Runtime.evaluate',{expression:'document.querySelector("[contenteditable=true]").focus()'});
call('Runtime.evaluate',{expression:`(()=>{let e=document.querySelector('button[aria-label="傳送"]'),f=e[Object.keys(e).find(k=>k.startsWith('__reactFiber'))];for(;f;f=f.return)if(f.type?.name==='Qft'){for(let h=f.memoizedState;h;h=h.next)if(typeof h.memoizedState==='boolean'&&h.queue?.dispatch){h.queue.dispatch(v=>!v);return 'triggered';}}})()`});
const p=await Promise.race([paused,new Promise(r=>setTimeout(()=>r(null),4000))]);
if(p){const out=await call('Debugger.evaluateOnCallFrame',{callFrameId:p.callFrames[0].callFrameId,expression:'JSON.stringify({b,Oe,Fi,js,ye,be,Ls,Is,mode:jt,hasText:Vo})',returnByValue:true});console.log(JSON.stringify(out));}
else console.log('no pause');
await call('Debugger.removeBreakpoint',{breakpointId:bp.result.breakpointId});await call('Debugger.resume');await call('Debugger.disable');ws.close();
})().catch(e=>{console.error(e);process.exitCode=1});