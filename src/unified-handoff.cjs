'use strict';
// One canonical Codex thread, independent provider sessions and a selection for the next turn.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
class UnifiedHandoff{
 constructor(primary,{root}){
  this.providers=new Map([[primary.provider,primary]]);this.primary=primary;this.claude=primary.claude;
  this.file=path.join(root,'unified-model-selection.json');this.choices={};this.defaultModel=primary.newThread?.model||null;
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
 selectedEffort(id){const model=this.selectedModel(id);return this.owner(model)?.effortFor(model,this.choices[id]?.effort??this.owner(model)?.threads[id]?.effort)||null;}
 selection(method,p){return this.requested(p)||(method==='turn/start'?this.selectedModel(p?.threadId):null);}
 selectionOnly(method,p){return method==='thread/resume'&&typeof p?.model==='string'&&Object.keys(p).every(k=>['threadId','model','effort','excludeTurns'].includes(k));}
 choose(id,model,effort){const before=this.choices[id];this.choices[id]={model:model||null,effort:effort===undefined?before?.effort??null:effort};this.save();}
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
  h.newThread={model:this.defaultModel,effort:effort?.value??h.newThread?.effort??null};h.save();
  return {method:'config/batchWrite',params:{...p,edits:edits.filter(e=>!['model','model_reasoning_effort'].includes(e.keyPath)),keyPath:undefined,value:undefined,mergeStrategy:undefined}};
 }
 readConfig(r){const h=this.owner(this.defaultModel);return h?{...r,config:{...r.config,model:this.defaultModel,...(h.newThread?.effort?{model_reasoning_effort:h.newThread.effort}:{})}}:r;}
 started(model,r){if(this.isModel(model)&&r?.thread?.id){this.choose(r.thread.id,model);return {...r,model};}return r;}
 strip(method,p){
  const model=this.requested(p),id=p?.threadId,effort=p?.effort??p?.collaborationMode?.settings?.reasoning_effort;
  if(id&&['turn/start','thread/settings/update','thread/resume'].includes(method)&&(model||effort))this.choose(id,model||this.selectedModel(id),effort);
  if(!this.isModel(model))return p;
  const result={...p};delete result.model;
  if(this.isModel(result.collaborationMode?.settings?.model))delete result.collaborationMode;
  return result;
 }
 async start(p,options){const h=this.owner(p.model);if(!h)throw Error('模型供應商不存在。');await this.flush(p.threadId);this.choose(p.threadId,p.model,p.effort??p.collaborationMode?.settings?.reasoning_effort);return h.start(p,options);}
 running(id){return [...this.providers.values()].some(h=>h.running(id));}
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
 codexTurn(id){this.choose(id,null,null);}
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
