'use strict';
// Run after the orchestrator restarts the rebuilt GPT dev app, before SSH connects.
// This script only reads existing QA fixtures and native RPC state. It neither
// launches/reconnects the app nor creates, changes or deletes threads/projects.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {cdp,rpc}=require('./qa-client.cjs');
const evidence=path.resolve(__dirname,'../evidence'),output=path.join(evidence,'native-restart-e2e.json');
const report={version:'0.4.10',at:new Date().toISOString(),passed:false,tests:[],scope:'offline persisted artifacts after caller-controlled app restart; native JSON-RPC and read-only runtime status, not renderer interaction'};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});
save();
(async()=>{
 let client,desktop;
 const watchdog=setTimeout(()=>{report.error='Offline restart E2E timed out';save();process.exit(1);},300000);
 try{
  const readEvidence=name=>{
   const result=JSON.parse(fs.readFileSync(path.join(evidence,name),'utf8'));
   assert.equal(result.version,report.version,name+' must describe this build');
   assert.equal(result.passed,true,name+' must have passed');
   return result;
  };
  const workspace=readEvidence('native-workspace-e2e.json'),organization=readEvidence('native-organization-e2e.json');
  const fixtureRoot=fs.realpathSync(evidence)+path.sep;
  const ownedFixture=(value,prefix)=>{
   assert.equal(typeof value,'string');
   const resolved=fs.realpathSync(value);
   assert(resolved.startsWith(fixtureRoot+prefix),'Only existing QA fixture paths are allowed');
   return resolved;
  };
  const workspaceFixture=ownedFixture(workspace.fixture,'workspace-qa-');
  const organizationFixture=ownedFixture(organization.fixture,'organization-qa-');
  const marker=fs.readFileSync(path.join(workspaceFixture,'project-marker.txt'),'utf8').trim();
  assert(marker);assert.equal(typeof workspace.nativeText,'string');assert(workspace.nativeText.includes(marker));
  assert.equal(typeof workspace.threadA,'string');assert(workspace.threadA);
  assert.equal(typeof organization.projectId,'string');assert.equal(typeof organization.sectionId,'string');
  assert(Array.isArray(organization.expectedOrder)&&organization.expectedOrder.length===2);
  assert.equal(new Set(organization.expectedOrder).size,2);
  assert.deepEqual(new Set(organization.threadIds),new Set(organization.expectedOrder));
  assert(organization.createdIDs.projectIds.includes(organization.projectId));
  assert(organization.createdIDs.sectionIds.includes(organization.sectionId));
  assert(organization.expectedOrder.every(id=>organization.createdIDs.threadIds.includes(id)));
  assert(!organization.deletedIDs.projectIds.includes(organization.projectId));
  assert(!organization.deletedIDs.sectionIds.includes(organization.sectionId));
  report.sourceThreadId=workspace.threadA;report.projectId=organization.projectId;
  report.sectionId=organization.sectionId;report.expectedOrder=organization.expectedOrder;
  report.sourceEvidence={workspaceAt:workspace.at,organizationAt:organization.at};
  desktop=await cdp();
  const offlineState=async()=>{
   const state=await desktop.evaluate('window.openCodexRuntime.status()');
   assert.equal(state.version,report.version);
   assert(['ssh','bridge'].includes(state.mode),'Runtime must remain in remote GPT mode');
   assert.equal(state.sshAgent,'codex');
   assert.equal(state.connected,false,'Restart checks must run before SSH connects');
   assert(!state.connecting,'A connection must not be in progress');
   assert.equal(state.executor,false,'No remote executor may be active');
   assert(!state.permissionBusy,'No active turn may alter the persisted fixture');
   return {version:state.version,mode:state.mode,sshAgent:state.sshAgent,connected:state.connected,executor:state.executor,profileId:state.profileId,fullAccess:state.fullAccess,permissionMode:state.permissionMode};
  };
  const initialState=await offlineState();report.runtime=initialState;
  client=await rpc();
  const call=(method,params={})=>client.call(method,params,60000);
  await call('initialize',{clientInfo:{name:'opencodex-restart-qa',version:report.version},capabilities:{experimentalApi:true}});
  const read=await call('thread/read',{threadId:workspace.threadA,includeTurns:true});
  assert.equal(read.openCodexHistoryComplete,true,'Persisted history must be explicitly complete');
  assert.equal(read.thread.id,workspace.threadA);assert.equal(read.thread.cwd,workspaceFixture);
  assert(Array.isArray(read.thread.turns)&&read.thread.turns.length>0);
  const turns=read.thread.turns,turnIds=turns.map(turn=>turn.id);
  assert.equal(new Set(turnIds).size,turnIds.length);
  assert(turns.every(turn=>Array.isArray(turn.items)));
  const replies=turns.flatMap(turn=>turn.items).filter(item=>item.type==='agentMessage').map(item=>item.text||'').join('');
  assert(replies.includes(marker),'Offline history must retain the real GPT reply marker');
  assert(replies.includes(workspace.nativeText.trim()),'Offline history must retain the recorded native response');
  const shellTurns=turns.filter(turn=>turn.items.some(item=>item.type==='commandExecution'&&item.command?.includes('/bin/cat project-marker.txt')));
  assert(shellTurns.length>=2,'Both pre-switch and resumed Mac shell cards must persist');
  const shellCards=shellTurns.flatMap(turn=>turn.items.filter(item=>item.type==='commandExecution'&&item.command?.includes('/bin/cat project-marker.txt')));
  assert(shellCards.every(item=>item.cwd===workspaceFixture&&item.exitCode===0&&String(item.aggregatedOutput).includes(marker)&&String(item.aggregatedOutput).includes(workspaceFixture)));
  assert(shellCards.some(item=>item.aggregatedOutput===workspace.shellA));
  assert(shellCards.some(item=>item.aggregatedOutput===workspace.resumedShellA));
  report.shellTurnIds=shellTurns.map(turn=>turn.id);
  report.tests.push('offline thread/read restores the complete native GPT response and both successful Mac shell cards');
  save();
  async function pages(method,params,{limit=1,maxPages=1000}={}){
   const rows=[],seen=new Set();let cursor=null;
   for(let pageIndex=0;pageIndex<maxPages;pageIndex++){
    const page=await call(method,{...params,limit,cursor});
    assert(Array.isArray(page.data),method+' must return data');
    assert(page.data.length<=limit,method+' must respect page size');
    rows.push(...page.data);
    if(!page.nextCursor)return rows;
    assert(!seen.has(page.nextCursor),method+' cursor did not advance');
    seen.add(page.nextCursor);cursor=page.nextCursor;
   }
   throw Error(method+' exceeded the bounded QA page limit');
  }
  const asc=await pages('thread/turns/list',{threadId:workspace.threadA,sortDirection:'asc',itemsView:'full'});
  const desc=await pages('thread/turns/list',{threadId:workspace.threadA,sortDirection:'desc',itemsView:'full'});
  assert.deepEqual(asc.map(turn=>turn.id),turnIds);
  assert.deepEqual(desc.map(turn=>turn.id),turnIds.slice().reverse());
  assert.deepEqual(asc.map(turn=>turn.items),turns.map(turn=>turn.items));
  const head=await call('thread/turns/list',{threadId:workspace.threadA,limit:1,sortDirection:'desc',itemsView:'full'});
  assert(head.backwardsCursor);
  const reverse=await call('thread/turns/list',{threadId:workspace.threadA,limit:1,sortDirection:'asc',itemsView:'full',cursor:head.backwardsCursor});
  assert.equal(reverse.data[0]?.id,head.data[0].id);
  const expectedItems=turns.flatMap(turn=>turn.items.map(item=>({turnId:turn.id,item})));
  const items=await pages('thread/items/list',{threadId:workspace.threadA,sortDirection:'asc'});
  assert.deepEqual(items.map(({turnId,item})=>({turnId,item})),expectedItems);
  const descendingItems=await pages('thread/items/list',{threadId:workspace.threadA,sortDirection:'desc'});
  assert.deepEqual(descendingItems.map(({turnId,item})=>({turnId,item})),expectedItems.slice().reverse());
  for(const turn of shellTurns){
   const perTurn=await pages('thread/items/list',{threadId:workspace.threadA,turnId:turn.id,sortDirection:'asc'});
   assert.deepEqual(perTurn.map(entry=>entry.item),turn.items);
   const after=await call('thread/items/list',{threadId:workspace.threadA,turnId:turn.id,sortDirection:'asc',cursor:{type:'item',itemId:turn.items.at(-1).id}});
   assert.equal(after.data.length,0);
  }
  report.turnCount=turns.length;report.itemCount=items.length;
  report.tests.push('offline turn/item pagination preserves order and complete cards; reverse anchors are inclusive and item anchors exclusive');
  save();
  const project=(await call('project/read',{projectId:organization.projectId})).project;
  assert.equal(project?.id,organization.projectId);assert.equal(project.name,organization.projectName);
  assert(project.roots?.some(root=>root.path===organizationFixture));
  const sections=await pages('threadSection/list',{}, {limit:100});
  const section=sections.find(value=>value.id===organization.sectionId);
  assert(section,'Persisted QA section must still exist');assert.equal(section.name,organization.sectionName);assert.equal(section.appearance,null);
  const query={cwd:organizationFixture,sectionId:organization.sectionId,sortKey:'section_position',useStateDbOnly:true};
  const ordered=await pages('thread/list',query);
  assert.deepEqual(ordered.map(thread=>thread.id),organization.expectedOrder);
  const backwards=await pages('thread/list',{...query,sortDirection:'desc'});
  assert.deepEqual(backwards.map(thread=>thread.id),organization.expectedOrder.slice().reverse());
  const assigned=await pages('thread/list',{cwd:organizationFixture,projectId:organization.projectId,useStateDbOnly:true});
  assert.deepEqual(new Set(assigned.map(thread=>thread.id)),new Set(organization.expectedOrder));
  const assertMetadata=thread=>{
   assert(organization.expectedOrder.includes(thread.id));assert.equal(thread.cwd,organizationFixture);
   assert.equal(thread.projectId,organization.projectId);assert.equal(thread.section?.id,organization.sectionId);
   assert.equal(thread.section.name,organization.sectionName);assert.equal(thread.section.appearance,null);
  };
  ordered.forEach(assertMetadata);backwards.forEach(assertMetadata);assigned.forEach(assertMetadata);
  const snapshots=new Map();
  for(const threadId of organization.expectedOrder){
   const thread=(await call('thread/read',{threadId,includeTurns:false})).thread;
   assertMetadata(thread);snapshots.set(threadId,thread);
  }
  report.tests.push('offline project/read, section/list and fixture-filtered thread lists restore renamed metadata, membership and ASC/DESC section order');
  const children=readEvidence('native-subagents-live.json');
  const childFixture=ownedFixture(children.fixture,'subagent-live-');
  const childMarker=fs.readFileSync(path.join(childFixture,'marker.txt'),'utf8').trim();
  assert(childMarker);assert.equal(children.children.length,2);
  const parentHistory=await call('thread/read',{threadId:children.rootId,includeTurns:true});
  assert.equal(parentHistory.openCodexHistoryComplete,true);
  const childIds=new Set(parentHistory.thread.turns.flatMap(t=>t.items||[]).filter(i=>i.type==='subAgentActivity'&&i.kind==='started').map(i=>i.agentThreadId));
  assert.deepEqual(childIds,new Set(children.children.map(child=>child.id)));
  for(const child of children.children){
   const history=await call('thread/read',{threadId:child.id,includeTurns:true});
   assert.equal(history.openCodexHistoryComplete,true);
   assert.equal(history.thread.parentThreadId,children.rootId);assert.equal(history.thread.cwd,childFixture);
   assert(history.thread.turns.every(t=>t.itemsView==='full'));
   const items=history.thread.turns.flatMap(t=>t.items||[]);
   assert(items.some(i=>i.type==='agentMessage'&&i.text.includes(childMarker)));
   assert(items.some(i=>i.type==='mcpToolCall'&&i.status==='completed'&&JSON.stringify(i.result).includes(childMarker)));
  }
  report.nativeSubagentPersistence=true;
  report.tests.push('offline restart retains parent activity links, both child histories and completed native tool result cards');
  assert.deepEqual((await call('thread/read',{threadId:workspace.threadA,includeTurns:true})).thread,read.thread);
  for(const [threadId,before] of snapshots)assert.deepEqual((await call('thread/read',{threadId,includeTurns:false})).thread,before);
  assert.deepEqual(await offlineState(),initialState);
  report.tests.push('all read-only checks leave thread metadata/history, selected GPT profile and offline permission state unchanged');
  report.passed=true;
 }catch(error){report.error=error.stack||String(error);process.exitCode=1;}
 finally{clearTimeout(watchdog);client?.close();desktop?.close();save();console.log(JSON.stringify(report));}
})().catch(error=>{report.passed=false;report.error=error.stack||String(error);save();console.error(report.error);process.exitCode=1;}).finally(()=>process.exit(process.exitCode||0));
