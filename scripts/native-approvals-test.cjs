'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {ApprovalGrants,approvalScope,idFor}=require('../src/native-approvals.cjs'),{localApproval}=require('../src/native-policy.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-approval-')),file=path.join(dir,'grants.json'),tests=[];
 const scope={profileId:'host1',hostKey:'qa@host:22',fingerprint:'SHA256:qa',cwd:fs.realpathSync(dir),mode:'project',tool:'test_node',extension:'opencodex-native:node_repl',schema:'schema1',hostLabel:'QA'};
 const grants=new ApprovalGrants(file);
 const run=async(response,extra={})=>{
  const decisions=[],runtime={run:{openCodex:true}},input={event:{type:'approval'},runtime,grants,getScope:()=>scope,isPending:()=>true,respond:d=>decisions.push(d),show:async options=>{assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);assert.deepEqual(options.buttons,['拒絕','允許這次','永遠允許此工具']);return {response}}};
  await localApproval({...input,...extra});return decisions;
 };
 try{
  assert.deepEqual(await run(0),['decline']);assert(!grants.has(scope));
  assert.deepEqual(await run(1),['accept']);assert(!grants.has(scope));tests.push('deny and allow-once do not persist');
  assert.deepEqual(await run(2),['accept']);assert(grants.has(scope));
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  const restarted=new ApprovalGrants(file);assert(restarted.has(scope));
  assert.deepEqual(await run(0,{grants:restarted,show:()=>{throw Error('must not prompt')}}),['accept']);tests.push('permanent consent persists across store restart with private file mode');
  for(const key of ['profileId','hostKey','fingerprint','cwd','mode','tool','extension','schema'])assert(!restarted.has({...scope,[key]:scope[key]+'-other'}),key);
  tests.push('host, SSH fingerprint, project, permission mode, tool and schema isolation');
  restarted.revoke(idFor(scope));assert(!grants.has(scope));
  assert.deepEqual(await run(0),['decline']);tests.push('revocation affects existing and new store instances');
  for(const mutation of [
   input=>{input.runtime.run.cancelled=true},
   input=>{input.runtime.run={openCodex:true}},
   input=>{input.runtime.closed=true},
   input=>{input.runtime.run.backgroundTextOnly=true},
   input=>{input.getScope=()=>({...scope,cwd:scope.cwd+'/changed'})}
  ]){
   const runtime={run:{openCodex:true}},input={event:{type:'approval'},runtime,isPending:()=>true,grants,getScope:()=>scope},decisions=[];
   await localApproval({...input,getScope:()=>input.getScope(),respond:d=>decisions.push(d),show:async()=>{mutation(input);return {response:2}}});
   assert.deepEqual(decisions,['decline']);assert(!grants.has(scope));
  }
  tests.push('cancelled, replaced, closed, background or switched-workspace runs cannot save consent');
  let pending=true;
  assert.deepEqual(await run(2,{isPending:()=>pending,show:async()=>{pending=false;return {response:2}}}),[]);assert(!grants.has(scope));
  assert.deepEqual(await run(2,{show:async()=>{grants.revoke(idFor(scope));return {response:2}}}),['decline']);assert(!grants.has(scope));
  tests.push('expired requests and revocation while dialog is open fail closed');
  for(const reason of ['cancel','disconnect','expired','revoke']){
   const runtime={run:{openCodex:true}},decisions=[];let pending=true,closed=false;
   await localApproval({event:{type:'approval'},runtime,grants,getScope:()=>scope,isPending:()=>pending,respond:d=>decisions.push(d),show:({signal})=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{closed=true;resolve({response:0});},{once:true});
    if(reason==='cancel')runtime.run.cancelled=true;
    if(reason==='disconnect')runtime.closed=true;
    if(reason==='expired')pending=false;
    if(reason==='revoke')grants.revoke(idFor(scope));
   })});
   assert(closed,reason+' must close the pending native sheet');assert(!grants.has(scope));
   assert.deepEqual(decisions,reason==='expired'?[]:['decline']);
  }
  tests.push('pending native sheets close on Stop, disconnect, expiration and revocation');
  let reported=false;const failing=new ApprovalGrants(path.join(dir,'missing','grants.json'));
  assert.deepEqual(await run(2,{grants:failing,onError:()=>{reported=true}}),['decline']);assert(reported);tests.push('failed persistence declines and reports error');
  fs.writeFileSync(file,'broken');
  assert(!grants.has(scope));assert.equal(grants.list().length,0);assert(grants.error);assert.throws(()=>grants.remember(scope));
  fs.writeFileSync(file,JSON.stringify({version:1,grants:[{...scope,id:'wrong',createdAt:'today'}]}));assert(!grants.has(scope));
  tests.push('corrupt or mismatched records never auto-approve');
  fs.unlinkSync(file);fs.symlinkSync(path.join(dir,'target'),file);assert(!grants.has(scope));assert.throws(()=>grants.remember(scope));fs.unlinkSync(file);
  tests.push('permission store symlinks are rejected');
  const call={name:'test_node',category:'extension'},entry={category:'extension',extensionId:scope.extension,tool:{inputSchema:{type:'object'}}};
  const rt={localCwd:dir,permissionMode:'project',requests:new Map([['id',{localResolve:()=>{},request:{method:'local/tool',params:call}}]]),toolHost:{entries:new Map([['test_node',entry]])},snapshot:{profileId:'host1',hostKey:'qa@host:22',hostFingerprint:'SHA256:qa',hostName:'QA',transport:'ssh'}};
  for(const transport of ['ssh','tailscale-ssh']){rt.snapshot.transport=transport;assert(approvalScope(rt,'id'));}
  for(const transport of ['https-relay',undefined,'unknown']){rt.snapshot.transport=transport;assert.equal(approvalScope(rt,'id'),null);}
  rt.snapshot.transport='tailscale-ssh';assert.equal(approvalScope(rt,'untrusted'),null);
  rt.snapshot.hostFingerprint=null;assert.equal(approvalScope(rt,'id'),null);rt.snapshot.hostFingerprint='SHA256:qa';
  entry.category='other';assert.equal(approvalScope(rt,'id'),null);
  tests.push('scope uses trusted pending request and registered tool, never dialog text');
  const decisions=[];await localApproval({event:{type:'approval'},runtime:{run:{openCodex:true}},grants,isPending:()=>true,respond:d=>decisions.push(d),show:async options=>{assert.equal(options.buttons.length,2);return {response:2}}});assert.deepEqual(decisions,['decline']);
  tests.push('unscoped tools cannot be permanently authorized');
  const report={version:'0.4.1',at:new Date().toISOString(),passed:true,tests};fs.writeFileSync(path.join(__dirname,'../evidence/native-approvals-test.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
