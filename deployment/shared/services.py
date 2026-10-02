"""Own only the Hermes gateway launched inside this Nora installation."""

import json
import hmac
import math
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time

_launched_children = {}
_GATEWAY_IDENTITY_MESSAGE = (
    "无法确认安装记录中的后台进程是否属于诺拉：系统拒绝读取进程信息。"
    "为避免启动重复服务，本次未启动新的诺拉，也未结束任何进程。"
    "请重启电脑后再试；若仍出现此提示，请保留诊断日志联系支持。"
)
_GATEWAY_STATUS_MESSAGE = "无法查询诺拉后台状态：系统拒绝读取进程信息。"


class GatewayIdentityError(RuntimeError):
    """Readable explanation with a fixed technical permission classification."""
    code = "EACCES"
    user_code = 'GATEWAY_IDENTITY'


def read_json(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _before_windows_boot(timestamp):
    import psutil
    if sys.platform != "win32":
        return False
    try:
        return timestamp < psutil.boot_time() - 1
    except (psutil.Error, OSError):
        return False


def owned_gateway(nora_home, *, require_readable=False):
    record = read_json(Path(nora_home) / "installer/gateway.json")
    if not record:
        return None
    import psutil
    try:
        created = float(record["created"])
        if not math.isfinite(created):
            return None
        if require_readable and _before_windows_boot(created):
            return _gateway_successor(nora_home, record, require_readable=require_readable)
        process = psutil.Process(int(record["pid"]))
        if abs(process.create_time() - created) > 0.01:
            return _gateway_successor(nora_home, record, require_readable=require_readable)
        # macOS framework Python re-execs argv[0] while retaining PID, birth time and arguments.
        command = process.cmdline()
        if process.status() == psutil.STATUS_ZOMBIE or not command or command[1:] != record["command"][1:]:
            return _gateway_successor(nora_home, record, require_readable=require_readable)
        return process
    except psutil.AccessDenied as cause:
        if require_readable:
            raise GatewayIdentityError(_GATEWAY_IDENTITY_MESSAGE) from cause
        return None
    except (KeyError, ValueError, TypeError, psutil.Error):
        return _gateway_successor(nora_home, record, require_readable=require_readable)


def _gateway_successor(nora_home, record, *, require_readable):
    """Follow a launcher-owned self-restart, never a process identified by PID alone."""
    import psutil
    token = record.get('ownerToken')
    command = record.get('launchCommand', record.get('command'))
    if (not isinstance(token, str) or len(token) != 64
            or any(c not in '0123456789abcdef' for c in token)
            or not isinstance(command, list)
            or not command or not Path(str(command[0])).is_absolute()
            or command[1:] not in (['-m', 'hermes_cli.main', 'gateway', 'run'],
                                   ['-m', 'hermes_cli.main', 'gateway', 'run', '--replace'])):
        return None
    try:
        home = Path(record['hermesHome']).resolve()
        if home == Path(nora_home).resolve() or not home.is_relative_to(Path(nora_home).resolve()):
            return None
        state_path = home / 'gateway_state.json'
        pid_path = home / 'gateway.pid'
        state, pid_record = read_json(state_path), read_json(pid_path)
        candidate = psutil.Process(int(state['pid']))
        created = candidate.create_time()
        if (candidate.status() == psutil.STATUS_ZOMBIE or state_path.stat().st_mtime < created
                or pid_path.stat().st_mtime < created):
            return None
        args = candidate.cmdline()
        if not _gateway_restart_command(args, home):
            return None
        executables = {Path(command[0]).resolve()}
        if (sys.platform == 'win32'
                and Path(command[0]).resolve() == (home / 'hermes-agent/venv/Scripts/python.exe').resolve()):
            # Windows venv Python is a launcher PE; its writer uses bundled base Python.
            executables.add((home / 'python/python.exe').resolve())
        if Path(candidate.exe()).resolve() not in executables:
            return None
        environment = candidate.environ()
        actual_token = environment.get('NORA_LAUNCHER_GATEWAY_OWNER', '')
        if (not isinstance(actual_token, str) or not hmac.compare_digest(token, actual_token)
                or Path(environment.get('HERMES_HOME', '')).resolve() != home):
            return None
        fingerprint = int(round(created * 100))
        if sys.platform.startswith('linux'):
            # Hermes stores Linux start ticks, and epoch centiseconds on Mac/Windows.
            try:
                stat = Path(f'/proc/{candidate.pid}/stat').read_text()
                fingerprint = int(stat[stat.rfind(')') + 2:].split()[19])
            except (OSError, ValueError, IndexError):
                pass
        for identity in (state, pid_record):
            if (identity.get('pid') != candidate.pid or identity.get('kind') != 'hermes-gateway'
                    or identity.get('start_time') != fingerprint
                    or Path(str(identity.get('hermes_home', ''))).resolve() != home):
                return None
        fresh = psutil.Process(candidate.pid)
        if (fresh.create_time() != created or fresh.status() == psutil.STATUS_ZOMBIE
                or fresh.cmdline() != args):
            return None
        return fresh
    except psutil.AccessDenied as cause:
        if require_readable:
            raise GatewayIdentityError(_GATEWAY_IDENTITY_MESSAGE) from cause
        return None
    except (KeyError, TypeError, ValueError, OSError, psutil.Error):
        return None


def check_gateway_control(nora_home, hermes_home):
    """An unknown live gateway must not be mistaken for an already stopped service."""
    if not owned_gateway(nora_home, require_readable=True):
        _check_gateway_hint(hermes_home)


def _gateway_restart_command(command, home):
    """Known Hermes module/CLI forms used by its own detached restart helper."""
    if command[1:] in (['-m', 'hermes_cli.main', 'gateway', 'run'],
                       ['-m', 'hermes_cli.main', 'gateway', 'run', '--replace'],
                       ['-m', 'hermes_cli.main', 'gateway', 'restart']):
        return True
    entries = {(home / 'hermes-agent/venv/bin/hermes').resolve(),
               (home / 'hermes-agent/hermes_cli/main.py').resolve()}
    if sys.platform == 'win32':
        entries.add((home / 'hermes-agent/venv/Scripts/hermes.exe').resolve())
    return (len(command) >= 2 and Path(command[1]).is_absolute() and Path(command[1]).resolve() in entries
            and command[2:] in (['gateway', 'run'], ['gateway', 'run', '--replace'], ['gateway', 'restart']))


def gateway_status(nora_home, hermes_home):
    try:
        process = owned_gateway(nora_home, require_readable=True)
    except GatewayIdentityError as cause:
        raise GatewayIdentityError(_GATEWAY_STATUS_MESSAGE) from cause.__cause__
    if process is None:
        # First-install inspection does not require psutil before the runtime exists.
        return {"gatewayRunning": False, "clawchatConnected": False, "clawchatState": "offline"}
    import psutil
    try:
        state = read_json(Path(hermes_home) / "gateway_state.json")
        platforms = state.get("platforms") or {}
        platform = platforms.get("clawchat") or {} if isinstance(platforms, dict) else {}
        if not isinstance(platform, dict):
            platform = {}
        writer = process
        if process and state.get("pid") != process.pid:
            # Windows venv launchers retain a parent and run Python in a child.
            writer = None
            try:
                command = process.cmdline()
                for child in process.children(recursive=True):
                    if (child.pid == state.get("pid") and child.status() != psutil.STATUS_ZOMBIE
                            and child.cmdline()[1:] == command[1:]):
                        writer = child
                        break
            except psutil.AccessDenied:
                raise
            except psutil.Error:
                writer = None
        state_path = Path(hermes_home) / "gateway_state.json"
        current = bool(writer and state.get("pid") == writer.pid
                       and state_path.stat().st_mtime >= writer.create_time()
                       and platform.get("writer_pid") == writer.pid
                       and platform.get("writer_start_time") == state.get("start_time"))
        connected = current and platform.get("state") == "connected"
        return {
            "gatewayRunning": bool(process),
            "clawchatConnected": bool(connected),
            "clawchatState": platform.get("state", "unknown") if current else "offline",
        }
    except psutil.AccessDenied as cause:
        # A denied inspection is no evidence of a stopped or disconnected service.
        raise GatewayIdentityError(_GATEWAY_STATUS_MESSAGE) from cause


def _check_gateway_hint(hermes_home):
    """A runtime-state PID is a hint; never signal or adopt its process."""
    import psutil

    state_path = Path(hermes_home) / "gateway_state.json"
    state = read_json(state_path)
    try:
        pid = int(state.get("pid", 0))
    except (ValueError, TypeError, OverflowError):
        return
    if pid <= 0:
        return
    try:
        modified = state_path.stat().st_mtime
    except FileNotFoundError:
        return
    # A pre-reboot snapshot cannot identify a live Windows user process.
    if _before_windows_boot(modified):
        return
    try:
        candidate = psutil.Process(pid)
        # Windows can expose creation time while denying cmdline/OpenProcess.
        # Reject a reused PID before attempting that higher-privilege inspection.
        try:
            if candidate.create_time() > modified + 1:
                return
        except psutil.AccessDenied:
            pass
        if "gateway" in candidate.cmdline():
            raise RuntimeError("此隔离目录已有其他方式启动的 Hermes，请先关闭该进程。")
    except psutil.NoSuchProcess:
        return
    except psutil.AccessDenied as cause:
        raise GatewayIdentityError(_GATEWAY_IDENTITY_MESSAGE) from cause


def start_gateway(nora_home, hermes_home, command, env, timeout=60):
    import psutil

    process = owned_gateway(nora_home, require_readable=True)
    directory = Path(nora_home) / "installer"
    if not process:
        directory.mkdir(parents=True, exist_ok=True)
        # Do not adopt or stop another gateway started outside this launcher.
        _check_gateway_hint(hermes_home)
        owner_token = secrets.token_hex(32)
        environment = {**env, 'HERMES_HOME': str(Path(hermes_home).resolve()),
                       'NORA_LAUNCHER_GATEWAY_OWNER': owner_token}
        with (directory / "gateway.log").open("a", encoding="utf-8") as log:
            os.chmod(directory / "gateway.log", 0o600)
            options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
            child = subprocess.Popen(command, cwd=hermes_home, env=environment, stdin=subprocess.DEVNULL,
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
        record = {"pid": child.pid, "created": process.create_time(), "command": process.cmdline(),
                  'launchCommand': list(command), 'ownerToken': owner_token,
                  'hermesHome': str(Path(hermes_home).resolve())}
        _write_gateway_record(directory, record)
    else:
        record = read_json(directory / 'gateway.json')
        if record.get('pid') != process.pid or record.get('command') != process.cmdline():
            fresh = psutil.Process(process.pid)
            if fresh.create_time() != process.create_time() or fresh.cmdline() != process.cmdline():
                raise RuntimeError('诺拉后台进程在检查期间发生变化，请重试。')
            _write_gateway_record(directory, {**record, 'pid': process.pid,
                'created': process.create_time(), 'command': process.cmdline()})
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = gateway_status(nora_home, hermes_home)
        if result["clawchatConnected"]:
            return result
        if not result["gatewayRunning"]:
            raise RuntimeError("Nora 启动后退出，请检查运行环境和 ClawChat 配置。")
        time.sleep(0.5)
    raise RuntimeError("Nora 已启动，但 ClawChat 未在一分钟内连通。请检查网络或重新配对。")


def _write_gateway_record(directory, record):
    target = directory / 'gateway.json'
    descriptor, name = tempfile.mkstemp(prefix='gateway-', suffix='.tmp', dir=directory)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(json.dumps(record))
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def stop_gateway(nora_home, *, hermes_home=None, preserve_liveware_home=None):
    import psutil

    home = Path(hermes_home) if hermes_home is not None else Path(nora_home) / 'hermes'
    process = owned_gateway(nora_home, require_readable=True)
    if process is None:
        _check_gateway_hint(home)
    if process:
        child_handle = _launched_children.pop(process.pid, None)
        children = process.children(recursive=True)
        if preserve_liveware_home is not None:
            executable = (Path(preserve_liveware_home) / "clawchat/liveware" /
                          ("liveware.exe" if os.name == "nt" else "liveware")).resolve()
            retained = []
            for child in children:
                try:
                    if Path(child.exe()).resolve() != executable or "agent" not in child.cmdline():
                        retained.append(child)
                except psutil.NoSuchProcess:
                    pass
            children = retained
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
        if owned_gateway(nora_home, require_readable=True):
            raise RuntimeError("Nora 尚未停止，请重试。")
        _check_gateway_hint(home)
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
        raise RuntimeError('ClawChat 连接服务尚未停止，暂不替换系统。')
