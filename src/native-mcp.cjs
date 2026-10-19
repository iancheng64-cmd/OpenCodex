'use strict';
// Resource projection for the authenticated native frontend. This module does
// not open a new HTTP endpoint, perform model calls, or manufacture turn IDs.
const {createHash}=require('node:crypto');
const MAX_RESOURCE_BYTES=4*1024*1024;
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const digest=id=>createHash('sha256').update(id).digest('hex');
const clone=v=>v===undefined?undefined:structuredClone(v);
function validId(id){if(typeof id!=='string'||!id||id.length>4000)throw Error('Invalid Mac MCP server identity');}
function validUri(uri){if(typeof uri!=='string'||!uri||uri.length>4000||/[\u0000-\u001f]/.test(uri))throw Error('Invalid Mac MCP resource URI');}
function bridgeToolName(id,name){
 validId(id);if(typeof name!=='string'||!name)throw Error('Invalid Mac MCP tool name');
 return 'mac_ext_'+digest(id).slice(0,12)+'_'+name.replace(/[^a-zA-Z0-9_]/g,'_').slice(0,65)+'_'+digest(name).slice(0,8);
}
function namespaceUri(id,uri){
 validId(id);validUri(uri);
 return (uri.startsWith('ui://')?'ui://opencodex-mcp/':'opencodex-mcp://resource/')+digest(id)+'/'+encodeURIComponent(uri);
}
function isProjectedUri(uri){return typeof uri==='string'&&(uri.startsWith('ui://opencodex-mcp/')||uri.startsWith('opencodex-mcp://resource/'));}
function projectMetadata(id,metadata){
 if(!object(metadata))return metadata;
 const next=clone(metadata);
 for(const key of ['ui/resourceUri','openai/outputTemplate'])if(typeof next[key]==='string'&&next[key])next[key]=namespaceUri(id,next[key]);
 if(object(next.ui)&&typeof next.ui.resourceUri==='string'&&next.ui.resourceUri)next.ui.resourceUri=namespaceUri(id,next.ui.resourceUri);
 return next;
}
function projectTool(id,tool){
 if(!object(tool))throw Error('Invalid Mac MCP tool');
 return {...clone(tool),...(tool._meta!==undefined?{_meta:projectMetadata(id,tool._meta)}:{})};
}
function projectResult(id,value){
 if(!object(value))return value;
 const next=clone(value);
 if(next._meta!==undefined)next._meta=projectMetadata(id,next._meta);
 if(Array.isArray(next.contents))next.contents=next.contents.map(item=>object(item)&&typeof item.uri==='string'?{...item,uri:namespaceUri(id,item.uri)}:item);
 if(Array.isArray(next.content))next.content=next.content.map(item=>{
  if(!object(item))return item;
  if(item.type==='resource_link'&&typeof item.uri==='string')return {...item,uri:namespaceUri(id,item.uri)};
  if(item.type==='resource'&&object(item.resource)&&typeof item.resource.uri==='string')return {...item,resource:{...item.resource,uri:namespaceUri(id,item.resource.uri)}};
  return item;
 });
 return next;
}
class NativeMcpBridge{
 constructor({getClients,getEntries,getGeneration=()=>0,active=new Set(),authorizeResource,authorizeTool,requestTimeoutMs=120000}){
  if(typeof getClients!=='function'||typeof authorizeResource!=='function')throw Error('Native MCP resource authorization is required');
  Object.assign(this,{getClients,getEntries,getGeneration,active,authorizeResource,authorizeTool,requestTimeoutMs});
 }
 resolve(uri){
  if(typeof uri!=='string'||uri.length>20000)throw Error('Invalid Mac MCP resource URI');
  const match=/^(?:ui:\/\/opencodex-mcp\/|opencodex-mcp:\/\/resource\/)([a-f0-9]{64})\/(.+)$/.exec(uri);
  if(!match)throw Error('Unknown Mac MCP resource namespace');
  let original;
  try{original=decodeURIComponent(match[2]);}catch{throw Error('Invalid Mac MCP resource URI');}
  validUri(original);
  for(const [id,client]of this.getClients()){
   if(digest(id)!==match[1])continue;
   if(namespaceUri(id,original)!==uri)throw Error('Invalid Mac MCP resource URI');
   if(!client?.running||typeof client.resource!=='function')throw Error('Mac MCP unavailable or cancelled');
   return {id,client,uri:original};
  }
  throw Error('Unknown Mac MCP resource server');
 }
 // App actions have their own caller and permission checks. They never borrow a
 // completed model run and never infer the extension from an ambiguous tool name.
 async call(params,{context,signal}={}){
  if(typeof this.getEntries!=='function'||typeof this.authorizeTool!=='function')throw Error('Native MCP app tool authorization is required');
  if(signal?.aborted)throw Error('Mac MCP app tool request cancelled');
  const resourceUri=params?._meta?.['opencodex/resourceUri'];
  const resolved=this.resolve(resourceUri),generation=this.getGeneration(),entries=this.getEntries();
  if(resolved.id.startsWith('opencodex-native:')||resolved.client.spec?.transport==='native')throw Error('Native tool app actions require an explicit native approval context');
  if(typeof params.tool!=='string'||!params.tool||params.tool.length>1000)throw Error('Invalid Mac MCP app tool name');
  const name=entries.has(params.tool)?params.tool:bridgeToolName(resolved.id,params.tool),entry=entries.get(name);
  if(!entry||entry.extensionId!==resolved.id||entry.category!=='extension'||entry.available?.()!==true||typeof entry.invoke!=='function')throw Error('Mac MCP app tool is unavailable or belongs to another server');
  const args=clone(params.arguments??{});
  if(!object(args))throw Error('Invalid Mac MCP app tool arguments');
  if(this.active.size>=16)throw Error('Too many concurrent Mac MCP requests');
  const controller=new AbortController();this.active.add(controller);
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  let rejectCancelled;
  const cancelled=new Promise((_,reject)=>{rejectCancelled=()=>reject(Error('Mac MCP app tool request cancelled or timed out'));});
  controller.signal.addEventListener('abort',rejectCancelled,{once:true});
  const timeout=setTimeout(abort,this.requestTimeoutMs);timeout.unref?.();
  const assertCurrent=()=>{
   if(controller.signal.aborted||generation!==this.getGeneration()||this.getClients().get(resolved.id)!==resolved.client||!resolved.client.running||this.getEntries().get(name)!==entry||entry.available?.()!==true)throw Error('Mac MCP app tool owner changed or request cancelled');
  };
  const checkOwner=async()=>{
   assertCurrent();
   if(await this.authorizeResource({serverId:resolved.id,uri:resolved.uri,context,signal:controller.signal})!==true)throw Error('Mac MCP app tool owner permission denied');
   assertCurrent();
  };
  const work=async()=>{
   await checkOwner();
   const call={name,arguments:clone(args),category:entry.category,tool:entry.tool,serverId:resolved.id,resourceUri,context,signal:controller.signal};
   if(await this.authorizeTool(call)!==true)throw Error('Mac MCP app tool permission denied');
   await checkOwner();
   // The production entry invokes the authenticated owning client and already
   // projects the result using that client's namespace.
   const result=await entry.invoke(args,controller.signal);
   await checkOwner();
   if(!object(result)||!Array.isArray(result.content))throw Error('Invalid Mac MCP app tool response');
   return result;
  };
  try{return await Promise.race([work(),cancelled]);}
  finally{
   clearTimeout(timeout);signal?.removeEventListener('abort',abort);
   controller.signal.removeEventListener('abort',rejectCancelled);this.active.delete(controller);
  }
 }
 async read(uri,{context,signal}={}){
  if(signal?.aborted)throw Error('Mac MCP resource request cancelled');
  const resolved=this.resolve(uri),generation=this.getGeneration();
  if(this.active.size>=16)throw Error('Too many concurrent Mac MCP resource requests');
  const controller=new AbortController();this.active.add(controller);
  const abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  let rejectCancelled;
  const cancelled=new Promise((_,reject)=>{rejectCancelled=()=>reject(Error('Mac MCP resource request cancelled or timed out'));});
  controller.signal.addEventListener('abort',rejectCancelled,{once:true});
  const timeout=setTimeout(abort,this.requestTimeoutMs);timeout.unref?.();
  const assertCurrent=()=>{
   if(controller.signal.aborted||generation!==this.getGeneration()||this.getClients().get(resolved.id)!==resolved.client||!resolved.client.running)throw Error('Mac MCP resource owner changed or request cancelled');
  };
  const work=async()=>{
   if(!await this.authorizeResource({serverId:resolved.id,uri:resolved.uri,context,signal:controller.signal}))throw Error('Mac MCP resource permission denied');
   assertCurrent();
   const result=await resolved.client.resource('resources/read',{uri:resolved.uri},controller.signal);
   assertCurrent();
   if(!await this.authorizeResource({serverId:resolved.id,uri:resolved.uri,context,signal:controller.signal}))throw Error('Mac MCP resource permission denied');
   assertCurrent();
   if(!object(result)||!Array.isArray(result.contents))throw Error('Invalid Mac MCP resource response');
   if(Buffer.byteLength(JSON.stringify(result))>MAX_RESOURCE_BYTES)throw Error('Mac MCP resource exceeds 4 MiB');
   const projected=projectResult(resolved.id,result);
   if(Buffer.byteLength(JSON.stringify(projected))>MAX_RESOURCE_BYTES)throw Error('Mac MCP resource exceeds 4 MiB');
   return projected;
  };
  try{return await Promise.race([work(),cancelled]);}
  finally{
   clearTimeout(timeout);signal?.removeEventListener('abort',abort);
   controller.signal.removeEventListener('abort',rejectCancelled);this.active.delete(controller);
  }
 }
}
module.exports={NativeMcpBridge,namespaceUri,isProjectedUri,projectTool,projectResult,bridgeToolName};
