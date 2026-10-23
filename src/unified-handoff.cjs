'use strict';
// One canonical Codex thread, independent provider sessions and a selection for the next turn.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
class UnifiedHandoff{
 constructor(primary,{root}){
  this.providers=new Map([[primary.provider,primary]]);this.primary=primary;this.claude=primary.claude;
  this.file=path.join(root,'unified-model-selection.json');this.choices={};this.activeChoices=new Map();this.redirecting=new Set();this.defaultModel=primary.newThread?.model||null;
  try{const data=JSON.parse(fs.readFileSync(this.file,'utf8'));this.choices=data.choices||{};this.defaultModel=data.defaultModel||null;}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 add(h){this.providers.set(h.provider,h);}
 owner(model){return [...this.providers.values()].find(h=>h.isModel(model));}
 isModel(model){return !!this.owner(model);}
 get connected(){return this.primary.connected;}
 get busy(){return [...this.providers.values()].some(h=>h.busy);}
 get threads(){return Object.fromEntries(Object.entries(this.choices).map(([id,c])=>[id,c]));}
 get defaultEngine(){return this.owner(this.defaultModel)?.provider||'codex';}
 save(){const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify({version:1,choices:this.choices,defaultModel:this.defaultModel}),{mode:0o600,flag:'wx'});fs.renameSync(tmp,this.file);}finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}}
 models(){return [...this.providers.values()].flatMap(h=>h.models());}
 listModels(r){return {...r,data:[...(r?.data||[]),...this.models()]};}
 requested(p){return this.primary.requested(p);}
 selectedModel(id){return Object.hasOwn(this.choices,id)?this.choices[id].model:this.primary.selectedModel(id);}
 selectedEffort(id){const model=this.selectedModel(id),owner=this.owner(model),effort=Object.hasOwn(this.choices,id)?this.choices[id].effort:owner?.threads[id]?.effort;return owner?owner.effortFor(model,effort):effort??null;}
 snapshot(id){return {model:this.selectedModel(id)||null,effort:this.selectedEffort(id)};}
 changedForActive(id){const active=this.activeChoices.get(id),selected=this.snapshot(id);return !!active&&(active.model!==selected.model||active.effort!==selected.effort);}
 selection(method,p){return this.requested(p)||(method==='turn/start'?this.selectedModel(p?.threadId):null);}
 selectionOnly(method,p){return method==='thread/resume'&&typeof p?.model==='string'&&Object.keys(p).every(k=>['threadId','model','effort','excludeTurns'].includes(k));}
 choose(id,model,effort){const before=this.choices[id];this.choices[id]={model:model||null,effort:effort===undefined?(before?.model===model?before.effort:null):effort};this.save();}
 setDefault(engine){
  if(engine==='codex'){this.defaultModel=null;this.save();return;}
  const h=this.providers.get(engine);if(!h)throw Error('無效的模型供應商。');h.setDefault(engine);this.defaultModel=h.newThread.model;this.save();
 }
 configWrite(method,p){
  const edits=method==='config/batchWrite'?p?.edits||[]:[{keyPath:p?.keyPath,value:p?.value,mergeStrategy:p?.mergeStrategy}];
  const model=edits.find(e=>e.keyPath==='model'),effort=edits.find(e=>e.keyPath==='model_reasoning_effort');
  if(model){this.defaultModel=this.isModel(model.value)?model.value:null;this.save();}
  const h=this.owner(this.defaultModel);
  if(!h)return null;
  h.newThread={model:this.defaultModel,effort:effort?effort.value:(h.newThread?.model===this.defaultModel?h.newThread.effort:null)};h.save();
  return {method:'config/batchWrite',params:{...p,edits:edits.filter(e=>!['model','model_reasoning_effort'].includes(e.keyPath)),keyPath:undefined,value:undefined,mergeStrategy:undefined}};
 }
 readConfig(r){const h=this.owner(this.defaultModel);return h?{...r,config:{...r.config,model:this.defaultModel,model_reasoning_effort:h.newThread?.effort??null}}:r;}
 started(model,r){
  if(!r?.thread?.id)return r;
  const h=this.owner(model),chosen=h?model:r.model||model;
  if(chosen)this.choose(r.thread.id,chosen,h?(h.newThread?.model===model?h.newThread.effort:undefined):r.reasoningEffort??null);
  return h?{...r,model,reasoningEffort:this.selectedEffort(r.thread.id)}:r;
 }
 strip(method,p){
  const model=this.requested(p),id=p?.threadId,effort=Object.hasOwn(p||{},'effort')?p.effort:p?.collaborationMode?.settings?.reasoning_effort;
  if(id&&['turn/start','thread/settings/update','thread/resume'].includes(method)&&(model||effort!==undefined))this.choose(id,model||this.selectedModel(id),effort);
  if(!this.isModel(model))return p;
  const result={...p};delete result.model;delete result.effort;
  if(this.isModel(result.collaborationMode?.settings?.model))delete result.collaborationMode;
  return result;
 }
 async start(p,options){const h=this.owner(p.model);if(!h)throw Error('模型供應商不存在。');await this.flush(p.threadId);this.choose(p.threadId,p.model,Object.hasOwn(p,'effort')?p.effort:p.collaborationMode?.settings?.reasoning_effort);const selected=this.snapshot(p.threadId);this.activeChoices.set(p.threadId,selected);return h.start({...p,...selected},options);}
 runningProvider(id){return [...this.providers.values()].find(h=>h.running(id));}
 running(id){return !!this.runningProvider(id);}
 restartForSteer(id){const h=this.runningProvider(id);return this.changedForActive(id)||!!h&&h.provider!=='claude';}
 async replaceActiveTurn(p,{active,interrupt,start,check,timeout=15000}){
  const id=p.threadId,run=active();
  if(this.redirecting.has(id))throw Error('模型正在切換，請稍候。');
  if(!run||!p.expectedTurnId||run.turnId!==p.expectedTurnId)throw Error('目前回合已改變；訊息尚未送出，請再試一次。');
  const selected=this.snapshot(id);this.redirecting.add(id);
  try{
   check();await interrupt();
   const deadline=Date.now()+timeout;
   for(let current;(current=active());){check();if(current.turnId&&current.turnId!==run.turnId)throw Error('目前回合已改變；訊息尚未送出，請再試一次。');if(Date.now()>=deadline)throw Error('上一個回合尚未停止；新訊息未送出，請稍後重試。');await new Promise(r=>setTimeout(r,50));}
   check();await this.flush(id);check();
   const result=await start({threadId:id,input:p.input,clientUserMessageId:p.clientUserMessageId,...selected});
   return {turnId:result.turn.id};
  }finally{this.redirecting.delete(id);}
 }
 async interrupt(id){for(const h of this.providers.values())if(h.running(id))return h.interrupt(id);return false;}
 steer(p){const h=[...this.providers.values()].find(h=>h.running(p.threadId));if(!h)throw Error('no active turn to steer');return h.steer(p);}
 completed(id,turn){return this.primary.completed(id,turn);}
 async flush(id){for(const h of this.providers.values())await h.flush(id);}
 turns(id){return [...this.providers.values()].flatMap(h=>h.turns(id));}
 merge(thread){
  // Providers may anchor to each other's turns. Repeat until all reachable anchors exist.
  let result=thread;
  for(let i=0;i<this.providers.size;i++)for(const h of this.providers.values())result=h.merge(result);
  return result;
 }
 codexTurn(id){if(this.isModel(this.selectedModel(id)))this.choose(id,null,null);this.activeChoices.set(id,this.snapshot(id));}
 settings(m){
  const id=m?.params?.threadId,s=m?.params?.threadSettings,model=this.selectedModel(id);
  if(!s||!model)return m;
  const effort=this.selectedEffort(id),mode=s.collaborationMode?.settings?{...s.collaborationMode,settings:{...s.collaborationMode.settings,model,reasoning_effort:effort}}:s.collaborationMode;
  return {...m,params:{...m.params,threadSettings:{...s,model,effort,...(mode?{collaborationMode:mode}:{})}}};
 }
 attach(...args){return this.primary.attach(...args);}
 detach(...args){return this.primary.detach(...args);}
 close(){for(const h of this.providers.values())h.claude.close();}
}
module.exports={UnifiedHandoff};
