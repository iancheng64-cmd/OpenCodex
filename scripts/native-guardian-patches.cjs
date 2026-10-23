'use strict';
// Preserve the official account's feature gates. Remote Guardian availability
// comes from the authenticated peer handshake and the local executor state.
function patch(code,pairs){
 for(const [before,after] of pairs){
  if(code.includes(after)&&code.indexOf(after)===code.lastIndexOf(after))continue;
  if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))
   throw Error('Unrecognized native Guardian boundary');
  code=code.replace(before,after);
 }
 return code;
}
function initial(code){
 return patch(code,[
  ['function dWi(e){let t=(0,mWi.c)(24)',
   'function dWi(e){let ocGuardian=(0,hWi.useSyncExternalStore)(globalThis.openCodexRuntime?.subscribe??(()=>()=>{}),()=>globalThis.openCodexRuntime?.isRemote()?globalThis.openCodexRuntime?.guardianAvailable()?"ready":"unavailable":"local");let t=(0,mWi.c)(24)'],
  ['b=On(),x=Xs(Dc,`1597774583`),S=',
   'b=On(),x=Xs(Dc,`1597774583`)&&ocGuardian==="local",S='],
  ['let F=m||h||g||j||E||T==null||P,I=y?.guardian_approval===!0,L;',
   'let F=m||h||g||j||E||T==null||(ocGuardian==="local"&&P),I=ocGuardian==="local"?y?.guardian_approval===!0:ocGuardian==="ready",L;']
 ]);
}
function shared(code){
 return patch(code,[
  ['function nvt(e){return B_t(e,ovt)}',
   'function nvt(e){return globalThis.openCodexRuntime?.isRemote()?globalThis.openCodexRuntime?.guardianAvailable()===true:B_t(e,ovt)}']
 ]);
}
module.exports={initial,shared};
