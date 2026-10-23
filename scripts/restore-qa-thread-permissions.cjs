'use strict';
// Repair only selections owned by a completed permission fixture. Conversation data is preserved.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict'),cp=require('node:child_process');
function restoreSelections(known,{audit,dev,profileId,permissionMode}){
 assert(['ask','project','full'].includes(permissionMode),'Expected original built-in permission');
 const result=structuredClone(known),changed=[];
 for(const [id,entry] of Object.entries(result)){
  if(entry.profile!==profileId||!['custom:'+audit,'custom:'+dev].includes(entry.permissionMode))continue;
  entry.permissionMode=permissionMode;delete entry.permissionSnapshot;changed.push(id);
 }
 for(const id of Object.keys(known)){
  const before=structuredClone(known[id]),after=structuredClone(result[id]);
  if(changed.includes(id)){delete before.permissionMode;delete before.permissionSnapshot;delete after.permissionMode;delete after.permissionSnapshot;}
  assert.deepEqual(after,before,'Non-permission conversation metadata changed');
 }
 return {result,changed};
}
function main(){
 const root=path.resolve(__dirname,'..'),state=JSON.parse(fs.readFileSync(path.join(root,'build/permissions-product-state.json')));
 assert(state.restoredAt,'Restore fixture configuration before its conversation selections');
 const running=cp.execFileSync('ps',['-axo','comm='],{encoding:'utf8'}).split('\n');
 assert(!running.some(x=>x.trim().startsWith('/Applications/OpenCodex.app/')||x.includes('/OpenCodex/build/')&&x.includes('OpenCodex.app/')),'Close OpenCodex before restoring selections');
 const base=path.join(os.homedir(),'Library/Application Support/OpenCodex');
 const original=JSON.parse(fs.readFileSync(state.settingsBackup));
 const toml=require('../build/OpenCodex.app/Contents/Resources/agentbridge/app/node_modules/smol-toml');
 const config=toml.parse(fs.readFileSync(path.join(base,'codex-official/config.toml'),'utf8'));
 assert(!config.permissions?.[state.audit]&&!config.permissions?.[state.dev],'QA profiles are still active');
 const file=path.join(base,'native-threads.json'),bytes=fs.readFileSync(file),known=JSON.parse(bytes);
 const {result,changed}=restoreSelections(known,{...state,permissionMode:original.permissionMode||'project'});
 const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
 if(changed.length){
  const dir=path.join(root,'build/qa-private');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(dir,'native-threads-before-qa-cleanup-'+crypto.randomUUID()+'.json'),bytes,{mode:0o600,flag:'wx'});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(result),{mode:0o600,flag:'wx'});assert.equal(sha(fs.readFileSync(file)),sha(bytes),'Conversation metadata changed during cleanup');fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
 }
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),result);
 const report={at:new Date().toISOString(),passed:true,changedCount:changed.length,threadCount:Object.keys(known).length,conversationMetadataPreserved:true,beforeSHA256:sha(bytes),afterSHA256:sha(fs.readFileSync(file)),permissionMode:original.permissionMode||'project'};
 fs.writeFileSync(path.join(root,'evidence/qa-thread-permissions-restored.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
module.exports={restoreSelections};
if(require.main===module)main();
