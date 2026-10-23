'use strict';
const CAPABILITY='OpenCodexPermissions/1';
const builtins=new Set(['ask','project','full']);
function profileFor(mode){
 if(builtins.has(mode))return null;
 if(typeof mode!=='string'||!mode.startsWith('custom:'))throw Error('無效的操作權限。');
 const profile=mode.slice(7);
 if(!profile||profile.length>200||profile.startsWith(':')||profile.includes('\0'))throw Error('無效的自訂權限設定檔。');
 return profile;
}
// One transaction owns both the Mac sandbox and the remote thread admission.
// Failed or superseded selections cannot fall back to an unrestricted tool host.
class NativePermissionRuntime{
 constructor({service,owners,closeHooks=async()=>{}}){Object.assign(this,{service,owners,closeHooks});this.pending=new Map();this.closed=false;}
 capable(runtime){
  if(!String(runtime.openCodexInitialized?.userAgent||'').split(/\s+/).includes(CAPABILITY))throw Error('此 SSH 引擎尚未支援 OpenCodex 自訂權限，請先更新引擎。');
 }
 entry(runtime){
  const profile=profileFor(runtime.permissionMode);
  if(runtime.openCodexPermissionChanging||runtime.openCodexPermissionFailed)throw Error('操作權限尚未就緒，請重新選擇權限或連線。');
  const entry=runtime.openCodexPermissions;
  if(!profile){if(entry)throw Error('權限工作階段與所選模式不一致。');return null;}
  this.capable(runtime);
  if(!entry?.valid()||entry.profile!==profile)throw Error('自訂權限工作階段未就緒。');
  return entry;
 }
 invalidate(runtime){
  runtime.openCodexThreads?.clear();runtime.openCodexDormantThreads?.clear();
  runtime.openCodexAgentReceipts?.clear();runtime.openCodexPermissionReceipts?.clear();runtime.openCodexGuardianReceipts?.clear();
  runtime.openCodexSubagents?.close();
 }
 async select(runtime,mode){
  const profile=profileFor(mode);
  if(this.closed||runtime.closed||runtime.run||runtime.openCodexPreparing?.cancelled)throw Error('請先停止工作，再變更操作權限。');
  if(this.pending.has(runtime))throw Error('操作權限正在更新，請稍候。');
  if(profile)this.capable(runtime);
  const operation={host:runtime.toolHost,rpc:runtime.rpc,cwd:runtime.localCwd,cancelled:false};
  const current=()=>!this.closed&&!operation.cancelled&&!runtime.closed&&!runtime.run&&
   !runtime.openCodexPreparing?.cancelled&&this.pending.get(runtime)===operation&&
   runtime.toolHost===operation.host&&runtime.rpc===operation.rpc&&runtime.localCwd===operation.cwd;
  this.pending.set(runtime,operation);runtime.openCodexPermissionChanging=true;
  let ticket;
  try{
   if(mode===runtime.permissionMode&&!runtime.openCodexPermissionFailed){
    const entry=runtime.openCodexPermissions;
    if(!profile&&!entry)return;
    if(profile&&entry?.valid()&&entry.profile===profile){
     await entry.validate();await this.owners.refresh(runtime);
     if(!current())throw Error('權限切換已取消。');
     return;
    }
   }
   if(profile)ticket=await this.service.prepare(runtime,profile);
   if(!current())throw Error('權限切換已取消。');
   this.invalidate(runtime);await this.closeHooks(runtime);
   if(!current())throw Error('權限切換已取消。');
   if(ticket)await ticket.commit();else this.service.closeRuntime(runtime);
   runtime.permissionMode=mode;
   await this.owners.refresh(runtime);
   if(!current())throw Error('權限切換已取消。');
   if(ticket)await ticket.entry.validate();
   if(!current())throw Error('權限切換已取消。');
   runtime.toolHost?.setFullFilesystemAccess?.(mode==='full');
   runtime.openCodexPermissionFailed=false;
  }catch(error){
   ticket?.abort();this.service.closeRuntime(runtime);this.owners.closeRuntime?.(runtime);
   this.invalidate(runtime);runtime.openCodexPermissionFailed=true;throw operation.cancellationError||error;
  }finally{
   if(this.pending.get(runtime)===operation){this.pending.delete(runtime);runtime.openCodexPermissionChanging=false;}
  }
 }
 snapshot(runtime){
  const entry=this.entry(runtime);if(!entry)return null;
  const owner=this.owners.owner(runtime),snapshot=owner?.permissionSnapshot;
  if(owner?.closed||owner?.permissionProfile!==entry.profile||snapshot?.cwd!==runtime.localCwd||snapshot.activePermissionProfile?.id!==entry.profile||!snapshot.sandbox)
   throw Error('Mac 原生權限資料尚未就緒。');
  return structuredClone(snapshot);
 }
 async prepare(runtime){
  const entry=this.entry(runtime);
  if(!entry)return null;
  await entry.validate();
  const host=runtime.toolHost,rpc=runtime.rpc,endpoint=host.server;
  let settled=false;
  const current=()=>this.entry(runtime)===entry&&runtime.toolHost===host&&runtime.rpc===rpc&&host.server===endpoint;
  if(!current())throw Error('自訂權限工作階段已變更。');
  const parameters={permissions:entry.profile,approvalPolicy:'untrusted',approvalsReviewer:'user'};
  return {
   // Inventory/config reloads rebuild the thread config without the request's
   // `permissions` field, so the selected profile must also be its local default.
   config:{permissions:structuredClone(entry.snapshot.definitions),default_permissions:entry.profile,opencodex_permission_context:structuredClone(entry.snapshot.permissionContext)},
   parameters,
   commit:async result=>{
    if(settled)throw Error('自訂權限對話設定已結束。');settled=true;
    const id=result?.thread?.id;
    if(!current()||typeof id!=='string'||!id||result.activePermissionProfile?.id!==entry.profile)
     throw Error('SSH 對話未套用所選的自訂權限設定檔。');
    await entry.validate();if(!current())throw Error('自訂權限工作階段已變更。');
    const receipt=Object.freeze({entry,profile:entry.profile,host,endpoint,rpc,cwd:entry.cwd,threadId:id});
    runtime.openCodexPermissionReceipts??=new Map();runtime.openCodexPermissionReceipts.set(id,receipt);
    return receipt;
   },
   abort:()=>{settled=true;}
  };
 }
 currentReceipt(runtime,threadId){
  const entry=this.entry(runtime);
  if(!entry)return null;
  const receipt=runtime.openCodexPermissionReceipts?.get(threadId);
  if(!receipt||receipt.entry!==entry||receipt.host!==runtime.toolHost||receipt.endpoint!==runtime.toolHost.server||
   receipt.rpc!==runtime.rpc||receipt.cwd!==runtime.localCwd||receipt.profile!==entry.profile)
   throw Error('請先重新開啟此對話，套用目前的自訂權限。');
  return receipt;
 }
 async validate(runtime,threadId){
  const receipt=this.currentReceipt(runtime,threadId);
  if(!receipt)return null;
  await receipt.entry.validate();
  if(this.currentReceipt(runtime,threadId)!==receipt)throw Error('對話權限已變更。');
  return {permissions:receipt.profile,approvalPolicy:'untrusted'};
 }
 async closeRuntime(runtime,cancellationError){
  const pending=this.pending.get(runtime);if(pending){pending.cancelled=true;if(cancellationError)pending.cancellationError=cancellationError;}
  // Keep an outstanding transaction reserved until its finally block completes.
  // Otherwise its late rollback could close a newly selected permission owner.
  if(!pending)runtime.openCodexPermissionChanging=false;
  runtime.openCodexPermissionFailed=true;
  this.invalidate(runtime);this.service.closeRuntime(runtime);this.owners.closeRuntime?.(runtime);
  await this.closeHooks(runtime);
 }
 async close(){
  if(this.closed)return;this.closed=true;
  for(const runtime of new Set([...this.pending.keys(),...this.service.entries.keys()]))await this.closeRuntime(runtime);
  this.service.close();
 }
}
module.exports={NativePermissionRuntime,profileFor,CAPABILITY};
