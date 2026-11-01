'use strict';
// SSH connection to the runtime host using the App's saved profiles, host trust and credentials.
const fs=require('node:fs'),path=require('node:path');
const cfg=require('./config.cjs'),ui=require('./ui.cjs');
const {Client}=require(path.join(cfg.abRoot,'node_modules/ssh2'));
const credentials=cfg.mod('profile-credentials.js');
const {createHash}=require('node:crypto');
// Same format as the App's trust store (runtime-known-hosts.json): "SHA256:" + base64 without padding.
const hostFingerprint=key=>'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'');
const {resolveRemotePlatform,captureRemote}=cfg.mod('remote-shell.js');
function pickProfile(selector){
 const items=cfg.profiles();
 if(!items.length)throw Error('尚未儲存任何 SSH 主機。請先在 OpenCodex App 的設定新增主機，或執行 opencodex profiles。');
 if(!selector){const s=cfg.cliSettings(),app=cfg.settings();const id=s.profileId||app.profileId;const found=items.find(p=>p.id===id)||items.find(p=>p.name===app.profileName);if(found)return found;throw Error('請用 --profile 指定主機（opencodex profiles 可列出）。');}
 const found=items.find(p=>p.id===selector||p.name===selector||p.host===selector||p.username+'@'+p.host===selector);
 if(!found)throw Error('找不到 SSH 主機設定：'+selector);
 return found;
}
async function connectConfig(profile,options={}){
 const c={host:profile.host,port:profile.port||22,username:profile.username,readyTimeout:15000,keepaliveInterval:15000,keepaliveCountMax:3};
 if(profile.authType==='agent'){if(!process.env.SSH_AUTH_SOCK)throw Error('找不到 SSH Agent；請改用私鑰或密碼。');c.agent=process.env.SSH_AUTH_SOCK;}
 else if(profile.authType==='key'){if(!profile.keyPath)throw Error('此主機設定缺少 SSH 私鑰路徑。');c.privateKey=fs.readFileSync(profile.keyPath);if(options.passphrase)c.passphrase=options.passphrase;}
 else{
  let password=options.password||process.env.OPENCODEX_SSH_PASSWORD;
  if(!password){const saved=credentials.savedCredentialFor(profile,cfg.profiles());if(saved?.encryptedPassword){const storage=cfg.storage();if(!storage.isEncryptionAvailable())throw Error('無法讀取 OpenCodex 憑證金鑰，已儲存的 SSH 密碼不可用。');password=storage.decryptString(Buffer.from(saved.encryptedPassword,'base64'));}}
  if(!password){if(!options.interactive)throw Error('此主機需要 SSH 密碼；請在互動模式輸入或設定 OPENCODEX_SSH_PASSWORD。');password=await ui.secret('SSH 密碼（'+profile.username+'@'+profile.host+'）：');}
  if(!password)throw Error('請輸入 SSH 密碼。');
  c.password=password;
 }
 return c;
}
// Verify the host key against the App's trust store. Unknown or changed keys require explicit confirmation.
async function connect(profile,options={}){
 const key=String(profile.host).toLowerCase()+':'+(profile.port||22);
 const config=await connectConfig(profile,options);
 const previous=cfg.knownHosts()[key];
 let observed='',pendingConfirmation=null;
 config.hostVerifier=raw=>{observed=hostFingerprint(raw);if(observed===previous||observed===options.trustedFingerprint)return true;pendingConfirmation={observed,previous};return false;};
 const conn=new Client();conn.on('error',()=>{});
 try{await new Promise((resolve,reject)=>{conn.once('ready',resolve);conn.once('error',reject);conn.connect(config);});}
 catch(e){
  try{conn.end();conn.destroy();}catch{}
  if(pendingConfirmation){
   const {observed,previous}=pendingConfirmation;
   if(!options.interactive)throw Error((previous?'主機金鑰已變更':'未知的主機金鑰')+'：'+observed+'。請在互動模式確認，或加上 --trust-host '+observed+'。');
   ui.warn((previous?'主機金鑰已變更！先前 '+previous+'，現在 ':'首次連線此主機，金鑰指紋 ')+observed);
   const a=(await ui.question(ui.color.yellow('  確認信任此主機？[y/N] › '))).trim().toLowerCase();
   if(!['y','yes'].includes(a))throw Error('使用者未信任主機金鑰，連線已取消。');
   return connect(profile,{...options,trustedFingerprint:observed});
  }
  const text=e?.message||String(e);
  if(/authentication methods failed|Password is required/i.test(text))throw Error('SSH 驗證失敗：請核對帳號、密碼或金鑰。');
  throw Error('SSH 連線失敗：'+text);
 }
 cfg.trustHost(key,observed);
 const platform=await resolveRemotePlatform(conn,profile.runtimePlatform||'auto');
 return {conn,key,fingerprint:observed,platform,profile};
}
module.exports={pickProfile,connect,captureRemote};
