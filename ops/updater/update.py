#!/usr/bin/env python3
"""Review/apply/rollback a pinned full release; Python data is migrated on a copy."""
import argparse
from contextlib import contextmanager
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

from bundle import PARTS, digest, download_release, extract_bundle, read_bundle, relative


def module_at(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def safe(path):
    path = Path(os.path.abspath(path))
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("Symlink requires manual review: " + str(path))
    return path


def content(path):
    path = safe(path)
    return path.read_bytes() if path.exists() else None


def sha(path):
    data = content(path)
    return None if data is None else digest(data)


def atomic(path, data, mode=0o600):
    path = safe(path)
    if data is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".tavern-update-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def json_write(path, value):
    atomic(path, (json.dumps(value, sort_keys=True, indent=2) + "\n").encode())


def plan_digest(plan):
    return digest(json.dumps(plan, sort_keys=True, separators=(",", ":")).encode())


class Updater:
    def __init__(self, home, *, lifecycle=None):
        self.home = safe(Path(home).expanduser().absolute())
        explicit_installation = (os.environ.get('HERMES_HOME') == str(self.home)
            and (self.home / 'config.yaml').is_file() and (self.home / 'skills').is_dir()
            and (self.home / 'apps/tavern-runtime').is_dir())
        if str(self.home) == "/" or (self.home == Path.home() and not explicit_installation):
            raise ValueError("Use the exact Hermes installation directory, not a broad home/root")
        self.state = self.home / "tavern-state"
        self.root = self.home / "tavern-updates-v2"
        self.apps = self.home / "apps"
        self.targets = {key: self.apps / value for key, value in PARTS.items()}
        self.lifecycle = lifecycle or NativeLifecycle(self)

    @contextmanager
    def lock(self):
        safe(self.root / "lock")
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / "lock").open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def _target(self, name):
        p = relative(name)
        if p.parts[0] in PARTS:
            return self.targets[p.parts[0]].joinpath(*p.parts[1:])
        if p.parts[0] == "home":
            rel = Path(*p.parts[1:])
            # The only host configuration owned by this updater is an explicit
            # skill file, the merged AGENTS, the Nora MCP entry and engine deps.
            if str(rel) not in ("AGENTS.md", "config.yaml", "tavern-state/native-runtime/dependencies.json") and not (
                str(rel).startswith("skills/") or str(rel).startswith("tavern-state/native/default-user/extensions/")):
                raise ValueError("Invalid managed host path: " + name)
            return self.home / rel
        raise ValueError("Invalid managed path: " + name)

    def _configured_paths(self):
        # Refuse to silently update a different installation when environment
        # overrides are used. Custom layout migration is deliberately separate.
        expected = {"TAVERN_DATA_ROOT": self.home, "TAVERN_APP_DIR": self.targets["app"], "TAVERN_STATE_DIR": self.state}
        for key, path in expected.items():
            if os.environ.get(key) and Path(os.environ[key]).resolve() != path.resolve():
                raise ValueError(f"Custom {key} requires an explicit layout migration")
        marker = self.targets["app"] / "native-runtime.json"
        if not marker.exists() or json.loads(marker.read_text()).get("schema") != 2:
            raise ValueError("This updater adopts existing Node Tavern installations, not legacy Python data")
        self._check_data_layout()

    def _check_data_layout(self):
        # An engine contract is NOT a user-data schema. Mixed installations
        # can contain the new engine marker while their worlds remain Python.
        for namespace in ("productions", "cards", "worldbooks"):
            directory = safe(self.state / namespace)
            if directory.exists() and any(directory.iterdir()):
                raise ValueError("Legacy Python data needs a verified migration before updating: " + namespace)
        native = safe(self.state / "native")
        if not native.exists():
            return
        for user in native.iterdir():
            safe(user)
            if not user.is_dir() or user.name.startswith("_"):
                continue
            legacy = safe(user / "nora-worlds")
            if legacy.exists() and any(legacy.iterdir()):
                raise ValueError("World v1 records require migration/reconciliation before this updater can proceed: " + str(legacy))
            worlds = safe(user / "nora-world-core/worlds")
            if not worlds.exists():
                continue
            for file in worlds.iterdir():
                safe(file)
                try:
                    if not file.is_file() or file.suffix != ".json":
                        raise ValueError("unexpected file type")
                    record = json.loads(file.read_text())
                    if not isinstance(record, dict) or record.get("schema_version") != 2:
                        raise ValueError("unsupported schema")
                except (ValueError, OSError) as error:
                    raise ValueError("World record requires review before updating: " + str(file)) from error

    def _check_space(self, transaction, plan, *, preparing):
        changed = [c for c in plan["changes"] if c["before"] != c["after"]]
        backup_bytes = sum(self._target(c["name"]).stat().st_size for c in changed if c["before"] is not None)
        replacement_bytes = sum((transaction / c["source"]).stat().st_size for c in changed if c["source"])
        # npm's expanded size is not present in the release manifest. This is
        # a conservative preparation reserve, not a claimed exact prediction.
        reserve = 1024 ** 3 if preparing else 64 * 1024 ** 2
        required = backup_bytes + replacement_bytes + reserve
        locations = {self.root, self.apps, self.home, self.state}
        for location in locations:
            safe(location)
            while not location.exists():
                location = location.parent
            if shutil.disk_usage(location).free < required:
                raise ValueError(f"Insufficient disk space at {location}: need at least {required} bytes; no files switched")

    def _mcp_config(self):
        import yaml  # Hermes' Python environment already owns this dependency.
        path = self.home / "config.yaml"
        raw = content(path) or b""
        value = yaml.safe_load(raw) or {}
        servers = value.setdefault("mcp_servers", {})
        old = servers.get("nora", {})
        current = json.loads(json.dumps(old))
        current["command"] = shutil.which("node") or "node"
        current["args"] = [str(self.targets["nora-mcp"] / "dist/server.js")]
        env = current.setdefault("env", {})
        env.setdefault("NORA_MCP_MODE", "read-only")
        if env["NORA_MCP_MODE"] not in ("read-only", "operator"):
            raise ValueError("Unknown MCP permission mode")
        paths = {"PROJECT_ROOT": self.targets["app"], "ST_ROOT": self.targets["app"] / "engine/sillytavern",
                 "STATE_ROOT": self.state, "NATIVE_DATA_ROOT": self.state / "native",
                 "USER_DATA_ROOT": self.state / "native/default-user", "CONFIG_PATH": self.state / "native-runtime/config.yaml",
                 "UPLOAD_ROOT": self.state / "imports"}
        for key, path in paths.items():
            name = "NORA_MCP_" + key
            if env.get(name) and Path(env[name]).resolve() != path.resolve():
                raise ValueError("Different MCP instance configured: " + name)
            env[name] = str(path)
        base_url = f"http://127.0.0.1:{getattr(self, 'isolated_port', 8799)}"
        env.setdefault("NORA_MCP_BASE_URL", base_url)
        if env["NORA_MCP_BASE_URL"] != base_url:
            raise ValueError("Non-default instance URL requires explicit layout migration")
        current.setdefault("timeout", 420)
        servers["nora"] = current
        # Keep comments/formatting byte-exact when there is no semantic change.
        return raw if current == old else yaml.safe_dump(value, allow_unicode=True, sort_keys=False).encode()

    def review(self, directory, expected, *, candidate=False):
        self._configured_paths()
        manifest = read_bundle(directory, expected, candidate=candidate)
        safe(self.root / "probe")
        self.root.mkdir(parents=True, exist_ok=True)
        transaction = Path(tempfile.mkdtemp(prefix="review-", dir=self.root))
        transaction.chmod(0o700)
        stage = transaction / "source"
        extract_bundle(directory, stage, manifest)
        desired = {name: stage / name for name in manifest["artifacts"]}
        installer = module_at("release_skill_installer", stage / "ops/scripts/install-hermes-skills.py")
        generated = transaction / "generated"
        generated.mkdir()

        def generated_file(name, data):
            file = generated / str(len(desired))
            file.write_bytes(data)
            file.chmod(0o600)
            desired[name] = file

        for change in installer.build_plan(stage / "ops/skills", self.home, full_release=True, include_unchanged=True):
            name = "home/" + str(Path(change["path"]).relative_to(self.home))
            if change["new"] is None:
                desired[name] = None
            else:
                generated_file(name, change["new"])
        # Include unchanged installed skills too: they are part of the next
        # baseline and may be intentionally retired in a later release.
        for rel in installer.SKILLS:
            for source in (stage / "ops/skills" / rel).rglob("*"):
                parts = source.relative_to(stage / "ops/skills").parts
                if source.is_file() and not any(p.startswith(".") or p in ("tests", "agents", "__pycache__", "node_modules") for p in parts):
                    desired["home/skills/" + "/".join(parts)] = source
        for name in ("runtime.sh", "provision.sh", "bringup-native.sh", "analyze-boot-metrics.mjs", "analyze-runtime-phases.mjs", "profile_memory.py"):
            desired["home/skills/creative/tavern/scripts/" + name] = stage / "ops/scripts" / name
        for name in manifest["artifacts"]:
            if name.startswith("ops/hooks/tavern-liveware-register/") or name == "ops/eslint-owned.cjs":
                desired["home/skills/creative/tavern/" + name[len("ops/"):]] = stage / name
        # Copy only shipped extension files. Extra user files remain untouched;
        # future removals use the installed managed-file baseline below.
        for name in manifest["artifacts"]:
            prefix = "app/native-extensions/"
            if name.startswith(prefix):
                desired["home/tavern-state/native/default-user/extensions/" + name[len(prefix):]] = stage / name
        generated_file("home/config.yaml", self._mcp_config())
        baseline = self.root / "installed.json"
        previous = json.loads(baseline.read_text()) if baseline.exists() else {"files": {}}
        for name, old_sha in previous["files"].items():
            if name not in desired:
                if name in ("home/AGENTS.md", "home/config.yaml"):
                    raise ValueError("Host configuration is missing from the desired inventory; refusing deletion: " + name)
                if sha(self._target(name)) not in (None, old_sha):
                    raise ValueError("Locally modified retired managed file; preserve and review: " + name)
                desired[name] = None
        changes, inventory = [], {}
        for name, source in sorted(desired.items()):
            target = safe(self._target(name))
            new = sha(source) if source else None
            before = sha(target)
            if new is not None:
                inventory[name] = new
            # Preserve modes on existing host files, enforce archive modes on code.
            mode = target.stat().st_mode & 0o777 if target.exists() else (source.stat().st_mode & 0o777 if source else 0o644)
            if name == "home/config.yaml":
                mode = 0o600
            changes.append({"name": name, "before": before, "after": new, "mode": mode,
                            "source": str(source.relative_to(transaction)) if source else None})
        plan = {"schema": 2, "home": str(self.home), "manifestSha256": expected, "commit": manifest["commit"],
                "sourceDigest": manifest["sourceDigest"], "candidate": manifest["candidate"],
                "versions": manifest["versions"], "changes": changes, "files": inventory,
                "previousBaseline": sha(baseline)}
        json_write(transaction / "plan.json", plan)
        return {"status": "reviewed", "transaction": str(transaction), "planDigest": plan_digest(plan),
                "versions": plan["versions"], "changedFiles": sum(c["before"] != c["after"] for c in changes),
                "candidate": plan["candidate"], "preserves": ["worlds", "chats", "model keys", "unrelated skills", "AGENTS outside managed block"],
                "activation": "Tavern restart, then Hermes /reload-mcp and fresh session for skill/AGENTS context"}

    def _load_plan(self, transaction, expected):
        transaction = safe(Path(transaction).absolute())
        if transaction.parent != self.root or not transaction.name.startswith("review-"):
            raise ValueError("Transaction belongs to another installation")
        plan = json.loads((transaction / "plan.json").read_text())
        if plan_digest(plan) != expected or plan["home"] != str(self.home):
            raise ValueError("Plan changed or belongs to another installation")
        if (plan.get('isolatedClean') or plan.get('cleanTransaction')) and type(self) is Updater:
            raise ValueError('Use the clean updater for this transaction; legacy file apply is not permitted')
        for change in plan["changes"]:
            self._target(change["name"])
            if change["source"]:
                relative(change["source"])
        return transaction, plan

    def _preconditions(self, transaction, plan):
        # Block application, not recovery: an affected old transaction must
        # still be able to restore its backed-up AGENTS through rollback.
        protected = {"home/AGENTS.md", "home/config.yaml"}
        if not protected.issubset(plan["files"]) or any(
            c["name"] in protected and c["after"] is None for c in plan["changes"]
        ):
            raise ValueError("Unsafe legacy plan could delete host configuration; review the release again")
        self._configured_paths()
        if sha(self.root / "installed.json") != plan["previousBaseline"]:
            raise ValueError("Installed release changed; review again")
        for change in plan["changes"]:
            if sha(self._target(change["name"])) != change["before"]:
                raise ValueError("Target changed since review: " + change["name"])
            if change["source"] and sha(transaction / change["source"]) != change["after"]:
                raise ValueError("Staged source changed: " + change["name"])

    def apply(self, transaction, expected):
        with self.lock():
            for file in self.root.glob("review-*/receipt.json"):
                status = json.loads(file.read_text()).get("status")
                if status not in ("rolled-back", "installed-awaiting-hermes-reload"):
                    raise ValueError("Unfinished update requires recovery first: " + str(file.parent))
            transaction, plan = self._load_plan(transaction, expected)
            if (transaction / "receipt.json").exists():
                raise ValueError("Transaction already attempted; inspect receipt/recovery")
            self._preconditions(transaction, plan)
            self._check_space(transaction, plan, preparing=True)
            # Download/install dependencies before interrupting the live process.
            self.lifecycle.prepare(transaction)
            self._preconditions(transaction, plan)
            self._check_space(transaction, plan, preparing=False)
            backup = transaction / "backup"
            backup.mkdir()
            actual = [c for c in plan["changes"] if c["before"] != c["after"]]
            for i, change in enumerate(actual):
                old = content(self._target(change["name"]))
                if old is not None:
                    atomic(backup / str(i), old, change["mode"])
            old_baseline = content(self.root / "installed.json")
            if old_baseline is not None:
                atomic(backup / "baseline.json", old_baseline)
            receipt = {"status": "applying", "planDigest": expected, "applied": [], "actual": actual,
                       "versions": plan["versions"], "commit": plan["commit"], "startedAt": int(time.time())}
            json_write(transaction / "receipt.json", receipt)
            try:
                self.lifecycle.stop()
                for i, change in enumerate(actual):
                    target = self._target(change["name"])
                    if sha(target) != change["before"]:
                        raise ValueError("Concurrent file change: " + change["name"])
                    # Journal intent before replacement; recovery handles both
                    # before and after values if interrupted between these writes.
                    receipt["applied"].append(i)
                    json_write(transaction / "receipt.json", receipt)
                    data = content(transaction / change["source"]) if change["source"] else None
                    atomic(target, data, change["mode"])
                self.lifecycle.activate(transaction)
                for name, value in plan["files"].items():
                    if sha(self._target(name)) != value:
                        raise ValueError("Installed content differs: " + name)
                verification = self.lifecycle.verify(transaction)
                json_write(self.root / "installed.json", {"manifestSha256": plan["manifestSha256"], "commit": plan["commit"],
                           "transaction": transaction.name, "sourceDigest": plan["sourceDigest"], "versions": plan["versions"], "files": plan["files"]})
                receipt.update(status="installed-awaiting-hermes-reload", verification=verification,
                               hermesReloadRequired=True, freshSessionRequired=True)
                json_write(transaction / "receipt.json", receipt)
                return {k: v for k, v in receipt.items() if k not in ("actual", "applied")}
            except BaseException as error:
                receipt["error"] = str(error)
                json_write(transaction / "receipt.json", receipt)
                self._restore(transaction, receipt)
                raise

    def _restore(self, transaction, receipt):
        # Preflight the whole recovery so a hotfix cannot cause a partial restore.
        for i in reversed(receipt["applied"]):
            change = receipt["actual"][i]
            target = self._target(change["name"])
            if sha(target) not in (change["after"], change["before"]):
                receipt["status"] = "recovery-blocked-concurrent-change"
                json_write(transaction / "receipt.json", receipt)
                raise ValueError("Recovery preserved a concurrent modification: " + change["name"])
            old = content(transaction / "backup" / str(i)) if change["before"] is not None else None
            if (digest(old) if old is not None else None) != change["before"]:
                raise ValueError("Recovery backup checksum mismatch")
        self.lifecycle.stop()
        for i in reversed(receipt["applied"]):
            change = receipt["actual"][i]
            target = self._target(change["name"])
            old = content(transaction / "backup" / str(i)) if change["before"] is not None else None
            atomic(target, old, change["mode"])
        self.lifecycle.restore(transaction)
        atomic(self.root / "installed.json", content(transaction / "backup/baseline.json"))
        receipt.update(status="rolled-back", hermesReloadRequired=True, freshSessionRequired=True)
        json_write(transaction / "receipt.json", receipt)
        return receipt

    def rollback(self, transaction, expected):
        with self.lock():
            transaction, plan = self._load_plan(transaction, expected)
            receipt = json.loads((transaction / "receipt.json").read_text())
            if receipt["status"] == "rolled-back":
                return receipt
            baseline = self.root / "installed.json"
            if baseline.exists() and receipt["status"] == "installed-awaiting-hermes-reload":
                if json.loads(baseline.read_text()).get("transaction") != transaction.name:
                    raise ValueError("A newer transaction is installed; refusing stale rollback")
            if baseline.exists() and json.loads(baseline.read_text()).get("manifestSha256") not in (plan["manifestSha256"], None):
                if sha(baseline) != plan["previousBaseline"]:
                    raise ValueError("A different release was installed; refusing stale rollback")
            return self._restore(transaction, receipt)


