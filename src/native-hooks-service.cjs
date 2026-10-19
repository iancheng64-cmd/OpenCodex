'use strict';
const {NativeHooksRuntime}=require('./native-hooks-runtime.cjs');
const {NativeHooksMcp}=require('./native-hooks-mcp.cjs');
const {nativeInventory,compareInventory}=require('./native-hooks-inventory.cjs');
class NativeHooksService{
 constructor({binary,nativeBinary,codexHome,env,AppServerRpc,owner,onRequest,onError=()=>{},Runtime=NativeHooksRuntime,Mcp=NativeHooksMcp}){
  Object.assign(this,{binary,nativeBinary,codexHome,env,AppServerRpc,owner,onRequest,onError,Runtime,Mcp});
  this.entries=new Map();
 }
 get(runtime){
  if(runtime.closed)throw Error('SSH 連線已中斷。');
  let entry=this.entries.get(runtime);if(entry)return entry;
  entry=new this.Runtime({runtime,binary:this.binary,codexHome:this.codexHome,env:this.env,
   inventoryCheck:async(inventory,cwd)=>{
    const owner=this.owner(runtime);
    if(!owner||owner.cwd!==cwd)throw Error('Mac Hooks 工具歸屬已變更。');
    await owner.ready();
    const [list,config]=await Promise.all([
     owner.rpc.request('hooks/list',{cwds:[cwd]},15000),
     owner.rpc.request('config/read',{cwd,includeLayers:false},15000)
    ]);
    if(owner!==this.owner(runtime)||runtime.localCwd!==cwd)throw Error('Mac Hooks 工具歸屬已變更。');
    compareInventory(inventory,nativeInventory(list,config,cwd));
   },
   mcpFactory:record=>new this.Mcp({record,runtime,binary:this.nativeBinary,env:this.env,AppServerRpc:this.AppServerRpc,onRequest:this.onRequest}),
   onNotification:message=>runtime.openCodexHooksNotification?.(message),
   onError:error=>this.onError(error,runtime)});
  this.entries.set(runtime,entry);runtime.openCodexHooks=entry;
  runtime.rpc.once('closed',()=>{void this.closeRuntime(runtime);});
  return entry;
 }
 prepare(runtime){return this.get(runtime).prepare();}
 validate(runtime,threadId){
  const entry=this.entries.get(runtime);
  if(!entry)throw Error('Hooks 執行環境已變更，請重新開啟此對話。');
  return entry.validate(threadId);
 }
 cancel(runtime,run){this.entries.get(runtime)?.cancelRun(run);}
 async closeRuntime(runtime){
  const entry=this.entries.get(runtime);if(!entry)return;
  this.entries.delete(runtime);
  if(runtime.openCodexHooks===entry)delete runtime.openCodexHooks;
  await entry.close();
 }
 async close(){await Promise.allSettled([...this.entries.keys()].map(runtime=>this.closeRuntime(runtime)));}
}
module.exports={NativeHooksService};
