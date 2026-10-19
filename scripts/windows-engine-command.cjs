'use strict';
// Development remote build utility: reuse the selected profile and pinned host identity.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Client}=require('../build/OpenCodex.app/Contents/Resources/agentbridge/app/node_modules/ssh2');
const storage=require('../src/safe-storage.cjs');
(async()=>{
 const root=path.join(os.homedir(),'Library/Application Support/OpenCodex'),read=n=>JSON.parse(fs.readFileSync(path.join(root,n)));
 const settings=read('opencodex.json'),profile=read('profiles.json').find(p=>p.id===settings.profileId);
 if(!profile)throw Error('Selected profile missing');
 const trusted=read('runtime-known-hosts.json')[profile.host.toLowerCase()+':'+(profile.port||22)];
 if(!trusted)throw Error('Previously trusted SSH host required');
 const config={host:profile.host,port:profile.port||22,username:profile.username,readyTimeout:15000,keepaliveInterval:15000,hostVerifier:key=>trusted==='SHA256:'+crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/,'')};
 if(profile.authType==='password')config.password=storage.decryptString(Buffer.from(profile.encryptedPassword,'base64'));
 else if(profile.authType==='key')config.privateKey=fs.readFileSync(profile.keyPath);
 else config.agent=process.env.SSH_AUTH_SOCK;
 const conn=new Client();conn.on('error',()=>{});
 let sftp,remoteScript;
 try{
  await new Promise((resolve,reject)=>{conn.once('ready',resolve);conn.once('error',reject);conn.connect(config)});
  const script=fs.readFileSync(process.argv[2],'utf8');
  sftp=await new Promise((resolve,reject)=>conn.sftp((e,s)=>e?reject(e):resolve(s)));
  const remoteHome=await new Promise((resolve,reject)=>sftp.realpath('.',(e,p)=>e?reject(e):resolve(p)));
  remoteScript=remoteHome.replace(/\/$/,'')+'/.opencodex-command-'+crypto.randomUUID()+'.ps1';
  await new Promise((resolve,reject)=>sftp.writeFile(remoteScript,'\ufeff'+script,'utf8',e=>e?reject(e):resolve()));
  const windowsPath=remoteScript.replace(/^\/([A-Za-z]:\/)/,'$1');
  if(/["\r\n]/.test(windowsPath))throw Error('Unsafe temporary script path');
  const command='powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+windowsPath+'"';
  await new Promise((resolve,reject)=>conn.exec(command,(err,channel)=>{
   if(err)return reject(err);
   const timer=setTimeout(()=>{channel.close();reject(Error('Remote command timed out'));},25*60*1000);
   channel.on('data',chunk=>process.stdout.write(chunk));
   channel.stderr.on('data',chunk=>process.stderr.write(chunk));
   channel.on('error',reject);
   channel.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Remote command exited '+code));});
  }));
 }finally{
  if(sftp&&remoteScript)await new Promise(resolve=>sftp.unlink(remoteScript,e=>{if(e)console.error('Temporary build script cleanup failed: '+e.message);resolve();}));
  conn.end();
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
