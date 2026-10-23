'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {UnifiedHandoff}=require('../src/unified-handoff.cjs');
const {GrokCLI,AntigravityCLI,agyModels}=require('../src/external-providers.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-unified-test-'));
let count=0;const test=async(name,fn)=>{await fn();count++;console.log('PASS '+name);};
function provider(id){
 const prefix='opencodex-'+id+':';return {provider:id,connected:true,busy:false,threads:{},claude:{close(){}},newThread:null,
 isModel:m=>typeof m==='string'&&m.startsWith(prefix),models:()=>[{model:prefix+'test'}],
 requested:p=>p?.model||p?.collaborationMode?.settings?.model||null,selectedModel:()=>null,
 effortFor:(_m,e)=>e||null,setDefault(){this.newThread={model:prefix+'test'};},save(){},
 async start(p){this.active=p.threadId;this.busy=true;return {turn:{id:id+'-turn'}};},
 running(t){return this.active===t;},async interrupt(){this.active=null;this.busy=false;return true;},
 steer(){return id;},async flush(){},turns(){return [];},merge:t=>t,completed(){}};
}
(async()=>{try{
 const a=provider('claude'),g=provider('grok'),u=new UnifiedHandoff(a,{root});u.add(g);
 await test('one thread switches providers while Stop still targets the running provider',async()=>{
  await u.start({threadId:'same',model:'opencodex-claude:test'},{});
  const stripped=u.strip('thread/settings/update',{threadId:'same',model:'opencodex-grok:test',effort:'high'});
  assert.equal(stripped.model,undefined);assert.equal(u.selectedModel('same'),'opencodex-grok:test');
  assert.equal(u.steer({threadId:'same'}),'claude');assert.equal(await u.interrupt('same'),true);assert.equal(a.busy,false);
  await u.start({threadId:'same',model:u.selectedModel('same')},{});assert.equal(g.active,'same');await u.interrupt('same');
 });
 await test('only model-only resume bypasses a running workspace lease',()=>{
  assert(u.selectionOnly('thread/resume',{threadId:'same',model:'native',excludeTurns:true}));
  assert(!u.selectionOnly('thread/resume',{threadId:'same',model:'native',cwd:'/other'}));
  assert(!u.selectionOnly('thread/resume',{threadId:'same',model:'native',permissions:':danger-full-access'}));
  assert(!u.selectionOnly('thread/resume',{threadId:'same'}));
 });
 await test('model config remains native while virtual selection survives restart',()=>{
  u.setDefault('grok');const result=u.configWrite('config/batchWrite',{edits:[{keyPath:'model',value:'opencodex-grok:test'},{keyPath:'model_reasoning_effort',value:'high'},{keyPath:'theme',value:'dark'}]});
  assert.deepEqual(result.params.edits,[{keyPath:'theme',value:'dark'}]);assert.equal(u.readConfig({config:{model:'native'}}).config.model,'opencodex-grok:test');
  const restored=new UnifiedHandoff(a,{root});restored.add(g);assert.equal(restored.defaultEngine,'grok');assert.equal(restored.selectedModel('same'),'opencodex-grok:test');
  restored.strip('thread/settings/update',{threadId:'same',model:'native'});assert.equal(restored.selectedModel('same'),'native');assert.equal(restored.isModel('native'),false);
 });
 await test('Grok permission callbacks allow only Mac MCP tools and only during a turn',()=>{
  const c=new GrokCLI({onEvent(){}}),sent=[];c.stream={write:v=>sent.push(JSON.parse(v))};c.busy=true;
  const request=title=>c.receive({id:sent.length+1,method:'session/request_permission',params:{toolCall:{title},options:[{kind:'allow_once',optionId:'once'}]}});
  request('terminal');assert.equal(sent.at(-1).result.outcome.outcome,'cancelled');
  request('mcp__agentbridge_mac__mac_fs_read');assert.equal(sent.at(-1).result.outcome.optionId,'once');
  c.busy=false;request('mcp__agentbridge_mac__mac_fs_read');assert.equal(sent.at(-1).result.outcome.outcome,'cancelled');
 });
 await test('ACP streams preserve text and finish cancellation only once',()=>{
  const events=[],c=new GrokCLI({onEvent:e=>events.push(e)});c.busy=true;c.tools=new Map();c.activeRequestId='turn';
  for(const text of ['hello',' world'])c.receive({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
  c.finish('cancelled');c.finish('completed');assert.equal(events.filter(e=>e.type==='done').length,1);assert.equal(events.findLast(e=>e.type==='message').text,'hello world');
 });
 await test('Antigravity parses only real CLI model identifiers and clears cancel deadline',()=>{
  assert.deepEqual(agyModels('Please login to continue'),[]);
  assert.equal(agyModels('[{"id":"gemini-test","name":"Gemini"}]')[0].displayName,'Gemini');
  assert.equal(agyModels('Available models:\n • gemini-test\n claude-test').length,2);
  const c=new AntigravityCLI({onEvent(){}});c.busy=true;c.cancelTimer=setTimeout(()=>assert.fail('stale cancel callback'),100);c.finish('completed');
 });
 console.log(count+' unified provider tests passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
