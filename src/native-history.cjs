'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// Persist native thread snapshots separately per SSH profile. No peer credentials
// or remote pathnames are used as filenames. A failed write leaves the prior copy.
class NativeHistory {
 constructor(directory,{onError=()=>{}}={}){this.directory=directory;this.onError=onError;this.entries=new Map();fs.mkdirSync(directory,{recursive:true,mode:0o700});}
 key(id,profile){if(typeof id!=='string'||!id||typeof profile!=='string'||!profile)throw Error('對話快取缺少主機或對話識別碼。');return crypto.createHash('sha256').update(JSON.stringify([profile,id])).digest('hex');}
 get(id,profile){
  const key=this.key(id,profile);
  if(this.entries.has(key))return structuredClone(this.entries.get(key));
  try{
   const data=JSON.parse(fs.readFileSync(path.join(this.directory,key+'.json'),'utf8'));
   if(data.version!==1||data.id!==id||data.profile!==profile||data.result?.thread?.id!==id)throw Error('對話快取內容不相符。');
   // Legacy v1 snapshots have no completeness proof. Never infer it from turns:[].
   const result={...data.result,openCodexHistoryComplete:data.result.openCodexHistoryComplete===true};
   this.entries.set(key,result);return structuredClone(result);
  }catch(e){if(e.code!=='ENOENT')this.onError(e);return undefined;}
 }
 has(id,profile){return this.get(id,profile)!==undefined;}
 set(id,result,profile,{summaryOnly=false,complete=false}={}){
  if(result?.thread?.id!==id)throw Error('無法保存不同對話的歷史。');
  const key=this.key(id,profile),previous=this.get(id,profile);
  const next=structuredClone({...previous,...result,thread:{...previous?.thread,...result.thread}});
  // A summary-only response must not erase a previously fetched conversation.
  const preservesHistory=summaryOnly||!Array.isArray(result.thread.turns);
  if(preservesHistory&&Array.isArray(previous?.thread?.turns))next.thread.turns=previous.thread.turns;
  // Completeness belongs to the stored snapshot, not untrusted response metadata.
  // Replacing turns invalidates the prior proof unless the caller read them all.
  next.openCodexHistoryComplete=preservesHistory?previous?.openCodexHistoryComplete===true:complete===true;
  const file=path.join(this.directory,key+'.json'),tmp=file+'.'+crypto.randomUUID()+'.tmp';
  try{
   fs.writeFileSync(tmp,JSON.stringify({version:1,id,profile,savedAt:new Date().toISOString(),result:next}),{mode:0o600,flag:'wx'});
   fs.renameSync(tmp,file);this.entries.set(key,next);return true;
  }catch(error){this.onError(error);return false;}finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')this.onError(e);}}
 }
 delete(id,profile){const key=this.key(id,profile);fs.rmSync(path.join(this.directory,key+'.json'),{force:true});return this.entries.delete(key);}
}
// The native renderer resumes with excludeTurns before fetching pages. An empty
// turns array in that metadata response is not proof of an empty conversation.
function snapshotOptions(method,params={}){
 const excluded=['thread/resume','thread/fork'].includes(method)&&params.excludeTurns===true;
 return {
  summaryOnly:excluded||(!['thread/start','thread/resume','thread/fork','thread/revert'].includes(method)&&!(method==='thread/read'&&params.includeTurns===true)),
  complete:!excluded&&(method==='thread/start'||method==='thread/resume'||method==='thread/fork'||(method==='thread/read'&&params.includeTurns===true))
 };
}
module.exports={NativeHistory,snapshotOptions};
