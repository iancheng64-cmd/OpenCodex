'use strict';
const {randomUUID}=require('node:crypto');
const {NativeHooksBinding,relayConfig,EVENTS}=require('./native-hooks-relay.cjs');
const {fingerprint}=require('./native-hooks-inventory.cjs');
const CAPABILITY='OpenCodexHooks/1';
const camel=s=>s.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
function nativeNotification(threadId,message){
 if(!['hooks/completed','hooks/started'].includes(message?.method)||!message.params?.run)return null;
 const p=message.params,r=p.run,run={};
 for(const [key,value]of Object.entries(r))run[camel(key)]=value;
 for(const key of ['eventName','handlerType','executionMode','scope','source','status'])if(typeof run[key]==='string')run[key]=camel(run[key]);
 return {method:message.method==='hooks/started'?'hook/started':'hook/completed',params:{threadId,turnId:p.turn_id??p.turnId??null,run}};
}
function nativeNotifications(threadId,message){
 if(message?.method==='hooks/started')return (message.params?.hooks||[]).map(run=>nativeNotification(threadId,{method:message.method,params:{...message.params,run}}));
 const mapped=nativeNotification(threadId,message);return mapped?[mapped]:[];
}
// One owner per SSH connection. Configuration is prepared before inference;
// only an authenticated relay plus NativeAgentRuns can open a real session.
class NativeHooksRuntime{
 constructor({runtime,binary,codexHome,env,Binding=NativeHooksBinding,inventory,inventoryCheck,mcpFactory,onNotification=()=>{},onError=()=>{}}){
  Object.assign(this,{runtime,binary,codexHome,env,Binding,inventory,inventoryCheck,mcpFactory,onNotification,onError});
  this.prepared=new Map();this.plans=new Map();this.bindings=new Map();this.pending=new Set();this.relaySources=new Set();this.closed=false;
  const host=runtime.toolHost;this.host=host;
  this.relay=call=>this.dispatch(call);host.openCodexHooksRelay=this.relay;
  this.onClosed=()=>{void this.close();};runtime.rpc?.once('closed',this.onClosed);
 }
 // cancelActive advances the per-call generation after every turn. A Hook
 // configuration belongs to the authenticated endpoint across turns; reconnects
 // replace that endpoint, while workspace/config changes close this owner.
 valid(plan){return !this.closed&&!this.runtime.closed&&this.runtime.toolHost===this.host&&this.runtime.localCwd===plan.cwd&&!!plan.endpoint&&this.host.server===plan.endpoint;}
 async readInventory(cwd){
  let inventory;
  if(this.inventory)inventory=await this.inventory(cwd);
  else{
   const seed=new this.Binding({binary:this.binary,cwd,codexHome:this.codexHome,env:this.env,threadId:randomUUID(),nonce:randomUUID(),events:[]});
   try{inventory=await seed.ready;}finally{await seed.close();}
  }
  if(!inventory||!Array.isArray(inventory.hooks))throw Error('Mac Hooks 清單無效。');
  await this.inventoryCheck?.(inventory,cwd);
  return inventory;
 }
 async validate(threadId){
  const plan=this.prepared.get(threadId);
  if(!plan||!this.valid(plan))throw Error('Hooks 執行環境已變更，請重新開啟此對話。');
  const inventory=await this.readInventory(plan.cwd);
  if(!this.valid(plan)||fingerprint(inventory)!==plan.fingerprint)throw Error('Hooks 設定已變更，請重新開啟此對話。');
 }
 async prepare(){
  if(this.closed||this.runtime.run)throw Error('請先停止工作，再載入 Hooks。');
  const cwd=this.runtime.localCwd,endpoint=this.host.server,inventory=await this.readInventory(cwd);
  const stamp={cwd,endpoint,fingerprint:fingerprint(inventory)};
  if(!this.valid(stamp))throw Error('Hooks 執行環境已變更。');
  const enabled=inventory.featureEnabled?inventory.hooks.filter(h=>h.enabled):[];
  if(!enabled.length){
   let settled=false;
   return {config:{'features.hooks':false},commit:async threadId=>{
    if(settled||typeof threadId!=='string'||!threadId||!this.valid(stamp))throw Error('Hooks 對話歸屬已變更。');
    settled=true;await this.closeThread(threadId);this.prepared.set(threadId,stamp);
   },abort:async()=>{settled=true;}};
  }
  if(!String(this.runtime.openCodexInitialized?.userAgent||'').split(/\s+/).includes(CAPABILITY))throw Error('此 SSH 引擎尚未支援 OpenCodex Hooks；請先更新引擎，或在原生設定停用 Hooks。');
  const events=new Set(enabled.map(h=>Object.keys(EVENTS).find(e=>EVENTS[e].snake===h.eventName)||h.eventName));
  for(const event of events)if(!EVENTS[event])throw Error('此版本尚未支援 Mac Hooks 事件：'+event);
  if(enabled.some(h=>h.source==='plugin')&&!inventory.capabilities?.pluginDiscovery)throw Error('此外掛 Hooks 尚未接入 Mac 執行環境。');
  const listed=await this.runtime.rpc.request('hooks/list',{},15000);
  if(!Array.isArray(listed?.data)||listed.data.some(g=>!Array.isArray(g.hooks)))throw Error('SSH Hooks 清單無效。');
  const relay=relayConfig({server:this.runtime.mcp.name,events:[...events],remoteHooks:listed.data.flatMap(g=>g.hooks),platform:this.runtime.openCodexInitialized.platformOs});
  const plan={...relay,...stamp,threadId:null};
  if(!this.valid(plan))throw Error('Hooks 執行環境已變更。');
  this.relaySources.add(relay.source);this.pending.add(plan);let settled=false;
  return {config:relay.config,commit:async threadId=>{
   if(settled)throw Error('Hooks 設定已結束。');settled=true;this.pending.delete(plan);
   if(typeof threadId!=='string'||!threadId||!this.valid(plan))throw Error('Hooks 對話歸屬已變更。');
   await this.closeThread(threadId);plan.threadId=threadId;this.plans.set(threadId,plan);this.prepared.set(threadId,plan);
  },abort:async()=>{settled=true;this.pending.delete(plan);}};
 }
 async dispatch({arguments:args,metadata,signal,claim}){
  const plan=this.plans.get(args?.sessionId);
  if(!plan||!this.valid(plan)||signal?.aborted||args?.relayNonce!==plan.nonce||!plan.events.has(args.event))throw Error('Unverified Hooks session');
  const manager=this.runtime.openCodexSubagents;
  if(!manager)throw Error('Hooks requires a verified native agent owner');
  const owner=await manager.resolveHook(args,metadata,signal);
  if(!this.valid(plan)||this.runtime.openCodexSubagents!==manager||signal?.aborted)throw Error('Hooks owner changed');
  claim?.(owner.run);
  let record=this.bindings.get(owner.threadId);
  if(record&&(record.plan!==plan||record.sessionId!==owner.sessionId))throw Error('Hooks session identity changed');
  if(!record){
   if(this.bindings.size>=16)throw Error('同時執行的 Hooks 工作階段已達上限。');
   record={plan,sessionId:owner.sessionId,threadId:owner.threadId,notifications:new Map(),finished:new Set()};
   this.bindings.set(owner.threadId,record);
   try{
    record.binding=new this.Binding({binary:this.binary,cwd:plan.cwd,codexHome:this.codexHome,env:this.env,threadId:owner.threadId,sessionId:owner.sessionId,subagent:owner.subagent,nonce:plan.nonce,events:plan.events,
     mcpCall:(call,abortSignal)=>{
      const active=record.active;
      if(!active||!active.authorized())throw Error('MCP Hook owner ended');
      record.mcp??=this.mcpFactory?.(record);
      if(!record.mcp)throw Error('Mac MCP Hooks execution is unavailable');
      return record.mcp.call(call,abortSignal,active);
     },onNotification:message=>{
      if(this.valid(plan)&&this.bindings.get(owner.threadId)===record)for(const mapped of nativeNotifications(owner.threadId,message))this.notify(record,mapped);
     }});
   }catch(error){this.bindings.delete(owner.threadId);throw error;}
  }
  if(record.active)throw Error('Hooks session is already executing');
  record.ownerRun=owner.run;
  const authorized=()=>this.valid(plan)&&this.runtime.openCodexSubagents===manager&&!signal?.aborted&&(owner.interruptLease?manager.interruptHookActive(owner.interruptLease):manager.isActive(owner.run));
  const active={owner,manager,authorized};record.active=active;
  try{
   if(!record.verified){
    const inventory=await record.binding.ready;
    if(!authorized()||fingerprint(inventory)!==plan.fingerprint)throw Error('Hooks 設定或執行歸屬已變更，請重新開啟此對話。');
    record.verified=true;
   }
   return await record.binding.invoke({...args,turnId:owner.turnId},metadata,{signal,authorizeInterrupt:owner.interruptLease?authorized:undefined});}
  finally{if(record.active===active)record.active=null;}
 }
 notify(record,message){
  const key=JSON.stringify([message.params.turnId,message.params.run.id]);
  if(message.method==='hook/started'){record.finished.delete(key);record.notifications.set(key,{message,at:Date.now()});}
  else{if(record.finished.has(key))return;record.notifications.delete(key);record.finished.add(key);}
  this.onNotification(message);
 }
 finishPending(record,pending=[...record.notifications]){
  for(const [key,value]of pending)if(record.notifications.get(key)===value){
   const {message,at}=value;
   this.notify(record,{method:'hook/completed',params:{...message.params,run:{...message.params.run,status:'stopped',statusMessage:'工作已停止',completedAt:Math.floor(Date.now()/1000),durationMs:Math.max(0,Date.now()-at)}}});
  }
 }
 cancelRun(run){
  for(const record of this.bindings.values())if(record.ownerRun===run){
   const pending=[...record.notifications];
   void record.binding.cancel(record.binding.client?.active?.turnId||run.turnId).catch(this.onError).finally(()=>this.finishPending(record,pending));
   record.mcp?.cancel?.();
   // Keep the root helper for its single-use Interrupt lease and later turns.
   if(record.threadId!==record.sessionId)void this.closeRecord(record).catch(this.onError);
  }
 }
 async closeRecord(record){
  if(this.bindings.get(record.threadId)===record)this.bindings.delete(record.threadId);
  record.mcp?.close?.();try{await record.binding?.close();}finally{this.finishPending(record);}
 }
 async closeThread(threadId){
  this.plans.delete(threadId);this.prepared.delete(threadId);
  await Promise.all([...this.bindings.values()].filter(r=>r.sessionId===threadId).map(r=>this.closeRecord(r)));
 }
 suppress(message){
  const run=message?.params?.run;
  // Start notifications can precede child admission. Match only the generated
  // transport source; retain this knowledge for late completion notifications.
  return !this.closed&&/^hook\/(started|completed)$/.test(message?.method)&&run?.source==='sessionFlags'&&run.handlerType==='mcpTool'&&this.relaySources.has(run.sourcePath);
 }
 async close(){
  if(this.closing)return this.closing;this.closed=true;this.plans.clear();this.prepared.clear();this.pending.clear();
  this.runtime.rpc?.removeListener('closed',this.onClosed);
  if(this.host.openCodexHooksRelay===this.relay)delete this.host.openCodexHooksRelay;
  this.closing=Promise.allSettled([...this.bindings.values()].map(r=>this.closeRecord(r))).then(results=>{for(const r of results)if(r.status==='rejected')this.onError(r.reason);});return this.closing;
 }
}
module.exports={NativeHooksRuntime,nativeNotification,nativeNotifications,CAPABILITY};
