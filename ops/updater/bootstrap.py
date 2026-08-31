#!/usr/bin/env python3
"""Adopt a pinned full-release updater through the Python-era bootstrap URL.

Review stages only a private updater. All active skills, app, MCP, data and AGENTS switch together
only on a separately confirmed apply. Requires Hermes' existing PyYAML; never
installs dependencies into the system Python.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
import tempfile
import urllib.request

sys.dont_write_bytecode = True

REPO = 'LoveMaker-art/noras-tavern'
ASSETS = ('release-manifest.json', 'SHA256SUMS', 'nora-tavern-app.tar.gz', 'nora-tavern-ops.tar.gz', 'nora-tavern-nora-mcp.tar.gz')


def notice(message):
    # Standalone Bootstrap cannot import updater modules until hashes are verified.
    print('[tavern-updater] ' + message, file=sys.stderr, flush=True)


def run_cli(command, **kwargs):
    from feedback import run_cli as run
    return run(command, **kwargs)


class UpdateFailure(ValueError):
    def __init__(self, result):
        self.result = result
        super().__init__('Update did not complete: ' + result['error'] + '; status=' + result['status'])


def checked_cli(command, *, env, log, transaction=None):
    from feedback import failure_report
    result = run_cli(command, env=env, log=log)
    if result.returncode:
        try:
            failure = json.loads(result.stderr)
            if not isinstance(failure, dict) or failure.get('event') != 'failure':
                raise ValueError('No structured failure')
        except (ValueError, TypeError):
            failure = failure_report(ValueError(result.stderr or '更新子进程异常退出，退出码 ' + str(result.returncode)), transaction)
        failure['errorLog'] = str(log)
        raise UpdateFailure(failure)
    return result


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
    # Direct invocations must fail before staging. The shell entry
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
    notice('开始执行更新脚本；进度写入终端，不需要模型参与更新。')
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
                notice('下载发布文件：' + name)
                (bundle / name).write_bytes(fetch(f'https://github.com/{REPO}/releases/download/{tag}/{name}'))
            sums = {line.split()[1]: line.split()[0] for line in (bundle / 'SHA256SUMS').read_text().splitlines() if line.strip()}
            expected = sums.get('release-manifest.json')
        if not expected:
            raise ValueError('Local review requires --manifest-sha256')
        stage = work / 'verified'
        stage.mkdir()
        notice('校验发布包及文件摘要')
        manifest = stage_ops(bundle, stage, expected, args.allow_candidate)
        # Import only the hash-verified updater, then verify ALL release archives
        # before invoking the staged engine. Active skills belong to apply only.
        sys.path.insert(0, str(stage / 'ops/updater'))
        from bundle import read_bundle, extract_bundle
        from update import atomic, json_write, safe
        from tree_transaction import inventory
        checked = read_bundle(bundle, expected, candidate=args.allow_candidate)
        extract_bundle(bundle, work / 'complete-check', checked)
        installed = update_root / ('bootstrap-' + expected)
        safe(installed)
        if installed.exists():
            if any(installed.rglob('__pycache__')):
                raise ValueError('Previously staged bootstrap contains unreviewed bytecode')
            staged_files = {name for name, item in inventory(installed, state=True).items() if 'sha256' in item}
            expected_files = {name for name in manifest['artifacts'] if name.startswith('ops/')}
            if staged_files != expected_files:
                raise ValueError('Previously staged bootstrap contains unreviewed files')
            for name, digest in manifest['artifacts'].items():
                if name.startswith('ops/') and sha((installed / name).read_bytes()) != digest:
                    raise ValueError('Previously staged bootstrap was modified')
        else:
            os.replace(stage, installed)
        # The standalone downloaded Bootstrap has no sibling updater modules.
        # Later imports must follow the verified tree after its durable move.
        sys.path.insert(0, str(installed / 'ops/updater'))
        entry = installed / 'ops/updater/update.py'
        command = [sys.executable, '-B', '-u', str(entry), '--hermes-home', str(home)]
        if args.isolated_test_port is not None:
            command += ['--isolated-test-port', str(args.isolated_test_port)]
        env = {**os.environ, 'HERMES_HOME': str(home)}
        notice('审查目标机器与更新计划')
        review = json.loads(checked_cli(command + ['review', '--release-dir', str(bundle),
                            '--manifest-sha256', expected] + (['--allow-candidate'] if args.allow_candidate else []),
                            env=env, log=update_root / 'bootstrap-review.log').stdout)
        json_write(update_root / 'bootstrap-review.json', {'transaction': review['transaction'], 'planDigest': review['planDigest'],
                   'testPort': args.isolated_test_port})
        # The reviewed engine owns this transaction, even after installed ops
        # are replaced. Never depend on a global last-Bootstrap pointer.
        apply_command = [sys.executable, '-B', '-u', review['engine']['entry'], *command[4:]]
        apply_command += ['apply', '--transaction', review['transaction'], '--expected-plan', review['planDigest'], '--confirm']
        result = {'bootstrap_schema': 2, 'updater_installed': False, 'updater_staged': True, 'commit': manifest['commit'],
                  'review': review, 'report': {'plan_id': Path(review['transaction']).name}, 'applyCommand': apply_command,
                  'next_step': 'Review migration and inactive-file lists; apply only this pinned plan after approval.'}
        if args.apply:
            notice('开始应用更新；耗时阶段每 10 秒报告一次状态')
            checked_cli(apply_command, env=env, log=Path(review['transaction']) / 'apply-error.log',
                        transaction=Path(review['transaction']))
            # npm/lifecycle may emit progress before the CLI result. The durable
            # receipt, not incidental stdout formatting, is the source of truth.
            receipt = json.loads((Path(review['transaction']) / 'receipt.json').read_text())
            from completion import installation_guidance
            from update_status import receipt_result
            result.update(installation_guidance(receipt, isolated=args.isolated_test_port is not None))
            result['apply'] = {**receipt_result(receipt), 'commit': receipt['commit']}
            result['updater_installed'] = True
        print(json.dumps(result, ensure_ascii=False))
        if result.get('restartCommand'):
            # Keep stdout machine-readable; make the owner's last terminal
            # instruction visible without requiring them to decode the receipt.
            print(result['next_step'], file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(getattr(error, 'result', {'ok': False, 'error': str(error),
              'next_step': '本次执行已停止，请直接报告结果；排查或重试需要用户另行同意。'}), ensure_ascii=False), file=sys.stderr, flush=True)
        raise SystemExit(1)
