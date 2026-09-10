#!/usr/bin/env python3
"""Download one release and hand it to the direct Tavern installer."""
import argparse
import hashlib
import json
import ntpath
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

REPO = "LoveMaker-art/noras-tavern"
METADATA = ("release-manifest.json", "SHA256SUMS")
FULL_ARCHIVES = (
    "nora-tavern-app.tar.gz",
    "nora-tavern-ops.tar.gz",
    "nora-tavern-nora-mcp.tar.gz",
)


def filesystem_path(path):
    """Use extended Windows paths for I/O, never for saved instance bindings."""
    value = os.fspath(path)
    if os.name != "nt":
        return value
    value = ntpath.normpath(ntpath.abspath(value.replace("/", "\\")))
    if value.startswith("\\\\?\\"):
        return value
    if value.startswith("\\\\"):
        return "\\\\?\\UNC\\" + value[2:]
    return "\\\\?\\" + value


def default_hermes_home():
    return Path(os.environ.get("HERMES_HOME") or (
        "/opt/data" if sys.platform.startswith("linux") and Path("/opt/data/skills").is_dir()
        else Path.home() / ".hermes")).expanduser().resolve()


def default_install_root():
    return Path(os.environ.get("TAVERN_DATA_ROOT") or default_hermes_home()).expanduser().resolve()


def managed_instance(home, root):
    """Authorize the desktop adapter only inside its recoverable transaction."""
    home, root = Path(home).resolve(), Path(root).resolve()
    try:
        instance = json.loads((home / "nora-instance.json").read_text(encoding="utf-8"))
        expected = {"noraHome": root, "hermesHome": root / "hermes", "installRoot": root / "tavern"}
        if instance.get("schema") != 1 or home != expected["hermesHome"]:
            raise ValueError("invalid instance")
        for name, path in expected.items():
            value = Path(instance[name])
            if not value.is_absolute() or value.resolve() != path or path.is_symlink():
                raise ValueError("invalid " + name)
        port = instance["port"]
        if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
            raise ValueError("invalid port")
        system = json.loads((expected["installRoot"] / "tavern-updates/nora-system.json").read_text(encoding="utf-8"))
        if system.get("schema") != 1:
            raise ValueError("invalid system receipt")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise RuntimeError("无法核对启动器实例记录，已停止更新") from error
    try:
        journal = json.loads((root / "installer/system-update/journal.json").read_text(encoding="utf-8"))
        if journal.get("schema") != 1 or journal.get("phase") != "applying":
            raise ValueError("not applying")
    except (OSError, ValueError, AttributeError) as error:
        raise RuntimeError("启动器更新事务未就绪，请从启动器执行更新") from error
    return instance


