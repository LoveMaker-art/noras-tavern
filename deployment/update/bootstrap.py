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
import ssl
import stat
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


def validate_partial_repair(home, root, instance, lifecycle=None):
    """Recheck the desktop's exact partial snapshot in the standalone updater.

    The bootstrap cannot import an unverified bridge or guess an old healthy
    state. Existing records and program identities must still match, and the
    bridge establishes the positive offline proof again before any swap.
    """
    if lifecycle is None:
        raw = os.environ.get('NORA_UPDATE_LIFECYCLE')
        lifecycle = json.loads(raw) if raw else {}
    if not isinstance(lifecycle, dict):
        raise RuntimeError('部分安装修复的启动器上下文无效。')
    snapshot = lifecycle.get('partialRepair')
    if snapshot is None:
        return None
    home, root = Path(home).resolve(), Path(root).resolve()
    nora = root.parent
    expected = {'noraHome': str(nora), 'hermesHome': str(home), 'installRoot': str(root), 'port': instance['port']}
    before = lifecycle.get('before')
    if (home != nora / 'hermes' or root != nora / 'tavern'
            or any(lifecycle.get(name) != value for name, value in expected.items())
            or not isinstance(before, dict)
            or any(before.get(name) is not False for name in ('systemReady', 'running', 'gatewayRunning', 'clawchatConnected'))
            or not isinstance(snapshot, dict)
            or set(snapshot) != {'schema', 'version', 'commit', 'bindings', 'missing', 'programs'}
            or snapshot.get('schema') != 'nora-managed-partial-installation/1'
            or before.get('version') != snapshot.get('version')):
        raise RuntimeError('部分安装修复的原实例或服务状态无法核验，未创建新安装。')
    def linked(path):
        try:
            value = Path(filesystem_path(path)).lstat()
        except FileNotFoundError:
            return False
        return stat.S_ISLNK(value.st_mode) or bool(getattr(value, 'st_file_attributes', 0) & 0x400)
    def reject_links(path):
        path = Path(filesystem_path(path))
        if linked(path):
            raise RuntimeError('部分安装修复包含链接或重定向，已保留现有数据。')
        if path.is_dir():
            for child in path.iterdir(): reject_links(child)
    for directory in (nora, home, root, root / 'tavern-state', root / 'apps', root / 'tavern-updates', home / 'hermes-agent'):
        current = directory
        while current != current.parent:
            if linked(current):
                raise RuntimeError('部分安装修复的实例路径被重定向，已保留现有数据。')
            current = current.parent
    if not (root / 'tavern-state').is_dir():
        raise RuntimeError('部分安装修复缺少原有数据目录，未创建新实例。')
    reject_links(root / 'tavern-state')
    records = {'instance': home / 'nora-instance.json',
               'system': root / 'tavern-updates/nora-system.json',
               'receipt': root / 'tavern-updates/installed.json',
               'manifest': root / 'tavern-updates/installed-manifest.json',
               'config': home / 'config.yaml',
               'runtimeMarker': home / 'hermes-agent/.hermes-bootstrap-complete',
               'nativeConfig': root / 'tavern-state/native-runtime/config.yaml'}
    bindings = snapshot.get('bindings')
    if not isinstance(bindings, dict) or set(bindings) != set(records):
        raise RuntimeError('部分安装修复缺少完整的原记录绑定。')
    objects = {}
    for name, file in records.items():
        reject_links(file)
        io_file = Path(filesystem_path(file))
        if name == 'nativeConfig' and not io_file.exists() and bindings[name] is None:
            continue
        if not io_file.is_file() or io_file.stat().st_size > 4 * 1024 * 1024:
            raise RuntimeError('部分安装修复的原记录已变化：' + file.name)
        raw = io_file.read_bytes()
        if (not re.fullmatch(r'[a-f0-9]{64}', str(bindings[name] or ''))
                or hashlib.sha256(raw).hexdigest() != bindings[name]):
            raise RuntimeError('部分安装修复的原记录已变化：' + file.name)
        if name not in ('config', 'nativeConfig'):
            objects[name] = json.loads(raw)
            if not isinstance(objects[name], dict):
                raise RuntimeError('部分安装修复的原记录无效：' + file.name)
    saved_instance = objects['instance']
    if (type(saved_instance.get('schema')) is not int or saved_instance['schema'] != 1
            or any(saved_instance.get(name) != value for name, value in expected.items())):
        raise RuntimeError('部分安装修复的实例记录与启动器绑定不一致。')
    import yaml
    try:
        config = yaml.safe_load((home / 'config.yaml').read_text(encoding='utf-8'))
        mcp = config['mcp_servers']['nora']
        env = mcp['env']
        expected_env = {
            'NORA_MCP_PROJECT_ROOT': str(root / 'apps/tavern-runtime'),
            'NORA_MCP_ST_ROOT': str(root / 'apps/tavern-runtime/engine/sillytavern'),
            'NORA_MCP_STATE_ROOT': str(root / 'tavern-state'),
            'NORA_MCP_NATIVE_DATA_ROOT': str(root / 'tavern-state/native'),
            'NORA_MCP_USER_DATA_ROOT': str(root / 'tavern-state/native/default-user'),
            'NORA_MCP_CONFIG_PATH': str(root / 'tavern-state/native-runtime/config.yaml'),
            'NORA_MCP_UPLOAD_ROOT': str(root / 'tavern-state/imports'),
            'NORA_MCP_BASE_URL': f"http://127.0.0.1:{instance['port']}",
        }
        if (mcp.get('args') != [str(root / 'apps/nora-mcp/dist/server.js')]
                or any(env.get(name) != value for name, value in expected_env.items())):
            raise ValueError('MCP binding mismatch')
    except (OSError, ValueError, KeyError, TypeError, AttributeError, yaml.YAMLError) as error:
        raise RuntimeError('部分安装修复的原有 MCP 配置绑定不一致。') from error
    receipt, manifest, system, marker = (objects[name] for name in ('receipt', 'manifest', 'system', 'runtimeMarker'))
    version, commit = snapshot.get('version'), snapshot.get('commit')
    if (type(receipt.get('schema')) is not int or receipt['schema'] not in (1, 2)
            or not re.fullmatch(r'\d+\.\d+\.\d+(?:-beta\.\d+)?', str(version or ''))
            or not re.fullmatch(r'[a-f0-9]{40}', str(commit or ''))
            or receipt.get('version') != version or receipt.get('commit') != commit
            or type(system.get('schema')) is not int or system['schema'] != 1
            or system.get('version') != version or system.get('commit') != commit
            or not isinstance(system.get('proof'), dict)
            or any(system['proof'].get(name) is not True for name in
                   ('hermesContext', 'mcpInstanceRead', 'managedConfiguration', 'clawchatRegistration'))
            or manifest.get('schema') != 'tavern-release/v2' or manifest.get('commit') != commit
            or not isinstance(manifest.get('versions'), dict) or manifest['versions'].get('tavern') != version
            or type(marker.get('schema')) is not int or marker['schema'] != 1
            or marker.get('source') != 'nora-integrated-runtime'
            or not re.fullmatch(r'[a-f0-9]{64}', str(marker.get('sha256') or ''))):
        raise RuntimeError('部分安装修复的版本、清单或原运行记录不一致。')
    programs = snapshot.get('programs')
    if not isinstance(programs, dict) or set(programs) != {'app', 'ops', 'nora-mcp'}:
        raise RuntimeError('部分安装修复缺少原程序身份。')
    def tree_digest(directory):
        result = hashlib.sha256()
        def visit(current, relative):
            value = current.lstat()
            if linked(current):
                raise RuntimeError('部分安装修复程序包含链接。')
            if stat.S_ISDIR(value.st_mode):
                result.update(b'D' + relative.encode() + b'\0')
                for child in sorted(current.iterdir(), key=lambda item: item.name): visit(child, relative + '/' + child.name)
            elif stat.S_ISREG(value.st_mode):
                result.update(b'F' + relative.encode() + b'\0')
                with current.open('rb') as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b''): result.update(block)
            else:
                raise RuntimeError('部分安装修复程序目录类型无效。')
        visit(Path(filesystem_path(directory)), '')
        return result.hexdigest()
    for name, directory in (('app', root / 'apps/tavern-runtime'), ('ops', root / 'apps/tavern-ops'), ('nora-mcp', root / 'apps/nora-mcp')):
        reject_links(directory)
        io_directory = Path(filesystem_path(directory))
        actual = None
        if io_directory.exists():
            if not io_directory.is_dir(): raise RuntimeError('部分安装修复程序目录类型无效。')
            value = io_directory.stat()
            actual = {'identity': [str(value.st_dev), str(value.st_ino)], 'digest': tree_digest(io_directory)}
            if value.st_ino <= 0: raise RuntimeError('部分安装修复程序身份无法核验。')
        expected_program = programs[name]
        if expected_program is not None and (not isinstance(expected_program, dict)
                or set(expected_program) != {'identity', 'digest'}
                or not isinstance(expected_program.get('identity'), list) or len(expected_program['identity']) != 2
                or any(not isinstance(item, str) or not re.fullmatch(r'[0-9]+', item)
                       for item in expected_program['identity'])
                or int(expected_program['identity'][1]) <= 0
                or not re.fullmatch(r'[a-f0-9]{64}', str(expected_program.get('digest') or ''))):
            raise RuntimeError('部分安装修复的原程序身份格式无效。')
        if programs[name] != actual:
            raise RuntimeError('部分安装修复的原程序已变化，未覆盖现有文件。')
    python_files = [home / 'hermes-agent/venv' / relative for relative in
                    (('Scripts/python.exe',) if os.name == 'nt' else ('bin/python3', 'bin/python'))]
    for file in python_files:
        # A managed venv may use an interpreter symlink. Its directory binding
        # remains strict; the runtime controller verifies the executable boundary.
        current = file.parent
        while current != home:
            if linked(current): raise RuntimeError('部分安装修复的 Python 路径被重定向。')
            current = current.parent
    native = root / 'apps/tavern-runtime'
    missing = {'nativeRuntime': not (native / 'native-runtime.json').is_file(),
               'nativeLifecycle': not (native / 'native_lifecycle.py').is_file(),
               'python': not any(file.is_file() for file in python_files)}
    if (not isinstance(snapshot.get('missing'), dict) or set(snapshot['missing']) != set(missing)
            or any(type(value) is not bool for value in snapshot['missing'].values())
            or not any(missing.values()) or snapshot['missing'] != missing):
        raise RuntimeError('部分安装修复的程序缺失集合已变化。')
    return snapshot


