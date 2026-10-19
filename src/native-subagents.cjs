'use strict';
// Ownership and cancellation only: this module does NOT enable multi_agent.
// Callers must first establish version-specific executor/config inheritance and
// propagate trusted app-server thread/turn identity through the Mac tool host.
// Never derive identity from tool arguments or silently fall back to runtime.run.
const {randomUUID}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const clone=value=>structuredClone(value);
const required=(value,name)=>{if(typeof value!=='string'||!value)throw Error('Missing '+name);return value;};
function sourceParent(thread){
 const spawn=thread?.source?.subAgent?.thread_spawn;
 if(!spawn||!Number.isSafeInteger(spawn.depth)||spawn.depth<1||typeof spawn.parent_thread_id!=='string'||!spawn.parent_thread_id)throw Error('Unverified subagent source');
 if(thread.parentThreadId!==spawn.parent_thread_id)throw Error('Conflicting subagent parent');
 return spawn;
}
function validateInventory(inventory,name){
 if(!Array.isArray(inventory)||!inventory.length)throw Error('Missing complete MCP inventory');
 const seen=new Set();let selected=false;
 for(const server of inventory){
  if(typeof server?.name!=='string'||seen.has(server.name))throw Error('Invalid MCP inventory');seen.add(server.name);
  const tools=Object.keys(server.tools||{}),resources=server.resources||[],templates=server.resourceTemplates||[];
  if(server.name===name){
   if(server.runtimeStatus!=='connected'||!tools.some(n=>n.includes('mac_fs_read')))throw Error('Mac MCP is not ready');selected=true;
  }else if(server.runtimeStatus!=='disabled'||tools.length||resources.length||templates.length)throw Error('Unexpected peer MCP capability');
 }
 if(!selected)throw Error('Mac MCP is absent');
}
class NativeSubagents{
 constructor({runtimeId,profileId,environmentId,cwd,mcpName,owner,approvalPolicy,sandbox,workspaceRoots=[],maxThreads=128,maxDepth=16}){
  for(const [name,value] of Object.entries({runtimeId,profileId,environmentId,cwd,mcpName}))required(value,name);
  if(!cwd.startsWith('/')||!owner||approvalPolicy==null||sandbox==null||!Array.isArray(workspaceRoots))throw Error('Incomplete Mac execution binding');
  if(!Number.isSafeInteger(maxThreads)||maxThreads<1||!Number.isSafeInteger(maxDepth)||maxDepth<1)throw Error('Invalid subagent limits');
  this.binding=Object.freeze({runtimeId,profileId,environmentId,cwd,mcpName,owner,approvalPolicy:clone(approvalPolicy),sandbox:clone(sandbox),workspaceRoots:clone(workspaceRoots)});
  this.maxThreads=maxThreads;this.maxDepth=maxDepth;this.records=new Map();this.closed=false;
 }
 assertOpen(){if(this.closed)throw Error('Subagent ownership session is closed');}
 environment(thread){
  const expected=this.binding,envs=thread?.environments;
  if(!Array.isArray(envs)||envs.length!==1)throw Error('Subagent must select exactly one Mac environment');
  const env=envs[0];
  if(env.environmentId!==expected.environmentId||env.cwd!==expected.cwd||!isDeepStrictEqual(env.runtimeWorkspaceRoots||[],expected.workspaceRoots))throw Error('Subagent environment differs from its Mac owner');
 }
 evidence(threadId,evidence){
  const b=this.binding;
  if(evidence?.profileId!==b.profileId||evidence?.runtimeId!==b.runtimeId||evidence?.owner!==b.owner)throw Error('Subagent owner differs from its parent');
  if(evidence.thread?.id!==threadId)throw Error('Wrong thread verification result');
  this.environment(evidence.thread);
  if(!isDeepStrictEqual(evidence.approvalPolicy,b.approvalPolicy)||!isDeepStrictEqual(evidence.sandbox,b.sandbox))throw Error('Subagent permissions differ from its parent');
  // The caller must collect every page before supplying this array.
  if(evidence.inventoryComplete!==true)throw Error('Incomplete MCP inventory');
  validateInventory(evidence.inventory,b.mcpName);
 }
 live(record){
  if(this.closed||!record?.run||record.run.cancelled||record.run.openCodex!==true||record.run.backgroundTextOnly)return false;
  if(!record.parentId&&record.boundTurnId&&record.run.turnId!==record.boundTurnId)return false;
  for(let current=record;current.parentId;){
   const parent=this.records.get(current.parentId);
   if(!parent||parent.run!==current.parentRun||parent.run.turnId!==current.parentTurnId||parent.run.cancelled||parent.phase==='completed'||parent.phase==='cancelled')return false;
   current=parent;
  }
  return record.phase!=='completed'&&record.phase!=='cancelled';
 }
 registerRoot(run,evidence){
  this.assertOpen();required(run?.threadId,'threadId');required(run.requestId,'requestId');
  if(run.cancelled||run.backgroundTextOnly||run.openCodex!==true)throw Error('Root turn is not eligible');
  if(this.records.size)throw Error('Close the previous ownership session before registering another root');
  this.evidence(run.threadId,evidence);
  if(evidence.thread.parentThreadId!=null||evidence.thread.source?.subAgent)throw Error('A child cannot register itself as a root');
  this.records.set(run.threadId,{id:run.threadId,parentId:null,depth:0,phase:'active',admitted:true,run,boundTurnId:run.turnId||null,turns:new Set(run.turnId?[run.turnId]:[])});return run;
 }
 // This admission mode is explicitly inherited configuration, not a child MCP
 // inventory observation. Only the pinned v2 engine (no per-spawn config/role)
 // is eligible, after the root's complete pre-turn inventory check.
 registerConfiguredRoot(run,thread,receipt){
  this.assertOpen();
  if(receipt?.version!=='0.160.0'||receipt.rootThreadId!==run.threadId||receipt.inventoryVerified!==true||receipt.v2ConfigVerified!==true)throw Error('Unverified subagent inheritance receipt');
  if(this.records.size||run.cancelled||run.openCodex!==true||!run.turnId||!run.requestId||thread.id!==run.threadId||thread.parentThreadId!=null||thread.source?.subAgent)throw Error('Invalid bound root');
  this.environment(thread);this.receipt=receipt;
  this.records.set(run.threadId,{id:run.threadId,parentId:null,depth:0,phase:'active',admitted:true,run,boundTurnId:run.turnId,turns:new Set([run.turnId])});
  return run;
 }
 admitInheritedChild(threadId,thread,receipt){
  this.assertOpen();const record=this.records.get(threadId);
  if(receipt!==this.receipt||!receipt||!record?.parentId||!this.live(record))throw Error('Invalid inherited subagent admission');
  this.environment(thread);const source=sourceParent(thread);
  if(thread.id!==threadId||source.parent_thread_id!==record.parentId||source.depth!==record.depth)throw Error('Conflicting inherited subagent source');
  record.run.rootThreadId=receipt.rootThreadId;record.admitted=true;this.release(record);return record.run;
 }
 stageChild(thread){
  this.assertOpen();const id=required(thread?.id,'child threadId'),source=sourceParent(thread);
  if(this.records.has(id))throw Error('Subagent thread already registered');
  const parent=this.records.get(source.parent_thread_id);
  if(!this.live(parent)||!parent.admitted||!parent.run.turnId)throw Error('Subagent parent is not active and verified');
  if(source.depth!==parent.depth+1||source.depth>this.maxDepth)throw Error('Subagent depth differs from its parent');
  if(this.records.size>=this.maxThreads)throw Error('Subagent ownership limit reached');
  this.environment(thread);
  const record={id,parentId:parent.id,parentRun:parent.run,parentTurnId:parent.run.turnId,depth:source.depth,phase:'pending',admitted:false,run:null,turns:new Set()};
  this.records.set(id,record);this.newRun(record);return record.run;
 }
 newRun(record){
  let resolve;const toolGate=new Promise(done=>resolve=done),controller=new AbortController();
  record.resolveGate=resolve;record.controller=controller;
  record.run={requestId:randomUUID(),threadId:record.id,cancelled:false,messages:new Map(),openCodex:true,acceptUsage:true,turnStarting:true,toolGate,signal:controller.signal,parentThreadId:record.parentId};
  record.phase='pending';
 }
 admitChild(threadId,evidence){
  this.assertOpen();const record=this.records.get(threadId);
  if(!record?.parentId||!this.live(record))throw Error('Subagent is no longer pending or active');
  try{
   this.evidence(threadId,evidence);const source=sourceParent(evidence.thread);
   if(source.parent_thread_id!==record.parentId||source.depth!==record.depth)throw Error('Subagent parent changed during verification');
  }catch(error){error.cancelled=this.cancel(threadId);throw error;}
  record.admitted=true;this.release(record);return record.run;
 }
 release(record){
  if(record.admitted&&record.run.turnId&&this.live(record)){record.phase='active';record.run.turnStarting=false;record.resolveGate?.(true);record.resolveGate=null;}
 }
 startTurn(threadId,turnId){
  this.assertOpen();required(turnId,'turnId');const record=this.records.get(threadId);
  if(!record)throw Error('Unknown subagent turn');
  if(record.phase==='completed'&&record.parentId){
   if(record.turns.has(turnId))throw Error('Subagent turn has already ended');
   const parent=this.records.get(record.parentId);
   if(!this.live(parent)||parent.run!==record.parentRun||parent.run.turnId!==record.parentTurnId)throw Error('Subagent parent turn has ended');
   this.newRun(record);record.admitted=false; // Recheck evidence for every subsequent turn.
  }
  if(!this.live(record))throw Error('Subagent turn is not active');
  if(record.run.turnId&&record.run.turnId!==turnId)throw Error('Previous subagent turn is still active');
  record.run.turnId=turnId;if(!record.parentId)record.boundTurnId=turnId;record.turns.add(turnId);this.release(record);return record.run;
 }
 // context must come from authenticated transport metadata or server requests.
 // Missing thread/turn identifiers are ambiguous as soon as a child is staged.
 resolveRun(context){
  if(this.closed)return null;
  if(context==null){
   if(this.records.size!==1)return null;
   const record=this.records.values().next().value;
   return this.live(record)&&record.admitted&&record.run.turnId?record.run:null;
  }
  const b=this.binding;
  if(context.runtimeId!==b.runtimeId||context.profileId!==b.profileId||context.owner!==b.owner||context.environmentId!==b.environmentId)return null;
  if(typeof context.threadId!=='string'||typeof context.turnId!=='string')return null;
  const record=this.records.get(context.threadId);
  return this.live(record)&&record.admitted&&record.phase==='active'&&record.run.turnId===context.turnId?record.run:null;
 }
 descendants(threadId){
  const ids=new Set([threadId]);let changed=true;
  while(changed){changed=false;for(const record of this.records.values())if(ids.has(record.parentId)&&!ids.has(record.id)){ids.add(record.id);changed=true;}}
  return [...ids].map(id=>this.records.get(id)).filter(Boolean).sort((a,b)=>b.depth-a.depth);
 }
 // Caller must interrupt each returned turn and cancel only its pending approvals
 // and tool operations. Do not call the single-run global cancelActive per child.
 cancel(threadId){
  const cancelled=[];
  for(const record of this.descendants(threadId)){
   if(record.phase==='cancelled'||record.phase==='completed')continue;
   record.run.cancelled=true;record.phase='cancelled';record.resolveGate?.(false);record.resolveGate=null;record.controller?.abort();
   cancelled.push({threadId:record.id,turnId:record.run.turnId||null,requestId:record.run.requestId});
  }
  return cancelled;
 }
 finish(threadId,turnId){
  const record=this.records.get(threadId);
  if(!record||record.run.turnId!==turnId||record.phase==='completed'||record.phase==='cancelled')return null;
  const cancelled=[];
  for(const child of [...this.records.values()].filter(r=>r.parentId===threadId))cancelled.push(...this.cancel(child.id));
  record.phase='completed';record.resolveGate?.(false);record.resolveGate=null;record.controller?.abort();
  return {run:record.run,cancelled};
 }
 close(){
  if(this.closed)return [];
  const result=[];for(const record of this.records.values())if(!record.parentId)result.push(...this.cancel(record.id));
  this.closed=true;this.records.clear();return result;
 }
 inspect(){return [...this.records.values()].map(r=>({threadId:r.id,parentThreadId:r.parentId,turnId:r.run.turnId||null,phase:r.phase,admitted:r.admitted}));}
}
module.exports={NativeSubagents,validateInventory};
