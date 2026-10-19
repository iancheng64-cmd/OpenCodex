'use strict';
// A local plugin host has an ephemeral thread. Display its approvals in the
// active remote conversation while replying on the original local RPC.
function routeNativeRequest(message, nativeThreadId, run){
 if(!run?.openCodex||run.cancelled||!run.threadId)return null;
 const params=message.params||{};
 if(params.threadId&&params.threadId!==nativeThreadId)return null;
 return {...message,params:{...params,...(params.threadId?{threadId:run.threadId}:{}),...('turnId' in params?{turnId:run.turnId||null}:{})}};
}
function nativeTurnMeta(run){
 if(!run?.openCodex||run.cancelled||!run.threadId||!run.turnId)throw Error('原生工具需要有效的 OpenCodex 執行回合。');
 return {'x-codex-turn-metadata':JSON.stringify({session_id:run.rootThreadId||run.threadId,thread_id:run.threadId,turn_id:run.turnId,thread_source:run.parentThreadId?'subagent':'user',...(run.parentThreadId?{parent_thread_id:run.parentThreadId,subagent_kind:'thread_spawn'}:{})})};
}
module.exports={routeNativeRequest,nativeTurnMeta};
