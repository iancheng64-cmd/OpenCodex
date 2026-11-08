"""Package the 0.4.15 preview as a verified DMG in ~/Downloads. Does NOT install to /Applications."""
from pathlib import Path
import subprocess, hashlib, json, plistlib, shutil, datetime, importlib.util
spec=importlib.util.spec_from_file_location('package_storage',Path(__file__).with_name('package-storage.py'))
storage=importlib.util.module_from_spec(spec);spec.loader.exec_module(storage)
root=Path(__file__).resolve().parent.parent
downloads=Path.home()/'Downloads'
source=root/'build/OpenCodex.app'
version='0.4.15'
dmg=downloads/f'OpenCodex-{version}.dmg'
def run(args): subprocess.run(args,check=True,cwd=root)
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def package():
 if dmg.exists():raise SystemExit(f'Refusing to overwrite existing artifact: {dmg.name}')
 run(['codesign','--verify','--deep','--strict',str(source)])
 with (source/'Contents/Info.plist').open('rb') as f:info=plistlib.load(f)
 assert info['CFBundleIdentifier']=='io.opencodex.desktop',info['CFBundleIdentifier']
 assert info['OpenCodexVersion']==version,info['OpenCodexVersion']
 digest=sha(source/'Contents/Resources/app.asar')
 identity=storage.sealed_identity(source)
 if storage.process_uses(source):raise SystemExit('Close the build App before packaging.')
 stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
 stage=root/'build'/('package-stage-'+stamp)
 mount=root/'build'/('dmg-verification-'+stamp)
 stage.mkdir()
 run(['ditto',str(source),str(stage/'OpenCodex.app')])
 (stage/'Applications').symlink_to('/Applications')
 shutil.copy2(root/'README.md',stage/'請先閱讀.md')
 run(['hdiutil','create','-volname',f'OpenCodex {version} Preview','-srcfolder',str(stage),'-format','UDZO','-imagekey','zlib-level=6',str(dmg)])
 run(['hdiutil','verify',str(dmg)])
 mount.mkdir()
 run(['hdiutil','attach','-readonly','-nobrowse','-mountpoint',str(mount),str(dmg)])
 try:
  assert storage.sealed_identity(mount/'OpenCodex.app')==identity,'DMG app identity differs from source'
  assert sha(mount/'OpenCodex.app/Contents/Resources/app.asar')==digest,'DMG asar digest differs'
  assert (mount/'Applications').is_symlink(),'Applications drop-target missing'
  with (mount/'OpenCodex.app/Contents/Info.plist').open('rb') as f:minfo=plistlib.load(f)
  assert minfo['OpenCodexVersion']==version
 finally:run(['hdiutil','detach',str(mount)])
 mount.rmdir()
 artifact={'name':dmg.name,'bytes':dmg.stat().st_size,'sha256':sha(dmg)}
 (downloads/f'OpenCodex-{version}-SHA256.txt').write_text(artifact['sha256']+'  '+artifact['name']+'\n')
 report={'version':version,'channel':'preview','packagedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'asarSHA256':digest,'dmgVerified':True,'installed':False,'artifact':artifact,
  'bundleIdentifier':info['CFBundleIdentifier'],'openCodexVersion':info['OpenCodexVersion'],
  'notes':['Installation deliberately deferred: /Applications/OpenCodex.app is untouched.',
   'DMG verified by hdiutil verify and by attaching read-only and re-checking the sealed identity and asar digest.']}
 text=json.dumps(report,ensure_ascii=False,indent=2)+'\n'
 (downloads/f'OpenCodex-{version}-verification.json').write_text(text)
 (root/f'evidence/package-dmg-{version}.json').write_text(text)
 storage.remove_generated(stage,root/'build',{'OpenCodex.app','Applications','請先閱讀.md'})
 print(json.dumps({'version':version,'dmgVerified':True,'installed':False,'artifact':artifact},ensure_ascii=False),flush=True)
with storage.package_lock(root/'build'):package()
