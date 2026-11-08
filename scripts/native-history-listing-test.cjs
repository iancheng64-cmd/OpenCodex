'use strict';
// History stays available: every host's cached conversations list offline and beside a connected
// host, and a cached conversation opens even when the renderer kept a live-engine cursor.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const routing=require('../src/native-routing.cjs'),{NativeOrganization}=require('../src/native-organization.cjs'),{NativeShell}=require('../src/native-shell.cjs');
const tests=[];
async function test(name,fn){await fn();tests.push(name);}
const summary=(id,profile,updatedAt,extra={})=>({profile,summary:{id,preview:'conversation '+id,updatedAt,createdAt:updatedAt,cwd:'/w'},...extra});
const known={a1:summary('a1','A',30),a2:summary('a2','A',10),b1:summary('b1','B',20),b2:summary('b2','B',40,{deleted:true}),c1:summary('c1','C',5,{archived:true})};
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ocx-history-listing-'));
 try{
  await test('cachedPage scopes: own, others and all, current host sorted with the rest by recency',async()=>{
   assert.deepEqual(routing.cachedPage('thread/list',{},known,'A').data.map(t=>t.id),['a1','a2']);
   assert.deepEqual(routing.cachedPage('thread/list',{},known,'A',{scope:'others'}).data.map(t=>t.id),['b1']);
   assert.deepEqual(routing.cachedPage('thread/list',{},known,'A',{scope:'all'}).data.map(t=>t.id),['a1','b1','a2']);
   assert.deepEqual(routing.cachedPage('thread/list',{archived:true},known,'A',{scope:'all'}).data.map(t=>t.id),['c1']);
   assert.deepEqual(routing.cachedPage('thread/search',{searchTerm:'B1'},known,'A',{scope:'all'}).data.map(r=>r.thread.id),['b1']);
   assert.deepEqual(routing.cachedAll('thread/list',{limit:1},known,'A',{scope:'all'}).map(t=>t.id),['a1','b1','a2']);
  });
  await test('cached rows look like engine rows and answer sub-agent discovery filters',async()=>{
   const k={...known,s1:{profile:'A',summary:{id:'s1',preview:'child',updatedAt:31,createdAt:31,cwd:'/w',threadSource:'subagent',parentThreadId:'a1',source:'vscode'}},s2:{profile:'A',summary:{id:'s2',preview:'grandchild',updatedAt:32,createdAt:32,cwd:'/w',threadSource:'subagent',parentThreadId:'s1',source:'vscode'}},tt:{profile:'A',summary:{id:'tt',preview:'',updatedAt:33,createdAt:33,cwd:'/w',threadSource:'thread_title',ephemeral:true}}};
   const general=routing.cachedPage('thread/list',{},k,'A');
   assert.deepEqual(general.data.map(t=>t.id),['a1','a2'],'sub-agent and title threads stay out of the plain list');
   assert.ok(general.data.every(t=>Array.isArray(t.turns)&&t.turns.length===0),'every cached row carries turns:[]');
   assert.deepEqual(routing.cachedPage('thread/list',{parentThreadId:'a1',sourceKinds:['subAgentThreadSpawn'],archived:false,sortKey:'created_at',sortDirection:'desc'},k,'A').data.map(t=>t.id),['s1']);
   assert.deepEqual(routing.cachedPage('thread/list',{ancestorThreadId:'a1',sourceKinds:['subAgentThreadSpawn']},k,'A').data.map(t=>t.id),['s2','s1']);
   assert.deepEqual(routing.cachedPage('thread/list',{sourceKinds:['vscode','cli']},k,'A').data.map(t=>t.id),['a1','a2']);
   assert.equal(routing.generalListing({}),true);assert.equal(routing.generalListing({sourceKinds:['vscode']}),true);
   assert.equal(routing.generalListing({parentThreadId:'a1',sourceKinds:['subAgentThreadSpawn']}),false);assert.equal(routing.generalListing({ancestorThreadId:'a1'}),false);
  });
  await test('the organization join keeps other hosts out unless asked, then lists them read-only',async()=>{
   const org=new NativeOrganization(path.join(dir,'org.json'),{localRequest:async()=>({data:[]}),owns:(p,id)=>known[id]?.profile===p&&!known[id].deleted,foreign:id=>!!known[id]?.summary&&!known[id].deleted});
   const fetch=query=>routing.cachedPage('thread/list',query,known,'A',{scope:'all'});
   assert.deepEqual((await org.listPage('A','thread/list',{},fetch)).data.map(t=>t.id),['a1','a2']);
   const page=await org.listPage('A','thread/list',{},fetch,{foreign:true});
   assert.deepEqual(page.data.map(t=>t.id),['a1','b1','a2']);
   assert.equal(page.data.find(t=>t.id==='b1').projectId,null);
   const merged=await org.listPage('A','thread/list',{},async query=>{const live={data:[{id:'a1',preview:'live a1',updatedAt:30,createdAt:30,cwd:'/w'}],nextCursor:null};if(!query.cursor)live.data.push(...routing.cachedAll('thread/list',query,known,'A',{scope:'others'}));return live;},{foreign:true});
   assert.deepEqual(merged.data.map(t=>t.id),['a1','b1']);
   assert.equal(merged.data[0].preview,'live a1');
  });
  await test('a cached conversation serves its pages from the head when the renderer sends a live-engine cursor',async()=>{
   const shell=new NativeShell({file:path.join(dir,'shell.json'),ready:async()=>{},getRpc:()=>null,emit(){},onError(){}});
   const turn=i=>({id:'t'+i,status:'completed',items:[{id:'i'+i,type:'userMessage',content:[]}],itemsView:'full'});
   const cached={id:'x',turns:[turn(1),turn(2),turn(3)]};
   const engineCursor='eyJhbGciOi.engine.cursor';
   const page=await shell.listCached('thread/turns/list',{threadId:'x',cursor:engineCursor,limit:2,sortDirection:'asc'},cached,{complete:true});
   assert.deepEqual(page.data.map(t=>t.id),['t1','t2']);assert(page.nextCursor.startsWith('ocsh1.'));
   const next=await shell.listCached('thread/turns/list',{threadId:'x',cursor:page.nextCursor,limit:2,sortDirection:'asc'},cached,{complete:true});
   assert.deepEqual(next.data.map(t=>t.id),['t3']);assert.equal(next.nextCursor,null);
   const items=await shell.listCached('thread/items/list',{threadId:'x',turnId:'t2',cursor:engineCursor,limit:10},cached,{complete:true});
   assert.deepEqual(items.data.map(r=>r.item.id),['i2']);
   await assert.rejects(shell.listCached('thread/turns/list',{threadId:'x',cursor:'ocsh1.bad.cursor'},cached,{complete:true}),/游標/);
   await assert.rejects(shell.listCached('thread/turns/list',{threadId:'x'},cached,{complete:false}),/完整歷史/);
  });
  const report={version:'0.4.15',at:new Date().toISOString(),passed:true,tests};
  fs.writeFileSync(path.join(__dirname,'../evidence/native-history-listing-unit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