def resolve_update_target(hermes_home=None, install_root=None, *, managed_home=None, validate_partial=True):
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
    partial = validate_partial_repair(home, root, instance) if instance and validate_partial else None
    if (not partial and not any((app / entry).is_file() for entry in ("native-runtime.json", "server.py", "backend/server.py"))) or not (root / "tavern-state").is_dir():
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
# BEGIN BUILD-OWNED RELEASE SOURCES
RELEASE_SOURCES = json.loads('{"schema":1,"primary":"jihulab","mirrors":[{"id":"jihulab","provider":"jihulab","baseUrl":"https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/","channelBaseUrl":"https://jihulab.com/LoveMaker-art/nora-tavern/-/raw/main/"},{"id":"sourceforge","provider":"sourceforge","baseUrl":"https://downloads.sourceforge.net/project/nora-tavern/"}]}')
# END BUILD-OWNED RELEASE SOURCES


def validate_sources(value):
    """Only the build-owned contract may name a download root."""
    invalid = RuntimeError('资源来源配置无效，未下载或修改安装。')
    if (not isinstance(value, dict) or type(value.get('schema')) is not int or value['schema'] != 1
            or set(value) - {'schema', 'primary', 'mirrors'}
            or not isinstance(value.get('mirrors'), list) or len(value['mirrors']) > 2):
        raise invalid
    ids, origins, mirrors = {'github'}, {'https://github.com', 'https://api.github.com'}, []
    for item in value['mirrors']:
        if (not isinstance(item, dict) or not isinstance(item.get('id'), str)
                or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', item['id']) or item['id'] in ids
                or not isinstance(item.get('baseUrl'), str)
                or set(item) - {'id', 'baseUrl', 'provider', 'channelBaseUrl'}
                or item.get('provider') not in (None, 'sourceforge', 'jihulab')
                or item.get('provider') != 'jihulab' and item.get('channelBaseUrl') is not None):
            raise invalid
        def root_url(raw):
            try:
                parsed = urllib.parse.urlsplit(raw)
                if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                        or parsed.query or parsed.fragment or parsed.port not in (None, 443)
                        or not parsed.path.endswith('/') or '\\' in raw
                        or re.search(r'[\x00-\x20\x7f]', raw)):
                    raise invalid
                return parsed
            except (ValueError, TypeError):
                raise invalid
        root = root_url(item['baseUrl'])
        origin = 'https://' + root.hostname
        if origin in origins:
            raise invalid
        if item.get('provider') == 'sourceforge' and (origin != 'https://downloads.sourceforge.net'
                or not re.fullmatch(r'/project/[a-z0-9][a-z0-9-]{2,29}/', root.path)):
            raise invalid
        if item.get('provider') == 'jihulab':
            identity = re.fullmatch(r'/api/v4/projects/([1-9][0-9]*)/packages/generic/([A-Za-z0-9][A-Za-z0-9._-]{0,254})/', root.path)
            if (origin != 'https://jihulab.com' or item['baseUrl'] != 'https://jihulab.com'+root.path
                    or not identity or int(identity[1]) > 9007199254740991):
                raise invalid
            if not isinstance(item.get('channelBaseUrl'), str):
                raise invalid
            channel = root_url(item['channelBaseUrl'])
            raw = re.fullmatch(r'/((?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}/){2,})-/raw/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/', channel.path)
            if (channel.hostname != 'jihulab.com' or item['channelBaseUrl'] != 'https://jihulab.com'+channel.path
                    or not raw or '..' in raw[2]
                    or re.search(r'(?:\.|\.lock)$', raw[2])):
                raise invalid
        ids.add(item['id'])
        origins.add(origin)
        mirrors.append(item)
    if value.get('primary') is not None and (not isinstance(value['primary'], str) or value['primary'] not in ids):
        raise invalid
    return mirrors


