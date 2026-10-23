'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),base=path.join(os.homedir(),'Library/Application Support/OpenCodex');
const config=path.join(base,'codex-official/config.toml'),settingsFile=path.join(base,'opencodex.json'),stateFile=path.join(root,'build/permissions-product-state.json');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const save=s=>fs.writeFileSync(stateFile,JSON.stringify(s,null,2)+'\n',{mode:0o600});
if(process.argv.includes('--restore')){
 const s=JSON.parse(fs.readFileSync(stateFile));assert(!s.restoredAt,'Fixture already restored');
 assert.equal(sha(fs.readFileSync(config)),s.fixtureConfigSHA256,'Configuration changed; inspect before restoring');
 const settings=JSON.parse(fs.readFileSync(settingsFile));
 assert.equal(settings.profileId,s.profileId,'Selected host changed; inspect before restoring');
 assert.equal(settings.codexConnections[s.profileId].executable,s.executable,'Engine changed; inspect before restoring');
 fs.writeFileSync(config,fs.readFileSync(s.configBackup),{mode:0o600});
 const original=JSON.parse(fs.readFileSync(s.settingsBackup));
 for(const key of ['cwd','permissionMode','fullAccess']){if(Object.hasOwn(original,key))settings[key]=original[key];else delete settings[key];}
 settings.codexConnections[s.profileId]=original.codexConnections[s.profileId];
 fs.writeFileSync(settingsFile,JSON.stringify(settings,null,2)+'\n',{mode:0o600});
 assert.equal(sha(fs.readFileSync(config)),s.originalConfigSHA256);
 s.restoredAt=new Date().toISOString();save(s);
 require('node:child_process').execFileSync(process.execPath,[path.join(__dirname,'restore-qa-thread-permissions.cjs')],{stdio:'inherit'});
 console.log(JSON.stringify({restored:true,configSHA256:s.originalConfigSHA256}));
}else{
 if(fs.existsSync(stateFile))assert(JSON.parse(fs.readFileSync(stateFile)).restoredAt,'Prior fixture still active');
 const original=fs.readFileSync(config),settingsBytes=fs.readFileSync(settingsFile),settings=JSON.parse(settingsBytes);
 const toml=require('../build/OpenCodex.app/Contents/Resources/agentbridge/app/node_modules/smol-toml'),parsed=toml.parse(original.toString());
 assert(!parsed.permissions,'Existing permission profiles require merging');
 assert.equal(settings.mode,'ssh');assert.equal(settings.sshAgent,'codex');
 const deployment=JSON.parse(fs.readFileSync(path.join(root,'evidence/windows-latency-deploy.json')));
 assert(deployment.Passed&&deployment.ExistingProfileCompatible&&deployment.OfficialUnchanged);
 const executable=deployment.Files.find(f=>f.Path.endsWith('\\codex.exe')).Path;
 const fixture=fs.realpathSync(fs.mkdtempSync(path.join(root,'evidence/permissions-product-qa-'))),cwd=path.join(fixture,'workspace');
 fs.mkdirSync(cwd);fs.mkdirSync(path.join(cwd,'secret'));fs.writeFileSync(path.join(cwd,'readme.txt'),'PERMISSION_READ_OK');
 fs.writeFileSync(path.join(cwd,'secret/private.txt'),'OWNED_FIXTURE_SECRET');
 fs.symlinkSync(fixture,path.join(cwd,'outside-link'));
 const privateDir=path.join(root,'build/qa-private');fs.mkdirSync(privateDir,{recursive:true,mode:0o700});
 const id=crypto.randomUUID(),configBackup=path.join(privateDir,'permissions-config-'+id+'.toml'),settingsBackup=path.join(privateDir,'permissions-settings-'+id+'.json');
 fs.writeFileSync(configBackup,original,{mode:0o600});fs.writeFileSync(settingsBackup,settingsBytes,{mode:0o600});
 const audit='opencodex_qa_audit',dev='opencodex_qa_dev';
 const appended=['','[permissions.'+audit+'.filesystem]', '":root"="read"', '":workspace_roots"={"secret"="deny"}',
 '[permissions.'+audit+'.network]','enabled=false',
 '[permissions.'+dev+'.filesystem]', '":root"="read"', '":workspace_roots"={"."="write","secret"="deny"}',
 '[permissions.'+dev+'.network]','enabled=false',''].join('\n');
 // The native frontend validates this before exposing its profile picker.
 assert(!parsed.default_permissions,'Existing default permission requires merging');
 const content='default_permissions='+JSON.stringify(audit)+'\n'+original.toString()+appended;toml.parse(content);
 const s={at:new Date().toISOString(),fixture,cwd,audit,dev,profileId:settings.profileId,executable,configBackup,settingsBackup,originalConfigSHA256:sha(original),fixtureConfigSHA256:sha(content)};
 save(s);
 fs.writeFileSync(config,content,{mode:0o600});
 Object.assign(settings,{cwd,permissionMode:'custom:'+audit,fullAccess:false});
 settings.codexConnections[settings.profileId]={...settings.codexConnections[settings.profileId],executable};
 fs.writeFileSync(settingsFile,JSON.stringify(settings,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({prepared:true,cwd,audit,dev,originalConfigSHA256:s.originalConfigSHA256}));
}
