'use strict';
function once(source,before,after){
 const index=source.indexOf(before);
 if(index<0||source.indexOf(before,index+before.length)>=0)throw Error('Unexpected startup patch boundary');
 return source.slice(0,index)+after+source.slice(index+before.length);
}
function patchStartup(source){
 source=once(source,
  " const targetClaude=asPeer?!isClaude():isClaude();\n const profiles=await handlers.get('profiles:list')({});",
  " const targetClaude=asPeer?!isClaude():isClaude();\n // Claim the connection before the first await, including profile lookup.\n connecting=true;bridgeError=null;publish();\n try{\n const profiles=await handlers.get('profiles:list')({});");
 source=once(source,
  " const profile=profiles.find(p=>p.id===(input.profileId||settings.profileId))||(!input.profileId?profiles.find(p=>p.name===settings.profileName)||profiles[0]:null);\n if(!profile)throw Error('請在側邊欄 SSH 連線新增主機。');",
  " const profile=input.automatic\n  ? (settings.profileId?profiles.find(p=>p.id===settings.profileId):profiles.find(p=>p.name===settings.profileName))\n  : profiles.find(p=>p.id===(input.profileId||settings.profileId))||(!input.profileId?profiles.find(p=>p.name===settings.profileName)||profiles[0]:null);\n if(!profile){\n  if(input.automatic&&!settings.profileId)return publicState();\n  throw Error(input.automatic?'已儲存的 SSH 主機不存在，請選擇主機後重新連線。':'請在側邊欄 SSH 連線新增主機。');\n }");
 source=once(source,
  " pendingConnection=null;hostConfirmation=null;connecting=true;bridgeError=null;publish();\n try{",
  " pendingConnection=null;hostConfirmation=null;publish();");
 source=once(source,
  " // Open the native shell first. SSH is an explicit user action from the sidebar.\n app.whenReady().then(()=>{audit('shell-ready',{mode:settings.mode,autoConnect:false});publish();});",
  " // Keep native startup independent of SSH; connect the saved host once per launch.\n app.whenReady().then(()=>{\n  audit('shell-ready',{mode:settings.mode,autoConnect:isRemote()});publish();\n  setImmediate(()=>{\n   if(shuttingDown||!isRemote()||connecting||permissionChanging||hostConfirmation||runtime&&!runtime.closed||claude?.connected)return;\n   audit('ssh-autoconnect-start',{});\n   connectBridge({automatic:true}).then(()=>{\n    audit('ssh-autoconnect-finished',{connected:!!(runtime&&!runtime.closed||claude?.connected),confirmationRequired:!!hostConfirmation});\n   }).catch(error=>{\n    bridgeError=error.message;publish();audit('ssh-autoconnect-failed',{});\n   });\n  });\n });");
 return source;
}
module.exports={patchStartup};
if(require.main===module){
 const fs=require('node:fs'),path=require('node:path'),file=path.join(__dirname,'../src/bootstrap.cjs');
 fs.writeFileSync(file,patchStartup(fs.readFileSync(file,'utf8')));
}
