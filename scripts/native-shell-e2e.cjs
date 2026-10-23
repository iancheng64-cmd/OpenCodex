'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {rpc}=require('./qa-client.cjs');
(async()=>{
 const evidence=path.join(__dirname,'../evidence'),report={version:'0.4.10',at:new Date().toISOString(),tests:[]};
 let r;
 try{
  const workspace=JSON.parse(fs.readFileSync(path.join(evidence,'native-workspace-e2e.json'),'utf8'));
  assert.equal(workspace.version,'0.4.10');assert.equal(workspace.passed,true);
  const fixture=fs.realpathSync(workspace.fixture),root=fs.realpathSync(evidence)+path.sep;
  assert(fixture.startsWith(root+'workspace-qa-'));assert(fs.existsSync(path.join(fixture,'project-marker.txt')));
  assert.equal(typeof workspace.threadA,'string');report.sourceThreadId=workspace.threadA;
  r=await rpc();await r.call('initialize',{clientInfo:{name:'native-shell-history-qa',version:'0.4.10'}});
  const read=await r.call('thread/read',{threadId:workspace.threadA,includeTurns:true});
  assert.equal(read.thread.cwd,fixture);assert(Array.isArray(read.thread.turns));
  const sourceTurns=read.thread.turns,sourceIds=sourceTurns.map(t=>t.id);
  const shellTurns=sourceTurns.filter(t=>t.items?.some(i=>i.type==='commandExecution'&&i.command.includes('/bin/cat project-marker.txt')));
  assert(shellTurns.length>=2,'workspace QA must have two real Mac shell turns');
  const shellIds=shellTurns.map(t=>t.id);report.shellTurnIds=shellIds;
  assert(sourceIds.some(id=>!shellIds.includes(id)),'workspace QA must include a real remote model turn');
  async function all(method,threadId,extra={}){
   const out=[],seen=new Set();let cursor=null;
   for(let count=0;count<200;count++){
    const page=await r.call(method,{threadId,limit:1,sortDirection:'asc',...extra,cursor});
    assert(Array.isArray(page.data));assert(page.data.length<=1);out.push(...page.data);
    if(!page.nextCursor)return out;
    assert(!seen.has(page.nextCursor),'pagination cursor did not advance');seen.add(page.nextCursor);cursor=page.nextCursor;
   }
   throw Error('QA history exceeded 200 pages');
  }
  const ascending=await all('thread/turns/list',workspace.threadA,{itemsView:'full'});
  assert.deepEqual(ascending.map(t=>t.id),sourceIds);
  const descending=await all('thread/turns/list',workspace.threadA,{itemsView:'full',sortDirection:'desc'});
  assert.deepEqual(descending.map(t=>t.id),sourceIds.slice().reverse());
  const first=await r.call('thread/turns/list',{threadId:workspace.threadA,limit:1,sortDirection:'desc'});
  const reverse=await r.call('thread/turns/list',{threadId:workspace.threadA,limit:1,sortDirection:'asc',cursor:first.backwardsCursor});
  assert.equal(reverse.data[0].id,first.data[0].id);
  report.tests.push('real shell and GPT turns traverse asc/desc one-row pages without duplicates or omissions; reverse cursor includes anchor');
  const items=await all('thread/items/list',workspace.threadA),expectedItems=sourceTurns.flatMap(t=>t.items.map(i=>[t.id,i.id]));
  assert.deepEqual(items.map(e=>[e.turnId,e.item.id]),expectedItems);
  for(const turn of shellTurns){
   const one=await all('thread/items/list',workspace.threadA,{turnId:turn.id});
   assert.deepEqual(one.map(e=>e.item.id),turn.items.map(i=>i.id));
   assert(one.every(e=>e.item.type==='commandExecution'));
   const after=await r.call('thread/items/list',{threadId:workspace.threadA,turnId:turn.id,cursor:{type:'item',itemId:turn.items.at(-1).id},sortDirection:'asc'});
   assert.equal(after.data.length,0);
  }
  report.tests.push('real Mac command cards remain visible in global/per-turn item pages and item anchors are exclusive');
  await assert.rejects(r.call('thread/fork',{threadId:workspace.threadA,lastTurnId:shellIds[0]}),/模型回合/);
  const fork=await r.call('thread/fork',{threadId:workspace.threadA,excludeTurns:true});
  assert(fork.thread.id&&fork.thread.id!==workspace.threadA);assert.equal(fork.thread.cwd,fixture);report.forkThreadId=fork.thread.id;
  assert.deepEqual((await all('thread/turns/list',fork.thread.id,{itemsView:'full'})).map(t=>t.id),sourceIds);
  assert.deepEqual((await all('thread/items/list',fork.thread.id)).map(e=>[e.turnId,e.item.id]),expectedItems);
  assert.deepEqual((await r.call('thread/read',{threadId:workspace.threadA,includeTurns:true})).thread.turns.map(t=>t.id),sourceIds);
  report.tests.push('full fork retains actual shell cards and all remote turns without changing source; synthetic shell cutoff is rejected explicitly');
  if(fork.turnsBackwardsCursor){
   const page=await r.call('thread/turns/list',{threadId:fork.thread.id,cursor:fork.turnsBackwardsCursor,sortDirection:'desc',limit:1});
   assert.equal(page.data[0].id,sourceIds.at(-1));
  }
  if(fork.itemsBackwardsCursor){
   const page=await r.call('thread/items/list',{threadId:fork.thread.id,cursor:fork.itemsBackwardsCursor,sortDirection:'desc',limit:1});
   assert.deepEqual([page.data[0].turnId,page.data[0].item.id],expectedItems.at(-1));
  }
  report.turnCount=sourceIds.length;report.itemCount=items.length;report.passed=true;
 }catch(e){report.passed=false;report.error=e.stack;process.exitCode=1;}
 finally{r?.close();fs.writeFileSync(path.join(evidence,'native-shell-e2e.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
})().catch(e=>{console.error(e.stack);process.exit(1)}).finally(()=>process.exit(process.exitCode||0));
