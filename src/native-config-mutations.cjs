'use strict';
const {isDeepStrictEqual}=require('node:util');
const mutation=/^(plugin\/(install|uninstall|enable|disable)|skills\/config\/write|config\/(value\/write|batchWrite|mcpServer\/reload)|mcpServer\/reload)$/;
const configWrite=/^config\/(value\/write|batchWrite)$/;
// Model defaults affect future turns, not the active runtime's tool permissions.
// Keep this exact-key allowlist separate from plugin and permission mutations.
function selectionOnly(method,params){
 const keys=new Set(['model','model_reasoning_effort']);
 if(method==='config/value/write')return keys.has(params?.keyPath);
 return method==='config/batchWrite'&&Array.isArray(params?.edits)&&params.edits.every(edit=>keys.has(edit?.keyPath));
}
// The native renderer synchronizes its built-in MCP configuration on startup.
// Rewriting identical settings must not revoke a concurrently connecting runtime.
// Serialize writes so an intervening change cannot disappear between snapshots.
class NativeConfigMutations{
 constructor({request,invalidate,busy,cwd}){Object.assign(this,{request,invalidate,busy,cwd});this.tail=Promise.resolve();}
 async settled(){
  // A renderer can enqueue another write while the previous one is completing.
  let tail;do{tail=this.tail;await tail;}while(tail!==this.tail);
 }
 call(method,params,timeout){
  if(!mutation.test(method))return this.request(method,params,timeout);
  const run=this.tail.then(async()=>{
   // Also allow the empty batch left after external-provider model interception.
   // Await the real write so persistence errors still reach the native renderer.
   if(selectionOnly(method,params))return this.request(method,params,timeout);
   if(this.busy())throw Error('請先停止工作，再變更工具或外掛設定。');
   const snapshot=async()=>this.request('config/read',{cwd:this.cwd(),includeLayers:true},timeout);
   let before,readable=false;
   if(configWrite.test(method))try{before=await snapshot();readable=true;}catch{}
   const result=await this.request(method,params,timeout);
   let unchanged=false;
   if(readable)try{unchanged=isDeepStrictEqual(before,await snapshot());}catch{}
   // Unknown state and explicit plugin/reload operations always revoke.
   if(!unchanged)await this.invalidate();
   return result;
  });
  this.tail=run.catch(()=>{});
  return run;
 }
}
module.exports={NativeConfigMutations};
