'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {patchAsar}=require('./patch-asar.cjs'),{archive}=require('./asar-reader.cjs'),{verify}=require('./asar-integrity.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-asar-')),file=path.join(root,'fixture.asar');
try{
 const header=Buffer.from(JSON.stringify({files:{'native.node':{size:3,unpacked:true}}})),headerSize=8+Math.ceil(header.length/4)*4,prefix=Buffer.alloc(8+headerSize);
 prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(headerSize,4);prefix.writeUInt32LE(headerSize-4,8);prefix.writeUInt32LE(header.length,12);header.copy(prefix,16);fs.writeFileSync(file,prefix);
 fs.mkdirSync(file+'.unpacked');fs.writeFileSync(file+'.unpacked/native.node','old');
 const packed=Buffer.from('packed source preserved');
 patchAsar(file,{'src/main.js':packed},{refreshUnpackedIntegrity:true});
 assert.deepEqual(verify(file),{packed:1,unpacked:1,passed:true});
 // Model signing: native file content and length change across a block boundary.
 const signed=Buffer.alloc(4194304+31,7);fs.writeFileSync(file+'.unpacked/native.node',signed);
 assert.throws(()=>verify(file),/native.node/);
 const first=patchAsar(file,{}, {refreshUnpackedIntegrity:true});
 assert.deepEqual(verify(file),{packed:1,unpacked:1,passed:true});
 const a=archive(file);try{assert.deepEqual(a.read('src/main.js'),packed);assert.deepEqual(a.read('native.node'),signed);assert.equal(a.entries['native.node'].unpacked,true);assert.equal(a.entries['native.node'].integrity.blocks.length,2);}finally{a.close();}
 assert.equal(patchAsar(file,{}, {refreshUnpackedIntegrity:true}),first,'sealing unchanged bytes is idempotent');
 signed[4194304]^=1;fs.writeFileSync(file+'.unpacked/native.node',signed);
 assert.throws(()=>verify(file),/native.node digest/);
 console.log('PASS final signed bytes, size changes, block integrity, packed preservation, idempotency and tamper detection');
}finally{fs.rmSync(root,{recursive:true,force:true});}
