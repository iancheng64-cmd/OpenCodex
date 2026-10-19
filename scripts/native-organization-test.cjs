'use strict';
// Regression tests use a mock local app-server plus a real temporary file.
// They do not establish native UI or SSH end-to-end acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {NativeOrganization}=require('../src/native-organization.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-organization-')),file=path.join(dir,'organization.json');
const sections=new Map(),projects=new Map(),calls=[],events=[],allowed=new Map([['host-a',new Set(['one','two','three'])],['host-b',new Set(['one'])]]);
let serial=0;
const options={
 owns:(profile,thread)=>allowed.get(profile)?.has(thread),
 notify:(profile,message)=>events.push({profile,message}),
 clock:()=>1234,
 localRequest:async(method,params)=>{
  calls.push({method,params:structuredClone(params)});
  if(method==='threadSection/list')return {data:[...sections.values()],nextCursor:null};
  if(method==='threadSection/create'){const section={id:'section-'+ ++serial,name:params.name,appearance:params.appearance??null};sections.set(section.id,section);return {section};}
  if(method==='threadSection/update'){
   const old=sections.get(params.sectionId);if(!old)throw Error('not found');
   const section={...old,name:params.name};if(Object.hasOwn(params,'appearance'))section.appearance=params.appearance;sections.set(section.id,section);return {section};
  }
  if(method==='threadSection/delete'){sections.delete(params.sectionId);return {};}
  if(method==='project/create'||method==='project/import'){
   assert(!Object.hasOwn(params,'threads'),'Remote thread IDs must not reach the native Mac DB');
   const project={id:'project-'+ ++serial,name:params.name,roots:params.roots||[],metadata:params.metadata||{},position:serial,createdAt:1,updatedAt:1,recencyAt:null};
   projects.set(project.id,project);return {project};
  }
  if(method==='project/read'){if(!projects.has(params.projectId))throw Error('not found');return {project:projects.get(params.projectId)};}
  if(method==='project/list')return {data:[...projects.values()],nextCursor:null};
  if(method==='project/update'){const project={...projects.get(params.projectId),...params,id:params.projectId};projects.set(project.id,project);return {project};}
  if(method==='project/delete'){projects.delete(params.projectId);return {};}
  throw Error('unexpected local RPC '+method);
 }
};
let checks=0;const test=async(name,run)=>{await run();checks++;console.log('PASS '+name);};
(async()=>{
 let org=new NativeOrganization(file,options),section,project;
 await test('native entities retained; thread membership stays local',async()=>{
  section=(await org.request('host-a','threadSection/create',{name:'First',appearance:{color:'red'}})).section;
  await org.request('host-a','thread/section/move',{threadId:'one',sectionId:section.id});
  assert.equal(org.projectThread('host-a',{id:'one',section:{id:'peer'},projectId:'peer'}).section.name,'First');
  assert.equal(org.projectThread('host-b',{id:'one'}).section,null);
  assert.equal(calls.filter(c=>c.method==='thread/section/move').length,0);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
 });
 await test('insert before, native sort directions, and ordering survives restart',async()=>{
  await org.request('host-a','thread/section/move',{threadId:'two',sectionId:section.id,beforeThreadId:'one'});
  await assert.rejects(org.request('host-a','thread/section/move',{threadId:'one',sectionId:section.id,beforeThreadId:'one'}),/自己之前/);
  org=new NativeOrganization(file,options);
  const rows=await org.listPage('host-a','thread/list',{sectionId:section.id,sortKey:'section_position',sortDirection:'asc'},async query=>{
   assert(!Object.hasOwn(query,'sectionId'));assert(!Object.hasOwn(query,'projectId'));assert.equal(query.sortKey,'created_at');
   return {data:[{id:'one'},{id:'three'},{id:'two'}],nextCursor:null};
  });
  assert.deepEqual(rows.data.map(x=>x.id),['two','one']);assert.equal(rows.data[0].sectionEnteredAt,1234);
  // Verified against the bundled real native app-server: default equals ASC.
  for(const sortDirection of ['desc',undefined]){
   const ordered=await org.listPage('host-a','thread/list',{sectionId:section.id,sortKey:'section_position',sortDirection},async()=>({data:[{id:'two'},{id:'one'}]}));
   assert.deepEqual(ordered.data.map(x=>x.id),sortDirection==='desc'?['one','two']:['two','one']);
  }
 });
 await test('section rename and appearance clear project into all reads',async()=>{
  await org.request('host-a','threadSection/update',{sectionId:section.id,name:'Renamed',appearance:null});
  const result=org.projectResult('host-a',{thread:{id:'one'},model:'untouched'});
  assert.equal(result.thread.section.name,'Renamed');assert.equal(result.thread.section.appearance,null);assert.equal(result.model,'untouched');
 });
 await test('no-profile offline startup is empty; remote notifications retain local joins',async()=>{
  const empty=await org.listPage(undefined,'thread/list',{},async()=>{throw Error('unexpected remote fetch');});
  assert.deepEqual(empty,{data:[],backwardsCursor:null,nextCursor:null});
  assert.equal(org.projectThread(null,{id:'one',projectId:'remote'}).projectId,null);
  const started=org.projectNotification('host-a',{method:'thread/started',params:{thread:{id:'one',section:{id:'remote'}}}});
  assert.equal(started.params.thread.section.name,'Renamed');
  assert.equal(org.projectNotification('host-a',{method:'thread/project/updated',params:{threadId:'one',projectId:'remote'}}).params.projectId,null);
  const unrelated={method:'turn/completed',params:{threadId:'one'}};assert.equal(org.projectNotification('host-a',unrelated),unrelated);
 });
 await test('moves validate ownership and destination without corrupting state',async()=>{
  const before=fs.readFileSync(file,'utf8');
  await assert.rejects(org.request('host-b','thread/section/move',{threadId:'two',sectionId:section.id}),/不屬於/);
  await assert.rejects(org.request('host-a','thread/section/move',{threadId:'one',sectionId:section.id,beforeThreadId:'three'}),/同一分類/);
  assert.equal(fs.readFileSync(file,'utf8'),before);
 });
 await test('project import joins remote threads locally, emits update and validates ownership',async()=>{
  project=(await org.request('host-a','project/import',{name:'Project',roots:[{path:'/Users/test/project'}],idempotencyKey:'fixture',threads:['one','two']})).project;
  assert.equal(org.projectThread('host-a',{id:'one'}).projectId,project.id);
  assert.equal(org.projectThread('host-b',{id:'one',projectId:project.id}).projectId,null);
  assert.deepEqual(events.map(e=>e.message.params.threadId),['one','two']);
  const n=calls.length;await assert.rejects(org.request('host-b','project/import',{name:'invalid',threads:['two']}),/不屬於/);assert.equal(calls.length,n);
 });
 await test('start strips local project UUID and fork inherits project; ephemeral joins stay memory-only',async()=>{
  const original={projectId:project.id,cwd:'/Users/test/project'};
  const clean=await org.prepareThread('host-a','thread/start',original);assert(!Object.hasOwn(clean,'projectId'));assert.equal(original.projectId,project.id);
  assert.equal(org.captureThread('host-a','thread/start',original,{id:'three'}).projectId,project.id);
  assert.equal(org.captureThread('host-a','thread/fork',{threadId:'three'},{id:'fork'}).projectId,project.id);
  const old=fs.readFileSync(file,'utf8');assert.equal(org.captureThread('host-a','thread/start',original,{id:'ephemeral',ephemeral:true}).projectId,project.id);assert.equal(fs.readFileSync(file,'utf8'),old);
  await assert.rejects(org.prepareThread('host-a','thread/start',{projectId:'missing'}),/not found/);
 });
 await test('metadata project assignment validates local ID, preserves sections, clears with empty string and survives restart',async()=>{
  const original={threadId:'one',projectId:project.id};
  assert.equal(org.remoteMethod('thread/metadata/update',original),'thread/read');
  assert.deepEqual(await org.prepareThread('host-a','thread/metadata/update',original),{threadId:'one'});
  assert.equal(org.captureThread('host-a','thread/metadata/update',original,{id:'one'}).projectId,project.id);
  assert.equal(org.projectThread('host-a',{id:'one'}).section.id,section.id);
  const updated={threadId:'one',projectId:'',gitInfo:{branch:'fixture'}};
  assert.equal(org.remoteMethod('thread/metadata/update',updated),'thread/metadata/update');
  const clean=await org.prepareThread('host-a','thread/metadata/update',updated);assert.deepEqual(clean,{threadId:'one',gitInfo:{branch:'fixture'}});
  // A rejected remote operation never reaches captureThread, so preparation cannot change assignment.
  assert.equal(org.projectThread('host-a',{id:'one'}).projectId,project.id);
  assert.equal(org.captureThread('host-a','thread/metadata/update',updated,{id:'one'}).projectId,null);
  assert.equal(new NativeOrganization(file,options).projectThread('host-a',{id:'one'}).projectId,null);
  const n=events.length;org.captureThread('host-a','thread/metadata/update',{threadId:'one',projectId:null},{id:'one'});assert.equal(events.length,n);
  await assert.rejects(org.prepareThread('host-b','thread/metadata/update',{threadId:'two',projectId:project.id}),/不屬於/);
  await assert.rejects(org.prepareThread('host-a','thread/metadata/update',{threadId:'one',projectId:'peer-id'}),/not found/);
  assert.throws(()=>org.captureThread('host-a','thread/metadata/update',original,{id:'two'}),/識別碼不符/);
  org.captureThread('host-a','thread/metadata/update',original,{id:'one'});
  assert.equal(events.at(-1).message.params.projectId,project.id);
 });
 await test('project/section filtering and pagination collect all upstream pages',async()=>{
  const inputs=[];
  const fetch=async q=>{inputs.push(q);return q.cursor?{data:[{id:'three',createdAt:3},{id:'foreign',createdAt:0}],nextCursor:null}:{data:[{id:'one',createdAt:1},{id:'two',createdAt:2}],nextCursor:'remote-next'};};
  const query={projectId:project.id,sectionId:null,limit:1,sortKey:'created_at',sortDirection:'asc'};
  let result=await org.listPage('host-a','thread/list',query,fetch);assert.deepEqual(result.data.map(t=>t.id),['three']);assert.equal(result.nextCursor,null);
  const all={projectId:project.id,limit:1,sortKey:'created_at',sortDirection:'asc'};
  result=await org.listPage('host-a','thread/list',all,fetch);assert.deepEqual(result.data.map(t=>t.id),['one']);assert(result.nextCursor);
  const cursor=result.nextCursor;
  result=await org.listPage('host-a','thread/list',{...all,cursor},fetch);assert.deepEqual(result.data.map(t=>t.id),['two']);
  await assert.rejects(org.listPage('host-b','thread/list',{...all,cursor},fetch),/重新整理/);
  assert(inputs.every(q=>!Object.hasOwn(q,'projectId')&&!Object.hasOwn(q,'sectionId')));
 });
 await test('search wrappers preserved; upstream cursor loops are rejected',async()=>{
  const page=await org.listPage('host-a','thread/search',{sectionId:section.id},async()=>({data:[{thread:{id:'one'},snippet:'Exact hit'}]}));
  assert.equal(page.data[0].snippet,'Exact hit');assert.equal(page.data[0].thread.section.name,'Renamed');
  await assert.rejects(org.listPage('host-a','thread/list',{},async()=>({data:[],nextCursor:'loop'})),/重複/);
 });
 await test('project recency uses SSH members and keeps empty projects last',async()=>{
  org.getThreads=profile=>profile==='host-a'?[{summary:{id:'one',recencyAt:8}},{summary:{id:'two',recencyAt:99},archived:true},{summary:{id:'three',updatedAt:7}}]:[];
  const empty=(await org.request('host-a','project/create',{name:'empty'})).project;
  const list=await org.request('host-a','project/list',{sortKey:'recencyAt',sortDirection:'asc',limit:1});
  assert.equal(list.data[0].id,project.id);assert.equal(list.data[0].recencyAt,8);assert(list.nextCursor);
  const last=await org.request('host-a','project/list',{sortKey:'recencyAt',sortDirection:'asc',limit:1,cursor:list.nextCursor});assert.equal(last.data[0].id,empty.id);assert.equal(last.data[0].recencyAt,null);
  assert.equal((await org.request('host-b','project/read',{projectId:project.id})).project.recencyAt,null);
  await assert.rejects(org.request('host-b','project/list',{sortKey:'recencyAt',sortDirection:'asc',cursor:list.nextCursor}),/重新整理/);
 });
 await test('section delete removes membership while project delete clears assignment across profiles',async()=>{
  await org.request('host-b','thread/section/move',{threadId:'one',sectionId:section.id});
  await org.request('host-a','threadSection/delete',{sectionId:section.id});
  assert.equal(org.projectThread('host-a',{id:'one'}).section,null);assert.equal(org.projectThread('host-b',{id:'one'}).section,null);
  await org.request('host-a','project/delete',{projectId:project.id});
  assert.equal(org.projectThread('host-a',{id:'one'}).projectId,null);
  assert.equal(new NativeOrganization(file,options).projectThread('host-a',{id:'three'}).projectId,null);
 });
 await test('external catalog deletion, removed threads, corrupt files, and failed writes fail safely',async()=>{
  section=(await org.request('host-a','threadSection/create',{name:'external'})).section;
  await org.request('host-a','thread/section/move',{threadId:'one',sectionId:section.id});
  org.removeThread('host-a','one');assert.equal(org.projectThread('host-a',{id:'one'}).section,null);
  await org.request('host-a','thread/section/move',{threadId:'two',sectionId:section.id});sections.delete(section.id);
  await org.request('host-a','threadSection/list',{});assert.equal(org.projectThread('host-a',{id:'two'}).section,null);
  const bad=path.join(dir,'bad.json');fs.writeFileSync(bad,'{incomplete');assert.throws(()=>new NativeOrganization(bad,options),/原始檔案已保留/);assert.equal(fs.readFileSync(bad,'utf8'),'{incomplete');
  const snapshot=structuredClone(org.state),realRename=fs.renameSync;fs.renameSync=()=>{throw Error('disk fixture');};
  try{assert.throws(()=>org.transaction(s=>s.sections.fake={id:'fake'}),/disk fixture/);assert.deepEqual(org.state,snapshot);}
  finally{fs.renameSync=realRename;}
 });
 console.log(JSON.stringify({passed:true,checks,scope:'mock native RPC and temporary filesystem; no live UI/SSH acceptance'}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(dir,{recursive:true,force:true}));
