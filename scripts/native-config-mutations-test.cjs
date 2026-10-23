'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {NativeConfigMutations}=require('../src/native-config-mutations.cjs');
const tests=[];
function fixture(){
 const c={state:{config:{permissions:{audit:{write:false}}},layers:[]},revoked:0,writes:0,reads:0,busy:false};
 c.run=new NativeConfigMutations({cwd:()=>'/workspace',busy:()=>c.busy,invalidate:()=>{c.revoked++},request:async(method,params)=>{
  if(method==='config/read'){c.reads++;assert.equal(params.cwd,'/workspace');assert.equal(params.includeLayers,true);if(c.failRead===c.reads)throw Error('read failed');return structuredClone(c.state);}
  if(c.failWrite)throw Error('write failed');
  c.writes++;await c.wait?.();if(params?.state)c.state=params.state;return {ok:true};
 }});
 return c;
}
async function check(name,fn){await fn();tests.push(name);}
(async()=>{
 await check('repeated native startup writes retain initializing custom permission owners',async()=>{const c=fixture();await Promise.all([c.run.call('config/batchWrite',{}),c.run.call('config/batchWrite',{})]);assert.equal(c.writes,2);assert.equal(c.revoked,0);});
 await check('changed permissions revoke previous owners',async()=>{const c=fixture();await c.run.call('config/value/write',{state:{config:{permissions:{audit:{write:true}}},layers:[]}});assert.equal(c.revoked,1);});
 await check('layer and trust changes revoke even with identical effective config',async()=>{const c=fixture();await c.run.call('config/batchWrite',{state:{...c.state,layers:[{disabledReason:'untrusted'}]}});assert.equal(c.revoked,1);});
 await check('explicit plugin and reload operations revoke without relying on config equivalence',async()=>{for(const method of ['plugin/install','plugin/uninstall','plugin/enable','plugin/disable','skills/config/write','config/mcpServer/reload','mcpServer/reload']){const c=fixture();await c.run.call(method,{});assert.equal(c.revoked,1);}});
 await check('unreadable before or after state fails closed',async()=>{for(const failRead of [1,2]){const c=fixture();c.failRead=failRead;await c.run.call('config/batchWrite',{});assert.equal(c.revoked,1);}});
 await check('failed write does not revoke and a later request can retry',async()=>{const c=fixture();c.failWrite=true;await assert.rejects(c.run.call('config/batchWrite',{}),/write failed/);assert.equal(c.revoked,0);c.failWrite=false;await c.run.call('config/batchWrite',{});assert.equal(c.writes,1);});
 await check('queued writes cannot hide a transient permission change',async()=>{const c=fixture(),original=structuredClone(c.state);let release;c.wait=()=>new Promise(r=>release=r);const a=c.run.call('config/batchWrite',{state:{config:{permissions:{audit:{write:true}}},layers:[]}});while(!release)await new Promise(r=>setImmediate(r));const b=c.run.call('config/batchWrite',{state:original});delete c.wait;release();await Promise.all([a,b]);assert.equal(c.revoked,2);});
 await check('busy state is checked when a queued mutation starts',async()=>{const c=fixture();let release;c.wait=()=>new Promise(r=>release=r);const a=c.run.call('config/batchWrite',{});while(!release)await new Promise(r=>setImmediate(r));const b=c.run.call('config/batchWrite',{});c.busy=true;release();await a;await assert.rejects(b,/請先停止/);assert.equal(c.writes,1);});
 await check('settled waits for writes queued while the previous write completes',async()=>{
  const c=fixture();let first,second,done=false;
  c.wait=()=>new Promise(r=>first=r);const a=c.run.call('config/batchWrite',{});
  while(!first)await new Promise(r=>setImmediate(r));
  const settled=c.run.settled().then(()=>done=true);
  c.wait=()=>new Promise(r=>second=r);const b=c.run.call('config/batchWrite',{});
  first();while(!second)await new Promise(r=>setImmediate(r));
  assert.equal(done,false);second();await Promise.all([a,b,settled]);assert.equal(done,true);
 });
 const report={at:new Date().toISOString(),passed:true,tests};fs.writeFileSync(path.join(__dirname,'../evidence/native-config-mutations-test.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;});
