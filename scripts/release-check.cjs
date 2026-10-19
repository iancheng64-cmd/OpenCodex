'use strict';
// Current release evidence is bound to bundle and source digests.
// Older scripts retain their original report labels; those files are not relabelled or used as release gates.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {archive}=require('./asar-reader.cjs'),root=path.resolve(__dirname,'..'),app=path.join(root,'build/OpenCodex.app'),asar=path.join(app,'Contents/Resources/app.asar');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),report={version:'0.4.8',at:new Date().toISOString(),asarSHA256:sha(fs.readFileSync(asar)),sources:{},tests:[],passed:false};
try{
 report.asarIntegrity=require('./asar-integrity.cjs').verify(asar);
 for(const script of ['identity.py','stable-signing.py','patch-asar.cjs','asar-integrity.cjs','subagent-patches.cjs','runtime-patches.cjs','bundle-native-hooks.cjs'])report.sources['scripts/'+script]=sha(fs.readFileSync(path.join(__dirname,script)));
 const a=archive(asar);assert.equal(JSON.parse(a.read('package.json')).openCodexVersion,report.version);
 for(const name of fs.readdirSync(path.join(root,'src'))){
  const code=fs.readFileSync(path.join(root,'src',name));report.sources['src/'+name]=sha(code);
  if(!['bridge-adapter.cjs','native-preload.cjs'].includes(name))assert.equal(sha(a.read('opencodex/'+name)),sha(code),name+' differs from bundle');
 }
 let preload=fs.readFileSync(path.join(root,'src/native-preload.cjs'),'utf8');
 preload=preload.replace("/*OPEN_CODEX_STYLES*/''",JSON.stringify(fs.readFileSync(path.join(root,'src/connections.css'),'utf8'))).replace("/*OPEN_CODEX_PANEL*/''",JSON.stringify(fs.readFileSync(path.join(root,'src/connections.html'),'utf8')));
 assert(a.read('.vite/build/preload.js').toString().endsWith(preload));
 assert(fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/runtime-backend.js'),'utf8').endsWith(fs.readFileSync(path.join(root,'src/bridge-adapter.cjs'),'utf8')));
 const helper=path.join(app,'Contents/Resources/opencodex-hooks-helper');
 report.hooksHelperSHA256=sha(fs.readFileSync(helper));
 cp.execFileSync('codesign',['--verify','--strict',helper]);
 const executorSource=fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/local-exec-server.js'),'utf8');
 assert.equal(require('./subagent-patches.cjs').executor(executorSource),executorSource,'bounded executor concurrency missing from bundle');
 const backend=fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/runtime-backend.js'),'utf8');assert.equal(require('./runtime-patches.cjs').initializationDiagnostics(backend),backend,'connection diagnostics missing from bundle');assert.equal(require('./subagent-patches.cjs').backend(backend),backend,'scoped lifecycle patches missing from bundle');
 assert(fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/local-tool-host.js'),'utf8').endsWith(fs.readFileSync(path.join(root,'src/workspace-host.cjs'),'utf8')));
 const host=fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/local-tool-host.js'),'utf8');
 assert.equal(require('./subagent-patches.cjs').hooksHost(host),host,'native Hooks endpoint missing');
 assert(a.read('webview/assets/widget-338e9f889b2d.js').toString().includes(require('./native-mcp-patches.cjs').after));
 a.close();
 for(const script of ['asar-integrity-test.cjs','native-helper-cleanup-test.cjs','native-profile-test.cjs','native-agents-test.cjs','native-claude-test.cjs','native-tools-test.cjs','native-full-access-test.cjs','native-approvals-test.cjs','native-app-approval-test.cjs','native-routing-test.cjs','native-shell-test.cjs','native-queue-unit.cjs','native-workspace-test.cjs','native-request-test.cjs','native-parity-test.cjs','native-hooks-relay-probe.cjs','native-hooks-runtime-test.cjs','native-hooks-mcp-test.cjs','native-hooks-service-test.cjs','native-hooks-helper-check.cjs','native-hooks-mcp-e2e.cjs','native-history-test.cjs','native-policy-parity-test.cjs','native-organization-test.cjs','native-mcp-test.cjs','native-subagents-test.cjs','native-agent-runs-test.cjs','native-connection-test.cjs','quota-test.cjs','ssh-profiles-test.cjs','native-remote-engine-test.cjs']){
  report.sources['scripts/'+script]=sha(fs.readFileSync(path.join(__dirname,script)));
  const result=cp.spawnSync(process.execPath,[path.join(__dirname,script)],{cwd:root,env:{...process.env,OPENCODEX_HOOKS_HELPER:helper},encoding:'utf8',timeout:120000});
  report.tests.push({script,passed:result.status===0});
  if(result.status!==0)throw Error(script+': '+result.stderr+' '+result.stdout);
  console.log('PASS '+script);
 }
 for(const scenario of ['normal','cancel-child','cancel-root','parent-complete','review','review-cancel']){
  const script='native-subagents-e2e.cjs';report.sources['scripts/'+script]=sha(fs.readFileSync(path.join(__dirname,script)));
  const result=cp.spawnSync(process.execPath,[path.join(__dirname,script),scenario],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  report.tests.push({script,scenario,passed:result.status===0});
  if(result.status!==0)throw Error(script+' '+scenario+': '+result.stderr+' '+result.stdout);
  const file=path.join(root,'evidence/native-subagents-e2e-'+scenario+'.json');
  report.tests.at(-1).reportSHA256=sha(fs.readFileSync(file));
  console.log('PASS '+script+' '+scenario);
 }
 for(const script of ['launcher-test.py','package-storage-test.py']){
  report.sources['scripts/'+script]=sha(fs.readFileSync(path.join(__dirname,script)));
  const result=cp.spawnSync('python3',[path.join(__dirname,script)],{cwd:root,encoding:'utf8',timeout:120000});
  report.tests.push({script,passed:result.status===0});if(result.status!==0)throw Error(script+': '+result.stderr+' '+result.stdout);console.log('PASS '+script);
 }
 cp.execFileSync('codesign',['--verify','--deep','--strict',app]);
 report.passed=true;
}catch(e){report.error=e.stack;process.exitCode=1;}
fs.writeFileSync(path.join(root,'evidence/release-check-0.4.8.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({version:report.version,passed:report.passed,tests:report.tests,error:report.error}));
