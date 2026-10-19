'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const {cdp,rpc,wait}=require('./qa-client.cjs');
const reportFile=path.join(__dirname,'../evidence/native-approvals-e2e.json');
(async()=>{
 const phase=process.argv[2]||'initial',c=await cdp(),r=await rpc();
 const watchdog=setTimeout(()=>{console.error('Approval test timed out');process.exit(1)},240000);
 let report=phase==='initial'?{version:'0.4.1',at:new Date().toISOString(),tests:[]}:JSON.parse(fs.readFileSync(reportFile));
 try{
  assert((await c.evaluate('window.openCodexRuntime.status()')).connected);
  await r.call('initialize',{clientInfo:{name:'opencodex-approval-qa',version:'0.4.1'}});
  if(phase==='initial'){
   report.fixture=fs.realpathSync(fs.mkdtempSync(path.join(__dirname,'../evidence/approval-qa-')));
   report.threadId=(await r.call('thread/start',{cwd:report.fixture,permissions:':workspace'})).thread.id;
  }else{
   const resumed=await r.call('thread/resume',{threadId:report.threadId,permissions:':workspace'});
   assert.equal(resumed.thread.cwd,report.fixture);
  }
  async function readMarker(label,expectedGrant,expectDenied=false){
   const marker='APPROVAL-'+crypto.randomUUID();
   fs.writeFileSync(path.join(report.fixture,'approval-marker.txt'),marker);
   const auditFile=path.join(require('os').homedir(),'Library/Application Support/OpenCodex/adapter-events.jsonl');
   const auditStart=fs.statSync(auditFile).size;
   const start=r.events.length;
   console.log(JSON.stringify({phase:label,waitingForNativeTool:true,expectedGrant}));
   console.log(JSON.stringify({permissionMode:(await c.evaluate('window.openCodexRuntime.status()')).permissionMode}));
   const result=await r.call('turn/start',{threadId:report.threadId,permissions:':workspace',effort:'low',input:[{type:'text',text:'OpenCodex 權限驗收。請從目前工具目錄找到描述為「Codex 原生 · node_repl」的 js 工具，使用 Node fs 讀取相對路徑 approval-marker.txt 並回覆內容。請實際重新讀取，不可沿用先前結果；不要用其他工具、絕對路徑或更換目錄。若權限被拒絕，直接回覆「權限拒絕」，不要重試或改用其他方法。'}]});
   if(expectDenied){await wait(()=>fs.readFileSync(auditFile).subarray(auditStart).toString().includes('tool-approval-shown'),90000);await r.call('turn/interrupt',{threadId:report.threadId});}
   const done=await wait(()=>r.events.slice(start).find(e=>e.method==='turn/completed'&&e.params.threadId===report.threadId&&e.params.turn.id===result.turn.id),180000);
   assert.equal(done.params.turn.status,expectDenied?'interrupted':'completed');
   const events=r.events.slice(start),answer=events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta).join('');
   const prefix='mac_ext_'+crypto.createHash('sha256').update('opencodex-native:node_repl').digest('hex').slice(0,12)+'_js_';
   const calls=events.filter(e=>e.method==='item/completed'&&e.params.item?.type==='mcpToolCall').map(e=>e.params.item);
   assert(calls.some(x=>x.tool.startsWith(prefix)));
   if(expectDenied){assert(!answer.includes(marker));assert(!calls.some(x=>x.tool.startsWith(prefix)&&x.status==='completed'&&!x.result?.isError));}
   else{assert(answer.includes(marker));assert(calls.some(x=>x.tool.startsWith(prefix)&&x.status==='completed'));}
   const grants=(await c.evaluate('window.openCodexRuntime.status()')).approvalGrants.filter(g=>g.cwd===report.fixture);
   assert.equal(grants.length,expectedGrant?1:0);
   if(expectedGrant){report.grantId=grants[0].id;report.tool=grants[0].tool;}
   const audit=fs.readFileSync(auditFile).subarray(auditStart).toString().trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
   const prompts=audit.filter(e=>e.type==='tool-approval-shown').length;
   assert.equal(prompts,label==='native permanent consent'||expectDenied?1:0,'native approval dialog count');
   report.tests.push({name:label,passed:true,turnId:result.turn.id,remembered:grants.length,cancelled:expectDenied,prompts,calls:calls.map(x=>({tool:x.tool,status:x.status}))});
   console.log(JSON.stringify({phase:label,passed:true,remembered:grants.length}));
  }
  if(phase==='initial'){
   await readMarker('native permanent consent',true);
   await readMarker('second call without another approval',true);
  }else if(phase==='resume'){
   await readMarker('remembered after app restart',true);
  }else if(phase==='revoked'){
   const grants=(await c.evaluate('window.openCodexRuntime.status()')).approvalGrants;
   assert(!grants.some(g=>g.id===report.grantId),'Revoke the QA grant in the connection UI first');
   await readMarker('revoked grant asks again and Stop prevents execution',false,true);
   report.passed=true;delete report.error;
  }else throw Error('Unknown QA phase');
 }catch(e){report.passed=false;report.error=e.stack;process.exitCode=1;}
 finally{clearTimeout(watchdog);c.close();r.close();fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
})().catch(e=>{console.error(e.stack);process.exit(1)});
