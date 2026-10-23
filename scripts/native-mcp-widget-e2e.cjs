'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {cdp,socket,wait}=require('./qa-client.cjs');
const out=path.resolve(__dirname,'../evidence/native-mcp-gui-e2e.json');
(async()=>{
 const report=JSON.parse(fs.readFileSync(out));assert.equal(report.phase,'model-completed-awaiting-widget-interaction');
 let c,w;report.passed=false;delete report.error;
 try{
  c=await cdp();
  // The native renderer loads the resource after turn/completed, asynchronously.
  const target=await wait(async()=>{
   let targets;for(const host of ['127.0.0.1','[::1]']){try{targets=await(await fetch(`http://${host}:9325/json/list`,{signal:AbortSignal.timeout(3000)})).json();break;}catch{}}
   if(!targets)return null;
   const widgets=targets.filter(t=>t.type==='webview'&&t.url.startsWith('codex-sandbox://mcp-app-'));
   assert(widgets.length<=1,'Expected at most one observed MCP sandbox');
   return widgets[0]||null;
  },90000);
  w=await socket(target.webSocketDebuggerUrl);
  const evaluate=async expression=>{const r=await w.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const inspect='(()=>{const frame=document.querySelector("iframe#root"),d=frame?.contentDocument,b=d?.querySelector("#increment"),r=b?.getBoundingClientRect(),f=frame?.getBoundingClientRect();return {text:d?.body.innerText,state:d?.querySelector("#state")?.textContent,result:d?.querySelector("#result")?.textContent,disabled:b?.disabled,point:r&&f?{x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2}:null}})()';
  report.widgetBefore=await wait(async()=>{const v=await evaluate(inspect);return v.text?.includes('OPENCODEX-MCP-APP-GUI')&&v.disabled===false?v:null;},30000);
  const before=JSON.parse(report.widgetBefore.result);assert.equal(before.structuredContent.count,0);
  await c.evaluate('(()=>{const e=[...document.querySelectorAll("webview")].find(e=>e.src==='+JSON.stringify(target.url)+');if(!e)throw Error("Observed widget disappeared");e.scrollIntoView({block:"center"});return true})()');
  const observed=await evaluate(inspect);assert(observed.point&&observed.point.x>0&&observed.point.y>0);
  report.widgetActionStartedAt=new Date().toISOString();
  await w.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...observed.point});
  await w.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...observed.point});
  report.widgetAfter=await wait(async()=>{const v=await evaluate(inspect);let r;try{r=JSON.parse(v.result)}catch{}if(r?.structuredContent?.count===1)return v;if(v.state?.includes('denied')||v.state?.includes('unavailable')||v.state?.includes('require')||v.state?.includes('timeout'))throw Error(v.state);return null;},65000);
  report.widgetActionCompletedAt=new Date().toISOString();
  const log=fs.readFileSync(path.resolve(__dirname,'../evidence/mcp-app-gui-fixture-0.4.10/operations.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.at>=report.at);
  assert(log.some(x=>x.method==='tools/call'&&x.tool==='increment'),'No real fixture callback');
  assert(log.some(x=>x.method==='result'&&x.tool==='increment'&&x.count===1),'No real increment result');
  report.postTitleComposer=await wait(async()=>{const v=await c.evaluate('(async()=>{const s=await window.openCodexRuntime.status();return {busy:s.permissionBusy,ready:s.toolsReady,connected:s.connected,editable:!!document.querySelector(".ProseMirror[contenteditable=true]")}})()');return !v.busy&&v.ready&&v.connected&&v.editable?v:null;},30000);
  report.widgetOperations=log;report.widgetTarget={type:target.type,url:target.url};
  report.phase='widget-interaction-passed';report.passed=true;report.completedAt=new Date().toISOString();
 }catch(e){report.error=e.stack;process.exitCode=1;}
 finally{fs.writeFileSync(out,JSON.stringify(report,null,2),{mode:0o600});w?.close();c?.close();console.log(JSON.stringify({passed:report.passed,phase:report.phase,before:report.widgetBefore,after:report.widgetAfter,error:report.error}));}
})().finally(()=>process.exit(process.exitCode||0));
