'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {archive}=require('./asar-reader.cjs'),{patchAsar}=require('./patch-asar.cjs');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
function verify(file){
 const a=archive(file);let packed=0,unpacked=0;
 try{for(const[name,entry]of Object.entries(a.entries)){
  if(entry.link)continue;
  const data=a.read(name),integrity=entry.integrity;
  assert.equal(data.length,entry.size,name+' size');
  assert.equal(integrity?.algorithm,'SHA256',name+' algorithm');
  assert.equal(sha(data),integrity.hash,name+' digest');
  assert(Number.isSafeInteger(integrity.blockSize)&&integrity.blockSize>0,name+' block size');
  const blocks=[];for(let i=0;i<data.length;i+=integrity.blockSize)blocks.push(sha(data.subarray(i,i+integrity.blockSize)));
  // ASAR producers represent an empty file as zero blocks or one empty block.
  if(data.length===0&&integrity.blocks?.length===1)blocks.push(sha(data));
  assert.deepEqual(blocks,integrity.blocks,name+' blocks');
  entry.unpacked?unpacked++:packed++;
 }}finally{a.close();}
 return {packed,unpacked,passed:true};
}
if(require.main===module){
 const [action,file]=process.argv.slice(2);
 if(action==='seal'){
  const header=patchAsar(file,{}, {refreshUnpackedIntegrity:true});
  const report=verify(file);process.stdout.write(JSON.stringify({...report,headerSHA256:header})+'\n');
 }else if(action==='verify')process.stdout.write(JSON.stringify(verify(file))+'\n');
 else throw Error('Use seal|verify followed by an ASAR path');
}
module.exports={verify};
