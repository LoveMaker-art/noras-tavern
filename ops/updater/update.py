#!/usr/bin/env python3
"""Direct Tavern updater: backup, replace, start."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

UPDATE_CHECK_JOB_NAME = "Nora Tavern daily update check (09:00 Asia/Shanghai)"
UPDATE_CHECK_SCRIPT = "nora-tavern-update-check.sh"
UPDATE_CHECK_SCHEDULE = "0 9 * * *"
UPDATE_CHECK_FILES = (UPDATE_CHECK_SCRIPT, "nora-tavern-card-send.py")
HOST_HOOK = Path("hooks/tavern-liveware-register")


def log(message):
    print("[tavern-updater] " + message, file=sys.stderr, flush=True)


def safe(path):
    value = Path(path).expanduser().absolute()
    if value == Path("/"):
        raise RuntimeError("拒绝使用根目录")
    return value


def atomic(path, data, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def json_write(path, value):
    atomic(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())


def module_at(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        if sys.modules.get(name) is module:
            del sys.modules[name]
        raise
    return module


def remove(path):
    path = Path(path)
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def port_open(port=8799):
    with socket.socket() as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


@contextmanager
def installer_lock(home):
    path = Path(home) / "tavern-installer.lock"
    with path.open("a+") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def python_layout(app):
    app = Path(app)
    if (app / "native-runtime.json").is_file():
        return None
    for entry, web in (
        ("backend/server.py", "frontend"),
        ("server.py", "web"),
    ):
        if (app / entry).is_file():
            if entry == "backend/server.py" and not (app / web).is_dir():
                web = "backend/web"
            return {"entry": entry, "web": web}
    return None


def path_is_within(path, root):
    return path == root or root in path.parents


def runtime_process_belongs_to_app(app, cwd, argv):
    app = Path(app).resolve()
    cwd = Path(cwd).resolve()
    for value in argv:
        if not value.endswith(("server.py", "server.js")):
            continue
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = cwd / candidate
        if path_is_within(candidate.resolve(), app):
            return True
    return False


def process_rows(app):
    app = Path(app).resolve()
    rows = []
    if not Path("/proc").is_dir():
        return rows
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cwd = Path(entry / "cwd").resolve()
            argv = [os.fsdecode(value) for value in (entry / "cmdline").read_bytes().split(b"\0") if value]
        except OSError:
            continue
        if not runtime_process_belongs_to_app(app, cwd, argv):
            continue
        rows.append(int(entry.name))
    return rows


def stop_unmanaged(app):
    pids = process_rows(app)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 8
    # A terminated child can remain as a zombie in /proc until its parent
    # reaps it.  A zombie no longer owns the Tavern listener and must not keep
    # the update in maintenance for the full timeout.
    while time.monotonic() < deadline and any(pid in process_rows(app) for pid in pids):
        time.sleep(0.1)
    remaining = set(process_rows(app))
    for pid in pids:
        if pid in remaining:
            os.kill(pid, signal.SIGKILL)
    return pids


def run(command, *, cwd=None, env=None, timeout=None, capture=False):
    return subprocess.run(
        [str(value) for value in command],
        cwd=cwd,
        env=env,
        timeout=timeout,
        check=True,
        text=True,
        capture_output=capture,
    )


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def same_file(left, right):
    try:
        return Path(left).is_file() and Path(right).is_file() and file_sha(left) == file_sha(right)
    except OSError:
        return False


def link_or_copy(source, target):
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)
    return target


def reuse_or_install_dependencies(target, current, lock_name, command, required):
    target = Path(target)
    current = Path(current)
    modules = target / "node_modules"
    reusable = same_file(target / lock_name, current / lock_name) and all(
        (current / "node_modules" / relative).is_file() for relative in required
    )
    if reusable:
        shutil.copytree(current / "node_modules", modules, symlinks=True, copy_function=link_or_copy)
        return "reused"
    run(command, cwd=target)
    return "installed"


def prepare_dependencies(source, old_app, old_mcp, *, app_changed, mcp_changed):
    report = {"tavern": "unchanged", "mcp": "unchanged"}
    if app_changed:
        log("准备 Tavern 依赖")
        engine = source / "app/engine/sillytavern"
        report["tavern"] = reuse_or_install_dependencies(
            engine,
            Path(old_app) / "engine/sillytavern",
            "package-lock.json",
            ["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
            ("express/package.json", "webpack/package.json"),
        )
    if mcp_changed:
        log("准备 Nora MCP 依赖")
        report["mcp"] = reuse_or_install_dependencies(
            source / "nora-mcp",
            old_mcp,
            "npm-shrinkwrap.json",
            ["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
            ("@modelcontextprotocol/sdk/package.json", "zod/package.json"),
        )
    return report


def prepare_skills(source, destination):
    installer = module_at("simple_skill_installer", source / "ops/scripts/install-hermes-skills.py")
    return installer.prepare_skill_trees(source, destination)


def prepare_host_hook_swap(home, source, prepared_root):
    origin = Path(source) / "ops" / HOST_HOOK
    required = ("HOOK.yaml", "handler.py", "run.sh")
    missing = [name for name in required if not (origin / name).is_file()]
    if missing:
        raise RuntimeError("发布包缺少 Tavern 启动钩子：" + ", ".join(missing))
    target = Path(home) / HOST_HOOK
    if trees_equal(origin, target):
        return None
    prepared_root = Path(prepared_root)
    prepared_root.mkdir(parents=True, exist_ok=True)
    prepared = prepared_root / HOST_HOOK.name
    shutil.copytree(origin, prepared, symlinks=False)
    return "host-hook-tavern-liveware-register", prepared, target


def hermes_model(home, source):
    try:
        model = module_at("release_native_model", source / "app/native_model_config.py")
        return model.load_model_config(home / "config.yaml")
    except Exception:
        return None


def legacy_model(home):
    try:
        from python_model import load_python_model
        return load_python_model(home)
    except Exception:
        return None


def migration_copy(home, source, work, layout):
    old_state = home / "tavern-state"
    prepared = work / "prepared/state"
    if old_state.is_dir():
        shutil.copytree(old_state, prepared, symlinks=False)
    else:
        prepared.mkdir(parents=True)
    options = {
        "hermesModel": hermes_model(home, source),
        "legacyModel": legacy_model(home),
        "legacyApp": str(home / "apps/tavern-runtime"),
        "legacyWeb": layout["web"],
    }
    options_path = work / "model-input.json"
    json_write(options_path, options)
    result = run(
        ["node", source / "ops/updater/prepare-state.mjs", prepared, source / "app", options_path],
        timeout=300,
        capture=True,
    )
    return prepared, json.loads(result.stdout)


def fallback_python_state(home, work, reason):
    old = home / "tavern-state"
    prepared = work / "prepared-fallback/state"
    if old.is_dir():
        # An unsupported legacy record must not turn into lost configuration.
        # Keep the complete state tree so Liveware identities, model settings,
        # Story Profile data and the original import material remain usable or
        # recoverable.  The native runtime can create its own missing layout.
        shutil.copytree(old, prepared, symlinks=False)
    else:
        prepared.mkdir(parents=True)
    report = {
        "status": "archived",
        "reason": reason,
        "importedWorlds": 0,
        "note": "原 Python 数据完整保存在更新备份中，可后续手动导入",
    }
    return prepared, report


def render_mcp(home):
    try:
        import yaml
    except ImportError as error:
        raise RuntimeError("Hermes Python 缺少 PyYAML，无法写入 MCP 配置") from error
    path = home / "config.yaml"
    value = yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else {}
    value = value or {}
    servers = value.setdefault("mcp_servers", {})
    current = servers.get("nora") if isinstance(servers.get("nora"), dict) else {}
    env = current.get("env") if isinstance(current.get("env"), dict) else {}
    env.update({
        "NORA_MCP_PROJECT_ROOT": str(home / "apps/tavern-runtime"),
        "NORA_MCP_ST_ROOT": str(home / "apps/tavern-runtime/engine/sillytavern"),
        "NORA_MCP_STATE_ROOT": str(home / "tavern-state"),
        "NORA_MCP_NATIVE_DATA_ROOT": str(home / "tavern-state/native"),
        "NORA_MCP_USER_DATA_ROOT": str(home / "tavern-state/native/default-user"),
        "NORA_MCP_CONFIG_PATH": str(home / "tavern-state/native-runtime/config.yaml"),
        "NORA_MCP_UPLOAD_ROOT": str(home / "tavern-state/imports"),
        "NORA_MCP_BASE_URL": "http://127.0.0.1:8799",
        "NORA_MCP_MODE": "operator",
    })
    servers["nora"] = {
        **current,
        "command": shutil.which("node") or "node",
        "args": [str(home / "apps/nora-mcp/dist/server.js")],
        "env": env,
        "timeout": current.get("timeout", 420),
    }
    return yaml.safe_dump(value, allow_unicode=True, sort_keys=False).encode()


def merged_agents(home, managed):
    path = home / "AGENTS.md"
    current = path.read_text(encoding="utf-8") if path.is_file() else ""
    block = managed.decode("utf-8").strip()
    begin, end = "<!-- BEGIN TAVERN SKILLS -->", "<!-- END TAVERN SKILLS -->"
    first, last = current.find(begin), current.rfind(end)
    if first >= 0 and last >= first:
        prefix = current[:first].rstrip()
        suffix = current[last + len(end):].strip()
    else:
        prefix = current.replace(begin, "").replace(end, "").rstrip()
        suffix = ""
    sections = [value for value in (prefix, block, suffix) if value]
    return ("\n\n".join(sections) + "\n").encode("utf-8")


def tree_inventory(root):
    root = Path(root)
    if not root.is_dir():
        return None
    inventory = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        inventory[relative] = file_sha(path)
    return inventory


def trees_equal(left, right):
    return tree_inventory(left) == tree_inventory(right)


def changed_roots(manifest, changed_modules):
    modules = manifest.get("modules") or {}
    if not modules:
        return {"app", "ops", "nora-mcp"}
    roots = set()
    for module in changed_modules:
        for artifact in modules[module]["artifacts"]:
            roots.add(artifact.split("/", 1)[0])
    return roots


def dependency_marker(app_root):
    """Describe dependencies for an installed Tavern application tree.

    Release staging keeps the application below ``source/app`` while the
    installed tree itself is ``apps/tavern-runtime``.  Keeping this function
    explicitly on the installed-tree contract prevents callers from applying
    the staging prefix twice during a legacy-to-native upgrade.
    """
    result = run(["node", "--version"], capture=True)
    value = result.stdout.strip()
    if not value.startswith("v") or not value[1:].split(".", 1)[0].isdigit():
        raise RuntimeError("无法识别 Node.js 版本：" + value)
    return {
        "schema": 1,
        "lock_sha256": file_sha(Path(app_root) / "engine/sillytavern/package-lock.json"),
        "node_major": int(value[1:].split(".", 1)[0]),
        "prepared_at": int(time.time()),
    }


def roots_with_unmanaged_files(home, manifest):
    expected = set(manifest.get("artifacts") or {})
    roots = {
        "app": Path(home) / "apps/tavern-runtime",
        "ops": Path(home) / "apps/tavern-ops",
        "nora-mcp": Path(home) / "apps/nora-mcp",
    }
    changed = set()
    for name, root in roots.items():
        if not root.is_dir():
            changed.add(name)
            continue
        for directory, directories, files in os.walk(root):
            directories[:] = [entry for entry in directories if entry != "node_modules"]
            base = Path(directory)
            for filename in files:
                path = base / filename
                if path.is_symlink():
                    changed.add(name)
                    break
                relative = f"{name}/{path.relative_to(root).as_posix()}"
                if relative not in expected:
                    changed.add(name)
                    break
            if name in changed:
                break
    return changed


def copy_host_backup(home, backup, service_snapshot):
    host = backup / "host"
    host.mkdir(parents=True)
    for name in ("AGENTS.md", "config.yaml"):
        source = home / name
        if source.is_file():
            shutil.copy2(source, host / name)
    marker = home / "tavern-state/native-runtime/dependencies.json"
    if marker.is_file():
        (host / "native-runtime").mkdir()
        shutil.copy2(marker, host / "native-runtime/dependencies.json")
    if service_snapshot:
        json_write(host / "service.json", service_snapshot)


def restore_host(home, backup):
    host = backup / "host"
    for name in ("AGENTS.md", "config.yaml"):
        saved = host / name
        target = home / name
        if saved.is_file():
            shutil.copy2(saved, target)
        else:
            target.unlink(missing_ok=True)
    marker = home / "tavern-state/native-runtime/dependencies.json"
    saved_marker = host / "native-runtime/dependencies.json"
    if saved_marker.is_file():
        marker.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(saved_marker, marker)
    else:
        marker.unlink(missing_ok=True)


def swap_tree(source, target, backup_target):
    target.parent.mkdir(parents=True, exist_ok=True)
    backup_target.parent.mkdir(parents=True, exist_ok=True)
    had_target = target.exists()
    if had_target:
        os.replace(target, backup_target)
    try:
        os.replace(source, target)
    except BaseException:
        if had_target and backup_target.exists() and not target.exists():
            os.replace(backup_target, target)
        raise


def restore_tree(target, backup_target, failed):
    if target.exists():
        failed.parent.mkdir(parents=True, exist_ok=True)
        if failed.exists():
            remove(failed)
        os.replace(target, failed)
    if backup_target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(backup_target, target)


def start_old(home, service, snapshot):
    app = home / "apps/tavern-runtime"
    if (app / "native_lifecycle.py").is_file():
        environment = {**os.environ, "HERMES_HOME": str(home), "TAVERN_DATA_ROOT": str(home)}
        run([sys.executable, "-B", app / "native_lifecycle.py", "install"], env=environment)
        if service and snapshot:
            service.restore(snapshot)
            service.start()
        else:
            run([sys.executable, "-B", app / "native_lifecycle.py", "start"], env=environment)
        return
    if service and snapshot:
        service.restore(snapshot)
        service.start()
        return
    layout = python_layout(app)
    if layout:
        log_file = home / "tavern-state/runtime/python-recovery.log"
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("ab", buffering=0) as output:
            subprocess.Popen(
                [sys.executable, str(app / layout["entry"]), "--port", "8799"],
                cwd=app,
                env={**os.environ, "HERMES_HOME": str(home)},
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )


@contextmanager
def temporary_content_check_skip(config_path, enabled):
    """Skip ST's content scan only for a restart whose engine did not change."""
    config_path = Path(config_path)
    if not enabled:
        yield
        return
    original = config_path.read_bytes()
    text = original.decode("utf-8")
    patched, count = re.subn(
        r"(?m)^skipContentCheck:\s*(?:false|true)\s*$",
        "skipContentCheck: true",
        text,
        count=1,
    )
    if count != 1:
        raise RuntimeError("无法定位 SillyTavern 内容检查配置")
    changed = patched.encode("utf-8") != original
    if changed:
        atomic(config_path, patched.encode("utf-8"), mode=config_path.stat().st_mode & 0o777)
    try:
        yield
    finally:
        if changed:
            atomic(config_path, original, mode=config_path.stat().st_mode & 0o777)


