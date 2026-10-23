'use strict';
// Native queue/steer parity: the renderer waits for OpenCodex's slower turn id, and a
// steered Claude message stays inside the running Claude Code process and native turn.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {archive}=require('./asar-reader.cjs'),steer=require('./native-steer-patches.cjs'),{patchClaudeRuntime}=require('./claude-patches.cjs');
const root=path.resolve(__dirname,'..'),tests=[];
async function test(name,fn){await fn();tests.push(name);console.log('PASS '+name);}
(async()=>{
 await test('renderer steer wait patch is exact, idempotent and fails closed',async()=>{
  const a=archive(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar'));
  const bundled=a.read('webview/assets/app-shared-8340f229c2b3.js').toString();a.close();
  const original=bundled.includes(steer.WAIT_AFTER)?bundled.replace(steer.WAIT_AFTER,steer.WAIT_BEFORE):bundled;
  assert.equal(original.split(steer.WAIT_BEFORE).length,2,'the native wait boundary must be unique');
  const patched=steer.shared(original);assert.notEqual(patched,original);assert.equal(patched.split(steer.WAIT_AFTER).length,2);
  assert.equal(steer.shared(patched),patched);
  assert.throws(()=>steer.shared(original.replace(steer.WAIT_BEFORE,'changed boundary')),/Unrecognized native steer boundary/);
 });
 await test('a steered Claude message is written into the running process; late consumption stays in the same run',async()=>{
  const dist=path.join(root,'build/OpenCodex.app/Contents/Resources/agentbridge/app/dist-main'),file=path.join(dist,'claude-local-runtime.js');
  const code=patchClaudeRuntime(fs.readFileSync(path.join(root,'vendor/agentbridge/dist-main/claude-local-runtime.js'),'utf8'));
  const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(dist);m._compile(code,file);
  const events=[],rt=new m.exports.ClaudeLocalRuntime({onEvent:e=>events.push(e)});
  assert.throws(()=>rt.steer([{type:'text',text:'x'}]),/no active turn to steer/);
  const written=[];rt.protocol={user:(content,sessionId)=>written.push({content,sessionId})};rt.sessionId='sess';
  rt.run={requestId:'r1',cancelled:false,messages:new Map(),messageId:'assistant'};
  assert.deepEqual(rt.steer([{type:'text',text:'補充'}]),{requestId:'r1'});assert.equal(written[0].sessionId,'sess');assert.equal(written[0].content[0].text,'補充');
  rt.message({type:'assistant',message:{id:'m1',content:[{type:'text',text:'第一段'}]}});
  rt.message({type:'result',result:'第一段',is_error:false,usage:{}});
  assert.ok(rt.run,'the run stays open while a steered message may still start a turn');assert.equal(events.filter(e=>e.type==='done').length,0);
  rt.message({type:'system',subtype:'init',session_id:'sess'});
  rt.message({type:'assistant',message:{id:'m2',content:[{type:'text',text:'第二段'}]}});
  await new Promise(r=>setTimeout(r,2700));assert.ok(rt.run,'a resumed turn cancels the grace timer');
  rt.message({type:'result',result:'第二段',is_error:false,usage:{}});
  const done=events.filter(e=>e.type==='done');assert.equal(done.length,1);assert.equal(done[0].status,'completed');assert.equal(rt.run,undefined);
  assert.equal(events.filter(e=>e.type==='message').at(-1).text,'第一段\n\n第二段');
  // Without a later turn the grace period ends the run on its own.
  rt.run={requestId:'r2',cancelled:false,messages:new Map(),messageId:'assistant'};rt.steer([{type:'text',text:'晚到'}]);
  rt.message({type:'result',result:'ok',is_error:false,usage:{}});assert.ok(rt.run);
  await new Promise(r=>setTimeout(r,2700));assert.equal(rt.run,undefined);assert.equal(events.filter(e=>e.type==='done').length,2);
  // An error result and a cancelled run never wait.
  rt.run={requestId:'r3',cancelled:false,messages:new Map(),messageId:'assistant'};rt.steer([{type:'text',text:'x'}]);
  rt.message({type:'result',result:'bad',is_error:true,usage:{}});assert.equal(rt.run,undefined);
 });
 fs.writeFileSync(path.join(root,'evidence/native-steer-unit.json'),JSON.stringify({at:new Date().toISOString(),tests,passed:true},null,2)+'\n');
 console.log(JSON.stringify({passed:tests.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
