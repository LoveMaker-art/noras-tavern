#!/usr/bin/env python3
"""Adopt a pinned full-release updater through the Python-era bootstrap URL.

Review refreshes only the updater skill. App, MCP, data and AGENTS switch together
only on a separately confirmed apply. Requires Hermes' existing PyYAML; never
installs dependencies into the system Python.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

REPO = 'LoveMaker-art/noras-tavern'
ASSETS = ('release-manifest.json', 'SHA256SUMS', 'nora-tavern-app.tar.gz', 'nora-tavern-ops.tar.gz', 'nora-tavern-nora-mcp.tar.gz')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'tavern-updater-bootstrap-v2'}), timeout=60) as response:
        data = response.read(256 * 1024 * 1024 + 1)
    if len(data) > 256 * 1024 * 1024:
        raise ValueError('Bootstrap download exceeds size limit')
    return data


def stage_ops(bundle, root, expected, candidate=False):
    raw = (bundle / ASSETS[0]).read_bytes()
    if sha(raw) != expected:
        raise ValueError('Pinned release manifest does not match')
    manifest = json.loads(raw)
    if manifest.get('schema') != 'tavern-release/v2' or (manifest.get('candidate') and not candidate):
        raise ValueError('Requires a full stable release; candidates need explicit --allow-candidate')
    archive = manifest['archives']['ops']
    if archive['name'] != 'nora-tavern-ops.tar.gz' or sha((bundle / archive['name']).read_bytes()) != archive['sha256']:
        raise ValueError('Updater archive checksum/name mismatch')
    expected_files = {name: digest for name, digest in manifest['artifacts'].items() if name.startswith('ops/')}
    seen, total = set(), 0
    with tarfile.open(bundle / archive['name'], 'r:gz') as tar:
        for member in tar:
            name = member.name
            path = PurePosixPath(name)
            if (not member.isfile() or path.is_absolute() or '..' in path.parts or '\\' in name or str(path) != name
                    or any(ord(char) < 32 for char in name)
                    or name not in expected_files or name in seen or member.size < 0 or member.size > 64 * 1024 * 1024):
                raise ValueError('Unsafe/unmanifested bootstrap archive member')
            total += member.size
            if total > 512 * 1024 * 1024 or len(seen) >= 20000:
                raise ValueError('Bootstrap archive exceeds bounds')
            data = tar.extractfile(member).read(member.size + 1)
            if sha(data) != expected_files[name]:
                raise ValueError('Updater source checksum mismatch')
            target = root.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            seen.add(name)
    if seen != set(expected_files):
        raise ValueError('Updater source files are missing')
    return manifest


def installation_home(value):
    home = Path(value).absolute()
    explicit = (os.environ.get('HERMES_HOME') == str(home) and (home / 'config.yaml').is_file()
                and (home / 'skills').is_dir() and (home / 'apps/tavern-runtime').is_dir())
    if home == Path('/') or (home == Path.home() and not explicit) or any(
            part.is_symlink() for part in (home, *home.parents)):
        raise ValueError('Use an exact non-symlink Hermes installation')
    return home


def main():
    # Direct invocations must fail before refreshing skills too. The shell entry
    # selects Hermes' interpreter; Bootstrap preserves it for the reviewed CLI.
    try:
        import yaml  # noqa: F401
    except ImportError as error:
        raise ValueError('PyYAML is required; run install.sh with TAVERN_PYTHON set to the Hermes virtualenv interpreter. No files were updated.') from error
    default = os.environ.get('HERMES_HOME') or ('/opt/data' if Path('/opt/data/skills').is_dir() else str(Path.home() / '.hermes'))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', '--hermes-home', dest='home', default=default)
    parser.add_argument('--tag', help='Approved tag; omitted only to discover the latest stable GitHub release')
    parser.add_argument('--release-dir', type=Path, help='Verified local release bundle')
    parser.add_argument('--manifest-sha256', help='Required for a local bundle')
    parser.add_argument('--allow-candidate', action='store_true')
    parser.add_argument('--isolated-test-port', type=int)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--confirm', action='store_true')
    args = parser.parse_args()
    if args.apply and not args.confirm:
        raise ValueError('--apply requires --confirm')
    home = installation_home(args.home)
    update_root = home / 'tavern-updates-v2'
    if update_root.is_symlink():
        raise ValueError('Unsafe bootstrap state directory')
    update_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='bootstrap-stage-', dir=update_root) as temporary:
        work = Path(temporary)
        bundle = args.release_dir
        expected = args.manifest_sha256
        if bundle is None:
            tag = args.tag
            if not tag:
                release = json.loads(fetch(f'https://api.github.com/repos/{REPO}/releases/latest'))
                if release.get('draft') or release.get('prerelease'):
                    raise ValueError('Latest release is not stable')
                tag = release['tag_name']
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,100}', tag):
                raise ValueError('Invalid release tag')
            bundle = work / 'bundle'
            bundle.mkdir()
            for name in ASSETS:
                (bundle / name).write_bytes(fetch(f'https://github.com/{REPO}/releases/download/{tag}/{name}'))
            sums = {line.split()[1]: line.split()[0] for line in (bundle / 'SHA256SUMS').read_text().splitlines() if line.strip()}
            expected = sums.get('release-manifest.json')
        if not expected:
            raise ValueError('Local review requires --manifest-sha256')
        stage = work / 'verified'
        stage.mkdir()
        manifest = stage_ops(bundle, stage, expected, args.allow_candidate)
        # Import only the hash-verified updater, then verify ALL release archives
        # before refreshing any installed skill file.
        sys.path.insert(0, str(stage / 'ops/updater'))
        from bundle import read_bundle, extract_bundle
        from update import atomic, json_write, safe
        from tree_transaction import inventory
        checked = read_bundle(bundle, expected, candidate=args.allow_candidate)
        extract_bundle(bundle, work / 'complete-check', checked)
        installed = update_root / ('bootstrap-' + expected)
        safe(installed)
        if installed.exists():
            inventory(installed, state=True)
            for name, digest in manifest['artifacts'].items():
                if name.startswith('ops/') and sha((installed / name).read_bytes()) != digest:
                    raise ValueError('Previously staged bootstrap was modified')
        else:
            os.replace(stage, installed)
        entry = installed / 'ops/updater/update.py'
        target = safe(home / 'skills/system/tavern-updater')
        backup = work / 'previous-updater'
        if target.exists():
            inventory(target, state=True)  # Reject internal links before copying private files.
            # Keep the original updater outside skill discovery for recovery.
            backup = update_root / ('bootstrap-updater-backup-' + expected)
            if not backup.exists():
                shutil.copytree(target, backup)
        source = installed / 'ops/skills/system/tavern-updater'
        for file in source.rglob('*'):
            if file.is_file():
                atomic(safe(target / file.relative_to(source)), file.read_bytes(), 0o644)
        json_write(update_root / 'bootstrap-runtime.json', {'schema': 1, 'entry': str(entry),
                   'sha256': sha(entry.read_bytes()), 'manifestSha256': expected})
        command = [sys.executable, str(entry), '--hermes-home', str(home)]
        if args.isolated_test_port is not None:
            command += ['--isolated-test-port', str(args.isolated_test_port)]
        env = {**os.environ, 'HERMES_HOME': str(home)}
        review = json.loads(subprocess.check_output(command + ['review', '--release-dir', str(bundle),
                            '--manifest-sha256', expected] + (['--allow-candidate'] if args.allow_candidate else []), env=env, text=True))
        json_write(update_root / 'bootstrap-review.json', {'transaction': review['transaction'], 'planDigest': review['planDigest'],
                   'testPort': args.isolated_test_port})
        apply_command = command + ['apply', '--transaction', review['transaction'], '--expected-plan', review['planDigest'], '--confirm']
        result = {'bootstrap_schema': 2, 'updater_installed': True, 'commit': manifest['commit'],
                  'review': review, 'report': {'plan_id': Path(review['transaction']).name}, 'applyCommand': apply_command,
                  'next_step': 'Review migration and inactive-file lists; apply only this pinned plan after approval.'}
        if args.apply:
            applied = subprocess.run(apply_command, env=env, capture_output=True, text=True)
            if applied.returncode:
                atomic(Path(review['transaction']) / 'apply-error.log', applied.stderr.encode(), 0o600)
                raise ValueError('Update did not complete; inspect the private transaction receipt and apply-error.log.')
            # npm/lifecycle may emit progress before the CLI result. The durable
            # receipt, not incidental stdout formatting, is the source of truth.
            receipt = json.loads((Path(review['transaction']) / 'receipt.json').read_text())
            from completion import installation_guidance
            result.update(installation_guidance(receipt, isolated=args.isolated_test_port is not None))
            result['apply'] = {'status': receipt['status'], 'commit': receipt['commit']}
        print(json.dumps(result, ensure_ascii=False))
        if result.get('restartCommand'):
            # Keep stdout machine-readable; make the owner's last terminal
            # instruction visible without requiring them to decode the receipt.
            print(result['next_step'], file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
