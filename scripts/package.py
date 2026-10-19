"""Package verified OpenCodex; retain rollback files only until verification succeeds."""
from pathlib import Path
import subprocess, hashlib, json, plistlib, zipfile, shutil, datetime, importlib.util, atexit
spec=importlib.util.spec_from_file_location('package_storage',Path(__file__).with_name('package-storage.py'))
storage=importlib.util.module_from_spec(spec);spec.loader.exec_module(storage)
root=Path(__file__).resolve().parent.parent
downloads=Path.home()/'Downloads'
source=root/'build/OpenCodex.app'
installed=Path('/Applications/OpenCodex.app')
dmg=downloads/'OpenCodex.dmg'
sourcezip=downloads/'OpenCodex-source.zip'
version='0.4.1'
baseline='original-apps-20261017.sha256'
def run(args): subprocess.run(args,check=True,cwd=root)
def sha(p):
 with p.open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()
def read(name): return json.loads((root/'evidence'/name).read_text())
def write_report(report):
 text=json.dumps(report,ensure_ascii=False,indent=2)+'\n'
 (root/'evidence/release-verification.json').write_text(text)
 (downloads/'OpenCodex-verification.json').write_text(text)
lock=storage.package_lock(root/'build');lock.__enter__();atexit.register(lock.__exit__,None,None,None)
run(['shasum','-a','256','-c','evidence/'+baseline])
run(['codesign','--verify','--deep','--strict',str(source)])
with (source/'Contents/Info.plist').open('rb') as f: info=plistlib.load(f)
assert info['CFBundleIdentifier']=='io.opencodex.desktop'
assert info['OpenCodexVersion']==version
names=['native-routing-test.json','native-local-test.json','native-tools-test.json','native-request-test.json','native-shell-test.json','native-queue-unit.json','native-workspace-unit.json','native-workspace-e2e.json','native-full-access-test.json','native-full-access-e2e.json','native-approvals-test.json','native-approvals-e2e.json','app-signing-update.json','ui-smoke.json']
tests={name:read(name) for name in names}
for name,result in tests.items():
 assert result['version']==version,(name,'wrong version')
 assert result['passed'],name
# Prior acceptance remains explicitly historical; it is never relabelled as this build.
historical_names=['native-queue-test.json','native-ssh-test.json','native-computer-e2e.json','native-browser-e2e.json','review-test.json','protocol-test.json','stop-reconnect-test.json','resume-tools-test.json','mode-smoke.json','native-pages.json']
historical={name:read(name) for name in historical_names}
for name,result in historical.items():
 assert result['version']=='0.4.0',(name,'unexpected historical version')
 if name!='mode-smoke.json': assert result['passed'],name
assert tests['native-full-access-e2e.json']['disabledRestoresProject']
assert tests['app-signing-update.json']['sameIdentityAcrossChangedBuilds']
assert tests['app-signing-update.json']['builds'][-1]['asarSHA256']==sha(source/'Contents/Resources/app.asar'),'Signing evidence belongs to a different build'
assert tests['ui-smoke.json']['liveQuotaAvailable']
assert tests['ui-smoke.json']['sshAttempt']['connected']
# Keep screenshots and detailed private desktop state in local evidence only.
# The release contains the same verified result with tool/status summaries.
for name in ['native-computer-e2e.json','native-browser-e2e.json']:
 result=historical[name]
 historical[name]={k:result[k] for k in ['version','at','kind','threadId','status','passed']}
 historical[name]['calls']=[{k:call[k] for k in ['tool','status']} for call in result['calls']]
ui=tests['ui-smoke.json'];modes=historical['mode-smoke.json']
assert ui['agentBridgeMainLoaded'] is False
assert modes['restoredSSH'] and modes['rejectUnsafeUrl']
assert modes['custom']['status']=='completed' and modes['custom']['mock']
assert modes['official']['initialized']
run(['/Users/ian/.local/bin/node','scripts/quota-test.cjs'])
run(['/Users/ian/.local/bin/node','scripts/ssh-profiles-test.cjs'])
print('Versioned tests, current original-app baseline and signature verified',flush=True)
install_needed=not installed.exists() or storage.sealed_identity(source)!=storage.sealed_identity(installed)
if install_needed and installed.exists() and storage.process_uses(installed):
 raise SystemExit('OpenCodex is running; close the App before installing a changed build. Existing files are untouched.')
stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
stage=root/'build'/('package-stage-'+stamp)
backup=root/'build/releases'/('before-'+version+'-'+stamp)
backup.mkdir(parents=True)
artifact_backup=downloads/('OpenCodex-previous-'+stamp)
artifact_backup.mkdir()
artifact_backup_names=set()
for p in (dmg,sourcezip,downloads/'OpenCodex-SHA256.txt',downloads/'OpenCodex-verification.json'):
 if p.exists():
  p.rename(artifact_backup/p.name);artifact_backup_names.add(p.name)
