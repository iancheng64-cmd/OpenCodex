'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {resolveMode,setFullAccess}=require('../src/native-policy.cjs');
(async()=>{
 const tests=[],settings={permissionMode:'project',fullAccess:false};
 const profiles={':read-only':'ask',':workspace':'project',':danger-full-access':'full'};
 for(const [permissions,mode] of Object.entries(profiles)){
  assert.deepEqual(resolveMode({permissions},null,settings),{requested:mode,effective:mode});
  assert.deepEqual(resolveMode({permissions},null,{...settings,fullAccess:true}),{requested:mode,effective:'full'});
 }
 assert.equal(resolveMode({},'ask',{...settings,fullAccess:true}).effective,'full');
 assert.equal(resolveMode({},'ask',settings).effective,'ask');
 assert.equal(resolveMode({},null,{...settings,fullAccess:'true'}).effective,'project');
 assert.deepEqual(resolveMode({permissions:'custom'},null,{...settings,fullAccess:true}),{requested:'custom:custom',effective:'full'});
 assert.deepEqual(resolveMode({permissions:'custom'},null,settings),{requested:'custom:custom',effective:'custom:custom'});
 assert.throws(()=>resolveMode({approvalsReviewer:'guardian'},null,{...settings,fullAccess:true}));
 tests.push('explicit opt-in overrides built-in and custom profiles while preserving the selected profile; unsupported reviewers reject');
 let disk={},runtimeMode='project';
 const apply=async mode=>{runtimeMode=mode},save=()=>{disk=JSON.parse(JSON.stringify(settings))};
 await setFullAccess({enabled:true,settings,apply,save});
 assert.equal(runtimeMode,'full');assert.equal(settings.permissionMode,'project');
 assert.equal(resolveMode({permissions:':workspace'},'ask',disk).effective,'full');
 await setFullAccess({enabled:false,settings,apply,save});
 assert.equal(runtimeMode,'project');assert.equal(disk.fullAccess,false);
 tests.push('enable persists across settings reload; disable restores normal policy without rewriting thread choices');
 await assert.rejects(setFullAccess({enabled:true,settings,busy:true,apply,save}));
 assert.equal(runtimeMode,'project');assert.equal(settings.fullAccess,false);
 await assert.rejects(setFullAccess({enabled:'yes',settings,apply,save}));
 tests.push('active work and malformed input cannot change access mode');
 await assert.rejects(setFullAccess({enabled:true,settings,apply,save:()=>{throw Error('disk full')}}),/disk full/);
 assert.equal(settings.fullAccess,false);assert.equal(runtimeMode,'project');
 await assert.rejects(setFullAccess({enabled:true,settings,apply:async()=>{throw Error('executor unavailable')},save}));
 assert.equal(settings.fullAccess,false);
 tests.push('persistence or executor failure leaves previous mode intact');
 const report={version:'0.4.1',at:new Date().toISOString(),passed:true,tests};
 fs.writeFileSync(path.join(__dirname,'../evidence/native-full-access-test.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.stack);process.exitCode=1});
