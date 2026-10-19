const $=id=>document.getElementById(id);
const pct=n=>typeof n==='number'&&Number.isFinite(n)?Math.round(n*10)/10+'%':'未提供';
function period(mins,kind){if(mins==null)return kind==='primary'?'主要額度':'次要額度';return mins%1440===0?mins/1440+' 天':mins%60===0?mins/60+' 小時':mins+' 分鐘';}
function time(n){return typeof n==='number'?new Date(n).toLocaleString('zh-TW',{hour12:false}):'尚未更新';}
function render(s){
 $('state').textContent=s.mode==='ssh'?(s.connected?'已連線至 '+s.profile+' · Mac Executor '+((s.sshAgent==='claude'?s.executor:s.toolsReady)?'就緒':'未就緒'):'SSH 尚未連線'):(s.mode==='official'?'官方登入模式':'自訂 API 模式');
 $('error').textContent=s.error||s.diagnostic||'';
 $('reconnect').hidden=s.mode!=='ssh';
 const q=s.quota||{},a=q.account;
 $('account').textContent=a?(a.email|| (a.type==='apiKey'?'API Key 帳號':'已登入帳號'))+(a.plan?' · '+a.plan:''):'尚未取得帳號';
 $('source').textContent=q.source||(s.mode==='ssh'?'遠端 Codex 帳號':'本機帳號');
 $('quota-state').textContent=q.status==='available'&&!q.stale?'已同步 · 每 30 秒更新':q.status==='disconnected'?'連線中斷，無法取得最新額度':q.error||'正在讀取額度…';
 $('quota-state').dataset.stale=String(!!q.stale);
 $('updated').textContent='資料更新：'+time(q.quota?.updatedAt)+(q.stale&&q.quota?'（上次取得，非即時資料）':'');
 $('buckets').replaceChildren();
 for(const bucket of q.quota?.buckets||[]){
  const group=document.createElement('div');group.className='bucket';
  const title=document.createElement('strong');title.textContent=bucket.name;group.append(title);
  for(const kind of ['primary','secondary']){
   const w=bucket[kind];if(!w)continue;
   const row=document.createElement('div');row.className='quota-row';
   const text=document.createElement('div');text.textContent=period(w.windowDurationMins,kind)+' · 剩餘 '+pct(w.remainingPercent);row.append(text);
   if(typeof w.remainingPercent==='number'){const meter=document.createElement('progress');meter.max=100;meter.value=w.remainingPercent;meter.setAttribute('aria-label',period(w.windowDurationMins,kind)+' 剩餘額度');row.append(meter);}
   const reset=document.createElement('div');reset.className='hint';reset.textContent='重置：'+(w.resetsAt!=null?time(w.resetsAt*1000):'未提供');row.append(reset);group.append(row);
  }
  $('buckets').append(group);
 }
}
function error(e){$('error').textContent=e.message||String(e);}
window.openCodex.status().then(s=>{render(s);$('mode').value=s.mode;toggle();}).catch(error);
window.openCodex.onStatus(render);function toggle(){$('api').style.display=$('mode').value==='custom'?'block':'none';}
$('mode').onchange=toggle;
$('manager').onclick=()=>window.openCodex.manager().catch(error);
$('refresh').onclick=async()=>{try{$('refresh').disabled=true;render(await window.openCodex.refreshQuota());}catch(e){error(e);}finally{$('refresh').disabled=false;}};
$('reconnect').onclick=async()=>{try{$('reconnect').disabled=true;render(await window.openCodex.reconnect());}catch(e){error(e);}finally{$('reconnect').disabled=false;}};
$('apply').onclick=()=>window.openCodex.mode({mode:$('mode').value,baseUrl:$('url').value,model:$('model').value,apiKey:$('key').value}).catch(error);
setInterval(()=>window.openCodex.status().then(render).catch(()=>{}),10000);
