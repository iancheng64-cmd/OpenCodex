'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fields=['profileId','hostKey','fingerprint','cwd','mode','tool','extension','schema'];
function idFor(scope){if(!scope||!fields.every(k=>typeof scope[k]==='string'&&scope[k].length>0))return null;return crypto.createHash('sha256').update(JSON.stringify(fields.map(k=>scope[k]))).digest('hex');}
function approvalScope(runtime,approvalId){
 const pending=runtime?.requests?.get(approvalId),call=pending?.request?.params,entry=runtime?.toolHost?.entries?.get(call?.name),s=runtime?.snapshot;
 if(!pending?.localResolve||pending.request.method!=='local/tool'||!entry||entry.category!==call.category||!['ssh','tailscale-ssh'].includes(s?.transport)||!['ask','project'].includes(runtime.permissionMode))return null;
 try{
  const cwd=fs.realpathSync(runtime.localCwd);if(!fs.statSync(cwd).isDirectory())return null;
  const scope={profileId:s.profileId,hostKey:s.hostKey,fingerprint:s.hostFingerprint,cwd,mode:runtime.permissionMode,tool:call.name,extension:entry.extensionId||'opencodex-built-in',schema:crypto.createHash('sha256').update(JSON.stringify(entry.tool.inputSchema||{})).digest('hex'),hostLabel:s.hostName||s.profileId};
  return idFor(scope)?scope:null;
 }catch{return null;}
}
function appScope(runtime,call){
 const entry=runtime?.toolHost?.entries?.get(call?.name),s=runtime?.snapshot;
 if(!entry||entry.category!==call.category||entry.extensionId!==call.serverId||entry.tool!==call.tool||!['ssh','tailscale-ssh'].includes(s?.transport)||!['ask','project'].includes(runtime.permissionMode))return null;
 try{
  const cwd=fs.realpathSync(runtime.localCwd);if(!fs.statSync(cwd).isDirectory())return null;
  const scope={profileId:s.profileId,hostKey:s.hostKey,fingerprint:s.hostFingerprint,cwd,mode:runtime.permissionMode,tool:call.name,extension:entry.extensionId,schema:crypto.createHash('sha256').update(JSON.stringify(entry.tool.inputSchema||{})).digest('hex'),hostLabel:s.hostName||s.profileId};
  return idFor(scope)?scope:null;
 }catch{return null;}
}
class ApprovalGrants{
 constructor(file){this.file=file;this.revision=0;this.error=null;}
 read(){
  try{
   const stat=fs.lstatSync(this.file);if(!stat.isFile()||stat.size>1024*1024)throw Error('Invalid permission store');
   const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
   if(data.version!==1||!Array.isArray(data.grants)||data.grants.length>1000||data.grants.some(g=>!g||!idFor(g)||g.id!==idFor(g)||typeof g.createdAt!=='string'))throw Error('Invalid permission records');
   this.error=null;return data.grants;
  }catch(e){if(e.code==='ENOENT'){this.error=null;return [];}this.error='已記住的工具權限無法讀取，暫停自動允許。';return null;}
 }
 list(){return (this.read()||[]).map(g=>({id:g.id,tool:g.tool,hostLabel:g.hostLabel||g.profileId,cwd:g.cwd,mode:g.mode,createdAt:g.createdAt}));}
 has(scope){const id=idFor(scope);return !!id&&(this.read()||[]).some(g=>g.id===id);}
 write(grants){
  const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify({version:1,grants},null,2),{mode:0o600,flag:'wx'});fs.renameSync(tmp,this.file);this.revision++;this.error=null;}
  finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
 }
 remember(scope){
  const id=idFor(scope),current=this.read();if(!id||!current)throw Error(this.error||'無法保存此工具權限。');
  if(!current.some(g=>g.id===id)){if(current.length>=1000)throw Error('已記住的權限已達上限，請先撤銷不用的項目。');this.write([...current,{...scope,id,createdAt:new Date().toISOString()}]);}
 }
 revoke(id){const current=this.read();if(!current)throw Error(this.error);this.write(current.filter(g=>g.id!==id));}
}
module.exports={ApprovalGrants,approvalScope,appScope,idFor};
