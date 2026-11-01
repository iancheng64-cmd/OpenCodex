'use strict';
// Shared paths and settings for the OpenCodex CLI. The CLI reads the same profile,
// host-trust and credential files as the desktop App so one login serves both.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const repoRoot=path.resolve(__dirname,'..','..');
const appSupport=process.env.OPENCODEX_HOME||path.join(os.homedir(),'Library/Application Support/OpenCodex');
const cliRoot=path.join(appSupport,'cli');
const abRoot=path.join(repoRoot,'vendor/agentbridge');
function resourcesPath(){
 const candidates=[process.env.OPENCODEX_RESOURCES,'/Applications/OpenCodex.app/Contents/Resources',path.join(repoRoot,'build/OpenCodex.app/Contents/Resources')].filter(Boolean);
 for(const p of candidates)if(fs.existsSync(path.join(p,'agentbridge/codex/bin/codex')))return p;
 throw Error('找不到 OpenCodex.app 的 Resources（Mac 執行器）。請先安裝 /Applications/OpenCodex.app，或設定 OPENCODEX_RESOURCES。');
}
function mod(name){return require(path.join(abRoot,'dist-main',name));}
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}
function profiles(){return readJson(path.join(appSupport,'profiles.json'),[]);}
function settings(){return readJson(path.join(appSupport,'opencodex.json'),{});}
function cliSettings(){return readJson(path.join(cliRoot,'settings.json'),{});}
function saveCliSettings(value){writeJson(path.join(cliRoot,'settings.json'),value);}
function knownHosts(){return readJson(path.join(appSupport,'runtime-known-hosts.json'),{});}
function trustHost(key,fingerprint){writeJson(path.join(appSupport,'runtime-known-hosts.json'),{...knownHosts(),[key]:fingerprint});}
function storage(){return require(path.join(repoRoot,'src/safe-storage.cjs'));}
function ensureDirs(){for(const d of [cliRoot,path.join(cliRoot,'sessions'),path.join(cliRoot,'runtime-extensions'),path.join(cliRoot,'agent-task-checkpoints')])fs.mkdirSync(d,{recursive:true,mode:0o700});}
function version(){try{return require(path.join(repoRoot,'package.json')).openCodexVersion||'dev';}catch{return 'dev';}}
module.exports={repoRoot,appSupport,cliRoot,abRoot,resourcesPath,mod,readJson,writeJson,profiles,settings,cliSettings,saveCliSettings,knownHosts,trustHost,storage,ensureDirs,version};
