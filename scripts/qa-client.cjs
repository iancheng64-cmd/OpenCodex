'use strict';
const fs=require('fs'),path=require('path'),os=require('os');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function socket(url){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=()=>j(Error('WebSocket connection failed'));});const pending=new Map(),events=[];let seq=0;
 ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);return;}if(m.id!==undefined&&m.method){ws.send(JSON.stringify({id:m.id,error:{code:-32000,message:'QA has not authorized this request'}}));return;}events.push(m);};
 const call=(method,params={},timeout=90000)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('Timeout '+method))},timeout);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 return{ws,call,events,close(){ws.close();for(const p of pending.values())clearTimeout(p.timer);}};
}
async function cdp(){const targets=await(await fetch('http://127.0.0.1:9325/json/list',{signal:AbortSignal.timeout(3000)})).json(),target=targets.find(t=>t.url==='app://-/index.html');if(!target)throw Error('No native frontend');const c=await socket(target.webSocketDebuggerUrl);
 c.evaluate=async expression=>{const r=await c.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 c.worker=async(method,params)=>c.evaluate('('+function(method,params){return new Promise((resolve,reject)=>{const id=crypto.randomUUID();let unsub;const timer=setTimeout(()=>{unsub();reject(Error('Native worker timeout'));},60000);unsub=window.electronBridge.subscribeToWorkerMessages('git',m=>{if(m.type!=='worker-response'||m.response.id!==id)return;clearTimeout(timer);unsub();const r=m.response.result;r.type==='ok'?resolve(r.value):reject(Error(r.error.message));});window.electronBridge.sendWorkerMessageFromView('git',{type:'worker-request',workerId:'git',request:{id,method,params,enqueuedAtMs:Date.now()}}).catch(e=>{clearTimeout(timer);unsub();reject(e);});});}.toString()+')('+JSON.stringify(method)+','+JSON.stringify({operationSource:'git_direct_call',hostConfig:{id:'local',display_name:'Local',kind:'local'},...params})+')');
 return c;
}
async function rpc(){return socket(JSON.parse(fs.readFileSync(path.join(os.homedir(),'Library/Application Support/OpenCodex/test-endpoint.json'))).url);}
async function wait(fn,timeout=150000){const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await pause(250);}throw Error('Event timeout');}
module.exports={cdp,rpc,pause,wait,socket};
