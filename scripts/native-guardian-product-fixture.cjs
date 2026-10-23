'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),base=path.join(os.homedir(),'Library/Application Support/OpenCodex');
const settingsFile=path.join(base,'opencodex.json'),config=path.join(base,'codex-official/config.toml'),stateFile=path.join(root,'build/guardian-product-state.json');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),save=s=>fs.writeFileSync(stateFile,JSON.stringify(s,null,2)+'\n',{mode:0o600});
const keys=['cwd','permissionMode','fullAccess','approvalsReviewer'];
assert(!cp.execFileSync('ps',['-axo','comm='],{encoding:'utf8'}).split('\n').some(s=>s.includes('/OpenCodex.app/Contents/MacOS/')),'Close OpenCodex before changing the QA fixture');
if(process.argv.includes('--restore')){
 const s=JSON.parse(fs.readFileSync(stateFile));assert(!s.restoredAt,'Fixture already restored');
 const currentConfigSHA256=sha(fs.readFileSync(config));
 const prior=JSON.parse(fs.readFileSync(path.join(root,'build/hooks-product-state.json')));
 assert(currentConfigSHA256===s.configSHA256||(prior.restoredAt&&currentConfigSHA256===prior.originalSHA256),'Configuration changed outside known restored baseline; inspect before restoring');
 s.restoredConfigSHA256=currentConfigSHA256;s.configPreserved=true;
 const settings=JSON.parse(fs.readFileSync(settingsFile)),original=JSON.parse(fs.readFileSync(s.settingsBackup));
 assert.equal(settings.profileId,s.profileId,'Selected SSH profile changed');
 assert.equal(settings.codexConnections[s.profileId].executable,s.executable,'Selected engine changed');
 for(const key of keys){if(Object.hasOwn(original,key))settings[key]=original[key];else delete settings[key];}
 settings.codexConnections[s.profileId]=original.codexConnections[s.profileId];
 fs.writeFileSync(settingsFile,JSON.stringify(settings,null,2)+'\n',{mode:0o600});
 s.restoredAt=new Date().toISOString();save(s);
 console.log(JSON.stringify({restored:true,configPreserved:true,configUnchanged:currentConfigSHA256===s.configSHA256}));
}else{
 if(fs.existsSync(stateFile))assert(JSON.parse(fs.readFileSync(stateFile)).restoredAt,'Previous Guardian fixture is active');
 for(const name of ['permissions-product-state.json','hooks-product-state.json']){
  const file=path.join(root,'build',name);
  if(fs.existsSync(file))assert(JSON.parse(fs.readFileSync(file)).restoredAt,'Another product fixture is still active: '+name);
 }
 const settingsBytes=fs.readFileSync(settingsFile),settings=JSON.parse(settingsBytes);
 assert.equal(settings.mode,'ssh');assert.equal(settings.sshAgent,'codex');assert(settings.profileId);
 const deployment=JSON.parse(fs.readFileSync(path.join(root,'evidence/windows-latency-deploy.json')));
 assert(deployment.Passed&&deployment.ExistingProfileCompatible&&deployment.OfficialUnchanged);
 assert(deployment.Capability.includes('OpenCodexGuardian/1'));
 const executable=deployment.Files.find(f=>path.win32.basename(f.Path)==='codex.exe').Path;
 const fixture=fs.realpathSync(fs.mkdtempSync(path.join(root,'evidence/guardian-product-qa-'))),cwd=path.join(fixture,'workspace');fs.mkdirSync(cwd);
 fs.writeFileSync(path.join(cwd,'readme.txt'),'Owned OpenCodex Guardian verification workspace.');
 const privateDir=path.join(root,'build/qa-private');fs.mkdirSync(privateDir,{recursive:true,mode:0o700});
 const settingsBackup=path.join(privateDir,'guardian-settings-'+crypto.randomUUID()+'.json');fs.writeFileSync(settingsBackup,settingsBytes,{mode:0o600});
 const s={at:new Date().toISOString(),fixture,cwd,profileId:settings.profileId,executable,settingsBackup,configSHA256:sha(fs.readFileSync(config))};
 save(s);
 Object.assign(settings,{cwd,permissionMode:'project',fullAccess:false,approvalsReviewer:'user'});
 settings.codexConnections[settings.profileId]={...settings.codexConnections[settings.profileId],executable};
 fs.writeFileSync(settingsFile,JSON.stringify(settings,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({prepared:true,cwd,configUnchanged:true}));
}
