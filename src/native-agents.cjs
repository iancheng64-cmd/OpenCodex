'use strict';
// Native MCP entry point for the same text discussion engine as AgentBridge.
// Model output stays inside the calling native conversation's tool result.
const crypto=require('node:crypto');
class NativeAgents{
 constructor({getPeers,invoke,reservePeers=async()=>()=>{},onState=()=>{}}){Object.assign(this,{getPeers,invoke,reservePeers,onState});this.active=null;}
 state(){
  const peers=this.getPeers(),result={};
  for(const agent of ['codex','claude']){
   const r=peers[agent],connected=!!r&&!r.closed;
   const account=agent==='claude'&&connected?r.cli.status().account:null;
   result[agent]={connected,host:r?.hostName||r?.snapshot?.hostName||null,profileId:r?.network?.profileId||r?.snapshot?.profileId||null,
    authentication:agent==='claude'?(connected?(account?.verified===true?(account.authenticated?'authenticated':'required'):'unverified'):'disconnected'):null};
  }
  return {peers:result,ready:result.codex.connected&&result.claude.connected&&result.claude.authentication==='authenticated',busy:!!this.active,activity:this.active?.activity||null};
 }
 spec(){const owner=this;return {id:'opencodex-native:agents',name:'OpenCodex 雙代理',transport:'native',createClient(){return {running:true,
  start:async()=>[
   {name:'opencodex_agents_status',description:'Check the connected Codex and Claude peers before requesting a cross-model discussion.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
   {name:'opencodex_agents_discuss',description:'Ask the connected Codex and Claude agents to discuss a topic, critique each other, and return the transcript and final synthesis in this conversation. Text-only reasoning; no tools or file changes during discussion. Requires both peers and verified Claude login. Stop cancels the discussion.',inputSchema:{type:'object',properties:{topic:{type:'string',minLength:1,maxLength:20000},rounds:{type:'integer',minimum:1,maximum:8,default:1},leadAgent:{type:'string',enum:['codex','claude']}},required:['topic'],additionalProperties:false}}
  ],call:async(name,args,signal)=>{try{return {content:[{type:'text',text:JSON.stringify(name==='opencodex_agents_status'?owner.state():name==='opencodex_agents_discuss'?await owner.discuss(args,signal):(()=>{throw Error('Unknown OpenCodex agent tool');})())}]};}catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}},stop:async function(){this.running=false;}};}};}
 async discuss(input={},signal){
  if(signal?.aborted)throw Error('雙代理討論已取消。');
  if(this.active)throw Error('已有雙代理討論進行中，請先停止。');
  if(typeof input.topic!=='string'||!input.topic.trim()||input.topic.length>20000)throw Error('討論主題須為 1 到 20000 字。');
  const rounds=input.rounds??1,leadAgent=input.leadAgent??'codex';
  if(!Number.isInteger(rounds)||rounds<1||rounds>8||!['codex','claude'].includes(leadAgent))throw Error('雙代理討論設定無效。');
  if(!this.state().ready)throw Error('請在 SSH 連線中連接 Codex 與 Claude，並確認 Claude 已登入。');
  const peers=this.getPeers(),id=crypto.randomUUID();
  const run={id,turns:[],activity:'正在準備雙代理討論…',cancelled:false};
  const done=new Promise((resolve,reject)=>Object.assign(run,{resolve,reject}));done.catch(()=>{});
  // Cancellation may arrive while the vendor acquires its background leases.
  // Keep the run tracked until its done event; it must never start another one.
  const abort=()=>{run.cancelled=true;run.activity='正在停止雙代理討論…';this.onState();this.invoke('orchestrator:cancel',id).catch(e=>{run.error=e.message;});run.reject(Error('雙代理討論已取消。'));};
  run.cleanup=()=>{clearTimeout(run.timer);signal?.removeEventListener('abort',abort);run.release?.();run.release=null;};
  this.active=run;run.timer=setTimeout(abort,30*60*1000);run.timer.unref?.();this.onState();
  try{
   // Native conversations use the root directly. Reserve it so the discussion
   // pool opens isolated child processes instead of borrowing the active turn.
   run.release=await this.reservePeers(peers,id);
   if(run.cancelled||signal?.aborted)throw Error('雙代理討論已取消。');
   await this.invoke('orchestrator:start',{topic:input.topic.trim(),rounds,leadAgent,requestId:id,codexRuntimeId:peers.codex.id,claudeRuntimeId:peers.claude.cli.id});
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   if(this.active!==run)run.cleanup();
  }catch(error){run.cleanup();if(this.active===run)this.active=null;this.onState();throw error;}
  return done;
 }
 event(event){
  const run=this.active;if(!run||event.runId!==run.id)return;
  if(event.type==='activity')run.activity=event.text;
  if(event.type==='turn')run.turns.push({agent:event.agent,round:event.round,text:event.text});
  if(event.type==='final')run.final=event.text;
  if(event.type==='error')run.error=event.text;
  if(event.type==='done'){
   run.cleanup();this.active=null;
   if(event.status==='completed'&&!run.cancelled)run.resolve({status:'completed',turns:run.turns,final:event.final||run.final||''});
   else run.reject(Error(run.cancelled?'雙代理討論已取消。':run.error||'雙代理討論未完成。'));
  }
  this.onState();
 }
 async cancel(){const r=this.active;if(!r)return;r.cancelled=true;r.activity='正在停止雙代理討論…';this.onState();await this.invoke('orchestrator:cancel',r.id);}
}
async function reserveAgentRoots(peers,id,{codex,claude}){
 const jobs=[
  [codex.acquireCodexTask,codex.releaseCodexTask,peers.codex.id,'codex'],
  [claude.acquireClaudeTask,claude.releaseClaudeTask,peers.claude.cli.id,'claude']
 ];
 const settled=await Promise.allSettled(jobs.map(([acquire,,root,agent])=>acquire(root,'opencodex-native-root:'+agent+':'+id,id)));
 let released=false;
 const release=()=>{if(released)return;released=true;for(let i=0;i<settled.length;i++)if(settled[i].status==='fulfilled')jobs[i][1](settled[i].value.runtimeId,id);};
 const failed=settled.find(r=>r.status==='rejected');if(failed){release();throw failed.reason;}
 return release;
}
module.exports={NativeAgents,reserveAgentRoots};