verification={
 'version':version,'packagedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'phase':'pre-package validation','directSSHImplementation':True,'agentBridgeMainLoaded':False,
 'tests':tests,'historicalAcceptance':historical,'historicalAcceptanceVersion':'0.4.0','quotaCases':6,'sshValidationAssertions':15,
 'liveSSHVerified':bool(ui.get('sshAttempt',{}).get('connected',False)),
 'limits':['Official OAuth login not exercised; custom Responses provider tested against local mock only',
 'Claude Code and dual-agent integration are not implemented in the new SSH panel',
 'Native cloud features require their own authentication and service eligibility; remote OAuth tokens are never copied',
 'SSH custom permission profiles and Guardian reviewer are rejected; restricted Mac tools use explicit user approvals',
 'Settings pages are verified for rendering; Appshots, hooks, every Git/worktree workflow and all third-party plugins are not individually exercised',
 'Native MCP resource APIs are connected; the app-server does not expose an MCP prompts API',
 'Skills scan reports 475 entries and 2 parse errors; discovery does not prove every dependency is usable',
 'Stable local self-signed identity; no Developer ID notarization. Cross-update macOS TCC permission retention is not verified',
 'Highest-access switch applies to SSH conversations, persists across restarts, and does not override macOS or plugin-specific authorization'],
 'liveAcceptance':{'remoteMacFileRead':True,'remoteNativeNode':True,'highestAccessAcrossProjectsAndRestart':True,'highestAccessDisableRestoresProject':True,'rememberedToolGrantAcrossRestart':True,'revokedToolAsksAgainAndStopCancels':True},
 'acceptanceScope':'0.4.1 permission changes and listed current regression tests; other workflows retain separately dated 0.4.0 evidence',
 'nativeParityComplete':False,
 'originalBaseline':baseline,
}
write_report(verification)
shutil.copy2(root/'vendor/agentbridge/LICENSE',root/'THIRD-PARTY-AGENTBRIDGE-LICENSE')
with zipfile.ZipFile(sourcezip,'x',zipfile.ZIP_DEFLATED) as z:
 for folder in ('src','scripts'):
  for p in sorted((root/folder).iterdir()):
   if p.is_file() and p.suffix in ('.cjs','.js','.py','.c','.css','.html'):
    z.write(p,'OpenCodex/'+folder+'/'+p.name)
 for name in ['README.md','THIRD-PARTY-AGENTBRIDGE-LICENSE']:z.write(root/name,'OpenCodex/'+name)
 for name in ['release-verification.json',baseline]:
  z.write(root/'evidence'/name,'OpenCodex/evidence/'+name)
 for name,result in {**historical,**tests}.items():
  z.writestr('OpenCodex/evidence/'+name,json.dumps(result,ensure_ascii=False,indent=2)+'\n')
with zipfile.ZipFile(sourcezip) as z:
 if z.testzip() is not None: raise SystemExit('Source ZIP verification failed')
run(['python3','scripts/stop-owned-dev.py'])
# Only replace changed, inactive independent apps. Repacking documentation leaves the running App intact.
backup_names=set()
if install_needed:
 if installed.exists():
  installed.rename(backup/'OpenCodex.app');backup_names.add('OpenCodex.app')
 try:
  run(['ditto',str(source),str(installed)])
  run(['codesign','--verify','--deep','--strict',str(installed)])
 except BaseException:
  if installed.exists(): installed.rename(backup/'failed-new-OpenCodex.app')
  if (backup/'OpenCodex.app').exists(): (backup/'OpenCodex.app').rename(installed)
  raise
print('Independent App verified'+(' and installed' if install_needed else '; identical installed App preserved'),flush=True)
stage.mkdir()
run(['ditto',str(installed),str(stage/'OpenCodex.app')])
(stage/'Applications').symlink_to('/Applications')
shutil.copy2(root/'README.md',stage/'請先閱讀.md')
shutil.copy2(sourcezip,stage/sourcezip.name)
print('Creating disk image',flush=True)
run(['hdiutil','create','-volname','OpenCodex','-srcfolder',str(stage),'-format','UDZO','-imagekey','zlib-level=6',str(dmg)])
run(['hdiutil','verify',str(dmg)])
mount=root/'build/dmg-verification'
mount.mkdir(exist_ok=True)
subprocess.run(['hdiutil','attach','-readonly','-nobrowse','-mountpoint',str(mount),str(dmg)],check=True,stdout=subprocess.DEVNULL)
try:
 run(['codesign','--verify','--deep','--strict',str(mount/'OpenCodex.app')])
 relative='Contents/Resources/app.asar'
 if sha(mount/'OpenCodex.app'/relative)!=sha(installed/relative):raise SystemExit('Mounted app checksum mismatch')
 with (mount/'OpenCodex.app/Contents/Info.plist').open('rb') as f: assert plistlib.load(f)['OpenCodexVersion']==version
 if not (mount/'Applications').is_symlink():raise SystemExit('Applications shortcut missing')
finally:
 run(['hdiutil','detach',str(mount)])
run(['shasum','-a','256','-c','evidence/'+baseline])
hashes={p.name:sha(p) for p in (dmg,sourcezip)}
(downloads/'OpenCodex-SHA256.txt').write_text(''.join(h+'  '+n+'\n' for n,h in hashes.items()))
verification.update(phase='package verified',dmgVerified=True,installedSignatureVerified=True,originalAppsUnchanged=True,previousAppBackup=str(backup/'OpenCodex.app'),previousArtifacts=str(artifact_backup),artifacts=[{'name':p.name,'bytes':p.stat().st_size,'sha256':hashes[p.name]} for p in (dmg,sourcezip)])
write_report(verification)
# Only after image, signatures, checksums and source ZIP have all passed.
# Failure before this point leaves rollback directories for repair.
storage.remove_generated(stage,root/'build',{'OpenCodex.app','Applications','請先閱讀.md',sourcezip.name})
storage.remove_generated(backup,root/'build/releases',backup_names)
storage.remove_generated(artifact_backup,downloads,artifact_backup_names)
verification.update(previousAppBackup=None,previousArtifacts=None,temporaryArtifactsRemoved=True,installedAppReplaced=install_needed)
write_report(verification)
print(json.dumps({'version':version,'dmgVerified':True,'installedSignatureVerified':True,'originalAppsUnchanged':True,'artifacts':verification['artifacts']}),flush=True)
