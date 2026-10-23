'use strict';
const path=require('node:path');
const {readInput}=require('./native-permissions-input.cjs');
const images={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
const audio={'.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.ogg':'audio/ogg','.webm':'audio/webm'};
async function convertInput(runtime,input){
 // Presence of a custom session is authoritative: failures cannot fall back
 // to an unsandboxed filesystem read.
 const permissionOwner=runtime.openCodexPermissions,custom=runtime.permissionMode?.startsWith('custom:');
 if(runtime.openCodexPermissionChanging||runtime.openCodexPermissionFailed||
  (custom&&(!permissionOwner?.valid()||permissionOwner.profile!==runtime.permissionMode.slice(7)))||
  (permissionOwner&&!custom))throw Error('操作權限尚未就緒，附件未讀取。');
 const read=permissionOwner
  ?(kind,file)=>permissionOwner.readInput(kind,file)
  :(kind,file)=>readInput({kind,path:file});
 return Promise.all((input||[]).map(async item=>{
  if(item.type==='localImage'||item.type==='localAudio'){
   const value=await read(item.type,item.path);
   const isImage=item.type==='localImage';
   const mime=(isImage?images:audio)[path.extname(value.path).toLowerCase()];
   if(!mime)throw Error(isImage?'不支援的圖片格式。':'不支援的音訊格式。');
   if(value.encoding!=='base64'||typeof value.content!=='string')throw Error('附件資料格式無效。');
   return {type:isImage?'image':'audio',url:'data:'+mime+';base64,'+value.content};
  }
  if(item.type==='skill'){
   const entry=runtime.extensionCatalog?.items.find(s=>s.kind==='skill'&&s.enabled&&s.path===item.path);
   if(!entry)throw Error('此 Mac Skill 未啟用，請先重新載入 Skills。');
   const value=await read('skill',item.path);
   if(value.encoding!=='utf8'||typeof value.content!=='string')throw Error('Skill 資料格式無效。');
   return {type:'text',text:'使用者選取的 Mac Skill：'+item.name+'\n位置：'+item.path+'\n相對路徑以該 Mac 目錄為準。\n\n'+value.content,text_elements:[]};
  }
  return item;
 }));
}
module.exports={convertInput};