def source_candidates(url, *, channel='stable', sources=None):
    configuration = RELEASE_SOURCES if sources is None else sources
    mirrors = validate_sources(configuration)
    value = urllib.parse.urlsplit(url)
    relative = None
    api = f'/repos/{REPO}/releases'
    if value.scheme == 'https' and value.hostname == 'api.github.com' and not value.fragment:
        if value.path == api+'/latest' and not value.query and channel == 'stable':
            relative = 'channels/stable.json'
        elif value.path == api and value.query == 'per_page=100&page=1' and channel == 'beta':
            relative = 'channels/beta.json'
        elif value.path.startswith(api+'/tags/') and not value.query:
            tag = value.path[len(api+'/tags/'):]
            if re.fullmatch(TAG_PATTERN, tag):
                relative = f'releases/{tag}/release.json'
    elif value.scheme == 'https' and value.hostname == 'github.com' and not value.query and not value.fragment:
        prefix = f'/{REPO}/releases/download/'
        candidate = value.path[len(prefix):] if value.path.startswith(prefix) else ''
        if re.fullmatch(TAG_PATTERN+'/'+ASSET_PATTERN, candidate):
            relative = 'releases/'+candidate
    candidates = []
    if relative:
        for item in mirrors:
            path = relative.removeprefix('releases/') if item.get('provider') in ('sourceforge', 'jihulab') else relative
            root = item['channelBaseUrl'] if item.get('provider') == 'jihulab' and relative.startswith('channels/') else item['baseUrl']
            candidates.append((item['id'], root+path))
    candidates.append(('github', url))
    primary = configuration.get('primary')
    return [candidate for _, candidate in sorted(candidates, key=lambda item: (item[0] != primary, item[0] != 'github'))] if primary else [candidate for _, candidate in candidates]


