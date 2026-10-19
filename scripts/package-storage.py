"""Task-owned package transactions; cleanup only exact, verified generated paths."""
from pathlib import Path
import contextlib, fcntl, hashlib, os, shutil, subprocess

@contextlib.contextmanager
def package_lock(build):
 build.mkdir(exist_ok=True)
 with (build/'.package.lock').open('a') as stream:
  fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
  yield

def sealed_identity(app):
 subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True,capture_output=True)
 names=['Contents/Info.plist','Contents/_CodeSignature/CodeResources','Contents/MacOS/ChatGPT','Contents/MacOS/OpenCodex']
 result=[]
 for name in names:
  with (app/name).open('rb') as stream: result.append(hashlib.file_digest(stream,'sha256').hexdigest())
 return tuple(result)

def remove_generated(path,parent,expected_children):
 path,parent=Path(path),Path(parent)
 if path.is_symlink() or not path.is_dir() or path.parent!=parent or parent.resolve()!=parent:
  raise ValueError('Cleanup requires a generated directory directly under the specified root')
 if {p.name for p in path.iterdir()}!=set(expected_children):
  raise ValueError('Generated directory contains unexpected files; preserve for review')
 for base,dirs,files in os.walk(path,followlinks=False):
  if os.path.ismount(base): raise ValueError('Refusing to remove a mounted directory')
  for name in dirs:
   child=Path(base)/name
   if not child.is_symlink() and os.path.ismount(child):raise ValueError('Refusing mounted child')
 # Symlinks inside generated App bundles are removed as links, never followed.
 shutil.rmtree(path)
 if path.exists():raise RuntimeError('Generated directory still exists')

def process_uses(app):
 result=subprocess.run(['lsof','-nP','-Fpn'],check=True,capture_output=True,text=True)
 if result.stderr.strip():raise RuntimeError('Cannot verify active App files: lsof reported warnings')
 prefix=str(app)+'/'
 return any(line.startswith('n'+prefix) for line in result.stdout.splitlines())
