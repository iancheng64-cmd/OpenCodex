'use strict';
const fs=require('node:fs'),path=require('node:path');
// Runs only inside the private sandbox worker. Bound the actual descriptor read,
// not merely stat size, so concurrent growth cannot bypass the attachment limit.
const limits={localImage:20*1048576,localAudio:20*1048576,skill:1048576};
async function readInput({kind,path:file},signal){
 const limit=limits[kind];
 if(!limit||typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw Error('Invalid sandbox attachment');
 const resolved=await fs.promises.realpath(file);
 const handle=await fs.promises.open(resolved,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);
 try{
  const stat=await handle.stat();
  if(!stat.isFile())throw Error('附件必須是一般檔案。');
  if(stat.size>limit)throw Error('附件超過大小限制。');
  const chunks=[];let size=0;
  for(;;){
   if(signal?.aborted)throw Error('附件讀取已取消。');
   const buffer=Buffer.allocUnsafe(Math.min(65536,limit+1-size));
   const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
   if(!bytesRead)break;
   size+=bytesRead;if(size>limit)throw Error('附件超過大小限制。');
   chunks.push(buffer.subarray(0,bytesRead));
  }
  if(signal?.aborted)throw Error('附件讀取已取消。');
  const bytes=Buffer.concat(chunks,size);
  return {path:resolved,size,encoding:kind==='skill'?'utf8':'base64',content:bytes.toString(kind==='skill'?'utf8':'base64')};
 }finally{await handle.close();}
}
module.exports={readInput};