def sourceforge_url(url):
    value = urllib.parse.urlsplit(url)
    return (value.hostname == 'downloads.sourceforge.net'
            or bool(re.fullmatch(r'[a-z0-9-]+\.dl\.sourceforge\.net', value.hostname or '')))


def validate_source(url, original):
    value, initial = urllib.parse.urlsplit(url), urllib.parse.urlsplit(original)
    github_assets = {'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'}
    trusted = False
    api = f'/repos/{REPO}/releases'
    if initial.hostname == 'api.github.com' and (initial.path in (api, api+'/latest')
            or initial.path.startswith(api+'/tags/') and re.fullmatch(TAG_PATTERN, initial.path[len(api+'/tags/'):])):
        trusted = value.hostname == initial.hostname and value.path == initial.path and value.query == initial.query
    elif initial.hostname in github_assets:
        prefix = f'/{REPO}/releases/download/'
        valid_initial = initial.hostname != 'github.com' or (initial.path.startswith(prefix)
            and re.fullmatch(TAG_PATTERN+'/'+ASSET_PATTERN, initial.path[len(prefix):]) and not initial.query)
        trusted = valid_initial and value.hostname in github_assets and (value.hostname != 'github.com' or value.path == initial.path)
    else:
        for item in validate_sources(RELEASE_SOURCES):
            roots = [item['baseUrl']] + ([item['channelBaseUrl']] if item.get('provider') == 'jihulab' else [])
            for root in roots:
                parsed = urllib.parse.urlsplit(root)
                match = initial.hostname == parsed.hostname or item.get('provider') == 'sourceforge' and sourceforge_url(original)
                if match and initial.path.startswith(parsed.path):
                    permitted = (sourceforge_url(url) and value.port is None) if item.get('provider') == 'sourceforge' else value.hostname == parsed.hostname
                    trusted = permitted and value.path == initial.path
                    if item.get('provider') != 'sourceforge':
                        trusted = trusted and value.query == initial.query and not initial.query
    if (not trusted or initial.scheme != 'https' or initial.username or initial.password or initial.fragment
            or value.scheme != 'https' or value.username or value.password or value.fragment
            or initial.port not in (None, 443) or value.port not in (None, 443)):
        raise RuntimeError('资源响应偏离受信任来源，未使用下载内容。')

