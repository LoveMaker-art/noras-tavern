"""Process observation and ownership rules for runtime maintenance.

Kernel identity protects one bounded inspect/stop operation. Durable ownership
uses stable program/configuration evidence so Liveware checkpoint/restore does
not turn a healthy Tavern into an unrelated process. PID files are hints only.
"""
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import sys
import time


class ProcessError(ValueError):
    def __init__(self, code, message, evidence=None):
        super().__init__(message)
        self.code = code
        self.evidence = evidence or {}


def _entry(argv, kind):
    """Locate the executed file, never a script-looking argument to -c/-m/-e."""
    flags = {'-B', '-u', '-E', '-s', '-S', '-I', '-O', '-OO', '-q'} if kind == 'python' else {
        '--no-warnings', '--trace-warnings', '--enable-source-maps', '--experimental-strip-types'}
    paired = {'-X', '-W'} if kind == 'python' else {'--require', '-r', '--import'}
    i = 1
    while i < len(argv):
        value = argv[i]
        if value == '--':
            return argv[i + 1] if i + 1 < len(argv) else None
        if value in flags:
            i += 1
        elif value in paired:
            i += 2
        elif kind == 'python' and value.startswith(('-X', '-W')) and len(value) > 2:
            i += 1
        elif not value.startswith('-'):
            return value
        else:
            return None  # Unknown invocation is not authorization to stop it.
    return None


def command_matches(argv, cwd, script):
    script = Path(script).resolve()
    kind = 'python' if script.suffix == '.py' else 'node'
    entry = _entry(argv, kind)
    executable = Path(argv[0]).name.lower() if argv else ''
    return bool(executable.startswith(kind) and entry and cwd and (Path(cwd) / entry).resolve() == script)


def _linux(pid):
    proc = Path('/proc') / str(pid)
    try:
        uid = proc.stat().st_uid
        if uid != os.getuid():
            raise ProcessError('wrong-owner', 'Tavern PID belongs to another user')
        before = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
        if before[0] in ('Z', 'X'):
            return None
        argv = (proc / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')
        cwd = os.readlink(proc / 'cwd')
        after = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
        if after[0] in ('Z', 'X'):
            return None
        if before[19] != after[19]:
            raise ProcessError('process-changed', 'Tavern process changed during inspection')
        return {'pid': pid, 'identity': after[19], 'argv': argv, 'cwd': cwd,
                'uid': uid, 'pgid': int(after[2]), 'session': int(after[3])}
    except (FileNotFoundError, ProcessLookupError):
        return None


def _ps(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'uid=,pgid=,stat=,lstart=,command='],
                            capture_output=True, text=True)
    if result.returncode == 1:
        return None
    if result.returncode:
        raise ProcessError('inspection-failed', 'Cannot verify Tavern process identity')
    parts = result.stdout.strip().split(None, 8)
    if len(parts) < 9:
        raise ProcessError('inspection-failed', 'Incomplete Tavern process identity')
    if parts[2].startswith('Z'):
        return None
    names = subprocess.run(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], capture_output=True, text=True)
    if names.returncode:
        after = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
        if after.returncode == 1 or after.stdout.lstrip().startswith('Z'):
            return None
        raise ProcessError('inspection-failed', 'Cannot verify live Tavern process working directory')
    cwd = next((line[1:] for line in names.stdout.splitlines() if line.startswith('n')), '')
    try:
        argv = _darwin_argv(pid) if sys.platform == 'darwin' else shlex.split(parts[8])
    except ProcessError:
        after = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
        if after.returncode == 1 or after.stdout.lstrip().startswith('Z'):
            return None
        raise
    after = subprocess.run(['ps', '-p', str(pid), '-o', 'uid=,pgid=,stat=,lstart='], capture_output=True, text=True)
    latest = after.stdout.split()
    if after.returncode == 1 or (len(latest) >= 3 and latest[2].startswith('Z')):
        return None
    if after.returncode or len(latest) != 8 or latest[:2] != parts[:2] or latest[3:] != parts[3:8]:
        raise ProcessError('process-changed', 'Tavern process changed during inspection')
    return {'pid': pid, 'identity': ' '.join(parts[3:8]), 'argv': argv,
            'cwd': cwd, 'uid': int(parts[0]), 'pgid': int(parts[1])}


def _darwin_argv(pid):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN / KERN_PROCARGS2 (Darwin sysctl.h)
    length = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(length), None, 0) != 0 or not 4 < length.value <= 16 * 1024 * 1024:
        raise ProcessError('inspection-failed', 'Cannot read exact Tavern process arguments')
    buffer = ctypes.create_string_buffer(length.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(length), None, 0) != 0:
        raise ProcessError('inspection-failed', 'Tavern process arguments became unavailable')
    raw = buffer.raw[:length.value]
    count = int.from_bytes(raw[:4], sys.byteorder, signed=True)
    if not 0 < count <= 65536:
        raise ProcessError('inspection-failed', 'Invalid process argument count')
    offset = raw.find(b'\0', 4) + 1
    while offset < len(raw) and raw[offset] == 0:
        offset += 1
    result = []
    for _ in range(count):
        end = raw.find(b'\0', offset)
        if end < offset:
            raise ProcessError('inspection-failed', 'Incomplete process arguments')
        result.append(os.fsdecode(raw[offset:end]))
        offset = end + 1
    return result


