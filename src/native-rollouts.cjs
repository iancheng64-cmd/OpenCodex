'use strict';
// Rollout mirror and cross-host continuation helpers.
//
// The engine keeps every conversation as a JSONL "rollout" under CODEX_HOME/sessions/YYYY/MM/DD
// on the host that ran it. While a host is connected, each conversation's rollout is mirrored here
// (gzip, one file per host+conversation, keyed like native-history). To continue a conversation on
// a different host, the mirror (or, when none exists, a rollout synthesized from the cached
// history) is uploaded into that host's sessions directory and the engine resumes it by path.
//
// Transfers run over the runtime's own SSH connection (ssh2 exec). The engine's fs/* and
// command/exec APIs need a "local environment" that this adapter never configures.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const MAX_BYTES=48*1024*1024;
const key=(id,profile)=>{if(typeof id!=='string'||!id||typeof profile!=='string'||!profile)throw Error('rollout 鏡像缺少主機或對話識別碼。');return crypto.createHash('sha256').update(JSON.stringify([profile,id])).digest('hex');};
function firstLine(buffer){const end=buffer.indexOf(10);return buffer.subarray(0,end<0?buffer.length:end).toString('utf8');}
// The session_meta line that opens every plain rollout; null when the buffer is not one.
function sessionMeta(buffer){try{const line=JSON.parse(firstLine(buffer));return line?.type==='session_meta'&&line.payload?.id?line:null;}catch{return null;}}
class NativeRollouts{
 constructor(directory,{onError=()=>{}}={}){this.directory=directory;this.onError=onError;fs.mkdirSync(directory,{recursive:true,mode:0o700});}
 paths(id,profile){const base=path.join(this.directory,key(id,profile));return {data:base+'.jsonl.gz',meta:base+'.json'};}
 meta(id,profile){
  try{const m=JSON.parse(fs.readFileSync(this.paths(id,profile).meta,'utf8'));return m.version===1&&m.id===id&&m.profile===profile?m:null;}
  catch(e){if(e.code!=='ENOENT')this.onError(e);return null;}
 }
 has(id,profile){return !!this.meta(id,profile)&&fs.existsSync(this.paths(id,profile).data);}
 get(id,profile){
  const meta=this.meta(id,profile);if(!meta)return null;
  try{return {meta,data:zlib.gunzipSync(fs.readFileSync(this.paths(id,profile).data))};}
  catch(e){if(e.code!=='ENOENT')this.onError(e);return null;}
 }
 // data: the rollout file as the owning host stores it; remotePath: where that host keeps it.
 set(id,profile,data,{remotePath,updatedAt=null,compressed=false}={}){
  if(!Buffer.isBuffer(data)||!data.length)throw Error('rollout 內容為空。');
  if(data.length>MAX_BYTES)throw Error('rollout 超過 '+Math.round(MAX_BYTES/1048576)+' MB，未鏡像。');
  if(typeof remotePath!=='string'||!remotePath.startsWith('/'))throw Error('rollout 缺少遠端路徑。');
  if(!compressed){const meta=sessionMeta(data);if(!meta)throw Error('rollout 開頭不是 session_meta。');if(meta.payload.id!==id)throw Error('rollout 不屬於此對話。');}
  const files=this.paths(id,profile),tmp=files.data+'.'+crypto.randomUUID()+'.tmp';
  try{
   fs.writeFileSync(tmp,zlib.gzipSync(data),{mode:0o600,flag:'wx'});fs.renameSync(tmp,files.data);
   const meta={version:1,id,profile,remotePath,basename:path.posix.basename(remotePath),bytes:data.length,compressed,updatedAt,savedAt:new Date().toISOString()};
   fs.writeFileSync(files.meta,JSON.stringify(meta),{mode:0o600});return meta;
  }finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')this.onError(e);}}
 }
 delete(id,profile){const files=this.paths(id,profile);for(const f of [files.data,files.meta])fs.rmSync(f,{force:true});}
}

// --- Rollout file names and the engine's sessions layout ---
const pad=n=>String(n).padStart(2,'0');
// Engine timestamps are unix seconds; cached snapshots may already hold milliseconds.
const toMs=v=>{const n=Number(v);if(!Number.isFinite(n)||n<=0)return Date.now();return n<1e12?n*1000:n;};
const iso=v=>new Date(toMs(v)).toISOString();
// rollout-YYYY-MM-DDThh-mm-ss-<thread id>.jsonl, the engine's own layout, dated from creation.
function basenameFor(thread){
 const d=new Date(toMs(thread.createdAt));
 return `rollout-${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}-${thread.id}.jsonl`;
}
// sessions/YYYY/MM/DD comes from the file name's date, which is how the engine lists rollouts.
function sessionsPath(codexHome,basename){
 const m=/^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(basename);
 if(!m||!/^[A-Za-z0-9._-]+$/.test(basename))throw Error('rollout 檔名無法辨識。');
 if(typeof codexHome!=='string'||!codexHome.startsWith('/'))throw Error('CODEX_HOME 必須是絕對路徑。');
 return path.posix.join(codexHome,'sessions',m[1],m[2],m[3],basename);
}
// CODEX_HOME of a host, from a rollout path its engine reported (…/sessions/YYYY/MM/DD/file).
function codexHomeFromPaths(paths){
 const sample=(paths||[]).find(p=>typeof p==='string'&&p.startsWith('/')&&p.includes('/sessions/'));
 return sample?sample.slice(0,sample.indexOf('/sessions/')):null;
}

