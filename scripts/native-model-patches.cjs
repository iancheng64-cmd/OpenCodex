'use strict';
// SSH peers supply their own model catalog. Cloud feature flags belong to the
// local OpenAI login and must not hide the independently authenticated peer.
const patches=[
 ['if(!Ize(e.method))return;let t=e.trace==null?null:kYe(', 'if(e.method===`opencodex/models/updated`){f.invalidateQueries({queryKey:[...Tve,e.hostId]});return}if(!Ize(e.method))return;let t=e.trace==null?null:kYe('],
 // A new-conversation default chosen outside the composer (sidebar) must refresh its config view.
 // Inserted before the models branch so both patches stay contiguous and idempotent.
 ['if(e.method===`opencodex/models/updated`)', 'if(e.method===`opencodex/config/updated`){f.invalidateQueries({queryKey:[`user-saved-config`,e.hostId]});for(const k of [`layered-response`,`effective`,`user`])f.invalidateQueries({queryKey:[`config`,k,e.hostId]});return}if(e.method===`opencodex/models/updated`)'],
 ['isCustomModelProvider:a,model:o,useHiddenModels:s}){let c=o.availableAccessPrograms?.cyber;', 'isCustomModelProvider:a,model:o,useHiddenModels:s}){if(globalThis.openCodexRuntime?.isRemote())return !o.hidden&&o.model!==`codex-auto-review`;let c=o.availableAccessPrograms?.cyber;']
];
// Earlier development builds carried narrower forms of the same patch.
const legacy=[
 'if(e.method===`opencodex/config/updated`){for(const k of [`layered-response`,`effective`,`user`])f.invalidateQueries({queryKey:[`config`,k,e.hostId]});return}'
];
function refreshNativeModels(code){
 for(const old of legacy)if(code.includes(old))code=code.replace(old,'');
 for(const [before,after] of patches){
  if(code.includes(after)&&code.indexOf(after)===code.lastIndexOf(after))continue;
  if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))throw Error('Unrecognized native model boundary');
  code=code.replace(before,after);
 }
 return code;
}
function refreshPrimaryModelLabel(code){
 const before='l=Q(ql,`3849065407`),u;if(r!=null){';
 const after='l=Q(ql,`3849065407`),u;if(globalThis.openCodexRuntime?.isRemote()&&r==null&&typeof n===`string`&&/^opencodex-(claude|antigravity|grok):/.test(n))r=n.replace(/^opencodex-(claude|antigravity|grok):/,``);if(r!=null){';
 if(code.includes(after)&&code.indexOf(after)===code.lastIndexOf(after))return code;
 if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))throw Error('Unrecognized native composer label boundary');
 return code.replace(before,after);
}
module.exports={refreshNativeModels,refreshPrimaryModelLabel};
