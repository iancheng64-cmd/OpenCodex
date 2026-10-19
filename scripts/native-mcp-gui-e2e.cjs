'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {cdp,rpc,wait}=require('./qa-client.cjs');
const out=path.resolve(__dirname,'../evidence/native-mcp-gui-e2e.json');
(async()=>{
 const report={at:new Date().toISOString(),version:'0.4.8',passed:false,scope:'real native composer, GPT tool call, embedded MCP Apps UI'};
 report.asarSHA256=crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../build/OpenCodex.app/Contents/Resources/app.asar'))).digest('hex');
 const save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2),{mode:0o600});
 let c,r;save();
 try{
  c=await cdp();r=await rpc();await r.call('initialize',{clientInfo:{name:'opencodex-mcp-gui-qa',version:'0.4.8'}});
  const status=await c.evaluate('window.openCodexRuntime.status()');assert.equal(status.connected,true);
  assert(await c.evaluate('!!document.querySelector(".ProseMirror[contenteditable=true]")'));
  assert.equal(await c.evaluate('document.querySelector(".ProseMirror").innerText.trim()'),'');
  const prompt='這是 OpenCodex 原生 MCP App GUI 驗收。請只呼叫本機 opencodex_mcp_gui_qa 外掛的 show_counter 工具一次（名稱包含 show_counter），參數 {}。如果工具是延遲載入，可以先使用工具搜尋找到名稱包含 show_counter 的工具；已確認目前工具目錄有 mac_ext_6df5926e36ac_show_counter_3eae15bf。不要呼叫 increment，不使用其他業務工具，不讀寫檔案，不建立自訂 UI。呼叫完成後只回覆「MCP App 已顯示」。若清單沒有該工具，請直接回覆無此工具。';
  await c.evaluate('document.querySelector(".ProseMirror").focus()');
  await c.call('Input.insertText',{text:prompt});
  await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  const inputEvent=await wait(()=>r.events.find(e=>e.method==='item/completed'&&e.params?.item?.type==='userMessage'&&(e.params.item.content||[]).some(v=>v.text?.trim()===prompt.trim())),180000);
  const done=await wait(()=>r.events.find(e=>e.method==='turn/completed'&&e.params?.threadId===inputEvent.params.threadId&&e.params?.turn?.id===inputEvent.params.turnId),240000);
  report.threadId=done.params.threadId;report.turnId=done.params.turn.id;report.turnStatus=done.params.turn.status;
  report.events=r.events.filter(e=>['item/completed','error'].includes(e.method)&&e.params?.threadId===report.threadId);
  report.dom=await c.evaluate('({text:document.body.innerText,frames:[...document.querySelectorAll("iframe")].map(e=>({src:e.src,title:e.title})),mcpElements:[...document.querySelectorAll("*")].filter(e=>e.tagName.toLowerCase().includes("mcp")).map(e=>({tag:e.tagName,html:e.outerHTML.slice(0,1000)}))})');
  report.frameTree=await c.call('Page.getFrameTree');
  assert.equal(report.turnStatus,'completed');
  assert(report.events.some(e=>e.params?.item?.type==='mcpToolCall'&&e.params.item.tool?.includes('show_counter')&&!e.params.item.error&&!e.params.item.result?.isError),'Main turn did not successfully call the MCP fixture');
  report.phase='model-completed-awaiting-widget-interaction';
 }catch(e){report.error=e.stack;process.exitCode=1;}
 finally{save();r?.close();c?.close();console.log(JSON.stringify({...report,dom:report.dom?{text:report.dom.text.slice(-3500),frames:report.dom.frames,mcpElements:report.dom.mcpElements}:null,events:report.events?.map(e=>({method:e.method,itemType:e.params?.item?.type,tool:e.params?.item?.tool,result:e.params?.item?.result}))}));}
})();
