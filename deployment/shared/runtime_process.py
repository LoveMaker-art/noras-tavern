"""Current Tavern process operations."""
import os
from pathlib import Path
import signal
import socket
import time

try:
    import psutil
except ImportError:  # Linux release environments can use /proc without psutil.
    psutil = None


def _wrapped_os_denial(error):
    # Some macOS psutil C calls wrap syscall failures in SystemError instead
    # of AccessDenied. Unknown library faults must still remain visible.
    return isinstance(error.__cause__ or error.__context__, OSError)


def _argv(pid):
    if psutil is not None:
        try:
            return psutil.Process(int(pid)).cmdline()
        except (psutil.Error, OSError, ValueError):
            return []
        except SystemError as error:
            if _wrapped_os_denial(error):
                return []
            raise
    try:
        return [os.fsdecode(value) for value in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if value]
    except OSError:
        return []


def process_record(pid, script):
    if not pid:
        return None
    argv = _argv(pid)
    if psutil is not None:
        try:
            cwd = Path(psutil.Process(int(pid)).cwd()).resolve()
        except (psutil.Error, OSError, ValueError):
            return None
        except SystemError as error:
            if _wrapped_os_denial(error):
                return None
            raise
    else:
        try:
            cwd = Path(f"/proc/{pid}/cwd").resolve()
        except OSError:
            return None
    expected = Path(script).resolve()
    matched = any(
        (Path(value).resolve() if Path(value).is_absolute() else (cwd / value).resolve()) == expected
        for value in argv
        if value.endswith(("server.js", "server.py"))
    )
    if not matched:
        return None
    return {"pid": int(pid), "cwd": str(cwd), "argv": argv, "script": str(expected)}


def find_processes(script):
    result = []
    if psutil is not None:
        pids = psutil.pids()
    else:
        pids = [int(entry.name) for entry in Path("/proc").iterdir() if entry.name.isdigit()] if Path("/proc").is_dir() else []
    for pid in pids:
        record = process_record(pid, script)
        if record:
            result.append(record)
    return result


def same_runtime(current, saved):
    return bool(current and saved and current.get("cwd") == saved.get("cwd")
                and current.get("argv") == saved.get("argv"))


def port_open(port):
    with socket.socket() as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", int(port))) == 0


def require_listener(process, script, port):
    if not process_record(process["pid"], script) or not port_open(port):
        raise RuntimeError("Tavern 进程没有监听预期端口")
    return process


def verify_owned_listener(process, script, port):
    """Positive local OS evidence required before replacing old ownership."""
    if psutil is None:
        raise RuntimeError('local ownership recovery requires psutil')
    try:
        candidate = psutil.Process(int(process['pid']))
        created = candidate.create_time()
        owner = candidate.username()
        if hasattr(os, 'getuid'):
            same_owner = candidate.uids().real == os.getuid()
        else:
            same_owner = owner.casefold() == psutil.Process(os.getpid()).username().casefold()
        executable = str(Path(candidate.exe()).resolve())
        if not same_owner or Path(executable) != Path(process['argv'][0]).resolve():
            raise RuntimeError('Tavern executable or OS owner differs')
        listeners = candidate.net_connections(kind='tcp')
        if not any(connection.status == psutil.CONN_LISTEN and connection.laddr
                   and connection.laddr.port == int(port)
                   and connection.laddr.ip in ('127.0.0.1', '0.0.0.0')
                   for connection in listeners):
            raise RuntimeError('Tavern does not own the expected IPv4 listener')
        current = process_record(candidate.pid, script)
        if (not same_runtime(current, process) or psutil.Process(candidate.pid).create_time() != created
                or candidate.status() == psutil.STATUS_ZOMBIE):
            raise RuntimeError('Tavern changed during ownership inspection')
        evidence = {**current, 'exe': executable, 'owner': owner, 'created_at': created}
        if any(key in process and process[key] != evidence[key] for key in ('exe', 'owner', 'created_at')):
            raise RuntimeError('Tavern instance changed during ownership recovery')
        return evidence
    except (psutil.Error, OSError, ValueError) as error:
        raise RuntimeError('Tavern ownership inspection failed') from error


def stop_process(process, script, *, port=None, stop=None):
    pid = int(process["pid"])
    if stop:
        stop()
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return {"pid": pid, "stopped": True}
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and process_record(pid, script):
        time.sleep(0.1)
    if process_record(pid, script):
        os.kill(pid, signal.SIGKILL)
    return {"pid": pid, "stopped": True}
