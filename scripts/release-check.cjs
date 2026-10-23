'use strict';
// Current release evidence is bound to bundle and source digests.
// Older scripts retain their original report labels; those files are not relabelled or used as release gates.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {archive}=require('./asar-reader.cjs'),root=path.resolve(__dirname,'..'),app=path.join(root,'build/OpenCodex.app'),asar=path.join(app,'Contents/Resources/app.asar');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),report={version:'0.4.11',at:new Date().toISOString(),asarSHA256:sha(fs.readFileSync(asar)),sources:{},tests:[],passed:false};
try{
 report.asarIntegrity=require('./asar-integrity.cjs').verify(asar);
 for(const script of ['identity.py','refresh-build.cjs','build.cjs','native-model-patches.cjs','stable-signing.py','patch-asar.cjs','asar-integrity.cjs','subagent-patches.cjs','runtime-patches.cjs','extension-scan-patches.cjs','permission-patches.cjs','native-guardian-patches.cjs','native-steer-patches.cjs','claude-patches.cjs','bundle-native-hooks.cjs','bundle-permission-engine.cjs','permission-engine-check.cjs'])report.sources['scripts/'+script]=sha(fs.readFileSync(path.join(__dirname,script)));
 const a=archive(asar);assert.equal(JSON.parse(a.read('package.json')).openCodexVersion,report.version);
 for(const name of fs.readdirSync(path.join(root,'src'))){
  const code=fs.readFileSync(path.join(root,'src',name));report.sources['src/'+name]=sha(code);
  if(!['bridge-adapter.cjs','native-preload.cjs'].includes(name))assert.equal(sha(a.read('opencodex/'+name)),sha(code),name+' differs from bundle');
 }
 let preload=fs.readFileSync(path.join(root,'src/native-preload.cjs'),'utf8');
 preload=preload.replace("/*OPEN_CODEX_STYLES*/''",JSON.stringify(fs.readFileSync(path.join(root,'src/connections.css'),'utf8'))).replace("/*OPEN_CODEX_PANEL*/''",JSON.stringify(fs.readFileSync(path.join(root,'src/connections.html'),'utf8')));
 assert(a.read('.vite/build/preload.js').toString().endsWith(preload));
 assert(fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/runtime-backend.js'),'utf8').endsWith(fs.readFileSync(path.join(root,'src/bridge-adapter.cjs'),'utf8')));
 const migrationHelper=path.join(app,'Contents/Resources/opencodex-credential-migrate');
 report.credentialMigrationHelperSHA256=sha(fs.readFileSync(migrationHelper));
 cp.execFileSync('codesign',['--verify','--strict',migrationHelper]);
 const helper=path.join(app,'Contents/Resources/opencodex-hooks-helper');
 report.hooksHelperSHA256=sha(fs.readFileSync(helper));
 cp.execFileSync('codesign',['--verify','--strict',helper]);
 const permissionEngine=path.join(app,'Contents/Resources/opencodex-permission-engine');
 cp.execFileSync('codesign',['--verify','--strict',permissionEngine]);
 report.permissionEngine=JSON.parse(cp.execFileSync(process.execPath,[path.join(__dirname,'permission-engine-check.cjs'),permissionEngine],{encoding:'utf8',timeout:20000}));
 report.permissionEngineLicenseSHA256=sha(fs.readFileSync(path.join(app,'Contents/Resources/opencodex-permission-engine.LICENSE')));
 assert.equal(report.permissionEngineLicenseSHA256,sha(fs.readFileSync(path.join(root,'research/codex-0.160.0/LICENSE'))));
 const extensionsSource=fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/extensions.js'),'utf8');
 assert.equal(require('./extension-scan-patches.cjs').extensionScan(extensionsSource),extensionsSource,'scoped extension discovery missing from bundle');
 report.extensionsSHA256=sha(extensionsSource);
 const executorSource=fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/local-exec-server.js'),'utf8');
 assert.equal(require('./subagent-patches.cjs').executor(executorSource),executorSource,'bounded executor concurrency missing from bundle');
 const backend=fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/runtime-backend.js'),'utf8');assert.equal(require('./runtime-patches.cjs').initializationDiagnostics(backend),backend,'connection diagnostics missing from bundle');assert.equal(require('./subagent-patches.cjs').backend(backend),backend,'scoped lifecycle patches missing from bundle');
 assert.equal(require('./permission-patches.cjs').backend(backend),backend,'permission lifecycle missing from bundle');
 assert.equal(require('./runtime-patches.cjs').inventoryDeadline(backend),backend,'bounded tools-only isolation check missing from bundle');
 assert(fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/local-tool-host.js'),'utf8').endsWith(fs.readFileSync(path.join(root,'src/workspace-host.cjs'),'utf8')));
 const host=fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/local-tool-host.js'),'utf8');
 assert.equal(require('./subagent-patches.cjs').hooksHost(host),host,'native Hooks endpoint missing');
 assert(a.read('webview/assets/widget-338e9f889b2d.js').toString().includes(require('./native-mcp-patches.cjs').after));
 const primaryBundle=a.read('webview/assets/app-primary-2a670e99a60c.js').toString();assert.equal(require('./native-model-patches.cjs').refreshPrimaryModelLabel(primaryBundle),primaryBundle,'external model composer labels missing');
 const sharedBundle=a.read('webview/assets/app-shared-8340f229c2b3.js').toString();assert.equal(require('./native-steer-patches.cjs').shared(sharedBundle),sharedBundle,'steer wait patch missing from bundle');
 const claudeRuntime=fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/claude-local-runtime.js'),'utf8');assert.equal(require('./claude-patches.cjs').patchClaudeRuntime(claudeRuntime),claudeRuntime,'Claude steer runtime patch missing from bundle');
 const claudeAuth=fs.readFileSync(path.join(app,'Contents/Resources/agentbridge/app/dist-main/claude-auth-probe.js'),'utf8');assert.equal(require('./claude-patches.cjs').patchClaudeAuthProbe(claudeAuth),claudeAuth,'Claude credential denial diagnostics missing');
 a.close();
 for(const script of ['native-model-patches-test.cjs','asar-integrity-test.cjs','safe-storage-test.cjs','native-helper-cleanup-test.cjs','native-profile-test.cjs','native-agents-test.cjs','native-claude-test.cjs','claude-auth-probe-test.cjs','native-handoff-test.cjs','unified-providers-test.cjs','composio-test.cjs','native-steer-test.cjs','native-peer-reconnect-test.cjs','native-tools-test.cjs','native-full-access-test.cjs','native-approvals-test.cjs','native-guardian-test.cjs','native-guardian-runtime-test.cjs','native-guardian-ui-test.cjs','native-app-approval-test.cjs','native-inventory-test.cjs','extension-scan-test.cjs','native-routing-test.cjs','native-shell-test.cjs','native-queue-unit.cjs','native-workspace-test.cjs','native-request-test.cjs','native-parity-test.cjs','native-hooks-relay-probe.cjs','native-hooks-runtime-test.cjs','native-hooks-mcp-test.cjs','native-hooks-service-test.cjs','native-hooks-helper-check.cjs','native-hooks-mcp-e2e.cjs','native-history-test.cjs','native-policy-parity-test.cjs','native-organization-test.cjs','native-mcp-test.cjs','native-subagents-test.cjs','native-agent-runs-test.cjs','native-connection-test.cjs','quota-test.cjs','ssh-profiles-test.cjs','native-remote-engine-test.cjs','native-startup-test.cjs','native-config-mutations-test.cjs','native-permissions-runtime-test.cjs','native-permissions-workspace-test.cjs','native-permissions-connection-test.cjs','native-permissions-adapter-test.cjs']){
  report.sources['scripts/'+script]=sha(fs.readFileSync(path.join(__dirname,script)));
  const result=cp.spawnSync(process.execPath,[path.join(__dirname,script)],{cwd:root,env:{...process.env,OPENCODEX_HOOKS_HELPER:helper},encoding:'utf8',timeout:120000});
  report.tests.push({script,passed:result.status===0});
  if(result.status!==0)throw Error(script+': '+result.stderr+' '+result.stdout);
  console.log('PASS '+script);
 }
 for(const name of ['native-permission-catalog','native-permissions-tools','native-permissions-input','native-permissions-service','native-permissions-runtime','native-permissions-mcp','native-permissions-hooks','native-permissions-dispatch']){
  const script='research/'+name+'-probe.cjs';if(!fs.existsSync(path.join(root,script))){report.tests.push({script,passed:false,notRun:true,reason:'Required legacy probe is missing from this checkout'});continue;}report.sources[script]=sha(fs.readFileSync(path.join(root,script)));
  const result=cp.spawnSync(process.execPath,[path.join(root,script)],{cwd:root,env:{...process.env,
   OPENCODEX_PERMISSION_ENGINE:permissionEngine,OPENCODEX_NODE_REPL:path.join(app,'Contents/Resources/cua_node/bin/node_repl')},
   encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  report.tests.push({script,passed:result.status===0});
  if(result.status!==0)throw Error(script+': '+result.stderr+' '+result.stdout);
  const file=path.join(root,'evidence',name+'-probe.json'),data=JSON.parse(fs.readFileSync(file));
  assert.equal(data.passed,true);if(data.engineSha256)assert.equal(data.engineSha256,report.permissionEngine.binarySHA256);
  report.tests.at(-1).reportSHA256=sha(fs.readFileSync(file));report.tests.at(-1).checks=data.checks.length;
  console.log('PASS '+script);
 }
 for(const scenario of ['root','children','review']){
  const script='research/native-guardian-probe.cjs';if(!fs.existsSync(path.join(root,script))){report.tests.push({script,scenario,passed:false,notRun:true,reason:'Required legacy probe is missing from this checkout'});continue;}report.sources[script]=sha(fs.readFileSync(path.join(root,script)));
  const result=cp.spawnSync(process.execPath,[path.join(root,script),'--mcp','--product',...(scenario==='root'?[]:['--'+scenario])],
   {cwd:root,env:{...process.env,OPENCODEX_GUARDIAN_ENGINE:permissionEngine},encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
  report.tests.push({script,scenario,passed:result.status===0});
  if(result.status!==0)throw Error(script+' '+scenario+': '+result.stderr+' '+result.stdout);
  const file=path.join(root,'evidence/native-guardian-mcp-product-probe'+(scenario==='root'?'':'-'+scenario)+'-codex-cli_0.160.0.json');
  const data=JSON.parse(fs.readFileSync(file));
  assert.equal(data.passed,true);assert.equal(data.productPipeline,true);assert.equal(data.scenario,scenario);
  assert.equal(data.engineSha256,report.permissionEngine.binarySHA256);
  assert.equal(data.checks.length,4);assert(data.checks.every(check=>check.passed));
  assert.deepEqual(data.approvals,[]);assert.deepEqual(data.errors,[]);
  report.tests.at(-1).reportSHA256=sha(fs.readFileSync(file));report.tests.at(-1).checks=data.checks.length;
  console.log('PASS '+script+' '+scenario);
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
 report.passed=report.tests.every(t=>t.passed);
 if(!report.passed){report.error='Full release acceptance incomplete: required legacy probes are missing.';process.exitCode=1;}
}catch(e){report.error=e.stack;process.exitCode=1;}
fs.writeFileSync(path.join(root,'evidence/release-check-0.4.11.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({version:report.version,passed:report.passed,tests:report.tests,error:report.error}));
