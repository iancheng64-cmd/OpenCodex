'use strict';
// OpenCodex runs its own fork of these runtime modules. Rename everything a model, a user,
// a peer or an MCP server can see, so nothing presents this app as another application.
// Internal wire markers (agentbridge_ready, AGENTBRIDGE_WINDOWS) and the Resources/agentbridge
// folder stay: nobody sees them, and the MIT notice keeps the fork's origin on record.
const MAC_ENVIRONMENT_ID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const RULES={
 'agent-core-tools.js':[['AgentBridge has self-contained','OpenCodex has self-contained']],
 'agent-relay.js':[['agentbridge_peer_','opencodex_peer_']],
 'app-server-rpc.js':[['AgentBridge requires no Runtime environments.toml override','OpenCodex requires no Runtime environments.toml override']],
 'browser-runtime.js':[['請重新下載完整的 AgentBridge 安裝檔','請重新安裝完整的 OpenCodex']],
 'claude-auth-mode.js':[['agentbridge-native-context','opencodex-native-context']],
 'claude-local-backend.js':[['agentbridge_mac','opencodex_mac']],
 'claude-local-runtime.js':[
  ['agentbridge_mac','opencodex_mac'],
  ['AGENTBRIDGE_MAC_MCP_TOKEN','OPENCODEX_MAC_MCP_TOKEN'],
  ['You are running inside AgentBridge Studio on the user\'s Mac.','You are running inside OpenCodex on the user\'s Mac.'],
  ['intentionally disabled for this split route." :','intentionally disabled for this split route. OpenCodex is a standalone app with its own connection and Mac tool host: never tell the user to open or reconnect another app; if Mac tools are missing, point to the OpenCodex SSH panel. This Mac\'s skills from every installed agent, durable memory and earlier conversations are available through mac_skill_search, mac_skill_view, mac_memory_read, mac_memory_write and mac_session_search; use them without being asked." :']
 ],
 'claude-remote-bootstrap.js':[['AGENTBRIDGE_MAC_MCP_TOKEN','OPENCODEX_MAC_MCP_TOKEN'],['agentbridge-native-context','opencodex-native-context']],
 'claude-usage-reader.js':[['AgentBridge-Usage/','OpenCodex-Usage/']],
 'http-tool-health.js':[['AgentBridge HTTP health','OpenCodex HTTP health']],
 'local-code-mode-host.js':[['請更新 AgentBridge App','請更新 OpenCodex']],
 'local-exec-server.js':[
  ['currentEnvironmentId = `agentbridge-mac-${','currentEnvironmentId = `opencodex-mac-${'],
  // Threads store the environment they were created with and re-register it on resume.
  ['/^agentbridge-mac-'+MAC_ENVIRONMENT_ID+'$/i','/^(?:opencodex|agentbridge)-mac-'+MAC_ENVIRONMENT_ID+'$/i']
 ],
 'local-tool-host.js':[['agentbridge_peer_','opencodex_peer_'],['serverInfo: { name: "AgentBridge-Mac"','serverInfo: { name: "OpenCodex-Mac"']],
 'local-tool-stdio.js':[['clientInfo: { name: "AgentBridge",','clientInfo: { name: "OpenCodex",']],
 'mac-extension-servers.js':[['AgentBridge Mac extension adapter','OpenCodex Mac extension adapter']],
 'mac-mcp-auth.js':[['AgentBridge Studio on this Mac','OpenCodex on this Mac'],['請回到 AgentBridge Studio','請回到 OpenCodex'],['Return to AgentBridge Studio','Return to OpenCodex']],
 'runtime-backend.js':[
  ['`agentbridge_mac_${','`opencodex_mac_${'],
  ['clientInfo: { name: "agentbridge_studio", title: "AgentBridge Studio",','clientInfo: { name: "opencodex_desktop", title: "OpenCodex",'],
  ['discussion inside AgentBridge Studio.','discussion inside OpenCodex.'],
  ['AgentBridge requires no Runtime environments.toml override','OpenCodex requires no Runtime environments.toml override']
 ],
 'runtime-extensions.js':[['You are the Codex assistant in AgentBridge Studio.','You are the Codex assistant in OpenCodex.'],['AgentBridge Mac extension inventory','OpenCodex Mac extension inventory']]
};
// A rule must apply or have applied: an upstream rewrite must not silently restore the old name.
function rebrand(file,code){
 const rules=RULES[file];if(!rules)return code;
 for(const [before,after]of rules){
  if(code.includes(before)){code=code.replaceAll(before,after);continue;}
  if(!code.includes(after))throw Error('Unrecognized identity boundary in '+file+': '+before);
 }
 return code;
}
module.exports={RULES,rebrand};
