"""Forward independent maintenance to the installed APP's operation owner.

The receipt proves local file coherence, not an author's digital signature.
Original arguments and stdin are transient; this module never writes them to a
receipt, operation record or log, and never continues the original writer.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

RESOURCE_NAMES = ('launcher_bridge.py', 'first_install.py', 'nora_system.py', 'nora_profile.py',
    'launcher_services.py', 'model_config.py', 'bootstrap.py', 'update_recovery.py', 'update_paths.py',
    'error_diagnostics.py', 'operation_control.py', 'operation_cli.py', 'operation_evidence.py', 'operation_node.mjs', 'mcp_probe.mjs', 'operation-delegate.js', 'operation-budget.json', 'replace-launcher.py')
MANAGED = {'ops/updater/bootstrap.py': 'bootstrap', 'ops/updater/update.py': 'update', 'ops/installer/nora_system.py': 'system'}
KINDS = {'install', 'update', 'repair', 'start', 'stop', 'restart', 'pair', 'recover'}


class OperationCliError(RuntimeError):
    def __init__(self, code='OPERATION_CAPABILITY_INVALID'):
        super().__init__('无法核验已安装的新版启动器，未修改安装和数据。请保留诺拉数据，只重新安装最新版启动器。')
        self.code = code


def _control():
    name = '_nora_cli_operation_control'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name('operation_control.py'))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def _safe(file, *, directory=False, private=False, allow_root=False):
    value = Path(file)
    if not value.is_absolute():
        raise OperationCliError()
    for item in (value, *value.parents):
        if item.is_symlink():
            raise OperationCliError()
    if not (value.is_dir() if directory else value.is_file()):
        raise OperationCliError()
    if private and sys.platform != 'win32':
        stat = value.stat()
        if (stat.st_uid != os.getuid() and not (allow_root and stat.st_uid == 0)) or stat.st_mode & 0o022:
            raise OperationCliError()
    return value


def _same(left, right):
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def _hash(file):
    digest = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _descriptor(item):
    if not isinstance(item, dict) or not isinstance(item.get('size'), int) or item['size'] < 1:
        raise OperationCliError()
    file = _safe(item['path'], private=True, allow_root=True)
    before = file.stat()
    digest = _hash(file)
    after = file.stat()
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise OperationCliError()
    if after.st_size != item['size'] or digest != item.get('sha256'):
        raise OperationCliError()


def validate_receipt(nora_home):
    try:
        home = _safe(Path(nora_home).expanduser().resolve(), directory=True, private=True)
        directory = _safe(home / 'installer', directory=True, private=True)
        file = _safe(directory / 'launcher-control.json', private=True)
        if file.stat().st_size > 128 * 1024:
            raise OperationCliError()
        value = json.loads(file.read_text(encoding='utf-8'))
        # The forwarding Python may have another architecture (e.g. Rosetta).
        # The APP validates its own actual process.arch again before any write.
        arch = value.get('arch')
        if value.get('schema') != 'nora-launcher-control/1' or value.get('capabilityVersion') != 1 \
            or value.get('executorProtocol') != 'nora-operation-executor/1' or value.get('operationSchema') != 'nora-operation/1' \
            or value.get('telemetrySchema') != 3 or value.get('faultSchema') != 2 \
            or value.get('platform') != sys.platform \
            or f'{sys.platform}-{arch}' not in {'win32-x64', 'darwin-x64', 'darwin-arm64'} \
            or not _same(value['noraHome'], home) or not _same(value['installerDirectory'], directory) \
            or value.get('channel') not in {'stable', 'beta'} or type(value.get('port')) is not int or not 1024 <= value['port'] <= 65535:
            raise OperationCliError()
        for name in ('hermesHome', 'installRoot'):
            target = Path(value[name])
            if not target.is_absolute() or home not in target.parents:
                raise OperationCliError()
            if target.exists():
                _safe(target, directory=True, private=True)
            else:
                for part in target.parents:
                    if part.exists():
                        _safe(part, directory=True, private=True)
                        break
        executable = Path(value['executable']['path'])
        resources = executable.parent.parent / 'Resources' if sys.platform == 'darwin' else executable.parent / 'resources'
        if not _same(resources, value['resourcesRoot']) or not _same(resources / 'app.asar', value['asar']['path']) \
            or not _same(resources / 'app.asar/operation-cli.js', value['entry']) \
            or not _same(resources / f'app.asar.unpacked/node_modules/fs-native-extensions/prebuilds/{sys.platform}-{arch}/fs-native-extensions.node', value['native']['path']):
            raise OperationCliError()
        if set(value['resources']) != set(RESOURCE_NAMES):
            raise OperationCliError()
        for name in RESOURCE_NAMES:
            if not _same(resources / name, value['resources'][name]['path']):
                raise OperationCliError()
        source = [value['asar']['sha256'], value['native']['sha256'], [[name, value['resources'][name]['sha256']] for name in RESOURCE_NAMES]]
        if hashlib.sha256(json.dumps(source, separators=(',', ':')).encode()).hexdigest() != value['sourceHash']:
            raise OperationCliError()
        items = [value['executable'], value['asar'], value['native'], *value['resources'].values(), *value.get('managed', {}).values()]
        if value.get('installedManifest'):
            items += [value['installedManifest'], value['installedReceipt']]
            install = Path(value.get('installRoot', home / 'tavern'))
            if not _same(value['installedManifest']['path'], install / 'tavern-updates/installed-manifest.json') \
                or not _same(value['installedReceipt']['path'], install / 'tavern-updates/installed.json'):
                raise OperationCliError()
            manifest = json.loads(Path(value['installedManifest']['path']).read_text(encoding='utf-8'))
            installed = json.loads(Path(value['installedReceipt']['path']).read_text(encoding='utf-8'))
            if manifest.get('schema') != 'tavern-release/v2' or not manifest.get('commit') or manifest['commit'] != installed.get('commit') \
                or manifest.get('versions', {}).get('tavern') != installed.get('version'):
                raise OperationCliError()
            for name, item in value.get('managed', {}).items():
                if name not in MANAGED or not _same(item['path'], install / 'apps/tavern-ops' / name.removeprefix('ops/')) \
                    or manifest.get('artifacts', {}).get(name) != item['sha256']:
                    raise OperationCliError()
        elif value.get('managed'):
            raise OperationCliError()
        for item in items:
            _descriptor(item)
        return value
    except (OSError, KeyError, TypeError, ValueError, AttributeError) as error:
        raise OperationCliError() from error


def authorize_target(receipt, script):
    if not isinstance(script, str) or not Path(script).is_absolute():
        raise OperationCliError('OPERATION_ENTRY_UNSUPPORTED')
    for name, kind in (('launcher_bridge.py', 'bridge'), ('first_install.py', 'install'), ('bootstrap.py', 'install-bootstrap')):
        if _same(script, receipt['resources'][name]['path']):
            return kind
    for name, item in receipt.get('managed', {}).items():
        if name in MANAGED and _same(script, item['path']):
            return MANAGED[name]
    raise OperationCliError('OPERATION_ENTRY_UNSUPPORTED')


def ensure_operation(kind, argv=None, *, nora_home=None, stdin=None, operation_id=None, snapshot_sequence=None):
    if getattr(sys, '_nora_operation_delegate', None) is not None or any(name.startswith('NORA_OPERATION_') for name in os.environ):
        # A lost existing guard is a failure, never permission to start another.
        return _control().require_operation()
    if kind not in KINDS:
        raise OperationCliError('OPERATION_ENTRY_UNSUPPORTED')
    argv = list(sys.argv if argv is None else argv)
    if not argv or len(argv) > 128 or any(not isinstance(arg, str) or len(arg) > 8192 for arg in argv):
        raise OperationCliError('OPERATION_ENTRY_UNSUPPORTED')
    if stdin is None:
        stdin = b'' if sys.stdin.isatty() else sys.stdin.buffer.read(1024 * 1024 + 1)
    if isinstance(stdin, str):
        stdin = stdin.encode('utf-8')
    if not isinstance(stdin, bytes) or len(stdin) > 1024 * 1024:
        raise OperationCliError('OPERATION_ENTRY_UNSUPPORTED')
    if nora_home is None:
        raise OperationCliError('OPERATION_CAPABILITY_REQUIRED')
    receipt = validate_receipt(nora_home)
    authorize_target(receipt, argv[0])
    request = {'schema': 'nora-cli-request/1', 'kind': kind, 'argv': argv,
               'stdin': base64.b64encode(stdin).decode('ascii')}
    if operation_id is not None:
        import re
        if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', operation_id, re.I) \
            or type(snapshot_sequence) is not int or snapshot_sequence < 1:
            raise OperationCliError('OPERATION_ENTRY_UNSUPPORTED')
        request.update(operationId=operation_id, snapshotSequence=snapshot_sequence)
    environment = {name: value for name, value in os.environ.items()
                   if not name.startswith('NORA_OPERATION_') and name not in {'NODE_OPTIONS', 'NODE_PATH', 'NORA_UPDATE_LIFECYCLE'}}
    environment['ELECTRON_RUN_AS_NODE'] = '1'
    result = subprocess.run([receipt['executable']['path'], receipt['entry'], '--receipt',
        str(Path(receipt['noraHome']) / 'installer/launcher-control.json')],
        input=json.dumps(request, separators=(',', ':')).encode('utf-8'), env=environment, check=False)
    raise SystemExit(result.returncode)
