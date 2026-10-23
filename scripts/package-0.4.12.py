"""Package a documented preview without misreporting missing legacy acceptance."""
from pathlib import Path
import subprocess, hashlib, json, plistlib, zipfile, shutil, datetime, importlib.util
spec=importlib.util.spec_from_file_location('package_storage',Path(__file__).with_name('package-storage.py'))
storage=importlib.util.module_from_spec(spec);spec.loader.exec_module(storage)
root=Path(__file__).resolve().parent.parent
downloads=Path.home()/'Downloads'
source=root/'build/OpenCodex.app'
installed=Path('/Applications/OpenCodex.app')
version='0.4.12'
dmg=downloads/f'OpenCodex-{version}.dmg'
sourcezip=downloads/f'OpenCodex-{version}-source.zip'
def run(args): subprocess.run(args,check=True,cwd=root)
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def save(report):
 text=json.dumps(report,ensure_ascii=False,indent=2)+'\n'
 (root/f'evidence/release-{version}.json').write_text(text)
 (downloads/f'OpenCodex-{version}-verification.json').write_text(text)
def package():
 for p in (dmg,sourcezip):
  if p.exists():raise SystemExit(f'Refusing to overwrite release artifact: {p.name}')
 run(['codesign','--verify','--deep','--strict',str(source)])
 with (source/'Contents/Info.plist').open('rb') as f:info=plistlib.load(f)
 assert info['CFBundleIdentifier']=='io.opencodex.desktop' and info['OpenCodexVersion']==version
 digest=sha(source/'Contents/Resources/app.asar')
 regression=json.loads((root/f'evidence/release-check-{version}.json').read_text())
 assert regression['version']==version and regression['asarSHA256']==digest
 assert regression['passed'] is False and regression['asarIntegrity']['passed']
 expected={(f'research/{n}-probe.cjs',None) for n in (
  'native-permission-catalog','native-permissions-tools','native-permissions-input',
  'native-permissions-service','native-permissions-runtime','native-permissions-mcp',
  'native-permissions-hooks','native-permissions-dispatch')}
 expected.update({('research/native-guardian-probe.cjs',s) for s in ('root','children','review')})
 missing=[t for t in regression['tests'] if not t['passed']]
 assert len(missing)==11 and all(t.get('notRun') for t in missing)
 assert {(t['script'],t.get('scenario')) for t in missing}==expected
 assert len(regression['tests'])==70 and sum(t['passed'] for t in regression['tests'])==59
 assert regression['error']=='Full release acceptance incomplete: required legacy probes are missing.'
 for relative,hash_value in regression['sources'].items():assert sha(root/relative)==hash_value,relative
 reports={}
 for name in ('unified-providers-live','unified-providers-ui'):
  r=json.loads((root/f'evidence/{name}.json').read_text())
  assert r['passed'] and r['version']==version and r['asarSHA256']==digest,name
  assert all(r['checks'].values()),name
  reports[name]={k:r[k] for k in ('version','at','passed','asarSHA256','checks')}
  reports[name]['evidenceSHA256']=sha(root/f'evidence/{name}.json')
 agpath=root/f'evidence/antigravity-live-{version}.json'
 ag=json.loads(agpath.read_text())
 assert ag['passed'] and ag['version']==version and ag['asarSHA256']==digest
 assert ag['status']=='completed' and ag['error'] is None and ag['modelCount']>0
 reports['antigravity-live']={k:ag[k] for k in ('version','at','passed','asarSHA256','model','modelCount','status')}
 reports['antigravity-live']['evidenceSHA256']=sha(agpath)
 if storage.process_uses(source):raise SystemExit('Close development App before packaging.')
 if installed.exists() and storage.process_uses(installed):raise SystemExit('Close installed App before packaging.')
 identity=storage.sealed_identity(source)
 requirement=lambda app: next(s for s in subprocess.check_output(['codesign','-d','-r-',str(app)],stderr=subprocess.STDOUT,text=True).splitlines() if s.startswith('designated =>'))
 if installed.exists():assert requirement(source)==requirement(installed),'Signing identity changed'
 archives=sorted((root/'build').glob('opencodex-*-source.tar.gz'))
 assert len(archives)==5,'Expected five retained engine/helper source archives'
 archive_manifest={p.name:{'sha256':sha(p),'bytes':p.stat().st_size} for p in archives}
 report={'version':version,'channel':'preview','packagedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'phase':'acceptance recorded','asarSHA256':digest,'fullRegressionPassed':False,'nativeParityComplete':False,
  'availableChecksPassed':59,'missingLegacyChecks':missing,'acceptance':reports,
  'regressionEvidenceSHA256':sha(root/f'evidence/release-check-{version}.json'),
  'sources':regression['sources'],'sourceArchives':archive_manifest,
  'limits':['Eleven legacy permission/Guardian checks are missing; full release-check remains failed.',
   'Claude live generation remains unverified because SSH cannot access its existing macOS credential. Antigravity generation passed; structured per-model quota percentages remain unverified.',
   'Grok CLI subscription quota is unavailable; no values are estimated.',
   'Preserved native binaries are signature-verified, not rebuilt from source for this preview. Historical source-to-binary provenance and original-app baseline records are missing.',
   'No Apple Developer ID notarization, complete ChatGPT parity, or complete third-party service acceptance is claimed.']}
 with zipfile.ZipFile(sourcezip,'x',zipfile.ZIP_DEFLATED,strict_timestamps=False) as z:
  for folder in ('src','scripts'):
   for p in sorted((root/folder).iterdir()):
    if p.is_file() and p.suffix in ('.cjs','.js','.py','.c','.css','.html','.ps1','.sh'):
     z.write(p,'OpenCodex/'+folder+'/'+p.name)
  for p in sorted((root/'native/hooks-helper').rglob('*')):
   if p.is_file() and (p.suffix=='.rs' or p.name in ('Cargo.toml','Cargo.lock')):
    z.write(p,'OpenCodex/'+p.relative_to(root).as_posix())
  for p in archives:z.write(p,'OpenCodex/build/'+p.name)
  for name in ('README.md','CHANGELOG.md','THIRD-PARTY-AGENTBRIDGE-LICENSE','.gitignore'):
   z.write(root/name,'OpenCodex/'+name)
  for relative in ('vendor/agentbridge/dist-main/agent-core-tools.js','research/codex-0.160.0/LICENSE'):
   z.write(root/relative,'OpenCodex/'+relative)
  # Never include raw model events, settings, private OAuth state, or QA endpoints.
  z.writestr('OpenCodex/evidence/preview-acceptance.json',json.dumps(report,ensure_ascii=False,indent=2)+'\n')
  manifest={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}
  z.writestr('OpenCodex/SOURCE-SHA256.json',json.dumps(manifest,indent=2)+'\n')
 with zipfile.ZipFile(sourcezip) as z:
  assert z.testzip() is None and len(z.namelist())==len(set(z.namelist()))
  for name,value in manifest.items():assert hashlib.sha256(z.read(name)).hexdigest()==value
  for relative,value in regression['sources'].items():assert manifest['OpenCodex/'+relative]==value,relative
 stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
 stage=root/'build'/('package-stage-'+stamp)
 mount=root/'build'/('dmg-verification-'+stamp)
 backup=root/'build/releases'/('before-'+version+'-'+stamp)
 stage.mkdir()
 run(['ditto',str(source),str(stage/'OpenCodex.app')])
 (stage/'Applications').symlink_to('/Applications')
 shutil.copy2(root/'README.md',stage/'請先閱讀.md')
 shutil.copy2(sourcezip,stage/sourcezip.name)
 run(['hdiutil','create','-volname',f'OpenCodex {version} Preview','-srcfolder',str(stage),'-format','UDZO','-imagekey','zlib-level=6',str(dmg)])
 run(['hdiutil','verify',str(dmg)])
 mount.mkdir()
 run(['hdiutil','attach','-readonly','-nobrowse','-mountpoint',str(mount),str(dmg)])
 try:
  assert storage.sealed_identity(mount/'OpenCodex.app')==identity
  assert sha(mount/'OpenCodex.app/Contents/Resources/app.asar')==digest
  assert sha(mount/sourcezip.name)==sha(sourcezip)
  assert (mount/'Applications').is_symlink()
 finally:run(['hdiutil','detach',str(mount)])
 mount.rmdir()
 if installed.exists() and storage.process_uses(installed):raise SystemExit('App opened during packaging; installation pending.')
 backup.mkdir(parents=True)
 if installed.exists():installed.rename(backup/'OpenCodex.app')
 try:
  run(['ditto',str(source),str(installed)])
  assert storage.sealed_identity(installed)==identity
  assert sha(installed/'Contents/Resources/app.asar')==digest
 except BaseException:
  if installed.exists():installed.rename(backup/'failed-new-OpenCodex.app')
  if (backup/'OpenCodex.app').exists():(backup/'OpenCodex.app').rename(installed)
  raise
 # Backup path is local operational state, excluded from public verification.
 (root/f'evidence/package-local-{version}.json').write_text(json.dumps({'backup':str(backup),'identity':identity})+'\n')
 artifacts=[{'name':p.name,'bytes':p.stat().st_size,'sha256':sha(p)} for p in (dmg,sourcezip)]
 (downloads/f'OpenCodex-{version}-SHA256.txt').write_text(''.join(p['sha256']+'  '+p['name']+'\n' for p in artifacts))
 report.update(phase='preview package verified',dmgVerified=True,installedSignatureVerified=True,artifacts=artifacts)
 storage.remove_generated(stage,root/'build',{'OpenCodex.app','Applications','請先閱讀.md',sourcezip.name})
 report['temporaryStageRemoved']=True
 save(report)
 print(json.dumps({'version':version,'dmgVerified':True,'installedSignatureVerified':True,'artifacts':artifacts}),flush=True)
with storage.package_lock(root/'build'):package()
