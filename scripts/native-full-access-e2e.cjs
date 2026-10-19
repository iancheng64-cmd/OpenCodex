'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict');
const {cdp,rpc,wait}=require('./qa-client.cjs');
const reportFile=path.join(__dirname,'../evidence/native-full-access-e2e.json');
(async()=>{
 const phase=process.argv[2]||'initial',c=await cdp(),r=await rpc();
 const watchdog=setTimeout(()=>{console.error('Full access test timed out');process.exit(1)},240000);
 const report=phase==='initial'?{version:'0.4.1',at:new Date().toISOString(),tests:[]}:JSON.parse(fs.readFileSync(reportFile));
 const state=()=>c.evaluate('window.openCodexRuntime.status()');
 async function toggle(enabled){
  await wait(async()=>!(await state()).permissionBusy);
  await c.evaluate('window.openCodexRuntime.openConnections()');
  if((await state()).fullAccess!==enabled)await c.evaluate('document.querySelector("#oc-full-access").click()');
  await wait(async()=>(await state()).fullAccess===enabled);
  assert.equal(await c.evaluate('document.querySelector("#oc-full-access").getAttribute("aria-checked")'),String(enabled));
 }
 try{
  assert((await state()).connected);
  await r.call('initialize',{clientInfo:{name:'opencodex-full-access-qa',version:'0.4.1'}});
  if(phase==='initial'){
   assert.equal((await state()).fullAccess,false);
   await toggle(true);
   report.fixture=fs.realpathSync(fs.mkdtempSync(path.join(__dirname,'../evidence/full-access-qa-')));
   report.outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-full-access-')));
   report.threadId=(await r.call('thread/start',{cwd:report.fixture,permissions:':read-only'})).thread.id;
  }else if(phase==='resume'){
   assert.equal((await state()).fullAccess,true,'highest access persisted after restart');
   assert.equal((await state()).permissionMode,'full','reconnect uses persisted highest access');
   await r.call('thread/resume',{threadId:report.threadId,permissions:':workspace'});
   report.secondProject=fs.realpathSync(fs.mkdtempSync(path.join(__dirname,'../evidence/full-access-project-')));
   report.threadId=(await r.call('thread/start',{cwd:report.secondProject,permissions:':workspace'})).thread.id;
  }else throw Error('Unknown phase');
  assert.equal((await state()).permissionMode,'full','native built-in profile cannot undo explicit highest access');
  const marker='FULL-'+crypto.randomUUID(),input=path.join(report.outside,phase+'-input.txt'),output=path.join(report.outside,phase+'-output.txt');
  fs.writeFileSync(input,marker);
  const auditFile=path.join(os.homedir(),'Library/Application Support/OpenCodex/adapter-events.jsonl'),offset=fs.statSync(auditFile).size;
  const start=r.events.length,grants=(await state()).approvalGrants.length;
  const started=await r.call('turn/start',{threadId:report.threadId,permissions:phase==='initial'?':read-only':':workspace',effort:'low',input:[{type:'text',text:'OpenCodex 最高權限驗收。只做以下步驟：使用描述為「Codex 原生 · node_repl」的 js 工具，以 node:fs/promises 讀取 '+JSON.stringify(input)+'。再使用 Mac 的 mac_fs_write 工具，將剛讀到的原始內容寫到 '+JSON.stringify(output)+'。最後回覆原始內容。必須實際執行兩個工具；不要詢問使用者、不要使用其他工具代替，若被拒絕直接回覆錯誤。'}]});
  await wait(async()=>(await state()).permissionBusy,10000);
  assert.equal(await c.evaluate('document.querySelector("#oc-full-access").disabled'),true,'switch disabled during active turn');
  const done=await wait(()=>r.events.slice(start).find(e=>e.method==='turn/completed'&&e.params.threadId===report.threadId&&e.params.turn.id===started.turn.id),180000);
  assert.equal(done.params.turn.status,'completed');
  const events=r.events.slice(start),answer=events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('');
  assert(answer.includes(marker));assert.equal(fs.readFileSync(output,'utf8'),marker);
  const calls=events.filter(e=>e.method==='item/completed'&&e.params.item?.type==='mcpToolCall').map(e=>e.params.item);
  assert(calls.some(x=>x.tool.startsWith('mac_ext_d9bd7d616ff0_js_')&&x.status==='completed'));
  assert(calls.some(x=>x.tool==='mac_fs_write'&&x.status==='completed'));
  const audit=fs.readFileSync(auditFile).subarray(offset).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(audit.filter(x=>x.type==='tool-approval-shown').length,0);
  assert.equal((await state()).approvalGrants.length,grants);
  await wait(async()=>!(await state()).permissionBusy);
  assert.equal(await c.evaluate('document.querySelector("#oc-full-access").disabled'),false,'switch restored after turn');
  report.tests.push({phase,passed:true,threadId:report.threadId,prompts:0,externalMacFileWriteVerified:true,busySwitchDisabled:true,calls:calls.map(x=>({tool:x.tool,status:x.status}))});
  if(phase==='resume'){
   await toggle(false);assert.equal((await state()).permissionMode,'project');
   report.disabledRestoresProject=true;report.passed=true;
   // Leave normal mode for the separate revoke/deny acceptance, then user-facing final enable.
  }
 }catch(e){report.passed=false;report.error=e.stack;process.exitCode=1;}
 finally{clearTimeout(watchdog);c.close();r.close();fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
})().catch(e=>{console.error(e.stack);process.exit(1)});
