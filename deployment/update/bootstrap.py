#!/usr/bin/env python3
"""Download one release and hand it to the direct Tavern installer."""
import argparse
import hashlib
import http.client
import json
import ntpath
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import ssl
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
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
    """Bind the desktop adapter to its existing instance; update.py owns rollback."""
    home, root = Path(home).resolve(), Path(root).resolve()
    record_name = "nora-instance.json"
    detail = "nora-instance.json 不是 JSON 对象。"
    try:
        instance = json.loads((home / "nora-instance.json").read_text(encoding="utf-8"))
        if not isinstance(instance, dict):
            raise ValueError("invalid instance object")
        expected = {"noraHome": root, "hermesHome": root / "hermes", "installRoot": root / "tavern"}
        detail = "nora-instance.json 的 schema 无效。"
        if instance.get("schema") != 1:
            raise ValueError("invalid instance schema")
        detail = "Hermes 目录与启动器实例的 hermesHome 绑定不符。"
        if home != expected["hermesHome"]:
            raise ValueError("invalid instance home")
        for name, path in expected.items():
            detail = f"nora-instance.json 缺少 {name} 字段。"
            if name not in instance:
                raise ValueError("missing instance field")
            detail = f"nora-instance.json 的 {name} 路径格式无效。"
            value = Path(instance[name])
            detail = f"nora-instance.json 的 {name} 路径与启动器实例不符或为符号链接。"
            if not value.is_absolute() or value.resolve() != path or path.is_symlink():
                raise ValueError("invalid instance path")
        detail = "nora-instance.json 缺少 port 字段。"
        port = instance["port"]
        detail = "nora-instance.json 的 port 无效。"
        if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
            raise ValueError("invalid port")
        system_path = expected["installRoot"] / "tavern-updates/nora-system.json"
        record_name = "nora-system.json"
        detail = "nora-system.json 为符号链接。"
        if system_path.is_symlink():
            raise ValueError("linked system receipt")
        if system_path.exists():
            system = json.loads(system_path.read_text(encoding="utf-8"))
            detail = "nora-system.json 不是 JSON 对象。"
            if not isinstance(system, dict):
                raise ValueError("invalid system receipt object")
            detail = "nora-system.json 的 schema 无效。"
            if system.get("schema") != 1:
                raise ValueError("invalid system receipt")
        else:
            # Missing acceptance is not authority to invent an installation.
            # The explicit desktop binding and both historical version records
            # must agree; the shared transaction will create NEW acceptance only
            # after real runtime checks and restore absence on failure.
            updates = expected["installRoot"] / "tavern-updates"
            record_name = "installed.json"
            receipt = json.loads((updates / "installed.json").read_text(encoding="utf-8"))
            record_name = "installed-manifest.json"
            manifest = json.loads((updates / "installed-manifest.json").read_text(encoding="utf-8"))
            detail = "installed.json 不是 JSON 对象。"
            if not isinstance(receipt, dict):
                raise ValueError("invalid historical receipt object")
            detail = "installed-manifest.json 不是 JSON 对象。"
            if not isinstance(manifest, dict):
                raise ValueError("invalid historical manifest object")
            detail = "installed.json 的 schema 无效。"
            if receipt.get("schema") not in (1, 2):
                raise ValueError("invalid historical receipt schema")
            detail = "installed-manifest.json 的 schema 无效。"
            if manifest.get("schema") != "tavern-release/v2":
                raise ValueError("invalid historical manifest schema")
            detail = "installed.json 的 commit 格式无效。"
            if not re.fullmatch(r"[a-f0-9]{40}", str(receipt.get("commit", ""))):
                raise ValueError("invalid historical commit")
            detail = "installed.json 的 version 格式无效。"
            if not re.fullmatch(r"\d+\.\d+\.\d+(?:-beta\.\d+)?", str(receipt.get("version", ""))):
                raise ValueError("invalid historical version")
            detail = "installed.json 与 installed-manifest.json 的 commit 不一致。"
            if receipt["commit"] != manifest.get("commit"):
                raise ValueError("historical commits differ")
            detail = "installed-manifest.json 的 versions 字段格式无效。"
            versions = manifest.get("versions", {})
            if not isinstance(versions, dict):
                raise ValueError("invalid historical versions")
            detail = "installed.json 与 installed-manifest.json 的 version 不一致。"
            if receipt["version"] != versions.get("tavern"):
                raise ValueError("historical versions differ")
            instance = {**instance, "missingSystemReceipt": True}
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        if isinstance(error, FileNotFoundError):
            detail = f"缺少 {record_name}。"
        elif isinstance(error, json.JSONDecodeError):
            detail = f"{record_name} 的 JSON 损坏（第 {error.lineno} 行）。"
        elif isinstance(error, UnicodeError):
            detail = f"{record_name} 不是有效的 UTF-8 文本。"
        elif isinstance(error, PermissionError):
            detail = f"无法读取或核对 {record_name}，系统拒绝访问。"
        elif isinstance(error, (IsADirectoryError, NotADirectoryError)):
            detail = f"{record_name} 不是可读取的记录文件。"
        elif isinstance(error, OSError):
            detail = f"读取或核对 {record_name} 时发生文件系统错误。"
        # Only fixed reasons and known record names cross the diagnostic boundary.
        # Suppress raw parser/OS context, which can contain paths or record values.
        raise RuntimeError("无法核对启动器实例记录，已停止更新：" + detail) from None
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


