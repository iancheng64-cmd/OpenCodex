'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),cp=require('child_process'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),stateFile=path.join(root,'build/permissions-product-state.json'),s=JSON.parse(fs.readFileSync(stateFile));
assert(!s.restoredAt,'Fixture already restored');
const running=cp.execFileSync('ps',['-axo','comm='],{encoding:'utf8'}).split('\n');assert(!running.some(x=>x.trim().startsWith('/Applications/OpenCodex.app/')||x.includes('/OpenCodex/build/')&&x.includes('OpenCodex.app/')),'Close OpenCodex first');
const toml=require('../build/OpenCodex.app/Contents/Resources/agentbridge/app/node_modules/smol-toml');
const base=path.join(os.homedir(),'Library/Application Support/OpenCodex'),config=path.join(base,'codex-official/config.toml'),settingsFile=path.join(base,'opencodex.json');
const currentBytes=fs.readFileSync(config),settingsBytes=fs.readFileSync(settingsFile),current=toml.parse(currentBytes.toString()),settings=JSON.parse(settingsBytes),original=toml.parse(fs.readFileSync(s.configBackup,'utf8')),originalSettings=JSON.parse(fs.readFileSync(s.settingsBackup));
const plain=x=>JSON.parse(JSON.stringify(x));
assert.deepEqual(plain(current.permissions[s.audit]),{filesystem:{':root':'read',':workspace_roots':{secret:'deny'}},network:{enabled:false}});
assert.deepEqual(plain(current.permissions[s.dev]),{filesystem:{':root':'read',':workspace_roots':{'.':'write',secret:'deny'}},network:{enabled:false}});
assert.equal(current.default_permissions,s.audit);assert.equal(settings.profileId,s.profileId);assert.equal(settings.codexConnections[s.profileId].executable,s.executable);
// Initialization may fail before the fixture's custom selection is persisted.
assert([originalSettings.permissionMode,...[s.audit,s.dev].map(id=>'custom:'+id)].includes(settings.permissionMode),'Permission selection changed outside this fixture; inspect before restoring');
assert.equal(settings.fullAccess,false,'Full-access selection changed outside this fixture');
assert([s.cwd,originalSettings.cwd].includes(settings.cwd),'Workspace changed outside this fixture');
const desired=structuredClone(current);delete desired.permissions[s.audit];delete desired.permissions[s.dev];if(!Object.keys(desired.permissions).length)delete desired.permissions;
if(original.default_permissions===undefined)delete desired.default_permissions;else desired.default_permissions=original.default_permissions;
const output=toml.stringify(desired);assert.deepEqual(plain(toml.parse(output)),plain(desired));
const stamp=crypto.randomUUID(),backup=path.join(root,'build/qa-private');fs.mkdirSync(backup,{recursive:true,mode:0o700});
fs.writeFileSync(path.join(backup,'pre-cleanup-config-'+stamp+'.toml'),currentBytes,{mode:0o600});fs.writeFileSync(path.join(backup,'pre-cleanup-settings-'+stamp+'.json'),settingsBytes,{mode:0o600});
if(originalSettings.codexConnections?.[s.profileId]===undefined)delete settings.codexConnections[s.profileId];else settings.codexConnections[s.profileId]=originalSettings.codexConnections[s.profileId];
for(const key of ['cwd','permissionMode','fullAccess']){
 if(Object.hasOwn(originalSettings,key))settings[key]=originalSettings[key];else delete settings[key];
}
function atomic(file,data){fs.writeFileSync(file+'.restore',data,{mode:0o600});fs.renameSync(file+'.restore',file);}
atomic(config,output);atomic(settingsFile,JSON.stringify(settings,null,2)+'\n');
assert.deepEqual(plain(toml.parse(fs.readFileSync(config,'utf8'))),plain(desired));
const saved=JSON.parse(fs.readFileSync(settingsFile));
for(const key of ['cwd','permissionMode','fullAccess'])assert.deepEqual(saved[key],originalSettings[key],key);
assert.deepEqual(saved.codexConnections[s.profileId],originalSettings.codexConnections?.[s.profileId]);
s.restoredAt=new Date().toISOString();s.restoreMethod='remove unchanged QA profiles; restore fixture workspace, permission, full-access and engine selection; preserve other current user settings';s.restoredConfigSHA256=crypto.createHash('sha256').update(output).digest('hex');
atomic(stateFile,JSON.stringify(s,null,2)+'\n');
cp.execFileSync(process.execPath,[path.join(__dirname,'restore-qa-thread-permissions.cjs')],{stdio:'inherit'});
const report={version:'0.4.10',at:s.restoredAt,restored:true,fixtureProfilesRemoved:true,originalEngineRestored:true,originalWorkspaceAndPermissionRestored:true,currentReasoningEffortPreserved:desired.model_reasoning_effort===current.model_reasoning_effort,otherSettingsPreserved:true,configSHA256:s.restoredConfigSHA256};
fs.writeFileSync(path.join(root,'evidence/startup-fixture-restored.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
