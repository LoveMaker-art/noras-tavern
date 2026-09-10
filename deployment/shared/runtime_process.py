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


def _argv(pid):
    if psutil is not None:
        try:
            return psutil.Process(int(pid)).cmdline()
        except (psutil.Error, OSError, ValueError):
            return []
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
