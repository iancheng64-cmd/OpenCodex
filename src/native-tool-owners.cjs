'use strict';
// Each SSH tool host owns its native app-server. Never reassign a shared owner
// when another agent or background lease connects to the same directory.
class NativeToolOwners{
 constructor(create){this.create=create;this.owners=new Set();this.byHost=new WeakMap();this.revision=0;}
 async specs(cwd,runtime){
  for(const owner of this.owners)if(owner.closed)this.owners.delete(owner);
  const owner=this.create(cwd,runtime);owner.revision=this.revision;this.owners.add(owner);
  try{const specs=await owner.specs();Object.defineProperty(specs,'openCodexNativeOwner',{value:owner});return specs;}
  catch(e){owner.close();throw e;}
 }
 tag(specs,source){Object.defineProperty(specs,'openCodexNativeOwner',{value:source.openCodexNativeOwner});return specs;}
 owner(runtime){
  const host=runtime.toolHost||runtime.host;if(!host)return;
  const owner=this.byHost.get(host)||host.options?.extensionServers?.openCodexNativeOwner;
  if(owner){this.byHost.set(host,owner);owner.runtime=runtime;this.guard(runtime);}return owner;
 }
 guard(runtime){
  const host=runtime.toolHost||runtime.host;
  if(!host)return;
  host.openCodexPermissionDispatch=new (require('./native-permissions-dispatch.cjs').NativePermissionDispatch)(runtime,()=>this.byHost.get(host));
 }
 bind(runtime,specs){const owner=specs.openCodexNativeOwner;owner.runtime=runtime;this.byHost.set(runtime.toolHost||runtime.host,owner);this.guard(runtime);return owner;}
 async refresh(runtime){
  const previous=this.owner(runtime),cwd=runtime.localCwd||runtime.cwd;
  if(previous&&!previous.closed&&previous.cwd===cwd&&previous.revision===this.revision&&previous.permissionProfile===runtime.openCodexPermissions?.profile){
   // Cancellation resets the process and its permission snapshot without
   // discarding the owner. Recover it before admitting the next selection.
   await previous.ready();return;
  }
  const specs=await this.specs(cwd,runtime);
  try{await (runtime.toolHost||runtime.host).replaceNativeExtensions(specs);this.bind(runtime,specs);previous?.close();}
  catch(e){specs.openCodexNativeOwner.close();throw e;}
 }
 inventory(cwd){return [...this.owners].find(o=>!o.closed&&o.cwd===cwd);}
 closeRuntime(runtime){
  const host=runtime.toolHost||runtime.host;
  const owner=this.byHost.get(host)||host?.options?.extensionServers?.openCodexNativeOwner;
  this.byHost.delete(host);owner?.close();if(owner)this.owners.delete(owner);
  this.guard(runtime);
 }
 invalidate(){this.revision++;}
 close(){for(const owner of this.owners)owner.close();this.owners.clear();this.byHost=new WeakMap();}
}
module.exports={NativeToolOwners};
