'use strict';
// Aggregate only evidence produced after the current signed bundle regression.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'),evidence=path.join(root,'evidence');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const report={version:'0.4.8',at:new Date().toISOString(),passed:false,tests:{}};
try{
 report.asarSHA256=sha(fs.readFileSync(path.join(root,'build/OpenCodex.app/Contents/Resources/app.asar')));
 const baseline=JSON.parse(fs.readFileSync(path.join(evidence,'release-check-0.4.8.json')));
 assert.equal(baseline.passed,true);assert.equal(baseline.asarSHA256,report.asarSHA256);
 for(const [relative,digest] of Object.entries(baseline.sources))assert.equal(sha(fs.readFileSync(path.join(root,relative))),digest,relative+' changed since regression');
 const files=['native-local-test.json','ui-smoke.json','native-workspace-e2e.json','native-organization-e2e.json','native-shell-e2e.json','native-restart-e2e.json','native-mcp-gui-summary.json','native-subagents-live.json','native-subagents-ui.json','native-connection-live.json','native-review-git-e2e-0.4.8.json','native-queue-e2e-0.4.8.json','native-hooks-product-e2e.json'];
 for(const file of files){
  const data=JSON.parse(fs.readFileSync(path.join(evidence,file),'utf8'));
  assert.equal(data.version,report.version,file);assert.equal(data.passed,true,file);
  assert(Date.parse(data.at)>=Date.parse(baseline.at),file+' predates current bundle acceptance');
  report.tests[file]={at:data.at,sha256:sha(fs.readFileSync(path.join(evidence,file))),passed:true};
 }
 const read=n=>JSON.parse(fs.readFileSync(path.join(evidence,n+'.json')));
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
 const review=read('native-review-git-e2e-0.4.8'),queue=read('native-queue-e2e-0.4.8');
 assert.equal(review.asarSha256,report.asarSHA256);assert.equal(queue.asarSha256,report.asarSHA256);
 assert(review.findingAtChangedLine&&review.identifiesArithmeticBug&&review.sourceUnchanged&&review.fixtureUnchanged);report.nativeGitReview=true;
 assert(queue.queueEditing&&queue.automaticStart&&queue.historyVerified);report.nativeMessageQueue=true;
 const hooks=read('native-hooks-product-e2e');assert.equal(hooks.asarSHA256,report.asarSHA256);assert(hooks.checks.length>=6&&hooks.interrupt?.descendantsStopped===true);report.nativeHooks=true;
 const fixture=JSON.parse(fs.readFileSync(path.join(root,'build/hooks-product-state.json')));assert(fixture.restoredAt,'Hooks fixture not restored');report.hooksFixtureRestored=true;
 const engine=read('windows-hooks-engine-crlf-deploy');assert(engine.Passed&&engine.OfficialUnchanged&&engine.ExistingProfileCompatible&&engine.Capability.includes('OpenCodexHooks/1'));report.remoteHooksEngine={version:engine.Version,capability:engine.Capability,files:engine.Files,officialUnchanged:true,existingProfileCompatible:true};
 report.nativeParityComplete=false;
 report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
fs.writeFileSync(path.join(evidence,'native-gpt-e2e-0.4.8.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
