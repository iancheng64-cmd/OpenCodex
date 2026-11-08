'use strict';
// OpenCodex must run without, and never point to, another application.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {RULES,rebrand}=require('./identity-patches.cjs');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'vendor/agentbridge/dist-main'),tests=[];
const test=(name,fn)=>{fn();tests.push(name);};
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const list=dir=>fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?list(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
const patched=Object.fromEntries(Object.keys(RULES).map(name=>[name,rebrand(name,fs.readFileSync(path.join(dist,name),'utf8'))]));
test('renames apply and repeat without change',()=>{
 for(const [name,code]of Object.entries(patched))assert.equal(rebrand(name,code),code,name);
 assert.throws(()=>rebrand('runtime-backend.js','upstream rewrote this file'),/Unrecognized identity boundary/);
});
test('no product name remains in what a model, user, peer or server sees',()=>{
 for(const [name,code]of Object.entries(patched))assert.doesNotMatch(code,/AgentBridge|agentbridge_mac|agentbridge_studio|agentbridge_peer|AGENTBRIDGE_MAC/,name);
});
test('every module OpenCodex loads is covered',()=>{
 const uncovered=fs.readdirSync(dist).filter(name=>name.endsWith('.js')&&!RULES[name]&&/AgentBridge|agentbridge_mac|agentbridge_peer/.test(fs.readFileSync(path.join(dist,name),'utf8')));
 // main.js belongs to the original application and is never loaded.
 assert.deepEqual(uncovered,['main.js']);
 for(const file of list('src').concat(list('cli')))assert.doesNotMatch(read(file),/require\([^)]*(?:dist-main\/main|dist-main\/preload)/,file);
});
test('new environments use the new name and threads keep their stored one',()=>{
 const code=patched['local-exec-server.js'],check=new RegExp(/\/\^\(\?:opencodex\|agentbridge\)-mac-[^/]+\/i/.exec(code)[0].slice(1,-2),'i'),id='12345678-1234-1234-1234-123456789abc';
 assert.match(code,/currentEnvironmentId = `opencodex-mac-\$\{/);
 assert(check.test('opencodex-mac-'+id));assert(check.test('agentbridge-mac-'+id));assert(!check.test('other-mac-'+id));
});
test('the app never reaches into another application or its data',()=>{
 for(const file of [...list('src'),...list('cli')]){
  if(/\.(cjs|js|c|html)$/.test(file))assert.doesNotMatch(read(file),/AgentBridge Studio\.app|agentbridge-studio|com\.agentbridge\.studio/,file);
 }
 for(const [name,code]of Object.entries(patched))assert.doesNotMatch(code,/AgentBridge Studio\.app|agentbridge-studio|com\.agentbridge\.studio/,name);
});
test('the app and CLI use the same tool server name for every provider',()=>{
 assert.match(read('src/external-providers.cjs'),/name:'opencodex_mac'/);assert.doesNotMatch(read('src/external-providers.cjs'),/agentbridge/i);
 for(const file of ['cli/lib/providers/claude.cjs','cli/lib/providers/codex.cjs'])assert.doesNotMatch(read(file),/agentbridge_mac/,file);
 assert.match(patched['claude-local-backend.js'],/mcp__opencodex_mac__/);assert.match(patched['runtime-backend.js'],/`opencodex_mac_\$\{/);
});
test('the user interface does not mention it either',()=>{
 for(const file of ['src/connections.html','src/controls.html','src/controls.js','src/native-preload.cjs'])assert.doesNotMatch(read(file),/AgentBridge/,file);
});
test('the only instruction naming it is the one forbidding it',()=>{
 const code=read('src/agent-environment.cjs'),mentions=code.match(/AgentBridge/g)||[];
 assert.equal(mentions.length,1);assert.match(code,/Never tell the user to open, install or reconnect another app such as AgentBridge Studio/);
});
console.log(JSON.stringify({passed:tests.length,tests},null,2));