TAG_PATTERN = r'v\d+\.\d+\.\d+(?:-beta\.\d+)?'
ASSET_PATTERN = r'[A-Za-z0-9][A-Za-z0-9._-]*'
ASSET_INDEX_NAME = 'release-assets.json'
CURRENT_ASSET_PATTERN = (r'(?:release-assets\.json|release-manifest\.json|[A-Za-z0-9][A-Za-z0-9._-]*-(?:release-manifest[A-Za-z0-9._-]*\.json|SHA256SUMS|first-install-manifest\.json|nora-tavern-first-install-bootstrap\.py|tavern-updater-bootstrap\.py)|SHA256SUMS|LAUNCHER-SHA256SUMS|bootstrap-manifest\.json|'
                         r'tavern-updater-bootstrap\.py|nora-(?:system|launcher)-[A-Za-z0-9._-]*\.json|Nora-Tavern-Launcher-[A-Za-z0-9._-]*|'
                         r'first-install-manifest\.json|nora-tavern-first-install-bootstrap\.py|install-nora-tavern\.(?:sh|ps1)|install-tavern-updater\.sh)')


def release_version_key(value):
    match = re.fullmatch(r'v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?', value or '')
    if not match:
        raise RuntimeError('共享资产版本格式无效。')
    major, minor, patch, beta = match.groups()
    return (int(major), int(minor), int(patch), 1 if beta is None else 0, int(beta or 0))


def validate_asset_index(index, tag):
    if (not isinstance(index, dict) or index.get('schema') != 'nora-release-assets/1'
            or index.get('repository') != REPO or index.get('tag') != tag
            or not re.fullmatch(TAG_PATTERN, tag or '') or not re.fullmatch(r'[a-f0-9]{40}', index.get('commit') or '')
            or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', index.get('minimumLauncherVersion') or '')
            or release_version_key(index['minimumLauncherVersion']) <= release_version_key('2.1.1')
            or not isinstance(index.get('assets'), list) or len(index['assets']) > 256):
        raise RuntimeError('共享资产索引身份或兼容门槛无效。')
    names = set()
    for item in index['assets']:
        if (not isinstance(item, dict) or not re.fullmatch(ASSET_PATTERN, item.get('name') or '')
                or item['name'] in names or re.fullmatch(CURRENT_ASSET_PATTERN, item['name'])
                or not re.fullmatch(r'v\d+\.\d+\.\d+', item.get('asset_release_tag') or '')
                or release_version_key(item['asset_release_tag']) >= release_version_key(tag)
                or not re.fullmatch(r'[a-f0-9]{64}', item.get('sha256') or '')
                or not isinstance(item.get('size'), int) or isinstance(item['size'], bool) or not 0 < item['size'] <= 2*1024**3
                or set(item) != {'name', 'asset_release_tag', 'size', 'sha256'}):
            raise RuntimeError('共享资产引用缺失、冲突或超出可信范围。')
        names.add(item['name'])
    return index


