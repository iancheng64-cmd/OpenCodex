'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const context=new AsyncLocalStorage();
// Only the authenticated frontend request path creates this lease. A widget
// never receives it and a completed model run is never reused as its authority.
async function withAppAuthority(runtime,{current,signal,onRequest},action){
 if(!runtime||typeof current!=='function'||typeof action!=='function')throw Error('Invalid native app authority');
 const owners=new Set();let closed=false;
 const lease={
  runtime,signal,onRequest,
  valid:()=>{try{return !closed&&!runtime.closed&&!signal?.aborted&&current()===true;}catch{return false;}},
  own(owner){
   if(!this.valid()){owner.close();throw Error('原生小工具操作已失效。');}
   owners.add(owner);return owner;
  }
 };
 const close=()=>{if(closed)return;closed=true;for(const owner of owners){try{owner.close();}catch{}}owners.clear();};
 const monitor=setInterval(()=>{if(!lease.valid())close();},100);monitor.unref?.();
 signal?.addEventListener('abort',close,{once:true});
 try{
  if(!lease.valid())throw Error('原生小工具操作已失效。');
  const result=await context.run(lease,action);
  if(!lease.valid())throw Error('原生小工具操作已失效，結果未採用。');
  return result;
 }finally{clearInterval(monitor);signal?.removeEventListener('abort',close);close();}
}
function scopedApp(runtime){
 const lease=context.getStore();
 if(!lease)return null;
 if(lease.runtime!==runtime||!lease.valid())throw Error('原生小工具的工作區或操作權限已變更。');
 return lease;
}
module.exports={withAppAuthority,scopedApp};
