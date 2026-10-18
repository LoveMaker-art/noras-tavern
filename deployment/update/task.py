#!/usr/bin/env python3
"""Submit/query the same updater used by Nora and the desktop update button."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def installation(home, root=None):
    entry = Path(__file__).with_name('bootstrap.py')
    spec = importlib.util.spec_from_file_location('nora_task_bootstrap', entry)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    home = Path(home).expanduser().resolve()
    marker = home / 'nora-instance.json'
    managed_home = None
    if marker.is_file():
        record = json.loads(marker.read_text(encoding='utf-8'))
        managed_home = Path(record['noraHome']).expanduser()
        module.managed_instance(home, managed_home)
    home, root = module.resolve_update_target(home, root, managed_home=managed_home)
    if managed_home is None:
        managed_home = home
    return home, root, managed_home


def node_for(home):
    explicit = os.environ.get('TAVERN_NODE_EXECUTABLE')
    candidates = ([Path(explicit)] if explicit else []) + [
        home / 'node/node.exe', home / 'node/bin/node',
    ]
    command = shutil.which('node')
    if command:
        candidates.append(Path(command))
    for candidate in candidates:
        if candidate.is_file():
            result = subprocess.run([str(candidate), '-p', 'JSON.stringify({v:process.versions.node,e:!!process.versions.electron})'],
                                    capture_output=True, text=True, timeout=10)
            try:
                value = json.loads(result.stdout)
                if result.returncode == 0 and not value['e'] and int(value['v'].split('.')[0]) >= 22:
                    return str(candidate.absolute())
            except (ValueError, KeyError):
                pass
    raise RuntimeError('未找到可独立执行更新器的 Node 运行环境；未修改现有程序和数据。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    for option in ['apply', 'check', 'status', 'wait', 'recover']:
        mode.add_argument('--' + option, action='store_true')
    parser.add_argument('--confirm', action='store_true')
    parser.add_argument('--hermes-home', default=os.environ.get('HERMES_HOME'))
    parser.add_argument('--install-root')
    parser.add_argument('--port', type=int)
    parser.add_argument('--request-id')
    parser.add_argument('--operation-request-id')
    parser.add_argument('--operation-id')
    parser.add_argument('--snapshot-sequence', type=int)
    parser.add_argument('--release-dir')
    parser.add_argument('--allow-candidate', action='store_true')
    parser.add_argument('--tag')
    parser.add_argument('--manifest-sha256')
    parser.add_argument('--target-manifest-sha256')
    parser.add_argument('--target-commit')
    parser.add_argument('--runner-root', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('--runner-manifest', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if (args.apply or args.recover) and not args.confirm:
        raise RuntimeError('更新和恢复需要明确授权，请使用 --confirm。')
    if args.allow_candidate and not args.release_dir:
        raise RuntimeError('测试版本必须明确指定本地验收目录。')
    home, root, owner = installation(args.hermes_home, args.install_root)
    marker = home / 'nora-instance.json'
    port = json.loads(marker.read_text(encoding='utf-8'))['port'] if marker.is_file() else args.port
    if port is None:
        import yaml
        config = yaml.safe_load((home / 'config.yaml').read_text(encoding='utf-8')) or {}
        from urllib.parse import urlparse
        base = config.get('mcp_servers', {}).get('nora', {}).get('env', {}).get('NORA_MCP_BASE_URL', '')
        port = urlparse(base).port or 8799
    if args.port is not None and args.port != port:
        raise RuntimeError('端口与现有安装配置不一致，未开始更新。')
    ops = args.runner_root.resolve() if args.runner_root else Path(__file__).resolve().parent.parent
    if args.runner_manifest is None and (ops.parent / 'release-manifest.json').is_file():
        args.runner_manifest = ops.parent / 'release-manifest.json'
    entry = ops / 'installer/desktop/updater-task.js'
    if not entry.is_file():
        raise RuntimeError('当前更新器缺少独立任务执行文件，未修改数据。')
    action = 'status' if args.status else 'wait' if args.wait else 'check' if args.check else 'recover' if args.recover else 'update'
    payload = {'action': action, 'noraHome': str(owner), 'hermesHome': str(home), 'installRoot': str(root),
               'port': port, 'python': sys.executable, 'node': node_for(home), 'opsRoot': str(ops),
               'venvHome': sys.prefix, 'managedPythonRoot': sys.base_prefix,
               'channel': os.environ.get('NORA_RELEASE_CHANNEL', 'stable'),
               'hermesInstallDir': os.environ.get('HERMES_INSTALL_DIR', str(home / 'hermes-agent'))}
    if args.allow_candidate:
        payload['allowCandidate'] = True
    for name, value in [('requestId', args.request_id), ('operationRequestId', args.operation_request_id), ('operationId', args.operation_id),
                        ('snapshotSequence', args.snapshot_sequence), ('releaseDir', args.release_dir),
                        ('tag', args.tag), ('manifestPath', str(args.runner_manifest.resolve()) if args.runner_manifest else None)]:
        if value is not None:
            payload[name] = value
    if args.manifest_sha256:
        import hashlib
        if not args.runner_manifest or hashlib.sha256(args.runner_manifest.read_bytes()).hexdigest() != args.manifest_sha256:
            raise RuntimeError('独立更新器清单摘要不匹配，未开始更新。')
        payload['manifestSha256'] = args.manifest_sha256
    if args.target_commit:
        payload['targetCommit'] = args.target_commit
    if args.target_manifest_sha256:
        import re
        if not re.fullmatch(r'[a-f0-9]{64}', args.target_manifest_sha256):
            raise RuntimeError('目标发布清单摘要格式无效，未开始更新。')
        payload['targetManifestSha256'] = args.target_manifest_sha256
    result = subprocess.run([payload['node'], str(entry)], input=json.dumps(payload), text=True, check=False)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(json.dumps({'event': 'error', 'code': 'UPDATER_REQUEST_FAILED', 'message': str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
