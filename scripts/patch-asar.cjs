'use strict';
process.noAsar=true;
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
function patchAsar(file, changes, {refreshUnpackedIntegrity=false}={}) {
 const fd=fs.openSync(file,'r'),prefix=Buffer.alloc(16);fs.readSync(fd,prefix,0,16,0);
 const oldBase=8+prefix.readUInt32LE(4), hb=Buffer.alloc(prefix.readUInt32LE(12));
 fs.readSync(fd,hb,0,hb.length,16);const header=JSON.parse(hb),entries=[];
 const walk=(n,p='')=>{for(const[k,v]of Object.entries(n.files||{})){const q=p?p+'/'+k:k;if(v.files)walk(v,q);else entries.push([q,v]);}};walk(header);
 const oldOffsets=new Map(entries.map(([n,e])=>[n,Number(e.offset)]));
 for(const [n,value]of Object.entries(changes)){
  let dir=header;const seg=n.split('/'),base=seg.pop();for(const s of seg){dir.files??={};dir.files[s]??={files:{}};dir=dir.files[s];}
  dir.files??={};let e=dir.files[base];if(!e){e=dir.files[base]={};entries.push([n,e]);}
  const data=Buffer.isBuffer(value)?value:Buffer.from(value);
  changes[n]=data;e.size=data.length;delete e.unpacked;delete e.link;
  const blocks=[];for(let i=0;i<data.length;i+=4194304)blocks.push(crypto.createHash('sha256').update(data.subarray(i,i+4194304)).digest('hex'));
  e.integrity={algorithm:'SHA256',hash:crypto.createHash('sha256').update(data).digest('hex'),blockSize:4194304,blocks};
 }
 // Signing changes unpacked native binaries. Seal their final bytes without packing them.
 if(refreshUnpackedIntegrity){
  const unpackedRoot=fs.realpathSync(file+'.unpacked');
  for(const[n,e]of entries){
   if(!e.unpacked||e.link)continue;
   const resolved=fs.realpathSync(path.join(unpackedRoot,n));
   if(!resolved.startsWith(unpackedRoot+path.sep))throw Error('Unpacked entry escapes archive: '+n);
   const data=fs.readFileSync(resolved),blocks=[];
   for(let i=0;i<data.length;i+=4194304)blocks.push(crypto.createHash('sha256').update(data.subarray(i,i+4194304)).digest('hex'));
   e.size=data.length;e.integrity={algorithm:'SHA256',hash:crypto.createHash('sha256').update(data).digest('hex'),blockSize:4194304,blocks};
  }
 }
 let offset=0;for(const[n,e]of entries){if(e.unpacked||e.link)continue;e.offset=String(offset);offset+=e.size;}
 const json=Buffer.from(JSON.stringify(header)),headerSize=8+Math.ceil(json.length/4)*4;
 const packed=Buffer.alloc(8+headerSize);packed.writeUInt32LE(4,0);packed.writeUInt32LE(headerSize,4);packed.writeUInt32LE(headerSize-4,8);packed.writeUInt32LE(json.length,12);json.copy(packed,16);
 const out=fs.openSync(file+'.new','w');fs.writeSync(out,packed);
 for(const[n,e]of entries){if(e.unpacked||e.link)continue;let data=changes[n];if(!data){data=Buffer.alloc(e.size);fs.readSync(fd,data,0,e.size,oldBase+oldOffsets.get(n));}fs.writeSync(out,data);}
 fs.closeSync(out);fs.closeSync(fd);fs.renameSync(file+'.new',file);
 return crypto.createHash('sha256').update(json).digest('hex');
}
module.exports={patchAsar};
