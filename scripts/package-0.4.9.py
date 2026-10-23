"""Package the exact 0.4.9 bundle exercised by GPT native acceptance."""
from pathlib import Path
import subprocess, hashlib, json, plistlib, zipfile, shutil, datetime, importlib.util
spec=importlib.util.spec_from_file_location('package_storage',Path(__file__).with_name('package-storage.py'))
storage=importlib.util.module_from_spec(spec);spec.loader.exec_module(storage)
root=Path(__file__).resolve().parent.parent
downloads=Path.home()/'Downloads'
source=root/'build/OpenCodex.app'
installed=Path('/Applications/OpenCodex.app')
version='0.4.9'
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
 for name in ('release-check-0.4.9.json','native-gpt-e2e-0.4.9.json'):
  result=json.loads((root/'evidence'/name).read_text())
  assert result['passed'] and result['version']==version and result['asarSHA256']==bundle_hash,name
  tests[name]=result
 for relative,digest in tests['release-check-0.4.9.json']['sources'].items():
  assert sha(root/relative)==digest,f'Changed since regression: {relative}'
 assert tests['native-gpt-e2e-0.4.9.json']['liveCodexTool']
 assert tests['native-gpt-e2e-0.4.9.json']['restartPersistence']
 assert tests['native-gpt-e2e-0.4.9.json']['nativeOrganization']
 assert tests['native-gpt-e2e-0.4.9.json']['nativeGitWorktree']
 assert tests['native-gpt-e2e-0.4.9.json']['nativeMcpAppFixture']
 assert tests['native-gpt-e2e-0.4.9.json']['nativeSubagents']
 assert tests['native-gpt-e2e-0.4.9.json']['nativeSubagentUi']
 assert tests['native-gpt-e2e-0.4.9.json']['connectionReadiness']
 assert tests['native-gpt-e2e-0.4.9.json']['nativeGitReview']
 assert tests['native-gpt-e2e-0.4.9.json']['nativeMessageQueue']
 mcp=json.loads((root/'evidence/native-mcp-gui-summary.json').read_text())
 assert mcp['passed'] and mcp['asarSHA256']==bundle_hash and mcp['postTurnCallback'] and mcp['postTitleComposerReady']
 assert tests['native-gpt-e2e-0.4.9.json']['nativeHooks']
 assert tests['native-gpt-e2e-0.4.9.json']['hooksFixtureRestored']
 for key in ('automaticSshStartup','customPermissionProfileLifecycle','customPermissionCancelRecovery','permissionFixtureRestored'):
  assert tests['native-gpt-e2e-0.4.9.json'][key],key
 assert tests['native-gpt-e2e-0.4.9.json']['customPermissionToolApprovalVerified'] is False
 assert tests['release-check-0.4.9.json']['asarIntegrity']['passed']
 # REA exceeded its response size limit on this bundle; do not reuse 0.4.7 evidence.
 # The release gate verifies every packed/unpacked file and block digest independently.
 engine_source=json.loads((root/'evidence/hooks-engine-source.json').read_text())
 assert sha(root/engine_source['archive'])==engine_source['sha256']
 helper_source=json.loads((root/'evidence/hooks-helper-source.json').read_text())
 assert sha(root/helper_source['archive'])==helper_source['sha256']
 permission_source=json.loads((root/'evidence/permission-engine-source.json').read_text())
 assert sha(root/permission_source['archive'])==permission_source['sha256']
 hooks=json.loads((root/'evidence/native-hooks-product-e2e.json').read_text())
 assert hooks['passed'] and hooks['asarSHA256']==bundle_hash
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
  'acceptanceScope':'Fresh-start automatic SSH connection; custom permission profile switching, actual model turn, resume, fork, pending approval cancellation and recovery; isolated real Mac sandbox probes; actual SSH GPT Hooks, Git review, message queue, workspace, Worktree, child agents, history and MCP Apps. Native custom-permission approval acceptance/tool/widget GUI flow remains unverified.',
  'limits':['Claude development and live generation are deferred by user',
   'Hooks require the OpenCodexHooks/1 patched remote engine; plugin Hooks discovery and cloud policy binding are not implemented and are rejected',
   'Custom profiles require OpenCodexPermissions/1. Native approval acceptance and subsequent custom-permission GUI tool/widget flows remain unverified because desktop automation cannot obtain the approval window; no approval was bypassed',
   'Guardian automatic approval remains unsupported; subagents require tested engine 0.160.0 and verified inherited Mac configuration',
   'REA analysis exceeded its response size limit; independent ASAR file/block integrity checks and strict codesign passed',
   'Owned MCP Apps GUI and post-turn button callback passed; all third-party apps and complete event-streaming coverage remain unverified',
   'Engine workspace switching restarts the App; this is not a pair of side-by-side chat windows',
   'Official OAuth, cloud features, all third-party plugins and complete native parity are not verified',
   'Fixed local signing identity; no Developer ID notarization or verified cross-update TCC retention',
   'Full access does not replace macOS or individual plugin authorization',
   'SSH submission requires a registered executor and matching live tool channel. Startup configuration races have bounded retries; authentication failures, changed host keys and unrelated connection failures still require user action',
   'Explicit user /shell commands retain native full-access semantics; custom model sandbox restrictions do not apply to that separate user action'],
  'originalBaseline':baseline,'signingRequirement':line(requirement) if installed.exists() else requirement}
 write_report(report)
 with zipfile.ZipFile(sourcezip,'x',zipfile.ZIP_DEFLATED) as z:
  for folder in ('src','scripts'):
   for p in sorted((root/folder).iterdir()):
    if p.is_file() and p.suffix in ('.cjs','.js','.py','.c','.css','.html','.ps1','.sh'): z.write(p,'OpenCodex/'+folder+'/'+p.name)
  for p in sorted((root/'native/hooks-helper').rglob('*')):
   if p.is_file() and (p.suffix=='.rs' or p.name in ('Cargo.toml','Cargo.lock')):
    z.write(p,'OpenCodex/'+p.relative_to(root).as_posix())
  z.write(root/engine_source['archive'],'OpenCodex/'+engine_source['archive'])
  z.write(root/helper_source['archive'],'OpenCodex/'+helper_source['archive'])
  z.write(root/permission_source['archive'],'OpenCodex/'+permission_source['archive'])
  # Include every research probe required by the same-bundle regression manifest.
  for relative in tests['release-check-0.4.9.json']['sources']:
   if relative.startswith('research/'):
    assert Path(relative).suffix=='.cjs' and '..' not in Path(relative).parts,relative
    z.write(root/relative,'OpenCodex/'+relative)
  vendor_relative='vendor/agentbridge/dist-main/agent-core-tools.js'
  z.write(root/vendor_relative,'OpenCodex/'+vendor_relative)
  z.write(root/'evidence/hooks-helper-source.json','OpenCodex/evidence/hooks-helper-source.json')
  for name in ('README.md','THIRD-PARTY-AGENTBRIDGE-LICENSE'): z.write(root/name,'OpenCodex/'+name)
  for name in (*tests.keys(),f'release-{version}.json','hooks-engine-source.json','permission-engine-source.json','windows-permissions-engine-deploy.json','windows-hooks-migration-compatibility.json','native-mcp-gui-summary.json','native-startup-live.json','native-permissions-cancel-e2e.json','startup-fixture-restored.json','native-connection-unit.json','native-connection-live.json'):
   z.write(root/'evidence'/name,'OpenCodex/evidence/'+name)
  # Keep real model events and fixture paths local; publish their evidence digest.
  hooks_summary={key:hooks[key] for key in ('version','at','completedAt','passed','asarSHA256','checks')}
  hooks_summary.update(evidenceSHA256=sha(root/'evidence/native-hooks-product-e2e.json'),
   descendantsStopped=hooks['interrupt']['descendantsStopped'])
  z.writestr('OpenCodex/evidence/native-hooks-product-summary.json',json.dumps(hooks_summary,ensure_ascii=False,indent=2)+'\n')
  # Hash exactly the published entries, without private fixture settings or raw model events.
  manifest={name:hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist()}
  z.writestr('OpenCodex/SOURCE-SHA256.json',json.dumps(manifest,indent=2)+'\n')
 with zipfile.ZipFile(sourcezip) as z:
  assert z.testzip() is None
  manifest=json.loads(z.read('OpenCodex/SOURCE-SHA256.json'))
  assert len(z.namelist())==len(set(z.namelist()))
  for name,digest in manifest.items(): assert hashlib.sha256(z.read(name)).hexdigest()==digest,name
  for relative,digest in tests['release-check-0.4.9.json']['sources'].items():
   assert manifest['OpenCodex/'+relative]==digest,relative
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
