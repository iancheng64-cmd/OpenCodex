"""Explicit task-artifact cleanup; keeps current apps, source and deliverables."""
from pathlib import Path
import argparse, datetime, hashlib, json, os, plistlib, shutil, subprocess
ROOT=Path(__file__).resolve().parent.parent
DOWNLOADS=Path.home()/'Downloads'
CANDIDATES=[
 ROOT/'build/releases/before-0.2.0-20261014-075520',
 ROOT/'build/releases/before-0.3.0-20261015-144708',
 ROOT/'build/releases/before-0.4.1-20261015-205507',
 ROOT/'build/OpenCodex-v02-20261015-070146.app',
 ROOT/'build/package-staging',
 DOWNLOADS/'OpenCodex-previous-20261014-075520',
 DOWNLOADS/'OpenCodex-previous-20261015-144708',
 DOWNLOADS/'OpenCodex-previous-20261015-205507',
]
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def run(args): return subprocess.run(args,check=True,capture_output=True)
def sha(p):
 with p.open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()
def free(): return shutil.disk_usage(ROOT).free
def snapshot(p):
 assert p in CANDIDATES and p.is_dir() and not p.is_symlink(),str(p)
 assert p.resolve()==p,str(p)
 h=hashlib.sha256();logical=0;allocated=0;count=0
 device=p.stat().st_dev
 paths=[p]
 for base,ds,fs in os.walk(p,followlinks=False):
  paths.extend(Path(base)/name for name in ds+fs)
 for q in sorted(paths):
  s=q.lstat()
  assert s.st_dev==device and not os.path.ismount(q),str(q)
  h.update(json.dumps([str(q.relative_to(p)),s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns]).encode())
  logical+=s.st_size;allocated+=s.st_blocks*512;count+=1
 return {'path':str(p),'entries':count,'logicalBytes':logical,'allocatedBytes':allocated,'treeStatSha256':h.hexdigest()}
def verify_preserved():
 run(['shasum','-a','256','-c',str(ROOT/'evidence/original-apps-20261015.sha256')])
 expected={}
 for line in (DOWNLOADS/'OpenCodex-SHA256.txt').read_text().splitlines():
  digest,name=line.split(None,1);p=DOWNLOADS/name.strip()
  assert p.name in ('OpenCodex.dmg','OpenCodex-source.zip')
  assert sha(p)==digest,p
  expected[str(p)]=digest
 for p in (Path('/Applications/OpenCodex.app'),ROOT/'build/OpenCodex.app'):
  run(['codesign','--verify','--deep','--strict',str(p)])
  with (p/'Contents/Info.plist').open('rb') as f: info=plistlib.load(f)
  assert info['OpenCodexVersion']=='0.4.1'
  expected[str(p/'Contents/Resources/app.asar')]=sha(p/'Contents/Resources/app.asar')
 assert len(set(v for k,v in expected.items() if k.endswith('app.asar')))==1
 assert (ROOT/'src/bridge-adapter.cjs').is_file()
 return expected
def ensure_idle(paths):
 info=plistlib.loads(run(['hdiutil','info','-plist']).stdout)
 mounts=[]
 for img in info.get('images',[]):
  mounts.extend([img.get('image-path','')])
  mounts.extend(e.get('mount-point','') for e in img.get('system-entities',[]))
 for value in mounts:
  if value: assert not any(value==str(p) or value.startswith(str(p)+'/') for p in paths),'Mounted candidate'
 result=run(['lsof','-nP','-Fpn'])
 if result.stderr.strip(): raise RuntimeError('Open-file inspection reported warnings; review before cleanup')
 active=[]
 for line in result.stdout.decode(errors='replace').splitlines():
  if line.startswith('n'):
   name=line[1:]
   if any(name==str(p) or name.startswith(str(p)+'/') for p in paths):active.append(name)
 assert not active,'Candidate contains open files: '+repr(active[:5])
def write(path,data): path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
args=argparse.ArgumentParser();args.add_argument('--apply',type=Path);a=args.parse_args()
if not a.apply:
 preserved=verify_preserved()
 existing=[p for p in CANDIDATES if p.exists()]
 ensure_idle(existing)
 plan={'createdAt':now(),'status':'planned','authorizedScope':'OpenCodex task-created obsolete builds and packages only','preserved':preserved,'freeBytesBeforePlan':free(),'candidates':[snapshot(p) for p in existing]}
 path=ROOT/'evidence'/('cleanup-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.json')
 assert not path.exists()
 write(path,plan)
 print(json.dumps({'plan':str(path),'allocatedBytes':sum(x['allocatedBytes'] for x in plan['candidates']),'candidates':plan['candidates']}))
else:
 path=a.apply.resolve()
 assert path.parent==ROOT/'evidence' and path.name.startswith('cleanup-') and path.suffix=='.json'
 plan=json.loads(path.read_text());assert plan['status']=='planned'
 assert verify_preserved()==plan['preserved']
 paths=[Path(x['path']) for x in plan['candidates']]
 assert all(p in CANDIDATES for p in paths) and len(set(paths))==len(paths)
 ensure_idle(paths)
 for item,p in zip(plan['candidates'],paths):assert snapshot(p)==item,'Changed since plan: '+str(p)
 plan.update(status='running',startedAt=now(),freeBytesBeforeDelete=free(),results=[])
 write(path,plan)
 try:
  for item,p in zip(plan['candidates'],paths):
   assert snapshot(p)==item,'Changed during cleanup: '+str(p)
   shutil.rmtree(p)
   assert not p.exists()
   plan['results'].append({'path':str(p),'removedAt':now(),'allocatedBytes':item['allocatedBytes']})
   write(path,plan)
  assert verify_preserved()==plan['preserved']
  plan.update(status='verified',finishedAt=now(),freeBytesAfterDelete=free(),preservedVerified=True)
  plan['immediateFreeBytesIncrease']=plan['freeBytesAfterDelete']-plan['freeBytesBeforeDelete']
  write(path,plan)
 except BaseException as exc:
  plan.update(status='incomplete',error=str(exc),freeBytesAfterDelete=free());write(path,plan);raise
 print(json.dumps({k:v for k,v in plan.items() if k not in ('preserved','candidates')},ensure_ascii=False))
