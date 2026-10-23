'use strict';
// Subscription CLIs run on the verified SSH host; every executable tool stays on the Mac.
const crypto=require('node:crypto'),path=require('node:path');
const quote=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
const env='export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
const labels={grok:'Grok',antigravity:'Antigravity'};
function channel(conn,command){return new Promise((resolve,reject)=>conn.exec(env+command,(e,s)=>e?reject(e):resolve(s)));}
async function capture(conn,command,timeout=20000){
 const s=await channel(conn,command);
 return new Promise((resolve,reject)=>{
  let out='',err='',done=false;
  const finish=(e,value)=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(value);};
  const timer=setTimeout(()=>{s.close();finish(Error('CLI 查詢逾時。'));},timeout);
  s.on('data',b=>{out+=b;if(out.length>262144){s.close();finish(Error('CLI 回應過大。'));}});
  s.stderr?.on('data',b=>{err=(err+b).slice(-2000);});
  s.on('error',e=>finish(e));s.on('close',code=>finish(null,{code,stdout:out,stderr:err}));s.end();
 });
}
function grokModels(state){
 return (state?.availableModels||[]).filter(m=>typeof m.modelId==='string').map(m=>({
  id:m.modelId,model:m.modelId,displayName:m.name||m.modelId,description:m.description||'',isDefault:m.modelId===state.currentModelId,
  inputModalities:['text','image'],defaultReasoningEffort:m._meta?.reasoningEffort||null,
  supportedReasoningEfforts:(m._meta?.reasoningEfforts||[]).map(e=>({reasoningEffort:e.value||e.id,description:e.description||e.label||e.id})).sort((a,b)=>['none','minimal','low','medium','high','xhigh','max','ultra'].indexOf(a.reasoningEffort)-['none','minimal','low','medium','high','xhigh','max','ultra'].indexOf(b.reasoningEffort))
 }));
}
function agyModels(raw){
 const clean=String(raw).replace(/\x1b\[[0-9;]*m/g,'');let data;
 try{data=JSON.parse(clean);}catch{}
 const entries=Array.isArray(data)?data:Array.isArray(data?.models)?data.models:null;
 if(entries)return entries.flatMap(m=>{const id=typeof m==='string'?m:m.id||m.model;return typeof id==='string'?[{id,model:id,displayName:m.displayName||m.name||id,isDefault:m.isDefault===true,inputModalities:['text'],supportedReasoningEfforts:[]}]:[];});
 // Only accept model identifiers explicitly printed by the CLI, never invent versions.
 const ids=[...clean.matchAll(/(?:^|\s)(?:[*•]\s*)?((?:gemini|claude|gpt|grok)-[a-z0-9][a-z0-9._-]*)(?=\s|$)/gmi)].map(m=>m[1]);
 return [...new Set(ids)].map(id=>({id,model:id,displayName:id,isDefault:false,inputModalities:['text'],supportedReasoningEfforts:[]}));
}
class GrokCLI{
 constructor({conn,mcp,onEvent,cwd}){Object.assign(this,{conn,mcp,onEvent});this.id=crypto.randomUUID();this.options={cwd};this.pending=new Map();this.next=0;this.busy=false;this.snapshot={account:{verified:false,authenticated:false},models:[],quota:{stale:false,windows:[],unavailableReason:'Grok CLI 未提供訂閱剩餘額度或重置時間。'}};}
 status(){return {...this.snapshot,runtimeId:this.id};}
 emit(e){this.onEvent({runtimeId:this.id,...(this.activeRequestId?{requestId:this.activeRequestId}:{}),...e});}
 async start(){
  this.stream=await channel(this.conn,'cd /tmp && grok --tools "" --no-subagents --disable-web-search agent stdio');let buffer='';
  this.stream.on('data',b=>{buffer+=b;if(buffer.length>32*1024*1024)return this.fail(Error('Grok 回應過大。'));let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.trim())continue;try{this.receive(JSON.parse(line));}catch(e){this.fail(e);}}});
  this.stream.stderr?.on('data',()=>{});this.stream.on('error',e=>this.fail(e));this.stream.on('close',()=>this.fail(Error('Grok CLI 連線已中斷。')));
  const init=await this.call('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
  this.snapshot.runtimeVersion=init._meta?.agentVersion||init.agentInfo?.version;
  this.snapshot.models=grokModels(init._meta?.modelState);this.capabilities=init.agentCapabilities;
  await this.refreshAccount();return this.status();
 }
 sendJSON(value){if(this.closed)throw Error('Grok CLI 已關閉。');this.stream.write(JSON.stringify(value)+'\n');}
 call(method,params,timeout=30000){
  const id=++this.next;return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(method+' 逾時；未自動重送。'));if(method==='session/prompt')this.fail(Error('Grok 回合逾時。'));},timeout);
   this.pending.set(id,{resolve,reject,timer});
   try{this.sendJSON({jsonrpc:'2.0',id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
  });
 }
 receive(m){
  if(m.id!=null&&!m.method){const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message||'Grok RPC 失敗')):p.resolve(m.result);return;}
  if(m.method&&m.id!=null){
   // No terminal/filesystem callbacks are advertised. Mac MCP owns its approval gate.
   if(m.method==='session/request_permission'){
    const name=m.params?.toolCall?.title||'',mac=/^(?:mcp__agentbridge_mac__|agentbridge_mac[.:/])/.test(name);
    const option=mac&&this.busy&&m.params.options?.find(o=>o.kind==='allow_once');
    this.sendJSON({jsonrpc:'2.0',id:m.id,result:{outcome:option?{outcome:'selected',optionId:option.optionId}:{outcome:'cancelled'}}});
   }else this.sendJSON({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Only the authenticated Mac MCP tool channel is available.'}});
   return;
  }
  if(m.method!=='session/update'||!this.busy||this.replaying)return;
  const u=m.params?.update;if(!u)return;
  if(u.sessionUpdate==='agent_message_chunk'&&u.content?.type==='text'){this.text=(this.text||'')+u.content.text;this.emit({type:'message',text:this.text});}
  if(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update'){
   const id=u.toolCallId,old=this.tools.get(id)||{};this.tools.set(id,{...old,...u});const t=this.tools.get(id);
   this.emit({type:'tool',itemId:id,tool:t.title||'Mac tool',status:t.status==='completed'?'completed':t.status==='failed'?'failed':'running',text:t.status==='completed'||t.status==='failed'?JSON.stringify(t.content||t.rawOutput||''):JSON.stringify(t.rawInput||{})});
  }
 }
 async refreshAccount(){
  if(this.busy||this.closed)return this.status();
  try{const r=await this.call('authenticate',{methodId:'cached_token',_meta:{headless:true}});delete this.snapshot.error;this.snapshot.account={verified:true,authenticated:true,email:r?._meta?.email||null,authMethod:'Grok CLI · '+(r?._meta?.subscription_tier||'訂閱登入')};}
  catch(e){this.snapshot.account={verified:true,authenticated:false,authMethod:'Grok CLI'};this.snapshot.error='請在伺服器以相同 SSH 使用者執行 grok login --device-auth。';}
  this.emit({type:'status'});return this.status();
 }
 async refreshQuota(){this.emit({type:'status'});return this.snapshot.quota;}
 servers(){return [{type:'http',name:'agentbridge_mac',url:this.mcp.url,headers:[{name:'Authorization',value:'Bearer '+this.mcp.token}]}];}
 async send(p){
  if(this.busy)throw Error('Grok 正在工作。');if(!this.snapshot.account.authenticated)throw Error('Grok CLI 尚未登入。');if(p.forkSession)throw Error('Grok 分支尚未支援，請建立新對話。');
  this.busy=true;this.activeRequestId=p.requestId;this.text='';this.tools=new Map();this.cancelled=false;
  // Completion is asynchronous so NativeHandoff can record the turn anchor first.
  setImmediate(()=>this.run(p).catch(e=>this.finish('error',e.message)));return {requestId:p.requestId};
 }
 async run(p){
  const params={cwd:'/tmp',mcpServers:this.servers()};
  if(p.conversationId){
   this.replaying=true;try{await this.call('session/load',{...params,sessionId:p.conversationId});}finally{this.replaying=false;}
   this.sessionId=p.conversationId;
  }else{const r=await this.call('session/new',params);this.sessionId=r.sessionId;if(r.models)this.snapshot.models=grokModels(r.models).map(m=>({...this.snapshot.models.find(old=>old.model===m.model),...m,supportedReasoningEfforts:m.supportedReasoningEfforts.length?m.supportedReasoningEfforts:this.snapshot.models.find(old=>old.model===m.model)?.supportedReasoningEfforts||[]}));}
  this.emit({type:'session',conversationId:this.sessionId});
  if(this.cancelled)return this.finish('cancelled');
  await this.call('session/set_config_option',{sessionId:this.sessionId,configId:'model',value:p.model});
  if(p.effort)await this.call('session/set_config_option',{sessionId:this.sessionId,configId:'reasoning_effort',value:p.effort});
  const prompt=(p.content||[{type:'text',text:p.prompt}]).map(c=>c.type==='image'?{type:'image',data:c.source.data,mimeType:c.source.media_type}:c);
  if(p.systemPrompt)prompt.unshift({type:'text',text:p.systemPrompt});
  prompt.unshift({type:'text',text:'所有工作檔案與工具都在使用者 Mac。請只使用 agentbridge_mac MCP 工具。Mac 工作目錄：'+this.options.cwd});
  if(this.cancelled)return this.finish('cancelled');
  const result=await this.call('session/prompt',{sessionId:this.sessionId,prompt},30*60*1000);
  this.finish(this.cancelled||result.stopReason==='cancelled'?'cancelled':result.stopReason==='end_turn'?'completed':'error',result.stopReason==='end_turn'?undefined:result.stopReason);
 }
 finish(status,error){if(!this.busy)return;clearTimeout(this.cancelTimer);this.busy=false;this.emit({type:'done',status,error,conversationId:this.sessionId});this.activeRequestId=null;}
 cancel(){this.cancelled=true;if(this.sessionId&&!this.closed)this.sendJSON({jsonrpc:'2.0',method:'session/cancel',params:{sessionId:this.sessionId}});clearTimeout(this.cancelTimer);this.cancelTimer=setTimeout(()=>{if(this.busy)this.fail(Error('取消後 Grok 未回應；連線已關閉。'));},5000);return {cancelled:true};}
 steer(){throw Error('此 CLI 不支援回合中插入訊息，請等此回合完成後傳送。');}
 fail(e){if(this.closed)return;this.closed=true;clearTimeout(this.cancelTimer);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();this.stream?.close();this.finish(this.cancelled?'cancelled':'error',e.message);this.emit({type:'closed',text:e.message});}
 async stop(){this.fail(Error('Grok 連線已關閉。'));}
}
// A disposable workspace contains the MCP credential and fail-closed CLI tool hook.
// No user settings are overwritten; the credential is sent over SSH stdin, not argv.
const AGY_RUN=String.raw`
import sys,json,os,tempfile,subprocess,shutil,signal
p=json.loads(sys.stdin.readline())
root=tempfile.mkdtemp(prefix="opencodex-agy-")
proc=None
def stop(signum,frame):
 raise KeyboardInterrupt()
for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):
 signal.signal(sig,stop)
try:
 os.chmod(root,0o700)
 d=os.path.join(root,".agents");os.mkdir(d,0o700)
 guard=os.path.join(root,"guard.py")
 with open(guard,"w") as f:
  f.write('import sys,json\ntry:\n p=json.load(sys.stdin); n=p.get("toolCall",{}).get("name",""); ok=n.startswith(("mcp__agentbridge_mac__","mcp_agentbridge_mac_","agentbridge_mac."))\nexcept Exception: ok=False\nprint(json.dumps({"decision":"auto_approve" if ok else "deny","reason":"OpenCodex only permits the authenticated Mac MCP channel."}))\n')
 for name,data in [("hooks.json",{"opencodex-mac-only":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"python3 "+guard,"timeout":10}]}]}}),("mcp_config.json",{"mcpServers":{"agentbridge_mac":{"serverUrl":p["mcp"]["url"],"headers":{"Authorization":"Bearer "+p["mcp"]["token"]}}}})]:
  target=os.path.join(d,name)
  with open(target,"w") as f: json.dump(data,f)
  os.chmod(target,0o600)
 args=["agy","--input-format","stream-json","--output-format","stream-json","--disable-slash-commands","--mode","accept-edits","--model",p["model"],"--print-timeout","30m"]
 if p.get("conversationId"): args+=["--conversation",p["conversationId"]]
 if p.get("effort"): args+=["--effort",p["effort"]]
 proc=subprocess.Popen(args,cwd=root,stdin=subprocess.PIPE)
 proc.communicate((json.dumps({"event":"user","message":{"content":p["prompt"]}})+"\n").encode())
 sys.exit(proc.returncode)
finally:
 if proc is not None and proc.poll() is None:
  proc.terminate()
  try: proc.wait(timeout=3)
  except subprocess.TimeoutExpired:
   proc.kill()
   proc.wait()
 shutil.rmtree(root)
`;
class AntigravityCLI{
 constructor({conn,mcp,onEvent,cwd}){Object.assign(this,{conn,mcp,onEvent});this.id=crypto.randomUUID();this.options={cwd};this.busy=false;this.snapshot={account:{verified:false,authenticated:false},models:[]};}
 status(){return {...this.snapshot,runtimeId:this.id};}
 emit(e){this.onEvent({runtimeId:this.id,...(this.activeRequestId?{requestId:this.activeRequestId}:{}),...e});}
 async start(){await this.refreshAccount();return this.status();}
 async refreshAccount(){
  if(this.busy||this.closed)return this.status();
  try{
   const r=await capture(this.conn,'agy models');const models=agyModels(r.stdout);
   const auth=/login|log in|sign.?in|auth.*required|not authenticated/i.test(r.stdout+'\n'+r.stderr);
   this.snapshot.models=auth?[]:models;this.snapshot.account={verified:auth||models.length>0,authenticated:!auth&&models.length>0,authMethod:'Antigravity CLI'};
   // A generic Keychain command can fail even when AGY uses a readable token cache.
   // Only report the result of AGY's own authentication check.
   this.snapshot.error=auth?'Antigravity CLI 在此 SSH 工作階段回報需要驗證；先前登入的憑證可能已過期或無法更新。請以相同 SSH 使用者執行 agy，完成瀏覽器登入及驗證碼流程，再按更新。':!models.length?'CLI 未回傳可辨識的模型清單。':null;
  }catch(e){this.snapshot.error=e.message;this.snapshot.account={verified:false,authenticated:false,authMethod:'Antigravity CLI'};}
  this.emit({type:'status'});return this.status();
 }
 async refreshQuota(){
  if(this.busy||!this.snapshot.account.authenticated)return this.snapshot.quota;
  try{const r=await capture(this.conn,'agy -p /usage --print-timeout 15s',20000);
   this.snapshot.quota={windows:[],raw:r.stdout.replace(/\x1b\[[0-9;]*m/g,'').trim().slice(0,32000),updatedAt:Date.now(),stale:r.code!==0,error:r.code?'無法更新 Antigravity 額度。':null};
  }catch(e){this.snapshot.quota={...this.snapshot.quota,stale:true,error:e.message};}
  this.emit({type:'status'});return this.snapshot.quota;
 }
 async send(p){
  if(this.busy)throw Error('Antigravity 正在工作。');if(!this.snapshot.account.authenticated)throw Error('Antigravity CLI 尚未登入。');
  if(p.content?.some(c=>c.type!=='text'))throw Error('Antigravity CLI 目前僅支援文字輸入。');if(p.forkSession)throw Error('Antigravity 分支尚未支援。');
  this.busy=true;this.cancelled=false;this.activeRequestId=p.requestId;this.text='';this.parts=new Map();this.sessionId=p.conversationId;
  setImmediate(()=>this.run(p).catch(e=>this.finish('error',e.message)));return {requestId:p.requestId};
 }
 async run(p){
  this.stream=await channel(this.conn,'python3 -c '+quote(AGY_RUN));let buffer='',result=false;
  this.stream.on('data',b=>{buffer+=b;if(buffer.length>4*1024*1024){this.stream.close();return this.finish('error','Antigravity 回應過大。');}let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let v;try{v=JSON.parse(line);}catch{continue;}
   if(v.conversation_id){this.sessionId=v.conversation_id;this.emit({type:'session',conversationId:this.sessionId});}
   if(v.event==='step_update'){
    const s=v.step_update;if(s?.step_type==='agent_response'&&s.text_delta){this.parts.set(s.step_index,(this.parts.get(s.step_index)||'')+s.text_delta);this.text=[...this.parts.values()].join('\n');this.emit({type:'message',text:this.text});}
    if(s?.step_type==='tool')this.emit({type:'tool',itemId:'agy:'+s.step_index,tool:s.tool_info?.name||'Mac tool',status:s.state==='DONE'?'completed':'running',text:JSON.stringify(s.tool_info||{})});
   }
   if(v.event==='result'){
    result=true;const r=v.result||{};if(r.response)this.emit({type:'message',text:r.response});
    if(r.conversation_id)this.sessionId=r.conversation_id;
    this.finish(this.cancelled?'cancelled':r.status==='SUCCESS'?'completed':'error',r.error?String(r.error):undefined);
   }
  }});
  this.stream.stderr?.on('data',()=>{});this.stream.on('error',e=>this.finish('error',e.message));
  this.stream.on('close',()=>{if(!result)this.finish(this.cancelled?'cancelled':'error','Antigravity 未回傳完成結果。');});
  const prompt=[p.systemPrompt,'只使用 agentbridge_mac MCP 工具處理使用者 Mac 的檔案。工作目錄：'+this.options.cwd,p.prompt].filter(Boolean).join('\n\n');
  this.stream.end(JSON.stringify({mcp:this.mcp,model:p.model,effort:p.effort,conversationId:p.conversationId,prompt})+'\n');
  if(this.cancelled)this.stream.signal?.('INT');
 }
 finish(status,error){if(!this.busy)return;clearTimeout(this.cancelTimer);this.busy=false;this.emit({type:'done',status,error,conversationId:this.sessionId});this.activeRequestId=null;}
 cancel(){this.cancelled=true;this.stream?.signal?.('INT');clearTimeout(this.cancelTimer);this.cancelTimer=setTimeout(()=>{this.stream?.close();this.finish('cancelled');},5000);return {cancelled:true};}
 steer(){throw Error('Antigravity CLI 不支援回合中插入訊息，請於此回合結束後傳送。');}
 async stop(){this.closed=true;clearTimeout(this.cancelTimer);this.stream?.signal?.('TERM');this.stream?.close();this.finish('cancelled');}
}
class ExternalProviders{
 constructor({abRoot,deps,selectWorkspace,onEvent,onState}){Object.assign(this,{abRoot,deps,selectWorkspace,onEvent,onState});this.runtimes=new Map();this.errors=new Map();this.operations=new Map();this.generation=0;}
 state(id){
  const r=this.runtimes.get(id),s=r?.cli.status(),authenticated=s?.account?.authenticated===true,connected=!!r&&!r.closed&&!r.cli.closed;
  return {id,label:labels[id],connected,authenticated,account:s?.account||null,source:'SSH · '+labels[id]+' CLI',status:!connected?'disconnected':s?.account?.verified!==true?'auth-unverified':!authenticated?'auth-required':s?.quota?.stale?'unavailable':'available',stale:!connected||!!s?.quota?.stale,error:this.errors.get(id)||s?.error||null,quota:s?.quota?{...s.quota,buckets:(s.quota.windows||[]).map(w=>({name:w.name,primary:w}))}:null,login:id==='grok'?'grok login --device-auth':'agy'};
 }
 async connect(id,main){
  if(this.operations.has(id))return this.operations.get(id);
  const p=this.open(id,main,this.generation).finally(()=>this.operations.delete(id));this.operations.set(id,p);return p;
 }
 async open(id,main,generation=this.generation){
  const existing=this.runtimes.get(id);
  if(existing?.conn===main.conn&&!existing.closed&&!existing.cli.closed)return existing;
  if(existing)await this.close(id);
  if(!main.conn||main.closed)throw Error('SSH 連線尚未就緒。');
  const {LocalToolHost}=require(path.join(this.abRoot,'dist-main/local-tool-host.js'));
  const {LoopbackForward}=require(path.join(this.abRoot,'dist-main/loopback-forward.js'));
  let r,host,forward;
  try{
   const cwd=main.localCwd,mode=['ask','project','full'].includes(main.permissionMode)?main.permissionMode:'ask';
   host=new LocalToolHost({stateDirectory:this.deps.stateDirectory,allowedRoots:[cwd],extensionServers:[],enableShell:true,readOnlyRoots:this.deps.libraryRoot?[this.deps.libraryRoot]:[],agentRole:'claude',...this.deps.localTools(),fullFilesystemAccess:mode==='full',authorize:async call=>{
    if(!r||r.closed||!r.cli.busy)return false;
    if(call.category==='agent-bridge'||r.permissionMode==='full'||r.permissionMode==='project'&&call.category==='filesystem-read')return true;
    return this.ask(r,call);
   }});
   const endpoint=await host.start();forward=new LoopbackForward(main.conn,endpoint.port);const port=await forward.start();
   const Driver=id==='grok'?GrokCLI:AntigravityCLI;
   const cli=new Driver({conn:main.conn,cwd,mcp:{url:'http://127.0.0.1:'+port+'/mcp',token:endpoint.token},onEvent:e=>{
    if(e.type==='done'){for(const p of [...r.pending.values()])p.resolve({allow:false});r.host.cancelActive();}
    this.onEvent(id,e);if(e.type==='closed'){r.closed=true;void this.release(r);}this.onState();
   }});
   r={cli,host,conn:main.conn,forward,network:{profileId:main.snapshot.profileId,hostFingerprint:main.snapshot.hostFingerprint,transport:main.snapshot.transport},hostName:main.snapshot.hostName,hostKey:main.snapshot.profileId+'|'+id,pending:new Map(),permissionMode:mode,cwd:null,localCwd:null,closed:false,provider:id};
   if(generation!==this.generation||main.closed)throw Error('連線已取消。');
   this.runtimes.set(id,r);await this.selectWorkspace(r,cwd);
   if(r.closed||generation!==this.generation)throw Error('連線已取消。');
   r.onClose=()=>{r.closed=true;void cli.stop();this.onEvent(id,{runtimeId:cli.id,type:'closed',text:'SSH 已中斷；工作未重送。'});void this.release(r);this.onState();};main.conn.once('close',r.onClose);
   await cli.start();if(main.closed||r.closed||generation!==this.generation)throw Error('SSH 已中斷。');
   this.errors.delete(id);this.onState();return r;
  }catch(e){if(r){r.closed=true;await r.cli.stop();await this.release(r);}else{forward?.stop();await host?.stop();}this.errors.set(id,e.message);this.onState();throw e;}
 }
 ask(r,call){return new Promise(resolve=>{
  const id=crypto.randomUUID();let timer;const finish=a=>{if(!r.pending.has(id))return;r.pending.delete(id);clearTimeout(timer);call.signal?.removeEventListener('abort',cancel);this.onEvent(r.provider,{runtimeId:r.cli.id,type:'requestClosed',approvalId:id});resolve(a.allow===true);};
  const cancel=()=>finish({allow:false});timer=setTimeout(cancel,120000);
  r.pending.set(id,{toolName:call.name,input:call.arguments,isQuestion:false,resolve:finish,dispose:()=>clearTimeout(timer)});
  call.signal?.addEventListener('abort',cancel,{once:true});
  this.onEvent(r.provider,{runtimeId:r.cli.id,type:'approval',approvalId:id,executionLocation:'local',title:'允許 '+labels[r.provider]+' 在這台 Mac 使用 '+call.name+'？',detail:JSON.stringify(call.arguments,null,2).slice(0,8000)});
 });}
 async invoke(provider,name,...args){
  const r=this.runtimes.get(provider);if(!r||r.closed)throw Error(labels[provider]+' 尚未連線。');
  if(name==='claude:permission'){const mode=args[1];if(!['ask','project','full'].includes(mode))throw Error('此供應商尚未支援自訂權限設定。');r.permissionMode=mode;r.host.setFullFilesystemAccess(mode==='full');return;}
  if(name==='claude:cancel'){r.host.cancelActive();return r.cli.cancel();}
  if(name==='claude:quota')return r.cli.refreshQuota();
  if(name==='claude:disconnect')return this.close(provider);
  if(name==='claude:respond'){const a=args[0],p=r.pending.get(a.approvalId);p?.resolve({allow:r.cli.busy&&['accept','acceptForSession'].includes(a.decision)});return;}
  throw Error('未支援的供應商操作：'+name);
 }
 async refresh(){await Promise.allSettled([...this.runtimes.values()].filter(r=>!r.closed&&!r.cli.busy).map(async r=>{await r.cli.refreshAccount();await r.cli.refreshQuota();}));this.onState();}
 async release(r){if(r.released)return;r.released=true;if(r.onClose)r.conn.removeListener('close',r.onClose);for(const p of [...r.pending.values()])p.resolve({allow:false});r.forward.stop();await r.host.stop();}
 async close(id){const r=this.runtimes.get(id);if(!r)return;r.closed=true;await r.cli.stop();await this.release(r);if(this.runtimes.get(id)===r)this.runtimes.delete(id);}
 async closeAll(){this.generation++;await Promise.allSettled([...this.runtimes.keys()].map(id=>this.close(id)));await Promise.allSettled([...this.operations.values()]);await Promise.allSettled([...this.runtimes.keys()].map(id=>this.close(id)));}
}
module.exports={ExternalProviders,GrokCLI,AntigravityCLI,grokModels,agyModels};
