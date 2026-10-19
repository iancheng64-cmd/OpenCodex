'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {nativeProfile,prepareProfile,claudeConnection,engineTransition}=require('../src/native-profile.cjs'),toml=require('../build/OpenCodex.app/Contents/Resources/agentbridge/app/node_modules/smol-toml');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'opencodex-profile-unit-')),tests=[];
try{
 const official=path.join(root,'codex-official');fs.mkdirSync(official);
 for(const name of ['plugins','skills'])fs.mkdirSync(path.join(official,name));
 const config={model:'codex-only',model_provider:'private',model_reasoning_effort:'xhigh',notify:['private-hook'],mcp_servers:{test:{command:'test'}},plugins:{test:{enabled:true}}};
 const original=toml.stringify(config);fs.writeFileSync(path.join(official,'config.toml'),original);fs.writeFileSync(path.join(official,'auth.json'),'test-secret');fs.writeFileSync(path.join(official,'.codex-global-state.json'),'{"history":"codex-only"}');
 const profile=nativeProfile(root,{mode:'ssh',sshAgent:'claude'});prepareProfile(root,profile,toml);
 assert.notEqual(profile.userData,root);assert.notEqual(profile.home,official);
 const seeded=toml.parse(fs.readFileSync(path.join(profile.home,'config.toml'),'utf8'));assert.deepEqual(JSON.parse(JSON.stringify(seeded)),{mcp_servers:config.mcp_servers,plugins:config.plugins});
 for(const name of ['auth.json','.codex-global-state.json'])assert.equal(fs.existsSync(path.join(profile.home,name)),false);
 for(const name of ['plugins','skills'])assert.equal(fs.realpathSync(path.join(profile.home,name)),fs.realpathSync(path.join(official,name)));
 assert.equal(fs.readFileSync(path.join(official,'config.toml'),'utf8'),original);tests.push('isolates native history and model state, shares installed extensions, does not copy credentials or hooks');
 fs.appendFileSync(path.join(profile.home,'config.toml'),'\n# user preference\n');prepareProfile(root,profile,toml);assert.match(fs.readFileSync(path.join(profile.home,'config.toml'),'utf8'),/user preference/);tests.push('relaunch preserves the engine profile');
 assert.equal(nativeProfile(root,{mode:'ssh',sshAgent:'codex'}).home,official);assert.equal(nativeProfile(root,{mode:'official',sshAgent:'claude'}).userData,root);assert.equal(nativeProfile(root,{mode:'custom',sshAgent:'claude'}).home,path.join(root,'codex-custom'));tests.push('Codex and existing official/custom homes remain unchanged');
 for(const configDir of ['/home/test/.claude','C:\\Users\\test\\.claude','\\\\server\\share'])assert.equal(claudeConnection({configDir}).configDir,configDir);
 for(const configDir of ['relative','/path\ncommand','x'.repeat(4097)])assert.throws(()=>claudeConnection({configDir}));
 assert.throws(()=>claudeConnection({authMode:'unknown'}));assert.deepEqual(claudeConnection(),{authMode:'official'});assert.deepEqual(claudeConnection({configDir:'  '}),{authMode:'official'});tests.push('remote configuration accepts absolute POSIX and Windows paths and rejects invalid input');
 for(const mode of ['official','custom','ssh']){
  const original={mode,sshAgent:'codex',profileId:'codex-host',profileName:'Codex host',cwd:'/codex',fullAccess:true};
  const saved=JSON.stringify(original);
  const claude=engineTransition(original,{engine:'claude'});
  assert.equal(claude.mode,'ssh');assert.equal(claude.sshAgent,'claude');
  Object.assign(claude,{profileId:'claude-host',profileName:'Claude host',cwd:'/claude'});
  const back=engineTransition(claude,{engine:'codex'});
  assert.equal(back.mode,mode);assert.equal(back.profileId,'codex-host');assert.equal(back.cwd,'/codex');assert(back.fullAccess);
  const again=engineTransition(back,{engine:'claude'});
  assert.equal(again.profileId,'claude-host');assert.equal(again.cwd,'/claude');assert.equal(again.mode,'ssh');
  assert.equal(JSON.stringify(original),saved);
 }
 assert.throws(()=>engineTransition({mode:'official'},{engine:'unknown'}),/Agent/);
 tests.push('engine roundtrip restores official/custom/SSH routing, per-host directories and full access without mutating input');
 const {discussionDeadline,discussionTransportDeadline}=require('./runtime-patches.cjs');
 const host=fs.readFileSync(path.join(__dirname,'../vendor/agentbridge/dist-main/local-tool-host.js'),'utf8');
 const patched=discussionDeadline(host);assert.equal(discussionDeadline(patched),patched);
 assert.match(patched,/opencodex-native:agents/);new (require('node:vm').Script)(patched);
 const policy=fs.readFileSync(path.join(__dirname,'../vendor/agentbridge/dist-main/runtime-policy.js'),'utf8');
 const transport=discussionTransportDeadline(policy);assert.equal(discussionTransportDeadline(transport),transport);new (require('node:vm').Script)(transport);
 tests.push('discussion deadlines patch the actual vendor sources and are syntactically valid and idempotent');
 const report={at:new Date().toISOString(),passed:true,tests};fs.writeFileSync(path.join(__dirname,'../evidence/native-profile-unit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{fs.rmSync(root,{recursive:true,force:true});}
