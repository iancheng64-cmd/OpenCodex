'use strict';
// Claude Code on the SSH host (official login stays there); tools run on this Mac via the MCP tool host.
const crypto=require('node:crypto');
const cfg=require('../config.cjs');
const {ClaudeLocalRuntime}=cfg.mod('claude-local-runtime.js');
const {launchRemoteClaude}=cfg.mod('claude-remote-launch.js');
const {startToolHost}=require('../mac-tools.cjs');
class ClaudeDriver{
 constructor({ssh,cwd,permissionMode,resources,toolOptions,onEvent,authorizeTool,connection={}}){
  Object.assign(this,{ssh,cwd,permissionMode,resources,toolOptions,onEvent,authorizeTool,connection});
  this.id='claude';this.label='Claude Code';this.closed=false;this.activeRequest=null;
 }
 get busy(){return !!this.cli?.busy;}
 emit(e){this.onEvent({provider:'claude',runtimeId:this.cli?.id,...e});}
 async start(){
  const {conn,platform,profile}=this.ssh;
  this.tools=await startToolHost({conn,cwd:this.cwd,agentRole:'claude',permissionMode:this.permissionMode,resources:this.resources,options:this.toolOptions,authorize:async call=>{
   if(!this.cli?.busy)return false;
   if(call.category==='agent-bridge'||this.permissionMode==='full'||(this.permissionMode==='project'&&call.category==='filesystem-read'))return true;
   return this.authorizeTool({provider:'claude',name:call.name,arguments:call.arguments,signal:call.signal});
  }});
  const endpoint=this.tools.endpoint;
  this.cli=new ClaudeLocalRuntime({cwd:this.cwd,executable:this.connection.executable,authMode:this.connection.authMode==='api'?'api':'official',api:this.connection.api,permissionMode:this.permissionMode,autoCompactPercent:70,additionalDirectories:[],
   remote:{launch:(args,options)=>launchRemoteClaude(conn,{platform,nodeExecutable:this.connection.nodeExecutable,executable:this.connection.executable,remoteCwd:this.connection.remoteCwd,configDir:this.connection.configDir,args,...options})},
   mcp:{url:endpoint.remoteUrl,token:endpoint.token,name:'agentbridge_mac'},
   onPermission:request=>{
    // Mac MCP calls are approved once at the tool host; anything else is denied for the split route.
    if(request.toolName.startsWith('mcp__agentbridge_mac__'))return Promise.resolve({allow:!!this.cli?.busy&&!request.signal.aborted});
    return Promise.resolve({allow:false});
   },
   onEvent:event=>{
    if(event.type==='done')this.tools?.host.cancelActive();
    if(event.type==='closed'){this.closed=true;void this.tools?.stop().catch(()=>{});}
    this.emit(event);
   }});
  try{
   await this.cli.start();
   const catalog=await this.cli.extensions();
   if(catalog.mcp.some(s=>s.name!=='agentbridge_mac'))throw Error('Claude 載入了非 Mac 工具，已停止這次連線。');
  }catch(e){await this.stop();throw e;}
  this.hostName=profile.name;
  return this.status();
 }
 status(){
  const s=this.cli?.status()||{};const a=s.account||{};
  return {provider:'claude',connected:!this.closed&&!!this.cli,runtimeVersion:s.runtimeVersion,account:{...a,authenticated:a.authenticated===true,authMethod:a.authMethod||'Claude Code'},models:this.models(),quota:s.quota,tools:this.tools?.host.listTools().map(t=>t.name)||[],error:a.authenticated?null:(a.authProblem==='credential-unavailable'?'鑰匙圈需授權：請在主機桌面允許 Claude Code 讀取憑證。':'請在主機以相同 SSH 使用者執行 claude auth login。')};
 }
 models(){return (this.cli?.status().models||[]).map(m=>({...m,provider:'claude',defaultReasoningEffort:m.defaultReasoningEffort||m.supportedReasoningEfforts?.[0]?.reasoningEffort||''}));}
 effort(model,value){const m=this.models().find(m=>m.model===model),supported=(m?.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort);if(!supported.length)return '';if(value&&supported.includes(value))return value;return supported.includes(m.defaultReasoningEffort)?m.defaultReasoningEffort:supported.includes('high')?'high':supported[0];}
 async refreshAccount(){if(this.cli)await this.cli.refreshAccount();return this.status();}
 async refreshQuota(){if(!this.cli)return null;await this.cli.refreshAccount().catch(()=>{});return this.cli.refreshQuota();}
 async send(input){
  if(this.closed||!this.cli)throw Error('Claude 尚未連線。');
  if(!this.cli.status().account?.authenticated){await this.cli.refreshAccount();if(!this.cli.status().account?.authenticated)throw Error(this.status().error||'遠端 Claude 尚未登入。');}
  const model=input.model&&input.model!=='default'?input.model:undefined;
  const requestId=input.requestId||crypto.randomUUID();
  return this.cli.send({requestId,prompt:input.prompt,conversationId:input.conversationId||undefined,model:model||'default',effort:this.effort(input.model||'default',input.effort),systemPrompt:input.systemPrompt});
 }
 async cancel(){this.tools?.host.cancelActive();return this.cli?.cancel();}
 async stop(){if(this.closed)return;this.closed=true;await this.cli?.stop().catch(()=>{});await this.tools?.stop().catch(()=>{});}
}
module.exports={ClaudeDriver};
