'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
function createStorage({root=path.join(os.homedir(),'Library/Application Support/OpenCodex'),legacyKey}={}){
 let key;
 const directory=path.join(root,'credentials'),file=path.join(directory,'safe-storage.key');
 function check(st,dir=false){
  if(!(dir?st.isDirectory():st.isFile())||st.uid!==process.getuid()||(st.mode&0o077)!==0||(!dir&&st.nlink!==1))throw Error('OpenCodex 憑證檔案的擁有者或權限無效。');
 }
 function read(){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{check(fs.fstatSync(fd));const value=fs.readFileSync(fd,'utf8');if(!/^[a-f0-9]{64}$/.test(value))throw Error('OpenCodex 憑證金鑰損壞；原檔案已保留。');return value;}finally{fs.closeSync(fd);}
 }
 function migrate(){
  if(legacyKey)return legacyKey();
  const helper=path.join(process.resourcesPath||path.resolve(__dirname,'../build/OpenCodex.app/Contents/Resources'),'opencodex-credential-migrate');
  try{return cp.execFileSync(helper,[],{encoding:'utf8',timeout:5000,maxBuffer:1024,stdio:['ignore','pipe','pipe']});}
  catch(e){if(e.status===44)return null;throw Error('舊 OpenCodex 憑證尚未移轉；已保留原鑰匙圈項目，且不會顯示密碼提示。');}
 }
 function keyBytes(){
  if(key)return key;
  fs.mkdirSync(directory,{recursive:true,mode:0o700});check(fs.lstatSync(directory),true);
  let secret;
  try{secret=read();}catch(e){
   if(e.code!=='ENOENT')throw e;
   secret=migrate()??crypto.randomBytes(32).toString('hex');
   if(!/^[a-f0-9]{64}$/.test(secret))throw Error('OpenCodex 舊憑證格式無效。');
   const temporary=path.join(directory,'.'+crypto.randomUUID()+'.tmp');
   try{
    const fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,secret);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    // Publish without replacing a concurrently initialized key.
    try{fs.linkSync(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;}
   }finally{try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
   secret=read();
  }
  key=crypto.createHash('sha256').update(secret).digest();return key;
 }
 return {
  isEncryptionAvailable(){try{keyBytes();return true;}catch{return false;}},
  encryptString(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',keyBytes(),iv);return Buffer.concat([Buffer.from('ocx1'),iv,c.update(value,'utf8'),c.final(),c.getAuthTag()]);},
  decryptString(buffer){if(!Buffer.isBuffer(buffer)||buffer.length<32||buffer.subarray(0,4).toString()!=='ocx1')throw Error('Unsupported OpenCodex credential format');const c=crypto.createDecipheriv('aes-256-gcm',keyBytes(),buffer.subarray(4,16));c.setAuthTag(buffer.subarray(-16));return Buffer.concat([c.update(buffer.subarray(16,-16)),c.final()]).toString('utf8');},
  getSelectedStorageBackend(){return 'file';}
 };
}
module.exports={...createStorage(),createStorage};
