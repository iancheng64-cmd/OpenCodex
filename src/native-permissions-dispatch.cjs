'use strict';
const {scopedRun}=require('./native-run-context.cjs');
const {scopedApp}=require('./native-app-context.cjs');
// Called after existing authentication/approval, at the final execution boundary.
// An enabled custom mode never falls back to an unsandboxed host implementation.
class NativePermissionDispatch {
 constructor(runtime,getNativeOwner){Object.assign(this,{runtime,getNativeOwner});}
 errorMessage(error){
  if(!this.runtime.openCodexPermissions&&!this.runtime.permissionMode?.startsWith('custom:'))return null;
  const messages=new Set([
   '自訂權限工作階段未就緒，工具未執行。','自訂權限的操作歸屬已失效。',
   '此外掛尚未連接自訂權限沙盒，工具未執行。','自訂權限的工作區或連線已變更。',
   '自訂權限設定已變更，請重新開啟對話。','自訂權限工具所屬回合已結束。',
   '此工具無法在目前的權限沙盒執行。','權限工具已取消。'
  ]);
  return messages.has(error?.message)?error.message:'自訂權限沙盒拒絕操作或執行失敗，請檢查權限設定。';
 }
 session(){
  if(this.runtime.openCodexPermissionChanging||this.runtime.openCodexPermissionFailed)throw Error('自訂權限工作階段未就緒，工具未執行。');
  const mode=this.runtime.permissionMode,entry=this.runtime.openCodexPermissions;
  const selected=typeof mode==='string'&&mode.startsWith('custom:');
  if(!entry&&!selected)return null;
  if(!selected||!entry||entry.profile!==mode.slice(7)||!entry.valid())throw Error('自訂權限工作階段未就緒，工具未執行。');
  return entry;
 }
 async checked(entry,signal,action){
  const app=scopedApp(this.runtime),run=scopedRun(this.runtime);
  const current=()=>{
   if(signal?.aborted||this.session()!==entry||
    (app?!app.valid():!entry.runActive(run)))throw Error('自訂權限的操作歸屬已失效。');
  };
  current();await entry.validate();current();
  const result=await action();
  await entry.validate();current();return result;
 }
 native(entry,serverId,client){
  const owner=this.getNativeOwner?.();
  if(!serverId?.startsWith('opencodex-native:')||!owner||owner.closed||
   owner.permissionProfile!==entry.profile||!entry.nativeOwners.has(owner)||!owner.clients.has(client))
   throw Error('此外掛尚未連接自訂權限沙盒，工具未執行。');
 }
 tool({entry:tool,name,args,signal,client,invoke}){
  const permission=this.session();
  if(!permission)return invoke();
  return this.checked(permission,signal,()=>{
   if(/^mac_(fs|process)_/.test(name))return permission.call(name,args,signal);
   const serverId=tool.extensionId||(['mac_mcp_resources','mac_mcp_prompts'].includes(name)?args?.serverId:null);
   this.native(permission,serverId,client);
   return invoke();
  });
 }
 resource({serverId,client,signal,invoke}){
  const permission=this.session();
  if(!permission)return invoke();
  return this.checked(permission,signal,()=>{
   this.native(permission,serverId,client);return invoke();
  });
 }
}
module.exports={NativePermissionDispatch};