def resolve_update_target(hermes_home=None, install_root=None, *, managed_home=None):
    """Resolve an existing installation without writing or inventing a new root.

    Kept in the standalone bootstrap so the downloaded entry and bundle runner
    use the same rules, without an unverified helper download.
    """
    home = Path(hermes_home).expanduser().resolve() if hermes_home else default_hermes_home()
    managed_error = "此实例由诺拉启动器管理，禁止用 Tavern 单体更新器覆盖完整 Nora 系统。请在启动器中检查版本。"
    instance = managed_instance(home, managed_home) if managed_home else None
    if (home / "nora-instance.json").exists() and not instance:
        raise RuntimeError(managed_error)
    if not (home / "skills").is_dir():
        raise RuntimeError("无法确认 Hermes 安装目录：" + str(home))
    candidates = {}

    def add(label, value):
        root = Path(value).expanduser().resolve()
        if root == Path(root.anchor):
            raise RuntimeError("拒绝使用文件系统根目录作为安装目录")
        candidates[label] = root

    if install_root:
        add("--install-root", install_root)
    if instance:
        add("启动器实例", instance["installRoot"])
    if os.environ.get("TAVERN_DATA_ROOT"):
        add("TAVERN_DATA_ROOT", os.environ["TAVERN_DATA_ROOT"])

    config_path = home / "config.yaml"
    if config_path.exists():
        try:
            import yaml
            config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
            server = config.get("mcp_servers", {}).get("nora", {})
            env = server.get("env", {})
            if not isinstance(env, dict):
                raise ValueError("MCP env must be a mapping")
            if instance and env.get("NORA_MCP_BASE_URL") != f"http://127.0.0.1:{instance['port']}":
                raise ValueError("MCP port differs from the managed instance")
            suffixes = {
                "NORA_MCP_PROJECT_ROOT": "apps/tavern-runtime",
                "NORA_MCP_ST_ROOT": "apps/tavern-runtime/engine/sillytavern",
                "NORA_MCP_STATE_ROOT": "tavern-state",
                "NORA_MCP_NATIVE_DATA_ROOT": "tavern-state/native",
                "NORA_MCP_CONFIG_PATH": "tavern-state/native-runtime/config.yaml",
                "NORA_MCP_UPLOAD_ROOT": "tavern-state/imports",
            }
            for key, suffix in suffixes.items():
                if key not in env:
                    continue
                value = Path(env[key]).expanduser()
                parts = Path(suffix).parts
                if not value.is_absolute() or value.parts[-len(parts):] != parts:
                    raise ValueError("invalid " + key)
                add("MCP " + key, value.parents[len(parts) - 1])
            if "NORA_MCP_USER_DATA_ROOT" in env:
                value = Path(env["NORA_MCP_USER_DATA_ROOT"]).expanduser()
                if not value.is_absolute() or value.parent.name != "native" or value.parent.parent.name != "tavern-state":
                    raise ValueError("invalid NORA_MCP_USER_DATA_ROOT")
                add("MCP NORA_MCP_USER_DATA_ROOT", value.parents[2])
            args = server.get("args", [])
            if not isinstance(args, list):
                raise ValueError("MCP args must be a list")
            for arg in args:
                if isinstance(arg, str) and arg.replace("\\", "/").endswith("apps/nora-mcp/dist/server.js"):
                    value = Path(arg).expanduser()
                    if not value.is_absolute():
                        raise ValueError("relative MCP server path")
                    add("MCP args", value.parents[3])
        except (ImportError, OSError, ValueError, TypeError, AttributeError) as error:
            raise RuntimeError("无法核对现有 MCP 配置，已停止更新：" + str(config_path)) from error
        except yaml.YAMLError as error:
            raise RuntimeError("无法解析现有 MCP 配置，已停止更新：" + str(config_path)) from error

    # These are evidence locations, not fallback destinations. No recursive scan.
    known = [home]
    if os.environ.get("NORA_TAVERN_HOME"):
        known.append(Path(os.environ["NORA_TAVERN_HOME"]).expanduser() / "tavern")
    for root in known:
        if (root / "tavern-updates/installed.json").is_file() or (
                (root / "apps/tavern-runtime").is_dir() and (root / "tavern-state").is_dir()):
            add("现有安装 " + str(root), root)
    if len(set(candidates.values())) > 1:
        details = "; ".join(label + "=" + str(value) for label, value in candidates.items())
        raise RuntimeError("安装目录冲突，未修改任何实例。请先核对绑定：" + details)
    if not candidates:
        raise RuntimeError("未找到已有酒馆安装，更新器不会创建新实例。首次部署请使用安装流程。")
    root = next(iter(candidates.values()))
    if (root / "tavern-updates/nora-system.json").exists() and not instance:
        raise RuntimeError(managed_error)
    app = root / "apps/tavern-runtime"
    if not any((app / entry).is_file() for entry in ("native-runtime.json", "server.py", "backend/server.py")) or not (root / "tavern-state").is_dir():
        raise RuntimeError("目标不是完整的已有酒馆安装，已停止更新：" + str(root))
    if (root / "tavern-state").is_symlink():
        raise RuntimeError("数据目录是符号链接，无法保证事务回滚，已停止更新：" + str(root / "tavern-state"))
    receipt = root / "tavern-updates/installed.json"
    if receipt.exists():
        try:
            if not isinstance(json.loads(receipt.read_text(encoding="utf-8")), dict):
                raise ValueError("invalid receipt")
        except (OSError, ValueError) as error:
            raise RuntimeError("安装记录损坏，已停止更新：" + str(receipt)) from error
    return home, root


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, target):
    request = urllib.request.Request(url, headers={"User-Agent": "tavern-updater/3"})
    with urllib.request.urlopen(request, timeout=120) as response, Path(target).open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)


