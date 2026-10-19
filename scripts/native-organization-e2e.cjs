'use strict';
// Run only against an already connected GPT SSH QA instance after rebuilding.
// All app interaction uses the native JSON-RPC endpoint. Retain the main
// fixture for the orchestrator's offline/restart checks; never delete threads.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {rpc,wait}=require('./qa-client.cjs');
const evidence=path.resolve(__dirname,'../evidence'),output=path.join(evidence,'native-organization-e2e.json');
fs.mkdirSync(evidence,{recursive:true});
const fixture=fs.realpathSync(fs.mkdtempSync(path.join(evidence,'organization-qa-')));
const report={version:'0.4.8',at:new Date().toISOString(),passed:false,fixture,tests:[],createdIDs:{threadIds:[],sectionIds:[],projectIds:[]},deletedIDs:{sectionIds:[],projectIds:[]},scope:'real native JSON-RPC over an already connected GPT SSH instance; UI and restart checks are separate'};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});
save();
(async()=>{
 let client;
 const watchdog=setTimeout(()=>{report.error='Organization E2E timed out';save();process.exit(1);},300000);
 try{
  client=await rpc();
  const call=(method,params)=>client.call(method,params,60000);
  await call('initialize',{clientInfo:{name:'opencodex-organization-qa',version:report.version},capabilities:{experimentalApi:true}});
  async function createProject(label){const root=label==='organization'?fixture:fs.mkdtempSync(path.join(fixture,'scratch-project-'));const project=(await call('project/create',{idempotencyKey:crypto.randomUUID(),name:'OpenCodex QA '+label,roots:[{path:root}],metadata:{fixture:'native-organization'}})).project;assert(project?.id);report.createdIDs.projectIds.push(project.id);save();return project;}
  async function createSection(label){const section=(await call('threadSection/create',{name:'OpenCodex QA '+label,appearance:{color:'blue'}})).section;assert(section?.id);report.createdIDs.sectionIds.push(section.id);save();return section;}
  async function start(projectId){const params={cwd:fixture,permissions:':workspace'};if(projectId!==undefined)params.projectId=projectId;const thread=(await call('thread/start',params)).thread;assert(thread?.id);assert.equal(thread.cwd,fixture);report.createdIDs.threadIds.push(thread.id);save();return thread;}
  const project=await createProject('organization'),section=await createSection('organization');
  report.projectId=project.id;report.sectionId=section.id;save();
  const first=await start(project.id),second=await start();
  report.threadId=first.id;report.threadIds=[first.id,second.id];save();
  // The native engine does not persist/list never-started empty threads.
  // Seed real turns before asserting database-backed organization queries.
  for(const thread of [first,second]){
   const marker='ORGANIZATION-'+crypto.randomUUID(),from=client.events.length;
   const started=await call('turn/start',{threadId:thread.id,effort:'low',input:[{type:'text',text:'這是分類功能驗收。請勿使用工具，只回覆以下字串：'+marker}]});
   const done=await wait(()=>client.events.slice(from).find(e=>e.method==='turn/completed'&&e.params.threadId===thread.id&&e.params.turn.id===started.turn.id));
   assert.equal(done.params.turn.status,'completed');
   const history=(await call('thread/read',{threadId:thread.id,includeTurns:true})).thread;
   assert(history.turns.some(t=>t.id===started.turn.id&&t.items.some(i=>i.type==='agentMessage'&&i.text.includes(marker))));
  }
  report.tests.push('two real GPT turns persist the native thread rows before database-backed list assertions');save();
  assert.equal(first.projectId,project.id);assert.equal(second.projectId,null);
  let thread=(await call('thread/metadata/update',{threadId:second.id,projectId:project.id})).thread;
  assert.equal(thread.projectId,project.id);
  assert(client.events.some(e=>e.method==='thread/project/updated'&&e.params.threadId===second.id&&e.params.projectId===project.id));
  report.tests.push('project create, start assignment, metadata reassignment and native update notification');save();
  for(const threadId of [first.id,second.id])await call('thread/section/move',{threadId,sectionId:section.id});
  await call('thread/section/move',{threadId:second.id,sectionId:section.id,beforeThreadId:first.id});
  const query={cwd:fixture,sectionId:section.id,sortKey:'section_position',useStateDbOnly:true,limit:100};
  const list=await call('thread/list',query);assert.deepEqual(list.data.map(t=>t.id),[second.id,first.id]);
  const descending=await call('thread/list',{...query,sortDirection:'desc'});assert.deepEqual(descending.data.map(t=>t.id),[first.id,second.id]);
  const page=await call('thread/list',{...query,limit:1});assert.deepEqual(page.data.map(t=>t.id),[second.id]);assert(page.nextCursor);
  const next=await call('thread/list',{...query,limit:1,cursor:page.nextCursor});assert.deepEqual(next.data.map(t=>t.id),[first.id]);assert.equal(next.nextCursor,null);
  report.sectionName='OpenCodex QA organization renamed';
  await call('threadSection/update',{sectionId:section.id,name:report.sectionName,appearance:null});
  thread=(await call('thread/read',{threadId:first.id,includeTurns:false})).thread;assert.equal(thread.section.id,section.id);assert.equal(thread.section.name,report.sectionName);assert.equal(thread.section.appearance,null);
  report.tests.push('section create, before ordering, default ASC, explicit DESC, local pagination and rename');save();
  const projectQuery={cwd:fixture,projectId:project.id,useStateDbOnly:true,limit:100};
  let filtered=await call('thread/list',projectQuery);assert.deepEqual(new Set(filtered.data.map(t=>t.id)),new Set([first.id,second.id]));
  thread=(await call('thread/metadata/update',{threadId:second.id,projectId:''})).thread;assert.equal(thread.projectId,null);
  filtered=await call('thread/list',projectQuery);assert.deepEqual(filtered.data.map(t=>t.id),[first.id]);
  const unassigned=await call('thread/list',{...projectQuery,projectId:null});assert.deepEqual(unassigned.data.map(t=>t.id),[second.id]);
  thread=(await call('thread/metadata/update',{threadId:second.id,projectId:project.id})).thread;assert.equal(thread.projectId,project.id);
  report.tests.push('project filtering, empty-string clear and unassigned filtering');save();
  const scratchSection=await createSection('delete fixture');
  await call('thread/section/move',{threadId:second.id,sectionId:scratchSection.id});
  await call('threadSection/delete',{sectionId:scratchSection.id});report.deletedIDs.sectionIds.push(scratchSection.id);save();
  thread=(await call('thread/read',{threadId:second.id})).thread;assert.equal(thread.section,null);assert.equal(thread.projectId,project.id);
  await call('thread/section/move',{threadId:second.id,sectionId:section.id,beforeThreadId:first.id});
  const scratchProject=await createProject('delete fixture');
  await call('thread/metadata/update',{threadId:second.id,projectId:scratchProject.id});
  await call('project/delete',{projectId:scratchProject.id});report.deletedIDs.projectIds.push(scratchProject.id);save();
  thread=(await call('thread/read',{threadId:second.id})).thread;assert.equal(thread.projectId,null);assert.equal(thread.section.id,section.id);
  await call('thread/metadata/update',{threadId:second.id,projectId:project.id});
  report.projectName='OpenCodex QA organization renamed';await call('project/update',{projectId:project.id,name:report.projectName});
  assert.equal((await call('project/read',{projectId:project.id})).project.name,report.projectName);
  report.tests.push('delete own scratch section/project clears assignment and preserves the other relation');
  const final=await call('thread/list',query);assert.deepEqual(final.data.map(t=>t.id),[second.id,first.id]);
  assert(final.data.every(t=>t.projectId===project.id&&t.section.id===section.id&&t.section.name===report.sectionName));
  report.expectedOrder=[second.id,first.id];report.passed=true;
 }catch(error){report.error=error.stack||String(error);process.exitCode=1;}
 finally{clearTimeout(watchdog);client?.close();save();console.log(JSON.stringify(report));}
})().catch(error=>{report.error=error.stack||String(error);save();console.error(report.error);process.exitCode=1;});
