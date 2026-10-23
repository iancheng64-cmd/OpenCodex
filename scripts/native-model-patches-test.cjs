'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),vm=require('node:vm');
const {refreshPrimaryModelLabel}=require('./native-model-patches.cjs');
const anchor='l=Q(ql,`3849065407`),u;if(r!=null){';
test('external model labels remain readable; provided display names and local mode are preserved',()=>{
 const fixture='let l,u;'+anchor.replace('l=','l=').replace(',u;',';')+'return r;}return "Custom";';
 // Exercise the actual transformed native branch in an isolated renderer context.
 const source='function label(n,r){let '+anchor+'return r;}return "Custom";}';
 const patched=refreshPrimaryModelLabel(source);
 assert.equal(refreshPrimaryModelLabel(patched),patched);
 const ctx={Q:()=>false,ql:{},openCodexRuntime:{isRemote:()=>true}};vm.createContext(ctx);vm.runInContext(patched,ctx);
 assert.equal(ctx.label('opencodex-grok:grok-4.7-build-fast',null),'grok-4.7-build-fast');
 assert.equal(ctx.label('opencodex-antigravity:gemini-test',null),'gemini-test');
 assert.equal(ctx.label('opencodex-claude:claude-test',null),'claude-test');
 assert.equal(ctx.label('opencodex-grok:grok-test','Friendly name'),'Friendly name');
 assert.equal(ctx.label('custom-user-model',null),'Custom');
 ctx.openCodexRuntime.isRemote=()=>false;assert.equal(ctx.label('opencodex-grok:grok-test',null),'Custom');
});
test('unrecognized or duplicated native boundaries fail closed',()=>{
 assert.throws(()=>refreshPrimaryModelLabel('other bundle'),/Unrecognized/);
 assert.throws(()=>refreshPrimaryModelLabel(anchor+anchor),/Unrecognized/);
});
