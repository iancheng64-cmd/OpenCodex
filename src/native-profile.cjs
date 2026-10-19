'use strict';
// Engine-specific native databases, UI state and model preferences.
// Shared extension installations stay at their existing paths; no history or credentials are copied.
const fs=require('node:fs'),path=require('node:path');
function nativeProfile(root,settings){
 const claude=settings.mode==='ssh'&&settings.sshAgent==='claude';
 return {home:path.join(root,claude?'codex-claude':settings.mode==='custom'?'codex-custom':'codex-official'),userData:claude?path.join(root,'native-claude-ui'):root,claude};
}
function prepareProfile(root,profile,toml){
 fs.mkdirSync(profile.home,{recursive:true,mode:0o700});
 fs.mkdirSync(profile.userData,{recursive:true,mode:0o700});
 if(!profile.claude)return;
 const source=path.join(root,'codex-official'),configPath=path.join(profile.home,'config.toml');
 if(!fs.existsSync(configPath)){
  const sourcePath=path.join(source,'config.toml'),config=fs.existsSync(sourcePath)?toml.parse(fs.readFileSync(sourcePath,'utf8')):{},selected={};
  for(const key of ['desktop','features','marketplaces','mcp_servers','plugins'])if(config[key]!==undefined)selected[key]=config[key];
  fs.writeFileSync(configPath,toml.stringify(selected),{mode:0o600,flag:'wx'});
 }
 for(const name of ['plugins','skills']){
  const target=path.join(profile.home,name),original=path.join(source,name);
  if(!fs.existsSync(original))continue;
  try{fs.lstatSync(target);}catch(e){if(e.code!=='ENOENT')throw e;fs.symlinkSync(original,target,'dir');}
 }
}
function codexConnection(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('無效的 Codex 連線設定。');
 const executable=value.executable??'';
 if(typeof executable!=='string'||executable.length>4096||/[\x00-\x1f\x7f]/.test(executable))throw Error('請填寫遠端 Codex 執行檔的完整路徑。');
 const file=executable.trim();
 if(file&&!(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(file)))throw Error('請填寫遠端 Codex 執行檔的完整路徑。');
 return file?{executable:file}:{};
}
function claudeConnection(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('無效的 Claude 連線設定。');
 const authMode=value.authMode||'official',configDir=(value.configDir||'').trim();
 if(!['official','api'].includes(authMode))throw Error('無效的 Claude 登入模式。');
 if(configDir&&(configDir.length>4096||/[\x00-\x1f]/.test(configDir)||!(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(configDir))))throw Error('請填寫遠端 Claude 設定資料夾的完整路徑。');
 // The remote backend distinguishes an omitted path (default) from an empty path (invalid).
 return configDir?{authMode,configDir}:{authMode};
}
// Snapshot only routing preferences; history, model settings and credentials stay
// in their existing engine-specific stores.
function engineTransition(settings,input){
 const current=settings.mode==='ssh'&&settings.sshAgent==='claude'?'claude':'codex';
 const contexts={...settings.engineContexts,[current]:{mode:settings.mode,profileId:settings.profileId,profileName:settings.profileName,cwd:settings.cwd}};
 const target=input.engine||(input.mode==='ssh'&&input.sshAgent==='claude'?'claude':'codex');
 if(!['codex','claude'].includes(target))throw Error('無效的 Agent。');
 const saved=contexts[target]||{};
 const next={...settings,engineContexts:contexts};
 if(target!==current)for(const key of ['profileId','profileName','cwd'])if(saved[key]!==undefined)next[key]=saved[key];
 next.mode=input.engine?(target==='claude'?'ssh':(['ssh','official','custom'].includes(saved.mode)?saved.mode:'ssh')):input.mode;
 next.sshAgent=target;
 return next;
}
module.exports={nativeProfile,prepareProfile,codexConnection,claudeConnection,engineTransition};
