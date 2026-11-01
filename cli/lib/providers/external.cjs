'use strict';
// Grok CLI (ACP) and Antigravity CLI on the SSH host, reusing the App's drivers. POSIX hosts only.
const path=require('node:path');
const cfg=require('../config.cjs');
const {GrokCLI,AntigravityCLI}=require(path.join(cfg.repoRoot,'src/external-providers.cjs'));
const {startToolHost}=require('../mac-tools.cjs');
const labels={grok:'Grok',antigravity:'Antigravity'};
class ExternalDriver{
 constructor({id,ssh,cwd,permissionMode,resources,toolOptions,onEvent,authorizeTool}){
  Object.assign(this,{id,ssh,cwd,permissionMode,resources,toolOptions,onEvent,authorizeTool});this.label=labels[id];this.closed=false;
 }
 get busy(){return !!this.cli?.busy;}
 emit(e){this.onEvent({provider:this.id,runtimeId:this.cli?.id,...e});}
 async start(){
  if(this.ssh.platform!=='posix')throw Error(this.label+' CLI 僅支援 macOS／Linux 主機（需要 bash）。');
  this.tools=await startToolHost({conn:this.ssh.conn,cwd:this.cwd,agentRole:'claude',permissionMode:this.permissionMode,resources:this.resources,options:this.toolOptions,authorize:async call=>{
   if(!this.cli?.busy)return false;
   if(call.category==='agent-bridge'||this.permissionMode==='full'||(this.permissionMode==='project'&&call.category==='filesystem-read'))return true;
   return this.authorizeTool({provider:this.id,name:call.name,arguments:call.arguments,signal:call.signal});
  }});
  const Driver=this.id==='grok'?GrokCLI:AntigravityCLI;
  this.cli=new Driver({conn:this.ssh.conn,cwd:this.cwd,mcp:{url:this.tools.endpoint.remoteUrl,token:this.tools.endpoint.token},onEvent:e=>{
   if(e.type==='done')this.tools?.host.cancelActive();
   if(e.type==='closed'){this.closed=true;void this.tools?.stop().catch(()=>{});}
   this.emit(e);
  }});
  try{await this.cli.start();}catch(e){await this.stop();throw e;}
  return this.status();
 }
 status(){const s=this.cli?.status()||{};return {provider:this.id,connected:!this.closed&&!!this.cli&&!this.cli.closed,runtimeVersion:s.runtimeVersion,account:{...(s.account||{}),authMethod:s.account?.authMethod||this.label+' CLI'},models:this.models(),quota:s.quota,tools:this.tools?.host.listTools().map(t=>t.name)||[],error:s.error||null,login:this.id==='grok'?'grok login --device-auth':'agy'};}
 models(){return (this.cli?.status().models||[]).map(m=>({...m,provider:this.id}));}
 async refreshAccount(){await this.cli?.refreshAccount();return this.status();}
 async refreshQuota(){return this.cli?.refreshQuota();}
 async send(input){
  if(this.closed||!this.cli)throw Error(this.label+' 尚未連線。');
  const m=this.models().find(m=>m.model===input.model);
  const supported=(m?.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort);
  const effort=input.effort&&supported.includes(input.effort)?input.effort:undefined;
  return this.cli.send({requestId:input.requestId,prompt:input.prompt,model:input.model,effort,conversationId:input.conversationId||undefined,systemPrompt:input.systemPrompt});
 }
 async cancel(){this.tools?.host.cancelActive();return this.cli?.cancel();}
 async stop(){if(this.closed)return;this.closed=true;await this.cli?.stop().catch(()=>{});await this.tools?.stop().catch(()=>{});}
}
module.exports={ExternalDriver,labels};
