'use strict';
// Translate Claude's authenticated SSH runtime into the pinned native app-server protocol.
// Claude history is separate from Codex history and bound to the verified SSH host.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const policy=require('./native-policy.cjs'),routing=require('./native-routing.cjs');
const {NativeQueue}=require('./native-queue.cjs');
const clone=value=>JSON.parse(JSON.stringify(value)),now=()=>Math.floor(Date.now()/1000);
class NativeClaude{
 constructor({root,settings,saveSettings,invoke,emit,onState,selectWorkspace,refreshTools,forwardRequest,grants,showApproval,onError,shell}){
  Object.assign(this,{root,settings,saveSettings,invoke,emit,onState,selectWorkspace,refreshTools,forwardRequest,grants,showApproval,onError,shell});
  this.file=path.join(root,'native-claude-threads.json');this.entries={};this.loaded=new Set();this.preparing=false;
  try{const data=JSON.parse(fs.readFileSync(this.file,'utf8'));if(data.version!==1||!data.entries||typeof data.entries!=='object')throw Error('Invalid Claude history');this.entries=data.entries;}catch(e){if(e.code!=='ENOENT')throw e;}
  // An interrupted application cannot prove the remote turn completed. Never replay it.
  for(const e of Object.values(this.entries))for(const t of e.thread.turns||[])if(t.status==='inProgress'){t.status='interrupted';t.error={message:'App 已中斷；這項工作未自動重送。'};e.thread.status={type:'notLoaded'};}
  this.queue=new NativeQueue({file:path.join(root,'native-claude-queue.json'),context:()=>({profile:this.profile,connected:this.connected,busy:this.busy,ready:id=>this.loaded.has(id)&&this.owns(this.entries[id])}),start:(threadId,input)=>this.request('turn/start',{threadId,input},true),emit,onError});
 }
 get connected(){return !!this.runtime&&!this.runtime.closed&&!this.failed;}
 get busy(){return this.preparing||!!this.runtime?.run||!!this.runtime?.cli.busy||!!this.shell?.active;}
 get profile(){return this.runtime?.network?.profileId||this.settings.profileId;}
 owns(e){return !!e&&!e.deleted&&e.profile===this.profile&&(!this.connected||e.fingerprint===this.runtime.network.hostFingerprint);}
 entry(id){const e=this.entries[id];if(!this.owns(e))throw Error('此 Claude 對話不屬於目前主機，或主機身分已變更。');return e;}
 save(){const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify({version:1,entries:this.entries}),{mode:0o600,flag:'wx'});fs.renameSync(tmp,this.file);}finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}}
 note(method,params){this.emit({method,params:clone(params)});}
 attach(runtime,snapshot){if(this.busy)throw Error('請先停止 Claude 工作。');this.runtime=runtime;this.failed=false;this.snapshot=snapshot;this.loaded.clear();runtime.localCwd=runtime.cwd;runtime.toolHost=runtime.host;this.onState();}
 state(){const r=this.runtime,s=this.connected?r.cli.status():this.snapshot;return {sshAgent:'claude',connected:this.connected,executor:this.connected&&!!r.host?.status().ok,tools:this.connected?r.host?.listTools().length||0:0,profile:r?.hostName||this.settings.profileName,profileId:this.profile,cwd:r?.cwd||this.settings.cwd,transport:r?.network?.transport||null,runtimeVersion:s?.runtimeVersion||null,permissionMode:r?.permissionMode||this.settings.permissionMode,permissionBusy:this.busy||this.queue.starting,authentication:{status:!this.connected?'disconnected':s?.account?.authProblem==='credential-unavailable'?'blocked':s?.account?.verified!==true?'unverified':s?.account?.authenticated===true?'authenticated':'required',method:s?.account?.authMethod||null},quota:{account:s?.account||null,quota:s?.quota?{...s.quota,buckets:(s.quota.windows||[]).map(w=>({name:w.name,primary:w}))}:null,source:'SSH · Claude Code',status:!this.connected?'disconnected':s?.account?.authProblem==='credential-unavailable'?'auth-blocked':s?.account?.verified!==true?'auth-unverified':s?.account?.authenticated!==true?'auth-required':s?.quota?.stale?'unavailable':s?.quota?'available':'loading',stale:!this.connected||!!s?.quota?.stale,error:s?.account?.error||s?.quota?.error||null},engine:'opencodex-claude-ssh'};}
 async disconnect(){if(this.busy)throw Error('請先停止 Claude 工作。');const r=this.runtime;this.runtime=null;this.loaded.clear();if(r&&!r.closed)await this.invoke('claude:disconnect',r.cli.id);this.onState();}
 async permission(mode){if(this.connected)await this.invoke('claude:permission',this.runtime.cli.id,mode);}
 async refreshAccount(){if(this.connected){await this.runtime.cli.refreshAccount();this.onState();}}
 async quota(){if(this.connected){await this.refreshAccount();await this.invoke('claude:quota',this.runtime.cli.id);}}
 models(){return (this.connected?this.runtime.cli.status().models||[]:[]).map(m=>({...m,defaultReasoningEffort:m.defaultReasoningEffort||m.supportedReasoningEfforts?.[0]?.reasoningEffort||'none',hidden:false,supportsPersonality:false,inputModalities:m.inputModalities||['text','image']}));}
 model(value){const models=this.models(),m=value?models.find(m=>m.model===value||m.id===value):models.find(m=>m.isDefault)||models[0];if(!m)throw Error(value?'此 Claude 模型不在主機提供的模型清單。':'尚未取得 Claude 模型清單。');return m.model;}
 response(e,includeTurns=true){const thread=this.shell?this.shell.merge(e.thread):e.thread;const mode=policy.resolveMode({},e.permissionMode,this.settings).effective;return {thread:{...clone(thread),turns:includeTurns?clone(thread.turns):[]},model:e.thread.model,modelProvider:'anthropic',cwd:e.thread.cwd,approvalPolicy:mode==='full'?'never':'on-request',approvalsReviewer:'user',sandbox:mode==='full'?{type:'dangerFullAccess'}:mode==='ask'?{type:'readOnly'}:{type:'workspaceWrite',writableRoots:[e.thread.cwd],networkAccess:true},reasoningEffort:e.thread.reasoningEffort||null};}
 handles(method){return /^(thread\/|turn\/|review\/)/.test(method)||routing.reads.has(method);}
 async workspace(e,p={}){
  const cwd=fs.realpathSync(p.cwd||e?.thread.cwd||this.settings.cwd);if(!fs.statSync(cwd).isDirectory())throw Error('請選擇有效的 Mac 工作資料夾。');
  await this.selectWorkspace(this.runtime,cwd);
  const selected=policy.resolveMode(p,e?.permissionMode,this.settings);await this.permission(selected.effective);
  if(policy.selectedMode(p)){this.settings.permissionMode=selected.requested;this.saveSettings();}
  if(e){e.thread.cwd=cwd;e.permissionMode=selected.requested;}
  return {cwd,mode:selected.requested};
 }
 async request(method,p={},fromQueue=false){
  if(method==='account/read')return {account:null,requiresOpenaiAuth:false};
  if(method==='account/rateLimits/read')return {rateLimits:null,rateLimitsByLimitId:null};
  if(method==='model/list')return {data:this.models(),nextCursor:null};
  if(method==='collaborationMode/list')return {data:[]};
  if(method==='mcpServerStatus/list')return {data:[],nextCursor:null}; // Tools are exposed by Claude's MCP host, not a second native inventory.
  if(['thread/list','thread/search'].includes(method)){
   const known=Object.fromEntries(Object.entries(this.entries).filter(([,e])=>this.owns(e)).map(([id,e])=>[id,{profile:e.profile,archived:e.archived,summary:{...e.thread,turns:[]}}]));
   return routing.cachedPage(method,p,known,this.profile);
  }
  if(method==='thread/loaded/list')return {data:[...this.loaded].filter(id=>this.owns(this.entries[id])),nextCursor:null};
  if(method==='thread/attachmentOwner/list')return {data:[],nextCursor:null};
  const e=p.threadId?this.entry(p.threadId):null;
  if(method==='thread/read')return this.response(e,p.includeTurns===true);
  if(method.startsWith('thread/queue/')){if(!e)throw Error('缺少 Claude 對話。');return this.queue.request(method,p,this.profile);}
  if(method==='turn/interrupt'){
   this.queue.pause(this.profile,p.threadId);
   if(this.preparing?.threadId===p.threadId)this.preparing.cancelled=true;
   if(this.shell?.active?.remoteThreadId===p.threadId&&(!p.turnId||!this.shell.active.turnId||p.turnId===this.shell.active.turnId)){await this.shell.interrupt();return {};}
   const run=this.runtime?.run;
   if(run&&run.threadId===p.threadId&&(!p.turnId||run.turnId===p.turnId)){run.cancelled=true;await this.invoke('claude:cancel',this.runtime.cli.id,run.requestId);}
   return {};
  }
  if(method==='turn/steer')return this.steer(e,p);
  if(!this.connected)throw Error('Claude SSH 尚未連線；歷史對話仍可閱讀。');
  if(this.busy||(!fromQueue&&this.queue.starting))throw Error('請先停止目前 Claude 工作。');
  if(['thread/name/set','thread/archive','thread/unarchive','thread/delete','thread/unsubscribe'].includes(method)){
   if(!e)throw Error('缺少 Claude 對話。');
   if(method==='thread/name/set'){if(typeof p.name!=='string'||!p.name.trim())throw Error('對話名稱不可為空。');e.thread.name=p.name;this.note('thread/name/updated',{threadId:p.threadId,threadName:p.name});}
   if(method==='thread/archive')e.archived=true;if(method==='thread/unarchive')e.archived=false;
   if(method==='thread/delete'){e.deleted=true;this.loaded.delete(p.threadId);}
   if(method==='thread/unsubscribe')this.loaded.delete(p.threadId);
   this.save();return {};
  }
  if(method==='thread/start'||method==='thread/resume'){
   this.preparing=true;this.onState();
   try{
    const w=await this.workspace(e,p),model=this.model(p.model||e?.thread.model),timestamp=now();
    if(e){e.thread.model=model;e.thread.status={type:'idle'};this.loaded.add(e.thread.id);this.save();return this.response(e);}
    // A same-thread model handoff mirrors the native Codex thread id.
    const id=typeof p.openCodexThreadId==='string'&&p.openCodexThreadId&&!this.entries[p.openCodexThreadId]?p.openCodexThreadId:crypto.randomUUID(),entry={profile:this.profile,fingerprint:this.runtime.network.hostFingerprint,permissionMode:w.mode,conversationId:null,instructions:[p.baseInstructions,p.developerInstructions].filter(Boolean).join('\n\n'),thread:{id,sessionId:id,preview:'',model,modelProvider:'anthropic',createdAt:timestamp,updatedAt:timestamp,status:{type:'idle'},cwd:w.cwd,cliVersion:this.runtime.cli.status().runtimeVersion||'',source:'appServer',projectId:null,ephemeral:false,name:null,turns:[],reasoningEffort:p.reasoningEffort||null}};
    this.entries[id]=entry;this.loaded.add(id);this.save();this.note('thread/started',{thread:this.response(entry,false).thread});return this.response(entry,false);
   }finally{this.preparing=false;this.onState();}
  }
  if(method==='thread/fork')return this.fork(e,p);
  if(method==='thread/shellCommand')return this.shellCommand(e,p);
  if(method==='review/start')return this.review(e,p);
  if(method==='turn/start')return this.start(e,p);
  throw Error('Claude 模式尚未支援這項原生操作：'+method);
 }
 adoptSession(e,id){
  if(typeof id!=='string'||!id)return;
  if(e.forkSession&&id===e.conversationId)return;
  e.conversationId=id;e.forkSession=false;
 }
 async fork(e,p){
  if(!e)throw Error('缺少 Claude 對話。');
  const source=this.response(e).thread;
  if(p.path||p.beforeTurnId||(p.lastTurnId&&p.lastTurnId!==source.turns.at(-1)?.id))throw Error('Claude 目前可從最新回合建立獨立分支；尚不支援截斷至較早回合。');
  if(p.experimentalPredictionMode||p.serviceTier)throw Error('Claude 不支援此分支選項。');
  const entry=clone(e),id=crypto.randomUUID(),timestamp=now();
  entry.thread={...source,id,sessionId:id,name:null,createdAt:timestamp,updatedAt:timestamp,status:{type:'idle'},forkedFromId:e.thread.id};
  entry.archived=false;entry.forkSession=!!entry.conversationId;
  this.preparing=true;this.onState();
  try{
   await this.workspace(entry,p);entry.thread.model=this.model(p.model||entry.thread.model);
   if(p.baseInstructions!==undefined||p.developerInstructions!==undefined)entry.instructions=[p.baseInstructions,p.developerInstructions].filter(Boolean).join('\n\n');
   this.entries[id]=entry;this.loaded.add(id);
   try{this.save();}catch(error){delete this.entries[id];this.loaded.delete(id);throw error;}
   this.note('thread/started',{thread:this.response(entry,false).thread});return this.response(entry,!p.excludeTurns);
  }finally{this.preparing=false;this.onState();}
 }
 async shellCommand(e,p){
  if(!e||!this.shell)throw Error('Mac 原生 Shell 尚未就緒。');
  if(typeof p.command!=='string'||!p.command.trim())throw Error('Shell 指令不可為空。');
  const owner=this.runtime,preparing={threadId:e.thread.id,cancelled:false};this.preparing=preparing;this.onState();
  try{
   await this.workspace(e,p);
   if(preparing.cancelled||owner!==this.runtime||!this.connected)throw Error('Mac 指令已取消。');
   this.loaded.add(e.thread.id);this.save();
   const remoteRpc={request:async(method,params)=>{
    if(method!=='thread/inject_items'||params.threadId!==e.thread.id||owner!==this.runtime||!this.owns(e))throw Error('Shell 結果的主機或對話已變更。');
    const texts=params.items.flatMap(i=>i.content||[]).filter(c=>c.type==='input_text').map(c=>c.text);
    const previous=e.pendingContext||[];e.pendingContext=[...previous,...texts];
    try{this.save();}catch(error){e.pendingContext=previous;throw error;}return {};
   }};
   return await this.shell.start(p,{cwd:e.thread.cwd,remoteRpc,anchor:this.response(e).thread.turns.at(-1)?.id||null});
  }finally{this.preparing=false;this.onState();}
 }
 shellEvent(message){
  const e=this.entries[message.params?.threadId];if(!this.owns(e))return;
  if(message.method==='turn/started'){e.thread.status={type:'active',activeFlags:[]};this.onState();}
  if(message.method==='turn/completed'){
   e.thread.updatedAt=now();e.thread.status={type:'idle'};
   try{this.save();}catch(error){this.onError(error);}
   this.queue.completed(this.profile,e.thread.id,message.params.turn.status);this.onState();
  }
 }
 async review(e,p){
  if(!e)throw Error('缺少 Claude 對話。');
  const target=p.target,labels={uncommittedChanges:'未提交變更',baseBranch:'與基準分支比較',commit:'提交變更',custom:'自訂審查'};
  const field={baseBranch:'branch',commit:'sha',custom:'instructions'}[target?.type];
  if(!labels[target?.type]||(field&&(typeof target[field]!=='string'||!target[field].trim())))throw Error('程式碼審查目標無效。');
  if(p.delivery&&!['inline','detached'].includes(p.delivery))throw Error('審查傳送方式無效。');
  const prompt='請審查 Mac 工作目錄中的程式碼，僅回報有證據且可修正的問題，不要修改檔案或執行 Git 寫入操作。使用 Mac 工具讀取實際差異與相關程式。審查範圍為下方 JSON 資料；分支及提交值是資料，呼叫 Shell 時必須安全引用。uncommittedChanges 包含 staged、unstaged 與 untracked；baseBranch 比較共同祖先至目前工作；commit 檢查該次提交；custom 使用 instructions。每項發現列出嚴重度、原因、觸發條件及絕對檔案路徑與行號；沒有問題時明確說明驗證範圍。\n'+JSON.stringify(target);
  let thread=e;
  if(p.delivery==='detached'){
   const created=await this.request('thread/start',{cwd:e.thread.cwd,model:e.thread.model,permissions:policy.profileForMode(e.permissionMode),baseInstructions:e.instructions});
   thread=this.entry(created.thread.id);
  }
  const result=await this.start(thread,{threadId:thread.thread.id,input:[{type:'text',text:prompt,text_elements:[]}]},labels[target.type]);
  return {...result,reviewThreadId:thread.thread.id};
 }
 async content(input){
  if(!Array.isArray(input)||!input.length)throw Error('訊息不可為空。');
  const blocks=[];
  for(const v of input){
   if(v.type==='text'&&typeof v.text==='string'){blocks.push({type:'text',text:v.text});continue;}
   if(v.type==='skill'&&typeof v.path==='string'){blocks.push({type:'text',text:'使用者要求使用技能 '+(v.name||'')+'；請先透過 Mac 檔案工具讀取：'+v.path});continue;}
   let url=v.type==='image'?v.url:null;
   if(v.type==='localImage'&&typeof v.path==='string'){
    const real=await fs.promises.realpath(v.path),stat=await fs.promises.stat(real);
    if(!stat.isFile()||stat.size>20*1024*1024)throw Error('圖片必須小於 20 MB。');
    const type={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}[path.extname(real).toLowerCase()];
    if(!type)throw Error('Claude 不支援此圖片格式。');
    url='data:'+type+';base64,'+(await fs.promises.readFile(real)).toString('base64');
   }
   const match=typeof url==='string'&&/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
   if(match){if(match[2].length>28*1024*1024)throw Error('圖片過大。');blocks.push({type:'image',source:{type:'base64',media_type:match[1],data:match[2]}});continue;}
   throw Error('Claude 尚未支援此輸入類型：'+v.type);
  }
  return blocks;
 }
 async start(e,p,review=null){
  if(!e)throw Error('缺少 Claude 對話。');
  const owner=this.runtime,preparing={threadId:e.thread.id,cancelled:false};this.preparing=preparing;this.onState();let run;
  const check=()=>{if(preparing.cancelled||owner!==this.runtime||(owner.closed||this.failed))throw Error('Claude 工作已取消，訊息未送出。');};
  try{
   if(p.collaborationMode&&p.collaborationMode.mode!=='default')throw Error('Claude 尚未支援此協作模式。');
   if(p.serviceTier)throw Error('Claude 模式尚未支援此服務等級。');
   const content=await this.content(p.input),pending=clone(e.pendingContext||[]),model=this.model(p.model||e.thread.model);check();
   if(pending.length)content.unshift(...pending.map(text=>({type:'text',text})));
   await this.workspace(e,p);check();await this.refreshTools(this.runtime);check();
   if(!this.runtime.cli.status().account?.authenticated)await this.runtime.cli.refreshAccount();
   check();const account=this.runtime.cli.status().account;if(!account?.authenticated)throw Error(account?.error||(account?.verified?'遠端 Claude 尚未完成登入。':'無法確認遠端 Claude 登入狀態，請更新後重試。'));
   const turn={id:crypto.randomUUID(),status:'inProgress',items:[],startedAt:now(),completedAt:null,error:null};
   run={openCodex:true,review,threadId:e.thread.id,turnId:turn.id,requestId:turn.id,cancelled:false,turn,entry:e,items:new Map(),startedAt:Date.now()};
   this.runtime.run=run;e.thread.turns.push(turn);e.thread.model=model;e.thread.updatedAt=now();e.thread.status={type:'active',activeFlags:[]};
   if(!e.thread.preview)e.thread.preview=content.filter(v=>v.type==='text').map(v=>v.text).join('\n').slice(0,200);
   this.loaded.add(e.thread.id);this.save();this.note('turn/started',{threadId:e.thread.id,turn});
   if(review)this.item(run,{id:crypto.randomUUID(),type:'enteredReviewMode',review},true);
   else this.item(run,{id:crypto.randomUUID(),type:'userMessage',content:clone(p.input),clientId:p.clientUserMessageId||null},true);
   await this.runtime.cli.send({requestId:run.requestId,conversationId:e.conversationId||undefined,forkSession:e.forkSession===true,prompt:content.filter(v=>v.type==='text').map(v=>v.text).join('\n'),content,model,effort:this.effort(model,p.effort||p.reasoningEffort||p.collaborationMode?.settings?.reasoning_effort||e.thread.reasoningEffort),systemPrompt:e.instructions});
   if(pending.length){e.pendingContext=(e.pendingContext||[]).slice(pending.length);this.save();}
   return {turn:clone(turn)};
  }catch(error){if(run&&this.runtime?.run===run)this.finish('failed',error.message);throw error;}
  finally{this.preparing=false;this.onState();}
 }
 // Native "steer": guidance for the turn already running. The app-server's own error
 // strings let the native composer queue the message when the turn has ended, or retry
 // with the turn id it reports.
 async steer(e,p){
  if(!e)throw Error('缺少 Claude 對話。');
  const run=this.runtime?.run;
  if(!this.connected||!run||run.threadId!==e.thread.id||run.cancelled)throw Error('no active turn to steer');
  if(run.review)throw Error('cannot steer a review turn');
  if(p.expectedTurnId&&p.expectedTurnId!==run.turnId)throw Error('expected active turn id `'+p.expectedTurnId+'` but found `'+run.turnId+'`');
  const content=await this.content(p.input);
  if(typeof p.additionalContext==='string'&&p.additionalContext.trim())content.push({type:'text',text:p.additionalContext});
  if(this.runtime?.run!==run||run.cancelled||!this.connected)throw Error('no active turn to steer');
  this.runtime.cli.steer(content);
  this.item(run,{id:crypto.randomUUID(),type:'userMessage',content:clone(p.input),clientId:p.clientUserMessageId||null},true);
  e.thread.updatedAt=now();this.save();
  return {turnId:run.turnId};
 }
 // Always explicit: the chosen supported effort, else the model default; '' clears any
 // effort a previous Claude process was started with when the model has no effort control.
 effort(model,value){
  const m=this.models().find(m=>m.model===model),supported=(m?.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort);
  if(!supported.length)return '';
  if(value&&supported.includes(value))return value;
  return supported.includes(m.defaultReasoningEffort)?m.defaultReasoningEffort:supported.includes('high')?'high':supported[0];
 }
 item(run,item,complete=false){
  if(!run.items.has(item.id)){run.items.set(item.id,item);run.turn.items.push(item);this.note('item/started',{threadId:run.threadId,turnId:run.turnId,item});}
  if(complete)this.note('item/completed',{threadId:run.threadId,turnId:run.turnId,item});
  return item;
 }
 event(event){
  const r=this.runtime;if(!r||event.runtimeId!==r.cli.id)return;
  if(event.type==='closed'){this.failed=true;if(r.run)this.finish('interrupted',event.text||'SSH 已中斷，工作未重送。');this.loaded.clear();this.onState();return;}
  if(event.type==='claudeQuota'||event.type==='status'){this.onState();return;}
  const run=r.run;if(!run||event.requestId&&event.requestId!==run.requestId)return;
  if(event.type==='approval'){void this.approval(event).catch(this.onError);return;}
  if(event.type==='userInput'){this.question(event);return;}
  if(event.type==='session'){this.adoptSession(run.entry,event.conversationId);this.save();return;}
  if(event.type==='message'&&typeof event.text==='string'){
   let item=run.items.get('message:'+run.turnId);
   if(!item)item=this.item(run,{id:'message:'+run.turnId,type:'agentMessage',text:'',phase:'final_answer'});
   if(event.text.startsWith(item.text)){const delta=event.text.slice(item.text.length);item.text=event.text;if(delta)this.note('item/agentMessage/delta',{threadId:run.threadId,turnId:run.turnId,itemId:item.id,delta});}
   else item.text=event.text; // Final item is authoritative if Claude corrects cumulative output.
  }
  if(event.type==='tool'){
   const id=event.itemId;if(!id)return;
   let item=run.items.get(id);
   if(!item){let args={};if(event.status==='running')try{args=JSON.parse(event.text||'{}');}catch{args={input:event.text};}item=this.item(run,{id,type:'mcpToolCall',server:'claude',tool:event.tool||event.title||'Claude tool',arguments:args,status:'inProgress',result:null,error:null});}
   if(event.status==='running'&&event.text){try{item.arguments=JSON.parse(event.text);}catch{item.arguments={input:event.text};}}
   if(event.status!=='running'){item.status=event.status==='completed'?'completed':'failed';item.result={content:[{type:'text',text:event.text||''}]};if(event.image){const m=/^data:([^;]+);base64,(.+)$/.exec(event.image);if(m)item.result.content.push({type:'image',mimeType:m[1],data:m[2]});}if(item.status==='failed')item.error={message:event.text||'Claude 工具失敗'};this.note('item/completed',{threadId:run.threadId,turnId:run.turnId,item});}
  }
  if(event.type==='contextCompacted')this.item(run,{id:crypto.randomUUID(),type:'contextCompaction'},true);
  if(event.type==='error')run.error=event.text;
  if(event.type==='done'){if(event.conversationId)this.adoptSession(run.entry,event.conversationId);const forkFailed=run.entry.forkSession&&event.status==='completed';this.finish(forkFailed?'failed':event.status==='completed'?'completed':event.status==='cancelled'?'interrupted':'failed',forkFailed?'Claude 未確認獨立分支工作階段；原對話未切換。':event.error||event.text||run.error);}
 }
 finish(status,error){
  const r=this.runtime,run=r?.run;if(!run)return;
  for(const item of run.turn.items){
   if(item.type==='agentMessage')this.note('item/completed',{threadId:run.threadId,turnId:run.turnId,item});
   if(item.type==='mcpToolCall'&&item.status==='inProgress'){item.status='failed';item.error={message:error||'工作已結束，工具結果未確認。'};this.note('item/completed',{threadId:run.threadId,turnId:run.turnId,item});}
  }
  if(run.review)this.item(run,{id:crypto.randomUUID(),type:'exitedReviewMode',review:run.turn.items.filter(i=>i.type==='agentMessage').map(i=>i.text).join('\n\n')||error||'審查未產生結果。'},true);
  Object.assign(run.turn,{status,error:error?{message:error}:null,completedAt:now(),durationMs:Date.now()-run.startedAt});
  run.entry.thread.updatedAt=now();run.entry.thread.status={type:'idle'};r.run=null;
  try{this.save();}catch(e){this.onError(e);}this.note('turn/completed',{threadId:run.threadId,turn:run.turn});this.queue.completed(this.profile,run.threadId,status);this.onState();
 }
 scope(approvalId){
  const r=this.runtime,p=r?.pending.get(approvalId),entry=r?.host?.entries.get(p?.toolName),n=r?.network;
  if(!entry||p.isQuestion||!['ask','project'].includes(r.permissionMode)||!n?.hostFingerprint)return null;
  return {profileId:n.profileId,hostKey:r.hostKey,fingerprint:n.hostFingerprint,cwd:r.cwd,mode:r.permissionMode,tool:p.toolName,extension:'claude:'+(entry.extensionId||'opencodex-built-in'),schema:crypto.createHash('sha256').update(JSON.stringify(entry.tool.inputSchema||{})).digest('hex'),hostLabel:r.hostName};
 }
 async approval(event){
  const r=this.runtime;
  return policy.localApproval({event,runtime:r,isPending:()=>r.pending.has(event.approvalId),grants:this.grants,getScope:()=>this.scope(event.approvalId),show:this.showApproval,onChange:this.onState,onError:this.onError,respond:decision=>this.invoke('claude:respond',{runtimeId:r.cli.id,approvalId:event.approvalId,decision})});
 }
 question(event){
  const r=this.runtime,run=r.run,id=event.approvalId;
  const respond=answer=>{if(r!==this.runtime||r.run!==run||run.cancelled||!r.pending.has(id))return;return this.invoke('claude:respond',{runtimeId:r.cli.id,approvalId:id,...answer});};
  const message={id,method:'item/tool/requestUserInput',params:{threadId:run.threadId,turnId:run.turnId,itemId:id,isBlocking:true,questions:(event.questions||[]).map(q=>({id:q.id,header:q.header||'Claude',question:q.question,options:q.options||[],isOther:true,isSecret:false}))}};
  if(!this.forwardRequest(message,{respond:(_id,result)=>void respond({decision:'accept',answers:Object.fromEntries(Object.entries(result.answers||{}).map(([key,v])=>[key,v.answers||[]]))})?.catch(this.onError),reject:()=>void respond({decision:'decline'})?.catch(this.onError)}))void respond({decision:'decline'})?.catch(this.onError);
 }
 close(){this.queue.close();}
}
module.exports={NativeClaude};