def install_runtime(home, *, skip_content_check=False):
    app = home / "apps/tavern-runtime"
    module = module_at("installed_native_lifecycle", app / "native_lifecycle.py")
    contract = module.RuntimeContract.from_dict(json.loads((app / "native-runtime.json").read_text(encoding="utf-8")))
    runtime = module.NativeRuntime(home, app, home / "tavern-state", contract)
    runtime.install()
    service = runtime.managed_service()
    if service:
        text = service.node_text(runtime.node_command(8799, runtime.native_data_root), runtime.engine_root)
        service.install_text(text, accepted_hash=None, mode=service.file.stat().st_mode & 0o777)
    with temporary_content_check_skip(runtime.config_path, skip_content_check):
        return runtime.start(port=8799)


def refresh_liveware(home, source):
    try:
        source = Path(source)
        path = source / "updater/liveware_integration.py"
        if not path.is_file():
            path = source / "ops/updater/liveware_integration.py"
        integration = module_at("simple_liveware", path)
        return integration.repair(home)
    except Exception as error:
        return {"status": "pending", "warnings": [str(error)]}


def read_cron_jobs(home):
    path = Path(home) / "cron/jobs.json"
    if not path.is_file():
        return []
    value = json.loads(path.read_text(encoding="utf-8"))
    jobs = value.get("jobs", []) if isinstance(value, dict) else []
    if not isinstance(jobs, list):
        raise RuntimeError("Hermes cron jobs.json 格式无效")
    return [job for job in jobs if isinstance(job, dict)]


