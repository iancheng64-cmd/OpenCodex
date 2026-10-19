'use strict';
const before='resourceIdentity:m,server:M,signal:t,toolCallParams:e}))';
const after='resourceIdentity:m,server:M,signal:t,toolCallParams:{...e,_meta:{...e._meta,"opencodex/resourceUri":S.originResourceUri}}}))';
function patchWidget(source){
 if(source.includes(after)){if(source.split(after).length!==2||source.includes(before))throw Error('Ambiguous widget patch');return source;}
 if(source.split(before).length!==2)throw Error('Pinned native widget call boundary changed');
 return source.replace(before,after);
}
module.exports={patchWidget,after};
