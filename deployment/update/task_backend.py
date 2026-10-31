#!/usr/bin/env python3
"""Read and adapt a standalone Tavern through the existing updater transaction."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def updater():
    return module('nora_task_standalone_updater', HERE / 'update.py')


def failure(message, code='VERIFICATION_FAILED'):
    error = RuntimeError(message)
    error.code = code
    return error


def read(file):
    file = Path(file)
    for part in (file, *file.parents):
        if part.is_symlink():
            raise failure('独立更新目录包含链接，未修改现有安装。')
    value = json.loads(file.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise failure('独立更新记录不是对象，现有文件已保留。')
    return value


def roots(args, update):
    binding = update.instance_paths(args.hermes_home)
    if (Path(args.hermes_home) / 'nora-instance.json').exists() and (not binding or binding['desktopManaged']):
        raise failure('受管实例必须使用原系统后端，未切换为独立更新。')
    home, root = update.resolve_update_target(args.hermes_home, args.install_root)
    nora = Path(args.nora_home).expanduser().absolute()
    if not nora.is_absolute() or nora == Path(nora.anchor) or any(part.is_symlink() for part in (nora, *nora.parents)):
        raise failure('更新任务所属目录无法核验。')
    port = update.standalone_port(home, root)
    if port != args.port:
        raise failure('任务端口与原酒馆配置不一致，未修改安装。', 'CONDITIONS_CHANGED')
    return home, root, nora


def installed_identity(update, root, *, verify_contents=True):
    directory = root / 'tavern-updates'
    receipt = read(directory / 'installed.json')
    manifest_file = directory / 'installed-manifest.json'
    manifest = read(manifest_file)
    if (receipt.get('schema') not in (1, 2) or manifest.get('schema') != 'tavern-release/v2'
            or not re.fullmatch(r'[a-f0-9]{40}', str(receipt.get('commit', '')))
            or receipt['commit'] != manifest.get('commit')
            or not re.fullmatch(r'\d+\.\d+\.\d+(?:-beta\.\d+)?', str(receipt.get('version', '')))
            or receipt['version'] != manifest.get('versions', {}).get('tavern')
            or receipt.get('releaseManifestSha256') is not None
            and receipt['releaseManifestSha256'] != update.file_sha(manifest_file)):
        raise failure('已安装版本收据与发布清单不一致，现有数据和备份已保留。')
    artifacts = manifest.get('artifacts')
    if not isinstance(artifacts, dict) or not artifacts:
        raise failure('已安装程序缺少可核验文件清单。')
    mapping = {'app': root / 'apps/tavern-runtime', 'ops': root / 'apps/tavern-ops', 'nora-mcp': root / 'apps/nora-mcp'}
    for name, digest in artifacts.items():
        relative = PurePosixPath(name)
        if (not isinstance(name, str) or relative.is_absolute() or '..' in relative.parts
                or len(relative.parts) < 2 or relative.parts[0] not in mapping
                or not re.fullmatch(r'[a-f0-9]{64}', str(digest))):
            raise failure('已安装程序清单路径无效。')
        file = mapping[relative.parts[0]].joinpath(*relative.parts[1:])
        if any(part.is_symlink() for part in (file, *file.parents)):
            raise failure('已安装程序目录包含链接，未修改现有安装：' + name)
        if verify_contents and (not file.is_file() or update.file_sha(file) != digest):
            raise failure('已安装程序文件与发布清单不一致：' + name)
    return receipt, manifest


def world_read(update, root, home=None):
    app, state = root / 'apps/tavern-runtime', update.bound_state_root(home, root)
    if getattr(sys, '_nora_operation_delegate', None) is not None:
        return update.verify_worlds(app, state)
    native = state / 'native'
    if not native.is_dir():
        return {}
    node = os.environ.get('TAVERN_NODE_EXECUTABLE') or shutil.which('node')
    if not node:
        raise failure('未找到现有 Node.js，无法读取原有世界。', 'RESOURCE_INCOMPLETE')
    # The existing verifier replaces writes with an explicit denial. This is
    # the same bounded read-only program, never an independent maintenance run.
    result = subprocess.run([str(node), str(HERE / 'verify-worlds.mjs'), str(app), str(native)],
        capture_output=True, text=True, timeout=120, check=True)
    return json.loads(result.stdout)


def status(args, update, *, verify=True):
    home, root, nora = roots(args, update)
    # Admission proves ownership without requiring bytes that this transaction
    # is about to repair. Final/current/recovery verification remains strict.
    receipt, manifest = installed_identity(update, root, verify_contents=verify)
    runtime = update.standalone_runtime(root,home=home)
    runtime.verify_install()
    facts = runtime.status()
    if facts.get('inspection_error'):
        raise failure('无法核验原酒馆进程归属：' + facts['inspection_error'])
    running = facts.get('processes', {}).get('native') is True
    if running and (facts.get('port') != args.port or facts.get('health', {}).get('ok') is not True):
        raise failure('原酒馆进程未通过当前实例的健康与端口检查。')
    worlds = world_read(update, root, home) if verify else None
    return {'standalone': True, 'installed': True, 'hermesInstalled': True, 'noraInstalled': True,
        'systemReady': True, 'setupCompleted': None, 'version': receipt['version'], 'commit': manifest['commit'],
        'port': args.port, 'running': running, 'gatewayRunning': None, 'clawchatConnected': None,
        'gatewayManaged': False, 'noraHome': str(nora), 'hermesHome': str(home), 'installRoot': str(root),
        'worldVerification': {'status': 'verified', 'worlds': sum(len(value) for value in worlds.values())} if worlds is not None else None}


def effects(args, update):
    home, root, _ = roots(args, update)
    file = root / 'tavern-updates/transaction.json'
    if not file.exists():
        return {'effectState': 'untouched', 'recoveryOutcome': 'not-required', 'canRecover': False,
            'canResume': False, 'reason': 'no_journal'}
    previous = read(file)
    # Early standalone updaters committed without a recovery plan. They never
    # belong to this actor. Verify the live installation instead of attempting
    # to load them as a resumable modern transaction; keep the old record intact.
    if (set(previous) == {'schema', 'status', 'version', 'backup'}
            and previous['schema'] == 1 and previous['status'] == 'committed'
            and isinstance(previous['backup'], str) and Path(previous['backup']).is_absolute()):
        current = status(args, update)
        if current['version'] != previous['version'] or read(file) != previous:
            raise failure('历史事务与当前真实安装不一致，未修改文件。')
        return {'effectState': 'untouched', 'recoveryOutcome': 'not-required', 'canRecover': False,
            'canResume': False, 'status': 'committed', 'operationId': None,
            'reason': 'legacy_committed_verified'}
    helper = update.recovery_module()
    observed = helper.effects(home, root)
    if observed.get('effectState') == 'unknown':
        return {**observed, 'canResume': False}
    journal = helper.load(home, root, full=False)
    if journal.plan['before'].get('scope') != 'standalone-tavern':
        return {'effectState': 'unknown', 'recoveryOutcome': 'recovery-required', 'canRecover': False,
            'canResume': False, 'reason': 'transaction_scope_mismatch'}
    same_operation = args.operation_id is None or journal.record.get('operationId') == args.operation_id
    if not same_operation:
        if journal.record.get('status') in ('committed', 'restored'):
            current = status(args, update)
            expected = journal.record['version'] if journal.record['status'] == 'committed' else journal.plan['before']['version']
            if current['version'] != expected or journal.record['status'] == 'restored' and current['running'] != journal.plan['before']['running']:
                raise failure('历史事务与当前真实安装或服务状态不一致。')
            return {'effectState': 'untouched', 'recoveryOutcome': 'not-required', 'canRecover': False,
                'canResume': False, 'status': journal.record['status'], 'operationId': journal.record.get('operationId'),
                'reason': 'prior_transaction_verified'}
        return {**observed, 'canRecover': False, 'canResume': False, 'reason': 'other_operation'}
    if journal.record.get('status') == 'committed':
        current = status(args, update)
        if current['version'] != journal.record['version']:
            raise failure('已提交事务与当前已安装版本不一致。')
        return {**observed, 'effectState': 'changed', 'recoveryOutcome': 'not-required', 'canRecover': False,
            'canResume': True, 'version': current['version'], 'commit': current['commit']}
    return {**observed, 'canResume': False}


def require_owner(args, update):
    gate = update._operation_control.require_operation()
    gate.assert_active()
    if args.operation_id and args.operation_id != gate.operation_id:
        raise failure('此任务不属于当前执行者，未修改文件。', 'OPERATION_REQUEST_CONFLICT')
    return gate


def verify_committed(args, update):
    require_owner(args, update)
    home, root, _ = roots(args, update)
    helper = update.recovery_module()
    journal = helper.load(home, root)
    gate = getattr(sys, '_nora_operation_delegate')
    if (journal.record.get('operationId') != gate.operation_id or journal.record.get('status') != 'committed'
            or journal.plan['before'].get('scope') != 'standalone-tavern'):
        raise failure('未找到属于当前任务的已提交独立更新，禁止重复更新。')
    current = status(args, update)
    if current['version'] != journal.record['version'] or current['running'] != journal.plan['before']['running']:
        raise failure('新版文件或原有服务状态尚未通过验收。')
    if journal.plan.get('worlds') is not None:
        update.verify_preserved_worlds(root / 'apps/tavern-runtime', update.bound_state_root(home, root),
            journal.plan.get('storyInventory', {}), journal.plan['worlds'])
    return {**current, 'updateVerified': True, 'operationVerified': True}


def execute(args):
    update = updater()
    home, root, _ = roots(args, update)
    if args.command in ('status', 'repair-preflight'):
        return status(args, update, verify=args.command == 'status')
    if args.command == 'operation-effects':
        return {'effects': effects(args, update)}
    if args.command == 'plan-update':
        bootstrap = module('nora_task_standalone_bootstrap', HERE / 'bootstrap.py')
        manifest, _, sums = bootstrap.verify_metadata(args.release_dir, args.manifest_sha256,
            allow_candidate=args.allow_candidate)
        archives, mode = bootstrap.required_archives(root, manifest)
        return {'archives': [{'name': name, 'sha256': sums[name]} for name in archives],
            'mode': mode, 'version': manifest['versions']['tavern']}
    require_owner(args, update)
    with update.guarded_standalone_execution(home, root):
        if args.command == 'verify-current-update':
            current = status(args, update)
            if not args.version or args.version.removeprefix('v') != current['version']:
                raise failure('当前安装与固定验收版本不一致，未创建更新事务。', 'CONDITIONS_CHANGED')
            return {**current, 'updateVerified': True, 'operationVerified': True, 'noUpdate': True}
        if args.command == 'update':
            bootstrap = HERE / 'bootstrap.py'
            manifest_sha = args.manifest_sha256 or update.file_sha(args.release_dir / 'release-manifest.json')
            selected = read(args.release_dir / 'release-manifest.json')
            if (args.tag and args.tag.removeprefix('v') != update.publication_tag(selected).removeprefix('v')
                    or args.target_commit and args.target_commit != selected.get('commit')):
                raise failure('固定发布身份与更新任务不一致，未修改安装。', 'CONDITIONS_CHANGED')
            command = [sys.executable, '-B', '-u', str(bootstrap), '--hermes-home', str(home),
                '--install-root', str(root), '--release-dir', str(args.release_dir),
                '--manifest-sha256', manifest_sha, '--apply', '--confirm']
            if args.allow_candidate:
                command.append('--allow-candidate')
            # The downloaded verified release runner performs the transaction;
            # this adapter does not replace files, start services or own a log.
            update._operation_control.managed_run(command, check=True)
            return verify_committed(args, update)
        if args.command == 'recover-update':
            with update.installer_lock(root):
                update.recover_standalone(home, root)
            current = status(args, update)
            observed = effects(args, update)
            if observed.get('effectState') != 'restored' or observed.get('recoveryOutcome') != 'restored-and-verified':
                raise failure('独立更新恢复结果尚未通过验证。')
            return {**current, 'updateRecovered': True, 'recoveryVerification': 'confirmed', 'effects': observed}
        if args.command == 'resume-committed-update':
            return verify_committed(args, update)
    raise failure('不支持的独立更新命令。', 'OPERATION_ENTRY_UNSUPPORTED')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('nora-home', 'hermes-home', 'install-root'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--release-dir', type=Path)
    parser.add_argument('--manifest-sha256')
    parser.add_argument('--allow-candidate', action='store_true')
    parser.add_argument('--operation-id')
    parser.add_argument('--kind')
    parser.add_argument('--tag')
    parser.add_argument('--target-commit')
    parser.add_argument('--version')
    parser.add_argument('command', choices=('status', 'repair-preflight', 'plan-update', 'update', 'operation-effects',
        'recover-update', 'resume-committed-update', 'verify-current-update'))
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535 or args.kind not in (None, 'update', 'repair', 'recover'):
        raise failure('更新任务参数无效。')
    if args.command in ('plan-update', 'update') and args.release_dir is None:
        raise failure('更新缺少固定发布目录。')
    print(json.dumps({'event': 'result', **execute(args)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'event': 'error', 'code': getattr(error, 'code', 'VERIFICATION_FAILED'),
            'message': str(error)}, ensure_ascii=False), flush=True)
        raise SystemExit(1)
