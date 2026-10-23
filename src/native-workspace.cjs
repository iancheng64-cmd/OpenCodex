'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const methods=new Set(['thread/start','thread/resume','thread/fork','thread/shellCommand','turn/start','review/start']);
function needsLease(method,params){return methods.has(method)||(method==='thread/settings/update'&&['cwd','permissions','sandboxPolicy','approvalPolicy','approvalsReviewer'].some(key=>params?.[key]!=null))||(method==='mcpServer/tool/call'&&require('./native-mcp.cjs').isProjectedUri(params?._meta?.['opencodex/resourceUri']));}
async function resolveCwd(params,entry,fallback){
 const value=params?.cwd??entry?.localCwd??(typeof entry?.summary?.cwd==='string'&&entry.summary.cwd.startsWith('/')?entry.summary.cwd:fallback);
 if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0'))throw Error('請選擇有效的 Mac 專案資料夾。');
 const cwd=await fs.realpath(value);
 if(!(await fs.stat(cwd)).isDirectory())throw Error('Mac 專案目錄必須是資料夾。');
 return cwd;
}
function acquire(runtime){
 if(runtime.closed||runtime.run||runtime.openCodexPreparing)throw Error('工作仍在啟動或執行，請稍候或先停止工作。');
 const token={cancelled:false};runtime.openCodexPreparing=token;
 return {check(){if(runtime.closed||runtime.openCodexPreparing!==token||token.cancelled)throw Error('工作初始化已取消。');},
 release(){if(runtime.openCodexPreparing===token)runtime.openCodexPreparing=null;}};
}
// The native frontend creates a short-lived title thread beside a user thread.
// Queue title collisions and history restores during preparation. The native
// parent and child panels restore concurrently. Model turns retain the explicit
// busy error and are never silently resent.
const pendingByRuntime=new WeakMap();
function acquireAsync(runtime,{threadId,ephemeral=false,restore=false,isCurrent=()=>true,timeoutMs=300000}={}){
 const pending=pendingByRuntime.get(runtime)||[];pendingByRuntime.set(runtime,pending);
 const active=runtime.openCodexPreparing||runtime.run;
 if(active&&!ephemeral&&!active.ephemeral&&!(restore&&!runtime.run))return Promise.reject(Error('工作仍在啟動或執行，請稍候或先停止工作。'));
 if(pending.length>=8)return Promise.reject(Error('背景工作等待佇列已滿。'));
 return new Promise((resolve,reject)=>{
  const entry={threadId,ephemeral,cancelled:false},deadline=Date.now()+timeoutMs;pending.push(entry);
  let timer;
  const finish=(error,lease)=>{clearTimeout(timer);const i=pending.indexOf(entry);if(i>=0)pending.splice(i,1);error?reject(error):resolve(lease);};
  const check=()=>{
   if(runtime.closed||entry.cancelled||!isCurrent())return finish(Error('工作初始化已取消。'));
   if(Date.now()>=deadline)return finish(Error('等待背景工作逾時；訊息未自動重送。'));
   const first=pending.find(e=>!e.ephemeral)||pending[0];
   if(first===entry&&!runtime.run&&!runtime.openCodexPreparing){
    try{const lease=acquire(runtime);Object.assign(runtime.openCodexPreparing,{threadId,ephemeral});return finish(null,lease);}catch(error){return finish(error);}
   }
   timer=setTimeout(check,20);
  };check();
 });
}
function cancelPending(runtime,threadId){
 let cancelled=false;for(const entry of pendingByRuntime.get(runtime)||[])if(threadId&&entry.threadId===threadId){entry.cancelled=true;cancelled=true;}return cancelled;
}
// The native title service unsubscribes when its request expires. Cancel only
// that ephemeral work before the remote thread loses its completion listener.
async function cancelEphemeral(runtime,threadId,cancelRun){
 let cancelled=false;
 for(const entry of pendingByRuntime.get(runtime)||[])if(entry.threadId===threadId&&entry.ephemeral){entry.cancelled=true;cancelled=true;}
 const preparing=runtime.openCodexPreparing;
 if(preparing?.threadId===threadId&&preparing.ephemeral){preparing.cancelled=true;cancelled=true;}
 const run=runtime.run;
 if(run?.threadId===threadId&&run.ephemeral){await cancelRun(run.requestId);cancelled=true;}
 return cancelled;
}
function localThread(thread,known,fallback){
 const cwd=fallback||known[thread?.id]?.localCwd;
 return thread&&cwd?{...thread,cwd}:thread;
}
function localResult(result,known,fallback){
 if(!result?.thread)return result;
 const thread=localThread(result.thread,known,fallback);
 // start/resume/fork return cwd twice. Native automations use the top-level one.
 return {...result,thread,...(Object.hasOwn(result,'cwd')&&thread.cwd?{cwd:thread.cwd}:{})};
}
async function resume(runtime,params,{entry,check,readThread,request}){
 const guard=()=>{check();if(runtime.closed||runtime.run)throw Error('對話仍在執行或已斷線，無法重新載入設定。');};
 guard();
 if(entry?.summary?.ephemeral===true)throw Error('暫存對話無法重新載入；請建立新的對話。');
 // A newly created paginated thread has no rollout until the first turn or a
 // full history read. Persist it through the native history API before resume.
 if(entry?.emptyHistory===true){
  const history=await readThread(runtime.rpc,{threadId:params.threadId,includeTurns:true},true);
  guard();
  if(history?.thread?.id!==params.threadId)throw Error('重新載入的對話身分不一致。');
 }
 // The engine ignores configuration overrides while this connection remains
 // subscribed. Invalidated admissions must release that subscription first.
 if(!runtime.openCodexThreads?.has(params.threadId)){
  await runtime.rpc.request('thread/unsubscribe',{threadId:params.threadId});
  guard();
 }
 const result=await request('thread/resume',params);
 guard();
 return result;
}
module.exports={methods,needsLease,resolveCwd,acquire,acquireAsync,cancelPending,cancelEphemeral,localThread,localResult,resume};
