'use strict';
const cp=require('node:child_process'),crypto=require('node:crypto');
let key;
function keyBytes(){
 if(key)return key;
 let secret;
 try{secret=cp.execFileSync('/usr/bin/security',['find-generic-password','-a','OpenCodex','-s','OpenCodex Safe Storage','-w'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
 catch(e){
  if(e.status!==44)throw Error('無法存取 OpenCodex 鑰匙圈。');
  secret=crypto.randomBytes(32).toString('hex');
  cp.execFileSync('/usr/bin/security',['-i'],{input:'add-generic-password -a OpenCodex -s "OpenCodex Safe Storage" -w "'+secret+'"\nquit\n',stdio:['pipe','ignore','pipe']});
  const read=cp.execFileSync('/usr/bin/security',['find-generic-password','-a','OpenCodex','-s','OpenCodex Safe Storage','-w'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if(read!==secret)throw Error('OpenCodex 鑰匙圈儲存驗證失敗。');
 }
 key=crypto.createHash('sha256').update(secret).digest();return key;
}
module.exports={
 isEncryptionAvailable(){try{keyBytes();return true;}catch{return false;}},
 encryptString(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',keyBytes(),iv);return Buffer.concat([Buffer.from('ocx1'),iv,c.update(value,'utf8'),c.final(),c.getAuthTag()]);},
 decryptString(buffer){if(buffer.subarray(0,4).toString()!=='ocx1')throw Error('Unsupported OpenCodex credential format');const c=crypto.createDecipheriv('aes-256-gcm',keyBytes(),buffer.subarray(4,16));c.setAuthTag(buffer.subarray(-16));return Buffer.concat([c.update(buffer.subarray(16,-16)),c.final()]).toString('utf8');},
 getSelectedStorageBackend(){return 'keychain';}
};
