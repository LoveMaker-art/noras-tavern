"""Own only the Hermes gateway launched inside this Nora installation."""

import json
import os
from pathlib import Path
import subprocess
import time

_launched_children = {}


def read_json(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def owned_gateway(nora_home):
    record = read_json(Path(nora_home) / "installer/gateway.json")
    if not record:
        return None
    import psutil
    try:
        process = psutil.Process(int(record["pid"]))
        if abs(process.create_time() - float(record["created"])) > 0.01:
            return None
        # macOS framework Python re-execs argv[0] while retaining PID, birth time and arguments.
        command = process.cmdline()
        if process.status() == psutil.STATUS_ZOMBIE or not command or command[1:] != record["command"][1:]:
            return None
        return process
    except (KeyError, ValueError, TypeError, psutil.Error):
        return None


def gateway_status(nora_home, hermes_home):
    process = owned_gateway(nora_home)
    state = read_json(Path(hermes_home) / "gateway_state.json")
    platforms = state.get("platforms") or {}
    platform = platforms.get("clawchat") or {} if isinstance(platforms, dict) else {}
    if not isinstance(platform, dict):
        platform = {}
    state_path = Path(hermes_home) / "gateway_state.json"
    current = bool(process and state.get("pid") == process.pid
                   and state_path.stat().st_mtime >= process.create_time()
                   and platform.get("writer_pid") == process.pid
                   and platform.get("writer_start_time") == state.get("start_time"))
    connected = current and platform.get("state") == "connected"
    return {
        "gatewayRunning": bool(process),
        "clawchatConnected": bool(connected),
        "clawchatState": platform.get("state", "unknown") if current else "offline",
    }


def start_gateway(nora_home, hermes_home, command, env, timeout=60):
    import psutil

    if not owned_gateway(nora_home):
        directory = Path(nora_home) / "installer"
        directory.mkdir(parents=True, exist_ok=True)
        # Do not adopt or stop another gateway started outside this launcher.
        foreign = read_json(Path(hermes_home) / "gateway_state.json")
        if foreign.get("pid") and psutil.pid_exists(int(foreign["pid"])):
            candidate = psutil.Process(int(foreign["pid"]))
            if "gateway" in candidate.cmdline():
                raise RuntimeError("此隔离目录已有其他方式启动的 Hermes，请先关闭该进程。")
        with (directory / "gateway.log").open("a", encoding="utf-8") as log:
            os.chmod(directory / "gateway.log", 0o600)
            options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
            child = subprocess.Popen(command, cwd=hermes_home, env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log, **options)
        _launched_children[child.pid] = child
        process = psutil.Process(child.pid)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError("Nora 启动后退出，请检查运行环境和 ClawChat 配置。")
            args = process.cmdline()
            if "gateway" in args and "run" in args:
                break
            time.sleep(0.1)
        record = {"pid": child.pid, "created": process.create_time(), "command": process.cmdline()}
        target = directory / "gateway.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(record), encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(target)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = gateway_status(nora_home, hermes_home)
        if result["clawchatConnected"]:
            return result
        if not result["gatewayRunning"]:
            raise RuntimeError("Nora 启动后退出，请检查运行环境和 ClawChat 配置。")
        time.sleep(0.5)
    raise RuntimeError("Nora 已启动，但 ClawChat 未在一分钟内连通。请检查网络或重新配对。")


def stop_gateway(nora_home):
    import psutil

    process = owned_gateway(nora_home)
    if process:
        child_handle = _launched_children.pop(process.pid, None)
        children = process.children(recursive=True)
        process.terminate()
        _, alive = psutil.wait_procs([process], timeout=15)
        for child in children:
            try:
                if child.is_running():
                    child.terminate()
            except psutil.NoSuchProcess:
                pass
        _, remaining = psutil.wait_procs(children + alive, timeout=5)
        for child in remaining:
            child.kill()
        psutil.wait_procs(remaining, timeout=5)
        if owned_gateway(nora_home):
            raise RuntimeError("Nora 尚未停止，请重试。")
        if child_handle:
            child_handle.wait(timeout=5)
    (Path(nora_home) / "installer/gateway.json").unlink(missing_ok=True)


def clawchat_paired(hermes_home):
    try:
        from dotenv import dotenv_values
        import yaml
    except ImportError:
        return False
    try:
        root = Path(hermes_home)
        config = yaml.safe_load((root / "config.yaml").read_text(encoding="utf-8")) or {}
        platform = config.get("platforms", {}).get("clawchat", {})
        values = dotenv_values(root / ".env")
        return bool(platform.get("enabled") and values.get("CLAWCHAT_TOKEN") and values.get("CLAWCHAT_HOME_CHANNEL"))
    except (OSError, ValueError, AttributeError, yaml.YAMLError):
        return False


def stop_liveware(hermes_home):
    import psutil
    target = (Path(hermes_home) / 'clawchat/liveware' / ('liveware.exe' if os.name == 'nt' else 'liveware')).resolve()
    selected = []
    for process in psutil.process_iter(['exe', 'cmdline']):
        try:
            if process.info['exe'] and Path(process.info['exe']).resolve() == target and 'agent' in (process.info['cmdline'] or []):
                process.terminate()
                selected.append(process)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    _, alive = psutil.wait_procs(selected, timeout=10)
    for process in alive:
        process.kill()
    _, alive = psutil.wait_procs(alive, timeout=5)
    if alive:
        raise RuntimeError('手机连接服务尚未停止，暂不替换系统。')