SOURCEFORGE = 'https://downloads.sourceforge.net/project/nora-tavern/'
TAG_PATTERN = r'v\d+\.\d+\.\d+(?:-beta\.\d+)?'
ASSET_PATTERN = r'[A-Za-z0-9][A-Za-z0-9._-]*'


def sourceforge_url(url):
    value = urllib.parse.urlsplit(url)
    return (value.hostname == 'downloads.sourceforge.net'
            or bool(re.fullmatch(r'[a-z0-9-]+\.dl\.sourceforge\.net', value.hostname or '')))


def validate_source(url, original):
    value, initial = urllib.parse.urlsplit(url), urllib.parse.urlsplit(original)
    if (value.scheme != 'https' or value.username or value.password or value.fragment
            or (sourceforge_url(original) and (not sourceforge_url(url)
                or value.port is not None or value.path != initial.path))):
        raise RuntimeError('资源响应偏离受信任来源，未使用下载内容。')


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        validate_source(newurl, request.full_url)
        return super().redirect_request(request, response, code, message, headers, newurl)


def open_source(url, *, timeout=120):
    validate_source(url, url)
    request = urllib.request.Request(url, headers={'User-Agent': 'tavern-updater/4', 'Accept-Encoding': 'identity'})
    return urllib.request.build_opener(ReleaseRedirect()).open(request, timeout=timeout)


def can_switch_source(error):
    if isinstance(error, urllib.error.HTTPError):
        return error.code in (403, 404, 408, 410, 429, 500, 502, 503, 504)
    if isinstance(error, urllib.error.URLError):
        return not isinstance(error.reason, (ssl.SSLCertVerificationError, ssl.CertificateError))
    return isinstance(error, (TimeoutError, ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError))


def select_release(tag=None):
    if tag and not re.fullmatch(TAG_PATTERN, tag):
        raise RuntimeError('发布版本格式无效。')
    urls = [f'https://api.github.com/repos/{REPO}/releases/' + ('tags/'+tag if tag else 'latest'),
            SOURCEFORGE + (tag+'/release.json' if tag else 'channels/stable.json')]
    deadline = time.monotonic()+30
    for index, url in enumerate(urls):
        try:
            with open_source(url, timeout=min(15, max(1, deadline-time.monotonic()))) as response:
                validate_source(response.geturl(), url)
                raw = response.read(1024*1024+1)
            if len(raw) > 1024*1024:
                raise RuntimeError('发布目录超过读取上限。')
            release = json.loads(raw)
            selected = release.get('tag_name', '')
            if (not re.fullmatch(TAG_PATTERN, selected) or release.get('draft') is not False
                    or (tag and selected != tag) or (not tag and release.get('prerelease') is not False)
                    or not isinstance(release.get('assets'), list)):
                raise RuntimeError('发布目录身份无效，未开始更新。')
            assets = {}
            for asset in release['assets']:
                name = asset.get('name', '')
                if (not re.fullmatch(ASSET_PATTERN, name) or name in assets or asset.get('state') != 'uploaded'
                        or not isinstance(asset.get('size'), int) or isinstance(asset['size'], bool) or asset['size'] <= 0
                        or not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest') or '')
                        or asset.get('browser_download_url') != f'https://github.com/{REPO}/releases/download/{selected}/{name}'):
                    raise RuntimeError('发布文件身份或校验信息无效。')
                assets[name] = asset
            return {**release, 'asset_index': assets}
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError) as error:
            if index or not can_switch_source(error):
                raise
            print('[WARN] GitHub版本查询失败，正在使用SourceForge备用源。', file=sys.stderr)
    raise RuntimeError('无法确认发布版本。')


