'use strict';
// Codex deprecated detached delivery in favour of a separate thread + inline review.
// Both requests traverse the normal owner, permission and Mac isolation checks.
async function detachedReview(params,request){
 const created=await request('thread/start',{...(params.cwd?{cwd:params.cwd}:{}),...(params.permissions?{permissions:params.permissions}:{}),...(params.approvalsReviewer?{approvalsReviewer:params.approvalsReviewer}:{})});
 const threadId=created?.thread?.id;
 if(!threadId||threadId===params.threadId)throw Error('無法建立獨立審查對話。');
 const result=await request('review/start',{...params,threadId,delivery:'inline'});
 if(result.reviewThreadId!==threadId)throw Error('審查回傳了非預期的對話。');
 return result;
}
module.exports={detachedReview};
