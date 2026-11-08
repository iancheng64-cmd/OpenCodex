'use strict';
// Codex continues an active goal as soon as a thread is idle, including right after
// thread/resume. A resumed thread has no Mac environment until turn/start selects one,
// so that turn would run with no Mac tool. Hold the goal across the gap and persist the
// hold: a paused goal this app paused must become active again even after a restart.
const fs=require('node:fs'),crypto=require('node:crypto');
class GoalGuard{
 constructor({file,audit=()=>{},timeoutMs=10000}){
  Object.assign(this,{file,audit,timeoutMs});this.holds=new Map();
  try{for(const [id,value]of Object.entries(JSON.parse(fs.readFileSync(file,'utf8'))))this.holds.set(id,value);}
  catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
 }
 save(){
  const temporary=this.file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(Object.fromEntries(this.holds)),{mode:0o600,flag:'wx'});fs.renameSync(temporary,this.file);}
  finally{try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
 }
 held(threadId){return this.holds.has(threadId);}
 // Never blocks opening a conversation: without goals support there is nothing to hold.
 async hold(rpc,threadId){
  if(!threadId)return false;
  let goal;
  try{goal=(await rpc.request('thread/goal/get',{threadId},this.timeoutMs))?.goal;}catch{return false;}
  if(goal?.status!=='active')return false;
  try{await rpc.request('thread/goal/set',{threadId,status:'paused'},this.timeoutMs);}
  catch(error){this.audit('goal-hold-failed',{threadId,message:error.message});return false;}
  this.holds.set(threadId,{at:Date.now()});this.save();
  this.audit('goal-held',{threadId});
  return true;
 }
 note(threadId){this.holds.set(threadId,{at:Date.now()});this.save();}
 // The turn that selected the Mac environment is running, so continuations now have tools.
 async release(rpc,threadId){
  if(!this.holds.has(threadId))return false;
  try{await rpc.request('thread/goal/set',{threadId,status:'active'},this.timeoutMs);}
  catch(error){this.audit('goal-release-failed',{threadId,message:error.message});return false;}
  this.forget(threadId);
  this.audit('goal-released',{threadId});
  return true;
 }
 forget(threadId){if(this.holds.delete(threadId))this.save();}
}
// A goal/set that would leave this thread active. Without a status the server keeps the
// current goal's status, or makes a new goal active.
function activatesGoal(params,current){return params?.status==='active'||(params?.status==null&&typeof params?.objective==='string'&&!current);}
// A dropped connection ends the running turn but not the user's goal. Ordinary messages are
// never resent; a goal is standing authorization to keep working until it is done.
async function continueInterruptedGoal({rpc,threadId,start,timeoutMs=10000}){
 if(!threadId)return false;
 const goal=(await rpc.request('thread/goal/get',{threadId},timeoutMs))?.goal;
 if(goal?.status!=='active')return false;
 await start({threadId,input:[{type:'text',text:'連線已恢復，請從中斷處繼續目前目標。',text_elements:[]}]});
 return true;
}
module.exports={GoalGuard,activatesGoal,continueInterruptedGoal};
