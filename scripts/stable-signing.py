"""Persistent local signing identity. Keys remain in the user's login keychain."""
from pathlib import Path
import argparse, hashlib, json, os, re, subprocess, tempfile

ROOT = Path(__file__).resolve().parent.parent
STATE = Path.home() / 'Library/Application Support/OpenCodex-signing'
CONFIG = STATE / 'identity.json'

def run(args, **kw):
    result = subprocess.run(args, capture_output=True, **kw)
    if result.returncode:
        detail = result.stderr.decode(errors='replace') if isinstance(result.stderr, bytes) else result.stderr
        raise RuntimeError(Path(args[0]).name + ' failed: ' + detail.strip())
    return result

def identity():
    if CONFIG.is_symlink() or not CONFIG.is_file():
        raise RuntimeError('No fixed signing identity. Run scripts/stable-signing.py init once; never fall back to ad hoc.')
    data = json.loads(CONFIG.read_text())
    if data.get('version') != 1 or not re.fullmatch(r'[0-9A-F]{40}', data.get('sha1', '')):
        raise RuntimeError('Invalid signing metadata; preserve the existing keychain identity.')
    cert = STATE / 'certificate.der'
    if cert.is_symlink() or hashlib.sha1(cert.read_bytes()).hexdigest().upper() != data['sha1']:
        raise RuntimeError('Signing certificate does not match the pinned identity.')
    return data

def initialize():
    if CONFIG.exists():
        return identity()
    if STATE.is_symlink():
        raise RuntimeError('Signing directory must not be a symlink')
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    # Refuse to rotate an identity after a partially completed setup.
    if any(STATE.iterdir()):
        raise RuntimeError('Signing setup is incomplete; recover it instead of generating another identity.')
    keychain = run(['/usr/bin/security', 'default-keychain', '-d', 'user'], text=True).stdout.strip().strip('"')
    if not Path(keychain).is_file():
        raise RuntimeError('User login keychain is unavailable')
    with tempfile.TemporaryDirectory(prefix='opencodex-signing-') as temporary:
        base = Path(temporary)
        config = base / 'openssl.cnf'
        config.write_text('[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=code_signing\n[subject]\nCN=OpenCodex Local Signing\nO=OpenCodex Local Development\n[code_signing]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\n')
        key, cert, bundle = base/'key.pem', base/'cert.pem', base/'identity.p12'
        old = os.umask(0o077)
        try:
            run(['/usr/bin/openssl','req','-new','-newkey','rsa:3072','-nodes','-x509','-days','3650','-sha256','-config',str(config),'-keyout',str(key),'-out',str(cert)])
            der = run(['/usr/bin/openssl','x509','-in',str(cert),'-outform','DER']).stdout
            fingerprint = hashlib.sha1(der).hexdigest().upper()
            # macOS requires a nonempty import passphrase for PKCS#12 on recent releases.
            # The random transfer password is not logged or retained; the key lives in Keychain.
            import secrets
            transfer_password = secrets.token_urlsafe(32)
            transfer_env = {**os.environ, 'OPENCODEX_SIGNING_TRANSFER_PASSWORD': transfer_password}
            run(['/usr/bin/openssl','pkcs12','-export','-inkey',str(key),'-in',str(cert),'-out',str(bundle),'-name','OpenCodex Local Signing','-passout','env:OPENCODEX_SIGNING_TRANSFER_PASSWORD'],env=transfer_env)
            # Restrict key access to codesign. Do not change global certificate trust.
            run(['/usr/bin/security','import',str(bundle),'-k',keychain,'-f','pkcs12','-P',transfer_password,'-x','-T','/usr/bin/codesign'])
            (STATE/'certificate.der').write_bytes(der)
            data = {'version':1,'sha1':fingerprint,'keychain':keychain,'kind':'local-self-signed'}
            CONFIG.write_text(json.dumps(data,indent=2)+'\n')
            os.chmod(CONFIG,0o600)
        finally:
            os.umask(old)
    return identity()

def sign(app, entitlements=None, *, deep=True):
    data = identity()
    args = ['/usr/bin/codesign','--force','--timestamp=none','--sign',data['sha1'],'--keychain',data['keychain']]
    if deep:
        args += ['--deep']
    if entitlements:
        args += ['--entitlements',str(entitlements)]
    subprocess.run(args+[str(app)],check=True)
    subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],check=True)
    details = run(['/usr/bin/codesign','-d','-r-','--verbose=2',str(app)],text=True)
    output = details.stdout+details.stderr
    if 'Signature=adhoc' in output or 'designated => cdhash' in output:
        raise RuntimeError('Build does not have a persistent signing identity')
    return output

def verify_stability():
    data = identity()
    with tempfile.TemporaryDirectory(prefix='opencodex-signing-check-') as temporary:
        base=Path(temporary); executable=base/'signing-check'
        snapshots=[]
        for n in (0,1):
            source=base/'main.c';source.write_text('int main(void){return '+str(n)+';}\n')
            run(['/usr/bin/clang',str(source),'-o',str(executable)])
            details=sign(executable)
            requirement=next(line for line in details.splitlines() if line.startswith('designated =>'))
            digest=run(['/usr/bin/codesign','-d','--verbose=4',str(executable)],text=True).stderr
            snapshots.append({'requirement':requirement,'cdhash':re.search(r'^CDHash=(.*)$',digest,re.M).group(1)})
        assert snapshots[0]['cdhash'] != snapshots[1]['cdhash']
        assert snapshots[0]['requirement'] == snapshots[1]['requirement']
        result={'passed':True,'differentBuilds':True,'stableRequirement':True,'certificate':data['sha1'],'snapshots':snapshots}
        (ROOT/'evidence/signing-stability.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result))

if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['init','verify'])
    args=parser.parse_args()
    if args.action=='init':
        result=initialize();print(json.dumps({'createdOrReused':True,'certificate':result['sha1'],'kind':result['kind']}))
    else:
        verify_stability()
