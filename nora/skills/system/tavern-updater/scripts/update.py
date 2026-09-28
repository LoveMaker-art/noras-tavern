#!/usr/bin/env python3
"""Resolve the Hermes interpreter before entering the installed updater."""
import json
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import uuid


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


def managed_request(home, action):
    root = managed_root(home)
    directory = root / 'installer/skill-update'
    request = directory / 'request.json'
    if action == 'status':
        if not request.is_file():
            return {'status': 'none', 'message': '尚未提交技能更新任务。'}
        return json.loads(request.read_text(encoding='utf-8'))
    try:
        endpoint = json.loads((directory / 'endpoint.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise RuntimeError('请先打开支持技能更新的新启动器，再重试；尚未开始更新。')
    age = time.time() * 1000 - endpoint.get('updatedAt', 0)
    if endpoint.get('schema') != 1 or Path(endpoint.get('noraHome', '')).resolve() != root or not 0 <= age <= 15000:
        raise RuntimeError('启动器不在线或实例不匹配，请打开对应启动器再重试。')
    lock = directory / 'submit.lock'
    # Submission holds this lock only for one local atomic write. Recover a
    # leftover empty lock after a killed agent, never replay its request.
    if lock.is_dir() and time.time() - lock.stat().st_mtime > 60:
        try:
            lock.rmdir()
        except OSError:
            pass
    try:
        lock.mkdir()
    except FileExistsError:
        raise RuntimeError('另一个技能正在提交更新请求；如上次提交中断，请一分钟后重试。')
    try:
        if request.is_file():
            old = json.loads(request.read_text(encoding='utf-8'))
            if old.get('status') in ('queued', 'running', 'restarting'):
                return old
        job = {'schema': 1, 'id': str(uuid.uuid4()), 'session': endpoint['session'],
               'action': action, 'confirm': True, 'status': 'queued', 'createdAt': int(time.time() * 1000)}
        temp = directory / (job['id'] + '.tmp')
        try:
            with temp.open('x', encoding='utf-8') as stream:
                json.dump(job, stream, ensure_ascii=False)
            os.replace(temp, request)
        finally:
            temp.unlink(missing_ok=True)
    finally:
        lock.rmdir()
    # Wait only for handoff. Hermes may be stopped after the launcher accepts it.
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        state = json.loads(request.read_text(encoding='utf-8'))
        if state.get('id') == job['id'] and state.get('status') != 'queued':
            return state
        time.sleep(0.2)
    return job


def standalone_entry(home):
    import yaml
    roots = [Path(os.environ.get('TAVERN_DATA_ROOT') or home).expanduser()]
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
            _, verified_root = module.resolve_update_target(home)
            if verified_root != root.resolve():
                raise RuntimeError('Updater location differs from verified installation')
            return entry, verified_root
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
    if args.status and (home / 'nora-instance.json').is_file():
        result = managed_request(home, 'status')
        print(json.dumps(result, ensure_ascii=False))
        if result.get('status') in ('error', 'interrupted'):
            raise SystemExit(1)
        return
    python = select_python(home)
    if args.check_environment:
        print(json.dumps({'python': python, 'hermesHome': str(home),
                          'managed': (home / 'nora-instance.json').is_file()}))
        return
    environment = dict(os.environ, HERMES_HOME=str(home))
    environment['PATH'] = str(Path(python).parent) + os.pathsep + environment.get('PATH', '')
    if (home / 'nora-instance.json').is_file():
        result = managed_request(home, 'status' if args.status else 'check' if args.check else 'update')
        print(json.dumps(result, ensure_ascii=False))
        if result.get('status') in ('error', 'interrupted'):
            raise SystemExit(1)
        return
    if os.path.abspath(sys.executable) != python:
        raise SystemExit(subprocess.call([python, '-B', str(Path(__file__).absolute()), *sys.argv[1:]], env=environment))
    entry, root = standalone_entry(home)
    environment['TAVERN_DATA_ROOT'] = str(root)
    if args.status or args.check:
        command = [str(root / 'apps/tavern-ops/scripts/nora-tavern-update-check.py'), '--check-only']
    else:
        command = [str(entry), '--hermes-home', str(home), '--install-root', str(root), '--apply', '--confirm']
    raise SystemExit(subprocess.call([python, '-u', '-B', *command], env=environment))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(json.dumps({'status': 'error', 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
