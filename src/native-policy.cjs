'use strict';
const profiles={':read-only':'ask',':workspace':'project',':danger-full-access':'full'};
const {profileFor}=require('./native-permissions-runtime.cjs');
const guardian=require('./native-guardian-runtime.cjs');
function profileId(mode){return profileFor(mode)||Object.keys(profiles).find(id=>profiles[id]===mode);}
function selectedMode(params={}){
 if(params.approvalsReviewer!=null)guardian.reviewer(params.approvalsReviewer);
 if(params.permissions!=null){
  if(Object.hasOwn(profiles,params.permissions))return profiles[params.permissions];
  const mode='custom:'+params.permissions;
  if(typeof params.permissions!=='string')throw Error('無效的自訂權限設定檔。');
  profileFor(mode);return mode;
 }
 const value=params.sandboxPolicy?.type||params.sandbox;
 if(value==null)return null;
 const modes={'read-only':'ask',readOnly:'ask','workspace-write':'project',workspaceWrite:'project','danger-full-access':'full',dangerFullAccess:'full'};
 if(!Object.hasOwn(modes,value))throw Error('SSH 模式不支援此沙盒設定。');
 return modes[value];
}
async function localApproval({event,runtime,respond,show,isPending,grants,getScope=()=>null,onChange=()=>{},onError=()=>{}}){
 if(event.type!=='approval'||!runtime?.run?.openCodex||!isPending())return false;
 const active=runtime.requests?.get(event.approvalId)?.openCodexRun||runtime.run,scope=getScope(),revision=grants?.revision;
 const current=()=>isPending()&&(active.parentThreadId?runtime.openCodexSubagents?.isActive(active):runtime.run===active)&&!runtime.closed&&!active.cancelled&&!active.backgroundTextOnly;
 const sameScope=()=>scope&&require('./native-approvals.cjs').idFor(getScope())===require('./native-approvals.cjs').idFor(scope);
 const controller=new AbortController();let monitor;
 try{
  if(grants&&scope&&grants.has(scope)&&current()&&sameScope())return respond('accept');
  const remember=!!(grants&&scope);
  const explanation=remember?'永遠允許的範圍：'+scope.hostLabel+' · '+scope.cwd+'\n工具：'+scope.tool+'\n此工具之後的操作不再逐次詢問；若為程式執行工具，也包含之後執行的程式碼。可在 SSH 連線 → 已記住的工具權限撤銷。\n\n':'';
  // Dismiss native sheets when their request expires, including Stop and disconnect.
  monitor=setInterval(()=>{if(!current()||(scope&&!sameScope())||grants?.revision!==revision)controller.abort();},100);
  const result=await show({signal:controller.signal,type:'question',title:'OpenCodex 工具權限',message:event.title||'允許在這台 Mac 執行工具？',detail:explanation+(event.detail||'').slice(0,8000),buttons:remember?['拒絕','允許這次','永遠允許此工具']:['拒絕','允許這次'],defaultId:0,cancelId:0,noLink:true});
  if(!isPending())return false;
  if(!current()||(scope&&!sameScope()))return respond('decline');
  if(result.response===2&&remember){
   if(grants.revision!==revision)return respond('decline');
   grants.remember(scope);onChange();return respond('accept');
  }
  return respond(result.response===1?'accept':'decline');
 }catch(error){onError(error);if(isPending())return respond('decline');return false;}
 finally{clearInterval(monitor);}
}
function resolveMode(params,remembered,settings){
 const requested=selectedMode(params)||remembered||settings.permissionMode||'project';
 profileFor(requested);
 return {requested,effective:settings.fullAccess===true?'full':requested};
}
function resolveSelection(params,remembered,settings){
 return {...resolveMode(params,remembered?.permissionMode,settings),
  reviewer:guardian.reviewer(params.approvalsReviewer??remembered?.approvalsReviewer??settings.approvalsReviewer)};
}
async function setFullAccess({enabled,settings,busy,apply,save}){
 if(typeof enabled!=='boolean')throw Error('無效的最高權限設定。');
 if(busy)throw Error('請先停止目前工作，再切換最高權限。');
 const previous=settings.fullAccess===true;
 if(previous===enabled)return;
 const restore=settings.permissionMode||'project';
 await apply(enabled?'full':restore);
 settings.fullAccess=enabled;
 try{save();}catch(error){settings.fullAccess=previous;await apply(previous?'full':restore);throw error;}
}
// The renderer reuses these snapshots as the next turn's permissions. The peer's
// read-only sandbox isolates its own computer; it is not the Mac user's choice.
// Keep the requested mode here: fullAccess is a separate executor override and
// must not overwrite the choice that is restored when that override is disabled.
function localSnapshot(snapshot,selection,cwd,verified){
 if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))return snapshot;
 // The peer reports its own working directory; the renderer must only ever see the Mac project.
 if(typeof snapshot.cwd==='string'&&typeof cwd==='string'&&cwd.startsWith('/')&&snapshot.cwd!==cwd)snapshot={...snapshot,cwd};
 if(snapshot.threadSettings)return {...snapshot,threadSettings:localSnapshot(snapshot.threadSettings,selection,cwd,verified)};
 const hasSandbox=Object.hasOwn(snapshot,'sandbox'),hasPolicy=Object.hasOwn(snapshot,'sandboxPolicy');
 if(!hasSandbox&&!hasPolicy)return snapshot;
 const mode=typeof selection==='string'?selection:selection?.requested;
 const reviewer=guardian.reviewer(typeof selection==='string'?undefined:selection?.reviewer);
 const custom=profileFor(mode),id=profileId(mode);
 if(custom){
  // Highest access is an explicit executor override. Keep the requested ID so
  // the renderer does not overwrite the profile restored when it is disabled.
  if(selection?.effective==='full'){
   const result=localSnapshot(snapshot,{requested:'full',reviewer},cwd);
   result.activePermissionProfile={id,extends:null};return result;
  }
  if(verified?.cwd!==cwd||verified?.activePermissionProfile?.id!==custom||!verified?.sandbox)
   throw Error('缺少此 Mac 專案已驗證的自訂權限，請重新開啟對話。');
  const result={...snapshot,runtimeWorkspaceRoots:[cwd],approvalPolicy:reviewer==='auto_review'?'on-request':verified.approvalPolicy,
   approvalsReviewer:reviewer,activePermissionProfile:structuredClone(verified.activePermissionProfile)};
  if(hasSandbox)result.sandbox=structuredClone(verified.sandbox);
  if(hasPolicy)result.sandboxPolicy=structuredClone(verified.sandbox);
  return result;
 }
 // Use the locally selected executor root, including when restoring old caches.
 // The native permission picker iterates writableRoots even for inactive modes.
 const roots=typeof cwd==='string'&&cwd.startsWith('/')&&!cwd.includes('\0')?[cwd]:[];
 const sandbox={type:{ask:'readOnly',project:'workspaceWrite',full:'dangerFullAccess'}[mode],
  ...(mode==='project'?{writableRoots:[...roots],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false}:{})};
 // Never copy peer writable roots or a remote custom profile into a Mac snapshot.
 const result={...snapshot,runtimeWorkspaceRoots:[...roots],approvalPolicy:mode!=='full'&&reviewer==='auto_review'?'on-request':{ask:'untrusted',project:'on-request',full:'never'}[mode],
  approvalsReviewer:reviewer,activePermissionProfile:{id,extends:null}};
 if(hasSandbox)result.sandbox={...sandbox};
 if(hasPolicy)result.sandboxPolicy={...sandbox};
 return result;
}
// A user action in an MCP App has its own leased executor context, not a model run.
async function appApproval({call,current,fullAccess,grants,getScope,show,onChange=()=>{}}){
 if(!current()||call.signal?.aborted)return false;
 if(fullAccess())return true;
 const scope=getScope(),revision=grants?.revision;
 const same=()=>!scope||require('./native-approvals.cjs').idFor(getScope())===require('./native-approvals.cjs').idFor(scope);
 if(scope&&grants?.has(scope)&&current()&&same())return true;
 const controller=new AbortController(),abort=()=>controller.abort();call.signal?.addEventListener('abort',abort,{once:true});
 const monitor=setInterval(()=>{if(!current()||!same()||grants?.revision!==revision)controller.abort();},100);
 try{
  const remember=!!(scope&&grants),result=await show({signal:controller.signal,type:'question',title:'OpenCodex 外掛操作',message:'允許這個小工具在 Mac 執行 '+call.name+'？',detail:(scope?'主機：'+scope.hostLabel+'\n專案：'+scope.cwd+'\n':'')+'外掛：'+call.serverId+'\n參數：'+JSON.stringify(call.arguments??{}).slice(0,8000),buttons:remember?['拒絕','允許這次','永遠允許此工具']:['拒絕','允許這次'],defaultId:0,cancelId:0,noLink:true});
  if(controller.signal.aborted||!current()||!same()||grants?.revision!==revision)return false;
  if(result.response===2&&remember){grants.remember(scope);onChange();return true;}
  return result.response===1;
 }catch(error){if(controller.signal.aborted)return false;throw error;}
 finally{clearInterval(monitor);call.signal?.removeEventListener('abort',abort);}
}
module.exports={profileId,selectedMode,localApproval,resolveMode,resolveSelection,setFullAccess,localSnapshot,appApproval};
