'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {archive}=require('./asar-reader.cjs'),patches=require('./native-guardian-patches.cjs');
const root=path.resolve(__dirname,'..'),a=archive(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar'));
const tests=[],files={initial:'app-initial-1ab6fbe93c4f.js',shared:'app-shared-8340f229c2b3.js'},code={};
for(const [kind,file] of Object.entries(files)){
 const original=a.read('webview/assets/'+file).toString();
 code[kind]=patches[kind](original);
 assert.equal(patches[kind](code[kind]),code[kind]);
 assert.throws(()=>patches[kind]('unrecognized native bundle'));
}
a.close();
tests.push('patches the pinned native assets once and rejects unknown bundles');
let api,update;
const base={mode:'ssh',sshAgent:'codex',connected:true,toolsReady:true,guardianAvailable:true};
vm.runInNewContext(fs.readFileSync(path.join(root,'src/native-preload.cjs'),'utf8'),{
 require:()=>({ipcRenderer:{sendSync:()=>base,on:(name,fn)=>{if(name==='opencodex:status')update=fn},invoke:async()=>({})},
  contextBridge:{exposeInMainWorld:(_name,value)=>{api=value}}}),
 document:{readyState:'loading',getElementById:()=>null},window:{addEventListener:()=>{}}
});
assert.equal(api.guardianAvailable(),true);
for(const change of [{connected:false},{toolsReady:false},{connecting:true},{guardianAvailable:false},
 {mode:'official'},{mode:'custom'},{sshAgent:'claude',executor:true,authentication:{status:'authenticated'}}]){
 update(null,{...base,...change});assert.equal(api.guardianAvailable(),false);
}
update(null,base);
tests.push('preload requires a ready Codex peer and excludes disconnected, unsupported, official, custom and Claude modes');
function extract(source,start,end){const i=source.indexOf(start),j=source.indexOf(end,i+start.length);assert(i>=0&&j>i);return source.slice(i,j);}
const ctx={
 openCodexRuntime:api,ovt:'guardian_approval',B_t:(c,k)=>c?.features?.[k],
 mWi:{c:()=>cache},hWi:{use:()=>null,useSyncExternalStore:(_subscribe,getSnapshot)=>getSnapshot()},
 Xs:(atom)=>atom==='Dc'?true:atom==='Vd'?{data:{requirements:null},isPending:false}:null,
 G:value=>value,nn:()=>[flags],On:()=>true,Yte:()=>({data:config,isPending:false}),
 pm:value=>value,HWe:()=>true
};
for(const name of ['sl','k0e','cr','ye','Ta','Dc','HG','mPn','Vd'])ctx[name]=name;
let cache=[],flags,config={config:{features:{guardian_approval:false}}};
vm.createContext(ctx);
vm.runInContext(extract(code.shared,'function nvt(e){','function rvt(e){')+';EDe=nvt;',ctx);
vm.runInContext(extract(code.initial,'function dWi(e){','function fWi(e){'),ctx);
let renders=0,result;
const render=()=>{renders++;result=ctx.dWi({cwdOverride:'/mac/project',hostId:'local'});};
// The native hook subscribes to this same preload status channel. Preserve its
// compiler cache while exercising reconnects so stale memoized gates are caught.
const off=api.subscribe(render);
assert.equal(result.isConfigDataPending,false);
assert.equal(result.isGuardianApprovalEnabledByStatsig,true);
assert.equal(result.isGuardianDefaultEnabledByStatsig,false);
assert.equal(ctx.nvt(config.config),true);
update(null,{...base,guardianAvailable:false});
assert.equal(result.isGuardianApprovalEnabledByStatsig,false);assert.equal(ctx.nvt(config.config),false);
update(null,base);assert.equal(result.isGuardianApprovalEnabledByStatsig,true);
update(null,{...base,connected:false});assert.equal(result.isGuardianApprovalEnabledByStatsig,false);
assert.equal(renders,4);
tests.push('native permission state follows disconnect and reconnect despite cached config and missing cloud flags');
update(null,{...base,mode:'official'});
assert.equal(ctx.nvt(config.config),false);
assert.equal(result.isGuardianApprovalEnabledByStatsig,false);
flags={features:{guardian_approval:true}};config={config:{features:{guardian_approval:true}}};render();
assert.equal(ctx.nvt(config.config),true);assert.equal(result.isGuardianApprovalEnabledByStatsig,true);
assert.equal(result.isGuardianDefaultEnabledByStatsig,true);
flags=undefined;render();assert.equal(result.isConfigDataPending,true);
off();
tests.push('official login retains its native feature defaults and pending cloud configuration');
const report={at:new Date().toISOString(),passed:true,tests,scope:'Actual pinned native functions and preload with isolated React hook state; not a desktop GUI acceptance'};
fs.writeFileSync(path.join(root,'evidence/native-guardian-ui-test.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
