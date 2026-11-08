'use strict';
// Mac tool host (files, shell, process, browser, computer) exposed to the remote CLI
// through an SSH loopback forward. Every executable tool stays on this Mac.
const fs=require('node:fs'),path=require('node:path');
const cfg=require('./config.cjs');
const {LocalToolHost}=cfg.mod('local-tool-host.js');
const {LoopbackForward}=cfg.mod('loopback-forward.js');
const agentWorkspace=require(path.join(cfg.repoRoot,'src/agent-environment.cjs'));
const environment=new agentWorkspace.AgentEnvironment({appRoot:cfg.appSupport,codexHome:path.join(cfg.appSupport,'codex-official')});
agentWorkspace.installCoreTools(cfg.mod('agent-core-tools.js').AgentCoreTools,environment);
function localTools(resources,options){
 const tools={};
 const computer=path.join(resources,'agentbridge/computer-use/claudex-computer-use');
 if(options.computer!==false&&fs.existsSync(computer))tools.nativeCommand={command:computer,args:[],computerProvider:'bundled'};
 const node=path.join(resources,'cua_node/bin/node'),playwright=path.join(cfg.abRoot,'node_modules/@playwright/mcp/cli.js'),browserRoot=path.join(resources,'agentbridge/browser');
 if(options.browser!==false&&fs.existsSync(node)&&fs.existsSync(playwright)&&fs.existsSync(browserRoot)){
  try{const {browserRuntimeArgs}=cfg.mod('browser-runtime.js');tools.browserCommand={command:node,args:[playwright,...browserRuntimeArgs(browserRoot),'--caps','vision,pdf,devtools','--snapshot-boxes','--user-data-dir',path.join(cfg.cliRoot,'browser-profile'),'--output-dir',path.join(cfg.cliRoot,'browser-output')],env:{}};}
  catch{}
 }
 return tools;
}
// authorize(call) decides per tool call. call.category: 'agent-bridge' | 'filesystem-read' | 'filesystem-write' | 'shell' | ...
async function startToolHost({conn,cwd,agentRole,permissionMode,resources,options={},authorize}){
 const host=new LocalToolHost({stateDirectory:path.join(cfg.cliRoot,'agent-task-checkpoints'),allowedRoots:[cwd],extensionServers:[],readOnlyRoots:[],enableShell:true,agentRole,...localTools(resources,options),fullFilesystemAccess:permissionMode==='full',authorize});
 const endpoint=await host.start();
 const forward=new LoopbackForward(conn,endpoint.port);
 let port;
 try{port=await forward.start();}catch(e){await host.stop();throw e;}
 return {host,forward,environment,endpoint:{...endpoint,remoteUrl:'http://127.0.0.1:'+port+'/mcp'},async stop(){forward.stop();await host.stop();}};
}
module.exports={startToolHost};
