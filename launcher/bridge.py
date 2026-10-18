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
    from . import nora_system, nora_profile, error_diagnostics, operation_control
    from .launcher_services import check_gateway_control, clawchat_paired, gateway_status, start_gateway, stop_gateway, stop_liveware
except ImportError:
    import nora_system
    import nora_profile
    import error_diagnostics
    import operation_control
    from launcher_services import check_gateway_control, clawchat_paired, gateway_status, start_gateway, stop_gateway, stop_liveware


HERE = Path(__file__).resolve().parent


def emit(event: str, **payload) -> None:
    print(json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def exception_diagnostic(error, *, stack=None):
    """Bridge-owned error metadata; never source lines, locals or child streams."""
    return error_diagnostics.exception_diagnostic(error, stack=stack, project_root=HERE.parent)


def fail(message: str, code: str | None = None, user_code: str | None = None, *, error=None) -> None:
    explicit = error is None
    error = RuntimeError(message) if explicit else error
    if explicit or error.__traceback__ is None:
        error._bridge_diagnostic_stack = [traceback.FrameSummary(frame.filename, frame.lineno, frame.name,
                                                               lookup_line=False)
                                         for frame in traceback.extract_stack()[:-1][-12:]]
    detail = exception_diagnostic(error)
    if code:
        detail['code'] = code
    emit('diagnostic', component='bridge', error=detail)
    fields = {'message': message, 'code': code}
    if user_code:
        fields['userCode'] = user_code
    emit("error", **fields)
    stopped = SystemExit(1)
    stopped.bridge_error = error
    raise stopped


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
    # Child gateways import owned hook directories after their installation
    # digest is sealed. -B on this bridge does not propagate to a new Python.
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    # The desktop runtime is installation-owned; inherited PATH may contain a
    # Bun shim named node. Pin Tavern to the bundled executable explicitly.
    env['TAVERN_NODE_EXECUTABLE'] = str(hermes_home / ('node/node.exe' if os.name == 'nt' else 'node/bin/node'))
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


def run_stream(command: list[str], *, env: dict[str, str] | None = None, native_cli=False):
    def native_diagnostic(value):
        # This is a process boundary, not permission for arbitrary child output.
        # Accept the bounded native exception protocol, including reviewed
        # process facts. Never forward arbitrary child context or output.
        remaining = 4
        def valid(item, *, root=False):
            nonlocal remaining
            required = {'name', 'message', 'code', 'stack'}
            optional = {'cause', 'secondaryErrors', 'context', 'missingReasons'} | ({'truncated'} if root else set())
            if (remaining == 0 or not isinstance(item, dict)
                    or not required.issubset(item) or not set(item).issubset(required | optional)):
                return False
            remaining -= 1
            if (not isinstance(item['name'], str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', item['name'])
                    or not isinstance(item['message'], str) or len(item['message']) > 2000
                    or not isinstance(item['stack'], str)):
                return False
            code = item['code']
            if code is not None and not (isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', code)
                                        or type(code) is int and 100 <= code <= 599):
                return False
            frames = item['stack'].splitlines()
            if len(frames) > 12 or any(not re.fullmatch(
                    r'File "[A-Za-z0-9_.-]{1,120}\.(?:py|js|cjs|mjs)", line [1-9][0-9]{0,6}, in [A-Za-z_<>][A-Za-z0-9_<>.]{0,119}',
                    frame) for frame in frames):
                return False
            if 'truncated' in item and type(item['truncated']) is not bool:
                return False
            if 'context' in item:
                context = item['context']
                if (not isinstance(context, dict) or not context
                        or not set(context).issubset({'pid', 'exitCode', 'port', 'loopback', 'stage'})):
                    return False
                bounds = {'pid': (1, 4294967295), 'exitCode': (-2147483648, 4294967295), 'port': (1, 65535)}
                for key, (minimum, maximum) in bounds.items():
                    if key in context and (type(context[key]) is not int or not minimum <= context[key] <= maximum):
                        return False
                if 'loopback' in context and type(context['loopback']) is not bool:
                    return False
                if 'stage' in context and context['stage'] not in ('native_start', 'first_install', 'update_apply', 'restoring'):
                    return False
            if 'missingReasons' in item:
                reasons = item['missingReasons']
                if (not isinstance(reasons, list) or len(reasons) > 16
                        or any(not isinstance(reason, str) or len(reason) > 96
                               or not re.fullmatch(r'[a-z_]+(?::[A-Z_]+)?', reason) for reason in reasons)):
                    return False
            if 'cause' in item and not valid(item['cause']):
                return False
            secondary = item.get('secondaryErrors', [])
            return (isinstance(secondary, list) and len(secondary) <= 2
                    and all(isinstance(branch, dict) and set(branch) == {'error'} and valid(branch['error'])
                            for branch in secondary))
        return valid(value, root=True)

    started = time.monotonic()
    emit("command", command=command)
    gate = getattr(sys, '_nora_operation_delegate', None)
    if gate and Path(command[0]).name.lower() in ('hermes', 'hermes.exe'):
        command = [sys.executable, '-B', '-c', 'import sys; from hermes_cli.main import main; sys.exit(main())', *command[1:]]
    process = (operation_control.managed_popen if gate else subprocess.Popen)(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        bufsize=1,
    )
    emit("diagnostic", operation="subprocess-start", pid=process.pid, command=command)
    assert process.stdout is not None
    failure = ""
    failure_code = None
    failure_user_code = None
    native_failure = None
    last_result = None
    for line in process.stdout:
        line = ANSI.sub("", line).rstrip()
        if line:
            try:
                message = json.loads(line)
            except ValueError:
                emit("log", line=line, stream="combined")
            else:
                if isinstance(message, dict):
                    if (native_cli and set(message) == {'event', 'component', 'error'}
                            and message.get('event') == 'diagnostic' and message.get('component') == 'native'
                            and native_diagnostic(message['error'])):
                        emit('diagnostic', component='bridge', error=message['error'])
                        continue
                    # Only the known native lifecycle CLI may supply this error
                    # envelope. Other children retain generic bridge diagnostics;
                    # never promote their streams or forged diagnostic objects.
                    if (native_cli and message.get('ok') is False
                            and isinstance(message.get('error'), str)
                            and set(message).issubset({'ok', 'error', 'code'})):
                        native_code = message.get('code')
                        if not isinstance(native_code, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', native_code):
                            native_code = None
                        native_failure = (message['error'][-2000:], native_code)
                    if message.get("event") == "result":
                        last_result = dict(message)
                    detail = message.get("error") or (message.get("message") if message.get("event") == "error" else "")
                    if detail:
                        failure = str(detail)[-2000:]
                        failure_code = message.get('code')
                        failure_user_code = message.get('userCode')
                if isinstance(message, dict) and message.get("event"):
                    if message.get('event') == 'diagnostic' and message.get('component') in ('bridge', 'native'):
                        # Only this bridge may label its own exception projection.
                        message['component'] = 'child'
                    emit(message.pop("event"), **message)
                else:
                    emit("log", line=line, stream="combined")
    process.stdout.close()
    code = process.wait()
    emit("diagnostic", operation="subprocess-exit", pid=process.pid, exitCode=code,
         durationMs=round((time.monotonic() - started) * 1000))
    if code:
        error = subprocess.CalledProcessError(code, command)
        if native_failure:
            detail, native_code = native_failure
            # The remote fault contract bounds codes independently. Include the
            # native code in its message too, without changing the wire schema.
            error._bridge_diagnostic_message = (f'[{native_code}] ' if native_code else '') + detail
            error.code = native_code
        fail(failure or f"命令执行失败，退出码 {code}；请查看安装日志中的具体输出。",
             failure_code, failure_user_code, error=error)
    return last_result


def run_json(command: list[str], *, env: dict[str, str] | None = None, timeout: int = 60) -> dict:
    run = operation_control.managed_run if getattr(sys, '_nora_operation_delegate', None) else subprocess.run
    result = run(command, text=True, capture_output=True, env=env, timeout=timeout)
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


def _repair_object(file):
    """A missing or unreadable record is not permission to create an instance."""
    file = Path(file)
    try:
        if file.is_symlink() or not file.is_file() or file.stat().st_size > 4 * 1024 * 1024:
            raise ValueError('not a regular bounded record')
        result = json.loads(file.read_text(encoding='utf-8'))
        if not isinstance(result, dict):
            raise ValueError('not an object')
        return result
    except (OSError, ValueError, UnicodeError) as error:
        raise RuntimeError('无法核验已有安装记录，现有数据已保留：' + file.name) from error


def partial_installation_snapshot(args):
    """Authenticate the exact damaged managed installation, without modifying it.

    This is a repair/rollback contract, never a claim that the old program works.
    Service state is established separately by partial_repair_preflight.
    """
    recovery = nora_system.recovery_module()
    root, home, tavern = args.nora_home, args.hermes_home, args.install_root
    if home != root / 'hermes' or tavern != root / 'tavern':
        raise RuntimeError('部分安装修复仅支持当前启动器绑定的专属目录。')
    for directory in (root, home, tavern, tavern / 'tavern-state'):
        current = directory
        while current != current.parent:
            if recovery.linked(current):
                raise RuntimeError('安装或数据目录被链接重定向，未修改现有安装。')
            current = current.parent
        if not directory.is_dir():
            raise RuntimeError('已有安装目录或数据目录缺失，未创建新实例。')
    recovery.reject_links(tavern / 'tavern-state')
    records = {
        'instance': home / 'nora-instance.json',
        'system': tavern / 'tavern-updates/nora-system.json',
        'receipt': tavern / 'tavern-updates/installed.json',
        'manifest': tavern / 'tavern-updates/installed-manifest.json',
    }
    def no_redirect(file):
        for current in (file, *file.parents):
            if recovery.linked(current):
                raise RuntimeError('已有安装路径被链接重定向，未读取目录外文件。')
    for file in records.values():
        no_redirect(file)
        recovery.reject_links(file)
    objects = {name: _repair_object(file) for name, file in records.items()}
    instance, system, receipt, manifest = (objects[name] for name in ('instance', 'system', 'receipt', 'manifest'))
    expected = {'noraHome': root, 'hermesHome': home, 'installRoot': tavern}
    if (type(instance.get('schema')) is not int or instance['schema'] != 1
            or type(instance.get('port')) is not int or instance['port'] != args.port
            or not 1024 <= args.port <= 65535
            or any(not isinstance(instance.get(name), str) or not Path(instance[name]).is_absolute()
                   or Path(instance[name]) != value for name, value in expected.items())):
        raise RuntimeError('已有安装的实例或端口绑定不一致，未修改任何文件。')
    version, commit = receipt.get('version'), receipt.get('commit')
    if (type(receipt.get('schema')) is not int or receipt['schema'] not in (1, 2)
            or not re.fullmatch(r'\d+\.\d+\.\d+(?:-beta\.\d+)?', str(version or ''))
            or not re.fullmatch(r'[a-f0-9]{40}', str(commit or ''))
            or type(system.get('schema')) is not int or system['schema'] != 1
            or system.get('version') != version or system.get('commit') != commit
            or not isinstance(system.get('proof'), dict)
            or any(system['proof'].get(name) is not True for name in nora_system.PROOFS)
            or manifest.get('schema') != 'tavern-release/v2' or manifest.get('commit') != commit
            or not isinstance(manifest.get('versions'), dict) or manifest['versions'].get('tavern') != version):
        raise RuntimeError('已有安装的版本、清单或验收记录不一致，未覆盖现有安装。')
    config = home / 'config.yaml'
    no_redirect(config)
    recovery.reject_links(config)
    try:
        import yaml
        value = yaml.safe_load(config.read_text(encoding='utf-8'))
        mcp = value['mcp_servers']['nora']
        env = mcp['env']
        if (mcp.get('args') != [str(tavern / 'apps/nora-mcp/dist/server.js')]
                or env.get('NORA_MCP_BASE_URL') != f'http://127.0.0.1:{args.port}'
                or env.get('NORA_MCP_STATE_ROOT') != str(tavern / 'tavern-state')):
            raise ValueError('binding differs')
    except (OSError, ValueError, TypeError, KeyError, AttributeError, yaml.YAMLError) as error:
        raise RuntimeError('已有模型配置与当前实例绑定不一致，未修改配置。') from error
    marker_file = home / 'hermes-agent/.hermes-bootstrap-complete'
    no_redirect(marker_file)
    recovery.reject_links(marker_file)
    marker = _repair_object(marker_file)
    if (type(marker.get('schema')) is not int or marker['schema'] != 1 or marker.get('source') != 'nora-integrated-runtime'
            or not re.fullmatch(r'[a-f0-9]{64}', str(marker.get('sha256') or ''))):
        raise RuntimeError('缺少可核验的原 Nora 核运行记录，未覆盖用户数据。')
    python_files = [home / 'hermes-agent/venv' / relative for relative in
                    (('Scripts/python.exe',) if os.name == 'nt' else ('bin/python3', 'bin/python'))]
    native = tavern / 'apps/tavern-runtime'
    missing = {'nativeRuntime': not (native / 'native-runtime.json').is_file(),
               'nativeLifecycle': not (native / 'native_lifecycle.py').is_file(),
               'python': not any(file.is_file() for file in python_files)}
    if not any(missing.values()):
        raise RuntimeError('当前程序没有本次修复支持的缺失项，请使用正常更新检查。')
    programs = {}
    for name, directory in (('app', native), ('ops', tavern / 'apps/tavern-ops'), ('nora-mcp', tavern / 'apps/nora-mcp')):
        no_redirect(directory)
        recovery.reject_links(directory)
        if directory.exists():
            if not directory.is_dir():
                raise RuntimeError('已有程序目录类型不正确，未覆盖现有文件。')
            programs[name] = {'identity': [str(part) for part in recovery.identity(directory)],
                              'digest': recovery.digest(directory)}
        else:
            programs[name] = None
    bindings = {name: nora_system.digest(file) for name, file in records.items()}
    bindings['config'] = nora_system.digest(config)
    native_config = tavern / 'tavern-state/native-runtime/config.yaml'
    no_redirect(native_config)
    recovery.reject_links(native_config)
    if native_config.exists() and not native_config.is_file():
        raise RuntimeError('原酒馆配置不是可核验的文件，未修改已有数据。')
    bindings['nativeConfig'] = nora_system.digest(native_config) if native_config.is_file() else None
    bindings['runtimeMarker'] = nora_system.digest(marker_file)
    return {'schema': 'nora-managed-partial-installation/1', 'version': version, 'commit': commit,
            'bindings': bindings, 'missing': missing, 'programs': programs}


def partial_repair_preflight(args):
    snapshot = partial_installation_snapshot(args)
    partial_repair_offline(args)
    if partial_installation_snapshot(args) != snapshot:
        raise RuntimeError('修复检查期间已有安装发生变化，未开始替换文件。')
    return {'partialRepair': snapshot, 'offline': True, 'running': False, 'gatewayRunning': False,
            'clawchatConnected': False, 'systemReady': False, 'version': snapshot['version'],
            'originalState': 'partial', 'runtimeReady': False}


def partial_repair_offline(args):
    check_gateway_control(args.nora_home, args.hermes_home)
    _recovery_require_native_offline(args)
    if gateway_status(args.nora_home, args.hermes_home).get('gatewayRunning') is not False:
        raise RuntimeError('诺拉服务尚未确认停止，未开始修复缺失程序。请先停止服务。')
    return {'offline': True, 'running': False, 'gatewayRunning': False, 'clawchatConnected': False}


def verify_partial_restoration(args, snapshot):
    result = partial_repair_preflight(args)
    if result['partialRepair'] != snapshot:
        raise RuntimeError('恢复后的版本、配置、原程序或缺失集合与修复前不一致，请保留备份。')
    return result


def verify_partial_baseline(args, snapshot):
    result = verify_partial_restoration(args, snapshot)
    helper = nora_system.recovery_module()
    journal = helper.load(args.hermes_home, args.install_root, full=False)
    plan = journal.plan
    baseline = plan.get('partialBaseline')
    saved = (plan.get('state') or {}).get('savedDigest')
    if saved is None and baseline is None:
        # The transaction has not taken a data snapshot or entered a swap.
        if (plan.get('state') or {}).get('phase') not in ('pending', 'untouched') or any(
                target.get('phase') not in ('pending', 'restored') for target in plan.get('targets', [])):
            raise RuntimeError('原剧情恢复证据缺失，保留现场。')
        return result
    keys = {'schema', 'partialRepair', 'stateDigest', 'storyInventory', 'worlds',
            'readerManifestSha256', 'readerCommit'}
    if (not isinstance(baseline, dict) or set(baseline) != keys
            or baseline.get('schema') != 'nora-managed-partial-repair-baseline/1'
            or baseline.get('partialRepair') != snapshot or baseline.get('stateDigest') != saved
            or not isinstance(baseline.get('storyInventory'), dict)
            or not re.fullmatch(r'[a-f0-9]{64}', str(saved or ''))
            or not re.fullmatch(r'[a-f0-9]{64}', str(baseline.get('readerManifestSha256') or ''))
            or not re.fullmatch(r'[a-f0-9]{40}', str(baseline.get('readerCommit') or ''))
            or (baseline.get('worlds') is not None and baseline.get('worlds') != plan.get('worlds'))
            or helper.digest(args.install_root / 'tavern-state') != saved):
        raise RuntimeError('原剧情、聊天或配置未精确恢复，保留备份与现场。')
    return result


def read_verified_model(nora_home: Path, hermes_home: Path, problems: list[str] | None = None, *, allow_pending=False) -> dict:
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
            credential = configured_key if is_custom else env_values.get(key_env, "")
            if value.get("credentialSha256") and hashlib.sha256(credential.encode()).hexdigest() != value["credentialSha256"]:
                return reject("密钥已更改，需要重新验证模型")
        except (OSError, ValueError, AttributeError, yaml.YAMLError):
            return reject("无法读取模型配置")
        if value.get("tavernSyncPending") and not allow_pending:
            return reject("模型已验证，酒馆同步尚未完成")
        return {"provider": provider, "model": model, "keyEnv": key_env, "baseUrl": base_url,
                "authMode": value.get("authMode", "key"), "tavernSyncPending": bool(value.get("tavernSyncPending"))}
    except (OSError, ValueError, AttributeError):
        return reject("无法读取模型验证记录")


def status_payload(nora_home: Path, hermes_home: Path, install_root: Path, port: int) -> dict:
    if not installed(install_root) and any((file.exists() or file.is_symlink()) for file in (
            hermes_home / 'nora-instance.json', install_root / 'tavern-updates/nora-system.json',
            install_root / 'tavern-updates/installed.json', install_root / 'tavern-updates/installed-manifest.json')):
        partial = partial_installation_snapshot(argparse.Namespace(nora_home=nora_home,
                    hermes_home=hermes_home, install_root=install_root, port=port))
        return {'installed': False, 'managedInstallation': True, 'needsRepair': True,
                'version': partial['version'], 'commit': partial['commit'], 'versionSource': 'receipt',
                'missingPrograms': partial['missing'], 'systemReady': False, 'setupCompleted': False,
                'systemProblems': ['已有安装的程序文件缺失，需要保留数据修复。'],
                'running': None, 'gatewayRunning': None, 'clawchatConnected': None,
                'hermesInstalled': bool(hermes_command(nora_home, hermes_home, install_root)),
                'noraInstalled': False, 'modelConfigured': False, 'clawchatPaired': False,
                'port': port, 'url': f'http://127.0.0.1:{port}', 'home': str(nora_home),
                'noraHome': str(nora_home), 'hermesHome': str(hermes_home), 'installRoot': str(install_root)}
    system = nora_system.installation_state(hermes_home, install_root)
    recovery = nora_system.update_recovery(install_root, hermes_home)
    hermes = hermes_command(nora_home, hermes_home, install_root)
    # Installed files and live service health are separate facts. Avoid booting
    # the entire Hermes CLI on every five-second status poll.
    hermes_ready = bool(hermes and (hermes_home / "hermes-agent/.hermes-bootstrap-complete").is_file())
    verified_model = read_verified_model(nora_home, hermes_home, allow_pending=True)
    credentials_ready = bool(verified_model) and not verified_model.get("tavernSyncPending")
    connection = gateway_status(nora_home, hermes_home)
    clawchat_connected = connection["clawchatConnected"]
    paired = clawchat_paired(hermes_home)
    profile_ready = paired and nora_profile.ready(hermes_home)
    if not installed(install_root):
        return {
            "installed": False,
            "updateRecovery": recovery,
            "systemReady": False,
            "setupCompleted": False,
            "running": False,
            "hermesInstalled": hermes_ready,
            "noraInstalled": system["noraInstalled"],
            "modelConfigured": credentials_ready,
            "modelSyncPending": bool(verified_model.get("tavernSyncPending")),
            "modelAuthMode": verified_model.get("authMode", "key"),
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
        "updateRecovery": recovery,
        "systemReady": system["ready"],
        "setupCompleted": system["setupCompleted"] and profile_ready,
        "clawchatProfileReady": profile_ready,
        "systemProblems": system["problems"],
        "running": running,
        "hermesInstalled": hermes_ready,
        "noraInstalled": system["noraInstalled"],
        "modelConfigured": credentials_ready,
        "modelSyncPending": bool(verified_model.get("tavernSyncPending")),
        "modelAuthMode": verified_model.get("authMode", "key"),
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
        payload['warningCode'] = status.get('inspection_error_code')
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
    if nora_system.read_json(args.install_root / "tavern-updates/nora-system.json").get("schema") == 1:
        fail("已有 Nora 安装记录，请通过修复当前安装恢复受管文件；不会重新执行首次安装。")
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


def _same_skill_damage(before, system):
    problems = before.get('systemProblems')
    return (before.get('systemReady') is False and isinstance(problems, list) and bool(problems)
            and all(isinstance(problem, str) and problem.startswith((
                '技能文件内容与安装记录不一致：', '技能文件缺失：', '缺少技能：')) for problem in problems)
            and sorted(problems) == sorted(system.get('problems', []))
            and bool(before.get('version'))
            and str(system.get('version', '')).lstrip('v') == str(before['version']).lstrip('v'))


def command_start(args, *, require_clawchat_connection=True) -> None:
    service = getattr(args, "service", "all")
    if (nora_system.update_recovery(args.install_root)
            and getattr(args, 'command', '') != 'update-lifecycle'):
        fail('上次更新尚未恢复完成，暂不启动可能混合版本的服务。请保留日志和备份。', user_code='UPDATE_RECOVERY_REQUIRED')
    if not installed(args.install_root):
        fail("还没有安装 Nora Tavern。")
    system = nora_system.installation_state(args.hermes_home, args.install_root)
    if not system["ready"]:
        fail("Nora 初始化未完成：" + "；".join(system["problems"][:3]))
    first_setup = not system["setupCompleted"]
    lifecycle = args.install_root / "apps/tavern-runtime/native_lifecycle.py"
    if first_setup and service != "tavern" and not read_verified_model(args.nora_home, args.hermes_home):
        fail("请先配置并测试模型。", user_code='MODEL_SETUP_REQUIRED')
    if first_setup and service != "tavern" and not clawchat_paired(args.hermes_home):
        fail("请先连接 ClawChat。", user_code='CLAWCHAT_PAIR_REQUIRED')
    if service != "tavern" and first_setup:
        sync_nora_profile(args)
    if service == "all":
        emit("milestone", index=4, state="running", task="正在启动服务")
    else:
        emit("task", task="正在启动酒馆" if service == "tavern" else "正在启动诺拉")
    env = env_for(args.nora_home, args.hermes_home, args.install_root)
    if service != "nora":
        emit("task", stage_id="start_tavern", task="正在启动酒馆")
        run_stream([python_command(args.hermes_home), "-u", "-B", str(lifecycle), "start", "--port", str(args.port)], env=env, native_cli=True)
    if service != "tavern":
        emit("task", stage_id="start_nora", task="正在连接 ClawChat")
        start_gateway(args.nora_home, args.hermes_home,
                      [python_command(args.hermes_home), "-m", "hermes_cli.main", "gateway", "run"], env,
                      require_connection=require_clawchat_connection)
    if service == "nora":
        emit("result", **status_payload(args.nora_home, args.hermes_home, args.install_root, args.port))
        return
    if service == "tavern":
        emit("result", **status_payload(args.nora_home, args.hermes_home, args.install_root, args.port))
        return
    if first_setup:
        emit("task", stage_id="connect", task="正在准备 ClawChat 连接组件")
        require_bundled_clawchat(args.hermes_home)
        # Initial setup explicitly verifies registration. Subsequent starts use
        # the user's gateway hooks, including their choice to disable a hook.
        run_stream([python_command(args.hermes_home), "-B",
                    str(args.hermes_home / "hooks/tavern-liveware-register/handler.py")], env=env)
    emit("task", stage_id="health_check", task="正在检查服务连接")
    status = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    gateway_ready = status["clawchatConnected"] if require_clawchat_connection is not False else status["gatewayRunning"]
    if not (status["running"] and gateway_ready):
        fail("启动检查未通过，请检查服务连接后重试。")
    if first_setup:
        nora_system.verify_runtime(args.hermes_home, args.install_root, args.port, python_command(args.hermes_home), env)
        nora_system.mark_setup_complete(args.install_root)
    status = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    emit("milestone", index=4, state="done", task="启动检查通过")
    emit("result", **status)


def command_stop(args) -> None:
    service = getattr(args, "service", "all")
    emit("task", stage_id="stop", task="正在停止" + {"nora": "诺拉", "tavern": "酒馆", "all": "诺拉与酒馆"}[service])
    errors, error_messages = [], []
    if service != "tavern":
        try:
            if service == "nora":
                stop_gateway(args.nora_home, hermes_home=args.hermes_home, preserve_liveware_home=args.hermes_home)
            else:
                stop_gateway(args.nora_home, hermes_home=args.hermes_home)
        except Exception as error:
            errors.append(error)
            error_messages.append(str(error))
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
                               env=env_for(args.nora_home, args.hermes_home, args.install_root), native_cli=True)
                stop_liveware(args.hermes_home)
        except SystemExit as error:
            errors.append(getattr(error, 'bridge_error', error))
            error_messages.append("酒馆停止命令未完成")
        except Exception as error:
            errors.append(error)
            error_messages.append(str(error))
    if errors:
        failure = RuntimeError("；".join(error_messages))
        failure._bridge_diagnostic_message = '停止服务失败。'
        failure.secondary_errors = errors[1:3]
        raise failure from errors[0]
    status = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
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
    emit("task", stage_id="profile_sync", task="正在设置诺拉的名字和头像")
    try:
        result = run_json([python_command(args.hermes_home), "-B", str(HERE / "nora_profile.py"),
                           str(args.hermes_home)],
                          env=env_for(args.nora_home, args.hermes_home, args.install_root), timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        fail("ClawChat 已配对，但诺拉的名字和头像未完成同步。配对已保留，请重试。", error=error)
    if result.get("ok") is not True or not nora_profile.ready(args.hermes_home):
        diagnostic = result.get('diagnostic')
        if isinstance(diagnostic, dict):
            emit('diagnostic', component='bridge', error=diagnostic)
        fail("ClawChat 已配对，但诺拉的名字和头像未完成同步。配对已保留，请重新检查连接。",
             code=diagnostic.get('code') if isinstance(diagnostic, dict) else None)


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
    emit("task", stage_id="pair", task="正在激活 ClawChat")
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
    result = operation_control.managed_run([python_command(args.hermes_home), "-B", "-c", activation],
                            input=json.dumps({"agent": str(args.hermes_home / "hermes-agent"),
                                              "cli": str(plugin / "clawchat_cli.py"), "code": code,
                                              "repair": clawchat_paired(args.hermes_home)}),
                            env=env, text=True, capture_output=True, timeout=120)
    if result.returncode:
        # The same nonzero exit can mean a network, service or input failure.
        # Preserve the bounded CLI explanation in the existing redacted log;
        # do not invent "expired code" as the cause of every activation error.
        output = str(result.stderr or result.stdout or '').replace(code, '[REDACTED]')
        if output:
            emit('log', line=output[-8192:])
        error = RuntimeError('ClawChat 激活进程退出，退出码 '+str(result.returncode)+'。')
        error.code = 'PAIR_ACTIVATION_FAILED'
        fail('ClawChat 配对未成功。请查看日志，检查网络和配对信息后重新提交。',
             user_code='PAIR_ACTIVATION_FAILED', error=error)
    if not clawchat_paired(args.hermes_home):
        fail("ClawChat 激活未保存完整配置。")
    stop_gateway(args.nora_home, hermes_home=args.hermes_home)
    sync_nora_profile(args)
    emit("milestone", index=3, state="done", task="ClawChat 已配对")
    command_status(args)


def missing_receipt_snapshot(args):
    marker = args.install_root / 'tavern-updates/nora-system.json'
    if marker.exists() or marker.is_symlink() or not installed(args.install_root):
        fail('旧安装恢复条件已变化，未修改当前安装。请重新检查更新。')
    instance = nora_system.read_json(args.hermes_home / 'nora-instance.json')
    expected = {'noraHome': args.nora_home, 'hermesHome': args.hermes_home, 'installRoot': args.install_root}
    if (instance.get('schema') != 1 or instance.get('port') != args.port
            or any(Path(str(instance.get(name, ''))).resolve() != path.resolve() for name, path in expected.items())):
        fail('旧安装的实例绑定不一致，未修改现有数据。')
    files = {'instance': args.hermes_home / 'nora-instance.json', 'config': args.hermes_home / 'config.yaml',
             'receipt': args.install_root / 'tavern-updates/installed.json',
             'manifest': args.install_root / 'tavern-updates/installed-manifest.json'}
    try:
        return {name: nora_system.digest(file) for name, file in files.items()}
    except OSError:
        fail('旧安装的版本或配置记录不完整，未修改现有数据。')


def _recovery_require_native_offline(args):
    """An incomplete program tree cannot safely supply a stop controller."""
    import socket
    try:
        import psutil
    except ImportError as error:
        raise RuntimeError('无法核验酒馆进程状态，未恢复文件。') from error
    try:
        owner = psutil.Process().username().casefold()
        script = (args.install_root / 'apps/tavern-runtime/engine/sillytavern/server.js').resolve()
        for process in psutil.process_iter(['name', 'username', 'cmdline', 'cwd'], ad_value=None):
            info = process.info
            if str(info.get('name') or '').lower() not in ('node', 'node.exe'):
                continue
            if not info.get('cmdline'):
                if not info.get('username') or info['username'].casefold() == owner:
                    raise RuntimeError('无法确认酒馆进程已停止，未恢复文件。')
                continue
            for value in info['cmdline']:
                if not isinstance(value, str) or not value.endswith('server.js'):
                    continue
                path = Path(value)
                if not path.is_absolute():
                    if not info.get('cwd'):
                        raise RuntimeError('无法确认酒馆进程目录，未恢复文件。')
                    path = Path(info['cwd']) / path
                if path.resolve() == script:
                    raise RuntimeError('酒馆进程仍在运行且停止组件不完整，未恢复文件。请先正常退出酒馆。')
    except psutil.Error as error:
        raise RuntimeError('无法核验酒馆进程状态，未恢复文件。') from error
    with socket.socket() as probe:
        probe.settimeout(0.3)
        if probe.connect_ex(('127.0.0.1', args.port)) == 0:
            raise RuntimeError('酒馆端口仍被占用，未恢复文件。请先正常退出占用该端口的程序。')


def recovery_stop(args):
    required = ('apps/tavern-runtime/native_lifecycle.py', 'apps/tavern-runtime/native-runtime.json',
                'apps/tavern-ops/updater/runtime_lock.py', 'apps/tavern-ops/updater/runtime_process.py',
                'apps/tavern-ops/updater/service_manager.py')
    if all((args.install_root / name).is_file() for name in required):
        args.service = 'all'
        command_stop(args)
    else:
        # Renaming either app or ops may have been interrupted. Do not load a
        # mixed controller or guess ownership from a saved PID in that state.
        _recovery_require_native_offline(args)
        stop_gateway(args.nora_home, hermes_home=args.hermes_home)
        stop_liveware(args.hermes_home)
    _recovery_require_native_offline(args)
    gateway = gateway_status(args.nora_home, args.hermes_home)
    if gateway.get('gatewayRunning') is not False:
        raise RuntimeError('尚未确认诺拉后台进程已停止，未恢复文件。')
    proof = {'offline': True, 'running': False, 'gatewayRunning': False}
    emit('result', **proof)
    return proof


def recovery_verify(args, before):
    state = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    if any(type(value.get(key)) is not bool for value in (state, before) for key in ('running', 'gatewayRunning')):
        raise RuntimeError('恢复前后的服务核验信息不完整。')
    if str(state.get('version', '')).lstrip('v') != str(before.get('version', '')).lstrip('v'):
        raise RuntimeError('恢复后的旧版本核验失败。')
    if before.get('systemReady') and not state.get('systemReady'):
        raise RuntimeError('旧版本文件已恢复，但安装完整性核验尚未通过。')
    if any(bool(state.get(key)) != bool(before.get(key)) for key in ('running', 'gatewayRunning')):
        raise RuntimeError('旧版本文件已恢复，但原有服务状态尚未恢复。')
    if before.get('clawchatConnected') and not state.get('clawchatConnected'):
        raise RuntimeError('旧版本文件已恢复，但 ClawChat 连接尚未恢复。')
    return state


def command_recover_update(args):
    gate = operation_control.require_operation()
    if gate.operation_id != args.operation_id:
        raise RuntimeError('更新恢复编号与当前受管操作不一致，未修改文件。')
    helper = nora_system.recovery_module()
    emit('task', stage_id='verify', task='正在核验更新事务和旧版本备份')

    def bind(plan):
        lifecycle = plan.get('lifecycle')
        if not isinstance(lifecycle, dict):
            raise RuntimeError('恢复记录缺少启动器服务计划，未修改文件。')
        for key, value in (('noraHome', args.nora_home), ('hermesHome', args.hermes_home),
                           ('installRoot', args.install_root)):
            if Path(lifecycle[key]).resolve() != value.resolve():
                raise RuntimeError('恢复计划与当前启动器实例不一致，未修改文件。')
        args.port = lifecycle['port']
        return lifecycle

    def stop(plan, _backup):
        bind(plan)
        emit('task', stage_id='stop', task='正在停止当前实例，保留失败现场')
        return recovery_stop(args)

    def resume(plan, _backup):
        lifecycle = bind(plan)
        emit('task', stage_id='start_tavern', task='正在恢复更新前的服务状态')
        original_command = args.command
        args.command = 'update-lifecycle'
        try:
            command_update_lifecycle(args, {**lifecycle, 'before': plan['before'], 'phase': 'rollback'})
        finally:
            args.command = original_command

    def verify(plan, _backup):
        lifecycle = bind(plan)
        return (verify_partial_baseline(args, lifecycle['partialRepair'])
                if lifecycle.get('partialRepair') else recovery_verify(args, plan['before']))

    with helper.recovery_lock(args.install_root):
        helper.recover(args.hermes_home, args.install_root, stop=stop, resume=resume, verify=verify)
    emit('task', stage_id='health_check', task='旧版本和原有服务状态已恢复')
    journal = helper.read_object(args.install_root / 'tavern-updates/transaction.json')
    partial = (journal.get('recoveryPlan', {}).get('lifecycle') or {}).get('partialRepair')
    restored = verify_partial_baseline(args, partial) if partial else status_payload(
        args.nora_home, args.hermes_home, args.install_root, args.port)
    if partial:
        restored.update(installed=installed(args.install_root), managedInstallation=True, needsRepair=True,
                        hermesInstalled=bool(hermes_command(args.nora_home, args.hermes_home, args.install_root)),
                        noraInstalled=False, setupCompleted=False)
    emit('result', **restored, updateRecovered=True, recoveryVerification='confirmed')


def _first_install_helper():
    source = HERE / 'first_install.py'
    if not source.is_file():
        raise RuntimeError('启动器缺少首次安装恢复组件，请保留数据并重新安装新版启动器。')
    spec = importlib.util.spec_from_file_location('launcher_first_install_recovery', source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def command_operation_effects(args):
    transaction = args.nora_home / 'installer/operations' / args.operation_id / 'first-install/transaction.json'
    if transaction.is_file():
        effects = _first_install_helper().inspect_first_install(transaction)
    elif args.kind == 'update':
        if not (args.install_root / 'tavern-updates/transaction.json').exists():
            effects = {'effectState': 'untouched', 'canRecover': False, 'reason': 'no_journal'}
        else:
            effects = nora_system.recovery_module().effects(args.hermes_home, args.install_root)
        if effects.get('operationId') != args.operation_id and effects.get('status') in ('committed', 'restored'):
            effects = {'effectState': 'untouched', 'canRecover': False, 'reason': 'other_completed_operation'}
        elif effects.get('operationId') == args.operation_id and effects.get('status') == 'committed':
            effects.update(recoveryOutcome='not-required', canResume=True)
    else:
        effects = {'effectState': 'untouched', 'canRecover': False, 'reason': 'no_journal'}
    emit('result', effects=effects)


def command_resume_committed_update(args):
    helper = nora_system.recovery_module()
    journal = helper.load(args.hermes_home, args.install_root, full=False)
    gate = operation_control.require_operation()
    if (journal.record.get('status') != 'committed' or journal.record.get('operationId') != args.operation_id
            or gate.operation_id != args.operation_id):
        raise RuntimeError('此次更新没有已提交的受管事务，未重复替换文件。')
    lifecycle = journal.plan.get('lifecycle')
    if not isinstance(lifecycle, dict):
        raise RuntimeError('更新事务缺少原服务验收计划，未改变文件。')
    for key, target in (('noraHome', args.nora_home), ('hermesHome', args.hermes_home), ('installRoot', args.install_root)):
        if Path(str(lifecycle.get(key, ''))).resolve() != target.resolve():
            raise RuntimeError('更新事务的实例绑定无法确认。')
    args.port = lifecycle['port']
    command_update_lifecycle(args, {**lifecycle, 'before': journal.plan['before'], 'phase': 'verify',
                                   'version': journal.record['version']})
    state = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    if state.get('systemReady') is not True or str(state.get('version', '')).lstrip('v') != str(journal.record['version']).lstrip('v'):
        raise RuntimeError('更新后的版本或完整性尚未通过验收，已保留旧版本备份。')
    emit('result', **state, operationVerified=True, updateVerified=True)


def command_verify_current_update(args):
    operation_control.require_operation()
    acceptance = nora_system.inspect(args.hermes_home, args.install_root, args.port)
    state = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    if (acceptance.get('ready') is not True or state.get('systemReady') is not True
            or str(state.get('version', '')).lstrip('v') != str(args.version).lstrip('v')
            or any(type(state.get(key)) is not bool for key in ('running', 'gatewayRunning'))):
        raise RuntimeError('当前酒馆的固定版本、文件或进程状态未通过核验，旧启动器备份已保留。')
    emit('result', **state, updateVerified=True)


def command_inspect_current_update(args):
    """Verify an already installed combination without owning or changing a task."""
    version = str(args.version).removeprefix('v')
    commit = str(args.commit)
    expected_digest = getattr(args, 'manifest_sha256', None)
    if (not re.fullmatch(r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.(?:0|[1-9]\d*))?', version)
            or not re.fullmatch(r'[0-9a-f]{40}', commit)
            or expected_digest is not None and not re.fullmatch(r'[0-9a-f]{64}', expected_digest)):
        raise RuntimeError('当前安装核验目标无效，未改变安装和数据。')
    updates = args.install_root / 'tavern-updates'
    for file in (updates, updates / 'installed.json', updates / 'installed-manifest.json'):
        attributes = file.lstat()
        if file.is_symlink() or getattr(attributes, 'st_file_attributes', 0) & 0x400:
            raise RuntimeError('当前安装记录不能使用链接或重解析目录，未改变安装和数据。')
    files = (updates / 'installed.json', updates / 'installed-manifest.json')
    records, before = [], []
    for file in files:
        value = _repair_object(file)
        raw = file.read_bytes()
        if json.loads(raw) != value:
            raise RuntimeError('当前安装记录正在变化，请等待原任务结束。')
        records.append(value)
        before.append(raw)
    receipt, manifest = records
    if (receipt.get('schema') not in (1, 2) or manifest.get('schema') != 'tavern-release/v2'
            or receipt.get('version') != version or manifest.get('versions', {}).get('tavern') != version
            or receipt.get('commit') != commit or manifest.get('commit') != commit
            or expected_digest is not None and hashlib.sha256(before[1]).hexdigest() != expected_digest
            or receipt.get('manifestDigest') is not None and receipt['manifestDigest'] != hashlib.sha256(
                json.dumps(manifest, sort_keys=True).encode()).hexdigest()):
        raise RuntimeError('当前核心版本、提交或已安装清单与固定目标不一致，未改变安装和数据。')
    acceptance = nora_system.inspect(args.hermes_home, args.install_root, args.port)
    state = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    if (acceptance.get('ready') is not True or state.get('systemReady') is not True
            or str(state.get('version', '')).removeprefix('v') != version or state.get('commit') != commit
            or any(type(state.get(key)) is not bool for key in ('running', 'gatewayRunning'))
            or any(file.read_bytes() != raw for file, raw in zip(files, before))):
        raise RuntimeError('当前安装完整性、进程状态或稳定记录未通过核验，未改变安装和数据。')
    emit('result', **state, updateVerified=True, verificationScope='read-only-current-install')


def command_resume_committed_install(args):
    gate = operation_control.require_operation()
    transaction = args.nora_home / 'installer/operations' / args.operation_id / 'first-install/transaction.json'
    helper = _first_install_helper()
    journal = helper.FirstInstallJournal.load(transaction)
    effects = helper.inspect_first_install(transaction)
    if (gate.operation_id != args.operation_id or effects.get('operationId') != args.operation_id
            or effects.get('status') != 'committed' or effects.get('canResume') is not True
            or journal.record.get('noraHome') != str(args.nora_home)
            or journal.record.get('roots') != {'hermes': str(args.hermes_home), 'tavern': str(args.install_root)}):
        raise RuntimeError('首装事务尚未确认提交，未重复安装文件。')
    state = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    if state.get('running') is False:
        args.service = 'tavern'
        command_start(args)
    acceptance = nora_system.inspect(args.hermes_home, args.install_root, args.port)
    proof = nora_system.verify_runtime(args.hermes_home, args.install_root, args.port,
                                       python_command(args.hermes_home), env_for(args.nora_home, args.hermes_home, args.install_root))
    state = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    if (acceptance.get('ready') is not True or state.get('systemReady') is not True
            or state.get('running') is not True or not all(proof.get(key) for key in nora_system.PROOFS)
            or str(state.get('version', '')).lstrip('v') != str(effects.get('version', '')).lstrip('v')):
        raise RuntimeError('首装文件已提交，但实际程序和连接尚未通过验收；未重复安装。')
    emit('result', **state, operationVerified=True, firstInstallVerified=True)


def command_recover_install(args):
    transaction = args.nora_home / 'installer/operations' / args.operation_id / 'first-install/transaction.json'
    result = _first_install_helper().resume_first_install(transaction, stop=lambda: recovery_stop(args))
    if result.get('status') != 'restored':
        error = RuntimeError('首次安装恢复未完成，已保留故障现场和原数据。')
        error.code = 'UPDATE_RECOVERY_REQUIRED'
        error.secondary_errors = result.get('errors', [])
        raise error
    emit('result', **status_payload(args.nora_home, args.hermes_home, args.install_root, args.port),
         firstInstallRecovered=True, recoveryVerification='confirmed')


def command_update_lifecycle(args, plan=None):
    plan = json.load(sys.stdin) if plan is None else plan
    before = plan["before"]
    phase = plan["phase"]
    if phase not in ("preflight", "stop", "verify", "rollback", "recover-stop", "recover-verify"):
        fail("未知的更新事务阶段")
    for name in ("nora_home", "hermes_home", "install_root"):
        key = {"nora_home": "noraHome", "hermes_home": "hermesHome", "install_root": "installRoot"}[name]
        if Path(plan[key]).resolve() != getattr(args, name).resolve():
            fail("更新事务路径不匹配")
    partial = plan.get('partialRepair')
    if partial and phase in ('preflight', 'stop', 'rollback', 'recover-verify'):
        result = (verify_partial_baseline(args, partial) if phase in ('rollback', 'recover-verify')
                  else verify_partial_restoration(args, partial))
        if phase in ('rollback', 'recover-verify'):
            emit('result', **result, installed=installed(args.install_root), managedInstallation=True,
                 needsRepair=True, hermesInstalled=bool(hermes_command(args.nora_home, args.hermes_home, args.install_root)),
                 noraInstalled=False, setupCompleted=False)
            return
        emit('result', **result)
        return
    if phase == 'recover-stop':
        recovery_stop(args)
        return
    if phase == 'recover-verify':
        emit('result', **recovery_verify(args, before))
        return
    receipt_recovery = plan.get('receiptRecovery')
    if receipt_recovery and phase in ('preflight', 'rollback'):
        if missing_receipt_snapshot(args) != receipt_recovery:
            fail('旧安装的实例、版本或配置与更新前不一致，未恢复服务。')
    if phase == 'preflight':
        check_gateway_control(args.nora_home, args.hermes_home)
        state = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
        if (not before.get('version') or str(state.get('version', '')).lstrip('v') != str(before['version']).lstrip('v')
                or any(type(state.get(key)) is not bool or type(before.get(key)) is not bool
                       or state[key] != before[key] for key in ('running', 'gatewayRunning'))):
            fail('更新前的版本或服务状态已变化，请重新检查更新')
        emit('result', **state)
        return
    args.service = 'all'
    command_stop(args)
    if phase == 'stop':
        _recovery_require_native_offline(args)
        if gateway_status(args.nora_home, args.hermes_home).get('gatewayRunning') is not False:
            raise RuntimeError('尚未确认诺拉后台进程已停止，未开始替换。')
        emit('result', offline=True, running=False, gatewayRunning=False)
        return
    if phase == 'verify':
        acceptance = nora_system.inspect(args.hermes_home, args.install_root, args.port)
        if not acceptance['ready']:
            fail('更新事务完整性复核失败：' + '；'.join(acceptance['problems']))
    missing_receipt_rollback = phase == 'rollback' and bool(receipt_recovery)
    damaged_rollback = phase == 'rollback' and before.get('systemReady') is False and not missing_receipt_rollback
    # Explicitly disconnected snapshots require only the original running state.
    # Missing fields from older lifecycle clients keep the strict start contract.
    restore_connection = before.get('clawchatConnected') is not False
    if missing_receipt_rollback:
        # Resume only services that actually ran before this transaction, after
        # exact old bindings/records were restored. Do not manufacture acceptance
        # for the old version or rerun first setup during rollback.
        env = env_for(args.nora_home, args.hermes_home, args.install_root)
        if before.get('running'):
            lifecycle = args.install_root / 'apps/tavern-runtime/native_lifecycle.py'
            run_stream([python_command(args.hermes_home), '-u', '-B', str(lifecycle), 'start', '--port', str(args.port)], env=env, native_cli=True)
        if before.get('gatewayRunning'):
            start_gateway(args.nora_home, args.hermes_home,
                          [python_command(args.hermes_home), '-m', 'hermes_cli.main', 'gateway', 'run'], env,
                          require_connection=restore_connection)
    elif damaged_rollback:
        system = nora_system.inspect(args.hermes_home, args.install_root, args.port)
        if not _same_skill_damage(before, system):
            fail('旧安装的版本或完整性问题与更新前不一致，未恢复服务')
        # Restore services separately without rerunning first-setup verification.
        for key, service in (('running', 'tavern'), ('gatewayRunning', 'nora')):
            if before.get(key):
                args.service = service
                command_start(args, require_clawchat_connection=restore_connection)
    elif before.get('running') or before.get('gatewayRunning'):
        args.service = ('all' if before.get('running') and before.get('gatewayRunning') else
                        'tavern' if before.get('running') else 'nora')
        command_start(args, require_clawchat_connection=restore_connection if phase == 'rollback' else True)
    state = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
    if damaged_rollback and not _same_skill_damage(before, {
            'version': state.get('version'), 'problems': state.get('systemProblems', [])}):
        fail('恢复服务后旧安装的完整性问题发生变化')
    expected = plan['version'] if phase == 'verify' else before.get('version')
    if str(state.get('version', '')).lstrip('v') != str(expected).lstrip('v'):
        fail('更新事务版本复核失败')
    if (phase == 'verify' or before.get('systemReady')) and not state.get('systemReady'):
        fail('更新事务完整性复核失败：' + '；'.join(state.get('systemProblems', [])))
    for key in ('running', 'gatewayRunning'):
        if type(state.get(key)) is not bool or type(before.get(key)) is not bool or state[key] != before[key]:
            fail('未能恢复更新前的服务状态：' + key)
    if before.get('clawchatConnected') and not state.get('clawchatConnected'):
        fail('未能恢复更新前的 ClawChat 连接')
    emit('result', **state)


def command_update(args, *, repair: bool = False, plan: bool = False) -> None:
    managed = (args.install_root / "tavern-updates/nora-system.json").is_file()
    partial = partial_repair_preflight(args) if managed and not installed(args.install_root) else None
    if not installed(args.install_root) and not partial:
        fail("还没有安装 Nora Tavern。")
    bootstrap = args.install_root / "apps/tavern-ops/updater/bootstrap.py"
    selected = release_dir(args.release_dir) if getattr(args, "release_dir", None) else None
    manifest = nora_system.read_json(selected / 'release-manifest.json') if selected else {}
    recovering_receipt = bool(selected and not managed)
    if recovering_receipt and manifest.get('bootstrap', {}).get('managedReceiptRecovery') != 1:
        fail("缺少系统安装记录，无法确认此旧部署的安全升级与回滚方式。未修改当前安装；请保留数据并导出日志，勿清空重装。")
    if recovering_receipt:
        managed = True
        emit('task', stage_id='verify', task='核对旧安装的实例和版本记录，保留现有数据进行升级')
    if managed:
        if not selected or repair:
            fail("请从启动器的检查更新入口更新完整系统。")
        bootstrap = selected / "tavern-updater-bootstrap.py"
        if not bootstrap.is_file() or hashlib.sha256(bootstrap.read_bytes()).hexdigest() != manifest.get("bootstrap", {}).get("sha256"):
            fail("更新器校验失败，当前安装未修改。")
        instance = nora_system.read_json(args.hermes_home / "nora-instance.json")
        if instance.get("port") != args.port:
            fail("启动器端口与实例记录不一致，已停止更新。")
        if not plan and manifest.get('bootstrap', {}).get('managedLifecycle') != 1:
            fail('目标更新组件不支持启动验证失败回滚，现有安装未修改。请使用支持事务恢复的新版本。')
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
    if getattr(args, 'allow_candidate', False):
        if not selected:
            fail('测试版本必须明确指定本地验收目录。')
        command.append('--allow-candidate')
    if managed:
        command += ["--managed-home", str(args.nora_home)]
    if getattr(args, "tag", None):
        if not re.fullmatch(r"[a-zA-Z0-9._-]{1,100}", args.tag):
            fail("版本编号无效。")
        command += ["--tag", args.tag]
    if plan:
        result = run_json(command + ["--plan"], env=env_for(args.nora_home, args.hermes_home, args.install_root), timeout=180)
        emit("result", **result)
        return
    env = env_for(args.nora_home, args.hermes_home, args.install_root)
    if managed:
        before = partial or status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
        env['NORA_UPDATE_LIFECYCLE'] = json.dumps({
            'bridge': str(Path(__file__).resolve()), 'noraHome': str(args.nora_home),
            'hermesHome': str(args.hermes_home), 'installRoot': str(args.install_root),
            'port': args.port, 'before': {key: before.get(key) for key in
                ('version', 'systemReady', 'systemProblems', 'running', 'gatewayRunning', 'clawchatConnected')},
            **({'receiptRecovery': missing_receipt_snapshot(args)} if recovering_receipt else {}),
            **({'partialRepair': partial['partialRepair']} if partial else {})})
    result = run_stream(command, env=env)
    if managed:
        if not result or not result.get('updateVerified'):
            fail('更新事务未返回验证结果；请保留日志，不要重新安装。')
    else:
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
    sub.add_parser('repair-preflight').add_argument('--offline-only', action='store_true')
    sub.add_parser("verify-model")
    sub.add_parser('verify-current-update').add_argument('--version', required=True)
    inspect_current = sub.add_parser('inspect-current-update')
    inspect_current.add_argument('--version', required=True)
    inspect_current.add_argument('--commit', required=True)
    inspect_current.add_argument('--manifest-sha256')
    install = sub.add_parser("install")
    install.add_argument("--release-dir")
    for action in ("start", "stop", "restart"):
        sub.add_parser(action).add_argument("--service", choices=("all", "nora", "tavern"), default="all")
    sub.add_parser("finish-update")
    sub.add_parser("update-lifecycle")
    sub.add_parser("recovery-stop")
    for name in ('operation-effects', 'recover-update', 'recover-install', 'resume-committed-update', 'resume-committed-install'):
        command = sub.add_parser(name)
        command.add_argument('--operation-id', required=True)
        if name == 'operation-effects':
            command.add_argument('--kind', choices=('install', 'update'), required=True)
    sub.add_parser("pair")
    update = sub.add_parser("update")
    update.add_argument("--tag")
    update.add_argument("--release-dir")
    update.add_argument('--allow-candidate', action='store_true')
    plan_update = sub.add_parser("plan-update")
    plan_update.add_argument("--release-dir", required=True)
    plan_update.add_argument('--allow-candidate', action='store_true')
    sub.add_parser("check-update")
    sub.add_parser("repair")
    sub.add_parser("open-logs")
    sub.add_parser("open-settings")
    open_url = sub.add_parser("open-url")
    open_url.add_argument("url")
    args = parser.parse_args()
    if hasattr(args, 'operation_id') and not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', args.operation_id, re.I):
        raise RuntimeError('操作记录编号无效')
    if args.command != "status":
        emit("diagnostic", component="python", executable=sys.executable, version=sys.version)
    args.nora_home = safe(args.nora_home) if args.nora_home else default_nora_home()
    args.hermes_home = safe(args.hermes_home) if args.hermes_home else default_hermes_home(args.nora_home)
    args.install_root = safe(args.install_root) if args.install_root else default_install_root(args.nora_home)
    require_descendant(args.nora_home, args.hermes_home, "Hermes 目录")
    require_descendant(args.nora_home, args.install_root, "Tavern 目录")
    readonly = args.command in ('status', 'repair-preflight', 'verify-model', 'operation-effects', 'plan-update', 'check-update', 'inspect-current-update', 'open-logs', 'open-settings', 'open-url')
    if not readonly:
        from operation_cli import ensure_operation
        ensure_operation({'recover-update': 'recover', 'recover-install': 'recover',
                          'recovery-stop': 'stop', 'update-lifecycle': 'update',
                          'resume-committed-update': 'update', 'resume-committed-install': 'install',
                          'verify-current-update': 'update'}.get(args.command, args.command),
                         nora_home=args.nora_home)
    if args.command == "status":
        command_status(args)
    elif args.command == 'repair-preflight':
        emit('result', **(partial_repair_offline(args) if args.offline_only else partial_repair_preflight(args)))
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
    elif args.command == "recovery-stop":
        recovery_stop(args)
    elif args.command == "restart":
        command_stop(args)
        command_start(args)
    elif args.command == "pair":
        command_pair(args)
    elif args.command == "finish-update":
        acceptance = nora_system.inspect(args.hermes_home, args.install_root, args.port)
        if not acceptance['ready']:
            fail('更新验收未通过：' + '；'.join(acceptance['problems']))
        state = status_payload(args.nora_home, args.hermes_home, args.install_root, args.port)
        if not all(state.get(key) for key in ('systemReady', 'modelConfigured', 'clawchatPaired', 'clawchatProfileReady')):
            fail('更新后的 Nora 配置未通过检查。')
        nora_system.mark_setup_complete(args.install_root)
        command_status(args)
    elif args.command == "update":
        command_update(args)
    elif args.command == "update-lifecycle":
        command_update_lifecycle(args)
    elif args.command == "recover-update":
        command_recover_update(args)
    elif args.command == 'recover-install':
        command_recover_install(args)
    elif args.command == 'operation-effects':
        command_operation_effects(args)
    elif args.command == 'resume-committed-update':
        command_resume_committed_update(args)
    elif args.command == 'resume-committed-install':
        command_resume_committed_install(args)
    elif args.command == 'verify-current-update':
        command_verify_current_update(args)
    elif args.command == 'inspect-current-update':
        command_inspect_current_update(args)
    elif args.command == "plan-update":
        command_update(args, plan=True)
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
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        import errno
        code = errno.errorcode.get(error.errno) if isinstance(error, OSError) else getattr(error, "code", None)
        if isinstance(error, subprocess.TimeoutExpired):
            code = "TIMEOUT"
        fail(str(error), code, getattr(error, 'user_code', None), error=error)
