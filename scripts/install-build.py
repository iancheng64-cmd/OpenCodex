#!/usr/bin/env python3
"""Install build/OpenCodex.app into /Applications as a verified, reversible transaction.

Steps: verify the build's signature; compare its designated requirement with the installed app's;
refuse while a non-system process holds the installed bundle; quit the running app when asked;
copy the build beside the installed app, swap by rename (the old app becomes the backup); verify
the installed signature and asar digest; relaunch when asked. Writes evidence/install-<version>.json.

Usage: python3 scripts/install-build.py [--quit] [--relaunch]
"""
import hashlib, json, os, plistlib, re, shutil, subprocess, sys, time
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'build/OpenCodex.app')
DST = '/Applications/OpenCodex.app'
SYSTEM_HOLDERS = {'NotificationCenter', 'NotificationsSettingsIntents', 'mds', 'mdworker', 'mds_stores', 'Finder', 'lsd', 'quicklookd', 'QuickLookUIService', 'spotlightknowledged', 'com.apple.dock.external.extra.a'}
# Helpers the app leaves behind for a moment after it quits; they are asked to exit before the swap.
APP_HELPERS = {'browser_crashpad_handler', 'bare-modifier-monitor', 'OpenCodexEngine Helper', 'OpenCodexEngine Helper (GPU)', 'OpenCodexEngine Helper (Renderer)', 'OpenCodexEngine Helper (Plugin)'}


def run(*cmd, check=True):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if check and p.returncode:
        raise SystemExit(f'{" ".join(cmd)} failed ({p.returncode}): {p.stderr.strip()[:400]}')
    return p


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def requirement(app):
    out = run('codesign', '-d', '-r-', app).stderr + run('codesign', '-d', '-r-', app).stdout
    m = re.search(r'designated => (.+)', out)
    return m.group(1).strip() if m else None


def holders(app):
    p = run('lsof', '-F', 'pc', '+D', app, check=False)
    pids, names, cur = set(), {}, None
    for line in p.stdout.splitlines():
        if line.startswith('p'):
            cur = int(line[1:]); pids.add(cur)
        elif line.startswith('c') and cur is not None:
            names[cur] = line[1:]
    return {pid: names.get(pid, '?') for pid in pids if names.get(pid, '?') not in SYSTEM_HOLDERS}


def app_pids():
    p = run('pgrep', '-f', DST + '/Contents/MacOS/', check=False)
    return [int(x) for x in p.stdout.split()]


def main():
    quit_app = '--quit' in sys.argv
    relaunch = '--relaunch' in sys.argv
    if not os.path.isdir(SRC):
        raise SystemExit('build/OpenCodex.app is missing')
    run('codesign', '--verify', '--deep', '--strict', SRC)
    with open(os.path.join(SRC, 'Contents/Info.plist'), 'rb') as f:
        info = plistlib.load(f)
    version = info.get('OpenCodexVersion')
    src_asar = sha256(os.path.join(SRC, 'Contents/Resources/app.asar'))
    src_req = requirement(SRC)
    previous = None
    if os.path.isdir(DST):
        dst_req = requirement(DST)
        if dst_req != src_req:
            raise SystemExit(f'designated requirement differs: installed {dst_req!r} vs build {src_req!r}')
        with open(os.path.join(DST, 'Contents/Info.plist'), 'rb') as f:
            previous = {'openCodexVersion': plistlib.load(f).get('OpenCodexVersion'), 'asarSHA256': sha256(os.path.join(DST, 'Contents/Resources/app.asar'))}
        if app_pids():
            if not quit_app:
                raise SystemExit('OpenCodex is running; pass --quit to close it first')
            # Ask politely first; an Electron app that ignores the Apple event still exits cleanly on
            # SIGTERM (its before-quit handlers run). Never SIGKILL: that could lose unsaved state.
            run('osascript', '-e', 'tell application "OpenCodex" to quit', check=False)
            for _ in range(20):
                if not app_pids():
                    break
                time.sleep(0.5)
            if app_pids():
                for pid in app_pids():
                    try:
                        os.kill(pid, 15)
                    except ProcessLookupError:
                        pass
                for _ in range(60):
                    if not app_pids():
                        break
                    time.sleep(0.5)
            if app_pids():
                raise SystemExit('OpenCodex did not quit')
            time.sleep(1)
        busy = holders(DST)
        if busy and quit_app and all(name in APP_HELPERS for name in busy.values()):
            for pid in busy:
                try:
                    os.kill(pid, 15)
                except ProcessLookupError:
                    pass
            for _ in range(20):
                busy = holders(DST)
                if not busy:
                    break
                time.sleep(0.5)
        if busy:
            raise SystemExit(f'installed app is in use by {busy}')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    staging = DST + '.new-' + stamp
    backup_dir = os.path.join(ROOT, 'build/releases', f'before-{version}-{stamp}')
    run('ditto', SRC, staging)
    run('codesign', '--verify', '--deep', '--strict', staging)
    backup = None
    try:
        if os.path.isdir(DST):
            os.makedirs(os.path.dirname(backup_dir), exist_ok=True)
            backup = os.path.join(backup_dir, 'OpenCodex.app')
            os.makedirs(backup_dir, exist_ok=True)
            os.rename(DST, backup)
        os.rename(staging, DST)
        run('codesign', '--verify', '--deep', '--strict', DST)
        installed_asar = sha256(os.path.join(DST, 'Contents/Resources/app.asar'))
        if installed_asar != src_asar:
            raise SystemExit('installed asar digest differs from the build')
    except BaseException:
        if os.path.isdir(staging):
            shutil.rmtree(staging, ignore_errors=True)
        if backup and not os.path.isdir(DST) and os.path.isdir(backup):
            os.rename(backup, DST)
        raise
    evidence = {
        'version': version, 'installedAt': datetime.now(timezone.utc).isoformat(), 'asarSHA256': src_asar,
        'previous': previous, 'backup': backup_dir if backup else None, 'signatureVerified': True,
        'designatedRequirementUnchanged': True, 'quitApp': quit_app, 'relaunched': False,
    }
    if relaunch:
        run('open', '-a', DST)
        for _ in range(60):
            if app_pids():
                evidence['relaunched'] = True
                break
            time.sleep(0.5)
    path = os.path.join(ROOT, 'evidence', f'install-{version}.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(evidence, f, ensure_ascii=False, indent=1)
    print(json.dumps(evidence, ensure_ascii=False))


if __name__ == '__main__':
    main()
