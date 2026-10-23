'use strict';
// Owned, local-only MCP Apps fixture. No network, shell execution, or user data access.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const fixtureDir=path.resolve(__dirname,'../evidence/mcp-app-gui-fixture-0.4.10');
const config=path.join(os.homedir(),'.codex/config.toml'),tag='opencodex_mcp_gui_qa';
const suffix='\n# OpenCodex owned MCP Apps GUI acceptance fixture\n[mcp_servers.'+tag+']\ncommand = "/usr/bin/env"\nargs = ["node", '+JSON.stringify(__filename)+', "serve"]\nenabled = true\nstartup_timeout_sec = 10\ntool_timeout_sec = 20\n';
if(process.argv[2]==='install'){
 fs.mkdirSync(fixtureDir,{recursive:true,mode:0o700});const before=fs.readFileSync(config,'utf8');
 assert(!before.includes('[mcp_servers.'+tag+']'),'fixture already registered');
 fs.writeFileSync(path.join(fixtureDir,'config-before.toml'),before,{mode:0o600,flag:'wx'});
 fs.appendFileSync(config,suffix);console.log(JSON.stringify({registered:tag,fixtureDir}));
}else if(process.argv[2]==='remove'){
 const before=fs.readFileSync(config,'utf8');assert.equal(before.split(suffix).length,2,'exact owned fixture config must occur once');
 fs.writeFileSync(config,before.replace(suffix,''),{mode:0o600});
 const restored=fs.readFileSync(config,'utf8')===fs.readFileSync(path.join(fixtureDir,'config-before.toml'),'utf8');
 console.log(JSON.stringify({removed:tag,originalConfigRestored:restored}));
}else if(process.argv[2]==='serve'){
 let count=0;const uri='ui://opencodex-qa/counter.html',marker='OPENCODEX-MCP-APP-GUI';
 const html="<!doctype html><html><head><meta charset=\"utf-8\"><title>OpenCodex MCP App 驗收</title><style>body{font:16px system-ui;padding:16px;background:#202327;color:white}button{font:inherit;padding:10px;border-radius:8px}pre{white-space:pre-wrap}</style></head><body><h2>OPENCODEX-MCP-APP-GUI</h2><p id=\"state\">等待原生連線</p><p id=\"counter\">計數：0</p><button id=\"increment\" disabled>增加測試計數</button><pre id=\"result\"></pre><script>let next=1;const pending=new Map();function request(method,params){return new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(Error('request timeout '+method));}},60000);});}\nfunction notify(method,params){window.parent.postMessage({jsonrpc:'2.0',method,params},'*');}\nfunction render(r){document.querySelector('#result').textContent=JSON.stringify(r);if(r?.structuredContent)document.querySelector('#counter').textContent='計數：'+r.structuredContent.count;}\nwindow.addEventListener('message',e=>{if(e.source!==window.parent)return;const m=e.data;if(!m||m.jsonrpc!=='2.0')return;const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}if(m.method==='ui/notifications/tool-result')render(m.params);});\ndocument.querySelector('#increment').onclick=async()=>{try{render(await request('tools/call',{name:'increment',arguments:{}}));document.querySelector('#state').textContent='操作成功';}catch(e){document.querySelector('#state').textContent=e.message;}};\nrequest('ui/initialize',{appInfo:{name:'OpenCodex owned QA',version:'1'},appCapabilities:{},protocolVersion:'2026-01-26'}).then(r=>{notify('ui/notifications/initialized',{});notify('ui/notifications/size-changed',{height:280});document.querySelector('#state').textContent='原生連線完成';document.querySelector('#increment').disabled=false;}).catch(e=>document.querySelector('#state').textContent=e.message);</script></body></html>";
 const log=(method,extra={})=>fs.appendFileSync(path.join(fixtureDir,'operations.jsonl'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,method,...extra})+'\n',{mode:0o600});
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.id===undefined)return;let result;log(m.method,m.method==='tools/call'?{tool:m.params.name}:{}); 
  if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{},resources:{}},serverInfo:{name:tag,version:'1'}};
  else if(m.method==='ping')result={};
  else if(m.method==='tools/list')result={tools:[
   {name:'show_counter',description:'OpenCodex owned MCP Apps GUI acceptance: show a local counter widget. No user data, no network, no file modifications.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:uri,visibility:['model','app']},'openai/outputTemplate':uri}},
   {name:'increment',description:'Increment only this temporary in-memory QA counter.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:uri,visibility:['app']}}}
  ]};
  else if(m.method==='tools/call'&&['show_counter','increment'].includes(m.params.name)){if(m.params.name==='increment')count++;result={content:[{type:'text',text:marker+' count='+count}],structuredContent:{marker,count},_meta:{ui:{resourceUri:uri}}};log('result',{tool:m.params.name,count});}
  else if(m.method==='resources/read'&&m.params.uri===uri)result={contents:[{uri,mimeType:'text/html;profile=mcp-app',text:html,_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}}}}]};
  else if(m.method==='resources/list')result={resources:[{uri,name:'OpenCodex owned GUI counter',mimeType:'text/html;profile=mcp-app'}]};
  else if(m.method==='resources/templates/list')result={resourceTemplates:[]};
  else return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported fixture method'}})+'\n');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
 });
}else throw Error('Use install, serve, or remove');