def hermes_command():
    candidates = (
        Path(sys.executable).with_name("hermes"),
        Path("/opt/hermes/.venv/bin/hermes"),
    )
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which("hermes")
    if found:
        return Path(found)
    raise RuntimeError("未找到 Hermes CLI，无法安装更新提醒任务")


def update_check_jobs(home):
    return [
        job for job in read_cron_jobs(home)
        if job.get("name") == UPDATE_CHECK_JOB_NAME or job.get("script") == UPDATE_CHECK_SCRIPT
    ]


def configure_update_check_job(home):
    cli = hermes_command()
    environment = {**os.environ, "HERMES_HOME": str(home)}
    existing = update_check_jobs(home)
    if existing:
        primary = existing[0]
        run([
            cli, "cron", "edit", primary["id"],
            "--schedule", UPDATE_CHECK_SCHEDULE,
            "--prompt", "",
            "--name", UPDATE_CHECK_JOB_NAME,
            "--deliver", "local",
            "--clear-skills",
            "--script", UPDATE_CHECK_SCRIPT,
            "--no-agent",
        ], env=environment, capture=True)
        for duplicate in existing[1:]:
            run([cli, "cron", "remove", duplicate["id"]], env=environment, capture=True)
    else:
        run([
            cli, "cron", "create", UPDATE_CHECK_SCHEDULE,
            "--name", UPDATE_CHECK_JOB_NAME,
            "--deliver", "local",
            "--script", UPDATE_CHECK_SCRIPT,
            "--no-agent",
        ], env=environment, capture=True)

    configured = update_check_jobs(home)
    if len(configured) != 1:
        raise RuntimeError(f"更新提醒任务数量异常：{len(configured)}")
    job = configured[0]
    schedule = job.get("schedule", {})
    if (schedule.get("expr") != UPDATE_CHECK_SCHEDULE
            or job.get("script") != UPDATE_CHECK_SCRIPT
            or job.get("no_agent") is not True
            or job.get("deliver") != "local"):
        raise RuntimeError("更新提醒任务配置未生效")
    return job


