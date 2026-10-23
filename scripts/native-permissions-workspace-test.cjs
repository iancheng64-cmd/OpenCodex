'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/ssh-runtime.cjs'),'utf8');
const tests=[];
async function test(name,work){await work();tests.push(name);}
function fixture(mode='project'){
 const calls=[],runtime={localCwd:'/old',permissionMode:mode,snapshot:{},toolHost:{
  async setWorkspace(cwd,specs){calls.push(['workspace',cwd,specs.map(x=>x.id)]);runtime.toolHost.specs=specs;await fixtureGate?.();},
  status(){return {tools:runtime.toolHost.specs||[]};}
 }};
 let fixtureGate;
 const deps={extensionServers:async(cwd,mode)=>{calls.push(['discover',cwd,mode]);return mode.startsWith('custom:')?[]:[{id:'external:'+cwd}];}};
 const permissions={capable(){},async closeRuntime(){calls.push(['close']);runtime.openCodexPermissionFailed=true;},
  async select(rt,mode){calls.push(['select',mode]);rt.permissionMode=mode;rt.openCodexPermissionFailed=false;}
 };
 const context={deps,permissions,Error};
 let select;
 if(source.includes('async function selectWorkspace(')){
  const start=source.indexOf(' async function selectWorkspace('),end=source.indexOf('\n const deps=',start);
  vm.runInNewContext(source.slice(start,end)+'\nselect=selectWorkspace;',Object.assign(context,{select:null}));select=context.select;
 }else{
  const start=source.indexOf('selectWorkspace:async('),end=source.indexOf(',invalidateNativeTools:',start);
  assert(start>=0&&end>start);select=vm.runInNewContext('({'+source.slice(start,end)+'}).selectWorkspace',context);
 }
 return {runtime,calls,permissions,deps,select,setGate:fn=>fixtureGate=fn};
}
(async()=>{
 await test('switching projects restores the selected project external extension catalogue',async()=>{
  const f=fixture();await f.select(f.runtime,'/new','project');
  assert.deepEqual(f.runtime.toolHost.specs.map(x=>x.id),['external:/new']);
  assert.equal(f.runtime.localCwd,'/new');assert.equal(f.runtime.openCodexWorkspaceFailed,false);
 });
 await test('returning from custom permissions to a built-in mode restores external plugins in the same project',async()=>{
  const f=fixture('custom:audit');f.runtime.toolHost.specs=[];
  await f.select(f.runtime,'/old','project');
  assert.deepEqual(f.runtime.toolHost.specs.map(x=>x.id),['external:/old']);
  assert.equal(f.runtime.permissionMode,'project');assert.equal(f.runtime.snapshot.permissionMode,'project');
 });
 await test('custom project selection does not create an unrestricted native owner',async()=>{
  const f=fixture();await f.select(f.runtime,'/new','custom:audit');
  assert.deepEqual(f.runtime.toolHost.specs,[]);assert.equal(f.runtime.permissionMode,'custom:audit');
  assert.equal(f.calls.filter(x=>x[0]==='select').length,1);
 });
 await test('unchanged workspace allows history reads during an active turn without rebuilding tools',async()=>{
  const f=fixture('custom:audit');f.runtime.run={};await f.select(f.runtime,'/old','custom:audit');
  assert.equal(f.calls.length,0);
 });
 await test('active model work prevents workspace and mode changes',async()=>{
  for(const [cwd,mode]of [['/new','project'],['/old','full']]){
   const f=fixture();f.runtime.run={};await assert.rejects(f.select(f.runtime,cwd,mode),/停止/);assert.equal(f.calls.length,0);
  }
 });
 await test('cancelled extension discovery closes newly created owner before host mutation',async()=>{
  const f=fixture();let closed=0;
  f.deps.extensionServers=async()=>{f.runtime.openCodexPreparing={cancelled:true};const specs=[];Object.defineProperty(specs,'openCodexNativeOwner',{value:{close(){closed++;}}});return specs;};
  await assert.rejects(f.select(f.runtime,'/new','project'),/取消/);
  assert.equal(closed,1);assert.equal(f.calls.filter(x=>x[0]==='workspace').length,0);assert.equal(f.runtime.openCodexWorkspaceFailed,true);
 });
 await test('disconnect during host initialization cannot commit the new selection',async()=>{
  const f=fixture();f.setGate(()=>{f.runtime.closed=true;});
  await assert.rejects(f.select(f.runtime,'/new','project'),/取消/);
  assert.equal(f.calls.filter(x=>x[0]==='select').length,0);assert.equal(f.runtime.openCodexWorkspaceFailed,true);
 });
 await test('failed permission activation leaves the workspace blocked and closes authority',async()=>{
  const f=fixture();f.permissions.select=async()=>{throw Error('permission unavailable');};
  await assert.rejects(f.select(f.runtime,'/new','custom:audit'),/unavailable/);
  assert.equal(f.runtime.openCodexWorkspaceFailed,true);assert.equal(f.calls.filter(x=>x[0]==='close').length,2);
 });
 await test('OAuth completion does not disrupt an active turn and refreshes tools before the next turn',async()=>{
  const f=fixture();f.runtime.run={};f.runtime.openCodexExtensionsDirty={};
  await f.select(f.runtime,'/old','project');assert.equal(f.calls.length,0);assert.notEqual(f.runtime.openCodexWorkspaceFailed,true);
  delete f.runtime.run;await f.select(f.runtime,'/old','project');
  assert.equal(f.calls.filter(x=>x[0]==='workspace').length,1);assert.equal(f.runtime.openCodexExtensionsDirty,undefined);
 });
 await test('an extension change during refresh remains pending for a later safe preparation',async()=>{
  const f=fixture();f.runtime.openCodexExtensionsDirty={};let next;
  f.setGate(()=>{next={};f.runtime.openCodexExtensionsDirty=next;});
  await f.select(f.runtime,'/old','project');assert.equal(f.runtime.openCodexExtensionsDirty,next);
 });
 const report={at:new Date().toISOString(),passed:true,tests,scope:'Actual SSH workspace transition with isolated host and permission dependencies'};
 fs.writeFileSync(path.join(__dirname,'../evidence/native-permissions-workspace-test.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
