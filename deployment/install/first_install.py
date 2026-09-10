#!/usr/bin/env python3
"""Hermes-only first installer for Nora Tavern."""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
import tarfile
import tempfile
import time
import platform


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
HOST_HOOK = Path("hooks/tavern-liveware-register")


def log(message: str) -> None:
    print("[nora-tavern-install] " + message, file=sys.stderr, flush=True)


def event(kind: str, **payload) -> None:
    print(json.dumps({"event": kind, **payload}, ensure_ascii=False), flush=True)


def safe(path: str | Path) -> Path:
    value = Path(path).expanduser().resolve()
    if value == Path("/"):
        raise RuntimeError("拒绝使用根目录作为安装目录")
    return value


def filesystem_path(path: str | Path) -> str:
    return _shared_paths.filesystem_path(path)


def install_workspace(nora_home: Path):
    root = Path(filesystem_path(nora_home)).resolve()
    parent = root / ".tmp"
    if not parent.resolve().is_relative_to(root):
        raise RuntimeError("安装临时目录越过隔离目录，已停止")
    parent.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix="i-", dir=parent)


def atomic(path: Path, data: bytes, mode: int = 0o600) -> None:
    path = Path(filesystem_path(path))
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


def module_at(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载模块：" + str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_shared_paths = module_at("nora_install_paths", ROOT / "ops/updater/bootstrap.py")


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


def validate_hermes(home: Path, *, dedicated: bool = True) -> dict:
    if not dedicated:
        hermes = shutil.which("hermes")
        if not hermes and not (home / "config.yaml").exists() and not (home / "skills").is_dir():
            raise RuntimeError("没有找到 Hermes 环境，请先安装 Hermes。")
        (home / "skills").mkdir(parents=True, exist_ok=True)
        return {"home": str(home), "hermes": hermes}
    name = "hermes.exe" if os.name == "nt" else "hermes"
    marker = home / "hermes-agent/.hermes-bootstrap-complete"
    hermes = next((
        str(candidate)
        for candidate in (
            home / "hermes-agent/venv/bin" / name,
            home / "hermes-agent/venv/Scripts" / name,
        )
        if candidate.is_file()
    ), None)
    if not marker.is_file() or not hermes:
        raise RuntimeError(
            "Nora 尚未完成安装，请在启动器中重试。"
        )
    if hermes:
        probe = subprocess.run(
            [hermes, "--version"],
            text=True,
            capture_output=True,
            timeout=30,
            env={**os.environ, "HOME": str(home), "HERMES_HOME": str(home)},
        )
        if probe.returncode:
            raise RuntimeError("Hermes 已存在但无法启动：" + (probe.stderr or probe.stdout).strip())
    (home / "skills").mkdir(parents=True, exist_ok=True)
    return {"home": str(home), "hermes": hermes}


def read_manifest_sha(release_dir: Path) -> str:
    checks = {}
    for line in (release_dir / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, name = line.split(None, 1)
        checks[name.strip()] = digest
    return checks.get("release-manifest.json", "")


def source_from_release(args, work: Path) -> tuple[Path, dict]:
    if args.source_root:
        source = safe(args.source_root)
        manifest = {
            "schema": "local-source",
            "versions": {"tavern": (source / "app/.tavern-release-version").read_text(encoding="utf-8").strip()},
            "commit": "local-source",
        }
        return source, manifest
    if not args.release_dir:
        raise RuntimeError("首次安装器需要 --release-dir 或 --source-root")
    release_dir = safe(args.release_dir)
    bundle = module_at("nora_tavern_bundle", ROOT / "ops/updater/bundle.py")
    manifest_sha = args.manifest_sha256 or read_manifest_sha(release_dir)
    manifest = bundle.read_bundle(release_dir, manifest_sha, candidate=args.allow_candidate)
    source = work / "source"
    bundle.extract_bundle(release_dir, source, manifest)
    dependencies = extract_dependency_bundle(release_dir, source)
    if dependencies:
        manifest["integratedDependencies"] = dependencies
    return source, manifest


def runtime_platform() -> tuple[str, str]:
    system = "win32" if os.name == "nt" else "darwin" if sys.platform == "darwin" else sys.platform
    machine = platform.machine().lower()
    if system == "win32":
        machine = {"win-amd64": "amd64", "win-arm64": "arm64", "win32": "x86"}.get(sysconfig.get_platform(), machine)
    architecture = "arm64" if machine in {"arm64", "aarch64"} else "x64" if machine in {"x86_64", "amd64"} else machine
    return system, architecture


def extract_dependency_bundle(release_dir: Path, source: Path) -> dict | None:
    manifest_path = release_dir / "nora-tavern-dependencies.json"
    if not manifest_path.is_file():
        return None
    value = json.loads(manifest_path.read_text(encoding="utf-8"))
    if value.get("schema") != 1:
        raise RuntimeError("依赖包清单版本不受支持")
    system, architecture = runtime_platform()
    if (value.get("platform"), value.get("arch")) != (system, architecture):
        raise RuntimeError(f"依赖包平台不匹配：需要 {system}-{architecture}")
    archive = release_dir / str(value.get("archive", ""))
    if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != value.get("sha256"):
        raise RuntimeError("依赖包校验失败，安装包可能不完整")
    source = Path(filesystem_path(source))
    source_root = source.resolve()
    with tarfile.open(archive, "r:gz") as stream:
        members = []
        for member in stream.getmembers():
            target = (source / member.name).resolve()
            if target != source_root and source_root not in target.parents:
                raise RuntimeError("依赖包包含非法路径：" + member.name)
            if member.issym() or member.islnk():
                link = (target.parent / member.linkname).resolve()
                if link != source_root and source_root not in link.parents:
                    raise RuntimeError("依赖包包含非法链接：" + member.name)
            if member.isdir():
                # extractall uses directory names again for lstat and metadata.
                member = copy.copy(member)
                member.name = str(Path(member.name))
            members.append(member)
        stream.extractall(source, members=members)
    return value


def mark_bundled_dependencies(source: Path, install_root: Path, manifest: dict) -> None:
    bundled = manifest.get("integratedDependencies")
    if not isinstance(bundled, dict):
        return
    node_major = int(bundled.get("nodeMajor") or 0)
    if node_major <= 0:
        raise RuntimeError("依赖包没有声明 Node.js 版本")
    lock = source / "app/engine/sillytavern/package-lock.json"
    required = (
        source / "app/engine/sillytavern/node_modules/express/package.json",
        source / "app/engine/sillytavern/node_modules/webpack/package.json",
        source / "nora-mcp/node_modules/@modelcontextprotocol/sdk/package.json",
        source / "nora-mcp/node_modules/zod/package.json",
    )
    if not lock.is_file() or not all(path.is_file() for path in required):
        raise RuntimeError("整合依赖包不完整")
    marker = install_root / "tavern-state/native-runtime/dependencies.json"
    atomic(marker, (json.dumps({
        "schema": 1,
        "lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
        "node_major": node_major,
        "prepared_at": int(time.time()),
        "source": "nora-integrated-package",
    }, indent=2) + "\n").encode("utf-8"), mode=0o600)


def assert_first_install_targets(install_root: Path, *, force: bool) -> None:
    targets = [
        install_root / "apps/tavern-runtime",
        install_root / "apps/tavern-ops",
        install_root / "apps/nora-mcp",
        install_root / "tavern-state/native-runtime",
    ]
    existing = [str(path) for path in targets if path.exists()]
    if existing and not force:
        raise RuntimeError(
            "检测到已有 Nora Tavern 安装痕迹。首次安装器不会覆盖现有安装；请使用 Tavern updater 或加 --force-first-install。\n"
            + "\n".join(existing)
        )


def copy_tree(source: Path, target: Path) -> None:
    source, target = Path(filesystem_path(source)), Path(filesystem_path(target))
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target, symlinks=True)


def install_host_hook(home: Path, source: Path) -> str:
    origin = source / "ops" / HOST_HOOK
    required = ("HOOK.yaml", "handler.py", "run.sh")
    missing = [name for name in required if not (origin / name).is_file()]
    if missing:
        raise RuntimeError("发布包缺少 Tavern 启动钩子：" + ", ".join(missing))
    target = home / HOST_HOOK
    copy_tree(origin, target)
    return str(target)


def snapshot_targets(home: Path, targets: list[Path], backup: Path) -> list[dict]:
    records = []
    root = Path(filesystem_path(backup / "targets"))
    for target in dict.fromkeys(targets):
        relative = target.relative_to(home)
        if not target.resolve().is_relative_to(home.resolve()):
            raise RuntimeError("托管文件路径越过安装目录，已停止：" + str(relative))
        destination = root / relative
        existed = target.exists()
        records.append({"path": str(relative), "existed": existed})
        if not existed:
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        if target.is_dir():
            shutil.copytree(filesystem_path(target), destination, symlinks=True)
        else:
            shutil.copy2(filesystem_path(target), destination)
    atomic(backup / "snapshot.json", (json.dumps(records, indent=2) + "\n").encode("utf-8"), mode=0o600)
    return records


def restore_targets(home: Path, records: list[dict], backup: Path) -> None:
    root = Path(filesystem_path(backup / "targets"))
    for record in sorted(records, key=lambda item: len(Path(item["path"]).parts), reverse=True):
        relative = Path(record["path"])
        target = Path(filesystem_path(home / relative))
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists() or target.is_symlink():
            target.unlink()
        if not record["existed"]:
            continue
        source = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target, symlinks=True)
        else:
            shutil.copy2(source, target)


