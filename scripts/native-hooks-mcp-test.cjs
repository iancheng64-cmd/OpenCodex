'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {NativeHooksMcp}=require('../src/native-hooks-mcp.cjs');
const permissionOptions={binary:'/verified/permission-engine',env:{SCOPE:'permissions'},AppServerRpc:class VerifiedRpc{}};
function fixture(runtimeOverrides={}){
 const calls=[],requests=[];
 class Tools{
  constructor(options){this.options=options;this.threadId='local';this.resets=0;}
  async ready(){if(this.options.validate)assert.equal(await this.options.validate(),true);}
  async inventory(){return [{name:'fixture',runtimeStatus:'connected',tools:{probe:{}}}];}
  async operation(method,params,signal){calls.push({method,params,signal});return {content:[{type:'text',text:'one'},{type:'image',data:'ignored'},{type:'text',text:'two'}]};}
  reset(){this.resets++;}
  close(){this.closed=true;}
 }
 const run={threadId:'child',turnId:'turn',rootThreadId:'root',parentThreadId:'root',openCodex:true};
 const owner={run,threadId:'child',sessionId:'root',turnId:'turn'};
 const active={owner,authorized:()=>true},runtime={id:'runtime',...runtimeOverrides};
 const mcp=new NativeHooksMcp({record:{plan:{cwd:'/mac/project'}},runtime,Tools,onRequest:(m,r,c)=>{requests.push({m,r,c});return true;}});
 const call={threadId:'child',server:'fixture',tool:'probe',arguments:{value:1},metadata:{threadId:'child',sessionId:'forged','x-codex-turn-metadata':'forged'}};
 return {mcp,active,run,call,calls,requests,runtime};
}
test('uses an isolated Hook host and validated Mac identity',async()=>{
 const f=fixture();assert.deepEqual(f.mcp.tools.options.config,{'features.hooks':false});
 assert.equal(f.mcp.tools.options.cwd,'/mac/project');
 assert.equal(await f.mcp.call(f.call,undefined,f.active),'one\ntwo');
 const request=f.calls[0];assert.equal(request.method,'mcpServer/tool/call');
 assert.equal(request.params._meta.threadId,'child');assert.equal(request.params._meta.sessionId,'root');
 assert.deepEqual(JSON.parse(request.params._meta['x-codex-turn-metadata']),{session_id:'root',thread_id:'child',turn_id:'turn',thread_source:'subagent',parent_thread_id:'root',subagent_kind:'thread_spawn'});
 assert.equal(f.mcp.active,null);f.mcp.close();
});
test('refuses foreign identity, remote environment, disabled or missing tool',async()=>{
 const f=fixture();
 for(const change of [{threadId:'other'},{metadata:{threadId:'other'}},{environmentId:'remote'}])
  await assert.rejects(f.mcp.call({...f.call,...change},undefined,f.active),/ownership mismatch/);
 for(const change of [{server:'other'},{tool:'absent'}])
  await assert.rejects(f.mcp.call({...f.call,...change},undefined,f.active),/未連線或已停用/);
 assert.equal(f.calls.length,0);f.mcp.close();
});
test('MCP errors and malformed results cannot become successful Hook output',async()=>{
 const f=fixture();
 for(const key of ['isError','is_error']){
  f.mcp.tools.operation=async()=>({[key]:true,content:[{type:'text',text:'failure'}]});
  await assert.rejects(f.mcp.call(f.call,undefined,f.active),/MCP tool returned an error: failure/);
 }
 f.mcp.tools.operation=async()=>({});await assert.rejects(f.mcp.call(f.call,undefined,f.active),/Invalid MCP Hook result/);f.mcp.close();
});
test('routes approvals to the active child and refuses stale or cancelled requests',async()=>{
 const f=fixture(),request={id:1,method:'item/commandExecution/requestApproval',params:{threadId:'local',turnId:'local-turn'}};
 assert.equal(f.mcp.tools.options.onRequest(request,{},f.mcp.tools),false);
 f.mcp.tools.operation=async()=>{
  assert.equal(f.mcp.tools.options.onRequest(request,{},f.mcp.tools),true);
  assert.equal(f.requests[0].m.params.threadId,'child');assert.equal(f.requests[0].m.params.turnId,'turn');
  assert.equal(f.requests[0].c.owner,f.runtime);
  assert.equal(f.mcp.tools.options.onRequest({...request,params:{threadId:'foreign'}},{},f.mcp.tools),false);
  f.run.cancelled=true;
  assert.equal(f.mcp.tools.options.onRequest(request,{},f.mcp.tools),false);
  return {content:[]};
 };
 await f.mcp.call(f.call,undefined,f.active);f.mcp.close();
});
test('cancellation during startup resets only its host and prevents dispatch',async()=>{
 const f=fixture(),other=fixture(),controller=new AbortController();let finish;
 f.mcp.tools.ready=()=>new Promise(r=>finish=r);
 const work=f.mcp.call(f.call,controller.signal,f.active);controller.abort();
 assert.equal(f.mcp.tools.resets,1);assert.equal(other.mcp.tools.resets,0);
 finish();await assert.rejects(work,/owner ended/);assert.equal(f.calls.length,0);
 f.mcp.close();other.mcp.close();
});
test('owner expiry during inventory blocks dispatch',async()=>{
 const f=fixture();f.mcp.tools.inventory=async()=>{f.active.authorized=()=>false;return [{name:'fixture',runtimeStatus:'connected',tools:{probe:{}}}];};
 await assert.rejects(f.mcp.call(f.call,undefined,f.active),/owner ended/);assert.equal(f.calls.length,0);f.mcp.close();
});