def expand_asset_index(release, assets):
    descriptor = assets.get(ASSET_INDEX_NAME)
    if descriptor is None:
        return None
    if descriptor['size'] > 64*1024:
        raise RuntimeError('共享资产索引超过读取上限。')
    tag = release['tag_name']
    urls = source_candidates(descriptor['browser_download_url'])
    for position, url in enumerate(urls):
        try:
            with open_source(url, timeout=30) as response:
                validate_source(response.geturl(), url)
                raw = response.read(64*1024+1)
            if len(raw) != descriptor['size'] or hashlib.sha256(raw).hexdigest() != descriptor['digest'][7:]:
                raise RuntimeError('共享资产索引与当前发布校验信息不一致。')
            index = validate_asset_index(json.loads(raw), tag)
            break
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError) as error:
            if position == len(urls)-1 or not can_switch_source(error):
                raise
            print('[WARN] 当前来源的共享资产索引请求失败，正在使用下一受信来源。', file=sys.stderr)
    for item in index['assets']:
        if item['name'] in assets:
            raise RuntimeError('共享引用与当前发布资产同名。')
        assets[item['name']] = {'name': item['name'], 'state': 'uploaded', 'size': item['size'],
                               'digest': 'sha256:'+item['sha256'], 'asset_release_tag': item['asset_release_tag'],
                               'browser_download_url': f"https://github.com/{REPO}/releases/download/{item['asset_release_tag']}/{item['name']}"}
    return index


def validate_shared_manifest(release, manifest):
    index = release.get('shared_assets')
    if index is None:
        return
    minimum = manifest.get('bootstrap', {}).get('minimumLauncherVersion')
    if (manifest.get('commit') != index['commit'] or manifest.get('versions', {}).get('tavern') != index['tag'][1:]
            or release_version_key(minimum) < release_version_key(index['minimumLauncherVersion'])):
        raise RuntimeError('共享资产与目标发布提交或客户端兼容门槛不一致。')
    for descriptor in [*manifest.get('archives', {}).values(), *manifest.get('modules', {}).values()]:
        asset = release['asset_index'].get(descriptor.get('name'))
        if asset and asset.get('asset_release_tag') and (asset['digest'] != 'sha256:'+str(descriptor.get('sha256'))
                or not isinstance(descriptor.get('size'), int) or isinstance(descriptor['size'], bool)
                or descriptor['size'] != asset['size']):
            raise RuntimeError('共享资产引用与组件校验信息不一致。')


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
    urls = source_candidates(f'https://api.github.com/repos/{REPO}/releases/' + ('tags/'+tag if tag else 'latest'))
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
                        or 'asset_release_tag' in asset
                        or not isinstance(asset.get('size'), int) or isinstance(asset['size'], bool) or asset['size'] <= 0
                        or not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest') or '')
                        or asset.get('browser_download_url') != f'https://github.com/{REPO}/releases/download/{selected}/{name}'):
                    raise RuntimeError('发布文件身份或校验信息无效。')
                assets[name] = asset
            index = expand_asset_index(release, assets)
            return {**release, 'asset_index': assets, **({'shared_assets': index} if index is not None else {})}
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError) as error:
            if index == len(urls)-1 or not can_switch_source(error):
                raise
            print('[WARN] 当前来源的版本查询失败，正在使用下一受信来源。', file=sys.stderr)
    raise RuntimeError('无法确认发布版本。')


def download(url, target, *, expected_sha256=None, expected_size=None):
    prefix = f'https://github.com/{REPO}/releases/download/'
    relative = url[len(prefix):] if url.startswith(prefix) else ''
    if not re.fullmatch(TAG_PATTERN+'/'+ASSET_PATTERN, relative):
        raise RuntimeError('发布文件地址无效，未下载。')
    urls = source_candidates(url)
    target = Path(target)
    temporary = target.with_name(target.name+'.part')
    deadline = time.monotonic()+1800
    try:
        for index, source in enumerate(urls):
            source_deadline = deadline-300*(len(urls)-index-1)
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
                if index == len(urls)-1 or not can_switch_source(error):
                    raise
                print('[WARN] 当前来源的资源传输失败，正在从下一受信来源重新下载同一文件。', file=sys.stderr)
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
            validate_shared_manifest(release, manifest)
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
