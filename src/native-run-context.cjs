'use strict';
// Only the authenticated Mac MCP host or the app-server request router enters
// this scope. Tool arguments never select a run.
const {AsyncLocalStorage}=require('node:async_hooks');
const storage=new AsyncLocalStorage();
function withRun(runtime,run,operation){
 if(!runtime||!run?.openCodex||run.cancelled||!run.threadId||!run.turnId)throw Error('Request cancelled: inactive OpenCodex turn');
 return storage.run({runtime,run},operation);
}
function scopedRun(runtime){const scope=storage.getStore();return scope?.runtime===runtime?scope.run:undefined;}
function turnMetadata(meta){
 let value=meta?.['x-codex-turn-metadata'];
 if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw Error('Invalid turn metadata');}}
 if(!value||Array.isArray(value)||typeof value!=='object')throw Error('Missing turn metadata');
 for(const key of ['session_id','thread_id','turn_id'])if(typeof value[key]!=='string'||!value[key])throw Error('Incomplete turn metadata');
 for(const [key,field]of [['threadId','thread_id'],['sessionId','session_id']])if(meta[key]!=null&&meta[key]!==value[field])throw Error('Conflicting turn metadata');
 // 0.160 omits thread_source on root calls; only a self-owned session may normalize it.
 if(value.thread_source==null&&value.session_id===value.thread_id&&!value.parent_thread_id)value={...value,thread_source:'user'};
 if(value.thread_source!=='user'&&value.thread_source!=='subagent')throw Error('Unsupported turn source');
 if(value.thread_source==='subagent'&&(typeof value.parent_thread_id!=='string'||!value.parent_thread_id))throw Error('Missing parent identity');
 if(value.thread_source==='user'&&(value.session_id!==value.thread_id||value.parent_thread_id))throw Error('Invalid root identity');
 return Object.freeze({...value});
}
module.exports={withRun,scopedRun,turnMetadata};