def prepare_skills(source: Path, work: Path) -> dict[str, Path]:
    installer = module_at("nora_tavern_skill_installer", source / "ops/scripts/install-hermes-skills.py")
    return installer.prepare_skill_trees(source, work / "prepared-skills")


def install_skills(home: Path, prepared: dict[str, Path]) -> list[str]:
    installed = []
    for relative, origin in prepared.items():
        target = Path(filesystem_path(home / "skills" / relative))
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(filesystem_path(origin), target)
        installed.append(relative)
    return sorted(installed)


def restore_retained_config(install_root: Path) -> Path:
    retained = install_root / "tavern-state/nora-retained-config.yaml"
    target = install_root / "tavern-state/native-runtime/config.yaml"
    for candidate in (retained, target):
        if candidate.is_symlink() or not candidate.resolve().is_relative_to(install_root.resolve()):
            raise RuntimeError("保留的酒馆配置不能重定向到隔离目录外")
    if retained.is_file():
        atomic(target, retained.read_bytes(), mode=0o600)
    return retained


def install_agents(home: Path, document: str) -> str:
    context = module_at("first_install_managed_context", ROOT / "ops/updater/managed_context.py")
    return context.install_agents(home, document)


def render_mcp(hermes_home: Path, install_root: Path, port: int = 8799) -> bytes:
    updater = module_at("first_install_mcp", HERE.parent / "updater/update.py")
    return updater.render_mcp(hermes_home, install_root, port)


