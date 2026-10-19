'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),EventEmitter=require('node:events');
const {NativeHooksRuntime,nativeNotification,nativeNotifications,CAPABILITY}=require('../src/native-hooks-runtime.cjs');
function fixture(extra={}){
 const made=[],messages=[],rpc=new EventEmitter();
 const runtime={rpc,localCwd:'/mac/project',toolHost:{generation:1,server:{}},mcp:{name:'mac'},openCodexInitialized:{userAgent:'codex '+CAPABILITY,platformOs:'windows'}};
 rpc.request=async(method)=>{assert.equal(method,'hooks/list');return {data:[{hooks:[]}]};};
 const inventory={featureEnabled:true,hooks:[{eventName:'pre_tool_use',enabled:true}]};
 class Binding{
  constructor(options){Object.assign(this,{options,ready:Promise.resolve(inventory),client:{}});made.push(this);}
  invoke(args,metadata,options){this.args=args;this.invocation=options;return Promise.resolve({});}
  async cancel(id){this.cancelled=id;}
  async close(){this.closed=true;}
 }
 const hooks=new NativeHooksRuntime({runtime,Binding,inventory:async()=>inventory,onNotification:m=>messages.push(m),...extra});
 const root={threadId:'root',turnId:'turn',requestId:'req'};
 const manager={resolveHook:async(args,meta)=>({run:root,threadId:meta.threadId,sessionId:args.sessionId,turnId:root.turnId}),
  isActive:run=>run===root,interruptHookActive:()=>true};
 runtime.openCodexSubagents=manager;
 const prepare=async()=>{const p=await hooks.prepare();await p.commit('root');return hooks.plans.get('root');};
 const call=(plan,changes={})=>hooks.dispatch({arguments:{sessionId:'root',relayNonce:plan.nonce,event:'PreToolUse',turnId:'remote-turn',...changes},metadata:{threadId:'root'}});
 return {runtime,inventory,manager,root,hooks,made,messages,prepare,call};
}
test('native Hook summaries map to the frontend protocol',()=>{
 assert.deepEqual(nativeNotification('root',{method:'hooks/completed',params:{turn_id:'turn',run:{event_name:'pre_tool_use',handler_type:'mcp_tool',source:'user_config',started_at:3,status:'completed',entries:[]}}}),
 {method:'hook/completed',params:{threadId:'root',turnId:'turn',run:{eventName:'preToolUse',handlerType:'mcpTool',source:'userConfig',startedAt:3,status:'completed',entries:[]}}});
 assert.equal(nativeNotification('root',{method:'other'}),null);
});
test('maps every aggregate start to the same native identity as completion',()=>{
 const run={id:'hook',event_name:'subagent_start',handler_type:'command',status:'running'};
 const messages=nativeNotifications('child',{method:'hooks/started',params:{turnId:'turn',hooks:[run,{...run,id:'hook2'}]}});
 assert.equal(messages.length,2);assert.equal(messages[0].method,'hook/started');
 assert.deepEqual(messages[0].params,{threadId:'child',turnId:'turn',run:{id:'hook',eventName:'subagentStart',handlerType:'command',status:'running'}});
 assert.deepEqual(nativeNotifications('root',{method:'unknown'}),[]);
});
test('hides only generated transport notifications even before child admission or after thread close',async()=>{
 const f=fixture(),p=await f.prepare();
 const message={method:'hook/started',params:{threadId:'unseen-child',run:{source:'sessionFlags',handlerType:'mcpTool',sourcePath:p.source}}};
 assert.equal(f.hooks.suppress(message),true);
 assert.equal(f.hooks.suppress({...message,params:{run:{...message.params.run,source:'userConfig'}}}),false);
 assert.equal(f.hooks.suppress({...message,params:{run:{...message.params.run,sourcePath:'/other/config.toml'}}}),false);
 await f.hooks.closeThread('root');assert.equal(f.hooks.suppress({...message,method:'hook/completed'}),true);
 await f.hooks.close();assert.equal(f.hooks.suppress(message),false);
});
test('requires explicit engine capability before configuring enabled Hooks',async()=>{
 const f=fixture();f.runtime.openCodexInitialized.userAgent='codex 0.160.0';
 await assert.rejects(f.hooks.prepare(),/尚未支援/);assert.equal(f.hooks.plans.size,0);await f.hooks.close();
});
test('Windows source key matches the engine platform name',async()=>{
 const f=fixture(),p=await f.hooks.prepare();
 assert(Object.keys(p.config.hooks.state).some(k=>k.startsWith('C:\\<session-flags>\\config.toml:')));
 await p.abort();assert.equal(f.hooks.pending.size,0);await f.hooks.close();
});
test('configuration cannot commit after the authenticated endpoint changes',async()=>{
 const f=fixture(),p=await f.hooks.prepare();f.runtime.toolHost.server={};
 await assert.rejects(p.commit('root'),/歸屬/);assert.equal(f.hooks.plans.size,0);await f.hooks.close();
});
test('rejects missing identity, wrong nonce, disabled event and obsolete endpoint',async()=>{
 const f=fixture(),p=await f.prepare();
 for(const change of [{sessionId:'other'},{relayNonce:'wrong'},{event:'Stop'}])await assert.rejects(f.call(p,change),/Unverified/);
 f.runtime.toolHost.server={};await assert.rejects(f.call(p),/Unverified/);
 assert.equal(f.made.length,0);await f.hooks.close();
});
test('rejects a manager replacement during owner validation',async()=>{
 const f=fixture(),p=await f.prepare(),original=f.manager.resolveHook;
 f.manager.resolveHook=async(...args)=>{f.runtime.openCodexSubagents={};return original(...args);};
 await assert.rejects(f.call(p),/owner changed/);assert.equal(f.made.length,0);await f.hooks.close();
});
test('uses the validated turn and preserves one helper per thread',async()=>{
 const f=fixture(),p=await f.prepare();await f.call(p);await f.call(p);
 assert.equal(f.made.length,1);assert.equal(f.made[0].args.turnId,'turn');
 assert.equal(f.made[0].options.threadId,'root');assert.equal(f.made[0].options.cwd,'/mac/project');
 await f.hooks.close();assert(f.made[0].closed);
});
test('later turns retain Hooks after normal call cancellation but reject cancelled requests',async()=>{
 const f=fixture(),p=await f.prepare();await f.call(p);
 f.hooks.cancelRun(f.root);f.runtime.toolHost.generation++;
 await f.hooks.validate('root');
 f.root.turnId='next-turn';await f.call(p);
 assert.equal(f.made.length,1);assert.equal(f.made[0].args.turnId,'next-turn');
 const abort=new AbortController();abort.abort();
 await assert.rejects(f.hooks.dispatch({arguments:{sessionId:'root',relayNonce:p.nonce,event:'PreToolUse'},metadata:{threadId:'root'},signal:abort.signal}),/Unverified/);
 await f.hooks.close();
});
test('workspace changes and stopped endpoints invalidate prepared sessions',async()=>{
 for(const change of [f=>{f.runtime.localCwd='/other/project';},f=>{f.runtime.toolHost.server=undefined;},f=>{f.runtime.toolHost={generation:1,server:f.runtime.toolHost.server};}]){
  const f=fixture(),p=await f.prepare();change(f);
  await assert.rejects(f.hooks.validate('root'),/環境已變更/);
  await assert.rejects(f.call(p),/Unverified/);assert.equal(f.made.length,0);await f.hooks.close();
 }
});
test('refuses concurrent execution for one Hook session',async()=>{
 const f=fixture(),p=await f.prepare();await f.call(p);let release;
 f.made[0].invoke=()=>new Promise(r=>release=r);
 const pending=f.call(p);await new Promise(setImmediate);
 await assert.rejects(f.call(p),/already executing/);release({});await pending;await f.hooks.close();
});
test('root cancellation preserves its Interrupt helper, child cancellation closes only the child',async()=>{
 const f=fixture(),p=await f.prepare();await f.call(p);f.hooks.cancelRun(f.root);
 assert.equal(f.made[0].cancelled,'turn');assert(!f.made[0].closed);
 const child={threadId:'child',turnId:'child-turn',parentThreadId:'root'};
 f.manager.resolveHook=async()=>({run:child,threadId:'child',sessionId:'root',turnId:'child-turn'});
 f.manager.isActive=run=>run===child||run===f.root;
 await f.call(p);f.hooks.cancelRun(child);await new Promise(setImmediate);
 assert(f.made[1].closed);assert(!f.made[0].closed);await f.hooks.close();
});
test('disabled Hooks replace and close the previously configured session',async()=>{
 const f=fixture(),p=await f.prepare();await f.call(p);f.inventory.featureEnabled=false;
 const disabled=await f.hooks.prepare();assert.equal(disabled.config['features.hooks'],false);await disabled.commit('root');
 assert.equal(f.hooks.plans.size,0);assert(f.made[0].closed);await assert.rejects(f.call(p),/Unverified/);await f.hooks.close();
});
test('late notifications are dropped after a workspace change or close',async()=>{
 const f=fixture(),p=await f.prepare();await f.call(p);
 const notify=f.made[0].options.onNotification,msg={method:'hooks/completed',params:{run:{status:'completed'}}};
 notify(msg);assert.equal(f.messages.length,1);f.runtime.localCwd='/other/project';notify(msg);assert.equal(f.messages.length,1);
 await f.hooks.close();notify(msg);assert.equal(f.messages.length,1);
});
test('MCP callbacks require the active validated owner and close with it',async()=>{
 let called=0,closed=0;
 const f=fixture({mcpFactory:()=>({call:async()=>{called++;return 'result';},close:()=>closed++})}),p=await f.prepare();
 await f.call(p);const binding=f.made[0];
 assert.throws(()=>binding.options.mcpCall({},undefined),/owner ended/);
 binding.invoke=async()=>binding.options.mcpCall({},undefined);assert.equal(await f.call(p),'result');assert.equal(called,1);
 f.manager.isActive=()=>false;await assert.rejects(f.call(p),/owner ended/);assert.equal(called,1);
 await f.hooks.close();assert.equal(closed,1);
});
test('disconnect closes helpers and removes only its own relay',async()=>{
 const f=fixture(),p=await f.prepare();await f.call(p);f.runtime.rpc.emit('closed');await f.hooks.close();
 assert(f.made[0].closed);assert.equal(f.runtime.toolHost.openCodexHooksRelay,undefined);
 assert.equal(f.runtime.rpc.listenerCount('closed'),0);await assert.rejects(f.call(p),/Unverified/);
});

