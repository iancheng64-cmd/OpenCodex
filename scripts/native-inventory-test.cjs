'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {inventoryDeadline}=require('./runtime-patches.cjs');
const policy=require('../vendor/agentbridge/dist-main/runtime-policy.js');
const source=fs.readFileSync(path.join(__dirname,'../vendor/agentbridge/dist-main/runtime-backend.js'),'utf8');
const patched=inventoryDeadline(source),tests=[];
const start=patched.indexOf('async function verifyThreadMcp('),end=patched.indexOf('\nfunction routeNotification(',start);
assert(start>=0&&end>start);
const ctx={runtime_policy_1:policy,node_fs_1:{default:{writeFileSync(){}}},node_path_1:{default:path},electron_1:{app:{getPath:()=>'/unused'}}};
vm.runInNewContext(patched.slice(start,end)+'\nthis.verify=verifyThreadMcp;',ctx);
const mac={name:'mac',runtimeStatus:'connected',tools:{mac_fs_read:{}}},disabled={name:'foreign',runtimeStatus:'disabled',tools:{}};
async function test(name,fn){await fn();tests.push(name);}
function runtime(reply){return {mcp:{name:'mac'},snapshot:{},rpc:{request:async(method,params,timeout)=>{
 assert.equal(method,'mcpServerStatus/list');assert.equal(params.detail,'toolsAndAuthOnly');assert.equal(params.serverName,undefined);assert.equal(timeout,60000);
 return reply(params);
}}};}
(async()=>{
 await test('patch handles original and existing bundle exactly once',async()=>{
  assert.equal(inventoryDeadline(patched),patched);
  const previous=patched.replace('threadId, detail: "toolsAndAuthOnly", limit:', 'threadId, limit:');
  assert.equal(inventoryDeadline(previous),patched);
  assert.throws(()=>inventoryDeadline(''),/boundary/);
 });
 await test('all pages include disabled foreign servers and the Mac tools',async()=>{
  const seen=[];await ctx.verify(runtime(p=>{seen.push(p.cursor);return p.cursor?{data:[mac]}:{data:[disabled],nextCursor:'two'};}),'thread');
  assert.deepEqual(seen,[undefined,'two']);
 });
 await test('resource-only foreign server cannot hide behind an empty tools list',async()=>{
  await assert.rejects(ctx.verify(runtime(()=>({data:[mac,{name:'resource-only',runtimeStatus:'connected',tools:{}}]})),'thread'),/非 Mac 工具/);
 });
 await test('starting and unknown foreign servers remain rejected',async()=>{
  for(const status of ['starting',undefined])await assert.rejects(ctx.verify(runtime(()=>({data:[mac,{name:'foreign',runtimeStatus:status,tools:{}}]})),'thread'),/非 Mac 工具/);
 });
 await test('disabled foreign server exposing a tool remains rejected',async()=>{
  await assert.rejects(ctx.verify(runtime(()=>({data:[mac,{...disabled,tools:{unexpected:{}}}]})),'thread'),/非 Mac 工具/);
 });
 await test('missing or failed Mac inventory blocks inference',async()=>{
  for(const data of [[disabled],[{...mac,toolsError:'unavailable'}],[{...mac,tools:{}}]])
   await assert.rejects(ctx.verify(runtime(()=>({data})),'thread'),/尚未載入 Mac 工具/);
 });
 await test('invalid pages and repeated cursors fail closed',async()=>{
  await assert.rejects(ctx.verify(runtime(()=>({data:null})),'thread'),/有效/);
  await assert.rejects(ctx.verify(runtime(()=>({data:[disabled],nextCursor:'same'})),'thread'),/完整驗證/);
 });
 await test('transport failure retains the failing stage',async()=>{
  await assert.rejects(ctx.verify(runtime(()=>{throw Error('unavailable')}),'thread'),/SSH Runtime 工具清單：unavailable/);
 });
 const report={at:new Date().toISOString(),passed:true,tests};
 fs.writeFileSync(path.join(__dirname,'../evidence/native-inventory-test.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1});