def checksums(directory):
    directory = Path(directory)
    sums = {}
    for line in (directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, name = line.split(None, 1)
        sums[name.strip()] = digest
    return sums


def verify_metadata(directory, expected_manifest=None, *, allow_candidate=False):
    directory = Path(directory)
    sums = checksums(directory)
    for name in METADATA:
        if not (directory / name).is_file():
            raise RuntimeError("发布文件缺失或校验失败：" + name)
        if name != "SHA256SUMS" and sha(directory / name) != sums.get(name):
            raise RuntimeError("发布文件缺失或校验失败：" + name)
    manifest_sha = sums["release-manifest.json"]
    if expected_manifest and expected_manifest != manifest_sha:
        raise RuntimeError("本地发布清单与指定校验值不一致")
    manifest = json.loads((directory / "release-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "tavern-release/v2" or (manifest.get("candidate") and not allow_candidate):
        raise RuntimeError("只允许安装正式 Tavern v2 发布包")
    return manifest, manifest_sha, sums


def installed_artifact(home, name):
    parts = PurePosixPath(name).parts
    roots = {
        "app": Path(home) / "apps/tavern-runtime",
        "ops": Path(home) / "apps/tavern-ops",
        "nora-mcp": Path(home) / "apps/nora-mcp",
    }
    root = roots.get(parts[0])
    return root.joinpath(*parts[1:]) if root else None


def matches(path, expected, expected_mode=None):
    try:
        return (path is not None and path.is_file() and not path.is_symlink()
                and sha(path) == expected
                and (expected_mode is None or path.stat().st_mode & 0o777 == expected_mode))
    except OSError:
        return False


def required_archives(home, manifest):
    native = Path(home, "apps/tavern-runtime/native-runtime.json").is_file()
    modules = manifest.get("modules")
    if not native or not isinstance(modules, dict) or not modules:
        return list(FULL_ARCHIVES), "full"
    artifacts = manifest.get("artifacts") or {}
    modes = manifest.get("artifactModes") or {}
    changed = []
    for module, descriptor in modules.items():
        members = descriptor.get("artifacts") or []
        if not members or any(name not in artifacts or not matches(
                installed_artifact(home, name), artifacts[name], modes.get(name)) for name in members):
            changed.append(module)
    # The runner must always come from the target release, even when the
    # installed updater happens to have the same hash.
    runner = next((name for name, value in modules.items() if "ops/updater/update.py" in value.get("artifacts", [])), None)
    if not runner:
        return list(FULL_ARCHIVES), "full"
    selected = set(changed)
    selected.add(runner)
    return sorted(modules[name]["name"] for name in selected), "incremental"


def verify_archives(directory, names, sums):
    directory = Path(directory)
    for name in names:
        path = directory / name
        if not path.is_file() or sha(path) != sums.get(name):
            raise RuntimeError("发布文件缺失或校验失败：" + name)


def extract_runner(directory, destination, manifest):
    expected = {name: digest for name, digest in manifest["artifacts"].items() if name.startswith("ops/")}
    archive = Path(directory) / "nora-tavern-ops.tar.gz"
    if archive.is_file():
        expected_archive_sha = manifest["archives"]["ops"]["sha256"]
    else:
        descriptor = next((value for value in (manifest.get("modules") or {}).values()
                           if "ops/updater/update.py" in value.get("artifacts", [])), None)
        if not descriptor:
            raise RuntimeError("发布包缺少更新器模块")
        archive = Path(directory) / descriptor["name"]
        expected_archive_sha = descriptor["sha256"]
        expected = {name: manifest["artifacts"][name] for name in descriptor["artifacts"]}
    if not archive.is_file() or sha(archive) != expected_archive_sha:
        raise RuntimeError("更新器压缩包校验失败")
    seen = set()
    with tarfile.open(archive, "r:gz") as package:
        for member in package:
            path = PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or ".." in path.parts or member.name not in expected:
                raise RuntimeError("更新器压缩包包含非法文件")
            data = package.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != expected[member.name]:
                raise RuntimeError("更新器文件校验失败：" + member.name)
            target = destination.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            seen.add(member.name)
    if seen != set(expected):
        raise RuntimeError("更新器压缩包不完整")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", help="旧版同目录部署的安装根")
    parser.add_argument("--install-root")
    parser.add_argument("--hermes-home", dest="hermes_home")
    parser.add_argument("--managed-home", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--tag")
    parser.add_argument("--release-dir", type=Path)
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--target-commit", help=argparse.SUPPRESS)
    parser.add_argument("--repair", action="store_true")
    parser.add_argument("--allow-candidate", action="store_true", help="显式允许本地校验过的测试包")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    if not (args.apply and args.confirm):
        raise RuntimeError("更新命令必须包含 --apply --confirm")
    if args.allow_candidate and not args.release_dir:
        raise RuntimeError("测试包必须通过 --release-dir 明确指定，不从正式发布入口下载")
    if args.data_root and args.install_root and Path(args.data_root).expanduser().resolve() != Path(args.install_root).expanduser().resolve():
        raise RuntimeError("--data-root 与 --install-root 冲突，已停止更新")
    home = args.hermes_home or (args.data_root if not os.environ.get("HERMES_HOME") else None)
    hermes_home, install_root = resolve_update_target(home, args.install_root or args.data_root,
                                                     managed_home=args.managed_home)
    print(f"[tavern-updater] 已确认现有安装：{install_root}", file=sys.stderr, flush=True)
    root = install_root / "tavern-updates"
    root.mkdir(parents=True, exist_ok=True)
    installed = root / "installed.json"
    if args.target_commit and not args.repair and not args.allow_candidate and not args.managed_home and installed.is_file():
        try:
            current = json.loads(installed.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            current = {}
        required_install = (
            install_root / "apps/tavern-runtime/native-runtime.json",
            install_root / "apps/tavern-runtime/engine/sillytavern/server.js",
            install_root / "apps/tavern-ops/updater/update.py",
            install_root / "apps/nora-mcp/dist/server.js",
        )
        if current.get("commit") == args.target_commit and all(path.is_file() for path in required_install):
            print(json.dumps({
                "status": "up-to-date",
                "version": current.get("version"),
                "commit": args.target_commit,
            }, ensure_ascii=False, indent=2))
            return
    with tempfile.TemporaryDirectory(prefix="install-", dir=filesystem_path(root)) as temporary:
        work = Path(temporary)
        bundle = args.release_dir
        if bundle is None:
            bundle = work / "release"
            bundle.mkdir()
            base = (
                f"https://github.com/{REPO}/releases/download/{args.tag}"
                if args.tag else f"https://github.com/{REPO}/releases/latest/download"
            )
            for name in METADATA:
                download(base + "/" + name, bundle / name)
            manifest, manifest_sha, sums = verify_metadata(bundle, args.manifest_sha256)
            archives, mode = required_archives(install_root, manifest)
            for name in archives:
                download(base + "/" + name, bundle / name)
        else:
            manifest, manifest_sha, sums = verify_metadata(bundle, args.manifest_sha256, allow_candidate=args.allow_candidate)
            archives, mode = required_archives(install_root, manifest)
            if all((bundle / name).is_file() for name in FULL_ARCHIVES):
                archives, mode = list(FULL_ARCHIVES), "local"
        verify_archives(bundle, archives, sums)
        print(f"[tavern-updater] 下载模式：{mode}，压缩包 {len(archives)} 个", file=sys.stderr, flush=True)
        runner = work / "runner"
        extract_runner(bundle, runner, manifest)
        command = [
            sys.executable, "-u", "-B", str(runner / "ops/updater/update.py"),
            "--hermes-home", str(hermes_home),
            "--install-root", str(install_root),
            *(["--managed-home", str(args.managed_home.resolve())] if args.managed_home else []),
            "install",
            "--release-dir", str(Path(bundle).resolve()),
            "--manifest-sha256", manifest_sha, "--confirm",
        ]
        if args.allow_candidate:
            command.append("--allow-candidate")
        result = subprocess.run(command)
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("[tavern-updater] 更新失败：" + str(error), file=sys.stderr)
        raise SystemExit(1)