class NativeLifecycle:
    """Activation uses existing Node lifecycle, not Liveware re-registration."""
    def __init__(self, updater, *, port=8799):
        self.u = updater
        self.port = port

    def runtime(self):
        app = self.u.targets["app"]
        module = module_at("updater_native_runtime", getattr(self, "module_path", app / "native_lifecycle.py"))
        contract = module.RuntimeContract.from_dict(json.loads((app / "native-runtime.json").read_text()))
        return module.NativeRuntime(self.u.home, app, self.u.state, contract)

    def prepare(self, transaction):
        self.module_path = transaction / "source/app/native_lifecycle.py"
        for part, relative_dir in (("app", "engine/sillytavern"), ("nora-mcp", ".")):
            directory = transaction / "source" / part / relative_dir
            subprocess.run(["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=directory, check=True)
        # Resolve config support and dependency versions before stopping Tavern.
        if self.runtime().node_major() < 20:
            raise ValueError("Node.js 20+ required")
        if not (self.u.state / "native-runtime/config.yaml").is_file():
            raise ValueError("Existing Node installation config is required")

    def stop(self):
        self.runtime().stop_run("production")

    def activate(self, transaction):
        journal = []
        for part, rel in (("app", "engine/sillytavern"), ("nora-mcp", ".")):
            target = self.u.targets[part] / rel / "node_modules"
            old = transaction / "backup" / (part + "-node_modules")
            source = transaction / "source" / part / rel / "node_modules"
            safe(target)
            journal.append({"target": str(target), "backup": str(old), "source": str(source), "hadOld": target.exists()})
            json_write(transaction / "dependencies.json", journal)
            if target.exists():
                os.replace(target, old)
            os.replace(source, target)
        runtime = self.runtime()
        atomic(transaction / "backup/dependency-marker", content(runtime.dependencies_marker))
        json_write(runtime.dependencies_marker, {"schema": 1, "node_major": runtime.node_major(), "lock_sha256": runtime.lock_digest()})
        runtime.start(port=self.port, assets_prepared=True)

    def verify(self, transaction):
        runtime = self.runtime()
        status = runtime.status()
        if not status["processes"]["native"] or not status["health"]["ok"]:
            raise ValueError("New Tavern process health failed")
        for route in ("/", "/_liveware/story-profile/"):
            import urllib.request
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}" + route, timeout=10) as response:
                if response.status != 200:
                    raise ValueError("Application route not ready: " + route)
        # Probe a NEW stdio process. This is deliberately not represented as a
        # reload of the gateway's already-running MCP process.
        env = {**os.environ, "NORA_MCP_STATE_ROOT": str(self.u.state), "NORA_MCP_MODE": "read-only"}
        probe = self.u.targets["ops"] / "updater/probe-mcp.mjs"
        result = subprocess.run(["node", str(probe), str(self.u.targets["nora-mcp"])], env=env,
                                check=True, capture_output=True, text=True, timeout=40)
        mcp = json.loads(result.stdout)
        planned = json.loads((transaction / "plan.json").read_text())["versions"]
        if mcp["server"]["version"] != planned["mcp"]:
            raise ValueError("Running MCP probe version does not match the release")
        return {"nativePid": status["native_pid"], "tavernHealth": True, "storyProfileRoute": True,
                "newMcpProcess": mcp, "gatewayMcpReloaded": False}

    def restore(self, transaction):
        # The reviewed lifecycle can boot either schema-2 source snapshot; do
        # not run an older start() that rewrites operator config on rollback.
        self.module_path = transaction / "source/app/native_lifecycle.py"
        journal = transaction / "dependencies.json"
        if journal.exists():
            for entry in reversed(json.loads(journal.read_text())):
                target, old, source = (Path(entry[k]) for k in ("target", "backup", "source"))
                # If the source still exists the dependency switch never finished.
                if not source.exists() and target.exists():
                    os.replace(target, source)
                if old.exists():
                    os.replace(old, target)
        marker = transaction / "backup/dependency-marker"
        if marker.exists():
            atomic(self.runtime().dependencies_marker, marker.read_bytes())
        self.runtime().start(port=self.port, assets_prepared=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-home", type=Path, default=os.environ.get("HERMES_HOME", "/opt/data"))
    parser.add_argument("--isolated-test-port", type=int, help="Run the same update transaction on a marked temporary copy with a separate port")
    sub = parser.add_subparsers(dest="command", required=True)
    fetch = sub.add_parser("fetch")
    fetch.add_argument("--tag", required=True)
    fetch.add_argument("--destination", type=Path, required=True)
    review = sub.add_parser("review")
    review.add_argument("--release-dir", type=Path, required=True)
    review.add_argument("--manifest-sha256", required=True)
    review.add_argument("--allow-candidate", action="store_true")
    for name in ("apply", "rollback"):
        child = sub.add_parser(name)
        child.add_argument("--transaction", type=Path)
        child.add_argument("--expected-plan")
        child.add_argument("--plan", help=argparse.SUPPRESS)
        child.add_argument("--confirm", action="store_true", required=True)
    args = parser.parse_args()
    if args.command in ('apply', 'rollback'):
        home = safe(Path(args.hermes_home).absolute())
        if args.plan:
            if args.transaction or args.expected_plan:
                raise ValueError('Use either the legacy reviewed plan ID or the explicit transaction/digest pair')
            reviewed = json.loads((home / 'tavern-updates-v2/bootstrap-review.json').read_text())
            if args.plan != Path(reviewed['transaction']).name:
                raise ValueError('Legacy plan ID differs from the pinned Bootstrap review')
            args.transaction, args.expected_plan = Path(reviewed['transaction']), reviewed['planDigest']
            args.isolated_test_port = reviewed.get('testPort')
        elif args.command == 'rollback' and not args.transaction and not args.expected_plan:
            installed = json.loads((home / 'tavern-updates-v2/installed.json').read_text())
            args.transaction = home / 'tavern-updates-v2' / installed['transaction']
            args.expected_plan = installed.get('planDigest')
            if args.isolated_test_port is None:
                args.isolated_test_port = installed.get('testPort')
        if not args.transaction or not args.expected_plan:
            raise ValueError('An explicitly reviewed transaction and pinned plan digest are required')
    if args.command == "fetch":
        result = download_release(args.tag, args.destination)
    else:
        from clean_update import CleanUpdater
        updater = CleanUpdater(args.hermes_home, port=args.isolated_test_port)
        if args.command == 'rollback':
            # Old file-level receipts still need their original recovery path.
            # New installs never use that writer, only the whole-tree transaction.
            transaction, plan = updater._load_plan(args.transaction, args.expected_plan)
            if not plan.get('cleanTransaction'):
                if plan.get('isolatedClean'):
                    raise ValueError('Recover this experimental receipt with its original updater version')
                updater = Updater(args.hermes_home)
        if args.command == "review":
            result = updater.review(args.release_dir, args.manifest_sha256, candidate=args.allow_candidate)
        else:
            result = getattr(updater, args.command)(args.transaction, args.expected_plan)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
