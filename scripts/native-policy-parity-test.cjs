'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const policy=require('../src/native-policy.cjs');
const tests=[],test=async(name,fn)=>{await fn();tests.push(name);};
const profile={ask:':read-only',project:':workspace',full:':danger-full-access'};
const sandbox={ask:'readOnly',project:'workspaceWrite',full:'dangerFullAccess'};
const peerSnapshot=()=>({thread:{id:'thread',cwd:'C:\\peer'},cwd:'C:\\peer',model:'chosen-model',
 approvalPolicy:'untrusted',approvalsReviewer:'guardian_subagent',
 sandbox:{type:'readOnly',writableRoots:['C:\\peer']},
 activePermissionProfile:{id:'peer-custom-profile',extends:':read-only'}});
const rendererTurn=s=>({permissions:s.activePermissionProfile?.id??null,sandboxPolicy:s.sandboxPolicy??s.sandbox,approvalPolicy:s.approvalPolicy,approvalsReviewer:s.approvalsReviewer});
(async()=>{
 await test('all built-in Mac choices survive a start/resume/fork snapshot and the next renderer turn',()=>{
  for(const mode of Object.keys(profile)){
   const remote=peerSnapshot(),before=JSON.stringify(remote),selection=policy.resolveMode({permissions:profile[mode]},null,{permissionMode:'project'});
   const local=policy.localSnapshot(remote,selection);
   assert.equal(local.activePermissionProfile.id,profile[mode]);assert.equal(local.activePermissionProfile.extends,null);
   assert.equal(local.sandbox.type,sandbox[mode]);assert.deepEqual(local.sandbox.writableRoots,mode==='project'?[]:undefined);
   assert.equal(local.approvalsReviewer,'user');assert.equal(local.model,'chosen-model');
   assert.deepEqual(policy.resolveMode(rendererTurn(local),'ask',{permissionMode:'ask'}),{requested:mode,effective:mode});
   assert.equal(JSON.stringify(remote),before);assert.notEqual(local,remote);
  }
 });
 await test('native permission picker can reopen project history without missing or peer roots',()=>{
  const cwd='/Users/test/project',remote={...peerSnapshot(),runtimeWorkspaceRoots:['C:\\peer']};
  for(const input of [remote,{...remote,sandbox:{type:'workspaceWrite'}}, {...remote,threadSettings:remote}]){
   const mapped=policy.localSnapshot(input,'project',cwd),local=mapped.threadSettings||mapped;
   assert.deepEqual([...local.sandbox.writableRoots],[cwd]);assert.deepEqual(local.runtimeWorkspaceRoots,[cwd]);
   assert.equal(local.sandbox.networkAccess,false);assert.equal(local.sandbox.excludeSlashTmp,false);
   assert.equal(local.sandbox.excludeTmpdirEnvVar,false);
   assert.equal(policy.resolveMode(rendererTurn(local),'ask',{}).requested,'project');
  }
  for(const cwd of [undefined,'C:\\peer','relative','/bad\0path']){
   const local=policy.localSnapshot(remote,'project',cwd);assert.deepEqual(local.sandbox.writableRoots,[]);assert.deepEqual(local.runtimeWorkspaceRoots,[]);
  }
  assert.deepEqual(remote.runtimeWorkspaceRoots,['C:\\peer']);
 });
 await test('legacy sandbox-only snapshots cannot silently downgrade a remembered project to ask',()=>{
  const remote={sandbox:{type:'readOnly'},approvalPolicy:'untrusted'};
  assert.equal(policy.selectedMode({sandboxPolicy:remote.sandbox}),'ask');
  const selection=policy.resolveMode({},'project',{permissionMode:'ask'});
  const local=policy.localSnapshot(remote,selection);
  assert.equal(policy.resolveMode(rendererTurn(local),'project',{permissionMode:'ask'}).requested,'project');
 });
 await test('highest access never replaces the user choice echoed by the renderer',async()=>{
  const settings={permissionMode:'project',fullAccess:true};
  for(const remembered of ['ask','project']){
   const selected=policy.resolveMode({},remembered,settings);assert.equal(selected.effective,'full');
   const local=policy.localSnapshot(peerSnapshot(),selected);
   const next=policy.resolveMode(rendererTurn(local),remembered,settings);
   assert.deepEqual(next,{requested:remembered,effective:'full'});
   assert.equal(policy.resolveMode(rendererTurn(local),remembered,{...settings,fullAccess:false}).effective,remembered);
  }
  let applied;
  await policy.setFullAccess({enabled:false,settings,busy:false,apply:async mode=>{applied=mode},save:()=>{}});
  assert.equal(applied,'project');assert.equal(settings.permissionMode,'project');
 });
 await test('settings/updated notifications preserve the newly selected mode for subsequent turn/start',()=>{
  const notification={threadId:'thread',threadSettings:{cwd:'/Users/test/project',model:'new-model',sandboxPolicy:{type:'readOnly'},approvalPolicy:'untrusted',activePermissionProfile:null}};
  const selection=policy.resolveMode({permissions:':workspace'},'ask',{permissionMode:'ask'});
  const local=policy.localSnapshot(notification,selection);
  assert.equal(local.threadId,'thread');assert.equal(local.threadSettings.cwd,'/Users/test/project');
  assert.equal(local.threadSettings.sandboxPolicy.type,'workspaceWrite');assert.equal(local.threadSettings.model,'new-model');
  assert.equal(local.threadSettings.approvalPolicy,'on-request');
  assert.equal(notification.threadSettings.sandboxPolicy.type,'readOnly');
  assert.equal(policy.resolveMode(rendererTurn(local.threadSettings),'ask',{permissionMode:'ask'}).requested,'project');
 });
 await test('empty settings/update replies and unrelated thread/turn payloads keep their exact shape',()=>{
  for(const value of [null,undefined,{},[],{thread:{id:'t'}},{turn:{id:'turn'}},{model:'chosen'}])assert.equal(policy.localSnapshot(value,'project'),value);
  assert.throws(()=>policy.localSnapshot(peerSnapshot(),'custom'),/權限/);
  assert.throws(()=>policy.resolveMode({permissions:'peer-custom-profile'},'project',{}),/權限/);
 });
 await test('mapping both snapshot formats never mutates peer writable roots or profile objects',()=>{
  const remote={sandbox:{type:'workspaceWrite',writableRoots:['C:\\peer']},sandboxPolicy:{type:'dangerFullAccess'},activePermissionProfile:{id:'peer'}};
  Object.freeze(remote.sandbox);Object.freeze(remote.sandboxPolicy);Object.freeze(remote.activePermissionProfile);Object.freeze(remote);
  const local=policy.localSnapshot(remote,'ask');
  assert.deepEqual(local.sandbox,{type:'readOnly'});assert.deepEqual(local.sandboxPolicy,{type:'readOnly'});
  assert.notEqual(local.sandbox,local.sandboxPolicy);assert.equal(remote.activePermissionProfile.id,'peer');
 });
 await test('settings and turn requests still enforce peer isolation independently of renderer snapshots',async()=>{
  const calls=[],context={exports:{},require:id=>{assert.equal(id,'../../../app.asar/opencodex/native-agent-runs.cjs');return require('../src/native-agent-runs.cjs');},runtimes:new Map(),node_crypto_1:crypto,refreshMacExtensions:async()=>{},verifyThreadMcp:async()=>{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bridge-adapter.cjs'),'utf8'),context);
  const runtime={closed:false,executor:{isRunning:true,environmentId:'mac'},snapshot:{executorEnvironment:{}},localCwd:'/Users/test/project',openCodexThreads:new Set(['thread']),
   rpc:{request:async(method,params)=>{calls.push({method,params});return method==='turn/start'?{turn:{id:'turn'}}:{};}}};
  for(const mode of Object.keys(profile)){
   const local=policy.localSnapshot(peerSnapshot(),mode),params={threadId:'thread',...rendererTurn(local)};
   runtime.permissionMode=mode;runtime.run=null;
   await context.exports.openCodexRequest(runtime,{},'thread/settings/update',params);
   let sent=calls.at(-1).params;
   assert.equal(sent.permissions,undefined);assert.equal(sent.approvalsReviewer,undefined);
   assert.equal(sent.sandboxPolicy.type,mode==='full'?'dangerFullAccess':'readOnly');
   assert.equal(sent.approvalPolicy,mode==='full'?'never':'untrusted');
   await context.exports.openCodexRequest(runtime,{},'turn/start',{...params,input:[]});
   sent=calls.at(-1).params;
   assert.equal(sent.sandboxPolicy.type,mode==='full'?'dangerFullAccess':'readOnly');
   assert.equal(sent.approvalPolicy,mode==='full'?'never':'untrusted');
   assert.equal(sent.environments[0].environmentId,'mac');
  }
 });
 console.log(JSON.stringify({passed:true,tests,scope:'Permission snapshot and existing adapter regression with mocked SSH; no live execution claim'}));
})().catch(error=>{console.error(error.stack);process.exitCode=1});
