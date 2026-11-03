#!/usr/bin/env node
'use strict';
// OpenCodex CLI: one terminal conversation that can continue with Codex, Claude Code,
// Antigravity or Grok running on an SSH host, while every tool executes on this Mac.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const cfg=require('./lib/config.cjs'),ui=require('./lib/ui.cjs'),ssh=require('./lib/ssh.cjs');
const {Session}=require('./lib/session.cjs');
const CLI_VERSION='0.1.0';
const PROVIDERS={codex:{label:'Codex',aliases:['gpt','openai']},claude:{label:'Claude Code',aliases:['anthropic']},antigravity:{label:'Antigravity',aliases:['agy','gemini','google']},grok:{label:'Grok',aliases:['xai']}};
const EFFORTS=['none','minimal','low','medium','high','xhigh','max','ultra'];
function providerId(name){if(!name)return null;const n=String(name).toLowerCase();for(const [id,p] of Object.entries(PROVIDERS))if(id===n||p.aliases.includes(n))return id;return null;}
function parseModel(value){
 if(!value)return null;const at=value.indexOf(':');
 if(at<0){const p=providerId(value);return p?{provider:p,model:null}:{provider:null,model:value};}
 const p=providerId(value.slice(0,at));if(!p)throw Error('未知的模型供應商：'+value.slice(0,at)+'（可用：codex、claude、antigravity、grok）');
 return {provider:p,model:value.slice(at+1)||null};
}
function parseArgs(argv){
 const o={_:[],toolOptions:{}};
 for(let i=0;i<argv.length;i++){
  const a=argv[i],next=()=>{if(i+1>=argv.length)throw Error('選項 '+a+' 需要參數。');return argv[++i];};
  if(a==='-p'||a==='--prompt')o.prompt=next();
  else if(a==='-m'||a==='--model')o.model=next();
  else if(a==='--effort')o.effort=next();
  else if(a==='--profile'||a==='--ssh')o.profile=next();
  else if(a==='-C'||a==='--cwd')o.cwd=next();
  else if(a==='--permission')o.permission=next();
  else if(a==='--full-access')o.permission='full';
  else if(a==='--resume'||a==='-r')o.resume=next();
  else if(a==='--trust-host')o.trustHost=next();
  else if(a==='--no-browser')o.toolOptions.browser=false;
  else if(a==='--no-computer')o.toolOptions.computer=false;
  else if(a==='--json')o.json=true;
  else if(a==='-v'||a==='--version')o.version=true;
  else if(a==='-h'||a==='--help')o.help=true;
  else if(a.startsWith('-'))throw Error('未知選項：'+a);
  else o._.push(a);
 }
 return o;
}
const HELP=`OpenCodex CLI ${CLI_VERSION} — 在終端機接續使用 Codex / Claude Code / Antigravity / Grok，工具都在這台 Mac 執行。

用法：
  OpenCodex                         互動模式（預設 SSH 主機與 Codex 預設模型）
  OpenCodex -p "訊息" [-m 供應商:模型]   單輪模式，輸出最終回覆後結束
  OpenCodex ssh [list|add|remove <名稱>|use <名稱>]   管理 SSH 主機
  OpenCodex models                  列出已連線供應商的模型
  OpenCodex status                  顯示連線、登入與額度
  OpenCodex sessions                列出可接續的工作階段

選項：
  -m, --model 供應商:模型   例：codex:gpt-6.1-sol、claude:default、antigravity:gemini-3.8-flash、grok:grok-4.7-build-fast
      --effort 強度         none/minimal/low/medium/high/xhigh/max（依模型支援）
      --profile 名稱        SSH 主機（名稱、id 或 user@host）
  -C, --cwd 路徑            Mac 工作目錄（預設目前目錄）
      --permission 模式     ask（預設，逐項確認）/ project（可讀，寫入需確認）/ full（全部允許）
  -r, --resume id          接續先前的工作階段
      --trust-host 指紋     非互動模式信任新的主機金鑰
      --no-browser / --no-computer   不啟用瀏覽器／電腦工具
      --json               單輪模式以 JSON Lines 輸出事件

互動指令：
  /model [供應商:模型]   切換模型（無參數顯示選單；可在同一對話換另一家 AI）
  /ssh [list|use|add|remove|status]   管理與切換 SSH 主機
  /effort 強度           設定思考強度        /permission 模式   設定 Mac 工具權限
  /status  /quota        連線與額度          /models            模型清單
  /new  /sessions  /resume id   工作階段      /cwd               顯示工作目錄
  /stop  或 Ctrl+C       中止目前回合        /exit              離開`;
