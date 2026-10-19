'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {ApprovalGrants,appScope}=require('../src/native-approvals.cjs'),{appApproval}=require('../src/native-policy.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-app-approval-')),tests=[];
 try{
  const tool={name:'refresh',inputSchema:{type:'object'}},entry={category:'extension',extensionId:'server',tool};
  const runtime={localCwd:dir,permissionMode:'project',toolHost:{entries:new Map([['tool',entry]])},snapshot:{profileId:'p',hostKey:'host',hostFingerprint:'SHA256:test',transport:'ssh'}};
  const call={name:'tool',category:'extension',serverId:'server',tool,arguments:{test:true}};
  const scope=appScope(runtime,call);assert(scope);assert.equal(appScope(runtime,{...call,tool:{...tool}}),null);assert.equal(appScope(runtime,{...call,serverId:'other'}),null);
  tests.push('grant scope is bound to registered descriptor identity and host');
  let grants=new ApprovalGrants(path.join(dir,'grants.json'));
  const run=(response,overrides={})=>appApproval({call,current:()=>true,fullAccess:()=>false,grants,getScope:()=>scope,show:async()=>({response}),...overrides});
  assert.equal(await run(0),false);assert.equal(await run(1),true);assert.equal(grants.has(scope),false);
  assert.equal(await run(0,{fullAccess:()=>true,show:()=>{throw Error('unexpected')}}),true);
  assert.equal(await run(2,{current:()=>false,fullAccess:()=>true}),false);
  tests.push('once, denial, highest access and stale owner rules');
  assert.equal(await run(2),true);grants=new ApprovalGrants(path.join(dir,'grants.json'));
  assert.equal(await run(0,{show:()=>{throw Error('unexpected')}}),true);
  grants.revoke(require('../src/native-approvals.cjs').idFor(scope));assert.equal(await run(0),false);
  tests.push('permanent app consent persists and can be revoked');
  for(const kind of ['owner','scope','revoke','abort']){
   const controller=new AbortController();let valid=true,currentScope=scope,closed=false;
   const result=await run(2,{call:{...call,signal:controller.signal},current:()=>valid,getScope:()=>currentScope,show:({signal})=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{closed=true;resolve({response:2});},{once:true});
    if(kind==='owner')valid=false;if(kind==='scope')currentScope={...scope,cwd:dir+'/other'};if(kind==='revoke')grants.revoke('unused');if(kind==='abort')controller.abort();
   })});
   assert.equal(result,false,kind);assert(closed,kind);assert(!grants.has(scope));
  }
  tests.push('stop, disconnect, workspace changes and revocation close outstanding approval');
  await assert.rejects(run(2,{grants:new ApprovalGrants(path.join(dir,'absent','grants.json'))}));
  assert.equal(await run(2,{getScope:()=>null,show:async o=>{assert.equal(o.buttons.length,2);return {response:2}}}),false);
  tests.push('failed persistence and unscoped permanent choice never execute');
  const patch=require('./native-mcp-patches.cjs'),source='resourceIdentity:m,server:M,signal:t,toolCallParams:e}))';
  const output=patch.patchWidget(source);assert.equal(patch.patchWidget(output),output);assert.throws(()=>patch.patchWidget('changed'));assert.throws(()=>patch.patchWidget(source+source));
  assert(output.includes('...e._meta,"opencodex/resourceUri":S.originResourceUri'));
  tests.push('native widget origin binding is unique, idempotent and overrides untrusted metadata');
  console.log(JSON.stringify({version:'0.4.3',passed:true,tests}));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error.stack);process.exitCode=1});