test('inventory parity is required even when the helper reports no Hooks',async()=>{
 const f=fixture({inventoryCheck:async()=>{throw Error('native plugin missing');}});
 f.inventory.featureEnabled=false;
 await assert.rejects(f.hooks.prepare(),/native plugin missing/);
 assert.equal(f.hooks.prepared.size,0);await f.hooks.close();
});
test('validates disabled sessions and detects configuration changes before inference',async()=>{
 const f=fixture();f.inventory.featureEnabled=false;
 const p=await f.hooks.prepare();await p.commit('root');await f.hooks.validate('root');
 f.inventory.featureEnabled=true;await assert.rejects(f.hooks.validate('root'),/設定已變更/);
 await f.hooks.close();
});
test('refuses helper settings changed between prepare and execution',async()=>{
 const f=fixture(),p=await f.prepare();f.inventory.hooks.push({eventName:'stop',enabled:true});
 await assert.rejects(f.call(p),/設定或執行歸屬/);assert.equal(f.made[0].args,undefined);await f.hooks.close();
});
test('cancelled Hook finishes once and leaves other agents running',async()=>{
 const f=fixture(),p=await f.prepare();await f.call(p);
 const child={threadId:'child',turnId:'child-turn',parentThreadId:'root'};
 f.manager.resolveHook=async()=>({run:child,threadId:'child',sessionId:'root',turnId:'child-turn'});
 f.manager.isActive=run=>run===child||run===f.root;
 await f.call(p);
 const start=(id,turnId)=>({method:'hooks/started',params:{turnId,hooks:[{id,event_name:'pre_tool_use',status:'running'}]}});
 f.made[0].options.onNotification(start('root-hook','turn'));f.made[1].options.onNotification(start('child-hook','child-turn'));
 f.hooks.cancelRun(f.root);await new Promise(setImmediate);
 const completed=f.messages.filter(m=>m.method==='hook/completed');
 assert.equal(completed.length,1);assert.equal(completed[0].params.threadId,'root');assert.equal(completed[0].params.run.status,'stopped');
 f.made[0].options.onNotification({method:'hooks/completed',params:{turnId:'turn',run:{id:'root-hook',status:'completed'}}});
 assert.equal(f.messages.filter(m=>m.method==='hook/completed').length,1);
 await f.hooks.close();
 assert.equal(f.messages.filter(m=>m.method==='hook/completed').length,2);
});
