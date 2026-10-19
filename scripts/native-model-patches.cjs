'use strict';
// SSH peers supply their own model catalog. Cloud feature flags belong to the
// local OpenAI login and must not hide the independently authenticated peer.
const patches=[
 ['if(!Ize(e.method))return;let t=e.trace==null?null:kYe(', 'if(e.method===`opencodex/models/updated`){f.invalidateQueries({queryKey:[...Tve,e.hostId]});return}if(!Ize(e.method))return;let t=e.trace==null?null:kYe('],
 ['isCustomModelProvider:a,model:o,useHiddenModels:s}){let c=o.availableAccessPrograms?.cyber;', 'isCustomModelProvider:a,model:o,useHiddenModels:s}){if(globalThis.openCodexRuntime?.isRemote())return !o.hidden&&o.model!==`codex-auto-review`;let c=o.availableAccessPrograms?.cyber;']
];
function refreshNativeModels(code){
 for(const [before,after] of patches){
  if(code.includes(after)&&code.indexOf(after)===code.lastIndexOf(after))continue;
  if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))throw Error('Unrecognized native model boundary');
  code=code.replace(before,after);
 }
 return code;
}
module.exports={refreshNativeModels};
