#!/usr/bin/env python3
"""Resolve the Hermes interpreter before entering the installed updater."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys


def candidates(home):
    if (home / 'nora-instance.json').is_file():
        yield home / 'hermes-agent/venv/Scripts/python.exe'
        yield home / 'hermes-agent/venv/bin/python3'
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
            failures.append(path + ': ' + result.stderr.strip().splitlines()[-1])
        except (OSError, subprocess.TimeoutExpired) as error:
            failures.append(path + ': ' + type(error).__name__)
    raise SystemExit('No verified Hermes Python (hermes_cli + yaml). Checked: '
                     + '; '.join(failures) + '. Stop; do not install into system Python.')


def main():
    source_ops = Path(__file__).resolve().parents[4]
    home = Path(os.environ.get('HERMES_HOME', source_ops)).expanduser().resolve()
    python = select_python(home)
    if sys.argv[1:] == ['--check-environment']:
        print(json.dumps({'python': python, 'hermesHome': str(home),
                          'managed': (home / 'nora-instance.json').is_file()}))
        return
    entry = source_ops / 'updater/update.py'
    if not entry.is_file():
        entry = home / 'apps/tavern-ops/updater/update.py'
    if not entry.is_file():
        raise SystemExit('Installed updater is missing. Use the published installer.')
    environment = dict(os.environ, HERMES_HOME=str(home))
    environment['PATH'] = str(Path(python).parent) + os.pathsep + environment.get('PATH', '')
    raise SystemExit(subprocess.call([python, '-u', '-B', str(entry), *sys.argv[1:]], env=environment))


if __name__ == '__main__':
    main()
