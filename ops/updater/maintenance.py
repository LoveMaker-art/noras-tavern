"""Bounded maintenance of one verified Tavern process, with durable restart intent.

The owner pauses chats before apply. Python background work must finish first.
Unknown processes, supervisors or external writers fail closed; never kill by name.
"""
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import time
import urllib.request

from update import atomic, json_write, safe


def process_record(pid, script):
    if not isinstance(pid, int) or pid <= 1:
        raise ValueError('Invalid Tavern PID')
    proc = Path('/proc') / str(pid)
    if Path('/proc/self').exists():
        try:
            if proc.stat().st_uid != os.getuid():
                raise ValueError('Tavern PID belongs to another user')
            stat = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
            if stat[0] == 'Z':
                return None
            argv = (proc / 'cmdline').read_bytes().decode().strip('\0').split('\0')
            cwd = str((proc / 'cwd').resolve())
            identity = stat[19]
        except FileNotFoundError:
            return None
    else:
        result = subprocess.run(['ps', '-p', str(pid), '-o', 'stat=,lstart=,command='], capture_output=True, text=True)
        if result.returncode == 1 or result.stdout.lstrip().startswith('Z'):
            return None
        if result.returncode:
            raise ValueError('Cannot verify Tavern process identity')
        parts = result.stdout.strip().split(None, 6)
        identity = ' '.join(parts[1:6])
        argv = shlex.split(parts[6])
        names = subprocess.run(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], capture_output=True, text=True)
        if names.returncode:
            # SIGTERM can complete between ps and lsof. Recheck liveness;
            # permission errors or a live replacement PID still fail closed.
            after = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
            if after.returncode == 1 or after.stdout.lstrip().startswith('Z'):
                return None
            raise ValueError('Cannot verify live Tavern process working directory')
        cwd = next((line[1:] for line in names.stdout.splitlines() if line.startswith('n')), '')
    executable = Path(argv[0]).name
    expected = 'python' if script.suffix == '.py' else 'node'
    if not executable.startswith(expected) or not cwd or not any(str((Path(cwd) / arg).resolve()) == str(script.resolve()) for arg in argv[1:] if not arg.startswith('-')):
        raise ValueError('PID does not execute the reviewed Tavern program')
    return {'pid': pid, 'identity': identity, 'argv': argv, 'cwd': cwd}


def port_open(port):
    with socket.socket() as sock:
        sock.settimeout(0.3)
        return sock.connect_ex(('127.0.0.1', port)) == 0


def pause(lifecycle, transaction):
    u = lifecycle.u
    python = lifecycle.source_runtime == 'python'
    pid_file = safe(u.state / 'server.pid') if python else lifecycle.runtime().run_dir('production') / 'native.pid'
    script = u.targets['app'] / ('backend/server.py' if python else 'engine/sillytavern/server.js')
    current = process_record(int(pid_file.read_text().strip()), script) if pid_file.exists() else None
    if not current and port_open(lifecycle.port):
        raise ValueError('Tavern port has an unowned process; no service was stopped')
    record = {'schema': 1, 'sourceRuntime': lifecycle.source_runtime, 'wasRunning': bool(current), 'process': current, 'paused': False}
    if current and python:
        with urllib.request.urlopen(f'http://127.0.0.1:{lifecycle.port}/api/health', timeout=10) as response:
            health = json.load(response)
        jobs = health.get('background_jobs')
        if health.get('ok') is not True or not isinstance(jobs, dict) or any(jobs.get(key, -1) != 0 for key in ('running', 'queued')):
            raise ValueError('Python background work is active or unknown; wait for it before updating')
        # Capture only this verified source process's environment, never log it.
        # Recovery is host-local/private; no credentials enter the release bundle.
        environment = Path('/proc') / str(current['pid']) / 'environ'
        record['environment'] = dict(item.split('=', 1) for item in environment.read_bytes().decode().split('\0') if '=' in item) if environment.exists() else dict(os.environ)
    json_write(transaction / 'maintenance.json', record)
    if current:
        if process_record(current['pid'], script) != current:
            raise ValueError('Tavern process changed before maintenance')
        os.kill(current['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and process_record(current['pid'], script):
            time.sleep(0.1)
        if process_record(current['pid'], script) or port_open(lifecycle.port):
            raise ValueError('Tavern did not stop or its supervisor restarted it; no directory was switched')
    record['paused'] = True
    json_write(transaction / 'maintenance.json', record)


def resume(lifecycle, transaction):
    journal = transaction / 'maintenance.json'
    if not journal.exists():
        return  # Failure happened before maintenance; leave the source untouched.
    record = json.loads(journal.read_text())
    if not record['wasRunning']:
        return  # Do not start an originally offline Python source and trigger jobs.
    if record['sourceRuntime'] != 'python':
        lifecycle.runtime().start(port=lifecycle.port, assets_prepared=True)
        return
    script = lifecycle.u.targets['app'] / 'backend/server.py'
    old = record['process']
    current = process_record(old['pid'], script)
    if current:
        if current != old:
            raise ValueError('Original PID was reused; source restart requires review')
        return
    if port_open(lifecycle.port):
        raise ValueError('Source restart port is occupied; no process was replaced')
    log_path = safe(lifecycle.u.state / 'server.log')
    with log_path.open('ab') as log:
        child = subprocess.Popen(old['argv'], cwd=old['cwd'], env=record.get('environment') or os.environ,
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    atomic(lifecycle.u.state / 'server.pid', str(child.pid).encode())
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise ValueError('Restored Python process exited; inspect its private server.log')
        if port_open(lifecycle.port):
            return
        time.sleep(0.1)
    raise ValueError('Restored Python process did not become available')
