'use strict';
// Aggregate only evidence produced after the current signed bundle regression.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),evidence=path.join(root,'evidence');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
// --waive-remote-engine: the OpenCodexHooks/Permissions/Guardian patched engine host is unavailable.
// Those gates are recorded as waived (never as passed); every other gate is still enforced.
const waive=process.argv.includes('--waive-remote-engine');
const remoteEngineFiles=['native-hooks-product-e2e.json','native-permissions-model-e2e.json','native-permissions-cancel-e2e.json','native-guardian-product-e2e.json'];
const report={version:'0.4.10',at:new Date().toISOString(),passed:false,tests:{}};
if(waive)report.waived={reason:'Patched remote engine host (OpenCodexHooks/1, OpenCodexPermissions/1, OpenCodexGuardian/1) unavailable; released without these gates at user request',
 gates:['native Hooks product acceptance','custom permission model/cancel acceptance','Guardian product acceptance','patched-engine core regression and conversation startup latency'],evidence:[...remoteEngineFiles,'latency-core-summary.json','windows-latency-deploy.json','native-latency-live.json']};
try{
 report.asarSHA256=sha(fs.readFileSync(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar')));
 const baseline=JSON.parse(fs.readFileSync(path.join(evidence,'release-check-0.4.10.json')));
 assert.equal(baseline.passed,true);assert.equal(baseline.asarSHA256,report.asarSHA256);
 for(const [relative,digest] of Object.entries(baseline.sources))assert.equal(sha(fs.readFileSync(path.join(root,relative))),digest,relative+' changed since regression');
 const files=['native-local-test.json','ui-smoke.json','native-workspace-e2e.json','native-organization-e2e.json','native-shell-e2e.json','native-restart-e2e.json','native-mcp-gui-summary.json','native-subagents-live.json','native-subagents-ui.json','native-connection-live.json','native-review-git-e2e-0.4.10.json','native-queue-e2e-0.4.10.json','native-hooks-product-e2e.json','native-startup-live.json','native-permissions-model-e2e.json','native-permissions-cancel-e2e.json','native-guardian-product-e2e.json'];
 for(const file of files.filter(f=>!waive||!remoteEngineFiles.includes(f))){
  const data=JSON.parse(fs.readFileSync(path.join(evidence,file),'utf8'));
  assert.equal(data.version,report.version,file);assert.equal(data.passed,true,file);
  assert(Date.parse(data.at)>=Date.parse(baseline.at),file+' predates current bundle acceptance');
  if(data.asarSHA256||data.asarSha256)assert.equal(data.asarSHA256||data.asarSha256,report.asarSHA256,file);
  report.tests[file]={at:data.at,sha256:sha(fs.readFileSync(path.join(evidence,file))),passed:true};
 }
 const read=n=>JSON.parse(fs.readFileSync(path.join(evidence,n+'.json')));
 if(!waive){
 const core=read('latency-core-summary');
 assert(core.passed&&core.version===report.version&&core.selected===core.passedUnique&&core.missing.length===0&&core.failedLatest.length===0);
 assert.equal(sha(fs.readFileSync(path.join(root,core.fixtureTimingChange.file))),core.fixtureTimingChange.sha256);
 assert.equal(sha(fs.readFileSync(path.join(evidence,core.inventoryFile))),core.inventorySHA256);
 assert.equal(sha(fs.readFileSync(path.join(root,'research/codex-0.160.0/codex-rs/Cargo.lock'))),core.cargoLockSHA256);
 const coreSource=read('permission-engine-source');
 assert.equal(core.sourceArchiveSHA256,coreSource.sha256);
 assert.equal(sha(fs.readFileSync(path.join(root,coreSource.archive))),core.sourceArchiveSHA256);
 for(const log of core.logs)assert.equal(sha(fs.readFileSync(path.join(evidence,log.file))),log.sha256,log.file);
 report.coreRegression={passedUnique:core.passedUnique,ignored:core.ignored.length,scope:core.scope,evidenceSHA256:sha(fs.readFileSync(path.join(evidence,'latency-core-summary.json')))};
 }
 const ui=read('ui-smoke'),workspace=read('native-workspace-e2e'),organization=read('native-organization-e2e'),restart=read('native-restart-e2e');
 assert.equal(ui.sshAttempt.connected,true);assert.equal(ui.liveQuotaAvailable,true);
 assert(workspace.tools.some(t=>t.tool.startsWith('mac_ext_')&&t.status==='completed'));
 assert(workspace.nativeText.includes(fs.readFileSync(path.join(workspace.fixture,'project-marker.txt'),'utf8')));
 assert(workspace.threadWorktree&&workspace.worktree?.worktreeGitRoot);
 assert(organization.passed&&restart.passed&&restart.nativeSubagentPersistence===true);
 report.liveCodexTool=true;report.nativeGitWorktree=true;report.nativeOrganization=true;report.restartPersistence=true;
 const mcp=read('native-mcp-gui-summary');assert.equal(mcp.asarSHA256,report.asarSHA256);assert(mcp.realModelToolCall&&mcp.nativeWebView&&mcp.postTurnCallback&&mcp.postTitleComposerReady);report.nativeMcpAppFixture=true;report.postTitleComposerReady=true;
 const children=read('native-subagents-live'),childUi=read('native-subagents-ui');
 assert.equal(children.asarSHA256,report.asarSHA256);assert.equal(childUi.asarSHA256,report.asarSHA256);
 assert(children.nativeHistory&&children.nativePluginIsolation&&children.children.length===2);
 assert(childUi.rootRestored&&childUi.overview&&childUi.childDetails&&childUi.returnNavigation);
 report.nativeSubagents=true;report.nativeSubagentUi=true;
 const connection=read('native-connection-live');assert.equal(connection.asarSHA256,report.asarSHA256);assert(connection.toolsReady&&connection.canSubmit&&connection.connectionStage==='ready'&&connection.diagnostic===null);report.connectionReadiness=true;
 const review=read('native-review-git-e2e-0.4.10'),queue=read('native-queue-e2e-0.4.10');
 assert.equal(review.asarSha256,report.asarSHA256);assert.equal(queue.asarSha256,report.asarSHA256);
 assert(review.findingAtChangedLine&&review.identifiesArithmeticBug&&review.sourceUnchanged&&review.fixtureUnchanged);report.nativeGitReview=true;
 assert(queue.queueEditing&&queue.automaticStart&&queue.historyVerified);report.nativeMessageQueue=true;
 const startup=read('native-startup-live');assert(startup.status.connected&&startup.status.toolsReady&&startup.status.canSubmit);
 assert(startup.events.some(e=>e.type==='ssh-autoconnect-start')&&startup.events.some(e=>e.type==='ssh-autoconnect-finished'&&e.connected));
 assert.equal(startup.checks.length,3);report.automaticSshStartup=true;
 if(waive){
  for(const key of ['nativeHooks','hooksFixtureRestored','customPermissionProfileLifecycle','customPermissionCancelRecovery','permissionFixtureRestored','customPermissionToolApprovalVerified','nativeGuardian','guardianFixtureRestored'])report[key]=false;
  report.coreRegression=null;report.conversationStartup=null;report.remoteHooksEngine=null;
 } else {
 const hooks=read('native-hooks-product-e2e');assert.equal(hooks.asarSHA256,report.asarSHA256);assert(hooks.checks.length>=6&&hooks.interrupt?.descendantsStopped===true);report.nativeHooks=true;
 const fixture=JSON.parse(fs.readFileSync(path.join(root,'build/hooks-product-state.json')));assert(fixture.restoredAt,'Hooks fixture not restored');report.hooksFixtureRestored=true;
 const engine=read('windows-latency-deploy');assert(engine.Passed&&engine.OfficialUnchanged&&engine.ExistingProfileCompatible&&engine.Capability.includes('OpenCodexHooks/1')&&engine.Capability.includes('OpenCodexPermissions/1'));report.remoteHooksEngine={version:engine.Version,capability:engine.Capability,files:engine.Files,officialUnchanged:true,existingProfileCompatible:true};
  const model=read('native-permissions-model-e2e'),cancel=read('native-permissions-cancel-e2e');
 assert(model.checks.length===7&&model.threadId&&model.forkId&&model.scope.includes('no tool enforcement'));
 assert(cancel.checks.length===3&&cancel.cancelledTurnId&&cancel.scope.includes('no tool enforcement'));
 const restored=read('startup-fixture-restored');assert(restored.version===report.version&&restored.restored&&restored.fixtureProfilesRemoved&&restored.originalWorkspaceAndPermissionRestored&&restored.otherSettingsPreserved);
 assert(Date.parse(restored.at)>Date.parse(model.at)&&Date.parse(restored.at)>Date.parse(startup.at));
 report.customPermissionProfileLifecycle=true;report.customPermissionCancelRecovery=true;report.permissionFixtureRestored=true;
 report.customPermissionToolApprovalVerified=false;
 report.customPermissionAcceptanceScope='Profile switching, real model turn without tools, resume, fork and pending native approval cancellation/recovery passed. Isolated Mac sandbox enforcement is covered by regression probes. Native approval acceptance and ensuing custom-permission GUI tool/widget flows remain unverified because desktop automation cannot obtain the approval window.';
 const guardian=read('native-guardian-product-e2e');assert.equal(guardian.asarSHA256,report.asarSHA256);assert.equal(guardian.checks.length,5);assert(guardian.reviews.starts.length&&guardian.toolCalls.length===1);
 const guardianFixture=JSON.parse(fs.readFileSync(path.join(root,'build/guardian-product-state.json')));assert(guardianFixture.restoredAt,'Guardian fixture not restored');
 assert(engine.Capability.includes('OpenCodexGuardian/1'));report.nativeGuardian=true;report.guardianFixtureRestored=true;
 const latency=read('native-latency-live'),before=read('latency-before-scoped-discovery');
 assert(latency.passed&&before.passed);assert.equal(latency.asarSHA256,report.asarSHA256);
 assert.equal(latency.engine,before.engine);assert.equal(latency.effectivePermission,before.effectivePermission);
 assert.equal(latency.bridge.tools,before.bridge.tools);assert(latency.bridge.tools>100);
 const elapsed=data=>data.timings.find(t=>t.label==='thread/start'&&t.passed)?.ms;
 assert(elapsed(latency)>0&&elapsed(before)>0);
 report.conversationStartup={beforeMs:elapsed(before),afterMs:elapsed(latency),tools:latency.bridge.tools,
  scope:'One measured conversation per build under the same script; not a latency guarantee.',
  evidenceSHA256:sha(fs.readFileSync(path.join(evidence,'native-latency-live.json'))),
  beforeEvidenceSHA256:sha(fs.readFileSync(path.join(evidence,'latency-before-scoped-discovery.json')))};
 }
 report.nativeParityComplete=false;
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
fs.writeFileSync(path.join(evidence,'native-gpt-e2e-0.4.10.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
