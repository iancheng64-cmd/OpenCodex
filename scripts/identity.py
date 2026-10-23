from pathlib import Path
import plistlib,subprocess,hashlib,json
root=Path(__file__).resolve().parent.parent
app=root/'build/OpenCodex.app'
p=app/'Contents/Info.plist'
d=plistlib.load(p.open('rb'))
d.update(CFBundleExecutable='OpenCodex',CFBundleName='OpenCodex',CFBundleDisplayName='OpenCodex',CFBundleIdentifier='io.opencodex.desktop',CFBundleShortVersionString='26.1007.71326',CFBundleVersion='20398',OpenCodexVersion='0.4.12',CFBundleAlternateNames=['OpenCodex'],CrProductDirName='io.opencodex.desktop',CFBundleURLTypes=[{'CFBundleURLName':'OpenCodex','CFBundleURLSchemes':['opencodex']}])
d['ElectronAsarIntegrity']={'Resources/app.asar':{'algorithm':'SHA256','hash':(root/'build/asar-hash.txt').read_text().strip()}}
for key in list(d):
 if key.startswith('SU') or key in ['CFBundleDocumentTypes','UTExportedTypeDeclarations','UTImportedTypeDeclarations','LSHasLocalizedDisplayName']:
  d.pop(key,None)
plistlib.dump(d,p.open('wb'))
for p in (app/'Contents/Frameworks').glob('**/Info.plist'):
 d=plistlib.load(p.open('rb'))
 if 'com.openai.codex' in d.get('CFBundleIdentifier',''):
  d['CFBundleIdentifier']=d['CFBundleIdentifier'].replace('com.openai.codex','io.opencodex.desktop')
  d['CFBundleDisplayName']=d.get('CFBundleDisplayName','OpenCodex').replace('ChatGPT','OpenCodex').replace('Codex Helper','OpenCodex Helper')
  plistlib.dump(d,p.open('wb'))
# Prevent localized bundle metadata from overriding the independent name.
for p in (app/'Contents/Resources').glob('*.lproj/InfoPlist.strings'):
 try:
  d=plistlib.load(p.open('rb'))
  for k in ['CFBundleName','CFBundleDisplayName']:d[k]='OpenCodex'
  plistlib.dump(d,p.open('wb'))
 except Exception:
  text=p.read_text(encoding='utf-16' if p.read_bytes().startswith((b'\xff\xfe',b'\xfe\xff')) else 'utf-8')
  p.write_text(text.replace('ChatGPT','OpenCodex').replace('"Codex"','"OpenCodex"'))
ent={'com.apple.security.cs.allow-jit':True,'com.apple.security.cs.allow-unsigned-executable-memory':True,'com.apple.security.cs.disable-library-validation':True}
plistlib.dump(ent,(root/'build/entitlements.plist').open('wb'))
# Electron 44+ pins the integrity dictionary in the framework at package time.
framework=app/'Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Codex Framework'
b=bytearray(framework.read_bytes());sentinel=b'AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A';offset=b.find(sentinel)
if offset<0: raise RuntimeError('ASAR integrity digest slot missing')
assert b[offset+32:offset+34]==bytes([1,1])
digest=hashlib.sha256(('Resources/app.asar'+'SHA256'+(root/'build/asar-hash.txt').read_text().strip()).encode()).digest()
b[offset+34:offset+66]=digest;framework.write_bytes(b)
subprocess.run(['clang','-O2','-x','objective-c','-framework','Foundation',str(root/'src/launcher.c'),'-o',str(app/'Contents/MacOS/OpenCodex')],check=True)
import importlib.util
spec=importlib.util.spec_from_file_location('stable_signing',root/'scripts/stable-signing.py')
signing=importlib.util.module_from_spec(spec);spec.loader.exec_module(signing)
subprocess.run(['clang','-O2','-Wno-deprecated-declarations','-framework','Security',str(root/'src/credential-migrate.c'),'-o',str(app/'Contents/Resources/opencodex-credential-migrate')],check=True)
signing.sign(app/'Contents/Resources/opencodex-credential-migrate',deep=False)
signing.sign(app/'Contents/Resources/opencodex-hooks-helper',deep=False)
signing.sign(app/'Contents/Resources/opencodex-permission-engine',deep=False)
signing.sign(app,root/'build/entitlements.plist')
# The deep pass changes unpacked native modules. Hash their final signed bytes,
# then sign only the framework and outer bundle so those bytes remain sealed.
asar=app/'Contents/Resources/app.asar'
sealed=json.loads(subprocess.check_output(['node',str(root/'scripts/asar-integrity.cjs'),'seal',str(asar)],text=True))
header=sealed['headerSHA256']
(root/'build/asar-hash.txt').write_text(header)
p=app/'Contents/Info.plist'
d=plistlib.load(p.open('rb'))
d['ElectronAsarIntegrity']['Resources/app.asar']['hash']=header
plistlib.dump(d,p.open('wb'))
b=bytearray(framework.read_bytes())
b[offset+34:offset+66]=hashlib.sha256(('Resources/app.asar'+'SHA256'+header).encode()).digest()
framework.write_bytes(b)
signing.sign(app/'Contents/Frameworks/Codex Framework.framework',deep=False)
signing.sign(app,root/'build/entitlements.plist',deep=False)
verified=json.loads(subprocess.check_output(['node',str(root/'scripts/asar-integrity.cjs'),'verify',str(asar)],text=True))
(root/'evidence/asar-integrity.json').write_text(json.dumps({**verified,'headerSHA256':header,'asarSHA256':hashlib.sha256(asar.read_bytes()).hexdigest()},indent=2)+'\n')
print('OpenCodex independent bundle, signature and every ASAR entry verified')
