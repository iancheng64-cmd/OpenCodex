"""Build a narrowly scoped SSH startup fix from the installed, signed 0.4.8 baseline."""
from pathlib import Path
import subprocess, json, plistlib, hashlib, importlib.util
ROOT=Path(__file__).resolve().parent.parent
BASE=Path('/Applications/OpenCodex.app')
APP=ROOT/'build/startup-hotfix/OpenCodex.app'
VERSION='0.4.8.1'
def run(args,**kw): return subprocess.run(args,check=True,cwd=ROOT,**kw)
def sha(p): return hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
def requirement(p):
 text=subprocess.check_output(['codesign','-d','-r-',str(p)],stderr=subprocess.STDOUT,text=True)
 return next(x for x in text.splitlines() if x.startswith('designated =>'))
assert not APP.exists(),'Preserve an existing hotfix build; inspect before rebuilding'
run(['codesign','--verify','--deep','--strict',str(BASE)])
info=plistlib.loads((BASE/'Contents/Info.plist').read_bytes())
assert info['OpenCodexVersion']=='0.4.8' and info['CFBundleIdentifier']=='io.opencodex.desktop'
baseline=sha(BASE/'Contents/Resources/app.asar')
APP.parent.mkdir(parents=True,exist_ok=True)
run(['ditto',str(BASE),str(APP)])
script="""
const fs=require('fs'),assert=require('assert/strict');
const {archive}=require('./scripts/asar-reader.cjs'),{patchAsar}=require('./scripts/patch-asar.cjs'),{patchStartup}=require('./scripts/startup-patches.cjs');
const base='/Applications/OpenCodex.app/Contents/Resources/app.asar',file='build/startup-hotfix/OpenCodex.app/Contents/Resources/app.asar';
const a=archive(file),pkg=JSON.parse(a.read('package.json'));assert.equal(pkg.openCodexVersion,'0.4.8');pkg.openCodexVersion='0.4.8.1';
const changes={'package.json':JSON.stringify(pkg),'opencodex/bootstrap.cjs':patchStartup(a.read('opencodex/bootstrap.cjs').toString())};a.close();
const header=patchAsar(file,changes),old=archive(base),next=archive(file),changed=[];
assert.deepEqual(Object.keys(next.entries),Object.keys(old.entries));
for(const name of Object.keys(old.entries))if(!old.read(name).equals(next.read(name)))changed.push(name);
old.close();next.close();assert.deepEqual(changed.sort(),Object.keys(changes).sort());
fs.writeFileSync('build/startup-hotfix/patch.json',JSON.stringify({header,changed},null,2));
console.log(JSON.stringify({changed}));
"""
run(['node','-e',script])
patch=json.loads((APP.parent/'patch.json').read_text())
info['OpenCodexVersion']=VERSION
info['ElectronAsarIntegrity']={'Resources/app.asar':{'algorithm':'SHA256','hash':patch['header']}}
(APP/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
framework=APP/'Contents/Frameworks/Codex Framework.framework'
binary=framework/'Versions/155.0.8059.40/Codex Framework'
data=bytearray(binary.read_bytes());sentinel=b'AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A';offset=data.find(sentinel)
assert offset>=0 and data.count(sentinel)==1 and data[offset+32:offset+34]==bytes([1,1])
data[offset+34:offset+66]=hashlib.sha256(('Resources/app.asarSHA256'+patch['header']).encode()).digest()
binary.write_bytes(data)
spec=importlib.util.spec_from_file_location('signing',ROOT/'scripts/stable-signing.py')
signing=importlib.util.module_from_spec(spec);spec.loader.exec_module(signing)
# Preserve signed unpacked binaries; only the integrity anchor and outer resource seal change.
signing.sign(framework,deep=False)
entitlements=APP.parent/'entitlements.plist'
entitlements.write_bytes(plistlib.dumps({'com.apple.security.cs.allow-jit':True,'com.apple.security.cs.allow-unsigned-executable-memory':True,'com.apple.security.cs.disable-library-validation':True}))
signing.sign(APP,entitlements,deep=False)
assert requirement(BASE)==requirement(APP),'Persistent signing identity changed'
integrity=json.loads(subprocess.check_output(['node','scripts/asar-integrity.cjs','verify',str(APP/'Contents/Resources/app.asar')],cwd=ROOT,text=True))
assert integrity['passed']
assert sha(BASE/'Contents/Resources/app.asar')==baseline
run(['node','scripts/native-startup-test.cjs',str(APP/'Contents/Resources/app.asar')])
report={'version':VERSION,'baselineVersion':'0.4.8','baselineAsarSHA256':baseline,'asarSHA256':sha(APP/'Contents/Resources/app.asar'),'changedArchiveEntries':patch['changed'],'asarIntegrity':integrity,'fixedSigningIdentity':True,'passed':True}
(ROOT/'evidence/startup-hotfix-build.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report),flush=True)
