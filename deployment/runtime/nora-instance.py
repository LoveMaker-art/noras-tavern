"""Resolve and operate the explicitly configured Nora instance on its host."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlparse


def query_configuration(home):
    """Find only the operation reader, even when Hermes dependencies are broken."""
    home = Path(home).resolve()
    file = home / 'nora-instance.json'
    if not file.exists():
        return {'hermesHome': str(home), 'noraHome': str(home),
                'installRoot': str(Path(os.environ.get('TAVERN_DATA_ROOT') or home)), 'desktopManaged': False}
    record = json.loads(file.read_text(encoding='utf-8'))
    if not isinstance(record, dict) or record.get('schema') != 1:
        raise RuntimeError('Invalid Nora instance configuration')
    for name in ('hermesHome', 'noraHome', 'installRoot'):
        value = record.get(name)
        if not isinstance(value, str) or not Path(value).is_absolute() or Path(value) == Path(Path(value).anchor):
            raise RuntimeError('Invalid Nora instance configuration')
    if Path(record['hermesHome']).resolve() != home:
        raise RuntimeError('Invalid Nora instance configuration')
    return {**record, 'desktopManaged': record.get('deployment', 'desktop') == 'desktop'}


def configuration(home):
    """Read one binding without moving data or requiring a desktop layout.

    nora_tavern describes explicit nonstandard paths. Existing MCP configuration
    and schema-1 instance records remain valid inputs; disagreement is an error.
    A legacy desktop record retains its service owner. New core records declare
    deployment=core rather than borrowing desktop ownership.
    """
    home = Path(home).resolve()
    def absolute(value, label):
        if not isinstance(value, str) or not Path(value).expanduser().is_absolute():
            raise RuntimeError(label + ' 必须是明确的绝对路径。')
        result = Path(value).expanduser().resolve()
        if result == Path(result.anchor):
            raise RuntimeError(label + ' 不能是文件系统根目录。')
        return result

    import yaml
    file = home / 'config.yaml'
    config = yaml.safe_load(file.read_text(encoding='utf-8')) if file.is_file() else {}
    if not isinstance(config, dict):
        raise RuntimeError('Hermes 配置不是对象，未修改实例。')
    declared = config.get('nora_tavern') or {}
    mcp = ((config.get('mcp_servers') or {}).get('nora') or {}).get('env') or {}
    if not isinstance(declared, dict) or not isinstance(mcp, dict):
        raise RuntimeError('实例路径配置不是对象，未修改实例。')
    record_file = home / 'nora-instance.json'
    record = json.loads(record_file.read_text(encoding='utf-8')) if record_file.is_file() else {}
    if record_file.exists() and (not isinstance(record, dict) or record.get('schema') != 1
            or absolute(record.get('hermesHome'), 'hermesHome') != home
            or record.get('deployment', 'desktop') not in ('core', 'desktop')):
        raise RuntimeError('Invalid Nora instance configuration')
    roots = {}
    def add(label, value):
        if value is not None:
            roots[label] = absolute(value, label)
    add('instance.installRoot', record.get('installRoot'))
    add('nora_tavern.installRoot', declared.get('installRoot'))
    project = mcp.get('NORA_MCP_PROJECT_ROOT')
    if project:
        app = absolute(project, 'NORA_MCP_PROJECT_ROOT')
        if app.name == 'tavern-runtime' and app.parent.name == 'apps':
            add('MCP.installRoot', str(app.parent.parent))
    if not roots and os.environ.get('TAVERN_DATA_ROOT'):
        add('TAVERN_DATA_ROOT', os.environ['TAVERN_DATA_ROOT'])
    state_value = declared.get('stateRoot') or mcp.get('NORA_MCP_STATE_ROOT')
    if not roots and state_value and Path(state_value).name == 'tavern-state':
        add('MCP.stateParent', str(absolute(state_value, 'stateRoot').parent))
    if not roots:
        raise RuntimeError('缺少当前实例 installRoot；请核对已有 MCP 或 nora_tavern 路径配置。')
    if len(set(roots.values())) != 1:
        raise RuntimeError('实例程序目录冲突，未修改任何文件：' + ', '.join(roots))
    root = next(iter(roots.values()))
    state = absolute(str(state_value or root / 'tavern-state'), 'stateRoot')
    if (state in (root, home) or root.is_relative_to(state) or home.is_relative_to(state)
            or any(state.is_relative_to(directory) for directory in
                   (root/'apps',home/'skills',home/'scripts',home/'hooks',home/'plugins'))):
        raise RuntimeError('数据目录与受管程序重叠；请将 stateRoot 指向独立的数据目录，原文件未移动。')
    if declared.get('stateRoot') and mcp.get('NORA_MCP_STATE_ROOT') and state != absolute(mcp['NORA_MCP_STATE_ROOT'], 'MCP.stateRoot'):
        raise RuntimeError('实例数据目录冲突，未修改任何文件。')
    app = absolute(str(declared.get('appRoot') or project or root / 'apps/tavern-runtime'), 'appRoot')
    if declared.get('appRoot') and project and app != absolute(project, 'MCP.appRoot'):
        raise RuntimeError('实例程序入口冲突，未修改任何文件。')
    ports = []
    if 'port' in record:
        ports.append(record['port'])
    if 'port' in declared:
        ports.append(declared['port'])
    if mcp.get('NORA_MCP_BASE_URL'):
        url = urlparse(mcp['NORA_MCP_BASE_URL'])
        if (url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1')
                or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment):
            raise RuntimeError('MCP 必须绑定当前主机明确的酒馆端口。')
        ports.append(url.port)
    if not ports or any(type(port) is not int or not 1024 <= port <= 65535 for port in ports) or len(set(ports)) != 1:
        raise RuntimeError('实例端口缺失或冲突，未修改任何文件。')
    desktop = bool(record) and record.get('deployment', 'desktop') == 'desktop'
    owner = absolute(record.get('noraHome', str(home)), 'noraHome')
    if record and os.environ.get('NORA_TAVERN_HOME') and owner != absolute(os.environ['NORA_TAVERN_HOME'], 'NORA_TAVERN_HOME'):
        raise RuntimeError('实例操作目录冲突，未修改任何文件。')
    result = {**record, 'schema': 1 if record else 0, 'noraHome': str(owner), 'hermesHome': str(home),
              'installRoot': str(root), 'stateRoot': str(state), 'appRoot': str(app),
              'port': ports[0], 'desktopManaged': desktop,
              'serviceOwner': 'desktop' if desktop else declared.get('serviceOwner', 'external')}
    for key in ('hermesInstallDir', 'python'):
        value = declared.get(key) or record.get(key)
        if value:
            result[key] = str(absolute(value, key))
    return result


def existing_configuration(home):
    """No binding is distinct from a present, invalid/conflicting binding."""
    import yaml
    home = Path(home)
    config = yaml.safe_load((home/'config.yaml').read_text(encoding='utf-8')) if (home/'config.yaml').is_file() else {}
    if not (home/'nora-instance.json').exists() and not (isinstance(config,dict) and (
            config.get('nora_tavern') or (config.get('mcp_servers') or {}).get('nora',{}).get('env'))):
        return None
    return configuration(home)


def verify_hermes_python(home, binding):
    """Verify loaded Hermes code/config, not a venv's directory spelling."""
    import hermes_cli
    from hermes_constants import get_hermes_home
    actual = Path(hermes_cli.__file__).resolve().parent.parent
    requested = binding.get('hermesInstallDir') or os.environ.get('HERMES_INSTALL_DIR')
    legacy = Path(home) / 'hermes-agent'
    if not requested and legacy.is_dir():
        requested = str(legacy)
    if requested and Path(requested).resolve() != actual:
        raise RuntimeError('Hermes Python 加载的程序与本实例绑定不一致。')
    # Native config.get_config_path is get_hermes_home()/config.yaml. Loading
    # the complete config module just to locate it can initialize native home
    # directories; identity verification itself must remain read-only.
    if Path(get_hermes_home()).resolve() != Path(home).resolve():
        raise RuntimeError('Hermes Python 加载的配置不属于本实例。')
    if binding.get('python') and Path(binding['python']).resolve() != Path(sys.executable).resolve():
        raise RuntimeError('请使用实例明确配置的 Hermes Python。')
    return {**binding, 'hermesInstallDir': str(actual), 'python': str(Path(sys.executable).absolute())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("check", "status", "start", "stop", "recover-existing", "app-link"))
    args = parser.parse_args()
    home = Path(os.environ.get("HERMES_HOME", Path(__file__).resolve().parents[1])).resolve()
    config = configuration(home)
    root, port = Path(config["installRoot"]), config["port"]
    if args.operation == "check":
        print(json.dumps({"ok": True, "port": port}))
        return 0
    env = {**os.environ, "HERMES_HOME": str(home), "TAVERN_DATA_ROOT": str(root),
           "TAVERN_STATE_DIR": config['stateRoot'], "TAVERN_APP_DIR": config['appRoot']}
    if args.operation == "app-link":
        import importlib.util
        script = root / "apps/tavern-ops/updater/liveware_integration.py"
        spec = importlib.util.spec_from_file_location("nora_entry", script)
        integration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(integration)
        entry = integration.verified_entry(root, port, hermes_home=home)
        if entry.get("status") != "ready":
            print(json.dumps(entry, ensure_ascii=False))
            return 1
        print(entry["url"])
        return 0
    if args.operation == "recover-existing":
        # The shared registration worker owns retries and App identity, not greetings.
        script = root / "apps/tavern-ops/updater/liveware_integration.py"
        command = [str(script), "--home", str(root), "--hermes-home", str(home),
                   "--port", str(port)]
        if config['desktopManaged']:
            command.append("--no-start-runtime")
        command.append("startup")
    else:
        command = [str(Path(config['appRoot']) / 'native_lifecycle.py'), args.operation]
        if args.operation != "stop":
            command += ["--port", str(port)]
    return subprocess.run([sys.executable, "-B", *command], env=env, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
