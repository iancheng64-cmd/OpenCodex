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
   mcp:{url:endpoint.remoteUrl,token:endpoint.token,name:'opencodex_mac'},
   onPermission:request=>{
    // Mac MCP calls are approved once at the tool host; anything else is denied for the split route.
    if(request.toolName.startsWith('mcp__opencodex_mac__'))return Promise.resolve({allow:!!this.cli?.busy&&!request.signal.aborted});
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
   if(catalog.mcp.some(s=>s.name!=='opencodex_mac'))throw Error('Claude 載入了非 Mac 工具，已停止這次連線。');
  }catch(e){await this.stop();throw e;}
  this.hostName=profile.name;
  return this.status();
 }
 // Claude Code keeps its own transcripts on the runtime host (~/.claude/projects/*/<session>.jsonl).
 // A short Node script lists them or extracts one transcript; nothing is modified.
 async remote(script,timeout=25000){
  const {appServerCommand}=cfg.mod('app-server-rpc.js'),{captureRemote}=cfg.mod('remote-shell.js');
  const out=await captureRemote(this.ssh.conn,appServerCommand(this.ssh.platform,this.connection.nodeExecutable||'node',['-e',script]),timeout);
  const line=out.trim().split('\n').pop();try{return JSON.parse(line);}catch{throw Error('無法解析主機回傳的 Claude 工作階段清單。');}
 }
 async listSessions(limit=60){
  const script=String.raw`const fs=require('fs'),p=require('path'),os=require('os');const root=p.join(process.env.CLAUDE_CONFIG_DIR||p.join(os.homedir(),'.claude'),'projects');const out=[];const text=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(x=>x&&x.type==='text').map(x=>x.text):[];try{for(const d of fs.readdirSync(root)){const dir=p.join(root,d);let files=[];try{files=fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl'));}catch{}for(const f of files){const file=p.join(dir,f);let st;try{st=fs.statSync(file);}catch{continue;}if(st.size<200)continue;let first='',cwd='',sid='';try{const fd=fs.openSync(file,'r');const b=Buffer.alloc(262144);const len=fs.readSync(fd,b,0,b.length,0);fs.closeSync(fd);for(const line of b.subarray(0,len).toString('utf8').split('\n')){let m;try{m=JSON.parse(line);}catch{continue;}if(m.cwd&&!cwd)cwd=m.cwd;if(m.sessionId&&!sid)sid=m.sessionId;if(m.type==='user'&&!first&&m.message&&!m.isMeta){const parts=text(m.message.content);const arr=Array.isArray(parts)?parts:[parts];const real=arr.filter(t=>t&&!/^\s*使用者自訂指令/.test(t));first=(real.length?real[real.length-1]:arr[arr.length-1]||'').slice(0,4000);}if(first&&cwd&&sid)break;}}catch{}out.push({id:sid||f.replace(/\.jsonl$/,''),project:d,size:st.size,updatedAt:st.mtimeMs,first,cwd});}}}catch(e){}console.log(JSON.stringify(out));`;
  const data=await this.remote(script);
  if(!Array.isArray(data))return [];
  const INTRO=/^\s*\[OpenCodex 模型交接\][\s\S]*?紀錄結束。請只回應接下來這則使用者的新訊息：\s*/;
  return data.sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,limit).map(s=>({id:s.id,title:(String(s.first||'').replace(INTRO,'').replace(/\s+/g,' ').trim()||'（無標題）').slice(0,80),updatedAt:s.updatedAt,cwd:s.cwd||null,project:s.project}));
 }
 async readSession(id){
  if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('Claude 工作階段識別碼無效。');
  const script=String.raw`const fs=require('fs'),p=require('path'),os=require('os');const root=p.join(process.env.CLAUDE_CONFIG_DIR||p.join(os.homedir(),'.claude'),'projects');const id='${id}';let file=null;try{for(const d of fs.readdirSync(root)){const f=p.join(root,d,id+'.jsonl');if(fs.existsSync(f)){file=f;break;}}}catch{}const turns=[];if(file){const text=c=>typeof c==='string'?[c]:Array.isArray(c)?c.filter(x=>x&&x.type==='text').map(x=>x.text):[];let cur=null;for(const line of fs.readFileSync(file,'utf8').split('\n')){let m;try{m=JSON.parse(line);}catch{continue;}if(m.parent_tool_use_id||m.parentUuid===undefined&&!m.type)continue;if(m.type==='user'&&m.message&&!m.isMeta){const parts=text(m.message.content).filter(t=>t&&!/^\s*使用者自訂指令/.test(t));const hasTool=Array.isArray(m.message.content)&&m.message.content.some(x=>x&&x.type==='tool_result');if(!parts.length||hasTool)continue;cur={user:parts[parts.length-1],assistant:'',at:Date.parse(m.timestamp)||0};turns.push(cur);}else if(m.type==='assistant'&&m.message&&cur){const t=text(m.message.content).join('\n');if(t)cur.assistant=(cur.assistant?cur.assistant+'\n':'')+t;}}}console.log(JSON.stringify({found:!!file,turns:turns.slice(-40).map(t=>({user:t.user.slice(0,8000),assistant:t.assistant.slice(0,8000),at:t.at}))}));`;
  return this.remote(script,40000);
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
