"""Package the 0.4.16 preview source archive in ~/Downloads (same composition as earlier previews).

Contents: OpenCodex-owned sources (src, scripts), the hooks helper Rust sources, the five retained
engine/helper source archives, docs and licences, the AgentBridge core tools file, and this
release's evidence JSON. Never includes settings, credentials, raw model events or QA endpoints.
"""
from pathlib import Path
import hashlib, json, zipfile
root=Path(__file__).resolve().parent.parent
version='0.4.16'
downloads=Path.home()/'Downloads'
sourcezip=downloads/f'OpenCodex-{version}-source.zip'
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
if sourcezip.exists():raise SystemExit(f'Refusing to overwrite existing artifact: {sourcezip.name}')
archives=sorted(p for p in (root/'build').glob('*.tar.gz') if p.name.startswith(('opencodex-engine-','opencodex-hooks-helper-')))
assert len(archives)==5,f'Expected five retained engine/helper source archives, found {[p.name for p in archives]}'
evidence=[root/'evidence'/f'{name}.json' for name in ('cross-host-e2e','queue-ui-e2e','parallel-sessions-e2e','standalone-flow-e2e','offline-history-e2e',f'install-{version}',f'package-dmg-{version}')]
with zipfile.ZipFile(sourcezip,'x',zipfile.ZIP_DEFLATED,strict_timestamps=False) as z:
 for folder in ('src','scripts'):
  for p in sorted((root/folder).iterdir()):
   if p.is_file() and p.suffix in ('.cjs','.js','.py','.c','.css','.html','.ps1','.sh'):
    z.write(p,'OpenCodex/'+folder+'/'+p.name)
 for p in sorted((root/'native/hooks-helper').rglob('*')) if (root/'native/hooks-helper').exists() else []:
  if p.is_file() and (p.suffix=='.rs' or p.name in ('Cargo.toml','Cargo.lock')):
   z.write(p,'OpenCodex/'+p.relative_to(root).as_posix())
 for p in archives:z.write(p,'OpenCodex/build/'+p.name)
 for name in ('README.md','CHANGELOG.md','THIRD-PARTY-AGENTBRIDGE-LICENSE','.gitignore'):
  if (root/name).exists():z.write(root/name,'OpenCodex/'+name)
 for relative in ('vendor/agentbridge/dist-main/agent-core-tools.js','research/codex-0.160.0/LICENSE'):
  if (root/relative).exists():z.write(root/relative,'OpenCodex/'+relative)
 for p in evidence:
  if p.exists():z.write(p,'OpenCodex/evidence/'+p.name)
 manifest={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}
 z.writestr('OpenCodex/SOURCE-SHA256.json',json.dumps(manifest,indent=2)+'\n')
with zipfile.ZipFile(sourcezip) as z:
 assert z.testzip() is None and len(z.namelist())==len(set(z.namelist()))
 names=z.namelist()
 for name,value in manifest.items():assert hashlib.sha256(z.read(name)).hexdigest()==value
 # Guard: nothing that smells like a credential or private state.
 banned=('profiles.json','opencodex.json','adapter-events.jsonl','test-endpoint.json','.env','id_ed25519','id_rsa')
 assert not any(Path(n).name in banned for n in names),'private file in archive'
print(json.dumps({'name':sourcezip.name,'bytes':sourcezip.stat().st_size,'sha256':sha(sourcezip),'files':len(names)}))
