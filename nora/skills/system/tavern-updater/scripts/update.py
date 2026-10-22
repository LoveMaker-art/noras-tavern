#!/usr/bin/env python3
"""Resolve the Hermes interpreter before entering the installed updater."""
import json
import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import re


def candidates(home):
    if (home / 'nora-instance.json').is_file():
        yield home / 'hermes-agent/venv/Scripts/python.exe'
        yield home / 'hermes-agent/venv/bin/python3'
        yield home / 'hermes-agent/venv/bin/python'
        return
    # Ask the running gateway, rather than trusting a stale PID file or PATH.
    if hasattr(socket, 'AF_UNIX'):
        try:
            address = home / 'gateway.sock'
            pointer = home / 'gateway.sock.path'
            if pointer.is_file():
                address = Path(pointer.read_text().strip())
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(3)
                client.connect(str(address))
                client.sendall(b'{"verb":"status"}\n')
                with client.makefile('rb') as stream:
                    response = json.loads(stream.readline(65536))
            state = response.get('result', {})
            if response.get('ok') and Path(state['hermes_home']).resolve() == home:
                pid = int(state['answering_pid'])
                argv = Path('/proc/{}/cmdline'.format(pid)).read_bytes().split(b'\0')
                executable = Path(os.fsdecode(argv[0]))
                if executable.is_absolute():
                    yield executable
        except (OSError, ValueError, KeyError, TypeError):
            pass
    yield Path(sys.executable)
    installation = Path(os.environ.get('HERMES_INSTALL_DIR') or home / 'hermes-agent').expanduser()
    yield installation / 'venv/Scripts/python.exe'
    yield installation / 'venv/bin/python3'
    yield installation / 'venv/bin/python'
    command = shutil.which('hermes')
    if command:
        yield Path(command).parent / ('python.exe' if os.name == 'nt' else 'python3')