def process_record(pid, script):
    if type(pid) is not int or pid <= 1:
        raise ProcessError('invalid-pid', 'Invalid Tavern PID')
    script = Path(script).resolve()
    try:
        record = _linux(pid) if Path('/proc/self').exists() else _ps(pid)
    except (PermissionError, UnicodeError) as error:
        raise ProcessError('inspection-failed', 'Cannot inspect Tavern process safely') from error
    if record is None:
        return None
    if record['uid'] != os.getuid():
        raise ProcessError('wrong-owner', 'Tavern PID belongs to another user')
    if not command_matches(record['argv'], record['cwd'], script):
        raise ProcessError('wrong-entry', 'PID does not execute the reviewed Tavern program')
    return record


def same_process(current, saved):
    """Compare two observations made inside one bounded operation.

    The kernel identity is intentionally included here. Callers use this only
    to detect PID reuse or exec/session changes between inspection and signal.
    """
    return bool(current and saved and all(current.get(key) == value for key, value in saved.items()))


def same_runtime(current, saved):
    """Match durable runtime ownership without volatile kernel coordinates.

    Liveware may restore a container with the same owned process/configuration
    but a different /proc start tick, process group or session. Those values
    are valid race evidence inside one operation, but are not durable runtime
    identity. The executed command, working directory and OS owner are.
    """
    if not current or not saved or not saved.get('argv') or not saved.get('cwd'):
        return False
    return all(key not in saved or current.get(key) == saved[key]
               for key in ('argv', 'cwd', 'uid'))


def find_processes(script):
    script = Path(script)
    if Path('/proc/self').exists():
        candidates = (int(entry.name) for entry in Path('/proc').iterdir() if entry.name.isdigit())
    else:
        rows = subprocess.check_output(['ps', '-axo', 'pid=,uid=,comm='], text=True).splitlines()
        kind = 'python' if script.suffix == '.py' else 'node'
        candidates = [int(parts[0]) for row in rows if len(parts := row.split(None, 2)) == 3
                      and int(parts[1]) == os.getuid() and Path(parts[2]).name.lower().startswith(kind)]
    result = []
    for pid in candidates:
        if pid <= 1:
            continue
        try:
            record = process_record(pid, script)
        except ProcessError as error:
            if error.code in ('wrong-entry', 'wrong-owner'):
                continue
            raise
        if record:
            result.append(record)
    return result


def port_open(port):
    with socket.socket() as sock:
        sock.settimeout(0.3)
        return sock.connect_ex(('127.0.0.1', port)) == 0


def listener_pids(port):
    """Return evidence for a live TCP listener; unknown ownership fails closed."""
    if not port_open(port):
        return []
    if not Path('/proc/self').exists():
        result = subprocess.run(['lsof', '-nP', '-t', '-iTCP:' + str(port), '-sTCP:LISTEN'],
                                capture_output=True, text=True)
        pids = sorted({int(line) for line in result.stdout.splitlines() if line.isdigit()})
    else:
        inodes = set()
        for name in ('tcp', 'tcp6'):
            table = Path('/proc/net') / name
            if not table.exists():
                continue
            for row in table.read_text().splitlines()[1:]:
                fields = row.split()
                if fields[3] == '0A' and int(fields[1].rsplit(':', 1)[1], 16) == port:
                    inodes.add('socket:[' + fields[9] + ']')
        pids = set()
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit():
                continue
            try:
                if any(os.readlink(fd) in inodes for fd in (proc / 'fd').iterdir()):
                    pids.add(int(proc.name))
            except (PermissionError, FileNotFoundError, ProcessLookupError):
                continue
        pids = sorted(pids)
    if not pids and port_open(port):
        raise ProcessError('unknown-listener', 'Cannot identify Tavern port owner')
    return pids


def require_listener(record, script, port):
    if listener_pids(port) != [record['pid']] or not same_process(process_record(record['pid'], script), record):
        raise ProcessError('wrong-listener', 'Tavern health endpoint is not owned by the reviewed process')


def legacy_stop_patterns(script, port):
    name = Path(script).name
    if port is None:
        return [name]
    return [f'{name} --port {port}', f'{name} .*--port {port}', f'{name} {port}']


def stop_process(record, script, *, port=None, stop=None, timeout=20):
    """Stop Tavern with the legacy v1.24.12 command-line match."""
    mode = 'manager-stop'
    if stop:
        stop()
    else:
        mode = 'legacy-pkill'
        for pattern in legacy_stop_patterns(script, port):
            subprocess.run(['pkill', '-f', pattern], check=False)
    time.sleep(1)
    return {
        'pid': record.get('pid'),
        'originalAlive': None,
        'listenerPids': [],
        'port': port,
        'portOpenAfterStop': port_open(port) if port is not None else None,
        'mode': mode,
    }
