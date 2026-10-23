'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict');
const {extensionScan}=require('./extension-scan-patches.cjs');
const original=fs.readFileSync(path.join(__dirname,'../vendor/agentbridge/dist-main/extensions.js'),'utf8'),patched=extensionScan(original);
const home=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-extension-scan-')),tests=[];
const put=(name,text)=>{const file=path.join(home,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
function fixture(code){
 const calls=[],promises={...fs.promises};
 for(const method of ['readdir','readFile'])promises[method]=async(...args)=>{calls.push({method,path:args[0]});return fs.promises[method](...args);};
 const exports={};vm.runInNewContext(code,{exports,process:{env:{}},require:name=>name==='node:fs'?{...fs,promises}:name==='node:os'?{...os,homedir:()=>home}:require(name)});
 return {scan:exports.localExtensions,calls};
}
const plain=value=>JSON.parse(JSON.stringify(value));
async function test(name,fn){await fn();tests.push(name);}
(async()=>{
 put('.codex/skills/shared/SKILL.md','description: Codex version\n');
 put('.agents/skills/shared/SKILL.md','description: Agents version\n');
 put('.codex/plugins/cache/demo/.codex-plugin/plugin.json','{"name":"demo"}');
 put('.codex/plugins/cache/demo/skills/extra/SKILL.md','description: plugin skill\n');
 put('.codex/config.toml','[mcp_servers.bridge]\n');
 put('.claude/skills/claude-only/SKILL.md','description: Claude skill\n');
 put('.claude/plugins/cache/demo/.claude-plugin/plugin.json','{"name":"Claude plugin"}');
 put('.claude.json','{"mcpServers":{"Claude server":{}},"enabledPlugins":{"Claude plugin":true}}');
 put('project/.agents/skills/shared/SKILL.md','description: Project version\n');
 put('.codex/skills/vendor/hidden/SKILL.md','description: never scanned\n');
 await test('Codex scope preserves metadata, statuses and project precedence without Claude disk access',async()=>{
  const a=fixture(original),b=fixture(patched),options={cwd:path.join(home,'project'),agent:'codex'};
  assert.deepEqual(plain(await b.scan(options)),plain(await a.scan(options)));
  assert(!b.calls.some(x=>x.path.includes('/.claude')));
 });
 await test('duplicate home roots preserve existing precedence but each file and directory is read once',async()=>{
  const a=fixture(original),b=fixture(patched),options={cwd:home,agent:'codex'};
  assert.deepEqual(plain(await b.scan(options)),plain(await a.scan(options)));
  const counts=new Map();for(const x of b.calls){const key=x.method+':'+x.path;counts.set(key,(counts.get(key)||0)+1);}
  assert([...counts.values()].every(n=>n===1));assert(b.calls.length<a.calls.length);
 });
 await test('unfiltered discovery and Claude scope retain both original catalogues',async()=>{
  for(const agent of [undefined,'claude']){
   const a=fixture(original),b=fixture(patched),options={cwd:home,agent};
   assert.deepEqual(plain(await b.scan(options)),plain(await a.scan(options)));
  }
 });
 await test('next scan observes edits, additions and removals without stale cache',async()=>{
  const b=fixture(patched),options={cwd:home,agent:'codex'};
  await b.scan(options);put('.codex/skills/new/SKILL.md','description: added\n');
  fs.unlinkSync(path.join(home,'.codex/plugins/cache/demo/skills/extra/SKILL.md'));
  put('.codex/skills/shared/SKILL.md','description: edited\n');
  const result=plain(await b.scan(options));assert.deepEqual(result,plain(await fixture(original).scan(options)));
  assert(result.items.some(x=>x.name==='new'));assert(!result.items.some(x=>x.name==='extra'));
  assert.equal(result.items.find(x=>x.name==='shared').description,'edited');
 });
 await test('patch is repeatable and rejects incompatible source',async()=>{
  assert.equal(extensionScan(patched),patched);
  assert.throws(()=>extensionScan('async function localExtensions() {}'),/Unrecognized/);
 });
 const report={at:new Date().toISOString(),passed:true,tests};
 fs.writeFileSync(path.join(__dirname,'../evidence/extension-scan-test.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(home,{recursive:true,force:true}));
