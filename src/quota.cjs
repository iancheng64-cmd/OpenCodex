'use strict';
// This monitor reads the selected Runtime's public account/quota RPCs only.
// It never reads authentication files or transfers a peer's credentials.
module.exports=function({getSource,normalize,publish,now=Date.now}){
 let generation=0,sourceKey=null,inflight=null;
 let state={status:'disconnected',source:null,account:null,quota:null,checkedAt:null,error:null};
 const snapshot=()=>({...state,stale:state.status!=='available'||!state.quota?.updatedAt||now()-state.quota.updatedAt>90000});
 function reset(source=null,status=source?.rpc?'loading':'disconnected'){
  generation++;inflight=null;sourceKey=source?.key??null;
  state={status,source:source?.label??null,account:null,quota:null,checkedAt:null,error:null};publish();return snapshot();
 }
 async function refresh(){
  const source=getSource();
  if(!source?.rpc){if(state.status!=='disconnected'||sourceKey!==null)reset(null,'disconnected');return snapshot();}
  if(source.key!==sourceKey)reset(source);
  if(inflight)return inflight;
  const epoch=generation;
  inflight=(async()=>{
   const [accountResult,quotaResult]=await Promise.allSettled([
    source.rpc.request('account/read',{refreshToken:false},15000),
    source.rpc.request('account/rateLimits/read',{},15000)
   ]);
   if(epoch!==generation||getSource()?.key!==source.key)return snapshot();
   const checkedAt=now();
   if(accountResult.status==='fulfilled'){
    const a=accountResult.value?.account;
    const account=a?{type:a.type||'unknown',email:typeof a.email==='string'?a.email:null,plan:typeof a.planType==='string'?a.planType:null}:null;
    if(JSON.stringify(state.account)!==JSON.stringify(account))state.quota=null;
    state.account=account;
   }else{
    // Do not associate a previous identity with a possibly switched account.
    state.account=null;state.quota=null;
   }
   state.checkedAt=checkedAt;
   if(quotaResult.status==='fulfilled'&&accountResult.status==='fulfilled'){
    state.quota=normalize(quotaResult.value,checkedAt);
    state.status=state.quota.available?'available':'unavailable';
    state.error=state.quota.available?null:'此帳號／服務沒有提供可顯示的額度。';
   }else{
    state.status='unavailable';state.error='目前無法取得帳號或額度；稍後會自動重試。';
   }
   publish();return snapshot();
  })().finally(()=>{if(epoch===generation)inflight=null;});
  return inflight;
 }
 return {snapshot,refresh,reset,invalidate(){reset(getSource());return refresh();}};
};
