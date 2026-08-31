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
import json
import os
from pathlib import Path
import re
import shutil
import signal
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

    def start(self, run_id="production", port=8799, data_root=None):
        self.verify_install()
        native_data = Path(data_root or self.native_data_root)
        self.sync_assets(native_data)
        run_dir = self.run_dir(run_id)
        run_dir.mkdir(parents=True, exist_ok=True)
        native_pid = self._read_pid(run_dir / "native.pid", "server.js")
        if native_pid:
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
            self.stop_run(run_id)
        env = os.environ.copy()
        env.setdefault(
            "TAVERN_PERSONALITY_FILE",
            str(Path(env.get("HERMES_HOME") or Path.home() / ".hermes") / "SOUL.md"),
        )
        native = self.spawn(
            [
                "node", "server.js",
                "--configPath", str(self.config_path),
                "--port", str(port),
                "--dataRoot", str(native_data),
                "--listen", "false",
                "--whitelist", "false",
            ],
            env,
            run_dir / "native.log",
        )
        _atomic_text(run_dir / "native.pid", str(native.pid) + "\n")
        metadata = {
            "schema": 1,
            "run_id": run_id,
            "port": port,
            "data_root": str(native_data),
            "native_pid": native.pid,
            "started_at": int(time.time()),
            "contract_commit": self.contract.commit,
        }
        _atomic_text(run_dir / "run.json", json.dumps(metadata, indent=2) + "\n")
        try:
            health = self.wait_for_health(port)
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

    def _read_pid(self, path, expected=None):
        try:
            pid = int(path.read_text(encoding="utf-8").strip())
            if self._pid_alive(pid, expected):
                return pid
        except (OSError, ValueError):
            pass
        try:
            path.unlink()
        except OSError:
            pass
        return None

    @staticmethod
    def _pid_alive(pid, expected=None):
        try:
            waited, _ = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                return False
        except (ChildProcessError, OSError):
            pass
        proc_stat = Path(f"/proc/{pid}/stat")
        proc_cmdline = Path(f"/proc/{pid}/cmdline")
        try:
            # A zombie still accepts kill(0), but no longer owns a port and must
            # not hold up restart or rollback.
            if proc_stat.is_file() and proc_stat.read_text(encoding="utf-8").split()[2] == "Z":
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
                return False
            if expected and proc_cmdline.is_file():
                command = proc_cmdline.read_bytes().replace(b"\0", b" ").decode(
                    "utf-8", errors="replace"
                )
                if expected not in command:
                    return False
            os.kill(pid, 0)
            return True
        except (OSError, IndexError):
            try:
                os.waitpid(pid, os.WNOHANG)
            except (ChildProcessError, OSError):
                pass
            return False

    def stop_run(self, run_id="production"):
        run_dir = self.run_dir(run_id)
        stopped = []
        for name in ("native",):
            pid_path = run_dir / f"{name}.pid"
            expected = "server.js"
            pid = self._read_pid(pid_path, expected)
            if not pid:
                continue
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and self._pid_alive(pid, expected):
                time.sleep(0.2)
            if self._pid_alive(pid, expected):
                os.killpg(pid, signal.SIGKILL)
            pid_path.unlink(missing_ok=True)
            stopped.append(name)
        return {"ok": True, "run_id": run_id, "stopped": stopped}

    def status(self, run_id="production"):
        run_dir = self.run_dir(run_id)
        try:
            metadata = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            metadata = {"run_id": run_id, "port": 8799}
        processes = {
            "native": bool(self._read_pid(run_dir / "native.pid", "server.js")),
        }
        health = self.health(int(metadata.get("port", 8799))) if any(processes.values()) else {
            "ok": False,
            "checks": {},
        }
        return {**metadata, "processes": processes, "health": health}

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
    for command in ("start", "status"):
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
    if args.command == "install":
        result = runtime.install()
    elif args.command == "start":
        result = runtime.start(args.run_id, args.port, args.native_data_root)
    elif args.command == "stop":
        result = runtime.stop_run(args.run_id)
    elif args.command == "status":
        result = runtime.status(args.run_id)
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
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except NativeLifecycleError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