// --- Remote host helpers over the runtime's SSH connection (ssh2 Client: conn.exec) ---
const sq=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
function sshExec(conn,command,{stdin=null,timeout=180000,maxOutput=MAX_BYTES+4096}={}){
 return new Promise((resolve,reject)=>{
  if(!conn||typeof conn.exec!=='function')return reject(Error('這個 SSH 連線無法執行指令。'));
  let settled=false;
  const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
  const timer=setTimeout(()=>finish(reject,Error('SSH 指令逾時。')),timeout);
  conn.exec(command,{pty:false},(error,stream)=>{
   if(error)return finish(reject,error);
   const out=[],err=[];let outBytes=0;
   stream.on('data',chunk=>{outBytes+=chunk.length;if(outBytes<=maxOutput)out.push(chunk);});
   stream.stderr?.on('data',chunk=>{if(err.length<64)err.push(chunk);});
   stream.on('error',e=>finish(reject,e));
   stream.on('close',(code,signal)=>finish(resolve,{code:code??(signal?1:0),stdout:Buffer.concat(out),stderr:Buffer.concat(err).toString('utf8').slice(0,2000),truncated:outBytes>maxOutput}));
   if(stdin)stream.end(stdin);else stream.end();
  });
 });
}
// The login shell's CODEX_HOME (or ~/.codex). Only a fallback: the engine's own rollout paths say
// where it really writes, and a wrapper script may set CODEX_HOME that a login shell never sees.
async function remoteCodexHomeViaShell(conn){
 const r=await sshExec(conn,'sh -lc \'printf "%s\\n" "${CODEX_HOME:-$HOME/.codex}"\'',{timeout:20000});
 const home=r.stdout.toString('utf8').trim().split('\n').at(-1)?.trim()||'';
 if(r.code!==0||!home.startsWith('/'))throw Error('無法判斷目前主機的 CODEX_HOME。');
 return home;
}
// File size on the host, or null when it does not exist (macOS and GNU stat spellings).
async function remoteSize(conn,remotePath){
 const r=await sshExec(conn,`stat -f %z ${sq(remotePath)} 2>/dev/null || stat -c %s ${sq(remotePath)} 2>/dev/null`,{timeout:20000});
 const n=Number(r.stdout.toString('utf8').trim());
 return r.code===0&&Number.isInteger(n)?n:null;
}
// Read a conversation's rollout from its host. A compressed (.jsonl.zst) rollout is returned as-is.
async function download(conn,remotePath){
 let p=remotePath,compressed=remotePath.endsWith('.zst'),size=await remoteSize(conn,p);
 if(size===null&&!compressed){p=remotePath+'.zst';compressed=true;size=await remoteSize(conn,p);}
 if(size===null)throw Error('主機上找不到 rollout 檔案。');
 if(!size)throw Error('rollout 內容為空。');
 if(size>MAX_BYTES)throw Error('rollout 超過 '+Math.round(MAX_BYTES/1048576)+' MB，未鏡像。');
 const r=await sshExec(conn,`cat ${sq(p)}`,{timeout:600000});
 if(r.code!==0)throw Error('讀取 rollout 失敗：'+r.stderr.trim());
 if(r.stdout.length!==size)throw Error(`rollout 讀取不完整（${r.stdout.length}/${size} bytes）。`);
 return {data:r.stdout,remotePath:p,compressed};
}
// Write a rollout into the target host (via a temp file) and verify its size there.
async function upload(conn,remotePath,data){
 if(!Buffer.isBuffer(data)||!data.length)throw Error('沒有可上傳的 rollout。');
 const tmp=remotePath+'.tmp';
 const r=await sshExec(conn,`mkdir -p ${sq(path.posix.dirname(remotePath))} && cat > ${sq(tmp)} && mv -f ${sq(tmp)} ${sq(remotePath)}`,{stdin:data,timeout:600000});
 if(r.code!==0)throw Error('寫入 rollout 失敗：'+r.stderr.trim());
 const size=await remoteSize(conn,remotePath);
 if(size!==data.length)throw Error(`rollout 上傳後大小不符（${size}/${data.length} bytes）。`);
 return {bytes:data.length};
}

