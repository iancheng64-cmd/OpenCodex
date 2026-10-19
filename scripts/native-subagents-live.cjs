'use strict';
// Real SSH model and native Node plugin; only an owned fixture directory is accessed.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {rpc,wait,cdp}=require('./qa-client.cjs');
const evidence=path.resolve(__dirname,'../evidence'),report={version:'0.4.8',at:new Date().toISOString(),externalModel:true,passed:false};
report.asarSHA256=crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../build/OpenCodex.app/Contents/Resources/app.asar'))).digest('hex');
let r,c,threadId,turnId;
(async()=>{
 const fixture=fs.mkdtempSync(path.join(evidence,'subagent-live-')),marker='NATIVE-CHILD-'+crypto.randomUUID(),key='qa_'+crypto.randomUUID().replaceAll('-','');
 fs.writeFileSync(path.join(fixture,'marker.txt'),marker);report.fixture=fixture;
 c=await cdp();const state=await c.evaluate('window.openCodexRuntime.status()');assert(state.connected);assert.equal(state.sshAgent,'codex');
 r=await rpc();await r.call('initialize',{clientInfo:{name:'opencodex-subagent-qa',version:report.version}});
 const t=await r.call('thread/start',{cwd:fixture,permissions:':workspace'});threadId=t.thread.id;report.rootId=threadId;
 const from=r.events.length;
 const prompt='這是 OpenCodex 自有子代理整合驗收，請依序完整執行。只可以讀取目前專案 marker.txt，不需修改檔案。第一步你自己從工具目錄找描述「Codex 原生 · node_repl」的 js 工具，透過 Node fs 讀取相對路徑 marker.txt，並設定 globalThis['+JSON.stringify(key)+']='+'"root"。接著使用 collaboration.spawn_agent 建立 qa_one 與 qa_two 兩個子代理，fork_turns="none"，要求每個子代理找到同一個「Codex 原生 · node_repl」js 工具，先檢查 globalThis['+JSON.stringify(key)+'] === undefined，否則回報隔離失敗；再設定它為自己的名字，透過 Node fs 實際讀取相對路徑 marker.txt，回報檔案內容與隔離成功。不要讓子代理再衍生代理。等待兩個子代理完成後，你再用你原本的原生 Node 工具確認 globalThis['+JSON.stringify(key)+'] 仍為 "root"，最後回覆兩個子代理名稱、檔案內容及 ROOT-ISOLATED。不要使用其他 node_repl、shell、cat 或一般讀檔工具代替。';
 const started=await r.call('turn/start',{threadId,effort:'low',input:[{type:'text',text:prompt}]});turnId=started.turn.id;
 await wait(()=>r.events.slice(from).find(e=>e.method==='turn/completed'&&e.params.threadId===threadId&&e.params.turn.id===turnId),300000);
 const root=(await r.call('thread/read',{threadId,includeTurns:true})).thread;
 assert.equal(root.turns.at(-1).status,'completed');
 const prefix='mac_ext_'+crypto.createHash('sha256').update('opencodex-native:node_repl').digest('hex').slice(0,12)+'_js_';
 const messages=thread=>thread.turns.flatMap(t=>t.items||[]).filter(i=>i.type==='agentMessage').map(i=>i.text).join('\n');
 const tools=thread=>thread.turns.flatMap(t=>t.items||[]).filter(i=>i.type==='mcpToolCall'&&i.tool.startsWith(prefix));
 report.rootText=messages(root);assert(report.rootText.includes(marker));assert(report.rootText.includes('ROOT-ISOLATED'));assert(tools(root).length>=2);
 // Native thread/list defaults to interactive sessions. Child navigation is
 // represented by subAgentActivity in the parent, not a flat sidebar row.
 const ids=new Set(root.turns.flatMap(t=>t.items||[]).filter(i=>i.type==='subAgentActivity'&&i.kind==='started').map(i=>i.agentThreadId));
 assert.equal(ids.size,2,'Expected exactly two native child conversations');report.children=[];
 for(const id of ids){
  const child=(await r.call('thread/read',{threadId:id,includeTurns:true})).thread;
  assert.equal(child.cwd,fixture);assert.equal(child.parentThreadId,threadId);assert.equal(child.turns.at(-1).status,'completed');
  assert(tools(child).some(i=>i.status==='completed'),'Missing completed native Node child call');assert(messages(child).includes(marker));
  assert(child.turns.every(t=>t.itemsView==='full'),'Child native history is incomplete');
  assert(tools(child).some(i=>JSON.stringify(i.result).includes(marker)),'Child marker lacks a real tool result');
  report.children.push({id,parentThreadId:child.parentThreadId,cwd:child.cwd,nativeTools:tools(child).map(i=>({tool:i.tool,status:i.status})),text:messages(child)});
 }
 report.rootNativeTools=tools(root).map(i=>({tool:i.tool,status:i.status}));
 report.nativeHistory=true;report.nativePluginIsolation=true;report.passed=true;
})().catch(e=>{report.error=e.stack;process.exitCode=1;}).finally(async()=>{
 if(!report.passed&&threadId&&turnId)try{await r.call('turn/interrupt',{threadId,turnId},10000);}catch{}
 r?.close();c?.close();fs.writeFileSync(path.join(evidence,'native-subagents-live.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
});