def install_update_check(home, ops_root):
    """Install the daily checker from an installed or staged operations root."""
    scripts = Path(home) / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    for name in UPDATE_CHECK_FILES:
        origin = Path(ops_root) / "scripts" / name
        if not origin.is_file():
            raise RuntimeError("发布包缺少更新提醒脚本：" + name)
        atomic(scripts / name, origin.read_bytes(), mode=0o755)
    job = configure_update_check_job(home)
    return {
        "status": "installed",
        "jobId": job["id"],
        "schedule": UPDATE_CHECK_SCHEDULE,
        "mode": "no-agent",
    }


def install(args):
    home = safe(args.home)
    if not (home / "skills").is_dir():
        raise RuntimeError("目标目录不是 Hermes 安装目录：" + str(home))
    from bundle import extract_bundle, installed_roots, read_bundle
    with installer_lock(home):
        update_root = home / "tavern-updates"
        update_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="direct-", dir=update_root) as temporary:
            work = Path(temporary)
            source = work / "source"
            manifest = read_bundle(args.release_dir, args.manifest_sha256)
            roots = installed_roots(home)
            old_app = roots["app"]
            old_mcp = roots["nora-mcp"]
            layout = python_layout(old_app)
            bundle_report = extract_bundle(args.release_dir, source, manifest, roots=roots)
            version = manifest["versions"]["tavern"]
            changed = set(bundle_report["changedModules"])
            root_changes = changed_roots(manifest, changed) | roots_with_unmanaged_files(home, manifest)
            if layout:
                root_changes.update(("app", "ops", "nora-mcp"))
            app_changed = "app" in root_changes
            ops_changed = "ops" in root_changes
            mcp_changed = "nora-mcp" in root_changes
            dependencies = prepare_dependencies(
                source,
                old_app,
                old_mcp,
                app_changed=app_changed,
                mcp_changed=mcp_changed,
            )
            skills = prepare_skills(source, work / "skills")
            agents_bytes = (source / "ops/skills/agents-tavern.md").read_bytes()
            desired_agents = merged_agents(home, agents_bytes)
            mcp_config = render_mcp(home)
            agents_changed = not (home / "AGENTS.md").is_file() or (home / "AGENTS.md").read_bytes() != desired_agents
            config_changed = not (home / "config.yaml").is_file() or (home / "config.yaml").read_bytes() != mcp_config
            migration = {"status": "not-required"}
            prepared_state = None
            if layout:
                log("迁移旧 Python 数据；不兼容记录只归档，不阻止更新")
                try:
                    prepared_state, migration = migration_copy(home, source, work, layout)
                except Exception as error:
                    prepared_state, migration = fallback_python_state(home, work, str(error))
            service_module = module_at("simple_service_manager", source / "ops/updater/service_manager.py")
            service = service_module.ManagedService.discover(home, old_app)
            service_snapshot = service.snapshot() if service else None
            swaps = []
            if app_changed:
                swaps.append(("app", source / "app", roots["app"]))
            if ops_changed:
                swaps.append(("ops", source / "ops", roots["ops"]))
            if mcp_changed:
                swaps.append(("nora-mcp", source / "nora-mcp", roots["nora-mcp"]))
            # The operations tree is swapped before host hooks. Keep the hook's
            # prepared source outside source/ops so moving that parent tree
            # cannot invalidate a later swap in the same transaction.
            host_hook = prepare_host_hook_swap(home, source, work / "host-hooks")
            if host_hook:
                swaps.append(host_hook)
            for relative, prepared in skills.items():
                target = home / "skills" / relative
                if not trees_equal(prepared, target):
                    swaps.append(("skill-" + relative.replace("/", "-"), prepared, target))
            for retired in getattr(module_at("simple_skill_names", source / "ops/scripts/install-hermes-skills.py"), "RETIRED"):
                target = home / "skills/creative" / retired
                if target.exists():
                    swaps.append(("retired-" + retired, None, target))
            host_changed = agents_changed or config_changed
            runtime_changed = app_changed or prepared_state is not None
            if not swaps and not host_changed and prepared_state is None:
                result = {
                    "status": "up-to-date",
                    "version": version,
                    "delivery": bundle_report,
                    "dependencies": dependencies,
                }
                print(json.dumps(result, ensure_ascii=False, indent=2))
                log("已是最新版，无需替换文件。")
                return
            stamp = time.strftime("%Y%m%d-%H%M%S")
            backup = home / "tavern-backups" / f"{stamp}-{version}-{uuid.uuid4().hex[:8]}"
            backup.mkdir(parents=True)
            copy_host_backup(home, backup, service_snapshot)
            applied = []
            state_swapped = False
            runtime_stopped = False
            try:
                if runtime_changed:
                    log("备份旧版本并停止 Tavern")
                    if service:
                        service.stop()
                    else:
                        stop_unmanaged(old_app)
                    runtime_stopped = True
                else:
                    log("应用非运行时更新，Tavern 保持运行")
                for name, prepared, target in swaps:
                    saved = backup / "trees" / name
                    if prepared is None:
                        saved.parent.mkdir(parents=True, exist_ok=True)
                        if target.exists():
                            os.replace(target, saved)
                        applied.append((name, target, saved))
                        continue
                    swap_tree(prepared, target, saved)
                    applied.append((name, target, saved))
                if prepared_state is not None:
                    active_state = home / "tavern-state"
                    saved_state = backup / "state"
                    os.replace(active_state, saved_state)
                    try:
                        os.replace(prepared_state, active_state)
                    except BaseException:
                        os.replace(saved_state, active_state)
                        raise
                    state_swapped = True
                if agents_changed:
                    atomic(home / "AGENTS.md", desired_agents, mode=0o600)
                if config_changed:
                    atomic(home / "config.yaml", mcp_config, mode=0o600)
                if app_changed:
                    json_write(home / "tavern-state/native-runtime/dependencies.json", dependency_marker(home / "apps/tavern-runtime"))
                if runtime_changed:
                    log("启动新版 Tavern")
                    runtime = install_runtime(
                        home,
                        skip_content_check="tavern-engine" not in changed,
                    )
                else:
                    runtime = {"native_pid": service_snapshot.get("pid") if service_snapshot else None,
                               "health": {"ok": port_open(8799)}}
                liveware_needed = app_changed or ops_changed or host_hook is not None
                liveware = refresh_liveware(home, home / "apps/tavern-ops") if liveware_needed else {"status": "unchanged"}
                if ops_changed:
                    try:
                        update_check = install_update_check(home, home / "apps/tavern-ops")
                    except Exception as update_check_error:
                        update_check = {"status": "pending", "warnings": [str(update_check_error)]}
                else:
                    update_check = {"status": "unchanged"}
                installed = {
                    "schema": 2,
                    "version": version,
                    "commit": manifest["commit"],
                    "installedAt": int(time.time()),
                    "backup": str(backup),
                    "migration": migration,
                    "liveware": liveware,
                    "updateCheck": update_check,
                    "delivery": bundle_report,
                    "dependencies": dependencies,
                }
                json_write(update_root / "installed.json", installed)
                json_write(update_root / "installed-manifest.json", manifest)
                reload_required = (
                    mcp_changed or agents_changed or config_changed
                    or any(name.startswith(("skill-", "host-hook-")) for name, _, _ in swaps)
                )
                result = {
                    "status": "installed",
                    "version": version,
                    "backup": str(backup),
                    "dataImport": migration,
                    "runtime": {"pid": runtime.get("native_pid"), "health": runtime.get("health", {}).get("ok")},
                    "liveware": liveware,
                    "updateCheck": update_check,
                    "delivery": bundle_report,
                    "dependencies": dependencies,
                    "next": "请在 ClawChat 输入 /restart 重新加载 MCP 和技能。" if reload_required else "更新已生效。",
                }
                print(json.dumps(result, ensure_ascii=False, indent=2))
                log("更新完成。" + ("请在 ClawChat 输入 /restart。" if reload_required else ""))
                return
            except BaseException as error:
                log("更新未完成，恢复旧版本")
                if runtime_stopped:
                    try:
                        active_app = home / "apps/tavern-runtime"
                        active_service = service_module.ManagedService.discover(home, active_app)
                        if active_service:
                            active_service.stop()
                        else:
                            stop_unmanaged(active_app)
                    except Exception:
                        pass
                failed_root = backup / "failed-new"
                for name, target, saved in reversed(applied):
                    restore_tree(target, saved, failed_root / name)
                if state_swapped:
                    active_state = home / "tavern-state"
                    if active_state.exists():
                        os.replace(active_state, failed_root / "state")
                    os.replace(backup / "state", active_state)
                restore_host(home, backup)
                recovery = "restored"
                if runtime_stopped:
                    try:
                        start_old(home, service, service_snapshot)
                    except Exception as recovery_error:
                        recovery = "files-restored-start-failed: " + str(recovery_error)
                raise RuntimeError(f"{error}; recovery={recovery}; backup={backup}") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-home", dest="home", type=Path, default=os.environ.get("HERMES_HOME", "/opt/data"))
    sub = parser.add_subparsers(dest="command", required=True)
    command = sub.add_parser("install")
    command.add_argument("--release-dir", type=Path, required=True)
    command.add_argument("--manifest-sha256", required=True)
    command.add_argument("--confirm", action="store_true", required=True)
    args = parser.parse_args()
    install(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