test('custom Hook host requires and retains the verified profile',async()=>{
 let valid=true,checks=0;
 const permission={options:permissionOptions,profile:'audit',valid:()=>valid,validate:async()=>{checks++;return valid;}};
 const f=fixture({permissionMode:'custom:audit',openCodexPermissions:permission});
 assert.equal(f.mcp.tools.options.permissionProfile,'audit');
 assert.equal(f.mcp.tools.options.binary,permissionOptions.binary);
 assert.equal(f.mcp.tools.options.env,permissionOptions.env);
 assert.equal(f.mcp.tools.options.AppServerRpc,permissionOptions.AppServerRpc);
 assert.throws(()=>fixture({permissionMode:'custom:audit',openCodexPermissions:{profile:'audit',valid:()=>true}}),/引擎未就緒/);
 await f.mcp.call(f.call,undefined,f.active);assert(checks>0);
 valid=false;
 await assert.rejects(f.mcp.call(f.call,undefined,f.active),/owner ended/);
 assert.equal(f.calls.length,1);f.mcp.close();
 assert.throws(()=>fixture({permissionMode:'custom:audit'}),/未就緒/);
 assert.throws(()=>fixture({permissionMode:'custom:dev',openCodexPermissions:permission}),/未就緒/);
 assert.throws(()=>fixture({permissionMode:'full',openCodexPermissions:permission}),/未就緒/);
});
test('profile replacement and built-in transitions revoke previous Hook authority',async()=>{
 for(const update of [runtime=>runtime.permissionMode='full',runtime=>runtime.openCodexPermissions={}]) {
  const permission={options:permissionOptions,profile:'dev',valid:()=>true,validate:async()=>true};
  const f=fixture({permissionMode:'custom:dev',openCodexPermissions:permission});
  f.mcp.tools.operation=async()=>{
   update(f.runtime);
   assert.equal(f.mcp.tools.options.onRequest({id:1,params:{threadId:'local'}},{},f.mcp.tools),false);
   return {content:[{type:'text',text:'stale'}]};
  };
  await assert.rejects(f.mcp.call(f.call,undefined,f.active),/owner ended/);f.mcp.close();
 }
 const f=fixture();f.runtime.permissionMode='custom:audit';
 await assert.rejects(f.mcp.call(f.call,undefined,f.active),/owner ended/);assert.equal(f.calls.length,0);f.mcp.close();
});
test('edited permission configuration blocks Hook dispatch before tool execution',async()=>{
 const permission={options:permissionOptions,profile:'dev',valid:()=>true,validate:async()=>{throw Error('configuration changed');}};
 const f=fixture({permissionMode:'custom:dev',openCodexPermissions:permission});
 await assert.rejects(f.mcp.call(f.call,undefined,f.active),/configuration changed/);
 assert.equal(f.calls.length,0);assert.equal(f.mcp.active,null);f.mcp.close();
});

test('serializes one Hook session and discards results after cancel or close',async()=>{
 for(const method of ['cancel','close']){
  const f=fixture();let finish;
  f.mcp.tools.operation=()=>new Promise(r=>finish=r);
  const work=f.mcp.call(f.call,undefined,f.active);await new Promise(setImmediate);
  await assert.rejects(f.mcp.call(f.call,undefined,f.active),/busy/);
  f.mcp[method]();finish({content:[{type:'text',text:'late'}]});
  await assert.rejects(work,/owner ended/);f.mcp.close();
 }
});
