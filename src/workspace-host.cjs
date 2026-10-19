// Appended to the bundled LocalToolHost module. Keep its authenticated endpoint,
// native approval handler and cancellation lifecycle while changing project roots.
const opencodexNativeMcp = () => require(node_path_1.default.join(process.resourcesPath, 'app.asar', 'opencodex', 'native-mcp.cjs'));
const opencodexProjectedMcpEntries = new WeakSet();
const opencodexRegisterExtension = LocalToolHost.prototype.registerExtension;
LocalToolHost.prototype.registerExtension = async function(spec) {
 await opencodexRegisterExtension.call(this, spec);
 const bridge = opencodexNativeMcp();
 for (const entry of this.entries.values()) {
  if (entry.extensionId !== spec.id || opencodexProjectedMcpEntries.has(entry)) continue;
  entry.tool = bridge.projectTool(spec.id, entry.tool);
  const invoke = entry.invoke;
  entry.invoke = async (...args) => bridge.projectResult(spec.id, await invoke.apply(entry, args));
  opencodexProjectedMcpEntries.add(entry);
 }
};
// Called only by the existing native websocket router after its thread/profile
// ownership check. Recheck that caller before and after the asynchronous read.
LocalToolHost.prototype.openCodexMcpResourceRead = async function(uri, context = {}) {
 if (typeof context.isAuthorized !== 'function') throw Error('Native MCP resource authorization is required');
 const { NativeMcpBridge } = opencodexNativeMcp();
 const bridge = new NativeMcpBridge({
  getClients: () => this.extensionClients,
  getGeneration: () => this.generation,
  active: this.active,
  authorizeResource: () => context.isAuthorized() === true,
  requestTimeoutMs: this.options.requestTimeoutMs || 120000
 });
 return bridge.read(uri, { context, signal: context.signal });
};
// Native frontend widget actions use an explicit app-operation approval callback.
// The callback receives the real catalog entry; absence is a denied operation.
LocalToolHost.prototype.openCodexMcpToolCall = async function(params, context = {}) {
 if (typeof context.isAuthorized !== 'function' || typeof context.authorizeTool !== 'function') throw Error('Native MCP app tool authorization is required');
 const { NativeMcpBridge } = opencodexNativeMcp();
 const bridge = new NativeMcpBridge({
  getClients: () => this.extensionClients,
  getEntries: () => this.entries,
  getGeneration: () => this.generation,
  active: this.active,
  authorizeResource: () => context.isAuthorized() === true,
  authorizeTool: call => context.authorizeTool(call),
  requestTimeoutMs: this.options.requestTimeoutMs || 120000
 });
 return bridge.call(params, { context, signal: context.signal });
};
LocalToolHost.prototype.setWorkspace = async function(cwd, specs) {
 if(this.active.size||[...(this.core?.jobs?.values()||[])].some(job=>job.state==='running'))throw Error('Mac 工具仍在執行，無法切換專案。');
 const root=await promises_1.default.realpath(cwd);
 if(!(await promises_1.default.stat(root)).isDirectory())throw Error('Mac 專案目錄不存在。');
 if(this.active.size)throw Error('Mac 工具仍在執行，無法切換專案。');
 for(const client of this.extensionClients.values())await client.stop();
 this.extensionClients.clear();
 for(const [name,entry]of this.entries)if(entry.extensionId)this.entries.delete(name);
 this.extensionStatuses=[];
 this.roots=[root];this.options.allowedRoots=[root];this.options.extensionServers=specs;
 if(this.core)this.core.config.cwd=root;
 for(let offset=0;offset<specs.length;offset+=4)await Promise.all(specs.slice(offset,offset+4).map(spec=>this.registerExtension(spec)));
};
