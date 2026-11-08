'use strict';
// The remote MCP startup budget is 45 s; inventory must not time out at 30 s.
function inventoryDeadline(code){
 const before='await runtime.rpc.request("mcpServerStatus/list", { threadId, limit: 100, ...(cursor ? { cursor } : {}) })';
 const previous='await runtime.rpc.request("mcpServerStatus/list", { threadId, limit: 100, ...(cursor ? { cursor } : {}) }, 60000).catch(error => { throw new Error("SSH Runtime 工具清單：" + error.message, { cause: error }); })';
 // Isolation checks every server's runtimeStatus and tools. Resource enumeration
 // adds remote round trips without strengthening the disabled-server requirement.
 const after=previous.replace('threadId, limit:', 'threadId, detail: "toolsAndAuthOnly", limit:');
 if(code.includes(after)&&!code.includes(before)&&!code.includes(previous))return code;
 const source=code.includes(previous)?previous:before;
 if(!code.includes(source)||code.indexOf(source)!==code.lastIndexOf(source))throw Error('Unrecognized Runtime inventory boundary');
 return code.replace(source,after);
}
function sharedHostTrust(code){
 const before='function trustedHostsPath() { return node_path_1.default.join(electron_1.app.getPath("userData"), "runtime-known-hosts.json"); }';
 const after='function trustedHostsPath() { return node_path_1.default.join(electron_1.app.getPath("appData"), "OpenCodex", "runtime-known-hosts.json"); }';
 if(code.includes(after)&&!code.includes(before))return code;
 if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))throw Error('Unrecognized SSH host trust boundary');
 return code.replace(before,after);
}
function discussionDeadline(code){
 const before='this.options.requestTimeoutMs || 120_000';
 const after='entry.extensionId === "opencodex-native:agents" ? 1_800_000 : (this.options.requestTimeoutMs || 120_000)';
 if(code.includes(after))return code;
 if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))throw Error('Unrecognized local tool deadline');
 return code.replace(before,after);
}
function discussionTransportDeadline(code){
 if(code.includes('tool_timeout_sec: 1860'))return code;
 const before='tool_timeout_sec: 180';
 if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))throw Error('Unrecognized MCP transport deadline');
 return code.replace(before,'tool_timeout_sec: 1860');
}
// A window guessed for every model compacted a 258k model at 35%, leaving room for only a few steps.
function autoCompactWindow(code){
 if(code.includes('contextWindow > 0 &&'))return code;
 const before='    if (typeof autoCompactPercent === "number" && Number.isFinite(autoCompactPercent)) {\n        const pct = Math.max(10, Math.min(95, Math.round(autoCompactPercent)));\n        const contextWindow = Number(config?.model_context_window) || 128000;\n';
 const after='    // Only a configured window is known here; otherwise the engine applies its per-model threshold.\n    const contextWindow = Number(config?.model_context_window);\n    if (contextWindow > 0 && typeof autoCompactPercent === "number" && Number.isFinite(autoCompactPercent)) {\n        const pct = Math.max(10, Math.min(95, Math.round(autoCompactPercent)));\n';
 if(!code.includes(before))throw Error('Unrecognized auto-compact policy');
 return code.replace(before,after);
}
// Retain the failing stage without exposing arbitrary command output or secrets.
function initializationDiagnostics(code){
 const report=stage=>`require('../../../app.asar/opencodex/native-connection.cjs').initializationFailure("${stage}", error)`;
 const replacements=[
  ['host = undefined;\n                    hostWarning = error instanceof Error ? error.message : String(error);','host = undefined;\n                    hostWarning = '+report('executor-start')+';'],
  ['executor = undefined;\n                    hostWarning = error instanceof Error ? error.message : String(error);','executor = undefined;\n                    hostWarning = '+report('executor-register')+';'],
  ['hostWarning = "Mac 擴充工具尚未連線；仍可使用命令與檔案工具。";','hostWarning = '+report('tool-host')+';']
 ];
 for(const [before,after]of replacements){
  if(code.includes(after)&&!code.includes(before))continue;
  if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))throw Error('Unrecognized Runtime initialization boundary');
  code=code.replace(before,after);
 }
 return code;
}
module.exports={inventoryDeadline,sharedHostTrust,discussionDeadline,discussionTransportDeadline,autoCompactWindow,initializationDiagnostics};
