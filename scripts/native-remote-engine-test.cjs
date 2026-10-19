'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {codexConnection,claudeConnection}=require('../src/native-profile.cjs'),{validateProfile,validateCwd}=require('../src/ssh-profiles.cjs'),cred=require('../vendor/agentbridge/dist-main/profile-credentials.js');
const tests=[],source=fs.readFileSync(path.join(__dirname,'../src/bootstrap.cjs'),'utf8');
(async()=>{
 for(const executable of ['/opt/OpenCodex/codex','C:\\Program Files\\OpenCodex\\codex.exe','\\\\server\\share\\codex.exe'])assert.deepEqual(codexConnection({executable:' '+executable+' '}),{executable});
 for(const executable of ['codex --flags','C:relative','/bin/codex\n','/bin/\x7fcodex','x'.repeat(4097),1,{}])assert.throws(()=>codexConnection({executable}),/完整路徑/);
 assert.deepEqual(codexConnection(),{});assert.deepEqual(codexConnection({executable:'  '}),{});assert.throws(()=>codexConnection([]));
 tests.push('remote engine accepts absolute POSIX/Windows paths, preserves spaces and rejects malformed input');
 const settings={},profile={id:'unit',name:'Unit',host:'host.invalid',username:'unit',port:22,authType:'password',runtimePlatform:'windows'},saved=cred.saveCredentialProfile({...profile,savePassword:true,password:'fixture'},null,x=>'encrypted:'+x,true);
 const registered=new Map(),profiles=[saved];let writes=0,failSave=false,sent;
 const handlers=new Map([
  ['profiles:list',async()=>profiles.map(cred.publicProfile)],
  ['profiles:save',async(_event,input)=>{profiles[0]=cred.saveCredentialProfile(input,profiles[0],x=>'encrypted:'+x,true);return profiles.map(cred.publicProfile);}],
  ['runtime:connect',async(_event,input)=>{sent={agent:'codex',input};throw Error('captured connection');}],
  ['claude:connect',async(_event,input)=>{sent={agent:'claude',input};throw Error('captured connection');}]
 ]);
 let claudeMode=false;
 const context={settings,handlers,codexConnection,claudeConnection,validateProfile,validateCwd,connecting:false,permissionChanging:false,pendingConnection:null,hostConfirmation:null,agents:null,claude:{runtime:null,queue:{starting:false}},runtime:null,peer:null,localTurns:new Set(),nativeShell:{},nativeQueue:{},bridgeError:null,publish:()=>{},save:()=>{if(failSave)throw Error('disk full');writes++},handle:(name,fn)=>registered.set(name,fn),isRemote:()=>true,isClaude:()=>claudeMode,nativePolicy:{resolveMode:()=>({effective:'full'})}};
 vm.createContext(context);
 vm.runInContext(source.split('\n').find(l=>l.startsWith("handle('opencodex:profile-save',")),context);
 const saveProfile=registered.get('opencodex:profile-save'),executable='C:\\Program Files\\OpenCodex\\codex.exe';
 await saveProfile({}, {...profile,savePassword:true,codexExecutable:executable});
 assert.equal(settings.codexConnections.unit.executable,executable);assert.equal(writes,1);assert.equal(profiles[0].encryptedPassword,saved.encryptedPassword);
 await saveProfile({}, {...profile,savePassword:true});assert.equal(settings.codexConnections.unit.executable,executable);assert.equal(writes,1);
 const prior=settings.codexConnections;failSave=true;await assert.rejects(saveProfile({}, {...profile,codexExecutable:'/new/codex'}),/disk full/);assert.equal(settings.codexConnections,prior);failSave=false;
 const roundTrip=JSON.parse(JSON.stringify(settings));assert.equal(roundTrip.codexConnections.unit.executable,executable);
 tests.push('actual profile handler persists engine choice separately from credentials, preserves omitted settings and rolls memory back on save failure');
 vm.runInContext(source.slice(source.indexOf('async function connectBridge('),source.indexOf('async function disconnectPeer(')),context);
 settings.profileId=profile.id;settings.cwd=__dirname;
 await assert.rejects(context.connectBridge(),/captured connection/);assert.equal(sent.agent,'codex');assert.equal(sent.input.executable,executable);
 claudeMode=true;await assert.rejects(context.connectBridge(),/captured connection/);assert.equal(sent.agent,'claude');assert.equal(sent.input.executable,undefined);
 claudeMode=false;await saveProfile({}, {...profile,codexExecutable:''});await assert.rejects(context.connectBridge(),/captured connection/);assert.equal(sent.input.executable,undefined);
 tests.push('actual connection routes saved executable to GPT only and restores the default engine when cleared');
 const report={at:new Date().toISOString(),passed:true,tests};fs.writeFileSync(path.join(__dirname,'../evidence/native-remote-engine-unit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1});
