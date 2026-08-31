"""Prepare and supervise Nora's bundled SillyTavern source engine.

SillyTavern source is part of the Nora repository and owns card parsing,
prompt assembly, chats, world info, and extension execution. This module only
verifies the source contract, prepares Node dependencies, installs user-scoped
Nora extensions, and runs the bundled engine as one Node process.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request


COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
MANAGED_EXTENSIONS = (
    "JS-Slash-Runner",
    "nora-mvu",
    "nora-ui",
    "nora-ledger",
)
OBSOLETE_MANAGED_EXTENSIONS = (
    "nora-shell",
    "nora-character-status",
)


class NativeLifecycleError(RuntimeError):
    pass


@dataclass(frozen=True)
class RuntimeContract:
    upstream_repository: str
    upstream_tag: str
    commit: str
    node_min_major: int
    source_dir: str

    @classmethod
    def from_dict(cls, value):
        if not isinstance(value, dict) or value.get("schema") != 2:
            raise NativeLifecycleError("unsupported native runtime contract")
        if value.get("engine") != "SillyTavern":
            raise NativeLifecycleError("native runtime must be SillyTavern")
        commit = str(value.get("upstream_commit") or "").lower()
        if not COMMIT_RE.fullmatch(commit):
            raise NativeLifecycleError("upstream runtime commit must be an exact SHA-1")
        repository = str(value.get("upstream_repository") or "")
        tag = str(value.get("upstream_tag") or "")
        source_dir = str(value.get("source_dir") or "")
        node_min_major = int(value.get("node_min_major") or 0)
        if not repository.startswith("https://github.com/SillyTavern/"):
            raise NativeLifecycleError("upstream runtime repository is not approved")
        source_path = Path(source_dir)
        if (
            not tag
            or not source_dir
            or source_path.is_absolute()
            or ".." in source_path.parts
            or node_min_major < 20
        ):
            raise NativeLifecycleError("native runtime contract is incomplete")
        return cls(repository, tag, commit, node_min_major, source_dir)


def render_native_config(source):
    """Render the config for a localhost-only runtime behind Liveware."""
    replacements = {
        "enableServerPlugins": "true",
        "enableServerPluginsAutoUpdate": "false",
        "whitelistMode": "false",
        "enableForwardedWhitelist": "false",
    }
    nested_replacements = {
        "performance.lazyLoadCharacters": "true",
        "extensions.autoUpdate": "false",
    }
    found = set()
    output = []
    section = ""
    for line in source.splitlines():
        stripped = line.lstrip()
        indentation = line[:len(line) - len(stripped)]
        key = stripped.split(":", 1)[0] if stripped and not stripped.startswith("#") else ""
        if key and not indentation:
            section = key
        if not indentation and key in replacements:
            output.append(f"{key}: {replacements[key]}")
            found.add(key)
        elif indentation and f"{section}.{key}" in nested_replacements:
            path = f"{section}.{key}"
            output.append(f"{indentation}{key}: {nested_replacements[path]}")
            found.add(path)
        else:
            output.append(line)
    required = set(replacements) | set(nested_replacements)
    missing = required - found
    if missing:
        raise NativeLifecycleError(
            "official config is missing required keys: " + ", ".join(sorted(missing))
        )
    return "\n".join(output) + "\n"


def _atomic_text(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    os.chmod(temporary, mode)
    temporary.replace(path)


class NativeRuntime:
    def __init__(self, data_root, app_root, state_root, contract):
        self.data_root = Path(data_root).expanduser().resolve()
        self.app_root = Path(app_root).expanduser().resolve()
        self.state_root = Path(state_root).expanduser().resolve()
        self.contract = contract
        candidates = (
            self.app_root / contract.source_dir,
            self.app_root.parent / contract.source_dir,
        )
        self.engine_root = next(
            (path.resolve() for path in candidates if path.is_dir()),
            candidates[0].resolve(),
        )
        self.native_data_root = self.state_root / "native"
        self.runtime_state = self.state_root / "native-runtime"
        self.config_path = self.runtime_state / "config.yaml"
        self.ready_marker = self.runtime_state / "ready.json"
        self.dependencies_marker = self.runtime_state / "dependencies.json"
        self._children = {}

    @classmethod
    def from_environment(cls):
        home = Path(os.environ.get("HERMES_HOME") or (
            "/opt/data" if sys.platform.startswith("linux") and Path("/opt/data/skills").is_dir()
            else Path.home() / ".hermes"
        ))
        data_root = Path(os.environ.get("TAVERN_DATA_ROOT", str(home)))
        app_root = Path(os.environ.get(
            "TAVERN_APP_DIR", str(data_root / "apps/tavern-runtime")
        ))
        state_root = Path(os.environ.get(
            "TAVERN_STATE_DIR", str(data_root / "tavern-state")
        ))
        contract_path = app_root / "native-runtime.json"
        if not contract_path.is_file():
            contract_path = app_root / "native/runtime.json"
        try:
            contract = RuntimeContract.from_dict(
                json.loads(contract_path.read_text(encoding="utf-8"))
            )
        except (OSError, ValueError) as error:
            raise NativeLifecycleError(f"cannot read native runtime contract: {error}")
        return cls(data_root, app_root, state_root, contract)

    @classmethod
    def for_test(cls, root, app_root, contract):
        root = Path(root)
        return cls(
            root,
            app_root,
            root / "state",
            RuntimeContract.from_dict(contract),
        )

    def node_major(self):
        result = subprocess.run(
            ["node", "--version"], check=True, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        match = re.fullmatch(r"v(\d+)(?:\.\d+){2}", result.stdout.strip())
        if not match:
            raise NativeLifecycleError("cannot parse Node.js version")
        return int(match.group(1))

    def source_metadata(self):
        marker = self.engine_root / ".nora-upstream.json"
        try:
            metadata = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise NativeLifecycleError(f"cannot read bundled engine metadata: {error}")
        if (
            metadata.get("schema") != 1
            or metadata.get("engine") != "SillyTavern"
            or metadata.get("integration") != "nora-source"
            or str(metadata.get("repository") or "") != self.contract.upstream_repository
            or str(metadata.get("tag") or "") != self.contract.upstream_tag
            or str(metadata.get("commit") or "").lower() != self.contract.commit
        ):
            raise NativeLifecycleError("bundled SillyTavern metadata does not match the source contract")
        return metadata

    def lock_digest(self):
        lock_path = self.engine_root / "package-lock.json"
        try:
            return hashlib.sha256(lock_path.read_bytes()).hexdigest()
        except OSError as error:
            raise NativeLifecycleError(f"cannot read bundled dependency lock: {error}")

    def verify_source(self):
        required = (
            self.engine_root / "server.js",
            self.engine_root / "default/config.yaml",
            self.engine_root / "package.json",
            self.engine_root / "package-lock.json",
            self.engine_root / "public/index.html",
        )
        missing = [str(path) for path in required if not path.exists()]
        if missing:
            raise NativeLifecycleError("bundled native source is incomplete: " + ", ".join(missing))
        try:
            package = json.loads((self.engine_root / "package.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise NativeLifecycleError(f"cannot read bundled engine package: {error}")
        metadata = self.source_metadata()
        if str(package.get("version") or "") != str(metadata.get("version") or ""):
            raise NativeLifecycleError("bundled engine package version does not match its metadata")
        source_markers = (
            ("public/index.html", 'class="no-blur nora-product"'),
            ("src/server-main.js", "computeStaticAssetRelease"),
            ("src/workspace.js", "function createExtensionsRouteHandler"),
            ("src/middleware/webpack-serve.js", "Nora pinned build output v4"),
        )
        for relative, marker in source_markers:
            try:
                source = (self.engine_root / relative).read_text(encoding="utf-8")
            except OSError as error:
                raise NativeLifecycleError(f"cannot read bundled Nora engine source {relative}: {error}")
            if marker not in source:
                raise NativeLifecycleError(f"bundled Nora engine source is missing integration marker: {relative}")
        return {
            "ok": True,
            "commit": self.contract.commit,
            "version": metadata["version"],
            "path": str(self.engine_root),
            "source": "bundled",
            "lock_sha256": self.lock_digest(),
        }

    def dependencies_ready(self, node_major=None):
        required = (
            self.engine_root / "node_modules/express/package.json",
            self.engine_root / "node_modules/webpack/package.json",
        )
        if not all(path.is_file() for path in required):
            return False
        try:
            marker = json.loads(self.dependencies_marker.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        return (
            marker.get("schema") == 1
            and marker.get("lock_sha256") == self.lock_digest()
            and int(marker.get("node_major") or 0) == int(node_major or self.node_major())
        )

    def verify_install(self):
        report = self.verify_source()
        try:
            node_major = self.node_major()
        except (OSError, subprocess.SubprocessError) as error:
            raise NativeLifecycleError(f"cannot verify Node.js: {error}")
        if node_major < self.contract.node_min_major:
            raise NativeLifecycleError(
                f"Node.js {self.contract.node_min_major}+ is required; found {node_major}"
            )
        if not self.dependencies_ready(node_major):
            raise NativeLifecycleError("bundled SillyTavern dependencies are not prepared")
        return {**report, "node_major": node_major, "dependencies": "ready"}

    def install(self):
        report = self.verify_source()
        try:
            node_major = self.node_major()
        except (OSError, subprocess.SubprocessError) as error:
            raise NativeLifecycleError(f"cannot verify Node.js: {error}")
        if node_major < self.contract.node_min_major:
            raise NativeLifecycleError(
                f"Node.js {self.contract.node_min_major}+ is required; found {node_major}"
            )
        installed = not self.dependencies_ready(node_major)
        if installed:
            try:
                subprocess.run(
                    ["npm", "ci", "--omit=dev", "--no-audit", "--no-fund"],
                    cwd=self.engine_root,
                    check=True,
                )
            except (OSError, subprocess.SubprocessError) as error:
                raise NativeLifecycleError(f"cannot prepare bundled SillyTavern dependencies: {error}")
            _atomic_text(
                self.dependencies_marker,
                json.dumps({
                    "schema": 1,
                    "lock_sha256": self.lock_digest(),
                    "node_major": node_major,
                    "prepared_at": int(time.time()),
                }, indent=2) + "\n",
            )
        report = self.verify_install()
        self.sync_assets()
        return {**report, "installed": installed, "path": str(self.engine_root)}

    def sync_assets(self, data_root=None):
        self.verify_source()
        data_root = Path(data_root or self.native_data_root)
        extension_source = self.app_root / "native-extensions"
        # Source-tree fallback keeps this module directly testable before packaging.
        if not extension_source.is_dir():
            extension_source = self.app_root / "native/extensions"
        if not extension_source.is_dir():
            raise NativeLifecycleError("Nora native extensions are missing")
        extension_target = data_root / "default-user/extensions"
        extension_target.mkdir(parents=True, exist_ok=True)
        for name in OBSOLETE_MANAGED_EXTENSIONS:
            shutil.rmtree(extension_target / name, ignore_errors=True)
        for name in MANAGED_EXTENSIONS:
            source = extension_source / name
            if not source.is_dir():
                raise NativeLifecycleError(f"managed Nora extension is missing: {name}")
            target = extension_target / name
            shutil.rmtree(target, ignore_errors=True)
            shutil.copytree(source, target)
        # Initial installation owns defaults; subsequent starts/updates preserve
        # the operator's settings instead of silently resetting config.yaml.
        if not self.config_path.exists():
            config = render_native_config(
                (self.engine_root / "default/config.yaml").read_text(encoding="utf-8")
            )
            _atomic_text(self.config_path, config, mode=0o600)
        return {
            "extensions": list(MANAGED_EXTENSIONS),
            "engine": str(self.engine_root),
            "source_mode": "bundled",
            "config": str(self.config_path),
        }

    def run_dir(self, run_id):
        if not RUN_ID_RE.fullmatch(run_id):
            raise NativeLifecycleError("invalid run id")
        return self.runtime_state / "runs" / run_id

    def spawn(self, command, env, log_path):
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log = open(log_path, "ab", buffering=0)
        try:
            return subprocess.Popen(
                command,
                cwd=self.engine_root,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        finally:
            log.close()

    def operations_module(self, name):
        if name == 'service_manager':
            self.operations_module('runtime_process')
        source = Path(__file__).resolve().parents[1] / 'ops/updater' / (name + '.py')
        if not source.is_file():
            source = self.app_root.parent / 'tavern-ops/updater' / (name + '.py')
        existing = sys.modules.get(name)
        # During update, staged/installed source paths change. Maintenance
        # ownership stays with the executing updater, not the staged module.
        if existing and (name == 'runtime_lock' or Path(existing.__file__).resolve() == source.resolve()):
            return existing
        key = 'tavern_operations_' + name + '_' + hashlib.sha256(str(source).encode()).hexdigest()[:12]
        if key not in sys.modules:
            spec = importlib.util.spec_from_file_location(key, source)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            sys.modules[key] = module
            sys.modules.setdefault(name, module)
        return sys.modules[key]

    def service_module(self):
        return self.operations_module('service_manager')

    def process_module(self):
        return self.operations_module('runtime_process')

    def managed_service(self):
        # Standalone/local runtimes need no dependency on installed operations.
        try:
            args = Path('/proc/1/cmdline').read_bytes().split(b'\0')
        except FileNotFoundError:
            return None
        if Path(os.fsdecode(args[0])).name != 'supervisord':
            return None
        return self.service_module().ManagedService.discover(self.data_root, self.app_root)

    def node_command(self, port, native_data):
        node = shutil.which('node')
        if not node:
            raise NativeLifecycleError('Node executable is unavailable')
        return [node, 'server.js', '--configPath', str(self.config_path), '--port', str(port),
                '--dataRoot', str(native_data), '--listen', 'false', '--whitelist', 'false']

    def start(self, run_id="production", port=8799, data_root=None, *, assets_prepared=False):
        with self.operations_module('runtime_lock').installation_lock(self.data_root):
            return self._start(run_id, port, data_root, assets_prepared=assets_prepared)

    def _start(self, run_id, port, data_root, *, assets_prepared):
        self.verify_install()
        native_data = Path(data_root or self.native_data_root)
        if not assets_prepared:
            self.sync_assets(native_data)
        run_dir = self.run_dir(run_id)
        run_dir.mkdir(parents=True, exist_ok=True)
        service = self.managed_service() if run_id == 'production' else None
        if service and data_root is not None and Path(data_root).resolve() != self.native_data_root:
            raise NativeLifecycleError('Managed service cannot use a different data root')
        if service and service.descriptor['command'] != shlex.join(self.node_command(port, native_data)):
            raise NativeLifecycleError('Managed start command differs; migrate it through the updater first')
        native_pid = None if service else self._read_pid(run_dir / "native.pid")
        processes = self.process_module()
        script = self.engine_root / 'server.js'
        if native_pid:
            process = processes.process_record(native_pid, script)
            if process['argv'] != self.node_command(port, native_data) or Path(process['cwd']) != self.engine_root:
                raise NativeLifecycleError('Running Tavern configuration differs; stop the reviewed instance explicitly')
            processes.require_listener(process, script, port)
            current = self.health(port)
            if current["ok"]:
                return {
                    "schema": 1,
                    "run_id": run_id,
                    "port": port,
                    "data_root": str(native_data),
                    "native_pid": native_pid,
                    "already_running": True,
                    "health": current,
                }
        if native_pid:
            raise NativeLifecycleError('Existing Tavern is unhealthy; explicit recovery is required')
        if not service and processes.port_open(port):
            raise NativeLifecycleError('Tavern port is occupied; no process was started')
        env = os.environ.copy()
        # The descriptor is for short-lived launchers, not the running server.
        env.pop('TAVERN_MAINTENANCE_FD', None)
        env.setdefault(
            "TAVERN_PERSONALITY_FILE",
            str(Path(env.get("HERMES_HOME") or Path.home() / ".hermes") / "SOUL.md"),
        )
        if service:
            native_pid = service.start()
        else:
            child = self.spawn(self.node_command(port, native_data), env, run_dir / 'native.log')
            native_pid = child.pid
            self._children[native_pid] = child
        process = processes.process_record(native_pid, script)
        if not process:
            raise NativeLifecycleError('Started Tavern process exited before identity verification')
        _atomic_text(run_dir / "native.pid", str(native_pid) + "\n")
        metadata = {
            "schema": 1,
            "run_id": run_id,
            "port": port,
            "data_root": str(native_data),
            "native_pid": native_pid,
            "started_at": int(time.time()),
            "contract_commit": self.contract.commit,
            "process": process,
        }
        _atomic_text(run_dir / "run.json", json.dumps(metadata, indent=2) + "\n")
        try:
            health = self.wait_for_health(port)
            processes.require_listener(process, script, port)
        except Exception:
            self.stop_run(run_id)
            raise
        return {**metadata, "health": health}

    def request_json(self, url):
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=3) as response:
            if response.status != 200:
                raise NativeLifecycleError(f"unexpected health status: {response.status}")
            return json.loads(response.read(1024 * 1024).decode("utf-8"))

    def health(self, port=8799):
        try:
            value = self.request_json(f"http://127.0.0.1:{port}/csrf-token")
            valid = bool(value.get("token"))
            return {
                "ok": valid,
                "checks": {"native": valid},
                "details": {"native": value},
            }
        except Exception as error:
            return {
                "ok": False,
                "checks": {"native": False},
                "details": {"native": {"error": str(error)}},
            }

    def wait_for_health(self, port, timeout=45):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = self.health(port)
            if last["ok"]:
                return last
            time.sleep(1)
        raise NativeLifecycleError(f"native health check timed out: {last}")

    def _read_pid(self, path):
        try:
            pid = int(path.read_text(encoding='utf-8').strip())
        except FileNotFoundError:
            pid = None
        except ValueError as error:
            raise NativeLifecycleError('Invalid Tavern PID file; review it before modifying the runtime') from error
        processes = self.process_module()
        script = self.engine_root / 'server.js'
        process = processes.process_record(pid, script) if pid else None
        metadata_path = path.parent / 'run.json'
        if not process:
            found = processes.find_processes(script)
            if not found:
                return None
            if len(found) != 1 or not metadata_path.exists():
                raise NativeLifecycleError('Live Tavern process lacks unambiguous run ownership; review before changing it')
            process = found[0]
            pid = process['pid']
        if metadata_path.exists():
            metadata = json.loads(metadata_path.read_text())
            saved = metadata.get('process')
            if saved and not processes.same_process(process, saved):
                raise NativeLifecycleError('Tavern process identity differs from the saved runtime')
            if metadata.get('data_root') and metadata.get('port'):
                args = process['argv']
                expected = {'--configPath': str(self.config_path), '--dataRoot': str(metadata['data_root']),
                            '--port': str(metadata['port'])}
                for flag, value in expected.items():
                    if args.count(flag) != 1 or args.index(flag) + 1 >= len(args) or args[args.index(flag) + 1] != value:
                        raise NativeLifecycleError('Tavern process configuration differs from the saved runtime')
        return pid

    def stop_run(self, run_id="production"):
        with self.operations_module('runtime_lock').installation_lock(self.data_root):
            return self._stop_run(run_id)

    def _stop_run(self, run_id):
        run_dir = self.run_dir(run_id)
        processes = self.process_module()
        service = self.managed_service() if run_id == 'production' else None
        pid_path = run_dir / 'native.pid'
        pid = service.pid() if service else self._read_pid(pid_path)
        metadata_path = run_dir / 'run.json'
        metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
        port = metadata.get('port')
        if not pid:
            if port and processes.port_open(port):
                raise NativeLifecycleError('Tavern port has an unowned process; nothing was stopped')
            # The manager must also leave an originally offline entry stopped.
            if service:
                service.stop()
            return {'ok': True, 'run_id': run_id, 'stopped': []}
        script = self.engine_root / 'server.js'
        process = processes.process_record(pid, script)
        if not process:
            raise NativeLifecycleError('Tavern process exited during inspection; inspect again')
        saved = metadata.get('process')
        if saved and not service and not processes.same_process(process, saved):
            raise NativeLifecycleError('Tavern process identity differs from the saved runtime')
        evidence = processes.stop_process(process, script, port=port,
                                          stop=service.stop if service else None)
        child = self._children.pop(pid, None)
        if child:
            child.wait(timeout=3)
        pid_path.unlink(missing_ok=True)
        return {'ok': True, 'run_id': run_id, 'stopped': ['native'], 'evidence': evidence}

    def status(self, run_id="production"):
        run_dir = self.run_dir(run_id)
        try:
            metadata = json.loads((run_dir / 'run.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            metadata = {'run_id': run_id, 'port': 8799}
        process = None
        try:
            service = self.managed_service() if run_id == 'production' else None
            pid = service.pid() if service else self._read_pid(run_dir / 'native.pid')
            process = self.process_module().process_record(pid, self.engine_root / 'server.js') if pid else None
            metadata['native_pid'] = pid if process else None
            if service:
                metadata['manager'] = service.name
            port = int(metadata.get('port', 8799))
            if process:
                self.process_module().require_listener(process, self.engine_root / 'server.js', port)
            health = self.health(port) if process else {'ok': False, 'checks': {}}
            return {**metadata, 'processes': {'native': bool(process)}, 'health': health}
        except (ValueError, OSError, NativeLifecycleError) as error:
            return {**metadata, 'processes': {'native': bool(process)},
                    'health': {'ok': False, 'checks': {}}, 'inspection_error': str(error)}

    def write_ready_marker(self, health):
        if not isinstance(health, dict) or not health.get("ok"):
            raise NativeLifecycleError("cannot mark an unhealthy runtime ready")
        report = {
            "schema": 1,
            "contract_commit": self.contract.commit,
            "verified_at": int(time.time()),
            "health": health,
        }
        _atomic_text(self.ready_marker, json.dumps(report, indent=2) + "\n")
        return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("install")
    for command in ("start", "restart", "status"):
        child = subparsers.add_parser(command)
        child.add_argument("--run-id", default="production")
        child.add_argument("--port", type=int, default=8799)
        child.add_argument("--native-data-root")
    stop = subparsers.add_parser("stop")
    stop.add_argument("--run-id", default="production")
    sync = subparsers.add_parser("sync")
    sync.add_argument("--native-data-root")
    subparsers.add_parser("prepare")
    args = parser.parse_args(argv)
    runtime = NativeRuntime.from_environment()
    if args.command == 'status':
        print(json.dumps(runtime.status(args.run_id), ensure_ascii=False, indent=2))
        return
    with runtime.operations_module('runtime_lock').installation_lock(runtime.data_root):
        result = execute(runtime, args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def execute(runtime, args):
    if args.command == 'restart':
        runtime.stop_run(args.run_id)
        return runtime.start(args.run_id, args.port, args.native_data_root)
    if args.command == "install":
        result = runtime.install()
    elif args.command == "start":
        result = runtime.start(args.run_id, args.port, args.native_data_root)
    elif args.command == "stop":
        result = runtime.stop_run(args.run_id)
    elif args.command == "sync":
        result = runtime.sync_assets(args.native_data_root)
    else:
        runtime.install()
        canary_data = runtime.state_root / "native-canary"
        result = runtime.start("canary", 18801, canary_data)
        try:
            result = runtime.write_ready_marker(result["health"])
        finally:
            runtime.stop_run("canary")
    return result


if __name__ == "__main__":
    try:
        main()
    except NativeLifecycleError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
