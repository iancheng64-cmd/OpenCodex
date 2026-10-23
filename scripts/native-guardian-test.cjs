'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {NativeGuardian}=require('../src/native-guardian.cjs');
const checks=[],test=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
function setup(){
 let current=true;const ended=new Set(),controller=new AbortController();
 const root={threadId:'root',turnId:'turn'},child={threadId:'child',turnId:'child-turn'};
 const gate=new NativeGuardian({sessionId:'root',server:'mac',current:()=>current,active:r=>!ended.has(r),waitMs:30});
 const call=(run=root,callId='call')=>({name:'write',arguments:{content:'value',path:'/owned'},signal:controller.signal,
  metadata:{callId,threadId:run.threadId,sessionId:'root','x-codex-turn-metadata':{
   session_id:'root',thread_id:run.threadId,turn_id:run.turnId,auto_review_enabled:true,
   ...(run===root?{}:{thread_source:'subagent',parent_thread_id:'root'})
  }}});
 const events=(run=root,callId='call')=>[
  {method:'item/started',params:{threadId:run.threadId,turnId:run.turnId,item:{type:'mcpToolCall',id:callId,server:'mac',tool:'write',arguments:{path:'/owned',content:'value'}}}},
  ...['started','completed'].map(phase=>({method:'item/autoApprovalReview/'+phase,params:{threadId:run.threadId,turnId:run.turnId,targetItemId:callId,reviewId:'review-'+callId,decisionSource:phase==='completed'?'agent':undefined,review:{status:phase==='started'?'inProgress':'approved'},action:{type:'mcpToolCall',server:'mac',toolName:'write'}}}))
 ];
 const approve=(run,id)=>events(run,id).forEach(e=>gate.notification(e));
 return {gate,root,child,controller,call,events,approve,ended,disconnect:()=>current=false};
}
(async()=>{
 await test('approval binds exact arguments independent of JSON key order and is consumed once',async()=>{
  const x=setup();x.approve();assert(await x.gate.authorize(x.root,x.call()));assert(!await x.gate.authorize(x.root,x.call()));
  x.approve();assert(!await x.gate.authorize(x.root,x.call()));x.gate.close();
 });
 await test('metadata cannot invent a decision, call ID, owner, turn or reviewer',async()=>{
  const mutate=[
   c=>{delete c.metadata.callId;c.metadata.itemId='call';},c=>c.metadata.callId='other',
   c=>c.metadata.threadId='other',c=>c.metadata.sessionId='other',
   c=>c.metadata['x-codex-turn-metadata'].session_id='other',
   c=>c.metadata['x-codex-turn-metadata'].thread_id='other',
   c=>c.metadata['x-codex-turn-metadata'].turn_id='old',
   c=>c.metadata['x-codex-turn-metadata'].auto_review_enabled=false,
   c=>c.name='other',c=>c.arguments.path='/unapproved',
   c=>c.arguments.extra=true,c=>{delete c.arguments.content;}
  ];
  for(const change of mutate){const x=setup();x.approve();const c=x.call();change(c);assert(!await x.gate.authorize(x.root,c));x.gate.close();}
  const x=setup(),c=x.call();c.metadata.decision='approved';assert(!await x.gate.authorize(x.root,c));x.gate.close();
 });
 await test('denied, aborted, malformed or mismatched native reviews cannot grant access',async()=>{
  for(const change of [
   e=>e[2].params.review.status='denied',e=>e[2].params.review.status='aborted',
   e=>e[2].params.review={},e=>e[2].params.decisionSource='user',
   e=>e[2].params.reviewId='other',e=>e[2].params.action.server='peer',
   e=>e[2].params.action.toolName='other',e=>e.splice(1,1),
   e=>e[0].params.item.arguments.content='different'
  ]){const x=setup(),e=x.events();change(e);e.forEach(m=>x.gate.notification(m));assert(!await x.gate.authorize(x.root,x.call()));x.gate.close();}
 });
 await test('HTTP arriving before native events waits boundedly, and duplicate HTTP cannot replay it',async()=>{
  const x=setup(),pending=x.gate.authorize(x.root,x.call());
  assert(!await x.gate.authorize(x.root,x.call()));x.approve();assert(await pending);x.gate.close();
  const y=setup();assert(!await y.gate.authorize(y.root,y.call()));y.approve();assert(!await y.gate.authorize(y.root,y.call()));y.gate.close();
 });
 await test('native completion and cancellation close pending and future receipts',async()=>{
  for(const stop of [
   x=>x.controller.abort(),x=>x.gate.cancel('root','turn'),x=>x.gate.close(),x=>x.disconnect(),
   x=>x.ended.add(x.root),
   x=>x.gate.notification({method:'turn/completed',params:{threadId:'root',turn:{id:'turn'}}}),
   x=>x.gate.notification({method:'item/completed',params:{threadId:'root',turnId:'turn',item:{type:'mcpToolCall',id:'call'}}})
  ]){const x=setup(),pending=x.gate.authorize(x.root,x.call());stop(x);x.approve();assert(!await pending);assert(!await x.gate.authorize(x.root,x.call()));x.gate.close();}
 });
 await test('child approvals cannot authorize siblings and child cancellation preserves root',async()=>{
  const x=setup();x.approve(x.child);x.approve(x.root);x.gate.cancel('child','child-turn');
  assert(!await x.gate.authorize(x.child,x.call(x.child)));assert(await x.gate.authorize(x.root,x.call()));x.gate.close();
  const y=setup();y.approve(y.child);assert(!await y.gate.authorize(y.root,y.call()));assert(await y.gate.authorize(y.child,y.call(y.child)));y.gate.close();
 });
 await test('inline review mapping binds parent events to verified delegate metadata',async()=>{
  const x=setup();x.approve();
  assert(!await x.gate.authorize(x.root,x.call(x.child)));
  assert(await x.gate.authorize(x.root,x.call(x.child),x.child,x.root));
  assert(!await x.gate.authorize(x.root,x.call(x.child),x.child,x.root));x.gate.close();
  for(const cancel of [x=>x.gate.cancel('child','child-turn'),x=>x.gate.cancel('root','turn')]){
   const y=setup(),pending=y.gate.authorize(y.root,y.call(y.child),y.child,y.root);
   cancel(y);y.approve();assert(!await pending);y.gate.close();
  }
  const y=setup();y.approve();const c=y.call(y.child);c.metadata['x-codex-turn-metadata'].thread_id='sibling';
  assert(!await y.gate.authorize(y.root,c,y.child,y.root));y.gate.close();
 });
 await test('conflicting events and receipt overflow cannot reopen admission',async()=>{
  const x=setup();x.approve();const e=x.events();e[0].params.item.arguments.path='/other';x.gate.notification(e[0]);assert(!await x.gate.authorize(x.root,x.call()));x.gate.close();
  const y=setup();y.gate.maxEntries=1;y.approve();y.approve(y.child,'new');assert(!await y.gate.authorize(y.root,y.call()));assert(y.gate.closed);
 });
 const report={at:new Date().toISOString(),passed:true,checks,scope:'exact native Guardian event receipts; isolated unit tests, not product activation'};
 fs.writeFileSync(path.resolve(__dirname,'../evidence/native-guardian-test.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;});
