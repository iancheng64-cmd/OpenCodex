;(()=>{
 const {ipcRenderer,contextBridge}=require('electron');
 let state=ipcRenderer.sendSync('opencodex:initial-state'),profiles=[],selected=null,busy=false;
 const listeners=new Set(),isRemote=()=>state?.mode==='ssh'||state?.mode==='bridge';
 const toolsReady=()=>state.sshAgent==='claude'?state.executor===true:state.toolsReady===true;
 const canSubmit=()=>isRemote()&&!state.connecting&&state.connected===true&&toolsReady()&&(state.sshAgent!=='claude'||state.authentication?.status==='authenticated');
 const invoke=(name,value)=>ipcRenderer.invoke('opencodex:'+name,value);
 function received(s){const previous=state?.error||state?.diagnostic;if(previous&&previous!==(s.error||s.diagnostic)&&$('oc-error')?.textContent===previous)text('oc-error','');state=s;for(const fn of listeners)fn(canSubmit());if(document.readyState!=='loading')renderStatus();}
 ipcRenderer.on('opencodex:status',(_e,s)=>received(s));
 contextBridge.exposeInMainWorld('openCodexRuntime',{
  canSubmit,isRemote,isBridge:isRemote,subscribe:fn=>{listeners.add(fn);fn(canSubmit());return()=>listeners.delete(fn);},
  status:()=>invoke('status'),openConnections:()=>openPanel()
 });
 const $=id=>document.getElementById(id),text=(id,v)=>{const e=$(id);if(e&&e.textContent!==v)e.textContent=v;};
 const escClose=()=>{$('oc-connections')?.close();$('opencodex-ssh')?.focus();};
 function error(e){text('oc-error',(e.message||String(e)).replace(/^Error invoking remote method '[^']+': Error: /,''));}
 async function action(fn){if(busy)return;busy=true;renderStatus();text('oc-error','');try{await fn();}catch(e){error(e);}finally{busy=false;renderStatus();}}
 function make(tag,cls,value){const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;}
 const icon='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="15" rx="3"/><path d="m7 8 3 3-3 3m6 0h4"/></svg>';
 async function switchEngine(engine){
  const current=isRemote()&&state.sshAgent==='claude'?'claude':'codex';
  if(engine===current)return;
  await action(async()=>{try{await invoke('mode',{engine});}catch(e){await openPanel();throw e;}});
 }
 function mountSidebar(){
  const header=document.querySelector('aside nav[class*="_Navigation_"] > div[class*="_header_"]');
  const rail=document.querySelector('aside nav[class*="sidebar-rail"] [data-appearance="plain"]');
  const target=header||rail;if(!target)return;
  let engines=$('opencodex-engines');
  if(!engines){
   engines=make('div','oc-engines');engines.id='opencodex-engines';engines.setAttribute('role','group');engines.setAttribute('aria-label','Agent 工作區');
   for(const [engine,label] of [['codex','GPT Codex'],['claude','Claude Code']]){
    const b=make('button','oc-engine',label);b.id='opencodex-engine-'+engine;b.type='button';b.onclick=()=>switchEngine(engine);engines.append(b);
   }
  }
  engines.classList.toggle('oc-rail',!header);
  if(engines.parentElement!==target)target.append(engines);
  const active=isRemote()&&state.sshAgent==='claude'?'claude':'codex';
  for(const engine of ['codex','claude']){
   const b=$('opencodex-engine-'+engine),selected=engine===active;
   b.setAttribute('aria-pressed',String(selected));b.disabled=busy||state.connecting||state.permissionBusy;
   b.title=selected?'目前工作區':(engine==='codex'?'開啟 GPT Codex':'開啟 Claude Code')+'；重新啟動並保留各自對話';
  }
  let button=$('opencodex-ssh');
  if(!button){button=make('button','oc-sidebar');button.id='opencodex-ssh';button.type='button';button.innerHTML=icon+'<span>SSH 連線</span><i aria-hidden="true"></i>';button.setAttribute('aria-haspopup','dialog');button.onclick=openPanel;}
  button.classList.toggle('oc-rail',!header);
  if(button.parentElement!==target)target.append(button);
  let hint=$('opencodex-connection-hint');
  if(!hint){hint=make('button','oc-connection-hint');hint.type='button';hint.id='opencodex-connection-hint';hint.setAttribute('role','status');hint.onclick=openPanel;}
  const toolsPending=isRemote()&&state.connected&&!toolsReady();
  const disconnected=isRemote()&&!state.connected,needsLogin=isRemote()&&state.sshAgent==='claude'&&state.connected&&state.authentication?.status!=='authenticated';
  hint.hidden=!(disconnected||toolsPending||needsLogin)||!header;
  const label=state.connecting?'正在連線…':toolsPending?'Mac 工具未就緒 · 查看原因':needsLogin?'Claude 登入待確認 · 查看設定':state.error?'連線失敗 · 按此重試':'尚未連線 · 選擇主機';
  if(hint.textContent!==label)hint.textContent=label;
  if(hint.parentElement!==target)target.append(hint);
  button.dataset.fullAccess=String(isRemote()&&state.fullAccess===true);
  const caption=button.querySelector('span'),captionText=isRemote()&&state.fullAccess?'SSH 連線 · 最高權限':'SSH 連線';
  // The sidebar is observed for child mutations. Unchanged text must not enqueue itself.
  if(caption&&caption.textContent!==captionText)caption.textContent=captionText;
  button.dataset.connected=String(isRemote()&&state.connected);button.title=isRemote()&&state.connected?'已連線 · '+state.profile:'主機與連線模式';
 }
 function period(min,kind){return min==null?(kind==='primary'?'主要額度':'次要額度'):min%1440===0?min/1440+' 天':min%60===0?min/60+' 小時':min+' 分鐘';}
 const when=n=>new Date(n).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
 function renderQuota(){
  for(const slot of document.querySelectorAll('[data-opencodex-quota]')){
   const q=state.quota||{},signature=JSON.stringify(q);if(slot.dataset.signature===signature)continue;
   slot.dataset.signature=signature;slot.className='oc-quota';slot.replaceChildren();
   const top=make('div','oc-row'),title=make('strong','','使用情況'),refresh=make('button','oc-quiet','更新');
   refresh.type='button';refresh.onclick=e=>{e.stopPropagation();refresh.disabled=true;invoke('quota').then(received).catch(error).finally(()=>refresh.disabled=false);};
   top.append(title,refresh);slot.append(top);
   slot.append(make('div','oc-muted',q.account?.email||(state.sshAgent==='claude'?'遠端 Claude 帳號':'遠端 Codex 帳號')));
   slot.append(make('div','oc-muted',q.source||'SSH 尚未連線'));
   if(q.status==='available'||q.quota){
    for(const bucket of q.quota?.buckets||[]){
     if((q.quota?.buckets?.length||0)>1)slot.append(make('strong','oc-bucket',bucket.name));
     for(const kind of ['primary','secondary']){
      const w=bucket[kind];if(!w)continue;
      const row=make('div','oc-row oc-window'),n=w.remainingPercent;
      row.append(make('span','',period(w.windowDurationMins,kind)),make('span','',typeof n==='number'?Math.round(n*10)/10+'% 剩餘':'未提供'));
      slot.append(row);
      if(typeof n==='number'){const meter=make('progress');meter.max=100;meter.value=n;meter.setAttribute('aria-label',period(w.windowDurationMins,kind)+'剩餘額度');slot.append(meter);}
      if(w.resetsAt!=null)slot.append(make('div','oc-muted','重置 '+when(w.resetsAt*1000)));
     }
    }
   }
   slot.append(make('div','oc-muted oc-updated',q.status==='loading'?'正在讀取帳號與額度…':q.stale?(q.error||(q.status==='disconnected'?'未連線，無法更新額度':'額度資料已過期，正在更新…')):(q.quota?.updatedAt?'更新 '+when(q.quota.updatedAt)+' · 每 30 秒同步':'正在讀取…')));
   if(q.stale&&q.quota)slot.append(make('div','oc-warning','上次取得的額度，非最新資料'));
  }
 }
 function renderApprovals(){
  const list=$('oc-approval-grants');if(!list)return;
  const grants=(state.approvalGrants||[]),signature=JSON.stringify(grants);
  text('oc-approval-error',state.approvalError||'');
  if(list.dataset.signature!==signature){
   list.dataset.signature=signature;list.replaceChildren();
   if(!grants.length)list.append(make('p','oc-muted','尚未記住任何工具權限。'));
   for(const grant of grants){
    const row=make('div','oc-grant'),info=make('div','oc-grant-info'),revoke=make('button','oc-button','撤銷');
    info.append(make('strong','',grant.tool),make('div','oc-muted',grant.hostLabel+' · '+(grant.mode==='project'?'專案權限':'逐次詢問')),make('div','oc-muted',grant.cwd));
    revoke.type='button';revoke.dataset.action='revoke';revoke.dataset.grantId=grant.id;revoke.setAttribute('aria-label','撤銷 '+grant.tool);
    revoke.onclick=()=>action(async()=>{received(await invoke('approval-revoke',grant.id));text('oc-feedback',state.fullAccess?'已撤銷單一工具授權；最高權限仍開啟。關閉最高權限後恢復對話的權限設定。':'已撤銷；此工具下次使用時會重新詢問。');});
    row.append(info,revoke);list.append(row);
   }
  }
 }
 function renderStatus(){
  mountSidebar();renderQuota();if(!$('oc-connections'))return;renderApprovals();
  text('oc-status',state.connecting?'正在連線…':isRemote()?(state.connected?'已連線至 '+state.profile:'尚未連線'):state.mode==='official'?'官方登入模式':'自訂 API 模式');
  text('oc-active-engine',(isRemote()&&state.sshAgent==='claude'?'Claude Code':'GPT Codex')+' 工作區 · 兩種 Agent 各自保留對話與模型');
  text('oc-runtime',isRemote()&&state.connected?'遠端 '+(state.sshAgent==='claude'?'Claude Code':'Codex')+' '+(state.runtimeVersion||'')+' · 本機工具 '+(toolsReady()?'就緒':'未就緒'):'透過 SSH 使用遠端 '+(state.sshAgent==='claude'?'Claude Code':'Codex')+'，在這台 Mac 執行工具');
  const peers=state.agents?.peers||{},other=state.sshAgent==='claude'?'codex':'claude',peer=peers[other];
  const auth=state.sshAgent==='claude'?state.authentication?.status:peers.claude?.authentication;
  $('oc-agents-section').hidden=!isRemote();
  text('oc-agents-state',state.agents?.activity||['codex','claude'].map(a=>(a==='codex'?'Codex':'Claude')+'：'+(!peers[a]?.connected?'尚未連線':peers[a].host+(a==='claude'&&peers[a].authentication!=='authenticated'?' · 登入待確認':' · 已連線'))).join(' ／ '));
  text('oc-peer-connect','連接協作 '+(other==='claude'?'Claude':'Codex'));
  $('oc-peer-connect').disabled=busy||state.connecting||state.permissionBusy||!state.connected||!selected;
  $('oc-peer-disconnect').hidden=!peer?.connected;$('oc-peer-disconnect').disabled=busy||state.connecting||state.permissionBusy;
  $('oc-agents-stop').hidden=!state.agents?.busy;
  text('oc-claude-auth-state',!peers.claude?.connected?'連線後檢查遠端 Claude 登入。':auth==='authenticated'?'遠端 Claude 已登入，可開始對話。':auth==='required'?'遠端 Claude 尚未登入。請在該主機以相同 SSH 使用者登入 Claude Code，再重新檢查。':'無法確認遠端 Claude 登入狀態，請重新檢查或核對設定資料夾。');
  $('oc-claude-check').disabled=busy||state.connecting||!peers.claude?.connected;
  if(state.error||state.diagnostic)text('oc-error',state.error||state.diagnostic);
  for(const el of document.querySelectorAll('#oc-connections [data-action]'))el.disabled=busy||state.connecting;
  $('oc-full-access-section').hidden=!isRemote();
  const access=$('oc-full-access');access.setAttribute('aria-checked',String(state.fullAccess===true));access.textContent=state.fullAccess?'已開啟 · 關閉':'開啟';
  access.disabled=busy||state.connecting||state.permissionBusy||!isRemote();
  text('oc-access-state',state.permissionBusy?'工作進行中，停止後即可切換。':state.fullAccess?'已開啟：所有 SSH 對話使用完整權限。':'已關閉：依各對話權限及已記住的工具授權執行。');
  $('oc-disconnect').hidden=!isRemote()||!state.connected;
  $('oc-connect').disabled=busy||state.connecting||!selected||!isRemote();
  $('oc-delete').disabled=busy||state.connecting||!selected||(state.connected&&selected.id===state.profileId||peer?.connected&&selected.id===peer.profileId);
  $('oc-mode-hint').hidden=isRemote();
  $('oc-confirm').hidden=!state.hostConfirmation;
  const c=state.hostConfirmation;
  if(c){text('oc-confirm-title',c.hostChanged?'主機金鑰已變更':'首次連線：確認主機金鑰');text('oc-fingerprint',c.host+':'+c.port+'\n'+c.hostFingerprint+(c.previousFingerprint?'\n先前：'+c.previousFingerprint:''));}
  for(const row of document.querySelectorAll('.oc-host')){row.dataset.active=String(row.dataset.id===selected?.id);row.dataset.connected=String(state.connected&&row.dataset.id===state.profileId);}
 }
 function drawProfiles(){
  const list=$('oc-hosts');list.replaceChildren();
  for(const p of profiles){const b=make('button','oc-host');b.type='button';b.dataset.id=p.id;b.append(make('strong','',p.name),make('small','',p.username+'@'+p.host));b.onclick=()=>edit(p);list.append(b);}
  if(!profiles.length)list.append(make('p','oc-muted','新增主機，開始連線。'));
  renderStatus();
 }
 function edit(p){
  selected=p||{id:crypto.randomUUID(),name:'',host:'',port:22,username:'',authType:'password',keyPath:'',runtimePlatform:'auto',savePassword:false};
  for(const key of ['name','host','port','username','authType','keyPath','runtimePlatform'])$('oc-'+key).value=selected[key]|| (key==='runtimePlatform'?'auto':'');
  $('oc-codex-executable').value=state.codexConnections?.[selected.id]?.executable||'';
  const claude=state.claudeConnections?.[selected.id]||{};$('oc-claude-config').value=claude.configDir||'';$('oc-claude-auth').value=claude.authMode||'official';
  $('oc-password').value='';$('oc-password').placeholder=selected.hasSavedPassword?'已儲存；留白沿用原密碼':'SSH 密碼';
  $('oc-savePassword').checked=!!selected.savePassword;
  text('oc-form-title',p?'主機設定':'新增主機');text('oc-error','');toggleAuth();renderStatus();
 }
 function toggleAuth(){const a=$('oc-authType').value;$('oc-password-row').hidden=a!=='password';$('oc-key-row').hidden=a!=='key';}
 async function saveProfile(){
  const input={...selected};for(const key of ['name','host','port','username','authType','keyPath','runtimePlatform'])input[key]=$('oc-'+key).value;
  input.codexExecutable=$('oc-codex-executable').value;input.password=$('oc-password').value;input.savePassword=$('oc-savePassword').checked;input.networkMode='direct';
  profiles=await invoke('profile-save',input);selected=profiles.find(p=>p.id===input.id);drawProfiles();return input.password;
 }
 async function openPanel(){
  if(!$('oc-connections'))return;
  if(!$('oc-connections').open)$('oc-connections').showModal();
  $('oc-mode').value=state.mode==='bridge'?'ssh':state.mode;$('oc-agent').value=state.sshAgent||'codex';toggleMode();
  $('oc-cwd').value=state.cwd||'';
  try{profiles=await invoke('profiles');drawProfiles();edit(profiles.find(p=>p.id===state.profileId)||profiles[0]||null);}catch(e){error(e);}
  $('oc-close').focus();
 }
 function toggleMode(){$('oc-api').hidden=$('oc-mode').value!=='custom';$('oc-agent-row').hidden=$('oc-mode').value!=='ssh';$('oc-claude-settings').hidden=$('oc-mode').value!=='ssh';}
 window.addEventListener('DOMContentLoaded',()=>{
  const style=make('style');style.textContent=/*OPEN_CODEX_STYLES*/'';document.head.append(style);
  const panel=make('dialog','oc-panel');panel.id='oc-connections';panel.setAttribute('aria-labelledby','oc-title');
  panel.innerHTML=/*OPEN_CODEX_PANEL*/'';
  document.body.append(panel);
  $('oc-close').onclick=escClose;
  panel.addEventListener('close',()=>{$('oc-password').value='';$('oc-apiKey').value='';});
  $('oc-authType').onchange=toggleAuth;$('oc-mode').onchange=toggleMode;$('oc-agent').onchange=toggleMode;
  $('oc-claude-check').onclick=()=>action(async()=>received(await invoke('claude-status')));
  $('oc-new').onclick=()=>{edit(null);$('oc-name').focus();};
  $('oc-save').onclick=()=>action(async()=>{await saveProfile();$('oc-password').value='';text('oc-feedback','主機設定已儲存');});
  $('oc-connect').onclick=()=>action(async()=>{const password=await saveProfile();received(await invoke('connect',{profileId:selected.id,cwd:$('oc-cwd').value,password,claude:{authMode:$('oc-claude-auth').value,configDir:$('oc-claude-config').value}}));$('oc-password').value='';});
  $('oc-peer-connect').onclick=()=>action(async()=>{const password=await saveProfile();received(await invoke('connect',{peer:true,profileId:selected.id,cwd:$('oc-cwd').value,password,claude:{authMode:$('oc-claude-auth').value,configDir:$('oc-claude-config').value}}));$('oc-password').value='';});
  $('oc-peer-disconnect').onclick=()=>action(async()=>received(await invoke('peer-disconnect')));
  $('oc-agents-stop').onclick=()=>action(async()=>received(await invoke('agents-cancel')));
  $('oc-full-access').onclick=()=>action(async()=>{received(await invoke('full-access',state.fullAccess!==true));text('oc-feedback',state.fullAccess?'最高權限已保存。':'最高權限已關閉，恢復對話權限。');});
  $('oc-disconnect').onclick=()=>action(async()=>received(await invoke('disconnect')));
  $('oc-delete').onclick=()=>action(async()=>{if(!selected)return;const id=selected.id;if(!window.confirm('刪除主機「'+selected.name+'」的連線設定？'))return;profiles=await invoke('profile-delete',id);drawProfiles();edit(profiles[0]||null);});
  $('oc-trust').onclick=()=>action(async()=>{const c=state.hostConfirmation;if(c)received(await invoke('connect',{profileId:c.profileId,confirmationId:c.id}));});
  $('oc-reject').onclick=()=>action(async()=>received(await invoke('cancel-confirmation')));
  $('oc-apply-mode').onclick=()=>action(async()=>{if($('oc-mode').value===state.mode&&$('oc-agent').value===(state.sshAgent||'codex'))return;await invoke('mode',{mode:$('oc-mode').value,sshAgent:$('oc-agent').value,baseUrl:$('oc-baseUrl').value,model:$('oc-model').value,apiKey:$('oc-apiKey').value});});
  let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;mountSidebar();renderQuota();});}).observe(document.body,{childList:true,subtree:true});
  invoke('status').then(received).catch(error);mountSidebar();
 });
 ipcRenderer.on('opencodex:open-connections',openPanel);
})();