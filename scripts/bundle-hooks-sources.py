"""Preserve build inputs for the remote engine and native Hooks helper."""
from pathlib import Path
import datetime, gzip, hashlib, json, tarfile, shutil, os, uuid
root = Path(__file__).resolve().parent.parent
EXCLUDED = {'.git', 'target', 'node_modules', '__pycache__', '.DS_Store', '.venv', '.ruff_cache', '.pytest_cache'}
def source_files(source):
    files = []
    for directory, directories, names in os.walk(source):
        directories[:] = sorted(name for name in directories if name not in EXCLUDED)
        files.extend(Path(directory) / name for name in names
                     if name not in EXCLUDED and not name.endswith('.snap.new')
                     and (Path(directory) / name).relative_to(source).as_posix() != 'codex-rs/cloud-tasks/error.log')
    return sorted(files)
def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()
def bundle(source, archive, prefix):
    destination = root / archive
    if destination.exists():
        raise RuntimeError(f'Refusing to replace source archive: {destination}')
    files = source_files(source)
    for p in files:
        if p.is_symlink() and (not p.resolve().is_relative_to(source.resolve()) or not p.resolve().is_file()):
            raise RuntimeError(f'Source symlink leaves the source tree or is not a file: {p}')
    temporary = destination.with_name(destination.name + '.partial-' + uuid.uuid4().hex)
    manifest = {}
    with temporary.open('xb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as gz, tarfile.open(fileobj=gz, mode='w', dereference=True) as tar:
        for p in files:
            name = prefix + '/' + p.relative_to(source).as_posix()
            manifest[name] = sha(p)
            info = tar.gettarinfo(str(p), arcname=name)
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mtime = 0
            with p.open('rb') as f:
                tar.addfile(info, f)
    with tarfile.open(temporary) as tar:
        actual = {}
        for entry in tar:
            assert entry.isfile(), entry.name
            actual[entry.name] = hashlib.sha256(tar.extractfile(entry).read()).hexdigest()
        assert actual == manifest
    # Publish only a completely verified archive, without replacing a release.
    os.link(temporary, destination)
    temporary.unlink()
    return {'archive': archive, 'sha256': sha(destination), 'bytes': destination.stat().st_size,
            'source': source.relative_to(root).as_posix(), 'prefix': prefix, 'files': len(manifest),
            'manifestSHA256': hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest(),
            'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
if __name__ == '__main__':
    engine_report = root / 'evidence/hooks-engine-source.json'
    old = json.loads(engine_report.read_text())
    engine_source = root / 'research/codex-0.160.0'
    for relative, digest in old['modified'].items():
        assert sha(engine_source / relative) == digest, relative
    backup = root / 'evidence/hooks-engine-source-before-recovery-20261019.json'
    if not backup.exists():
        shutil.copy2(engine_report, backup)
    engine = bundle(engine_source, old['archive'], 'codex-rust-v0.160.0')
    engine['modified'] = old['modified']
    engine['previousArchiveSHA256'] = old['sha256']
    engine_report.write_text(json.dumps(engine, indent=2) + '\n')
    helper = bundle(root / 'research/codex-0.162.0-alpha.17.2',
                    'build/opencodex-hooks-helper-upstream-source.tar.gz',
                    'research/codex-0.162.0-alpha.17.2')
    (root / 'evidence/hooks-helper-source.json').write_text(json.dumps(helper, indent=2) + '\n')
    print(json.dumps({'engine': engine, 'helper': helper}, indent=2))
