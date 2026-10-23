'use strict';
const {spawn}=require('node:child_process'),EventEmitter=require('node:events');
const path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
function stable(value){
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
 return value;
}
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
// Native config/read serializes absent Option fields as null. TOML has no null;
// app-server's JSON override conversion would turn these into empty strings.
// Omit only absent object fields; retain false, zero, empty tables and arrays.
function permissionDefinitions(value){
 if(Array.isArray(value))return value.map(item=>{
  if(item===null)throw Error('權限設定陣列含有無效空值。');
  return permissionDefinitions(item);
 });
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .filter(([,item])=>item!==null).map(([key,item])=>[key,permissionDefinitions(item)]));
 return value;
}
// Configuration-only native app-server. Never starts a thread, model, or MCP tool.
// Config/requirements reads reload native layers, including trust and managed policy.
class NativePermissionCatalog{
 constructor({binary,cwd,env,AppServerRpc,timeoutMs=15000}){
  if(!path.isAbsolute(cwd))throw Error('Permission catalog requires an absolute workspace');
  Object.assign(this,{binary,cwd,AppServerRpc,timeoutMs});this.env={...env};this.closed=false;
 }
 async ready(){
  if(this.closed)throw Error('權限設定讀取已關閉。');
  if(!this.pending)this.pending=this.start().catch(error=>{this.close();throw error;});
  return this.pending;
 }
 async start(){
  const env={...this.env};delete env.CODEX_APP_SERVER_WS_URL;delete env.CODEX_EXEC_SERVER_URL;
  const child=spawn(this.binary,['app-server','--listen','stdio://','-c','cli_auth_credentials_store="file"','-c','mcp_oauth_credentials_store="file"'],{cwd:this.cwd,env,detached:true,stdio:'pipe'});
  this.child=child;
  const transport=new EventEmitter();
  transport.write=value=>child.stdin.write(value);transport.close=()=>this.kill(child);
  const rpc=new this.AppServerRpc(transport);this.rpc=rpc;
  child.stdout.on('data',value=>transport.emit('data',value));child.stderr.resume();
  child.stdin.on('error',error=>transport.emit('error',error));
  child.on('error',error=>transport.emit('error',error));child.on('close',()=>transport.emit('close'));
  rpc.on('request',message=>rpc.reject(message.id,'Permission catalog cannot authorize operations'));
  await rpc.request('initialize',{clientInfo:{name:'opencodex-permission-catalog',version:'1'},capabilities:{experimentalApi:true}},this.timeoutMs);
  rpc.notify('initialized');
  if(this.closed)throw Error('權限設定讀取已關閉。');
 }
 async read(cwd=this.cwd,signal){
  if(!path.isAbsolute(cwd))throw Error('Invalid permission workspace');
  if(signal?.aborted)throw Error('權限設定讀取已取消。');
  const abort=()=>this.close();signal?.addEventListener('abort',abort,{once:true});
  try{
   await this.ready();
   const readState=async()=>({
    configuration:await this.rpc.request('config/read',{cwd,includeLayers:true},this.timeoutMs),
    requirements:await this.rpc.request('configRequirements/read',{},this.timeoutMs)
   });
   const before=await readState(),profiles=[],seen=new Set();let cursor;
   for(let page=0;page<100;page++){
    const result=await this.rpc.request('permissionProfile/list',{cwd,limit:100,...(cursor?{cursor}:{})},this.timeoutMs);
    if(!Array.isArray(result.data))throw Error('原生權限清單無效。');
    for(const profile of result.data){
     if(typeof profile.id!=='string'||!profile.id||typeof profile.allowed!=='boolean'||seen.has(profile.id))throw Error('原生權限清單無效。');
     seen.add(profile.id);profiles.push(profile);
    }
    if(!result.nextCursor){cursor=null;break;}
    if(typeof result.nextCursor!=='string'||cursor===result.nextCursor)throw Error('原生權限清單分頁無效。');
    cursor=result.nextCursor;
   }
   if(cursor)throw Error('原生權限清單未完整讀取。');
   const after=await readState();
   if(signal?.aborted||this.closed)throw Error('權限設定讀取已取消。');
   if(hash(before)!==hash(after))throw Object.assign(Error('讀取期間權限設定已變更，請重試。'),{code:'OPENCODEX_PERMISSION_CONFIG_CHANGED'});
   const config=after.configuration.config;
   if(!config||typeof config!=='object'||!Array.isArray(after.configuration.layers))throw Error('原生權限設定無效。');
   const permissionContext=Object.freeze({cwd:pathToFileURL(cwd).href,
    ...(typeof this.env.HOME==='string'&&path.isAbsolute(this.env.HOME)?{home:pathToFileURL(this.env.HOME).href}:{})});
   return Object.freeze({cwd,profiles:Object.freeze(profiles.map(p=>Object.freeze({...p}))),
    fingerprint:hash({cwd,permissionContext,state:after,profiles}),permissionContext,
    defaultProfile:config.default_permissions??config.defaultPermissions??null,
    // Raw definitions are only for the trusted bridge, never renderer or model output.
    definitions:permissionDefinitions(config.permissions||{}),
    requirements:structuredClone(after.requirements.requirements??null)});
  }catch(error){this.close();throw error;}
  finally{signal?.removeEventListener('abort',abort);}
 }
 kill(child){
  if(!child||child.exitCode!==null||child.signalCode)return;
  const stop=signal=>{if(child.exitCode===null&&!child.signalCode)try{process.kill(-child.pid,signal);}catch{}};
  stop('SIGTERM');const timer=setTimeout(()=>stop('SIGKILL'),1000);timer.unref();
  child.once('close',()=>clearTimeout(timer));
 }
 close(){if(this.closed)return;this.closed=true;this.rpc?.close();this.kill(this.child);}
}
module.exports={NativePermissionCatalog};
