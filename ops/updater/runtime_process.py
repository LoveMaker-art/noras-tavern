"""Current Tavern process operations."""
import os
from pathlib import Path
import signal
import socket
import time


def _argv(pid):
    try:
        return [os.fsdecode(value) for value in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if value]
    except OSError:
        return []


def process_record(pid, script):
    if not pid:
        return None
    argv = _argv(pid)
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
    for entry in Path("/proc").iterdir() if Path("/proc").is_dir() else []:
        if entry.name.isdigit():
            record = process_record(int(entry.name), script)
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
    while time.monotonic() < deadline and Path(f"/proc/{pid}").exists():
        time.sleep(0.1)
    if Path(f"/proc/{pid}").exists():
        os.kill(pid, signal.SIGKILL)
    return {"pid": pid, "stopped": True}
