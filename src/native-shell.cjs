'use strict';
// Execute an explicitly submitted shell command with the native Mac app-server.
// The peer's disabled local environment must never become its execution target.
const fs=require('node:fs'),crypto=require('node:crypto');
class NativeShell {
 constructor({ready,getRpc,emit,onError,file}){Object.assign(this,{ready,getRpc,emit,onError,file});this.active=null;this.cursorKey=crypto.randomBytes(32);this.history=file&&fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};}
 async readThread(rpc,params,knownEmpty=false){
  try{return await rpc.request('thread/read',params);}
  catch(error){
   // Codex 0.160 cannot list turns before the first model turn exists.
   // Only a locally tracked, never-started thread may use the metadata fallback.
   if(!params.includeTurns||!knownEmpty||error.message!=='list_turns is not supported yet')throw error;
   return rpc.request('thread/read',{...params,includeTurns:false});
  }
 }
 merge(thread){
  if(!Array.isArray(thread.turns))return thread;
  const turns=[...thread.turns],records=this.history[thread.id]||[];
  for(const record of [...records].reverse()){
   // The native completion event may say notLoaded even though item/completed
   // supplied every command card. Our own persisted cards are the authority;
   // repair that legacy marker only for locally recorded shell turns.
   const localTurn={...record.turn,itemsView:'full'};
   const existing=turns.findIndex(t=>t.id===record.turn.id);
   if(existing>=0){turns[existing]=localTurn;continue;}
   const anchor=record.anchor?turns.findIndex(t=>t.id===record.anchor):-1;
   // A missing anchor can indicate truncated or rolled-back history. Do not append stale commands.
   if(record.anchor&&anchor<0)continue;
   turns.splice(anchor+1,0,localTurn);
  }
  return {...thread,turns};
 }
 // Cursors describe positions, not frozen pages: reversing a cursor sees later updates.
 hasHistory(threadId){return (this.history[threadId]?.length||0)>0;}
 cursor(scope,position){
  const body=Buffer.from(JSON.stringify({...scope,...position})).toString('base64url');
  return 'ocsh1.'+body+'.'+crypto.createHmac('sha256',this.cursorKey).update(body).digest('base64url');
 }
 decodeCursor(value,scope){
  if(typeof value!=='string'||!value.startsWith('ocsh1.'))throw Error('Shell 歷史分頁已變更，請重新載入對話。');
  const [prefix,body,signature,...extra]=value.split('.');
  const expected=crypto.createHmac('sha256',this.cursorKey).update(body||'').digest('base64url');
  if(extra.length||!signature||signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw Error('無效的 Shell 歷史游標。');
  let parsed;try{parsed=JSON.parse(Buffer.from(body,'base64url').toString());}catch{throw Error('無效的 Shell 歷史游標。');}
  const globalItemCursor=scope.kind==='items'&&parsed.turnId===null;
  if(parsed.threadId!==scope.threadId||parsed.kind!==scope.kind||(parsed.turnId!==scope.turnId&&!globalItemCursor))throw Error('Shell 歷史游標不屬於這個對話或範圍。');
  return parsed;
 }
 async collect(rpc,method,params,{knownEmpty=false}={}){
  const data=[],seen=new Set();let cursor=null;
  for(let page=0;page<1000;page++){
   let result;
   try{result=await rpc.request(method,{...params,cursor,limit:100,sortDirection:'asc'});}
   catch(error){
    if(page===0&&knownEmpty&&error.message==='list_turns is not supported yet')return [];
    throw error;
   }
   if(!Array.isArray(result.data))throw Error('遠端歷史回應缺少資料。');
   data.push(...result.data);
   if(data.length>100000)throw Error('Shell 合併歷史超過本次可讀取範圍。');
   if(!result.nextCursor)return data;
   if(seen.has(result.nextCursor))throw Error('遠端歷史游標重複，已停止讀取。');
   seen.add(result.nextCursor);cursor=result.nextCursor;
  }
  throw Error('Shell 合併歷史超過本次可讀取頁數。');
 }
 async listCached(method,params,cachedThread,{complete=false}={}){
  if(!complete)throw Error('此對話尚未快取完整歷史，請連線後重新載入。');
  if(cachedThread?.id!==params.threadId||!Array.isArray(cachedThread.turns))throw Error('離線歷史快取不屬於此對話或缺少回合。');
  const snapshot=this.merge(structuredClone(cachedThread));
  if(snapshot.turns.some(turn=>!Array.isArray(turn.items)||(turn.itemsView&&turn.itemsView!=='full')))throw Error('此對話只快取了部分項目，請連線後重新載入完整歷史。');
  // The cache contains a full historical snapshot, not paginated native engine
  // cursors. Reuse merged ordering/cursors and keep absent item timestamps null.
  const rpc={request:async(method,p)=>{
   if(method==='thread/turns/list')return {data:snapshot.turns.map(turn=>({...turn,items:p.itemsView==='notLoaded'?[]:turn.items,itemsView:p.itemsView==='notLoaded'?'notLoaded':'full'})),nextCursor:null};
   if(method==='thread/items/list')return {data:snapshot.turns.filter(turn=>!p.turnId||turn.id===p.turnId).flatMap(turn=>turn.items.map(item=>({turnId:turn.id,item,startedAtMs:null,completedAtMs:null}))),nextCursor:null};
   throw Error('不支援的離線歷史方法。');
  }};
  return this.list(rpc,method,params,{forceMerge:true});
 }
 async list(rpc,method,params,options={}){
  const kind=method==='thread/turns/list'?'turns':method==='thread/items/list'?'items':null;
  if(!kind)throw Error('不支援的 Shell 歷史方法。');
  const ownCursor=typeof params.cursor==='string'&&params.cursor.startsWith('ocsh1.');
  if(!this.hasHistory(params.threadId)&&!ownCursor&&!options.forceMerge)return rpc.request(method,params);
  const scope={threadId:params.threadId,kind,turnId:kind==='items'?(params.turnId||null):null};
  const direction=params.sortDirection??(kind==='turns'?'desc':'asc');
  if(!['asc','desc'].includes(direction))throw Error('無效的歷史排序方向。');
  const requestedLimit=params.limit??25;
  if(!Number.isInteger(requestedLimit)||requestedLimit<0||requestedLimit>4294967295)throw Error('歷史分頁 limit 必須為非負整數。');
  const limit=Math.max(1,Math.min(100,requestedLimit));
  let position=null;
  if(params.cursor!=null){
   if(typeof params.cursor==='object'){
    if(kind!=='items'||!scope.turnId||params.cursor.type!=='item'||typeof params.cursor.itemId!=='string')throw Error('項目錨點需要有效的 turnId 與 itemId。');
    position={anchor:[scope.turnId,params.cursor.itemId],inclusive:false};
   }else position=this.decodeCursor(params.cursor,scope);
  }
  const view=params.itemsView??'summary';
  if(kind==='turns'&&!['full','summary','notLoaded'].includes(view))throw Error('無效的歷史項目檢視。');
  const remoteTurns=await this.collect(rpc,'thread/turns/list',{threadId:params.threadId,itemsView:kind==='turns'?view:'notLoaded'},options);
  const merged=this.merge({id:params.threadId,turns:remoteTurns}).turns;
  let rows;
  if(kind==='turns'){
   const localIds=new Set((this.history[params.threadId]||[]).map(r=>r.turn.id));
   // A local command has one full native card. Label it full instead of pretending
   // an incomplete command card is the engine's user/assistant summary projection.
   rows=merged.map(turn=>localIds.has(turn.id)?{...turn,items:view==='notLoaded'?[]:turn.items,itemsView:view==='notLoaded'?'notLoaded':'full'}:turn);
  }else{
   const localRecords=new Map((this.history[params.threadId]||[]).map(r=>[r.turn.id,r]));
   if(scope.turnId&&!merged.some(t=>t.id===scope.turnId))throw Error('找不到指定的歷史回合。');
   // A global head cursor can seed one turn's item list. Keep global ordering
   // until the cursor boundary is applied, then filter to the requested turn.
   const filterTurn=position?.turnId===null?null:scope.turnId;
   const peerRows=filterTurn&&localRecords.has(filterTurn)?[]:await this.collect(rpc,method,{threadId:params.threadId,...(filterTurn?{turnId:filterTurn}:{})},options);
   const byTurn=new Map();
   for(const entry of peerRows){const entries=byTurn.get(entry.turnId)||[];entries.push(entry);byTurn.set(entry.turnId,entries);}
   rows=merged.filter(turn=>!filterTurn||turn.id===filterTurn).flatMap(turn=>{
    const record=localRecords.get(turn.id);
    return record?record.turn.items.map(item=>({turnId:turn.id,item,startedAtMs:null,completedAtMs:null})):(byTurn.get(turn.id)||[]);
   });
  }
  const key=row=>kind==='turns'?row.id:[row.turnId,row.item.id];
  if(direction==='desc')rows=rows.slice().reverse();
  let start=0;
  if(position?.edge){
   if(position.edge!=='end')throw Error('無效的歷史游標位置。');
   start=direction==='desc'?0:Math.max(0,rows.length-1);
  }else if(position){
   const anchor=JSON.stringify(position.anchor),index=rows.findIndex(row=>JSON.stringify(key(row))===anchor);
   if(index<0)throw Error('歷史游標的錨點已不存在，請重新載入對話。');
   start=index+(position.inclusive?0:1);
  }
  rows=rows.slice(start);
  if(kind==='items'&&scope.turnId)rows=rows.filter(row=>row.turnId===scope.turnId);
  const data=rows.slice(0,limit),last=data.at(-1);
  return {data,nextCursor:last&&data.length<rows.length?this.cursor(scope,{anchor:key(last),inclusive:false}):null,
   backwardsCursor:data.length?this.cursor(scope,{anchor:key(data[0]),inclusive:true}):null};
 }
 async withHistoryCursors(result,rpc,options={}){
  const id=result.thread?.id;if(!id||!this.hasHistory(id))return result;
  const next={...result};
  for(const [field,kind] of [['turnsBackwardsCursor','turns'],['itemsBackwardsCursor','items']]){
   if(!Object.hasOwn(result,field))continue;
   // Snapshot an actual anchor: a dynamic end marker would skip new turns when
   // the renderer later reverses this cursor to catch up after resume.
   const page=await this.list(rpc,'thread/'+kind+'/list',{threadId:id,sortDirection:'desc',limit:1,...(kind==='turns'?{itemsView:'notLoaded'}:{})},options);
   next[field]=page.backwardsCursor;
  }
  return next;
 }
 prepareHistoryMutation(method,params,sourceThread){
  if(!['thread/fork','thread/revert','thread/delete'].includes(method))return null;
  const records=this.history[params.threadId]||[];
  if(!records.length)return null;
  if(this.active?.remoteThreadId===params.threadId)throw Error('請先停止 Mac 指令，再變更歷史。');
  if(method==='thread/delete')return {method,threadId:params.threadId,records:[]};
  if(sourceThread?.id!==params.threadId||!Array.isArray(sourceThread.turns))throw Error('變更 Shell 歷史前必須讀取完整的來源回合。');
  const turns=this.merge(sourceThread).turns;
  const cutoff=method==='thread/fork'?params.lastTurnId:params.beforeTurnId;
  if(cutoff&&records.some(record=>record.turn.id===cutoff))throw Error('目前無法以 Mac Shell 指令作為分支或回復截點；請選擇模型回合。');
  if(method==='thread/revert'&&!cutoff)throw Error('回復歷史需要 beforeTurnId。');
  const index=cutoff?turns.findIndex(turn=>turn.id===cutoff):turns.length-1;
  if(cutoff&&index<0)throw Error('找不到指定的歷史截點。');
  const retained=new Set(turns.slice(0,index+(method==='thread/fork'?1:0)).map(turn=>turn.id));
  return {method,threadId:params.threadId,records:structuredClone(records.filter(record=>retained.has(record.turn.id)))};
 }
 async commitHistoryMutation(plan,result,rpc,options={}){
  if(!plan)return this.withHistoryCursors(result,rpc,options);
  const target=plan.method==='thread/fork'?result.thread?.id:plan.threadId;
  if(!target||(plan.method==='thread/fork'&&target===plan.threadId))throw Error('遠端分支回應缺少新的對話 ID。');
  if(plan.method==='thread/revert'&&result.thread?.id!==target)throw Error('遠端回復回應不屬於來源對話。');
  const history={...this.history};
  if(plan.records.length)history[target]=structuredClone(plan.records);else delete history[target];
  this.persist(history);
  return this.withHistoryCursors(result,rpc,options);
 }
 persist(history){
  if(this.file){fs.writeFileSync(this.file+'.tmp',JSON.stringify(history),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
  this.history=history;
 }
 save(state,turn){
  this.persist({...this.history,[state.remoteThreadId]:[...(this.history[state.remoteThreadId]||[]),{anchor:state.anchor,turn:{...turn,items:state.items,itemsView:'full'}}]});
 }
 async start(params,{cwd,remoteRpc,anchor=null}){
  if(this.active)throw Error('Mac 指令仍在執行，請先停止目前工作。');
  const state={remoteThreadId:params.threadId,remoteRpc,anchor,items:[],cancelled:false};this.active=state;
  try{
   await this.ready();state.rpc=this.getRpc();
   const thread=await state.rpc.request('thread/start',{cwd,ephemeral:true});
   state.localThreadId=thread.thread.id;
   if(state.cancelled)throw Error('Mac 指令已取消。');
   return await state.rpc.request('thread/shellCommand',{...params,threadId:state.localThreadId});
  }catch(e){if(this.active===state)this.active=null;throw e;}
 }
 notification(message){
  const state=this.active;
  if(!state||message.params?.threadId!==state.localThreadId)return false;
  const mapped={...message,params:{...message.params,threadId:state.remoteThreadId}};
  if(message.method==='turn/started'){
   state.turnId=message.params.turn.id;
   if(state.cancelled)void this.interrupt().catch(e=>this.onError?.(e));
  }
  if(message.method==='item/completed'&&message.params.item?.type==='commandExecution')state.items.push(message.params.item);
  if(message.method==='turn/completed'){
   void this.complete(state,mapped);return true;
  }
  this.emit(mapped);return true;
 }
 async complete(state,message){
  try{
   const text=state.items.map(i=>'使用者在 Mac 執行的 Shell 指令（實際輸出）：\n工作目錄：'+i.cwd+'\n指令：'+i.command+'\n狀態：'+i.status+'；exit code：'+i.exitCode+'\n<untrusted_shell_output>\n'+String(i.aggregatedOutput||'').slice(0,131072)+'\n</untrusted_shell_output>').join('\n\n');
   if(text)await state.remoteRpc.request('thread/inject_items',{threadId:state.remoteThreadId,items:[{type:'message',role:'user',content:[{type:'input_text',text}]}]});
  }catch(e){
   message={...message,params:{...message.params,turn:{...message.params.turn,status:'failed',error:{message:'Mac 指令已結束，但結果未寫入遠端對話：'+e.message,codexErrorInfo:null,additionalDetails:null}}}};
   this.onError?.(e);
  }finally{
   try{this.save(state,message.params.turn);}catch(e){message={...message,params:{...message.params,turn:{...message.params.turn,status:'failed',error:{message:'Mac 指令紀錄無法保存：'+e.message,codexErrorInfo:null,additionalDetails:null}}}};this.onError?.(e);}
   if(this.active===state)this.active=null;this.emit(message);
   if(state.localThreadId)state.rpc.request('thread/unsubscribe',{threadId:state.localThreadId}).catch(()=>{});
  }
 }
 async interrupt(){
  const state=this.active;if(!state)return false;state.cancelled=true;
  if(state.turnId)await state.rpc.request('turn/interrupt',{threadId:state.localThreadId,turnId:state.turnId});
  return true;
 }
}
module.exports={NativeShell};