def install_soul(home: Path, source: Path, *, replace: bool, dedicated: bool = False) -> dict:
    template = source / "ops/installer/templates/SOUL.md"
    if not template.is_file():
        raise RuntimeError("发布包缺少 Nora SOUL 模板")
    target = home / "SOUL.md"
    example = home / "SOUL.nora-tavern.example.md"
    if dedicated and target.exists() and not replace:
        defaults = home / "hermes-agent/hermes_cli/default_soul.py"
        if defaults.is_file():
            upstream = module_at("nora_upstream_default_soul", defaults)
            replace = target.read_text(encoding="utf-8").strip() == upstream.DEFAULT_SOUL_MD.strip()
    if target.exists() and not replace:
        atomic(example, template.read_bytes(), mode=0o600)
        return {"status": "preserved-existing", "path": str(target), "example": str(example)}
    replaced = target.exists()
    atomic(target, template.read_bytes(), mode=0o600)
    return {"status": "replaced-with-backup" if replaced else "installed", "path": str(target)}


def write_install_receipt(root: Path, manifest: dict) -> None:
    atomic(root / "tavern-updates/installed-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
    atomic(root / "tavern-updates/installed.json", json.dumps({
        "schema": 1, "mode": "first-install", "version": manifest.get("versions", {}).get("tavern"),
        "commit": manifest.get("commit"), "installedAt": time.time(),
        "components": manifest.get("versions", {}), "hermesRuntime": manifest.get("hermesRuntime"),
    }, ensure_ascii=False, indent=2).encode("utf-8"))


def install_update_check(home: Path, ops_root: Path) -> dict:
    update = module_at("nora_tavern_update_installed", ops_root / "updater/update.py")
    return update.install_update_check(home, ops_root)


def start_tavern(hermes_home: Path, install_root: Path, port: int) -> dict:
    app = install_root / "apps/tavern-runtime"
    lifecycle = module_at("nora_tavern_native_lifecycle", app / "native_lifecycle.py")
    contract = lifecycle.RuntimeContract.from_dict(json.loads((app / "native-runtime.json").read_text(encoding="utf-8")))
    runtime = lifecycle.NativeRuntime(install_root, app, install_root / "tavern-state", contract)
    runtime.install()
    return runtime.start(port=port)


def stop_install_runtime(install_root: Path) -> None:
    app = install_root / "apps/tavern-runtime"
    lifecycle = module_at("nora_tavern_rollback_lifecycle", app / "native_lifecycle.py")
    contract = lifecycle.RuntimeContract.from_dict(json.loads((app / "native-runtime.json").read_text(encoding="utf-8")))
    lifecycle.NativeRuntime(install_root, app, install_root / "tavern-state", contract).stop_run()


def initialize_liveware(hermes_home: Path, install_root: Path, port: int) -> dict:
    try:
        integration = module_at("nora_tavern_liveware", install_root / "apps/tavern-ops/updater/liveware_integration.py")
        return integration.initialize(install_root, port, hermes_home=hermes_home)
    except Exception as error:
        return {"status": "pending", "warnings": [str(error)]}


def install(args) -> dict:
    if not (args.apply and args.confirm):
        raise RuntimeError("首次安装必须显式传入 --apply --confirm")
    dedicated = getattr(args, "dedicated_nora", False)
    if dedicated:
        nora_home = safe(args.nora_home) if args.nora_home else default_nora_home()
        hermes_home = safe(args.hermes_home) if args.hermes_home else default_hermes_home(nora_home)
        install_root = safe(args.install_root) if args.install_root else default_install_root(nora_home)
    else:
        shared = module_at("first_install_shared", HERE.parent / "updater/update.py")
        hermes_home = safe(args.hermes_home) if args.hermes_home else shared.default_hermes_home()
        install_root = safe(args.install_root or os.environ.get("TAVERN_DATA_ROOT") or hermes_home)
        nora_home = safe(args.nora_home) if args.nora_home else hermes_home
    os.environ["NORA_TAVERN_HOME"] = str(nora_home)
    os.environ["NORA_HERMES_HOME"] = str(hermes_home)
    os.environ["HERMES_HOME"] = str(hermes_home)
    os.environ["HERMES_INSTALL_DIR"] = str(hermes_home / "hermes-agent")
    os.environ["TAVERN_DATA_ROOT"] = str(install_root)
    if not 1024 <= args.port <= 65535:
        raise RuntimeError("酒馆端口必须在 1024 至 65535 之间")
    nora_home.mkdir(parents=True, exist_ok=True)
    event("milestone", index=0, state="running", task="检查 Nora")
    hermes = validate_hermes(hermes_home) if dedicated else validate_hermes(hermes_home, dedicated=False)
    event("task", milestone=0, task="Hermes 核心就绪，继续初始化 Nora")
    if dedicated and (hermes_home == nora_home or install_root == nora_home or
                      hermes_home.is_relative_to(install_root) or install_root.is_relative_to(hermes_home) or
                      not hermes_home.is_relative_to(nora_home) or not install_root.is_relative_to(nora_home)):
        raise RuntimeError("Nora 和酒馆必须安装在专属隔离目录内")
    assert_first_install_targets(install_root, force=args.force_first_install)
    with install_workspace(nora_home) as temporary:
        work = Path(temporary)
        event("task", milestone=0, task="正在解压诺拉与酒馆文件")
        source, manifest = source_from_release(args, work)
        version = manifest.get("versions", {}).get("tavern", "unknown")
        backup = install_root / "tavern-first-install-backups" / f"{time.strftime('%Y%m%d-%H%M%S')}-{version}-{time.time_ns()}"
        prepared_skills = prepare_skills(source, work)
        context = module_at("release_managed_context", source / "ops/updater/managed_context.py")
        document = context.agents_document((source / "ops/skills/agents-tavern.md").read_bytes())
        context_swaps, greeting_report = context.prepare_greeting(hermes_home, source, work / "greeting")
        patcher = module_at("first_install_clawchat_greeting_patch", source / "ops/updater/clawchat_greeting_patch.py")
        if dedicated and (hermes_home / "nora-components.json").is_file() and not patcher.bundled_patch_ready(hermes_home):
            raise RuntimeError("内置 ClawChat 缺少匹配的开场白修复，请使用同一版本的完整运行时重新构建安装包。")
        gateway_swaps, gateway_report = patcher.prepare(hermes_home, work / "clawchat-greeting")
        if gateway_report.get("status") == "pending":
            log("ClawChat 欢迎消息顺序补丁未应用，插件保留原状：" + "; ".join(gateway_report.get("warnings", [])))
        tavern_targets = [
            install_root / "apps/tavern-runtime",
            install_root / "apps/tavern-ops",
            install_root / "apps/nora-mcp",
            install_root / "tavern-state/native-runtime",
            install_root / "tavern-updates/installed.json",
            install_root / "tavern-updates/installed-manifest.json",
            install_root / "tavern-updates/nora-system.json",
        ]
        hermes_targets = [
            hermes_home / "config.yaml",
            hermes_home / "SOUL.md",
            hermes_home / "SOUL.nora-tavern.example.md",
            hermes_home / HOST_HOOK,
            hermes_home / "nora-instance.json",
            hermes_home / "cron/jobs.json",
            hermes_home / "clawchat/greeting.md",
            hermes_home / "clawchat/nora-greeting.json",
            hermes_home / "clawchat/greeting.nora-example.md",
            hermes_home / "nora-installation.json",
            hermes_home / "clawchat-skills",
            *[hermes_home / "scripts" / name for name in
              ("nora-instance.py", "nora-tavern-update-check.py", "nora-tavern-card-send.py")],
            *[hermes_home / "skills" / relative for relative in prepared_skills],
            *[target for _, _, target in gateway_swaps],
            *[target for _, _, target in context_swaps],
        ]
        tavern_records = snapshot_targets(install_root, tavern_targets, backup / "tavern")
        hermes_records = snapshot_targets(hermes_home, hermes_targets, backup / "hermes")
        # Retain recovery copies only while applying or if rollback itself fails.
        agents_backup = Path(filesystem_path(backup / "agents-rollback"))
        context.snapshot_agents(hermes_home, agents_backup)
        runtime_attempted = False
        try:
            event("task", milestone=0, task="配置诺拉")
            for _, prepared, target in gateway_swaps:
                atomic(target, prepared.read_bytes(), mode=prepared.stat().st_mode & 0o777)
            for _, prepared, target in context_swaps:
                atomic(target, prepared.read_bytes(), mode=0o600)
            if gateway_swaps:
                gateway_report = {**gateway_report, "status": "installed"}
            log("安装 Hermes skills、AGENTS 和 Nora MCP 配置")
            skills = install_skills(hermes_home, prepared_skills)
            host_hook = install_host_hook(hermes_home, source)
            agents = context.install_agents(hermes_home, document)
            atomic(hermes_home / "config.yaml", render_mcp(hermes_home, install_root, args.port), mode=0o600)
            soul = install_soul(hermes_home, source, replace=args.replace_soul, dedicated=dedicated)
            if dedicated:
                system = module_at("nora_install_system", HERE / "nora_system.py")
                system.configure_managed(hermes_home, install_root, nora_home, args.port, source,
                                         sys.executable, dict(os.environ))
            update_check = install_update_check(hermes_home, source / "ops")
            if update_check.get("status") != "installed":
                raise RuntimeError("诺拉更新提醒任务未成功注册")
            if dedicated:
                problems = system.managed_problems(hermes_home, install_root, args.port)
                if problems:
                    raise RuntimeError("；".join(problems))
                system.record_files_ready(hermes_home)
            event("milestone", index=0, state="done", task="诺拉文件安装完成")
            event("milestone", index=1, state="running", task="安装酒馆本体")
            copy_tree(source / "app", install_root / "apps/tavern-runtime")
            copy_tree(source / "ops", install_root / "apps/tavern-ops")
            copy_tree(source / "nora-mcp", install_root / "apps/nora-mcp")
            retained_config = restore_retained_config(install_root)
            mark_bundled_dependencies(source, install_root, manifest)
            event("task", milestone=1, task="启动并检查酒馆")
            log("准备并启动本地 Tavern")
            runtime_attempted = True
            runtime = start_tavern(hermes_home, install_root, args.port)
            liveware = {"status": "skipped"}
            if not args.skip_liveware:
                log("尝试初始化 Tavern Liveware 入口")
                liveware = initialize_liveware(hermes_home, install_root, args.port)
            if not runtime.get("health", {}).get("ok"):
                raise RuntimeError("酒馆启动后未通过健康检查")
            if dedicated:
                system = module_at("nora_install_system", HERE / "nora_system.py")
                event("task", milestone=1, task="验证诺拉身份、技能与酒馆连接")
                proof = system.verify_runtime(hermes_home, install_root, args.port, sys.executable, dict(os.environ))
                system.record_initialization(hermes_home, install_root, manifest, proof)
            write_install_receipt(install_root, manifest)
            retained_config.unlink(missing_ok=True)
            event("milestone", index=1, state="done", task="酒馆安装检查完成")
            event("task", task="系统已安装，等待配置模型和连接 ClawChat")
        except Exception:
            event("milestone", index=1, state="error", task="安装失败")
            log("安装失败，恢复安装前的程序和 Hermes 配置")
            if runtime_attempted:
                stop_install_runtime(install_root)
            restore_targets(install_root, tavern_records, backup / "tavern")
            restore_targets(hermes_home, hermes_records, backup / "hermes")
            context.restore_agents(hermes_home, agents_backup)
            shutil.rmtree(filesystem_path(agents_backup))
            event("milestone", index=0, state="pending", task="安装已回滚")
            raise
        shutil.rmtree(filesystem_path(agents_backup))

    result = {
        "status": "installed",
        "mode": "first-install",
        "version": version,
        "commit": manifest.get("commit"),
        "hermes": hermes,
        "home": str(nora_home),
        "noraHome": str(nora_home),
        "hermesHome": str(hermes_home),
        "installRoot": str(install_root),
        "paths": {
            "tavern": str(install_root / "apps/tavern-runtime"),
            "noraMcp": str(install_root / "apps/nora-mcp"),
            "ops": str(install_root / "apps/tavern-ops"),
            "state": str(install_root / "tavern-state"),
            "agents": agents,
            "hostHook": host_hook,
        },
        "skills": skills,
        "soul": soul,
        "runtime": {"pid": runtime.get("native_pid"), "port": args.port, "health": runtime.get("health", {}).get("ok")},
        "liveware": liveware,
        "updateCheck": update_check,
        "clawchatGreeting": gateway_report,
        "greeting": greeting_report,
        "next": "请重新启动 Hermes 会话，然后让 Nora 检查 Tavern 状态。",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-home", "--data-root", dest="hermes_home")
    parser.add_argument("--nora-home")
    parser.add_argument("--install-root")
    parser.add_argument("--release-dir", type=Path)
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--allow-candidate", action="store_true")
    parser.add_argument("--force-first-install", action="store_true")
    parser.add_argument("--replace-soul", action="store_true")
    parser.add_argument("--dedicated-nora", action="store_true")
    parser.add_argument("--skip-liveware", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    install(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("[nora-tavern-install] 安装失败：" + str(error), file=sys.stderr)
        raise SystemExit(1)
