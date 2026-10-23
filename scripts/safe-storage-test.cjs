'use strict';
// Isolated credentials only: never accesses the user's keychain or prints keys.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createStorage}=require('../src/safe-storage.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-storage-test-')),checks=[];
const make=name=>path.join(temp,name),keyFile=root=>path.join(root,'credentials/safe-storage.key');
const forbidden=()=>{throw Error('Unexpected keychain access');};
const check=(name,run)=>{run();checks.push(name);};
try{
 check('New installation creates a private persistent key',()=>{
  const root=make('fresh'),s=createStorage({root,legacyKey:()=>null}),cipher=s.encryptString('測試 credential');
  assert.equal(s.getSelectedStorageBackend(),'file');
  assert.equal(fs.statSync(path.dirname(keyFile(root))).mode&0o777,0o700);
  assert.equal(fs.statSync(keyFile(root)).mode&0o777,0o600);
  assert.equal(createStorage({root,legacyKey:forbidden}).decryptString(cipher),'測試 credential');
 });
 check('Legacy ciphertext decrypts after migration and reopening without keychain',()=>{
  const root=make('legacy'),secret=crypto.randomBytes(32).toString('hex'),iv=crypto.randomBytes(12);
  const c=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(secret).digest(),iv);
  const cipher=Buffer.concat([Buffer.from('ocx1'),iv,c.update('legacy credential'),c.final(),c.getAuthTag()]);
  let reads=0;const s=createStorage({root,legacyKey:()=>{reads++;return secret;}});
  assert.equal(s.decryptString(cipher),'legacy credential');assert.equal(reads,1);
  assert.equal(createStorage({root,legacyKey:forbidden}).decryptString(cipher),'legacy credential');
  assert.equal(fs.readFileSync(keyFile(root),'utf8'),secret);
 });
 check('Denied migration preserves the missing-key state',()=>{
  const root=make('denied'),s=createStorage({root,legacyKey:forbidden});
  assert.equal(s.isEncryptionAvailable(),false);
  assert.throws(()=>s.encryptString('unwritten'),/Unexpected keychain access/);
  assert.equal(fs.existsSync(keyFile(root)),false);
 });
 check('Invalid legacy keys are never persisted',()=>{
  const root=make('invalid');assert.throws(()=>createStorage({root,legacyKey:()=> 'invalid'}).encryptString('x'));
  assert.equal(fs.existsSync(keyFile(root)),false);
 });
 check('Corrupted key is preserved and does not fall back to keychain',()=>{
  const root=make('corrupt');createStorage({root,legacyKey:()=>null}).encryptString('x');
  fs.writeFileSync(keyFile(root),'broken');
  assert.throws(()=>createStorage({root,legacyKey:forbidden}).encryptString('x'),/損壞/);
  assert.equal(fs.readFileSync(keyFile(root),'utf8'),'broken');
 });
 check('Insecure key and directory permissions are rejected',()=>{
  const root=make('mode');createStorage({root,legacyKey:()=>null}).encryptString('x');
  fs.chmodSync(keyFile(root),0o644);
  assert.throws(()=>createStorage({root,legacyKey:forbidden}).encryptString('x'),/權限/);
  fs.chmodSync(keyFile(root),0o600);fs.chmodSync(path.dirname(keyFile(root)),0o755);
  assert.throws(()=>createStorage({root,legacyKey:forbidden}).encryptString('x'),/權限/);
 });
 check('Key symlinks and hardlinks are rejected without changing the target',()=>{
  const root=make('links');createStorage({root,legacyKey:()=>null}).encryptString('x');
  const file=keyFile(root),original=fs.readFileSync(file),target=path.join(root,'original');
  fs.renameSync(file,target);fs.symlinkSync(target,file);
  assert.throws(()=>createStorage({root,legacyKey:forbidden}).encryptString('x'));
  fs.unlinkSync(file);fs.linkSync(target,file);
  assert.throws(()=>createStorage({root,legacyKey:forbidden}).encryptString('x'),/權限/);
  assert.deepEqual(fs.readFileSync(target),original);
 });
 check('Credential directory symlinks are rejected',()=>{
  const root=make('dirlink'),target=make('target');fs.mkdirSync(root);fs.mkdirSync(target,{mode:0o700});
  fs.symlinkSync(target,path.join(root,'credentials'));
  assert.throws(()=>createStorage({root,legacyKey:forbidden}).encryptString('x'),/權限/);
  assert.deepEqual(fs.readdirSync(target),[]);
 });
 check('Authenticated encryption rejects tampered ciphertext and preserves Unicode and empty values',()=>{
  const s=createStorage({root:make('cipher'),legacyKey:()=>null});
  for(const text of ['', '中文 🔐'])assert.equal(s.decryptString(s.encryptString(text)),text);
  const cipher=s.encryptString('secret');cipher[cipher.length-1]^=1;
  assert.throws(()=>s.decryptString(cipher));
  for(const invalid of [null,'text',Buffer.alloc(4),Buffer.alloc(32)])assert.throws(()=>s.decryptString(invalid),/Unsupported/);
 });
 console.log(JSON.stringify({passed:true,checks}));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
