'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {NativeHistory,snapshotOptions}=require('../src/native-history.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-history-')),errors=[];
try{
 let cache=new NativeHistory(dir,{onError:e=>errors.push(e)});
 const result={cwd:'/Users/test/project',model:'test',thread:{id:'thread/one',cwd:'/Users/test/project',turns:[{id:'turn1',status:'completed',items:[{type:'agentMessage',text:'retained'}]}]}};
 assert(cache.set('thread/one',result,'profileA',{complete:true}));
 result.thread.turns.length=0;
 cache=new NativeHistory(dir,{onError:e=>errors.push(e)});
 assert.equal(cache.get('thread/one','profileA').thread.turns[0].items[0].text,'retained');
 assert.equal(cache.get('thread/one','profileB'),undefined);
 const a=cache.get('thread/one','profileA');a.thread.turns.length=0;
 assert.equal(cache.get('thread/one','profileA').thread.turns.length,1);
 assert(cache.set('thread/one',{thread:{id:'thread/one',name:'renamed',turns:[]}},'profileA',{summaryOnly:true}));
 assert.equal(cache.get('thread/one','profileA').model,'test');
 assert.equal(cache.get('thread/one','profileA').thread.turns.length,1);
 assert(cache.set('thread/one',{thread:{id:'thread/one',turns:[{id:'turn2'}]}},'profileB'));
 assert.equal(cache.get('thread/one','profileB').thread.turns[0].id,'turn2');
 assert.equal(cache.get('thread/one','profileA').openCodexHistoryComplete,true,'explicit proof persists across restart and summary updates');
 assert.equal(cache.get('thread/one','profileB').openCodexHistoryComplete,false,'new turns need explicit full-history proof');
 assert(cache.set('thread/one',{openCodexHistoryComplete:false,thread:{id:'thread/one',name:'metadata only'}},'profileA'));
 assert.equal(cache.get('thread/one','profileA').openCodexHistoryComplete,true,'missing turns preserve prior proof');
 assert(cache.set('first-summary',{openCodexHistoryComplete:true,thread:{id:'first-summary',turns:[]}},'profileA',{summaryOnly:true,complete:true}));
 assert.equal(cache.get('first-summary','profileA').openCodexHistoryComplete,false,'first summary cannot prove an empty history');
 assert(cache.set('first-metadata',{openCodexHistoryComplete:true,thread:{id:'first-metadata'}},'profileA',{complete:true}));
 assert.equal(cache.get('first-metadata','profileA').openCodexHistoryComplete,false,'no turns cannot establish proof');
 assert(cache.set('replace',{thread:{id:'replace',turns:[]}},'profileA',{complete:true}));
 assert.equal(cache.get('replace','profileA').openCodexHistoryComplete,true,'explicitly complete empty history is valid');
 assert(cache.set('replace',{openCodexHistoryComplete:true,thread:{id:'replace',turns:[{id:'partial'}]}},'profileA'));
 assert.equal(cache.get('replace','profileA').openCodexHistoryComplete,false,'new unproven turns invalidate prior proof and response cannot forge it');
 // Exercise the exact request policy used by bootstrap, then reload from disk.
 for(const id of ['parent','child']){
  const thread={id,parentThreadId:id==='child'?'parent':null,turns:[{id:'turn-'+id,itemsView:'full',items:[{type:id==='parent'?'subAgentActivity':'mcpToolCall',agentThreadId:'child',kind:'started',status:'completed',result:{marker:'retained'}}]}]};
  cache.set(id,{thread},'profileA',snapshotOptions('thread/read',{includeTurns:true}));
  cache.set(id,{thread:{id,name:'restored',turns:[]}},'profileA',snapshotOptions('thread/resume',{excludeTurns:true}));
  const persisted=new NativeHistory(dir).get(id,'profileA');
  assert.deepEqual(persisted.thread.turns,thread.turns);
  assert.equal(persisted.thread.name,'restored');assert.equal(persisted.openCodexHistoryComplete,true);
 }
 cache.set('excluded-fork',{thread:{id:'excluded-fork',turns:[]}},'profileA',snapshotOptions('thread/fork',{excludeTurns:true}));
 assert.equal(new NativeHistory(dir).get('excluded-fork','profileA').openCodexHistoryComplete,false);
 cache.set('parent',{thread:{id:'parent',turns:[]}},'profileA',snapshotOptions('thread/resume',{excludeTurns:false}));
 assert.deepEqual(new NativeHistory(dir).get('parent','profileA').thread.turns,[],'an explicitly full empty response replaces previous history');
 assert.equal(snapshotOptions('thread/revert').complete,false,'reverted history awaits full refresh');
 assert(cache.set('legacy',{thread:{id:'legacy',turns:[]}},'profileA',{complete:true}));
 const legacyFile=path.join(dir,cache.key('legacy','profileA')+'.json'),legacy=JSON.parse(fs.readFileSync(legacyFile,'utf8'));delete legacy.result.openCodexHistoryComplete;fs.writeFileSync(legacyFile,JSON.stringify(legacy));
 assert.equal(new NativeHistory(dir).get('legacy','profileA').openCodexHistoryComplete,false,'old v1 caches are incomplete until refreshed');
 assert.throws(()=>cache.set('wrong',result,'profileA'));
 assert.throws(()=>cache.get('thread/one',undefined));
 for(const entry of fs.readdirSync(dir)){assert(/^[a-f0-9]{64}\.json$/.test(entry));assert.equal(fs.statSync(path.join(dir,entry)).mode&0o777,0o600);}
 const filename=path.join(dir,cache.key('thread/one','profileA')+'.json');
 fs.writeFileSync(filename,'corrupt');cache=new NativeHistory(dir,{onError:e=>errors.push(e)});
 assert.equal(cache.get('thread/one','profileA'),undefined);assert.equal(errors.length,1);
 cache.delete('thread/one','profileB');assert.equal(new NativeHistory(dir).get('thread/one','profileB'),undefined);
 console.log('PASS restart persistence, profile isolation, clone safety, summary merge, explicit full-snapshot proof, empty/partial/legacy cache semantics, corrupt-cache rejection, private files and deletion');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