class App{
 constructor(options){
  this.options=options;this.drivers=new Map();this.sessionGrants=new Set();this.permissionMode=['ask','project','full'].includes(options.permission)?options.permission:(cfg.cliSettings().permissionMode||'ask');
  this.cwd=fs.realpathSync(options.cwd||process.cwd());if(!fs.statSync(this.cwd).isDirectory())throw Error('工作目錄必須是資料夾。');
  this.resources=cfg.resourcesPath();this.interactive=!options.prompt&&process.stdin.isTTY;this.current={provider:'codex',model:null,effort:options.effort||null};
  this.turn=null;this.sshState=null;
 }
 // ---------- SSH ----------
 async connectSsh(selector){
  const profile=ssh.pickProfile(selector||this.options.profile);
  if(this.sshState?.profile.id===profile.id&&!this.sshState.conn.destroyed)return this.sshState;
  if(this.turn)throw Error('請先等目前回合結束，再切換主機。');
  await this.closeProviders();
  if(this.sshState){const old=this.sshState;this.sshState=null;try{old.conn.end();}catch{}}
  ui.info('連線 SSH '+profile.username+'@'+profile.host+' …');
  this.sshState=await ssh.connect(profile,{interactive:process.stdin.isTTY,trustedFingerprint:this.options.trustHost});
  const state=this.sshState;
  state.conn.on('close',()=>{if(this.shuttingDown||this.sshState!==state)return;ui.warn('SSH 連線已中斷；指令不會自動重送。');for(const d of this.drivers.values())void d.stop().catch(()=>{});this.drivers.clear();this.sshState=null;if(this.turn)this.turn.resolve({status:'error',error:'SSH 連線已中斷'});});
  ui.ok('已連線 '+profile.name+'（'+this.sshState.platform+'）');
  const s=cfg.cliSettings();s.profileId=profile.id;cfg.saveCliSettings(s);
  if(this.session)this.session.profileId=profile.id;
  return this.sshState;
 }
 // ---------- providers ----------
 async provider(id,{quiet=false}={}){
  const existing=this.drivers.get(id);if(existing&&!existing.closed)return existing;
  if(!this.sshState)await this.connectSsh();
  const settings=cfg.settings(),profile=this.sshState.profile;
  const common={ssh:this.sshState,cwd:this.cwd,permissionMode:this.permissionMode,resources:this.resources,toolOptions:this.options.toolOptions,onEvent:e=>this.event(e),authorizeTool:call=>this.authorizeTool(call)};
  let driver;
  if(id==='codex'){const {CodexDriver}=require('./lib/providers/codex.cjs');driver=new CodexDriver({...common,executable:settings.codexConnections?.[profile.id]?.executable,approve:r=>this.approve(r),askUser:q=>ui.ask(q),version:CLI_VERSION});}
  else if(id==='claude'){const {ClaudeDriver}=require('./lib/providers/claude.cjs');driver=new ClaudeDriver({...common,connection:settings.claudeConnections?.[profile.id]||{authMode:'official'}});}
  else{const {ExternalDriver}=require('./lib/providers/external.cjs');driver=new ExternalDriver({...common,id});}
  if(!quiet)ui.info('啟動 '+PROVIDERS[id].label+' …');
  await driver.start();
  this.drivers.set(id,driver);
  const st=driver.status();
  if(!quiet)ui.ok(PROVIDERS[id].label+' 已連線'+(st.runtimeVersion?'（'+st.runtimeVersion+'）':'')+(st.account?.authenticated?'，已登入 '+(st.account.authMethod||''):'，'+ui.color.yellow('尚未登入')+(st.error?'：'+st.error:'')));
  return driver;
 }
 async closeProviders(){for(const d of this.drivers.values())await d.stop().catch(()=>{});this.drivers.clear();}
 async resolveModel(spec){
  const parsed=parseModel(spec)||{provider:this.current.provider,model:null};
  let provider=parsed.provider;
  if(!provider){for(const d of this.drivers.values())if(d.models().some(m=>m.model===parsed.model||m.id===parsed.model)){provider=d.id;break;}if(!provider)provider=this.current.provider;}
  const d=await this.provider(provider);
  const models=d.models();
  if(!models.length)throw Error(PROVIDERS[provider].label+' 尚未取得模型清單'+(d.status().error?'：'+d.status().error:'。'));
  const m=parsed.model?models.find(m=>m.model===parsed.model||m.id===parsed.model||m.displayName===parsed.model):models.find(m=>m.isDefault)||models[0];
  if(!m)throw Error('模型 '+parsed.model+' 不在 '+PROVIDERS[provider].label+' 提供的清單；輸入 /models 查看。');
  return {provider,model:m.model,info:m};
 }
 async setModel(spec){
  const r=await this.resolveModel(spec);
  if(this.current.provider!==r.provider&&this.turn)throw Error('目前回合仍在進行；請先 /stop。');
  this.current.provider=r.provider;this.current.model=r.model;
  const supported=(r.info.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort);
  if(this.current.effort&&!supported.includes(this.current.effort))this.current.effort=null;
  return r;
 }
 label(){return this.current.provider+':'+(this.current.model||'…')+(this.current.effort?' ['+this.current.effort+']':'');}
 // ---------- approvals ----------
 async authorizeTool(call){
  const key=call.provider+'|'+call.name;if(this.sessionGrants.has(key))return true;
  if(!process.stdin.isTTY)return false;
  const decision=await this.approve({provider:call.provider,title:'允許 '+PROVIDERS[call.provider].label+' 在這台 Mac 使用 '+call.name+'？',detail:JSON.stringify(call.arguments,null,2).slice(0,4000)});
  if(decision==='acceptForSession')this.sessionGrants.add(key);
  return decision!=='decline';
 }
 async approve(r){if(!process.stdin.isTTY){ui.warn('非互動模式無法確認：'+r.title+'（已拒絕；可用 --permission full）');return 'decline';}return ui.approve(r);}
 // ---------- events ----------
 event(e){
  const t=this.turn;
  if(this.options.json&&this.options.prompt&&!['message'].includes(e.type))process.stdout.write(JSON.stringify({at:Date.now(),...e,text:typeof e.text==='string'?e.text.slice(0,4000):e.text})+'\n');
  if(e.type==='closed'){ui.warn(PROVIDERS[e.provider]?.label+' 連線已關閉：'+(e.text||''));this.drivers.delete(e.provider);}
  if(!t||e.provider!==t.provider)return;
  if(e.type==='message'&&typeof e.text==='string'){t.record.assistant=e.text;if(!this.options.json)ui.stream(e.text);}
  else if(e.type==='tool'){
   if(e.status==='running'){if(!t.tools.has(e.itemId)){t.tools.set(e.itemId,{title:e.title||e.tool,status:'running'});if(!this.options.json)ui.tool({...e,title:e.title||e.tool});}}
   else{const rec=t.tools.get(e.itemId)||{title:e.title||e.tool};rec.status=e.status==='completed'?'completed':'failed';rec.output=String(e.text||'').slice(-4000);t.tools.set(e.itemId,rec);t.record.tools.push(rec);if(!this.options.json)ui.tool({...e,title:rec.title});}
  }
  else if(e.type==='session'&&e.conversationId)this.session.conversations[t.provider]=e.conversationId;
  else if(e.type==='error'&&e.text)t.error=e.text;
  else if(e.type==='activity'&&this.options.verbose)ui.info(e.text);
  else if(e.type==='done'){if(e.conversationId)this.session.conversations[t.provider]=e.conversationId;t.resolve({status:e.status,error:e.error||e.text||t.error});}
 }
 // ---------- turns ----------
 async send(text){
  if(this.turn)throw Error('上一回合尚未結束。');
  if(!this.current.model)await this.setModel(null);
  const provider=this.current.provider,driver=await this.provider(provider);
  const {text:prompt,handedOver}=this.session.prompt(provider,text);
  const record=this.session.begin({provider,label:PROVIDERS[provider].label,model:this.current.model,effort:this.current.effort,user:text});
  const started=Date.now();
  const turn={provider,record,tools:new Map(),error:null};
  const completion=new Promise(resolve=>{turn.resolve=resolve;});
  this.turn=turn;
  if(handedOver.length&&!this.options.json)ui.info('交接 '+handedOver.length+' 個其他模型的回合給 '+PROVIDERS[provider].label);
  if(!this.options.json)ui.startStream();
  this.tui?.setWorking(PROVIDERS[provider].label+' 工作中');
  try{
   await driver.send({requestId:record.id,prompt,model:this.current.model,effort:this.current.effort||undefined,conversationId:this.session.conversations[provider]||undefined});
   this.session.markSynced(provider,handedOver);
  }catch(e){this.turn=null;this.tui?.setWorking(null);this.session.finish(record,{status:'error',error:e.message});ui.endStream();throw e;}
  const result=await completion;
  this.turn=null;this.tui?.setWorking(null);
  if(!this.options.json)ui.endStream();
  this.session.finish(record,result);
  const secs=((Date.now()-started)/1000).toFixed(1);
  if(result.status==='completed'&&!this.options.json)ui.info(PROVIDERS[provider].label+' · '+this.current.model+' · '+secs+'s');
  else if(result.status==='cancelled')ui.warn('已中止（'+secs+'s）');
  else if(result.status!=='completed')ui.error((result.error||'回合失敗')+'（'+secs+'s）');
  return result;
 }
 async stop(){if(!this.turn)return false;const d=this.drivers.get(this.turn.provider);ui.warn('正在中止 '+PROVIDERS[this.turn.provider].label+' …');await d?.cancel().catch(()=>{});return true;}
 // ---------- info ----------
 async printStatus(){
  const s=this.sshState;
  ui.line(ui.color.bold('OpenCodex CLI '+CLI_VERSION));
  ui.line('SSH 主機：'+(s?s.profile.name+'（'+s.profile.username+'@'+s.profile.host+'，'+s.platform+'，指紋 '+s.fingerprint+'）':'未連線'));
  ui.line('Mac 工作目錄：'+this.cwd+'　權限：'+this.permissionMode+'　工作階段：'+this.session.id.slice(0,8));
  ui.line('目前模型：'+this.label());
  for(const id of Object.keys(PROVIDERS)){
   const d=this.drivers.get(id);
   if(!d){ui.line('  '+PROVIDERS[id].label.padEnd(12)+ui.color.dim('未啟動（/model '+id+' 可啟動）'));continue;}
   const st=d.status();const auth=st.account?.authenticated?ui.color.green('已登入 '+(st.account.authMethod||'')):ui.color.yellow('未登入'+(st.error?'：'+st.error:''));
   ui.line('  '+PROVIDERS[id].label.padEnd(12)+(st.connected?'已連線':'已關閉')+'  '+auth+'  模型 '+st.models.length+'  Mac 工具 '+(st.tools?.length||0));
  }
 }
 async printQuota(){
  for(const d of this.drivers.values()){
   const q=await d.refreshQuota().catch(e=>({error:e.message}));
   ui.line(ui.color.bold(PROVIDERS[d.id].label));
   if(!q){ui.line('  未提供額度資料');continue;}
   if(q.error)ui.line('  '+ui.color.yellow(q.error));
   if(q.raw)ui.line('  '+String(q.raw).split('\n').slice(0,30).join('\n  '));
   const windows=q.buckets?q.buckets.flatMap(b=>[['primary',b.primary],['secondary',b.secondary]].filter(([,w])=>w).map(([k,w])=>({name:(b.name||b.id)+' '+k,...w}))):(q.windows||[]);
   for(const w of windows){const reset=w.resetsAt?new Date((w.resetsAt>1e12?w.resetsAt:w.resetsAt*1000)).toLocaleString():'';ui.line('  '+String(w.name||w.id||'').padEnd(28)+(w.remainingPercent!=null?'剩餘 '+Math.round(w.remainingPercent)+'%':w.usedPercent!=null?'已用 '+Math.round(w.usedPercent)+'%':'')+(w.windowDurationMins?'  每 '+(w.windowDurationMins>=1440?Math.round(w.windowDurationMins/1440)+' 天':w.windowDurationMins>=60?Math.round(w.windowDurationMins/60)+' 小時':w.windowDurationMins+' 分'):'')+(reset?'  重置 '+reset:''));}
   if(!windows.length&&!q.raw&&!q.error)ui.line('  供應商未回報額度視窗');
  }
  if(!this.drivers.size)ui.line('尚未啟動任何供應商。');
 }
 // Collect models from connected providers; with all=true, start the others too (failures are reported, not fatal).
 async collectModels(all=false){
  const ids=all?Object.keys(PROVIDERS):[...this.drivers.keys()];const index=[];
  for(const id of ids){
   let d=this.drivers.get(id);
   if(!d&&all){try{d=await this.provider(id,{quiet:true});}catch(e){ui.line(ui.color.dim('  '+PROVIDERS[id].label+'：'+e.message));continue;}}
   if(!d)continue;
   for(const m of d.models())index.push({provider:id,model:m.model,displayName:m.displayName,isDefault:m.isDefault===true,efforts:(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort)});
  }
  return index;
 }
 async printModels(all=false){
  const index=await this.collectModels(all);
  if(!index.length){ui.line('尚無模型；先用 /model codex 或 /model claude 啟動供應商。');return [];}
  ui.table(index.map((m,i)=>[String(i+1)+')',m.provider+':'+m.model+(m.isDefault?' *':''),m.displayName!==m.model?m.displayName:'',m.efforts.join('/')]));
  return index;
 }
 // ---------- sessions (local CLI sessions + Codex threads on the runtime host) ----------
 when(ts){const d=new Date(ts||0);const same=d.toDateString()===new Date().toDateString();return same?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString([],{month:'numeric',day:'numeric'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
 // Providers the App handed a Codex thread to (from its unified-handoff records on this Mac).
 appHandoffProviders(){
  const map=new Map();const profile=this.sshState?.profile.id;
  for(const [provider,file] of [['claude','handoff/native-claude-threads.json'],['grok','handoff/grok/native-claude-threads.json'],['antigravity','handoff/antigravity/native-claude-threads.json']]){
   let entries;try{entries=cfg.readJson(path.join(cfg.appSupport,file),{}).entries||{};}catch{continue;}
   for(const [id,e] of Object.entries(entries)){if(e.deleted||(profile&&e.profile&&e.profile!==profile))continue;const rec=map.get(id)||{providers:new Set(),claudeSessions:new Set()};rec.providers.add(provider);if(provider==='claude'&&e.conversationId)rec.claudeSessions.add(e.conversationId);map.set(id,rec);}
  }
  return map;
 }
 async allSessions(){
  const local=Session.list().filter(s=>!this.sshState||!s.profileId||s.profileId===this.sshState.profile.id).map(s=>({key:'local:'+s.id,title:s.title||'（無標題）',updatedAt:s.updatedAt,detail:s.turns+' 回合 · '+(s.providers.map(p=>PROVIDERS[p]?.label||p).join('+')||'CLI'),codexThreadId:s.codexThreadId,claudeId:s.claudeId}));
  const knownCodex=new Set(local.map(s=>s.codexThreadId).filter(Boolean)),knownClaude=new Set(local.map(s=>s.claudeId).filter(Boolean));
  const handoff=this.appHandoffProviders();for(const rec of handoff.values())for(const id of rec.claudeSessions)knownClaude.add(id);
  const [codexResult,claudeResult]=await Promise.allSettled([
   this.provider('codex',{quiet:true}).then(d=>d.listThreads()),
   this.provider('claude',{quiet:true}).then(d=>d.listSessions()),
  ]);
  const remote=[];
  if(codexResult.status==='fulfilled')remote.push(...codexResult.value.filter(t=>!knownCodex.has(t.id)).map(t=>{const h=handoff.get(t.id);const names=['Codex',...(h?[...h.providers].map(p=>PROVIDERS[p].label):[])];return {key:'codex:'+t.id,title:t.title,updatedAt:t.updatedAt,detail:names.join('+')+(t.model?' · '+t.model:'')};}));
  else ui.warn('無法讀取主機上的 Codex 對話：'+codexResult.reason?.message);
  if(claudeResult.status==='fulfilled')remote.push(...claudeResult.value.filter(s=>!knownClaude.has(s.id)).map(s=>({key:'claude:'+s.id,title:s.title,updatedAt:s.updatedAt,detail:'Claude Code'+(s.cwd?' · '+s.cwd:'')})));
  else ui.warn('無法讀取主機上的 Claude Code 對話：'+claudeResult.reason?.message);
  return [...local,...remote].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
 }
 async resumeAny(key){
  let session;
  if(key.startsWith('local:'))session=Session.load(key.slice(6));
  else if(key.startsWith('codex:')){const d=await this.provider('codex',{quiet:true});const thread=await d.readThread(key.slice(6));session=Session.fromCodexThread(thread,{cwd:this.cwd,profileId:this.sshState?.profile.id});const merged=session.mergeAppHandoff(thread.id,this.sshState?.profile.id);if(merged)ui.info('已併入 App 中其他模型的 '+merged+' 個回合');session.save();}
  else if(key.startsWith('claude:')){const d=await this.provider('claude',{quiet:true});const id=key.slice(7);const data=await d.readSession(id);if(!data?.found)throw Error('主機上找不到這個 Claude Code 工作階段。');session=Session.fromClaudeSession(id,data,{cwd:this.cwd,profileId:this.sshState?.profile.id});session.save();}
  else{try{session=Session.load(key);}catch{const [codex,claude]=await Promise.allSettled([this.provider('codex',{quiet:true}).then(d=>d.listThreads(200)),this.provider('claude',{quiet:true}).then(d=>d.listSessions(200))]);const c=codex.status==='fulfilled'&&codex.value.find(t=>t.id===key||t.id.startsWith(key));if(c)return this.resumeAny('codex:'+c.id);const s=claude.status==='fulfilled'&&claude.value.find(t=>t.id===key||t.id.startsWith(key));if(s)return this.resumeAny('claude:'+s.id);throw Error('找不到工作階段：'+key);}}
  this.session=session;
  ui.ok('已接續 '+session.title.slice(0,50)+ui.color.dim('（'+session.turns.length+' 回合）'));
  const last=[...session.turns].reverse().find(t=>t.model);
  if(last){try{await this.setModel(last.provider+':'+last.model);if(last.effort)this.current.effort=last.effort;ui.info('模型 '+this.label());}catch{}}
  for(const t of session.turns.slice(-3)){this.tui?.user(t.user);if(t.assistant)for(const [i,l] of t.assistant.split('\n').slice(0,12).entries())ui.line((i?'  ':ui.color.green('• '))+l);}
  if(session.turns.length>3)ui.line(ui.color.dim('  （僅顯示最後 3 回合）'));
 }
 // ---------- slash commands ----------
 async command(line){
  const [cmd,...rest]=line.slice(1).trim().split(/\s+/);let arg=rest.join(' ').trim();
  switch(cmd){
   case 'help':case '?':ui.line(HELP);return;
   case 'exit':case 'quit':case 'q':return 'exit';
   case 'model':{
    if(arg){const r=await this.setModel(arg);ui.ok('模型 → '+this.label()+(r.info.displayName&&r.info.displayName!==r.model?'（'+r.info.displayName+'）':''));return;}
    const index=await this.collectModels(true);if(!index.length){ui.warn('尚未取得任何模型；請先確認 SSH 主機與登入狀態。');return;}
    const chosen=await ui.select({title:'選擇模型（切換供應商會把目前對話交接給新模型）',items:index.map(m=>({label:m.provider+':'+m.model,description:(m.displayName!==m.model?m.displayName:'')+(m.efforts.length?'  強度 '+m.efforts.join('/'):''),value:m.provider+':'+m.model,selected:m.provider===this.current.provider&&m.model===this.current.model}))});
    if(!chosen)return;
    const r=await this.setModel(chosen);
    if(r.info.supportedReasoningEfforts?.length){
     const efforts=r.info.supportedReasoningEfforts.map(e=>e.reasoningEffort);
     const effort=await ui.select({title:'思考強度 · '+this.current.provider+':'+this.current.model,items:[{label:'模型預設',description:r.info.defaultReasoningEffort||'',value:''},...efforts.map(e=>({label:e,value:e,selected:e===this.current.effort}))]});
     if(effort!==null)this.current.effort=effort||null;
    }
    ui.ok('模型 → '+this.label());return;
   }
   case 'models':await this.printModels(!!arg&&arg==='all');return;
   case 'effort':{
    if(!arg){
     const d=this.drivers.get(this.current.provider);const m=d?.models().find(m=>m.model===this.current.model);const supported=(m?.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort);
     if(!supported.length){ui.line('模型 '+this.label()+' 沒有可調整的思考強度。');return;}
     const chosen=await ui.select({title:'思考強度 · '+this.current.provider+':'+this.current.model,items:[{label:'模型預設',description:m.defaultReasoningEffort||'',value:''},...supported.map(e=>({label:e,value:e,selected:e===this.current.effort}))]});
     if(chosen===null)return;this.current.effort=chosen||null;ui.ok('思考強度 → '+(this.current.effort||'模型預設'));return;
    }
    if(arg==='default'||arg==='none'){this.current.effort=null;ui.ok('思考強度 → 模型預設');return;}
    if(!EFFORTS.includes(arg))throw Error('無效的思考強度：'+arg);
    const d=this.drivers.get(this.current.provider);const m=d?.models().find(m=>m.model===this.current.model);const supported=(m?.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort);
    if(supported.length&&!supported.includes(arg))throw Error('模型 '+this.current.model+' 支援的強度：'+supported.join('/'));
    this.current.effort=arg;ui.ok('思考強度 → '+arg);return;
   }
   case 'permission':case 'perm':{
    let mode=arg;
    if(!mode){mode=await ui.select({title:'Mac 工具權限（目前：'+this.permissionMode+'）',items:[{label:'ask',description:'每項命令、檔案變更與工具都先確認',value:'ask',selected:this.permissionMode==='ask'},{label:'project',description:'讀取不用確認；寫入與命令仍確認',value:'project',selected:this.permissionMode==='project'},{label:'full',description:'全部允許（危險）',value:'full',selected:this.permissionMode==='full'}]});if(!mode||mode===this.permissionMode)return;arg=mode;}
    if(!['ask','project','full'].includes(arg))throw Error('權限模式須為 ask、project 或 full。');
    if(this.turn)throw Error('請先等目前回合結束。');
    this.permissionMode=arg;const s=cfg.cliSettings();s.permissionMode=arg;cfg.saveCliSettings(s);
    if(this.drivers.size){ui.info('重新啟動已連線的供應商以套用權限 …');const ids=[...this.drivers.keys()];await this.closeProviders();for(const id of ids)await this.provider(id).catch(e=>ui.error(PROVIDERS[id].label+'：'+e.message));}
    ui.ok('權限 → '+arg);return;
   }
   case 'ssh':await this.sshCommand(rest);return;
   case 'status':await this.printStatus();return;
   case 'quota':case 'usage':await this.printQuota();return;
   case 'cwd':ui.line(this.cwd+'　（變更工作目錄請以 OpenCodex -C <路徑> 重新啟動）');return;
   case 'new':{if(this.turn)throw Error('請先等目前回合結束。');this.session=new Session({cwd:this.cwd,profileId:this.sshState?.profile.id});ui.ok('已開始新工作階段 '+this.session.id.slice(0,8));return;}
   case 'sessions':{const items=await this.allSessions();if(!items.length){ui.line('沒有可接續的工作階段。');return;}ui.table(items.slice(0,30).map(s=>[s.key.startsWith('local:')?'CLI':s.key.startsWith('claude:')?'Claude':'Codex',this.when(s.updatedAt),s.detail,s.title.slice(0,60)]));ui.line(ui.color.dim('輸入 /resume 以選單接續。'));return;}
   case 'resume':{
    if(this.turn)throw Error('請先等目前回合結束。');
    if(!arg){
     const items=(await this.allSessions()).filter(s=>s.key!=='local:'+this.session.id&&s.key!=='codex:'+(this.session.conversations.codex||''));
     if(!items.length){ui.line('沒有其他可接續的工作階段。');return;}
     arg=await ui.select({title:'接續哪個工作階段？（本機 CLI 與主機上的 Codex 對話）',items:items.slice(0,40).map(s=>({label:s.title.slice(0,60),description:this.when(s.updatedAt)+' · '+s.detail,value:s.key}))});
     if(!arg)return;
    }
    await this.resumeAny(arg);return;}
   case 'stop':if(!(await this.stop()))ui.line('目前沒有進行中的回合。');return;
   default:throw Error('未知指令 /'+cmd+'，輸入 /help 查看。');
  }
 }
 async sshCommand(args){
  const [sub,...rest]=args;const name=rest.join(' ').trim();
  const items=cfg.profiles();
  if(sub==='list'){
   if(!items.length){ui.line('尚無 SSH 主機。用 /ssh add 新增。');return;}
   ui.table(items.map(p=>[(this.sshState?.profile.id===p.id?'● ':'  ')+p.name,p.username+'@'+p.host+':'+(p.port||22),p.authType,p.runtimePlatform||'auto']));
   return;
  }
  if(!sub){
   const chosen=await ui.select({title:'SSH 主機（目前：'+(this.sshState?.profile.name||'未連線')+'）',items:[...items.map(p=>({label:p.name,description:p.username+'@'+p.host+':'+(p.port||22)+' · '+p.authType+' · '+(p.runtimePlatform||'auto'),value:'use:'+p.id,selected:this.sshState?.profile.id===p.id})),{label:'新增主機…',value:'add'},{label:'編輯主機…',value:'edit'},{label:'移除主機…',value:'remove'}]});
   if(!chosen)return;
   if(chosen.startsWith('use:')){const p=items.find(p=>p.id===chosen.slice(4));if(this.sshState?.profile.id===p.id){ui.line('已經連線到 '+p.name);return;}await this.connectSsh(p.id);this.current.model=null;await this.setModel(null).catch(e=>ui.warn(e.message));ui.ok('模型 '+this.label());return;}
   if(chosen==='add')return this.sshCommand(['add']);
   const target=await ui.select({title:chosen==='edit'?'編輯哪個主機？':'移除哪個主機？',items:items.map(p=>({label:p.name,description:p.username+'@'+p.host,value:p.name}))});
   if(!target)return;return this.sshCommand([chosen,target]);
  }
  if(sub==='status'){await this.printStatus();return;}
  if(sub==='use'||sub==='connect'){if(!name)throw Error('請提供主機名稱。');await this.connectSsh(name);this.current.model=null;return;}
  if(sub==='remove'||sub==='rm'||sub==='delete'){
   const p=items.find(p=>p.name===name||p.id===name);if(!p)throw Error('找不到主機：'+name);
   if(this.sshState?.profile.id===p.id)throw Error('此主機正在使用中，請先切換到其他主機。');
   const a=(await ui.question(ui.color.yellow('確定移除 '+p.name+'？[y/N] › '))).trim().toLowerCase();if(!['y','yes'].includes(a))return;
   cfg.writeJson(path.join(cfg.appSupport,'profiles.json'),items.filter(x=>x.id!==p.id));ui.ok('已移除 '+p.name);return;
  }
  if(sub==='add'||sub==='edit'){
   const previous=sub==='edit'?items.find(p=>p.name===name||p.id===name):null;if(sub==='edit'&&!previous)throw Error('找不到主機：'+name);
   const q=async(label,def)=>{const a=(await ui.question(ui.color.cyan(label+(def!==undefined&&def!==''?'（'+def+'）':'')+'› '))).trim();return a||def||'';};
   const input={id:previous?.id||crypto.randomUUID()};
   input.name=await q('名稱',previous?.name||name);input.host=await q('主機位址',previous?.host);input.port=Number(await q('連接埠',previous?.port||22));input.username=await q('SSH 使用者',previous?.username);
   const auth=(await q('認證方式 password/key/agent',previous?.authType||'password')).toLowerCase();input.authType=auth;
   if(auth==='key')input.keyPath=await q('私鑰完整路徑',previous?.keyPath||path.join(os.homedir(),'.ssh/id_ed25519'));
   input.runtimePlatform=(await q('主機系統 auto/posix/windows',previous?.runtimePlatform||'auto')).toLowerCase();
   let password;
   if(auth==='password'){const save=(await q('儲存密碼？y/N',previous?.savePassword?'y':'n')).toLowerCase();input.savePassword=['y','yes'].includes(save);if(input.savePassword){password=await ui.secret('SSH 密碼（留空保留原密碼）：');}}
   const {validateProfile}=require(path.join(cfg.repoRoot,'src/ssh-profiles.cjs'));const credentials=cfg.mod('profile-credentials.js');const storage=cfg.storage();
   const profile=credentials.saveCredentialProfile({...validateProfile(input),password:password||undefined},previous||undefined,v=>storage.encryptString(v).toString('base64'),storage.isEncryptionAvailable());
   const next=previous?items.map(p=>p.id===previous.id?profile:p):[profile,...items];
   cfg.writeJson(path.join(cfg.appSupport,'profiles.json'),next);ui.ok((previous?'已更新 ':'已新增 ')+profile.name);
   const use=(await q('立即連線？Y/n','y')).toLowerCase();if(['y','yes'].includes(use)){await this.connectSsh(profile.name);this.current.model=null;}
   return;
  }
  throw Error('用法：/ssh [list|use <名稱>|add|edit <名稱>|remove <名稱>|status]');
 }
 // ---------- main loops ----------
 banner(){
  const c=ui.color;const inner=Math.min((process.stdout.columns||80)-2,72);
  const home=os.homedir();const dir=this.cwd.startsWith(home)?'~'+this.cwd.slice(home.length):this.cwd;
  const host=this.sshState?this.sshState.profile.name+' ('+this.sshState.platform+')':'未連線';
  const row=s=>c.dim('│ ')+require('./lib/tui.cjs').pad(s,inner-4)+c.dim(' │');
  const lines=[c.dim('╭'+'─'.repeat(inner-2)+'╮'),row(c.bold('>_ OpenCodex CLI')+c.dim(' (v'+CLI_VERSION+')')),row(''),row(c.dim('model:     ')+this.label()+c.dim('   /model 切換')),row(c.dim('host:      ')+host+c.dim('   /ssh 切換')),row(c.dim('directory: ')+dir+c.dim('   權限 '+this.permissionMode)),c.dim('╰'+'─'.repeat(inner-2)+'╯')];
  for(const l of lines)ui.line(l);
  ui.line('');ui.line(c.dim('  描述一項任務就開始，或試試這些指令：'));ui.line('');
  for(const [n,d] of [['model','選擇模型與思考強度（可跨供應商接續同一對話）'],['ssh','管理或切換 SSH 主機'],['permission','設定在 Mac 上不需確認的操作'],['status','顯示目前工作階段設定'],['quota','查看各供應商剩餘額度']])ui.line('  '+c.bold('/'+n)+c.dim(' - '+d));
  ui.line('');
 }
 async tuiLoop(){
  const {Tui}=require('./lib/tui.cjs');
  const tui=new Tui({color:ui.color,title:'OpenCodex',hint:()=>this.label()+(this.sshState?' · '+this.sshState.profile.name:''),
   onSubmit:async text=>{
    if(text.startsWith('/')){try{if((await this.command(text))==='exit')await this.shutdown(0);}catch(e){ui.error(e.message);}return;}
    if(this.turn){tui.queue.push(text);ui.line(ui.color.dim('› 已排隊：'+text));tui.render();return;}
    await this.runTurn(text);
    while(tui.queue.length&&!this.shuttingDown)await this.runTurn(tui.queue.shift());
   },
   onInterrupt:()=>this.stop(),onExit:()=>this.shutdown(0)});
  this.tui=tui;ui.setSink(tui);tui.start();
  try{await this.connectSsh();await this.setModel(this.options.model||null);}catch(e){ui.error(e.message);ui.info('可用 /ssh 管理主機、/model 選擇模型後再開始。');}
  this.banner();
  if(this.pendingResume){const id=this.pendingResume;this.pendingResume=null;try{await this.resumeAny(id);}catch(e){ui.error(e.message);}}
  await new Promise(()=>{});
 }
 async runTurn(text){this.tui?.user(text);try{await this.send(text);}catch(e){ui.error(e.message);}}
 async repl(){
  if(process.stdin.isTTY&&process.stdout.isTTY&&!process.env.OPENCODEX_PLAIN)return this.tuiLoop();
  ui.line(ui.color.bold('OpenCodex CLI '+CLI_VERSION)+ui.color.dim('  · /help 查看指令，/model 切換模型（可跨供應商接續同一對話），/ssh 管理主機'));
  ui.line(ui.color.dim('Mac 工作目錄：'+this.cwd+'　權限：'+this.permissionMode));
  try{await this.connectSsh();await this.setModel(this.options.model||null);ui.ok('模型 '+this.label());}
  catch(e){ui.error(e.message);ui.info('可用 /ssh 管理主機、/model 選擇模型後再開始。');}
  const rl=ui.interface();let interrupts=0;
  rl.on('SIGINT',()=>{if(this.turn){void this.stop();return;}interrupts++;if(interrupts>=2){void this.shutdown(0);return;}ui.line('');ui.info('再按一次 Ctrl+C 離開，或輸入 /exit');});
  for(;;){
   let line;
   try{line=await ui.question(ui.color.magenta('OpenCodex ')+ui.color.dim('('+this.label()+') ')+ui.color.magenta('› '));}catch{break;}
   if(line===undefined||line===null)break;
   interrupts=0;line=line.trim();if(!line)continue;
   try{
    if(line.startsWith('/')){if((await this.command(line))==='exit')break;continue;}
    await this.send(line);
   }catch(e){ui.endStream();ui.error(e.message);}
  }
  await this.shutdown(0);
 }
 async once(text){
  await this.connectSsh();
  if(this.pendingResume){const id=this.pendingResume;this.pendingResume=null;await this.resumeAny(id);}
  await this.setModel(this.options.model||null);
  if(!this.options.json)ui.info('模型 '+this.label());
  const result=await this.send(text);
  if(this.options.json)process.stdout.write(JSON.stringify({type:'final',status:result.status,sessionId:this.session.id,text:this.turnText()})+'\n');
  await this.shutdown(result.status==='completed'?0:1);
 }
 turnText(){const t=this.session.turns.at(-1);return t?.assistant||'';}
 async shutdown(code){if(this.shuttingDown)return;this.shuttingDown=true;ui.endStream();if(this.tui){this.tui.setWorking(null);this.tui.stop();ui.setSink(null);}this.session?.save();await this.closeProviders();try{this.sshState?.conn.end();}catch{}ui.closeInterface();setTimeout(()=>process.exit(code),200).unref();}
}
async function main(){
 const o=parseArgs(process.argv.slice(2));
 if(o.version){console.log('OpenCodex CLI '+CLI_VERSION);return;}
 if(o.help){console.log(HELP);return;}
 cfg.ensureDirs();
 const sub=o._[0];
 if(sub==='ssh'&&(o._[1]===undefined||o._[1]==='list')){const items=cfg.profiles();if(!items.length){console.log('尚無 SSH 主機。執行 OpenCodex ssh add 新增。');return;}ui.table(items.map(p=>[p.name,p.username+'@'+p.host+':'+(p.port||22),p.authType,p.runtimePlatform||'auto']));return;}
 const app=new App(o);
 app.session=new Session({cwd:app.cwd});
 if(sub==='sessions'){await app.connectSsh();const items=await app.allSessions();if(!items.length){console.log('沒有可接續的工作階段。');}else ui.table(items.slice(0,40).map(s=>[s.key.startsWith('local:')?'CLI':s.key.startsWith('claude:')?'Claude':'Codex',app.when(s.updatedAt),s.detail,s.key.replace(/^(local|codex|claude):/,'').slice(0,8),s.title.slice(0,60)]));await app.shutdown(0);return;}
 if(o.resume){try{app.session=Session.load(o.resume);const last=[...app.session.turns].reverse().find(t=>t.model);if(last&&!o.model)o.model=last.provider+':'+last.model;}catch{app.pendingResume=o.resume;}}
 process.on('unhandledRejection',e=>{ui.error('內部錯誤：'+(e?.message||e));});
 if(sub==='ssh'){await app.sshCommand(o._.slice(1));await app.shutdown(0);return;}
 if(sub==='models'){await app.connectSsh();await app.printModels(true);await app.shutdown(0);return;}
 if(sub==='status'){await app.connectSsh();try{await app.provider('codex',{quiet:true});}catch(e){ui.warn('Codex：'+e.message);}await app.printStatus();await app.printQuota();await app.shutdown(0);return;}
 if(sub==='quota'){await app.connectSsh();for(const id of Object.keys(PROVIDERS)){try{await app.provider(id,{quiet:true});}catch{}}await app.printQuota();await app.shutdown(0);return;}
 if(o.prompt!==undefined){await app.once(o.prompt||o._.join(' '));return;}
 if(sub&&!sub.startsWith('/'))throw Error('未知子命令：'+sub+'（輸入 OpenCodex --help）');
 await app.repl();
}
main().catch(e=>{ui.error(e.message||String(e));process.exit(1);});