// --- Synthesis from the cached v2 history (for conversations mirrored before this version) ---
function text(parts){return (Array.isArray(parts)?parts:[]).map(p=>typeof p==='string'?p:p?.type==='text'?p.text:p?.type==='image'||p?.type==='localImage'?'[image]':'').filter(Boolean).join('\n');}
const clip=(value,max=20000)=>{const s=typeof value==='string'?value:JSON.stringify(value??null);return s.length>max?s.slice(0,max)+'\n…[truncated]':s;};
// The engine's history items for one window item; what the model must see again to continue.
function responseItems(item){
 const call=()=>'call_'+String(item.id||crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g,'').slice(0,40);
 switch(item?.type){
  case 'userMessage':{const t=text(item.content);return t?[{type:'message',role:'user',content:[{type:'input_text',text:t}]}]:[];}
  case 'agentMessage':return typeof item.text==='string'&&item.text?[{type:'message',role:'assistant',content:[{type:'output_text',text:item.text}]}]:[];
  case 'reasoning':{const summary=(item.summary||[]).map(s=>typeof s==='string'?s:s?.text).filter(Boolean);return summary.length?[{type:'reasoning',summary:summary.map(t=>({type:'summary_text',text:t})),content:null,encrypted_content:null}]:[];}
  case 'commandExecution':{const id=call();return [{type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:item.command||''}),call_id:id},{type:'function_call_output',call_id:id,output:clip(item.aggregatedOutput||'')+(item.exitCode!=null?`\n[exit code ${item.exitCode}]`:'')}];}
  case 'fileChange':{const id=call();const patch=['*** Begin Patch',...(item.changes||[]).flatMap(c=>[`*** ${c.kind==='add'?'Add':c.kind==='delete'?'Delete':'Update'} File: ${c.path}`,...(c.diff?[String(c.diff).trimEnd()]:[])]),'*** End Patch'].join('\n');return [{type:'custom_tool_call',name:'apply_patch',input:clip(patch),call_id:id},{type:'custom_tool_call_output',call_id:id,output:item.status==='completed'?'Done':String(item.status||'')}];}
  case 'mcpToolCall':{const id=call();return [{type:'function_call',name:`mcp__${item.server||'server'}__${item.tool||'tool'}`,arguments:clip(item.arguments??{}),call_id:id},{type:'function_call_output',call_id:id,output:clip(item.result??item.error??null)}];}
  case 'webSearch':return [{type:'web_search_call',action:item.action||{type:'search',query:item.query||''},status:'completed'}];
  default:return [];
 }
}
// What the window shows for one item in a legacy rollout: the engine builds legacy turns from
// user_message / agent_message / agent_reasoning events, not from response items (which only
// feed the model). A user_message event also opens a new turn, so turns split by themselves.
function displayEvents(item){
 switch(item?.type){
  case 'userMessage':{const t=text(item.content);return t?[{type:'user_message',message:t}]:[];}
  case 'agentMessage':return typeof item.text==='string'&&item.text?[{type:'agent_message',message:item.text}]:[];
  case 'reasoning':{const summary=(item.summary||[]).map(s=>typeof s==='string'?s:s?.text).filter(Boolean);return summary.length?[{type:'agent_reasoning',text:summary.join('\n\n')}]:[];}
  default:return [];
 }
}
// A plain (legacy-mode) rollout the engine can resume: session_meta, then for every item its
// response items (model context) and its display events. Tool activity is replayed for the model
// but, like the engine's own legacy rollouts, not drawn as cards.
function synthesize(thread,{historyMode='legacy'}={}){
 if(!thread?.id||!Array.isArray(thread.turns))throw Error('缺少可合成的對話歷史。');
 const lines=[];
 const push=(timestamp,type,payload)=>lines.push(JSON.stringify({timestamp,type,payload}))-1;
 const created=iso(thread.createdAt);
 push(created,'session_meta',{id:thread.id,session_id:thread.sessionId||thread.id,timestamp:created,cwd:typeof thread.cwd==='string'&&thread.cwd.startsWith('/')?thread.cwd:'/',originator:thread.originator||'OpenCodex',cli_version:thread.cliVersion||'0.160.0',source:'vscode',history_mode:historyMode,model_provider:thread.modelProvider||'openai'});
 for(const turn of thread.turns){
  const at=iso(turn.startedAt||thread.updatedAt);
  for(const item of turn.items||[]){
   for(const ri of responseItems(item))push(at,'response_item',ri);
   for(const ev of displayEvents(item))push(at,'event_msg',ev);
  }
 }
 if(lines.length<2)throw Error('對話沒有可合成的內容。');
 return Buffer.from(lines.join('\n')+'\n','utf8');
}
module.exports={NativeRollouts,MAX_BYTES,sessionMeta,basenameFor,sessionsPath,codexHomeFromPaths,sshExec,remoteCodexHomeViaShell,remoteSize,download,upload,synthesize,responseItems,displayEvents};