def download(url, target, *, expected_sha256=None, expected_size=None):
    prefix = f'https://github.com/{REPO}/releases/download/'
    relative = url[len(prefix):] if url.startswith(prefix) else ''
    if not re.fullmatch(TAG_PATTERN+'/'+ASSET_PATTERN, relative):
        raise RuntimeError('发布文件地址无效，未下载。')
    urls = [url, SOURCEFORGE+relative]
    target = Path(target)
    temporary = target.with_name(target.name+'.part')
    deadline = time.monotonic()+1800
    try:
        for index, source in enumerate(urls):
            source_deadline = deadline-(300 if not index else 0)
            digest, size = hashlib.sha256(), 0
            try:
                with open_source(source, timeout=min(120, max(1, source_deadline-time.monotonic()))) as response, temporary.open('wb') as output:
                    validate_source(response.geturl(), source)
                    while chunk := response.read(1024*1024):
                        if time.monotonic() >= source_deadline:
                            raise TimeoutError('下载超过等待期限。')
                        size += len(chunk)
                        if expected_size is not None and size > expected_size:
                            raise RuntimeError('下载文件大小校验失败。')
                        digest.update(chunk)
                        output.write(chunk)
                if expected_size is not None and size != expected_size:
                    raise ConnectionError('资源传输中断，文件未下载完整。')
                if expected_sha256 is not None and digest.hexdigest() != expected_sha256:
                    raise RuntimeError('下载文件哈希校验失败。')
                os.replace(temporary, target)
                return
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError) as error:
                if index or not can_switch_source(error):
                    raise
                print('[WARN] GitHub资源传输失败，正在从SourceForge重新下载同一文件。', file=sys.stderr)
    finally:
        temporary.unlink(missing_ok=True)


def download_asset(release, name, target, *, expected_sha256=None):
    asset = release['asset_index'].get(name)
    if not asset or (expected_sha256 and asset['digest'] != 'sha256:'+expected_sha256):
        raise RuntimeError('发布文件缺失或校验信息不一致：'+name)
    download(asset['browser_download_url'], target, expected_sha256=asset['digest'][7:], expected_size=asset['size'])


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
                and (sys.platform == "win32" or expected_mode is None or path.stat().st_mode & 0o777 == expected_mode))
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
    parser.add_argument("--plan", action="store_true", help="Only report required archives for the existing installation")
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
    if args.plan:
        if not args.release_dir:
            raise RuntimeError("更新计划需要已下载的发布清单")
        manifest, _, sums = verify_metadata(args.release_dir, args.manifest_sha256)
        archives, mode = required_archives(install_root, manifest)
        print(json.dumps({"archives": [{"name": name, "sha256": sums[name]} for name in archives],
                          "mode": mode, "version": manifest["versions"]["tavern"]}))
        return
    try:
        import operation_cli as cli
    except ImportError:
        import importlib.util
        cli_path = Path(__file__).resolve().parents[1] / 'installer/operation_cli.py'
        if not cli_path.is_file():
            cli_path = Path(__file__).resolve().parents[1] / 'shared/operation_cli.py'
        spec = importlib.util.spec_from_file_location('nora_bootstrap_operation_cli', cli_path)
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
    cli.ensure_operation('repair' if args.repair else 'update', nora_home=args.managed_home or os.environ.get('NORA_TAVERN_HOME'))
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
            release = select_release(args.tag)
            for name in METADATA:
                download_asset(release, name, bundle / name)
            manifest, manifest_sha, sums = verify_metadata(bundle, args.manifest_sha256)
            if args.target_commit and manifest.get('commit') != args.target_commit:
                raise RuntimeError('发布清单与本次更新目标不一致，未修改安装。')
            archives, mode = required_archives(install_root, manifest)
            for name in archives:
                download_asset(release, name, bundle / name, expected_sha256=sums.get(name))
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
        result = cli._control().managed_run(command)
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("[tavern-updater] 更新失败：" + str(error), file=sys.stderr)
        raise SystemExit(1)
