"""Package the exact 0.4.4 bundle exercised by GPT native acceptance."""
from pathlib import Path
import subprocess, hashlib, json, plistlib, zipfile, shutil, datetime, importlib.util
spec=importlib.util.spec_from_file_location('package_storage',Path(__file__).with_name('package-storage.py'))
storage=importlib.util.module_from_spec(spec);spec.loader.exec_module(storage)
root=Path(__file__).resolve().parent.parent
downloads=Path.home()/'Downloads'
source=root/'build/OpenCodex.app'
installed=Path('/Applications/OpenCodex.app')
version='0.4.4'
dmg=downloads/f'OpenCodex-{version}.dmg'
sourcezip=downloads/f'OpenCodex-{version}-source.zip'
def run(args): subprocess.run(args,check=True,cwd=root)
def sha(p):
 with p.open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()
def write_report(report):
 text=json.dumps(report,ensure_ascii=False,indent=2)+'\n'
 (root/f'evidence/release-{version}.json').write_text(text)
 (downloads/f'OpenCodex-{version}-verification.json').write_text(text)
def package():
 for p in (dmg,sourcezip):
  if p.exists(): raise SystemExit(f'Refusing to replace existing release artifact: {p}')
 baseline='original-apps-20261017.sha256'
 run(['shasum','-a','256','-c','evidence/'+baseline])
 run(['codesign','--verify','--deep','--strict',str(source)])
 with (source/'Contents/Info.plist').open('rb') as f: info=plistlib.load(f)
 assert info['CFBundleIdentifier']=='io.opencodex.desktop' and info['OpenCodexVersion']==version
 bundle_hash=sha(source/'Contents/Resources/app.asar')
 tests={}
 for name in ('release-check-0.4.4.json','native-gpt-e2e-0.4.4.json'):
  result=json.loads((root/'evidence'/name).read_text())
  assert result['passed'] and result['version']==version and result['asarSHA256']==bundle_hash,name
  tests[name]=result
 for relative,digest in tests['release-check-0.4.4.json']['sources'].items():
  assert sha(root/relative)==digest,f'Changed since regression: {relative}'
 assert tests['native-gpt-e2e-0.4.4.json']['liveCodexTool']
 assert tests['native-gpt-e2e-0.4.4.json']['restartPersistence']
 assert tests['native-gpt-e2e-0.4.4.json']['nativeOrganization']
 assert tests['native-gpt-e2e-0.4.4.json']['nativeGitWorktree']
 assert tests['native-gpt-e2e-0.4.4.json']['nativeMcpAppFixture']
 assert tests['native-gpt-e2e-0.4.4.json']['nativeSubagents']
 assert tests['native-gpt-e2e-0.4.4.json']['nativeSubagentUi']
 mcp=json.loads((root/'evidence/native-mcp-gui-summary.json').read_text())
 assert mcp['passed'] and mcp['asarSHA256']==bundle_hash and mcp['postTurnCallback']
 rea=json.loads((root/'evidence/rea-asar-integrity-summary.json').read_text())
 assert rea['passed'] and {r['operation'] for r in rea['records']}=={'inspect_artifact','inventory_artifact'}
 assert all(r['sha256']==bundle_hash and r['contradictions']==0 for r in rea['records']),'REA evidence differs from current bundle'
 if storage.process_uses(source): raise SystemExit('Development App is running; close it before packaging.')
 if installed.exists() and storage.process_uses(installed): raise SystemExit('Installed App is running; close it before installation.')
 identity=storage.sealed_identity(source)
 requirement=subprocess.check_output(['codesign','-d','-r-',str(source)],stderr=subprocess.STDOUT,text=True)
 if installed.exists():
  old_requirement=subprocess.check_output(['codesign','-d','-r-',str(installed)],stderr=subprocess.STDOUT,text=True)
  line=lambda text: next(row for row in text.splitlines() if row.startswith('designated =>'))
  assert line(requirement)==line(old_requirement),'Signing identity changed'
 stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
 stage=root/'build'/('package-stage-'+stamp)
 mount=root/'build'/('dmg-verification-'+stamp)
 backup=root/'build/releases'/('before-'+version+'-'+stamp)
 report={'version':version,'packagedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'phase':'validated bundle before packaging','asarSHA256':bundle_hash,'tests':tests,'nativeParityComplete':False,
  'acceptanceScope':'Current 0.4.4 regressions, GPT native workspace and Git/Worktree, local organization, restart persistence, live GPT native Node call, owned MCP Apps GUI and post-turn callback, pinned-engine subagent cancellation, live GPT children and native child detail UI; Claude deferred by user',
  'limits':['Claude development and live generation are deferred by user',
   'SSH native hooks and custom permission/Guardian profiles are not implemented; subagents require tested engine 0.160.0 and verified inherited Mac configuration',
   'Owned MCP Apps GUI and post-turn button callback passed; all third-party apps and complete event-streaming coverage remain unverified',
   'Engine workspace switching restarts the App; this is not a pair of side-by-side chat windows',
   'Official OAuth, cloud features, all third-party plugins and complete native parity are not verified',
   'Fixed local signing identity; no Developer ID notarization or verified cross-update TCC retention',
   'Full access does not replace macOS or individual plugin authorization',
   'One QA startup connected SSH without the Mac executor; a restart of the same bundle passed, but the intermittent initialization cause remains unresolved'],
  'originalBaseline':baseline,'signingRequirement':line(requirement) if installed.exists() else requirement}
 write_report(report)
 with zipfile.ZipFile(sourcezip,'x',zipfile.ZIP_DEFLATED) as z:
  for folder in ('src','scripts'):
   for p in sorted((root/folder).iterdir()):
    if p.is_file() and p.suffix in ('.cjs','.js','.py','.c','.css','.html'): z.write(p,'OpenCodex/'+folder+'/'+p.name)
  for name in ('README.md','THIRD-PARTY-AGENTBRIDGE-LICENSE'): z.write(root/name,'OpenCodex/'+name)
  for name in (*tests.keys(),f'release-{version}.json','rea-asar-integrity-summary.json','native-mcp-gui-summary.json','native-hooks-audit-20261017.md','native-empty-thread-probe.json','native-pages.json','native-official-auth-status.json'):
   z.write(root/'evidence'/name,'OpenCodex/evidence/'+name)
 with zipfile.ZipFile(sourcezip) as z: assert z.testzip() is None
 stage.mkdir()
 run(['ditto',str(source),str(stage/'OpenCodex.app')])
 (stage/'Applications').symlink_to('/Applications')
 shutil.copy2(root/'README.md',stage/'請先閱讀.md')
 shutil.copy2(sourcezip,stage/sourcezip.name)
 print('Creating versioned disk image',flush=True)
 run(['hdiutil','create','-volname',f'OpenCodex {version}','-srcfolder',str(stage),'-format','UDZO','-imagekey','zlib-level=6',str(dmg)])
 run(['hdiutil','verify',str(dmg)])
 mount.mkdir()
 run(['hdiutil','attach','-readonly','-nobrowse','-mountpoint',str(mount),str(dmg)])
 try:
  assert storage.sealed_identity(mount/'OpenCodex.app')==identity,'Mounted App identity differs'
  assert sha(mount/'OpenCodex.app/Contents/Resources/app.asar')==bundle_hash
  assert sha(mount/sourcezip.name)==sha(sourcezip)
  assert (mount/'Applications').is_symlink()
 finally: run(['hdiutil','detach',str(mount)])
 mount.rmdir()
 print('DMG verified; installing exact tested App',flush=True)
 # Check again after image creation; never replace an App started meanwhile.
 if installed.exists() and storage.process_uses(installed): raise SystemExit('Installed App was opened during packaging; verified DMG retained, installation pending.')
 backup.mkdir(parents=True)
 if installed.exists(): installed.rename(backup/'OpenCodex.app')
 try:
  run(['ditto',str(source),str(installed)])
  assert storage.sealed_identity(installed)==identity
  assert sha(installed/'Contents/Resources/app.asar')==bundle_hash
 except BaseException:
  if installed.exists(): installed.rename(backup/'failed-new-OpenCodex.app')
  if (backup/'OpenCodex.app').exists(): (backup/'OpenCodex.app').rename(installed)
  raise
 run(['shasum','-a','256','-c','evidence/'+baseline])
 artifacts=[{'name':p.name,'bytes':p.stat().st_size,'sha256':sha(p)} for p in (dmg,sourcezip)]
 (downloads/f'OpenCodex-{version}-SHA256.txt').write_text(''.join(p['sha256']+'  '+p['name']+'\n' for p in artifacts))
 report.update(phase='package verified',dmgVerified=True,installedSignatureVerified=True,originalAppsUnchanged=True,artifacts=artifacts,previousAppBackup=str(backup/'OpenCodex.app'))
 write_report(report)
 storage.remove_generated(stage,root/'build',{'OpenCodex.app','Applications','請先閱讀.md',sourcezip.name})
 report['temporaryStageRemoved']=True;write_report(report)
 print(json.dumps({'version':version,'dmgVerified':True,'installedSignatureVerified':True,'artifacts':artifacts}),flush=True)
with storage.package_lock(root/'build'): package()
