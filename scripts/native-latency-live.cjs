'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {rpc,cdp}=require('./qa-client.cjs');
const root=path.resolve(__dirname,'..'),base=path.join(os.homedir(),'Library/Application Support/OpenCodex');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const report={at:new Date().toISOString(),version:'0.4.10',passed:false,timings:[],checks:[]};
let c,r,threadId;
async function timed(label,fn){const start=performance.now();try{const value=await fn();report.timings.push({label,ms:Math.round(performance.now()-start),passed:true});return value;}catch(e){report.timings.push({label,ms:Math.round(performance.now()-start),passed:false,error:e.message});throw e;}}
(async()=>{
 c=await cdp();
 const state=await c.evaluate('(async()=>{const s=await window.openCodexRuntime.status();return {connected:s.connected,toolsReady:s.toolsReady,busy:s.permissionBusy,cwd:s.cwd,permissionMode:s.permissionMode}})()');
 assert(state.connected&&state.toolsReady&&!state.busy);
 report.asarSHA256=sha(fs.readFileSync(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar')));
 const settings=JSON.parse(fs.readFileSync(path.join(base,'opencodex.json')));
 report.engine=settings.codexConnections[settings.profileId].executable;
 report.effectivePermission=state.permissionMode;
 r=await rpc();
 await timed('initialize',()=>r.call('initialize',{clientInfo:{name:'opencodex-latency-live',version:'0.4.10'},capabilities:{experimentalApi:true}}));
 const created=await timed('thread/start',()=>r.call('thread/start',{cwd:state.cwd,ephemeral:true},120000));
 threadId=created.thread.id;assert(threadId);assert.equal(created.thread.cwd,state.cwd);
 report.checks.push('Ephemeral conversation created in the selected Mac workspace');
 let bridge;
 for(let round=1;round<=3;round++){
  const statuses=await timed('inventory/full/'+round,async()=>{
   let cursor;const data=[];do{const p=await r.call('mcpServerStatus/list',{threadId,limit:100,...(cursor?{cursor}:{})},90000);data.push(...p.data);cursor=p.nextCursor;}while(cursor);return data;
  });
  bridge=statuses.find(s=>s.name.startsWith('opencodex_')&&(s.tools?.length||Object.keys(s.tools||{}).length)>100)||statuses.find(s=>(s.tools?.length||Object.keys(s.tools||{}).length)>100);
  assert(bridge,'Mac tool bridge not present');
  assert.equal(bridge.runtimeStatus,'connected');
  const scoped=await timed('inventory/toolsOnly/'+round,()=>r.call('mcpServerStatus/list',{threadId,serverName:bridge.name,detail:'toolsAndAuthOnly',limit:100},90000));
  assert.equal(scoped.data.length,1);assert.equal(scoped.data[0].name,bridge.name);assert.equal(scoped.data[0].runtimeStatus,'connected');
 }
 report.bridge={name:bridge.name,tools:Array.isArray(bridge.tools)?bridge.tools.length:Object.keys(bridge.tools||{}).length};
 report.checks.push('Three full and scoped inventories preserve the connected tool set');
 await timed('thread/unsubscribe',()=>r.call('thread/unsubscribe',{threadId}));
 threadId=null;
 report.passed=true;
})().catch(e=>{report.error=e.stack;process.exitCode=1;}).finally(async()=>{
 if(threadId&&r)try{await r.call('thread/unsubscribe',{threadId},15000);}catch{}
 r?.close();c?.close();report.completedAt=new Date().toISOString();
 fs.writeFileSync(path.join(root,'evidence/native-latency-live.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));process.exit(process.exitCode||0);
});
