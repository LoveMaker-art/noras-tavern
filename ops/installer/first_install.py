#!/usr/bin/env python3
"""Hermes-only first installer for Nora Tavern."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BEGIN, END = "<!-- BEGIN TAVERN SKILLS -->", "<!-- END TAVERN SKILLS -->"


def log(message: str) -> None:
    print("[nora-tavern-install] " + message, file=sys.stderr, flush=True)


def safe(path: str | Path) -> Path:
    value = Path(path).expanduser().resolve()
    if value == Path("/"):
        raise RuntimeError("拒绝使用根目录作为 Hermes home")
    return value


def atomic(path: Path, data: bytes, mode: int = 0o600) -> None:
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


def default_home() -> Path:
    if os.environ.get("HERMES_HOME"):
        return safe(os.environ["HERMES_HOME"])
    if sys.platform.startswith("linux") and Path("/opt/data/skills").is_dir():
        return Path("/opt/data").resolve()
    return (Path.home() / ".hermes").resolve()


def validate_hermes(home: Path) -> dict:
    hermes = shutil.which("hermes")
    if not hermes and not (home / "config.yaml").exists() and not (home / "skills").is_dir():
        raise RuntimeError(
            "没有找到 Hermes 环境。请先安装 Hermes，确认 hermes 命令可用后再运行 Nora Tavern 首次安装器。"
        )
    (home / "skills").mkdir(parents=True, exist_ok=True)
    (home / "apps").mkdir(parents=True, exist_ok=True)
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
    return source, manifest


def assert_first_install_targets(home: Path, *, force: bool) -> None:
    targets = [
        home / "apps/tavern-runtime",
        home / "apps/tavern-ops",
        home / "apps/nora-mcp",
        home / "tavern-state/native-runtime",
    ]
    existing = [str(path) for path in targets if path.exists()]
    if existing and not force:
        raise RuntimeError(
            "检测到已有 Nora Tavern 安装痕迹。首次安装器不会覆盖现有安装；请使用 Tavern updater 或加 --force-first-install。\n"
            + "\n".join(existing)
        )


def copy_tree(source: Path, target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target)


def snapshot_targets(home: Path, targets: list[Path], backup: Path) -> list[dict]:
    records = []
    root = backup / "targets"
    for target in targets:
        relative = target.relative_to(home)
        destination = root / relative
        existed = target.exists()
        records.append({"path": str(relative), "existed": existed})
        if not existed:
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        if target.is_dir():
            shutil.copytree(target, destination, symlinks=True)
        else:
            shutil.copy2(target, destination)
    atomic(backup / "snapshot.json", (json.dumps(records, indent=2) + "\n").encode("utf-8"), mode=0o600)
    return records


def restore_targets(home: Path, records: list[dict], backup: Path) -> None:
    root = backup / "targets"
    for record in sorted(records, key=lambda item: len(Path(item["path"]).parts), reverse=True):
        relative = Path(record["path"])
        target = home / relative
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
        target = home / "skills" / relative
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(origin, target)
        installed.append(relative)
    return sorted(installed)


def merge_agents(home: Path, managed: str) -> str:
    path = home / "AGENTS.md"
    current = path.read_text(encoding="utf-8") if path.exists() else ""
    block = managed.strip()
    first, last = current.find(BEGIN), current.rfind(END)
    if first >= 0 and last >= first:
        next_text = current[:first].rstrip() + "\n\n" + block + "\n\n" + current[last + len(END):].lstrip()
    else:
        next_text = current.replace(BEGIN, "").replace(END, "").rstrip() + "\n\n" + block + "\n"
    atomic(path, next_text.encode("utf-8"), mode=0o600)
    return str(path)


def render_mcp(home: Path) -> bytes:
    try:
        import yaml
    except ImportError as error:
        raise RuntimeError("Hermes Python 缺少 PyYAML，无法写入 Nora MCP 配置") from error
    path = home / "config.yaml"
    value = yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else {}
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
    return yaml.safe_dump(value, allow_unicode=True, sort_keys=False).encode("utf-8")


def install_soul(home: Path, source: Path, *, replace: bool) -> dict:
    template = source / "ops/installer/templates/SOUL.md"
    if not template.is_file():
        raise RuntimeError("发布包缺少 Nora SOUL 模板")
    target = home / "SOUL.md"
    example = home / "SOUL.nora-tavern.example.md"
    if target.exists() and not replace:
        atomic(example, template.read_bytes(), mode=0o600)
        return {"status": "preserved-existing", "path": str(target), "example": str(example)}
    replaced = target.exists()
    atomic(target, template.read_bytes(), mode=0o600)
    return {"status": "replaced-with-backup" if replaced else "installed", "path": str(target)}


def install_update_check(home: Path, ops_root: Path) -> dict:
    try:
        update = module_at("nora_tavern_update_installed", ops_root / "updater/update.py")
        return update.install_update_check(home, ops_root)
    except Exception as error:
        return {"status": "pending", "warnings": [str(error)]}


def port_open(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", int(port))) == 0


def start_tavern(home: Path, port: int) -> dict:
    app = home / "apps/tavern-runtime"
    lifecycle = module_at("nora_tavern_native_lifecycle", app / "native_lifecycle.py")
    contract = lifecycle.RuntimeContract.from_dict(json.loads((app / "native-runtime.json").read_text(encoding="utf-8")))
    runtime = lifecycle.NativeRuntime(home, app, home / "tavern-state", contract)
    runtime.install()
    if Path("/proc").is_dir():
        return runtime.start(port=port)
    runtime.sync_assets()
    if port_open(port):
        raise RuntimeError(f"Tavern 端口已被占用：{port}")
    run_dir = runtime.run_dir("production")
    run_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["HERMES_HOME"] = str(home)
    env["TAVERN_DATA_ROOT"] = str(home)
    env.setdefault("TAVERN_PERSONALITY_FILE", str(home / "SOUL.md"))
    child = None
    try:
        child = runtime.spawn(runtime.node_command(port, runtime.native_data_root), env, run_dir / "native.log")
        atomic(run_dir / "native.pid", (str(child.pid) + "\n").encode("utf-8"))
        health = runtime.wait_for_health(port)
        metadata = {
            "schema": 1,
            "run_id": "production",
            "port": port,
            "data_root": str(runtime.native_data_root),
            "native_pid": child.pid,
            "started_at": int(time.time()),
            "contract_commit": contract.commit,
            "process": {"pid": child.pid, "inspection": "portable-health-check"},
        }
        atomic(run_dir / "run.json", (json.dumps(metadata, indent=2) + "\n").encode("utf-8"))
        return {**metadata, "health": health}
    except Exception:
        if child and child.poll() is None:
            try:
                os.kill(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        raise


def initialize_liveware(home: Path, port: int) -> dict:
    try:
        integration = module_at("nora_tavern_liveware", home / "apps/tavern-ops/updater/liveware_integration.py")
        return integration.initialize(home, port)
    except Exception as error:
        return {"status": "pending", "warnings": [str(error)]}


def install(args) -> dict:
    if not (args.apply and args.confirm):
        raise RuntimeError("首次安装必须显式传入 --apply --confirm")
    home = safe(args.hermes_home or default_home())
    hermes = validate_hermes(home)
    assert_first_install_targets(home, force=args.force_first_install)
    with tempfile.TemporaryDirectory(prefix="nora-first-install-") as temporary:
        work = Path(temporary)
        source, manifest = source_from_release(args, work)
        version = manifest.get("versions", {}).get("tavern", "unknown")
        backup = home / "tavern-first-install-backups" / f"{time.strftime('%Y%m%d-%H%M%S')}-{version}-{os.getpid()}"
        prepared_skills = prepare_skills(source, work)
        managed_targets = [
            home / "apps/tavern-runtime",
            home / "apps/tavern-ops",
            home / "apps/nora-mcp",
            home / "tavern-state/native-runtime",
            home / "AGENTS.md",
            home / "config.yaml",
            home / "SOUL.md",
            home / "SOUL.nora-tavern.example.md",
            *[home / "skills" / relative for relative in prepared_skills],
        ]
        records = snapshot_targets(home, managed_targets, backup)
        try:
            log("安装 Nora Tavern 程序文件")
            copy_tree(source / "app", home / "apps/tavern-runtime")
            copy_tree(source / "ops", home / "apps/tavern-ops")
            copy_tree(source / "nora-mcp", home / "apps/nora-mcp")

            log("安装 Hermes skills、AGENTS 和 Nora MCP 配置")
            skills = install_skills(home, prepared_skills)
            agents = merge_agents(home, (source / "ops/skills/agents-tavern.md").read_text(encoding="utf-8"))
            atomic(home / "config.yaml", render_mcp(home), mode=0o600)
            soul = install_soul(home, source, replace=args.replace_soul)

            log("准备并启动本地 Tavern")
            runtime = start_tavern(home, args.port)
            liveware = {"status": "skipped"}
            if not args.skip_liveware:
                log("尝试初始化 Tavern Liveware 入口")
                liveware = initialize_liveware(home, args.port)
            update_check = install_update_check(home, home / "apps/tavern-ops")
        except Exception:
            log("安装失败，恢复安装前的程序和 Hermes 配置")
            restore_targets(home, records, backup)
            raise

    result = {
        "status": "installed",
        "mode": "first-install",
        "version": version,
        "commit": manifest.get("commit"),
        "hermes": hermes,
        "home": str(home),
        "paths": {
            "tavern": str(home / "apps/tavern-runtime"),
            "noraMcp": str(home / "apps/nora-mcp"),
            "ops": str(home / "apps/tavern-ops"),
            "state": str(home / "tavern-state"),
            "agents": agents,
        },
        "skills": skills,
        "soul": soul,
        "runtime": {"pid": runtime.get("native_pid"), "port": args.port, "health": runtime.get("health", {}).get("ok")},
        "liveware": liveware,
        "updateCheck": update_check,
        "next": "请重新启动 Hermes 会话，然后让 Nora 检查 Tavern 状态。",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-home", "--data-root", dest="hermes_home")
    parser.add_argument("--release-dir", type=Path)
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--allow-candidate", action="store_true")
    parser.add_argument("--force-first-install", action="store_true")
    parser.add_argument("--replace-soul", action="store_true")
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