def select_python(home):
    failures = []
    seen = set()
    for candidate in candidates(home):
        # Do not resolve venv symlinks: their location selects site-packages.
        path = str(candidate.absolute())
        if path in seen or not candidate.is_file():
            continue
        seen.add(path)
        try:
            result = subprocess.run(
                [path, '-B', '-c', 'import hermes_cli, yaml'],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                return path
            lines = (result.stderr or result.stdout or '').strip().splitlines()
            failures.append(path + ': ' + (lines[-1] if lines else 'exit ' + str(result.returncode)))
        except (OSError, subprocess.TimeoutExpired) as error:
            failures.append(path + ': ' + type(error).__name__)
    raise SystemExit('No verified Hermes Python (hermes_cli + yaml). Checked: '
                     + '; '.join(failures) + '. Stop; do not install into system Python.')


def managed_root(home):
    home = Path(home).expanduser().resolve()
    instance = json.loads((home / 'nora-instance.json').read_text(encoding='utf-8'))
    root = Path(instance['noraHome']).expanduser()
    if instance.get('schema') != 1 or not root.is_absolute() or root.is_symlink():
        raise RuntimeError('Invalid launcher instance')
    root = root.resolve()
    for key, expected in [('hermesHome', root / 'hermes'), ('installRoot', root / 'tavern')]:
        value = Path(instance[key])
        if not value.is_absolute() or value.is_symlink() or value.resolve() != expected:
            raise RuntimeError('Conflicting launcher instance paths')
    if home != root / 'hermes':
        raise RuntimeError('HERMES_HOME differs from launcher instance')
    return root


def query_helper(ops, manifest_file, *, installed_receipt=None):
    """Authenticate only the bootstrap pair; Node verifies its reader closure.

    This wrapper never interprets task records. The two builtin-only files must
    be trusted before Node can safely run their own dependency verification.
    """
    try:
        if manifest_file.is_symlink():
            return None
        raw = manifest_file.read_bytes()
        manifest = json.loads(raw)
        if manifest.get('schema') != 'tavern-release/v2':
            return None
        if installed_receipt is not None:
            receipt = json.loads(installed_receipt.read_text(encoding='utf-8'))
            if (receipt.get('version') != manifest.get('versions', {}).get('tavern')
                    or receipt.get('commit') != manifest.get('commit')
                    or receipt.get('releaseManifestSha256', hashlib.sha256(raw).hexdigest()) != hashlib.sha256(raw).hexdigest()):
                return None
        for name in ('installer/desktop/updater-task.js', 'installer/desktop/updater-capability.js'):
            file = ops / name
            for parent in (file, *file.parents):
                if parent.is_symlink():
                    return None
                if parent == ops:
                    break
            if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != manifest['artifacts'].get('ops/' + name):
                return None
        return ops / 'installer/desktop/updater-task.js'
    except (OSError, ValueError, KeyError, TypeError):
        return None


def same_absolute_path(value, expected):
    # Windows short names and full names can identify the same directory.
    return isinstance(value, str) and Path(value).is_absolute() and Path(value).resolve() == expected.resolve()


def query_entries(home, root):
    # Choose code, not task state. Prefer the current installed reader; immutable
    # snapshots are only a fallback while the installed ops tree is being swapped.
    installs = [root / 'tavern'] if (home / 'nora-instance.json').is_file() else [Path(os.environ.get('TAVERN_DATA_ROOT') or home).expanduser()]
    snapshots = []
    directory = root / 'installer/update-jobs'
    jobs = sorted((entry for entry in directory.iterdir()
                   if re.fullmatch(r'[a-fA-F0-9-]{36}', entry.name) and entry.is_dir() and not entry.is_symlink()),
                  key=lambda entry: entry.stat().st_mtime, reverse=True) if directory.is_dir() else []
    for job in jobs:
        snapshot, manifest = job / 'runner/ops', job / 'runner/release-manifest.json'
        try:
            receipt = json.loads((job / 'updater-control.json').read_text(encoding='utf-8'))
            if (not same_absolute_path(receipt.get('noraHome'), root) or not same_absolute_path(receipt.get('hermesHome'), home)
                    or not same_absolute_path(receipt.get('opsRoot'), snapshot)
                    or not same_absolute_path(receipt.get('sourceManifest', {}).get('path'), manifest)
                    or receipt['sourceManifest']['sha256'] != hashlib.sha256(manifest.read_bytes()).hexdigest()):
                continue
            install = Path(receipt['installRoot'])
            if install.is_absolute() and not install.is_symlink():
                installs.append(install)
            entry = query_helper(snapshot, manifest)
            if entry:
                snapshots.append(entry)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    entries = []
    for install in installs:
        entry = query_helper(install / 'apps/tavern-ops', install / 'tavern-updates/installed-manifest.json',
                             installed_receipt=install / 'tavern-updates/installed.json')
        if entry and entry not in entries:
            entries.append(entry)
    yield from entries
    yield from (entry for entry in snapshots if entry not in entries)


def task_status(home):
    desktop = desktop_transport(home, 'status')
    if desktop is not None and desktop.get('status') != 'none':
        return desktop
    root = managed_root(home) if (home / 'nora-instance.json').is_file() else home
    unavailable = {'status': 'inspection-required', 'settled': False, 'busy': None,
                   'error': '无法核验更新任务是否结束，请保留日志，暂勿重复更新。'}
    nodes = []
    if os.environ.get('TAVERN_NODE_EXECUTABLE'):
        nodes.append(Path(os.environ['TAVERN_NODE_EXECUTABLE']))
    for base in (root, home):
        nodes.extend((base / 'node/node.exe', base / 'node/bin/node'))
    command = shutil.which('node')
    if command:
        nodes.append(Path(command))
    node = next((candidate for candidate in nodes if candidate.is_absolute() and candidate.is_file()), None)
    if node is None:
        return unavailable
    for entry in query_entries(home, root):
        try:
            result = subprocess.run([str(node), str(entry)], input=json.dumps({'action': 'status', 'noraHome': str(root)}),
                                    text=True, encoding='utf-8', capture_output=True, timeout=15, check=False)
            reply = json.loads(result.stdout)
            # Compatibility check for the public reply, not a second task state
            # machine. An older reader without the settled/lock contract cannot
            # claim completion during automatic recovery.
            if (not isinstance(reply.get('settled'), bool)
                    or not (isinstance(reply.get('busy'), bool) or reply.get('busy') is None)
                    or reply['settled'] and reply.get('busy') is not False
                    or reply.get('status') in ('succeeded', 'failed', 'rolled-back', 'blocked', 'cancelled', 'interrupted') and not reply['settled']):
                continue
            return reply
        except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
            continue
    return unavailable


def desktop_transport(home, action, confirm=False):
    """Submit to the existing desktop receiver using an authenticated reader.

    The receiver, not this wrapper, owns version selection and APP replacement.
    Absence of a desktop receipt retains the independent core-only deployment.
    """
    if not (home / 'nora-instance.json').is_file():
        return None
    root = managed_root(home)
    if not (root / 'installer/launcher-control.json').is_file():
        return None
    nodes = [Path(os.environ['TAVERN_NODE_EXECUTABLE'])] if os.environ.get('TAVERN_NODE_EXECUTABLE') else []
    nodes.extend((home / 'node/node.exe', home / 'node/bin/node'))
    node = next((candidate for candidate in nodes if candidate.is_absolute() and candidate.is_file()), None)
    if node is None:
        raise RuntimeError('未找到桌面更新查询所需的独立Node，原数据已保留。')
    for entry in query_entries(home, root):
        probe = subprocess.run([str(node), '-e',
            'const m=require(process.argv[1]);console.log(JSON.stringify({desktopProtocol:m.desktopProtocol||null}))', str(entry)],
            text=True, encoding='utf-8', capture_output=True, timeout=10, check=False)
        try:
            if json.loads(probe.stdout).get('desktopProtocol') != 'nora-desktop-update/1':
                continue
        except (ValueError, TypeError):
            continue
        reply = subprocess.run([str(node), str(entry)], input=json.dumps({'scope': 'desktop', 'action': action,
            'confirm': confirm, 'noraHome': str(root)}), text=True, encoding='utf-8', capture_output=True, timeout=45, check=False)
        try:
            result = json.loads(reply.stdout)
        except (ValueError, TypeError):
            # A reader which advertised this protocol actually ran. Preserve
            # its failure rather than misreporting it as an unsupported version.
            for line in reversed(reply.stderr.splitlines()):
                try:
                    failure = json.loads(line)
                    if failure.get('event') == 'error' and isinstance(failure.get('message'), str):
                        return {'scope': 'desktop', 'status': 'error', 'settled': False, 'busy': None,
                                'code': failure.get('code', 'DESKTOP_UPDATE_UNCONFIRMED'), 'error': failure['message']}
                except (ValueError, TypeError):
                    pass
            raise RuntimeError('桌面更新查询未返回可核验结果，请保留原任务并查看日志。')
        if result.get('scope') != 'desktop':
            continue
        return result
    raise RuntimeError('当前旧更新器尚不支持诺拉整套更新，请先在启动器完成一次更新；未改动原数据。')


def standalone_entry(home):
    # Importing the verified bootstrap must not add undeclared .pyc files to
    # its authenticated program tree, including when this skill ran without -B.
    sys.dont_write_bytecode = True
    import yaml
    roots = [Path(os.environ.get('TAVERN_DATA_ROOT') or home).expanduser()]
    managed = managed_root(home) if (home / 'nora-instance.json').is_file() else None
    if managed:
        roots.insert(0, managed / 'tavern')
    config = home / 'config.yaml'
    if config.is_file():
        value = yaml.safe_load(config.read_text(encoding='utf-8')) or {}
        project = value.get('mcp_servers', {}).get('nora', {}).get('env', {}).get('NORA_MCP_PROJECT_ROOT')
        if project:
            roots.append(Path(project).parent.parent)
    for root in roots:
        entry = root / 'apps/tavern-ops/updater/bootstrap.py'
        if entry.is_file():
            spec = importlib.util.spec_from_file_location('nora_skill_bootstrap', entry)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            _, verified_root = module.resolve_update_target(home, managed_home=managed)
            if verified_root != root.resolve():
                raise RuntimeError('Updater location differs from verified installation')
            task = entry.with_name('task.py')
            if not task.is_file():
                raise RuntimeError('当前更新器尚未包含独立任务入口，请使用新版官方独立更新命令接入；原数据未修改。')
            return task, verified_root
    raise RuntimeError('未找到已安装的更新器，请检查 HERMES_HOME 和 TAVERN_DATA_ROOT。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check-environment', action='store_true')
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--status', action='store_true')
    mode.add_argument('--apply', action='store_true')
    parser.add_argument('--confirm', action='store_true')
    args = parser.parse_args()
    if args.apply and not args.confirm:
        raise RuntimeError('更新需要用户明确授权，并带 --apply --confirm。')
    home = Path(os.environ.get('HERMES_HOME', Path(__file__).resolve().parents[4])).expanduser().resolve()
    if args.status:
        result = task_status(home)
        # JSON escapes preserve Unicode even when an isolated Windows caller uses a legacy pipe encoding.
        print(json.dumps(result))
        if result.get('status') in ('error', 'inspection-required', 'interrupted', 'failed', 'blocked', 'cancelled', 'rolled-back'):
            raise SystemExit(1)
        return
    python = select_python(home)
    if args.check_environment:
        print(json.dumps({'python': python, 'hermesHome': str(home),
                          'managed': (home / 'nora-instance.json').is_file()}))
        return
    environment = dict(os.environ, HERMES_HOME=str(home))
    environment['PATH'] = str(Path(python).parent) + os.pathsep + environment.get('PATH', '')
    if os.path.abspath(sys.executable) != python:
        raise SystemExit(subprocess.call([python, '-B', str(Path(__file__).absolute()), *sys.argv[1:]], env=environment))
    desktop = desktop_transport(home, 'check' if args.check else 'update', confirm=args.confirm)
    if desktop is not None:
        print(json.dumps(desktop))
        if desktop.get('status') in ('error', 'inspection-required', 'interrupted'):
            raise SystemExit(1)
        return
    entry, root = standalone_entry(home)
    environment['TAVERN_DATA_ROOT'] = str(root)
    command = [str(entry), '--hermes-home', str(home), '--install-root', str(root)]
    command += ['--check'] if args.check else ['--apply', '--confirm']
    raise SystemExit(subprocess.call([python, '-u', '-B', *command], env=environment))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(json.dumps({'status': 'error', 'error': str(error)}))
        raise SystemExit(1)
