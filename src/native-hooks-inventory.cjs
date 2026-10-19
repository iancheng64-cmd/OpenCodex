'use strict';
const {createHash}=require('node:crypto');
const camel=s=>typeof s==='string'?s.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()):s;
function normalized(h){
 const handler=h.handler||h;
 return {key:h.key,eventName:camel(h.eventName),handlerType:camel(handler.type||handler.handlerType),
  command:handler.command??null,async:handler.async??false,server:handler.server??null,tool:handler.tool??null,
  matcher:h.matcher??null,timeoutSec:h.timeoutSec??null,statusMessage:h.statusMessage??null,
  additionalContextLimit:h.additionalContextLimit??null,sourcePath:h.sourcePath,source:camel(h.source),
  pluginId:h.pluginId??null,displayOrder:h.displayOrder,enabled:h.enabled===true,isManaged:h.isManaged===true,
  currentHash:h.currentHash,trustStatus:camel(h.trustStatus)};
}
function fingerprint(inventory){
 if(typeof inventory?.featureEnabled!=='boolean'||!Array.isArray(inventory.hooks))throw Error('Mac Hooks 清單無效。');
 const entries=inventory.hooks.map(normalized).sort((a,b)=>String(a.key).localeCompare(String(b.key)));
 return createHash('sha256').update(JSON.stringify({featureEnabled:inventory.featureEnabled,hooks:entries})).digest('hex');
}
function nativeInventory(list,config,cwd){
 const group=list?.data?.find(g=>g.cwd===cwd);
 if(!group||!Array.isArray(group.hooks)||group.errors?.length)throw Error('無法驗證原生 Hooks 設定。');
 return {featureEnabled:config?.config?.features?.hooks===true,hooks:group.hooks};
}
function compareInventory(helper,native){
 const actual=fingerprint(helper),expected=fingerprint(native);
 if(actual!==expected)throw Error('Mac Hooks 與原生設定不一致；請檢查外掛或組織管理的 Hooks 是否已支援。');
 return actual;
}
module.exports={normalized,fingerprint,nativeInventory,compareInventory};
