#!/usr/bin/env python3
"""JSON-line bridge for a Nora Tavern desktop launcher shell.

The HTML launcher cannot execute local commands by itself. A desktop shell can
spawn this bridge and forward its JSON events to ``window.NoraLauncherBridge``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import webbrowser
import re
import importlib.util
import traceback
import time

try:
    from . import nora_system, nora_profile
    from .launcher_services import clawchat_paired, gateway_status, start_gateway, stop_gateway, stop_liveware
except ImportError:
    import nora_system
    import nora_profile
    from launcher_services import clawchat_paired, gateway_status, start_gateway, stop_gateway, stop_liveware


HERE = Path(__file__).resolve().parent


def emit(event: str, **payload) -> None:
    print(json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def fail(message: str) -> None:
    emit("error", message=message)
    raise SystemExit(1)


def safe(path: str | Path) -> Path:
    value = Path(path).expanduser().resolve()
    if value == Path("/"):
        raise RuntimeError("拒绝使用根目录作为安装目录")
    return value


def require_descendant(root: Path, child: Path, label: str) -> None:
    if child == root:
        raise RuntimeError(f"{label} 必须是隔离目录内的子目录")
    try:
        child.relative_to(root)
    except ValueError as error:
        raise RuntimeError(f"{label} 必须位于 Nora Tavern 隔离目录内：{root}") from error


def default_nora_home() -> Path:
    if os.environ.get("NORA_TAVERN_HOME"):
        return safe(os.environ["NORA_TAVERN_HOME"])
    if sys.platform == "darwin":
        return safe(Path.home() / "Library/NoraTavern")
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
        return safe(base / "NoraTavern")
    base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    return safe(base / "nora-tavern")


def default_hermes_home(root: Path) -> Path:
    return safe(os.environ.get("HERMES_HOME") or root / "hermes")


def default_install_root(root: Path) -> Path:
    return safe(os.environ.get("TAVERN_DATA_ROOT") or root / "tavern")


def env_for(nora_home: Path, hermes_home: Path, install_root: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["NORA_TAVERN_HOME"] = str(nora_home)
    env["NORA_HERMES_HOME"] = str(hermes_home)
    env["HERMES_HOME"] = str(hermes_home)
    env["HERMES_INSTALL_DIR"] = str(hermes_home / "hermes-agent")
    env["TAVERN_DATA_ROOT"] = str(install_root)
    env["PYTHONPATH"] = str(hermes_home / "hermes-agent")
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    if os.name == "nt":
        env["USERPROFILE"] = str(hermes_home)
        env["APPDATA"] = str(nora_home / "appdata/roaming")
        env["LOCALAPPDATA"] = str(nora_home / "appdata/local")
        additions = [
            str(hermes_home / "clawchat/liveware"),
            str(hermes_home / ".local/bin"),
            str(hermes_home / "bin"),
            str(hermes_home / "node"),
            str(hermes_home / "hermes-agent"),
            str(hermes_home / "hermes-agent/Scripts"),
            str(hermes_home / "hermes-agent/venv/Scripts"),
        ]
    else:
        env["HOME"] = str(hermes_home)
        env["XDG_CACHE_HOME"] = str(nora_home / "cache")
        env["XDG_DATA_HOME"] = str(nora_home / "data")
        additions = [
            str(hermes_home / "clawchat/liveware"),
            str(hermes_home / ".local/bin"),
            str(hermes_home / "bin"),
            str(hermes_home / "node/bin"),
            str(hermes_home / "hermes-agent"),
            str(hermes_home / "hermes-agent/bin"),
            str(hermes_home / "hermes-agent/venv/bin"),
        ]
    env["PATH"] = os.pathsep.join([*additions, env.get("PATH", "")])
    return env


def hermes_command(nora_home: Path, hermes_home: Path, install_root: Path) -> str | None:
    name = "hermes.exe" if os.name == "nt" else "hermes"
    marker = hermes_home / "hermes-agent/.hermes-bootstrap-complete"
    if not marker.is_file():
        return None
    candidates = [
        hermes_home / "hermes-agent/venv/bin" / name,
        hermes_home / "hermes-agent/venv/Scripts" / name,
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def python_command(hermes_home: Path) -> str:
    name = "python.exe" if os.name == "nt" else "python3"
    candidates = [
        hermes_home / "hermes-agent/venv/Scripts" / name,
        hermes_home / "hermes-agent/venv/bin" / name,
        hermes_home / "hermes-agent/venv/bin/python",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return sys.executable


def ensure_hermes(nora_home: Path, hermes_home: Path, install_root: Path) -> None:
    hermes_home.mkdir(parents=True, exist_ok=True)
    command = hermes_command(nora_home, hermes_home, install_root)
    if command and subprocess.run(
        [command, "--version"],
        capture_output=True,
        env=env_for(nora_home, hermes_home, install_root),
        timeout=30,
    ).returncode == 0:
        emit("log", line="已检测到 Hermes")
        return
    fail("未找到完整的 Nora 运行时，请通过桌面整合包安装。")


def release_dir(value: str | None) -> Path | None:
    if value:
        return Path(value).expanduser().resolve()
    candidates = (
        HERE / "payload",
        HERE / "package" / "payload",
        Path.cwd() / "payload",
    )
    for candidate in candidates:
        if (candidate / "nora-tavern-first-install-bootstrap.py").is_file():
            return candidate.resolve()
    return None


def installed(install_root: Path) -> bool:
    return (
        install_root / "apps/tavern-runtime/native-runtime.json"
    ).is_file() and (
        install_root / "apps/tavern-runtime/native_lifecycle.py"
    ).is_file()


ANSI = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def run_stream(command: list[str], *, env: dict[str, str] | None = None) -> None:
    started = time.monotonic()
    emit("command", command=command)
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        bufsize=1,
    )
    emit("diagnostic", operation="subprocess-start", pid=process.pid, command=command)
    assert process.stdout is not None
    for line in process.stdout:
        line = ANSI.sub("", line).rstrip()
        if line:
            try:
                message = json.loads(line)
            except ValueError:
                emit("log", line=line, stream="combined")
            else:
                if isinstance(message, dict) and message.get("event"):
                    emit(message.pop("event"), **message)
                else:
                    emit("log", line=line, stream="combined")
    code = process.wait()
    emit("diagnostic", operation="subprocess-exit", pid=process.pid, exitCode=code,
         durationMs=round((time.monotonic() - started) * 1000))
    if code:
        fail(f"命令执行失败，退出码 {code}")


def run_json(command: list[str], *, env: dict[str, str] | None = None, timeout: int = 60) -> dict:
    result = subprocess.run(command, text=True, capture_output=True, env=env, timeout=timeout)
    if result.returncode:
        return {"ok": False, "error": (result.stderr or result.stdout).strip()}
    try:
        return json.loads(result.stdout)
    except ValueError:
        return {"ok": False, "error": "命令没有返回 JSON", "output": result.stdout}


def read_version(install_root: Path) -> dict:
    value = nora_system.read_json(install_root / "tavern-updates/installed.json")
    if value.get("version"):
        return {"version": value.get("version"), "commit": value.get("commit"), "versionSource": "receipt"}
    try:
        version = (install_root / "apps/tavern-runtime/.tavern-release-version").read_text(encoding="utf-8").strip()
        if re.fullmatch(r"v?\d+\.\d+\.\d+(?:-beta\.\d+)?", version):
            return {"version": version, "commit": None, "versionSource": "legacy-runtime"}
    except OSError:
        pass
    return {"version": None, "commit": None, "versionSource": "unknown"}


def read_verified_model(nora_home: Path, hermes_home: Path, problems: list[str] | None = None) -> dict:
    def reject(reason: str) -> dict:
        if problems is not None:
            problems.append(reason)
        return {}

    marker = nora_home / "installer/model.json"
    env_file = hermes_home / ".env"
    config_file = hermes_home / "config.yaml"
    if not marker.is_file() or not config_file.is_file():
        return reject("未找到模型配置或验证记录")
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
        provider = str(value.get("provider") or "").strip()
        model = str(value.get("model") or "").strip()
        key_env = str(value.get("keyEnv") or "").strip()
        base_url = str(value.get("baseUrl") or "").strip().rstrip("/")
        if value.get("schema") != 1 or not provider or not model:
            return reject("模型验证记录格式无效")
        is_custom = provider == "custom" or (provider.startswith("custom:") and bool(provider[7:].strip()))
        env_values = {}
        if env_file.is_file():
            for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
                match = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)$", line)
                if match:
                    env_values[match.group(1)] = match.group(2).strip().strip("\"'")
        if not is_custom and (not re.match(r"^[A-Z0-9_]+$", key_env) or not env_values.get(key_env)):
            return reject("未找到供应商密钥配置")

        try:
            import yaml
        except ImportError:
            return reject("无法读取模型配置格式")
        try:
            config = yaml.safe_load(config_file.read_text(encoding="utf-8")) or {}
            model_config = config.get("model")
            if not isinstance(model_config, dict):
                return reject("缺少模型配置")
            if str(model_config.get("provider") or "").strip() != provider:
                return reject("供应商与验证记录不一致")
            configured_model = str(model_config.get("default") or model_config.get("name") or "").strip()
            if configured_model != model:
                return reject("模型名称与验证记录不一致")
            if is_custom:
                configured_base_url = str(model_config.get("base_url") or "").strip().rstrip("/")
                configured_key = str(model_config.get("api_key") or "").strip()
                if not base_url or configured_base_url != base_url:
                    return reject("接口地址与验证记录不一致")
                if not configured_key:
                    return reject("未找到自定义模型密钥配置")
        except (OSError, ValueError, AttributeError, yaml.YAMLError):
            return reject("无法读取模型配置")
        return {"provider": provider, "model": model, "keyEnv": key_env, "baseUrl": base_url}
    except (OSError, ValueError, AttributeError):
        return reject("无法读取模型验证记录")


def status_payload(nora_home: Path, hermes_home: Path, install_root: Path, port: int) -> dict:
    system = nora_system.inspect(hermes_home, install_root, port)
    hermes = hermes_command(nora_home, hermes_home, install_root)
    # Installed files and live service health are separate facts. Avoid booting
    # the entire Hermes CLI on every five-second status poll.
    hermes_ready = bool(hermes and (hermes_home / "hermes-agent/.hermes-bootstrap-complete").is_file())
    verified_model = read_verified_model(nora_home, hermes_home)
    credentials_ready = bool(verified_model)
    connection = gateway_status(nora_home, hermes_home)
    clawchat_connected = connection["clawchatConnected"]
    paired = clawchat_paired(hermes_home)
    profile_ready = paired and nora_profile.ready(hermes_home)
    if not installed(install_root):
        return {
            "installed": False,
            "systemReady": False,
            "setupCompleted": False,
            "running": False,
            "hermesInstalled": hermes_ready,
            "noraInstalled": nora_system.files_ready(hermes_home),
            "modelConfigured": credentials_ready,
            "modelProvider": verified_model.get("provider", ""),
            "modelName": verified_model.get("model", ""),
            "modelBaseUrl": verified_model.get("baseUrl", ""),
            "clawchatConnected": clawchat_connected,
            "clawchatPaired": paired,
            **connection,
            "port": port,
            "url": f"http://127.0.0.1:{port}",
            "home": str(nora_home),
            "noraHome": str(nora_home),
            "hermesHome": str(hermes_home),
            "installRoot": str(install_root),
        }
    lifecycle = install_root / "apps/tavern-runtime/native_lifecycle.py"
    status = run_json(
        [python_command(hermes_home), "-B", str(lifecycle), "status", "--port", str(port)],
        env=env_for(nora_home, hermes_home, install_root),
    )
    running = bool(status.get("health", {}).get("ok"))
    payload = {
        "installed": True,
        "systemReady": system["ready"],
        "setupCompleted": system["setupCompleted"] and profile_ready,
        "clawchatProfileReady": profile_ready,
        "systemProblems": system["problems"],
        "running": running,
        "hermesInstalled": hermes_ready,
        "noraInstalled": nora_system.files_ready(hermes_home),
        "modelConfigured": credentials_ready,
        "modelProvider": verified_model.get("provider", ""),
        "modelName": verified_model.get("model", ""),
        "modelBaseUrl": verified_model.get("baseUrl", ""),
        "clawchatConnected": clawchat_connected,
        "clawchatPaired": paired,
        **connection,
        "port": int(status.get("port") or port),
        "url": f"http://127.0.0.1:{int(status.get('port') or port)}",
        "home": str(nora_home),
        "noraHome": str(nora_home),
        "hermesHome": str(hermes_home),
        "installRoot": str(install_root),
        "pid": status.get("native_pid"),
        "warning": "",
    }
    payload.update(read_version(install_root))
    if status.get("inspection_error"):
        payload["warning"] = status["inspection_error"]
    if status.get("error"):
        payload["warning"] = status["error"]
    if running and paired:
        registration = nora_system.read_json(install_root / "tavern-state/liveware-ready.json")
        if registration.get("status") != "ready" and not payload["warning"]:
            payload["warning"] = ("ClawChat 酒馆入口仍在准备，可先与诺拉对话。" if clawchat_connected
                                  else "ClawChat 酒馆入口尚未就绪。")
    return payload


def command_status(args) -> None:
    emit("result", **status_payload(args.nora_home, args.hermes_home, args.install_root, args.port))


def command_install(args) -> None:
    system = nora_system.inspect(args.hermes_home, args.install_root, args.port)
    payload = release_dir(args.release_dir)
    target = nora_system.read_json(payload / "release-manifest.json") if payload else {}
    current = read_version(args.install_root)
    matches_target = not payload or (target.get("versions", {}).get("tavern") == current.get("version")
                                    and bool(target.get("commit")) and target["commit"] == current.get("commit"))
    if installed(args.install_root) and system["ready"] and matches_target:
        command_status(args)
        return
    if gateway_status(args.nora_home, args.hermes_home).get("gatewayRunning"):
        fail("请先停止 Nora，再继续初始化。现有配置与数据已保留。")
    if installed(args.install_root) and status_payload(args.nora_home, args.hermes_home, args.install_root, args.port).get("running"):
        fail("请先停止酒馆，再继续初始化。现有配置与数据已保留。")
    bootstrap = (payload / "nora-tavern-first-install-bootstrap.py") if payload else (HERE / "bootstrap.py")
    if not bootstrap.is_file():
        fail("没有找到首次安装器。")
    emit("milestone", index=0, state="running", task="安装 Nora")
    emit("log", line="开始首次安装")
    ensure_hermes(args.nora_home, args.hermes_home, args.install_root)
    command = [
        python_command(args.hermes_home),
        "-u",
        "-B",
        str(bootstrap),
        "--nora-home",
        str(args.nora_home),
        "--hermes-home",
        str(args.hermes_home),
        "--install-root",
        str(args.install_root),
        "--port",
        str(args.port),
        "--apply",
        "--confirm",
        "--skip-liveware",
        "--dedicated-nora",
    ]
    # An interrupted first install may leave program directories but no receipt.
    # The first installer snapshots affected paths before resuming initialization.
    if any((args.install_root / item).exists() for item in ("apps/tavern-runtime", "apps/tavern-ops", "apps/nora-mcp", "tavern-state/native-runtime")):
        command.append("--force-first-install")
    if payload:
        command += ["--release-dir", str(payload)]
        try:
            manifest = json.loads((payload / "release-manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            manifest = {}
        if manifest.get("schema") == "tavern-release/v2" and manifest.get("candidate") is True:
            command.append("--allow-candidate")
    run_stream(command, env=env_for(args.nora_home, args.hermes_home, args.install_root))
    emit("result", **status_payload(args.nora_home, args.hermes_home, args.install_root, args.port))


def command_start(args) -> None:
    service = getattr(args, "service", "all")
    if not installed(args.install_root):
        fail("还没有安装 Nora Tavern。")
    system = nora_system.inspect(args.hermes_home, args.install_root, args.port)
    if not system["ready"]:
        fail("Nora 初始化未完成：" + "；".join(system["problems"][:3]))
    lifecycle = args.install_root / "apps/tavern-runtime/native_lifecycle.py"
    if service != "tavern" and not read_verified_model(args.nora_home, args.hermes_home):
        fail("请先配置并测试模型。")
    if service != "tavern" and not clawchat_paired(args.hermes_home):
        fail("请先连接 ClawChat。")
    if service != "tavern":
        sync_nora_profile(args)
    emit("milestone", index=4, state="running", task="正在启动服务")
    env = env_for(args.nora_home, args.hermes_home, args.install_root)
    if service != "nora":
        run_stream([python_command(args.hermes_home), "-u", "-B", str(lifecycle), "start", "--port", str(args.port)], env=env)
    if service != "tavern":
        emit("task", task="正在连接 ClawChat")
        start_gateway(args.nora_home, args.hermes_home,
                      [python_command(args.hermes_home), "-m", "hermes_cli.main", "gateway", "run"], env)
    if service == "nora":
        emit("result", **status_payload(args.nora_home, args.hermes_home, args.install_root, args.port))
        return
    if service == "tavern" and not clawchat_paired(args.hermes_home):
        emit("result", **status_payload(args.nora_home, args.hermes_home, args.install_root, args.port))
        return
    emit("task", task="正在准备 ClawChat 连接组件")
    require_bundled_clawchat(args.hermes_home)
    # The gateway and launcher share one idempotent registration worker.
    # Registration and the model greeting run independently.
    run_stream([python_command(args.hermes_home), "-B",
                str(args.hermes_home / "hooks/tavern-liveware-register/handler.py")], env=env)
    if service == "tavern":
        emit("result", **status_payload(args.nora_home, args.hermes_home, args.install_root, args.port))
        return
    status = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    if not (status["running"] and status["clawchatConnected"]):
        fail("启动检查未通过，请检查服务连接后重试。")
    nora_system.verify_runtime(args.hermes_home, args.install_root, args.port, python_command(args.hermes_home), env)
    nora_system.mark_setup_complete(args.install_root)
    status = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    emit("milestone", index=4, state="done", task="启动检查通过")
    emit("result", **status)


def command_stop(args) -> None:
    service = getattr(args, "service", "all")
    emit("task", task="正在停止" + {"nora": "诺拉", "tavern": "酒馆", "all": "诺拉与酒馆"}[service])
    errors = []
    if service != "tavern":
        try:
            if service == "nora":
                stop_gateway(args.nora_home, preserve_liveware_home=args.hermes_home)
            else:
                stop_gateway(args.nora_home)
        except Exception as error:
            errors.append(str(error))
    if service != "nora":
        from contextlib import nullcontext
        try:
            lock = nullcontext()
            if installed(args.install_root):
                spec = importlib.util.spec_from_file_location(
                    "launcher_registration_lock", args.install_root / "apps/tavern-ops/updater/runtime_lock.py")
                locks = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(locks)
                lock = locks.installation_lock(args.install_root / "tavern-state", "liveware-registration.lock")
            # Serialize against registration, then stop the tunnel after the local runtime.
            with lock:
                if installed(args.install_root):
                    lifecycle = args.install_root / "apps/tavern-runtime/native_lifecycle.py"
                    run_stream([python_command(args.hermes_home), "-B", str(lifecycle), "stop"],
                               env=env_for(args.nora_home, args.hermes_home, args.install_root))
                stop_liveware(args.hermes_home)
        except SystemExit:
            errors.append("酒馆停止命令未完成")
        except Exception as error:
            errors.append(str(error))
    status = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    if errors:
        raise RuntimeError("；".join(errors))
    if (service != "nora" and status["running"]) or (service != "tavern" and status["gatewayRunning"]):
        fail("服务尚未完全停止，请重试。")
    emit("result", **status)


def require_bundled_clawchat(home: Path) -> None:
    required = [home / "plugins/clawchat/clawchat_cli.py", home / "plugins/clawchat/plugin.yaml",
                home / "nora-components.json", home / "nora-clawchat-check.py",
                home / "clawchat/liveware" / ("liveware.exe" if os.name == "nt" else "liveware")]
    if not all(file.is_file() for file in required):
        fail("当前安装缺少内置 ClawChat / Liveware，请使用新版完整安装包修复；已有模型配置无需重填。")


def sync_nora_profile(args) -> None:
    if nora_profile.ready(args.hermes_home):
        return
    emit("task", task="正在设置诺拉的名字和头像")
    try:
        result = run_json([python_command(args.hermes_home), "-B", str(HERE / "nora_profile.py"),
                           str(args.hermes_home)],
                          env=env_for(args.nora_home, args.hermes_home, args.install_root), timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        result = {"ok": False}
    if result.get("ok") is not True or not nora_profile.ready(args.hermes_home):
        fail("ClawChat 已配对，但诺拉的名字和头像未完成同步。配对已保留，请重试。")


def command_pair(args) -> None:
    body = json.load(sys.stdin)
    code = str(body.get("code") or "").strip()
    if not code or len(code) > 4096 or any(ch.isspace() for ch in code):
        fail("请填写 ClawChat 提供的配对码，不要粘贴整条命令。")
    env = env_for(args.nora_home, args.hermes_home, args.install_root)
    hermes = hermes_command(args.nora_home, args.hermes_home, args.install_root)
    if not hermes:
        fail("请先安装 Nora。")
    plugin = args.hermes_home / "plugins/clawchat"
    require_bundled_clawchat(args.hermes_home)
    run_stream([hermes, "plugins", "enable", "clawchat"], env=env)
    emit("task", task="正在激活 ClawChat")
    # Activation code travels over stdin, never in argv or launcher logs.
    # Scope the connect attribution to this child; plugin files and local
    # credential storage keep their Hermes identity.
    activation = (
        "import json,sys,runpy; from pathlib import Path; data=json.load(sys.stdin); "
        "sys.path.insert(0,data['agent']); sys.path.insert(0,str(Path(data['cli']).parent)); "
        "from clawchat_gateway import api_client; api_client.AGENTS_CONNECT_TYPE='nora-tavern'; "
        "sys.argv=[data['cli'],'activate',data['code'],'--no-restart'] + (['--repair'] if data['repair'] else []); "
        "runpy.run_path(data['cli'],run_name='__main__')"
    )
    result = subprocess.run([python_command(args.hermes_home), "-B", "-c", activation],
                            input=json.dumps({"agent": str(args.hermes_home / "hermes-agent"),
                                              "cli": str(plugin / "clawchat_cli.py"), "code": code,
                                              "repair": clawchat_paired(args.hermes_home)}),
                            env=env, text=True, capture_output=True, timeout=120)
    if result.returncode:
        fail("ClawChat 激活失败，请检查配对码是否过期，并重新获取。")
    if not clawchat_paired(args.hermes_home):
        fail("ClawChat 激活未保存完整配置。")
    stop_gateway(args.nora_home)
    sync_nora_profile(args)
    emit("milestone", index=3, state="done", task="ClawChat 已配对")
    command_status(args)


def command_update(args, *, repair: bool = False) -> None:
    managed = (args.install_root / "tavern-updates/nora-system.json").is_file()
    if not installed(args.install_root):
        fail("还没有安装 Nora Tavern。")
    bootstrap = args.install_root / "apps/tavern-ops/updater/bootstrap.py"
    selected = release_dir(args.release_dir) if getattr(args, "release_dir", None) else None
    if managed:
        if not selected or repair:
            fail("请从启动器的检查更新入口更新完整系统。")
        bootstrap = selected / "tavern-updater-bootstrap.py"
        manifest = json.loads((selected / "release-manifest.json").read_text(encoding="utf-8"))
        if not bootstrap.is_file() or hashlib.sha256(bootstrap.read_bytes()).hexdigest() != manifest.get("bootstrap", {}).get("sha256"):
            fail("更新器校验失败，当前安装未修改。")
        instance = nora_system.read_json(args.hermes_home / "nora-instance.json")
        if instance.get("port") != args.port:
            fail("启动器端口与实例记录不一致，已停止更新。")
        if gateway_status(args.nora_home, args.hermes_home).get("running"):
            fail("更新前必须先停止诺拉。")
    if not bootstrap.is_file():
        fail("没有找到更新器，请先修复安装目录。")
    emit("step", index=0, label="检查版本")
    command = [
        python_command(args.hermes_home),
        "-u",
        "-B",
        str(bootstrap),
        "--install-root",
        str(args.install_root),
        "--hermes-home",
        str(args.hermes_home),
        "--apply",
        "--confirm",
    ]
    if repair:
        command.append("--repair")
    if selected:
        command += ["--release-dir", str(selected)]
    if managed:
        command += ["--managed-home", str(args.nora_home)]
    if getattr(args, "tag", None):
        if not re.fullmatch(r"[a-zA-Z0-9._-]{1,100}", args.tag):
            fail("版本编号无效。")
        command += ["--tag", args.tag]
    run_stream(command, env=env_for(args.nora_home, args.hermes_home, args.install_root))
    emit("result", **status_payload(args.nora_home, args.hermes_home, args.install_root, args.port))


def command_check_update(args) -> None:
    request = urllib.request.Request(
        "https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest",
        headers={"User-Agent": "Nora-Tavern-Launcher", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        release = json.loads(response.read(1024 * 1024))
    latest = release.get("tag_name", "")
    if release.get("draft") or release.get("prerelease") or not re.fullmatch(r"[a-zA-Z0-9._-]{1,100}", latest):
        fail("没有找到可用的正式发布版本。")
    current = str(read_version(args.install_root).get("version") or "")
    # Do not turn a version check into a downgrade for a newer local build.
    def version(value):
        match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", value)
        return tuple(map(int, match.groups())) if match else None
    before, after = version(current), version(latest)
    available = bool(before and after and after > before)
    state = "unknown" if not before or not after else "available" if available else "current" if before == after else "ahead"
    emit("result", current=current or None, latest=latest, available=available, state=state)


def open_path(path: Path) -> None:
    if not path.exists():
        fail("路径不存在：" + str(path))
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    elif os.name == "nt":
        os.startfile(path)  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["xdg-open", str(path)])


def command_open_logs(args) -> None:
    open_path(args.install_root / "tavern-state/native-runtime/runs/production/native.log")
    emit("result", ok=True)


def command_open_settings(args) -> None:
    open_path(args.hermes_home / "config.yaml")
    emit("result", ok=True)


def command_open_url(args) -> None:
    webbrowser.open(args.url)
    emit("result", ok=True, url=args.url)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nora-home")
    parser.add_argument("--hermes-home")
    parser.add_argument("--install-root")
    parser.add_argument("--port", type=int, default=8799)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("verify-model")
    install = sub.add_parser("install")
    install.add_argument("--release-dir")
    for action in ("start", "stop", "restart"):
        sub.add_parser(action).add_argument("--service", choices=("all", "nora", "tavern"), default="all")
    sub.add_parser("finish-update")
    sub.add_parser("pair")
    update = sub.add_parser("update")
    update.add_argument("--tag")
    update.add_argument("--release-dir")
    sub.add_parser("check-update")
    sub.add_parser("repair")
    sub.add_parser("open-logs")
    sub.add_parser("open-settings")
    open_url = sub.add_parser("open-url")
    open_url.add_argument("url")
    args = parser.parse_args()
    args.nora_home = safe(args.nora_home) if args.nora_home else default_nora_home()
    args.hermes_home = safe(args.hermes_home) if args.hermes_home else default_hermes_home(args.nora_home)
    args.install_root = safe(args.install_root) if args.install_root else default_install_root(args.nora_home)
    require_descendant(args.nora_home, args.hermes_home, "Hermes 目录")
    require_descendant(args.nora_home, args.install_root, "Tavern 目录")
    if args.command == "status":
        command_status(args)
    elif args.command == "verify-model":
        problems = []
        verified = read_verified_model(args.nora_home, args.hermes_home, problems)
        emit("result", ok=bool(verified), error=("模型配置复核未通过：" + "；".join(problems)) if problems else "")
    elif args.command == "install":
        command_install(args)
    elif args.command == "start":
        command_start(args)
    elif args.command == "stop":
        command_stop(args)
    elif args.command == "restart":
        command_stop(args)
        command_start(args)
    elif args.command == "pair":
        command_pair(args)
    elif args.command == "finish-update":
        state = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
        if not all(state.get(key) for key in ('systemReady', 'modelConfigured', 'clawchatPaired', 'clawchatProfileReady')):
            fail('更新后的 Nora 配置未通过检查。')
        nora_system.mark_setup_complete(args.install_root)
        command_status(args)
    elif args.command == "update":
        command_update(args)
    elif args.command == "check-update":
        command_check_update(args)
    elif args.command == "repair":
        command_update(args, repair=True)
    elif args.command == "open-logs":
        command_open_logs(args)
    elif args.command == "open-settings":
        command_open_settings(args)
    elif args.command == "open-url":
        command_open_url(args)


if __name__ == "__main__":
    try:
        emit("diagnostic", component="python", executable=sys.executable, version=sys.version)
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        fail(str(error))
