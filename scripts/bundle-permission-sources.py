"""Archive the permission engine source without replacing earlier releases."""
from pathlib import Path
import importlib.util
import json
import hashlib
import tarfile
import sys

root = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    'source_bundle', Path(__file__).with_name('bundle-hooks-sources.py'))
source_bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source_bundle)
source = root / 'research/codex-0.160.0'
build = json.loads((root / 'evidence/permission-engine-bundle.json').read_text())
assert source_bundle.sha(source / 'codex-rs/Cargo.lock') == build['cargoLockSHA256']
helper = json.loads((root / 'evidence/hooks-helper-source.json').read_text())
assert source_bundle.sha(root / helper['archive']) == helper['sha256']
# The upstream checkout was extracted from an archive, not cloned. Compare to
# the verified prior source archive instead of mistaking the parent app's Git
# repository for the engine's revision.
previous = json.loads((root / 'evidence/hooks-engine-source.json').read_text())
assert source_bundle.sha(root / previous['archive']) == previous['sha256']
old = {}
with tarfile.open(root / previous['archive']) as archive:
    for entry in archive:
        assert entry.isfile() and entry.name.startswith(previous['prefix'] + '/')
        relative = entry.name[len(previous['prefix']) + 1:]
        old[relative] = hashlib.sha256(archive.extractfile(entry).read()).hexdigest()
current = {p.relative_to(source).as_posix(): source_bundle.sha(p)
           for p in source_bundle.source_files(source)}
modified = {name: current.get(name) for name in sorted(old.keys() | current.keys())
            if old.get(name) != current.get(name)}
report = source_bundle.bundle(
    source, 'build/opencodex-engine-0.160.0-latency1-source.tar.gz',
    'research/codex-0.160.0')
report.update(previousSourceArchiveSHA256=previous['sha256'], modified=modified,
              cargoLockSHA256=build['cargoLockSHA256'],
              helperSourceSHA256=helper['sha256'])
(root / 'evidence/permission-engine-source.json').write_text(
    json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
