"""Bounded maintenance of one verified Tavern process, with durable restart intent.

The owner pauses chats before apply. Python background work must finish first.
Unknown processes, supervisors or external writers fail closed; never kill by name.
"""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

from update import atomic, json_write, safe
from python_installation import python_script
from service_manager import ManagedService
from runtime_process import (process_record, same_process, find_processes, port_open,
                             stop_process, require_listener, ProcessError)


def python_processes(app):
    return find_processes(python_script(app))


def managed_service(lifecycle):
    return ManagedService.discover(lifecycle.u.home, lifecycle.u.targets['app'])


def verify_restored(lifecycle, process, script):
    """Recovery uses the same identity-bound health evidence on every path."""
    route, field = ('/api/health', 'ok') if lifecycle.source_runtime == 'python' else ('/csrf-token', 'token')
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        current = process_record(process['pid'], script)
        if not same_process(current, process):
            raise ValueError('Restored Tavern process exited or changed before verification')
        if port_open(lifecycle.port):
            require_listener(current, script, lifecycle.port)
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{lifecycle.port}' + route, timeout=3) as response:
                    healthy = bool(json.load(response).get(field))
                require_listener(current, script, lifecycle.port)
                if healthy:
                    return
            except (OSError, ValueError):
                pass
        time.sleep(0.1)
    raise ValueError('Restored Tavern process did not become healthy')


def pause(lifecycle, transaction):
    u = lifecycle.u
    python = lifecycle.source_runtime == 'python'
    pid_file = safe(u.state / 'server.pid') if python else lifecycle.runtime().run_dir('production') / 'native.pid'
    script = python_script(u.targets['app']) if python else u.targets['app'] / 'engine/sillytavern/server.js'
    service = managed_service(lifecycle)
    managed_pid = service.pid() if service else None
    if not python and not service:
        status = lifecycle.runtime().status()
        if status.get('inspection_error'):
            raise ValueError('Cannot inspect Node source before maintenance: ' + status['inspection_error'])
        managed_pid = status.get('native_pid')
    current = process_record(managed_pid, script) if managed_pid else (
        process_record(int(pid_file.read_text().strip()), script) if not service and pid_file.exists() else None)
    if python:
        found = python_processes(u.targets['app'])
        if len(found) > 1 or (current and found and current != found[0]):
            raise ValueError('Multiple or changing Python processes; no service was stopped')
        if not current and found:
            current = found[0]
    if not current and port_open(lifecycle.port):
        raise ValueError('Tavern port has an unowned process; no service was stopped')
    if current and port_open(lifecycle.port):
        require_listener(current, script, lifecycle.port)
    record = {'schema': 1, 'sourceRuntime': lifecycle.source_runtime, 'script': str(script),
              'wasRunning': bool(current), 'process': current, 'paused': False}
    if service:
        if current and current['pid'] != managed_pid:
            raise ValueError('Tavern process is not owned by the reviewed manager')
        record['service'] = service.snapshot()
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
        if not same_process(process_record(current['pid'], script), current):
            raise ValueError('Tavern process changed before maintenance')
        try:
            record['stopEvidence'] = stop_process(current, script, port=lifecycle.port,
                                                  stop=service.stop if service else None)
        except ProcessError as error:
            record['stopFailure'] = {'code': error.code, 'evidence': error.evidence}
            json_write(transaction / 'maintenance.json', record)
            raise
    record['paused'] = True
    json_write(transaction / 'maintenance.json', record)


def resume(lifecycle, transaction):
    journal = transaction / 'maintenance.json'
    if not journal.exists():
        return  # Failure happened before maintenance; leave the source untouched.
    record = json.loads(journal.read_text())
    saved = record.get('service')
    if saved:
        service = ManagedService(saved['descriptor'])
        service.stop()
        service.install_text(saved['text'], accepted_hash=record.get('nodeServiceHash', saved['descriptor']['sha256']), mode=saved['mode'])
        # reload can autostart the restored config. Preserve original offline state.
        if not record['wasRunning']:
            service.stop()
            return
        pid = service.start()
        expected = Path(record['script'])
        process = process_record(pid, expected)
        if not process or process['argv'] != record['process']['argv'] or process['cwd'] != record['process']['cwd']:
            raise ValueError('Restored managed service does not match the original program')
        if record['sourceRuntime'] == 'python':
            atomic(lifecycle.u.state / 'server.pid', str(pid).encode())
        verify_restored(lifecycle, process, expected)
        return
    if not record['wasRunning']:
        return  # Do not start an originally offline Python source and trigger jobs.
    if record['sourceRuntime'] != 'python':
        lifecycle.runtime().start(port=lifecycle.port, assets_prepared=True)
        return
    script = python_script(lifecycle.u.targets['app'])
    if record.get('script', str(script)) != str(script):
        raise ValueError('Restored Python entry differs from the paused process')
    old = record['process']
    current = process_record(old['pid'], script)
    if current:
        if not same_process(current, old):
            raise ValueError('Original PID was reused; source restart requires review')
        verify_restored(lifecycle, current, script)
        return
    # Recover older receipts after their manager already restarted the exact
    # original service. Never accept an arbitrary listener based only on health.
    service = managed_service(lifecycle)
    if service and service.pid():
        replacement = process_record(service.pid(), script)
        if replacement and replacement['argv'] == old['argv'] and replacement['cwd'] == old['cwd']:
            verify_restored(lifecycle, replacement, script)
            atomic(lifecycle.u.state / 'server.pid', str(replacement['pid']).encode())
            return
    if port_open(lifecycle.port):
        raise ValueError('Source restart port is occupied; no process was replaced')
    log_path = safe(lifecycle.u.state / 'server.log')
    environment = dict(record.get('environment') or os.environ)
    environment.pop('TAVERN_MAINTENANCE_FD', None)
    with log_path.open('ab') as log:
        child = subprocess.Popen(old['argv'], cwd=old['cwd'], env=environment,
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    atomic(lifecycle.u.state / 'server.pid', str(child.pid).encode())
    process = process_record(child.pid, script)
    if not process or process['argv'] != old['argv'] or process['cwd'] != old['cwd']:
        raise ValueError('Restored Python instance differs from the reviewed source')
    verify_restored(lifecycle, process, script)
