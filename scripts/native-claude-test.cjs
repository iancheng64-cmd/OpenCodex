'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {NativeClaude}=require('../src/native-claude.cjs'),{ApprovalGrants}=require('../src/native-approvals.cjs');
const {patchClaudeBackend,patchClaudeRuntime}=require('./claude-patches.cjs');
const Ajv=require('../build/OpenCodex.app/Contents/Resources/agentbridge/app/node_modules/ajv');
const ajv=new Ajv({strict:false,allErrors:true,formats:{int32:true,int64:true,uint16:true,uint32:true,uint64:true,uint:true}}),validators=new Map(),tests=[],fixtureRoots=new Set();
function validate(name,value){if(!validators.has(name)){const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../build/native-protocol/v2',name+'.json')));validators.set(name,ajv.compile(schema));}const v=validators.get(name);assert(v(value),JSON.stringify(v.errors));}
function setup(root=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-claude-unit-'))){
 fixtureRoots.add(root);
 const events=[],sent=[],calls=[],errors=[],steered=[],settings={profileId:'profile-a',cwd:root,permissionMode:'project',fullAccess:false};
 const cli={id:'runtime-a',busy:false,status:()=>({runtimeVersion:'test',account:{authenticated:true,verified:true},models:[{id:'default',model:'default',displayName:'Claude',description:'test',isDefault:true,supportedReasoningEfforts:[]}]}),send:async input=>{sent.push(input);cli.busy=true;},steer:content=>{steered.push(content);return {requestId:'runtime-a'};},refreshAccount:async()=>{}};
 const runtime={cli,host:{status:()=>({ok:true}),listTools:()=>[],entries:new Map()},cwd:root,network:{profileId:'profile-a',hostFingerprint:'SHA256:test'},hostKey:'host-a',hostName:'Test',pending:new Map(),permissionMode:'project',closed:false};
 const a=new NativeClaude({root,settings,saveSettings:()=>{},invoke:async(name,...args)=>{calls.push([name,...args]);if(name==='claude:permission')runtime.permissionMode=args[1];if(name==='claude:cancel'){cli.busy=false;a.event({type:'done',runtimeId:cli.id,requestId:args[1],status:'cancelled'});}},emit:m=>events.push(m),onState:()=>{},selectWorkspace:async(r,cwd)=>r.cwd=cwd,refreshTools:async()=>{},forwardRequest:()=>false,grants:new ApprovalGrants(path.join(root,'grants.json')),showApproval:async()=>({response:2}),onError:e=>errors.push(e.message)});
 a.attach(runtime,{});return {a,runtime,cli,root,settings,events,sent,steered,calls,errors,finish:()=>{cli.busy=false;a.event({type:'done',runtimeId:cli.id,status:'completed'});},close:()=>a.close()};
}
async function test(name,fn){await fn();tests.push({name,passed:true});console.log('PASS '+name);}
(async()=>{
 await test('vendor patch is exact, idempotent and fails closed on a changed boundary',async()=>{const code=fs.readFileSync(path.join(__dirname,'../vendor/agentbridge/dist-main/claude-local-backend.js'),'utf8'),patched=patchClaudeBackend(code);assert.equal(patchClaudeBackend(patched),patched);assert.throws(()=>patchClaudeBackend(code.replace('const runtimes = new Map();','const other = new Map();')));
  const runtime=fs.readFileSync(path.join(__dirname,'../vendor/agentbridge/dist-main/claude-local-runtime.js'),'utf8'),steerable=patchClaudeRuntime(runtime);assert.equal(patchClaudeRuntime(steerable),steerable);assert.match(steerable,/steer\(content\) \{/);assert.throws(()=>patchClaudeRuntime(runtime.replace('    async sendAndWait(input) {','    async sendAndWaitChanged(input) {')));});
 await test('steering a running turn stays in the same Claude process and native turn',async()=>{
  const f=setup();try{
   const id=(await f.a.request('thread/start',{})).thread.id;
   await assert.rejects(f.a.request('turn/steer',{threadId:id,input:[{type:'text',text:'太早'}]}),/no active turn to steer/);
   const started=await f.a.request('turn/start',{threadId:id,input:[{type:'text',text:'開始',text_elements:[]}]});
   await assert.rejects(f.a.request('turn/steer',{threadId:id,expectedTurnId:'other',input:[{type:'text',text:'x'}]}),/expected active turn id `other` but found `/);
   const steered=await f.a.request('turn/steer',{threadId:id,expectedTurnId:started.turn.id,clientUserMessageId:'c2',input:[{type:'text',text:'補充說明',text_elements:[]}],additionalContext:'背景'});
   validate('TurnSteerResponse',steered);assert.equal(steered.turnId,started.turn.id);
   assert.equal(f.steered.length,1);assert.deepEqual(f.steered[0].map(c=>c.text),['補充說明','背景']);assert.equal(f.sent.length,1,'no second Claude turn is started');
   assert.deepEqual(f.events.filter(m=>m.method==='item/completed'&&m.params.item.type==='userMessage').map(m=>m.params.item.content[0].text),['開始','補充說明']);
   f.finish();
   const history=await f.a.request('thread/read',{threadId:id,includeTurns:true});validate('ThreadReadResponse',history);
   assert.equal(history.thread.turns.length,1);assert.deepEqual(history.thread.turns[0].items.filter(i=>i.type==='userMessage').map(i=>i.clientId),[null,'c2']);
   await assert.rejects(f.a.request('turn/steer',{threadId:id,input:[{type:'text',text:'晚了'}]}),/no active turn to steer/);
   await f.a.request('review/start',{threadId:id,target:{type:'uncommittedChanges'}});
   await assert.rejects(f.a.request('turn/steer',{threadId:id,input:[{type:'text',text:'審查中'}]}),/cannot steer a review turn/);
   assert.equal(f.steered.length,1);f.finish();
  }finally{f.close();}
 });
 await test('real native protocol schemas accept model, thread and streaming tool results',async()=>{
  const f=setup();try{
   validate('ModelListResponse',await f.a.request('model/list'));
   const started=await f.a.request('thread/start',{cwd:f.root,permissions:':workspace'});validate('ThreadStartResponse',started);const id=started.thread.id;
   const response=await f.a.request('turn/start',{threadId:id,input:[{type:'text',text:'test',text_elements:[]}]});validate('TurnStartResponse',response);
   const event=value=>f.a.event({runtimeId:f.cli.id,requestId:response.turn.id,...value});
   event({type:'message',text:'one'});event({type:'message',text:'one two'});
   event({type:'tool',itemId:'tool1',tool:'mac_fs_read',status:'running'});
   event({type:'tool',itemId:'tool1',status:'running',text:'{"path":"/test"}'});
   event({type:'tool',itemId:'tool1',status:'completed',text:'result',image:'data:image/png;base64,AAAA'});
   event({type:'session',conversationId:'remote-session'});f.finish();
   const history=await f.a.request('thread/read',{threadId:id,includeTurns:true});validate('ThreadReadResponse',history);
   assert.equal(history.thread.turns[0].items.find(i=>i.type==='mcpToolCall').arguments.path,'/test');
   assert.equal(history.thread.turns[0].items.find(i=>i.type==='mcpToolCall').result.content[1].mimeType,'image/png');
   assert.equal(f.events.filter(m=>m.method==='item/agentMessage/delta').map(m=>m.params.delta).join(''),'one two');
   f.close();const next=setup(f.root);try{const resumed=await next.a.request('thread/resume',{threadId:id});validate('ThreadResumeResponse',resumed);await next.a.request('turn/start',{threadId:id,input:[{type:'text',text:'next',text_elements:[]}]});assert.equal(next.sent[0].conversationId,'remote-session');next.finish();}finally{next.close();}
  }finally{f.close();}
 });
 await test('Stop during tool preparation never sends a message',async()=>{
  const f=setup();try{const id=(await f.a.request('thread/start',{})).thread.id;let release;const gate=new Promise(r=>release=r);let entered=false;f.a.refreshTools=async()=>{entered=true;await gate;};const start=f.a.request('turn/start',{threadId:id,input:[{type:'text',text:'cancel'}]});while(!entered)await new Promise(r=>setImmediate(r));await f.a.request('turn/interrupt',{threadId:id});release();await assert.rejects(start,/取消/);assert.equal(f.sent.length,0);assert.equal(f.a.busy,false);}finally{f.close();}
 });
 await test('active Stop yields an interrupted native turn and no replay',async()=>{
  const f=setup();try{const id=(await f.a.request('thread/start',{})).thread.id;await f.a.request('turn/start',{threadId:id,input:[{type:'text',text:'stop'}]});await f.a.request('turn/interrupt',{threadId:id});assert.equal(f.a.entry(id).thread.turns[0].status,'interrupted');assert.equal(f.sent.length,1);assert.equal(f.a.busy,false);}finally{f.close();}
 });
 await test('host fingerprint isolates history and persisted highest access overrides thread profile',async()=>{
  const f=setup();try{f.settings.fullAccess=true;const r=await f.a.request('thread/start',{permissions:':read-only'});assert.equal(f.runtime.permissionMode,'full');assert.equal(r.sandbox.type,'dangerFullAccess');f.runtime.network.hostFingerprint='other';await assert.rejects(f.a.request('thread/read',{threadId:r.thread.id}),/主機/);assert.equal((await f.a.request('thread/list')).data.length,0);}finally{f.close();}
 });
 await test('permanent tool permission is scoped and bypasses only a matching pending request',async()=>{
  const f=setup();try{const id=(await f.a.request('thread/start',{permissions:':read-only'})).thread.id;await f.a.request('turn/start',{threadId:id,input:[{type:'text',text:'approve'}]});f.runtime.host.entries.set('mac_fs_write',{tool:{inputSchema:{type:'object'}}});f.runtime.pending.set('a',{toolName:'mac_fs_write'});await f.a.approval({type:'approval',approvalId:'a'});assert.equal(f.a.grants.list().length,1);f.a.showApproval=()=>{throw Error('must not prompt twice');};await f.a.approval({type:'approval',approvalId:'a'});assert.equal(f.calls.filter(c=>c[0]==='claude:respond'&&c[1].decision==='accept').length,2);f.finish();}finally{f.close();}
 });
 await test('connection loss settles a running turn and hides executor readiness',async()=>{
  const f=setup();try{const id=(await f.a.request('thread/start',{})).thread.id;await f.a.request('turn/start',{threadId:id,input:[{type:'text',text:'disconnect'}]});f.a.event({type:'closed',runtimeId:f.cli.id});assert.equal(f.a.connected,false);assert.equal(f.a.entry(id).thread.turns[0].status,'interrupted');assert.equal(f.a.state().executor,false);}finally{f.close();}
 });
 await test('verified Claude login controls readiness and an unauthenticated turn is never sent',async()=>{
  const f=setup();try{
   assert.equal(f.a.state().authentication.status,'authenticated');
   const id=(await f.a.request('thread/start',{})).thread.id,original=f.cli.status;
   f.cli.status=()=>({...original(),account:{authenticated:false,verified:true,authMethod:'none'}});
   assert.equal(f.a.state().authentication.status,'required');
   await assert.rejects(f.a.request('turn/start',{threadId:id,input:[{type:'text',text:'must not send'}]}),/登入/);assert.equal(f.sent.length,0);assert.equal(f.a.busy,false);
   f.cli.status=()=>({...original(),account:{authenticated:false,verified:false}});assert.equal(f.a.state().authentication.status,'unverified');
   assert.equal(f.a.state().quota.status,'auth-unverified');
   f.cli.status=()=>({...original(),account:{authenticated:false,verified:false,authProblem:'credential-unavailable',error:'鑰匙圈拒絕存取'}});assert.equal(f.a.state().authentication.status,'blocked');assert.equal(f.a.state().quota.status,'auth-blocked');
   await assert.rejects(f.a.request('turn/start',{threadId:id,input:[{type:'text',text:'must not send'}]}),/鑰匙圈拒絕存取/);assert.equal(f.sent.length,0);
   f.cli.refreshAccount=async()=>{f.cli.status=original;};await f.a.refreshAccount();assert.equal(f.a.state().authentication.status,'authenticated');
  }finally{f.close();}
 });
 await test('native OpenAI auth is not inferred from remote Claude auth',async()=>{const f=setup();try{assert.deepEqual(await f.a.request('account/read'),{account:null,requiresOpenaiAuth:false});await assert.rejects(f.a.content([{type:'image',url:'https://example.invalid/a.png'}]),/輸入類型/);}finally{f.close();}});
 fs.writeFileSync(path.join(__dirname,'../evidence/native-claude-unit.json'),JSON.stringify({at:new Date().toISOString(),tests,passed:true},null,2)+'\n');
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>{for(const root of fixtureRoots)fs.rmSync(root,{recursive:true,force:true});});
