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
import re
import stat
import uuid


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
        fsync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def fsync_directory(path):
    if os.name == 'nt': return
    descriptor = os.open(filesystem_path(path), os.O_RDONLY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def fsync_tree(path):
    path = Path(filesystem_path(path))
    if path.is_symlink(): return
    if path.is_dir():
        for child in path.iterdir(): fsync_tree(child)
        fsync_directory(path)
    else:
        # Windows' CRT commit requires a writable handle even when we only
        # flush an already copied file. Opening it does not replace its bytes.
        with path.open('r+b' if os.name == 'nt' else 'rb') as stream:
            os.fsync(stream.fileno())


def module_at(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载模块：" + str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_shared_paths_path = ROOT / 'ops/updater/bootstrap.py'
if not _shared_paths_path.is_file(): _shared_paths_path = HERE / 'update_paths.py'
_shared_paths = module_at("nora_install_paths", _shared_paths_path)
_diagnostics_path = HERE / "error_diagnostics.py"
if not _diagnostics_path.is_file():
    _diagnostics_path = HERE.parent / "shared/error_diagnostics.py"
_error_diagnostics = module_at("nora_install_error_diagnostics", _diagnostics_path)
_evidence_path = HERE / 'operation_evidence.py'
if not _evidence_path.is_file(): _evidence_path = HERE.parent / 'shared/operation_evidence.py'
_operation_evidence = module_at('nora_install_operation_evidence', _evidence_path)
_recovery_path = HERE / 'update_recovery.py'
if not _recovery_path.is_file(): _recovery_path = HERE.parent / 'updater/recovery.py'
_recovery = module_at('nora_first_install_recovery', _recovery_path)
_control_path = HERE / 'operation_control.py'
if not _control_path.is_file(): _control_path = HERE.parent / 'shared/operation_control.py'
_operation_control = module_at('nora_first_install_control', _control_path)


def assert_operation():
    if getattr(sys, '_nora_operation_delegate', None) is not None or os.environ.get('NORA_OPERATION_DELEGATE_ENDPOINT'):
        _operation_control.require_operation().assert_active()


def maintenance_run(command, **options):
    if getattr(sys, '_nora_operation_delegate', None) is None and not os.environ.get('NORA_OPERATION_DELEGATE_ENDPOINT'):
        return subprocess.run(command, **options)
    command = [str(value) for value in command]
    if not Path(command[0]).name.lower().startswith('python'):
        # Hermes console entry points run under the already validated Nora Python.
        entry = Path(command[0])
        if not entry.is_absolute() or entry.name.lower() not in ('hermes', 'hermes.exe'):
            raise RuntimeError('受管维护拒绝未委托的外部命令')
        command = [sys.executable, '-B', '-c',
            'import sys; from hermes_cli.main import main; sys.exit(main())', *command[1:]]
    return _operation_control.managed_run(command, **options)


class FirstInstallJournal:
    """One owned snapshot and resumable restore plan for first installation."""
    TAVERN = {'apps/tavern-runtime', 'apps/tavern-ops', 'apps/nora-mcp',
              'tavern-state/native-runtime/config.yaml', 'tavern-state/native-runtime/dependencies.json',
              'tavern-state/native-runtime/ready.json', 'tavern-state/native-runtime/runs', 'tavern-updates/installed.json',
              'tavern-updates/installed-manifest.json', 'tavern-updates/nora-system.json'}
    TAVERN |= {'tavern-state/native/default-user/extensions/' + name for name in
        ('JS-Slash-Runner', 'ST-Prompt-Template', 'nora-mvu', 'nora-ui', 'nora-ledger', 'nora-shell', 'nora-character-status')}
    HERMES = _recovery.MANAGED | {'config.yaml', 'AGENTS.md', 'AGENTS.md.bak', 'nora-instance.json',
        'hooks/tavern-liveware-register', 'clawchat/greeting.md', 'clawchat/nora-greeting.json',
        'clawchat/greeting.nora-example.md', 'plugins/clawchat/clawchat_gateway/adapter.py',
        'plugins/clawchat/clawchat_gateway/storage.py'} | {'skills/' + name for name in _recovery.SKILLS}

    def __init__(self, directory, record):
        self.directory = Path(directory)
        self.file = self.directory / 'transaction.json'
        self.record = record

    @classmethod
    def create(cls, nora_home, hermes_home, install_root, *, operation_id=None):
        operation_id, operation = _operation_evidence.operation_directory(nora_home,
            operation_id=operation_id, install_root=install_root)
        roots = {'hermes': Path(hermes_home).resolve(), 'tavern': Path(install_root).resolve()}
        for root in roots.values(): root.mkdir(parents=True, exist_ok=True)
        directory = operation / 'first-install'
        if directory.is_symlink(): raise RuntimeError('首装恢复目录不能是链接')
        operation.mkdir(parents=True, mode=0o700, exist_ok=True)
        attempt, archive, missing = cls.retire_attempt(operation, operation_id, nora_home, roots)
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        for owned in (directory, operation, operation.parent): os.chmod(filesystem_path(owned), 0o700)
        record = {'schema': 1, 'owner': 'nora-first-install', 'operationId': operation_id,
            'noraHome': str(Path(nora_home).resolve()), 'roots': {name: str(root) for name, root in roots.items()},
            'rootIdentities': {name: _recovery.identity(root) for name, root in roots.items()},
            'attempt': attempt, 'status': 'preparing', 'targets': [], 'checkpoints': {}, 'unrestored': []}
        if archive: record['previousArchive'] = archive
        if missing: record['missingReasons'] = missing
        journal = cls(directory, record); journal.save()
        rotation = operation / 'first-install-rotation.json'
        if rotation.exists():
            state = _recovery.read_object(rotation); state['state'] = 'complete'
            atomic(rotation, json.dumps(state).encode())
        return journal

    @classmethod
    def retire_attempt(cls, operation, operation_id, nora_home, roots):
        """Rotate only proven inactive effects, with an intent outside the moved tree."""
        directory = operation / 'first-install'; file = directory / 'transaction.json'
        rotation = operation / 'first-install-rotation.json'
        state = _recovery.read_object(rotation) if rotation.exists() else None
        expected = {'operationId': operation_id, 'noraHome': str(Path(nora_home).resolve()),
            'roots': {name: str(root) for name, root in roots.items()}}
        def check(record):
            if record.get('schema') != 1 or record.get('owner') != 'nora-first-install' or any(
                    record.get(key) != value for key, value in expected.items()):
                raise RuntimeError('首装重试记录身份或目标不一致')
            attempt = record.get('attempt', 1)
            if type(attempt) is not int or not 1 <= attempt <= 100:
                raise RuntimeError('首装尝试次数无效')
            return attempt
        if state is not None:
            if state.get('schema') != 1 or any(state.get(key) != value for key, value in expected.items()) or \
                    type(state.get('fromAttempt')) is not int or not 1 <= state['fromAttempt'] < 100 or \
                    state.get('toAttempt') != state['fromAttempt'] + 1 or state.get('state') not in ('intent', 'archived', 'complete'):
                raise RuntimeError('首装尝试归档记录不受信任')
            if state['state'] != 'complete':
                archive = operation / 'attempts' / f"attempt-{state['fromAttempt']:04d}" / 'first-install'
                if file.exists():
                    current = _recovery.read_object(file)
                    if check(current) == state['toAttempt']:
                        # A crash after the new sealed empty record was written.
                        current_journal = cls(directory, current); current_journal.validate()
                        if current.get('targets') or current.get('applyIntent'):
                            raise RuntimeError('首装新尝试已有活动现场，拒绝覆盖')
                        cls.validate_retired(archive, state, expected)
                        state['state'] = 'complete'; atomic(rotation, json.dumps(state).encode())
                        return state['toAttempt'], str(archive.relative_to(operation)), current.get('missingReasons', [])
                return cls.finish_rotation(operation, directory, state, expected)
            if not file.exists(): raise RuntimeError('首装当前尝试记录缺失，已保留现场')
        if not file.exists():
            if directory.exists() and any(directory.iterdir()): raise RuntimeError('首装恢复目录含未知现场')
            return 1, None, []
        journal = cls.load(file); attempt = check(journal.record)
        effects = _inspect_first_install_journal(journal)
        if effects['effectState'] not in ('untouched', 'restored') or not effects['canRecover']:
            raise RuntimeError('首装现场尚未安全恢复，拒绝开始新尝试')
        if attempt >= 100: raise RuntimeError('首装尝试次数达到上限')
        state = {'schema': 1, **expected, 'fromAttempt': attempt, 'toAttempt': attempt + 1,
            'sourceIdentity': _recovery.identity(directory), 'transactionDigest': hashlib.sha256(file.read_bytes()).hexdigest(),
            'state': 'intent'}
        atomic(rotation, json.dumps(state).encode())
        return cls.finish_rotation(operation, directory, state, expected)

    @classmethod
    def validate_retired(cls, source, state, expected):
        if _recovery.identity(source) != state.get('sourceIdentity'):
            raise RuntimeError('首装尝试归档身份变化')
        file = source / 'transaction.json'
        if hashlib.sha256(file.read_bytes()).hexdigest() != state.get('transactionDigest'):
            raise RuntimeError('首装尝试记录内容变化')
        record = _recovery.read_object(file)
        if record.get('schema') != 1 or record.get('owner') != 'nora-first-install' or any(
                record.get(key) != value for key, value in expected.items()):
            raise RuntimeError('首装尝试归档目标不一致')
        journal = cls(source, record); journal.validate()
        effects = _inspect_first_install_journal(journal)
        if effects['effectState'] not in ('untouched', 'restored') or not effects['canRecover']:
            raise RuntimeError('首装尝试现场变化，拒绝重试')

    @classmethod
    def finish_rotation(cls, operation, directory, state, expected):
        archive = operation / 'attempts' / f"attempt-{state['fromAttempt']:04d}" / 'first-install'
        for owned in (archive.parent.parent, archive.parent):
            if owned.is_symlink(): raise RuntimeError('首装尝试归档目录不能是链接')
            owned.mkdir(mode=0o700, exist_ok=True); os.chmod(filesystem_path(owned), 0o700)
        if directory.exists() and archive.exists() and not any(directory.iterdir()):
            # The new empty canonical directory was created after a completed
            # old-tree rename, but no new journal was written before power loss.
            cls.validate_retired(archive, state, expected)
            assert_operation(); directory.rmdir(); fsync_directory(directory.parent)
        if directory.exists():
            if archive.exists() or archive.is_symlink(): raise RuntimeError('首装尝试归档已有未知现场')
            cls.validate_retired(directory, state, expected)
            assert_operation(); os.replace(filesystem_path(directory), filesystem_path(archive))
            fsync_directory(directory.parent); fsync_directory(archive.parent)
        else: cls.validate_retired(archive, state, expected)
        state['state'] = 'archived'
        atomic(operation / 'first-install-rotation.json', json.dumps(state).encode())
        missing = []
        source = operation / 'evidence/python.json'; target = archive.parent / 'evidence/python.json'
        if source.exists() or source.is_symlink():
            try:
                if source.is_symlink() or source.parent.is_symlink() or source.stat().st_size > _operation_evidence.MAX_BYTES:
                    raise ValueError('首因证据不是受管文件')
                content = source.read_bytes()
                _operation_evidence._validate_record(json.loads(content), state['operationId'])
                if target.parent.is_symlink() or target.is_symlink(): raise ValueError('归档证据目录不能是链接')
                target.parent.mkdir(mode=0o700, exist_ok=True); os.chmod(target.parent, 0o700)
                if target.exists() and target.read_bytes() != content: raise ValueError('归档首因证据已变化')
                if not target.exists(): atomic(target, content)
            except (OSError, ValueError, TypeError, KeyError): missing.append('attempt_evidence_copy_failed')
        return state['toAttempt'], str(archive.relative_to(operation)), missing

    @classmethod
    def load(cls, file):
        file = Path(file)
        record = _recovery.read_object(file)
        if record.get('schema') != 1 or record.get('owner') != 'nora-first-install':
            raise RuntimeError('首装恢复记录身份不一致')
        _identity, operation = _operation_evidence.operation_directory(record['noraHome'],
            operation_id=record['operationId'], installer_directory=file.parents[3])
        if file != operation / 'first-install/transaction.json': raise RuntimeError('首装恢复记录路径不一致')
        journal = cls(file.parent, record); journal.validate(); return journal

    def save(self):
        encoded = json.dumps(self.record, ensure_ascii=False).encode('utf-8')
        if len(encoded) > 2 * 1024 * 1024: raise RuntimeError('首装恢复记录超出安全容量')
        atomic(self.file, encoded)

    def checkpoint(self, stage, state):
        assert_operation()
        if stage == 'apply' and state == 'intent':
            self.record.update(status='applying', applyIntent=True)
        if stage in ('apply', 'hermes_apply', 'tavern_apply') and state in ('result', 'failed'):
            namespace = {'hermes_apply': 'hermes', 'tavern_apply': 'tavern'}.get(stage)
            for item in self.record['targets']:
                if namespace and item['namespace'] != namespace: continue
                if not self.managed_code(item): continue
                target = self.target(item)
                item['newIdentity'] = _recovery.identity(target)
                item['newDigest'] = _recovery.digest(target) if target.is_file() else None
        self.record['checkpoints'][stage] = {'state': state, 'at': time.time()}
        self.save()

    def item_for(self, target):
        target = Path(filesystem_path(target)).resolve()
        for item in self.record['targets']:
            if Path(filesystem_path(self.target(item))).resolve() == target: return item
        raise RuntimeError('写入目标不在首装受管清单')

    def apply_bytes(self, target, content, mode=0o600):
        prepared = self.directory / 'prepared' / uuid.uuid4().hex
        atomic(prepared, content, mode=mode)
        self.apply(prepared, target)

    def remove(self, target):
        item = self.item_for(target); target = self.target(item)
        if not target.exists(): return
        current = _recovery.identity(target)
        if current not in [item.get('oldIdentity'), item.get('newIdentity')]:
            raise RuntimeError('首装删除目标身份变化，已保留现场')
        exchange = {'old': (Path(item['path']).parent / ('.nora-first-install-old-' + uuid.uuid4().hex)).as_posix(),
            'oldIdentity': current, 'oldDigest': _recovery.digest(target), 'newIdentity': None,
            'newDigest': None, 'phase': 'old-rename-intent'}
        item.setdefault('exchanges', []).append(exchange); self.save()
        old = _recovery.safe_path(self.record['roots'][item['namespace']], exchange['old'])
        assert_operation(); os.replace(filesystem_path(target), filesystem_path(old)); fsync_directory(target.parent)
        exchange['phase'] = 'new-rename-result'; item.update(newIdentity=None, newDigest=None); self.save()

    def apply(self, source, target):
        """Prepare on the target filesystem before either owned rename."""
        assert_operation()
        item = self.item_for(target)
        target = self.target(item); source = Path(source)
        current_id = _recovery.identity(target)
        expected_ids = [item.get('oldIdentity'), *[entry.get('newIdentity') for entry in item.get('exchanges', [])]]
        if current_id is not None and current_id not in expected_ids:
            raise RuntimeError('首装交换目标身份变化，未覆盖文件')
        expected_digests = [item.get('digest'), *[entry.get('newDigest') for entry in item.get('exchanges', [])]]
        if target.exists() and _recovery.digest(target) not in expected_digests:
            raise RuntimeError('首装交换目标内容变化，未覆盖文件')
        relative = Path(item['path']).parent
        exchange = {'staged': (relative / ('.nora-first-install-apply-' + uuid.uuid4().hex)).as_posix(),
            'old': (relative / ('.nora-first-install-old-' + uuid.uuid4().hex)).as_posix(),
            'oldIdentity': current_id, 'oldDigest': _recovery.digest(target) if target.exists() else None,
            'newDigest': _recovery.digest(source), 'phase': 'prepare-intent'}
        item.setdefault('exchanges', []).append(exchange); self.save()
        root = self.record['roots'][item['namespace']]
        staged, old = [_recovery.safe_path(root, exchange[key]) for key in ('staged', 'old')]
        staged.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir(): shutil.copytree(filesystem_path(source), filesystem_path(staged), symlinks=True)
        else: shutil.copy2(filesystem_path(source), filesystem_path(staged))
        if _recovery.digest(staged) != exchange['newDigest']: raise RuntimeError('首装暂存源核验失败')
        fsync_tree(staged)
        exchange.update(newIdentity=_recovery.identity(staged), phase='prepare-result')
        item.update(newIdentity=exchange['newIdentity'], newDigest=exchange['newDigest']); self.save()
        if item['namespace'] == 'tavern' and item['path'] == 'apps/tavern-runtime':
            # The engine creates a migration-backup directory during startup.
            # Seal code from the verified staging tree before it can run; never
            # reauthorize the live program bytes at commit time.
            item.update(codeDigestPolicy='nora-first-install-code/1',
                codeIdentity=exchange['newIdentity'], codeDigest=first_install_code_digest(staged))
            self.save()
        exchange['phase'] = 'old-rename-intent'; self.save()
        if current_id is not None:
            assert_operation(); os.replace(filesystem_path(target), filesystem_path(old)); fsync_directory(target.parent)
        exchange['phase'] = 'old-rename-result'; self.save()
        exchange['phase'] = 'new-rename-intent'; self.save()
        assert_operation(); os.replace(filesystem_path(staged), filesystem_path(target)); fsync_directory(target.parent)
        exchange['phase'] = 'new-rename-result'; self.save()

    def target(self, item):
        return _recovery.safe_path(self.record['roots'][item['namespace']], item['path'])

    def validate(self):
        if self.directory.is_symlink(): raise RuntimeError('首装恢复目录不能是链接')
        if (not isinstance(self.record.get('checkpoints'), dict)
                or any(not isinstance(value, dict) for value in self.record['checkpoints'].values())):
            raise RuntimeError('首装检查点记录无效，已保留现场')
        for name, root in self.record['roots'].items():
            if name not in ('hermes', 'tavern') or _recovery.identity(root) != self.record['rootIdentities'].get(name):
                raise RuntimeError('首装恢复根目录身份已变化，已保留现场')
        if not isinstance(self.record['targets'], list) or len(self.record['targets']) > 128:
            raise RuntimeError('首装恢复目标清单无效')
        seen = set()
        for item in self.record['targets']:
            namespace, relative = item.get('namespace'), item.get('path')
            allowed = self.TAVERN if namespace == 'tavern' else self.HERMES if namespace == 'hermes' else set()
            if relative not in allowed or (namespace, relative) in seen:
                raise RuntimeError('首装恢复目标不在受管清单')
            seen.add((namespace, relative))
            def owned(value, prefix):
                path = Path(value)
                if path.parent != Path(relative).parent or not re.fullmatch(prefix + r'[a-f0-9]{32}', path.name):
                    raise RuntimeError('首装交换暂存路径不受信任')
            for entry in item.get('exchanges', []):
                owned(entry['old'], r'\.nora-first-install-old-')
                if 'staged' in entry: owned(entry['staged'], r'\.nora-first-install-apply-')
                for artifact in entry.get('artifacts', []):
                    if artifact.get('source') not in (entry.get('old'), entry.get('staged')):
                        raise RuntimeError('首装归档来源不受信任')
                    if not re.fullmatch(r'failed-new/[0-9]+-[a-f0-9]{32}', artifact.get('archive', '')):
                        raise RuntimeError('首装归档路径不受信任')
            if 'staged' in item: owned(item['staged'], r'\.nora-first-install-restore-')
            if 'archive' in item and not re.fullmatch(r'failed-new/[0-9]+-[a-f0-9]{32}', item['archive']):
                raise RuntimeError('首装失败程序归档路径不受信任')
            if 'untrustedCopy' in item and not re.fullmatch(r'failed-new/[0-9]+-[a-f0-9]{32}', item['untrustedCopy'].get('archive', '')):
                raise RuntimeError('首装未知配置保留路径不受信任')
        return self

    def prepare(self, targets, *, manifest):
        self.record['targetDigest'] = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
        self.record['targets'] = [{'namespace': namespace, 'path': Path(target).resolve().relative_to(Path(self.record['roots'][namespace])).as_posix(),
            'phase': 'pending'} for namespace, entries in targets.items() for target in dict.fromkeys(entries)]
        self.validate(); self.checkpoint('prepare', 'intent')
        for item in self.record['targets']:
            target = self.target(item)
            saved = _recovery.safe_path(self.directory, 'backups/' + item['namespace'] + '/' + item['path'])
            item.update(existed=target.exists(), oldIdentity=_recovery.identity(target), phase='preparing')
            item['digest'] = _recovery.digest(target) if item['existed'] else None
            self.save()
            if item['existed']:
                saved.parent.mkdir(parents=True, exist_ok=True)
                if target.is_dir(): shutil.copytree(filesystem_path(target), filesystem_path(saved), symlinks=True)
                else: shutil.copy2(filesystem_path(target), filesystem_path(saved))
                if _recovery.digest(saved) != item['digest']: raise RuntimeError('首装备份内容核验失败')
                fsync_tree(saved)
            item.update(savedIdentity=_recovery.identity(saved), phase='prepared'); self.save()
        self.record['status'] = 'prepared'; self.checkpoint('prepare', 'result')
        return self

    def restore_target(self, item, index):
        target = self.target(item)
        saved = _recovery.safe_path(self.directory, 'backups/' + item['namespace'] + '/' + item['path'])
        if item.get('phase') == 'pending' or item.get('savedIdentity') is None and item.get('existed'):
            raise RuntimeError('首装备份未完成，未覆盖目标')
        if item['existed'] and (_recovery.identity(saved) != item['savedIdentity'] or _recovery.digest(saved) != item['digest']):
            raise RuntimeError('首装备份身份或内容已变化，未覆盖目标')
        current = _recovery.identity(target)
        if current is not None:
            identities = [item.get('oldIdentity'), item.get('newIdentity'), item.get('stagedIdentity'),
                *[entry.get('oldIdentity') for entry in item.get('exchanges', [])],
                *[entry.get('newIdentity') for entry in item.get('exchanges', [])]]
            derived = self.record.get('restoreMode') == 'failed-apply' and self.managed_code(item)
            if current not in identities and not derived:
                self.preserve_unknown(item, index, target)
                raise RuntimeError('待恢复目标身份未知，已保留现场')
            digests = [item['digest'], item.get('newDigest'), *[entry.get('newDigest') for entry in item.get('exchanges', [])]]
            if _recovery.digest(target) not in digests and not derived:
                self.preserve_unknown(item, index, target)
                raise RuntimeError('待恢复目标内容未知，已保留现场')
        if target.exists() and item['existed'] and _recovery.digest(target) == item['digest']:
            if current != item.get('oldIdentity'): _recovery.restore_permissions(saved, target)
            item.update(phase='restored', restoredIdentity=current); self.save(); return
        if item.get('phase') == 'restored' and not item['existed'] and not target.exists(): return
        if 'archive' not in item:
            item.update(archive=f'failed-new/{index}-{uuid.uuid4().hex}', failedIdentity=_recovery.identity(target), phase='restore-intent')
            self.save()
        archive = _recovery.safe_path(self.directory, item['archive'])
        if target.exists():
            if _recovery.identity(target) != item['failedIdentity']:
                raise RuntimeError('待恢复目标身份变化，已保留现场')
            archive.parent.mkdir(parents=True, exist_ok=True)
            assert_operation(); os.replace(filesystem_path(target), filesystem_path(archive))
            fsync_directory(target.parent); fsync_directory(archive.parent)
        elif archive.exists() and _recovery.identity(archive) != item['failedIdentity']:
            raise RuntimeError('失败程序归档身份不一致')
        item['phase'] = 'archived'; self.save()
        if item['existed']:
            if 'staged' not in item:
                item['staged'] = (Path(item['path']).parent / ('.nora-first-install-restore-' + uuid.uuid4().hex)).as_posix()
                self.save()
            staged = _recovery.safe_path(self.record['roots'][item['namespace']], item['staged'])
            if staged.exists():
                if _recovery.identity(staged) != item.get('stagedIdentity'):
                    raise RuntimeError('首装恢复暂存身份不一致')
                if _recovery.digest(staged) != item['digest']:
                    if staged.is_dir(): shutil.rmtree(filesystem_path(staged))
                    else: staged.unlink()
            if not staged.exists():
                staged.parent.mkdir(parents=True, exist_ok=True)
                if saved.is_dir(): staged.mkdir()
                else: staged.touch(mode=0o600)
                item.update(stagedIdentity=_recovery.identity(staged), phase='copy-intent'); self.save()
                if saved.is_dir(): shutil.copytree(filesystem_path(saved), filesystem_path(staged), symlinks=True, dirs_exist_ok=True)
                else: shutil.copy2(filesystem_path(saved), filesystem_path(staged))
            if _recovery.digest(staged) != item['digest']: raise RuntimeError('首装恢复暂存内容核验失败')
            fsync_tree(staged)
            item['phase'] = 'install-intent'; self.save()
            assert_operation(); os.replace(filesystem_path(staged), filesystem_path(target)); fsync_directory(target.parent)
        item.update(phase='restored', restoredIdentity=_recovery.identity(target)); self.save()

    def preserve_unknown(self, item, index, target):
        # Copy a regular owned-path configuration while leaving its original
        # in place. Links, devices and user-data directories are never read.
        if not target.is_file() or target.is_symlink(): return
        current, digest = _recovery.identity(target), _recovery.digest(target)
        previous = item.get('untrustedCopy')
        if previous and previous.get('sourceIdentity') == current and previous.get('digest') == digest and previous.get('phase') == 'copy-result':
            archive = _recovery.safe_path(self.directory, previous['archive'])
            if _recovery.identity(archive) == previous.get('identity') and _recovery.digest(archive) == digest: return
        copy = {'archive': f'failed-new/{index}-{uuid.uuid4().hex}', 'sourceIdentity': current,
            'digest': digest, 'phase': 'copy-intent'}
        item['untrustedCopy'] = copy; self.save()
        archive = _recovery.safe_path(self.directory, copy['archive'])
        archive.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        descriptor = os.open(filesystem_path(target), os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        with os.fdopen(descriptor, 'rb') as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode) or [opened.st_dev, opened.st_ino] != current:
                raise RuntimeError('未知配置句柄身份变化，原文件未读取')
            fd = os.open(filesystem_path(archive), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'wb') as destination:
                shutil.copyfileobj(source, destination); destination.flush(); os.fsync(destination.fileno())
        fsync_directory(archive.parent)
        if _recovery.identity(target) != current or _recovery.digest(target) != digest or _recovery.digest(archive) != digest:
            raise RuntimeError('未知配置在保留期间变化，原文件未覆盖')
        copy.update(identity=_recovery.identity(archive), phase='copy-result'); self.save()

    def archive_exchanges(self, item, index):
        """Retain owned previous/staged trees outside all runtime deletion trees."""
        for exchange in item.get('exchanges', []):
            artifacts = exchange.setdefault('artifacts', [])
            for key, identity_key in (('old', 'oldIdentity'), ('staged', 'newIdentity')):
                if key not in exchange: continue
                source = _recovery.safe_path(self.record['roots'][item['namespace']], exchange[key])
                artifact = next((entry for entry in artifacts if entry['source'] == exchange[key]), None)
                if artifact is None:
                    if not source.exists(): continue
                    expected = exchange.get(identity_key)
                    if expected is not None and _recovery.identity(source) != expected:
                        raise RuntimeError('首装交换残留身份不一致，已保留现场')
                    artifact = {'source': exchange[key], 'archive': f'failed-new/{index}-{uuid.uuid4().hex}',
                        'identity': _recovery.identity(source), 'phase': 'archive-intent', 'kind': key}
                    artifacts.append(artifact); self.save()
                archive = _recovery.safe_path(self.directory, artifact['archive'])
                if source.exists():
                    if archive.exists() or _recovery.identity(source) != artifact['identity']:
                        raise RuntimeError('首装交换残留归档身份不一致')
                    archive.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                    assert_operation(); os.replace(filesystem_path(source), filesystem_path(archive))
                    fsync_directory(source.parent); fsync_directory(archive.parent)
                elif not archive.exists() or _recovery.identity(archive) != artifact['identity']:
                    raise RuntimeError('首装交换残留归档未完成')
                artifact['phase'] = 'archive-result'; self.save()

    def managed_code(self, item):
        if item['namespace'] == 'tavern':
            return (item['path'].startswith('apps/') or item['path'].startswith('tavern-state/native/default-user/extensions/')
                or item['path'] in {'tavern-state/native-runtime/runs', 'tavern-state/native-runtime/dependencies.json',
                    'tavern-state/native-runtime/ready.json'})
        return item['path'] in self.HERMES - {'config.yaml', 'AGENTS.md', 'AGENTS.md.bak', 'SOUL.md',
            'SOUL.nora-tavern.example.md', 'clawchat/greeting.md', 'clawchat/greeting.nora-example.md', 'cron/jobs.json'}

    def restore(self, *, stop=None):
        self.validate()
        self.record.setdefault('restoreMode', 'failed-apply' if self.record.get('applyIntent') and
            self.record['checkpoints'].get('commit', {}).get('state') != 'result' else 'strict')
        self.record['status'] = 'restoring'; self.checkpoint('restore', 'intent')
        if stop is not None:
            try:
                proof = stop()
                if not isinstance(proof, dict) or proof.get('offline') is not True:
                    raise RuntimeError('未获得运行进程已停止的正证据，已保留安装现场')
            except Exception as error:
                self.record['status'] = 'blocked_stop'
                self.record['unrestored'] = [{'namespace': item['namespace'], 'path': item['path'], 'reason': 'runtime_not_stopped'}
                    for item in self.record['targets'] if item['phase'] != 'restored']
                self.save()
                return {'status': 'blocked_stop', 'errors': [error], 'unrestored': self.record['unrestored']}
        errors, unrestored = [], []
        for index, item in reversed(list(enumerate(self.record['targets']))):
            try:
                self.restore_target(item, index)
                self.archive_exchanges(item, index)
            except Exception as error:
                errors.append(error); unrestored.append({'namespace': item['namespace'], 'path': item['path'], 'reason': type(error).__name__})
        self.record['unrestored'] = unrestored
        self.record['status'] = 'recovery_failed' if errors else 'restored'
        self.checkpoint('restore', 'result')
        return {'status': self.record['status'], 'errors': errors, 'unrestored': unrestored}


def resume_first_install(journal_path, *, stop):
    return FirstInstallJournal.load(journal_path).restore(stop=stop)


def _inspect_first_install_journal(journal):
    journal.validate()
    if (journal.record['checkpoints'].get('commit', {}).get('state') == 'result'
            and journal.record['checkpoints'].get('restore', {}).get('state') not in ('intent', 'result')):
        return _inspect_committed_first_install(journal)
    if not journal.record.get('applyIntent') and not any(item.get('exchanges') or 'newIdentity' in item
            for item in journal.record['targets']):
        return {'effectState': 'untouched', 'canRecover': True, 'reason': 'no_apply_intent'}
    targets = journal.record['targets']
    if not targets or any('existed' not in item or 'digest' not in item or item.get('phase') == 'pending' for item in targets):
        return {'effectState': 'unknown', 'canRecover': False, 'reason': 'journal_incomplete'}
    for item in targets:
        if not item['existed']: continue
        saved = _recovery.safe_path(journal.directory, 'backups/' + item['namespace'] + '/' + item['path'])
        if _recovery.identity(saved) != item.get('savedIdentity') or _recovery.digest(saved) != item['digest']:
            return {'effectState': 'unknown', 'canRecover': False, 'reason': 'backup_invalid'}
    changed = False
    failed_apply = journal.record.get('restoreMode') == 'failed-apply' or (journal.record.get('applyIntent') and
        journal.record['checkpoints'].get('commit', {}).get('state') != 'result')
    for item in targets:
        target = journal.target(item); current = _recovery.identity(target)
        if current is None and not item['existed']: continue
        digest = _recovery.digest(target) if current is not None else None
        if current is not None and digest == item['digest'] and current in (
                item.get('oldIdentity'), item.get('stagedIdentity'), item.get('restoredIdentity')):
            continue
        known = [item.get('newIdentity'), *[entry.get('newIdentity') for entry in item.get('exchanges', [])]]
        digests = [item.get('newDigest'), *[entry.get('newDigest') for entry in item.get('exchanges', [])]]
        own_missing = current is None and any(entry.get('phase') in
            ('old-rename-intent', 'old-rename-result', 'new-rename-intent') for entry in item.get('exchanges', []))
        recovering_missing = current is None and item.get('phase') in ('restore-intent', 'archived', 'copy-intent', 'install-intent')
        if not (current is not None and current in known and digest in digests or own_missing or recovering_missing
                or failed_apply and journal.managed_code(item)):
            return {'effectState': 'unknown', 'canRecover': False, 'reason': 'target_unknown'}
        changed = True
    restored = journal.record['checkpoints'].get('restore', {}).get('state') in ('intent', 'result')
    return {'effectState': 'changed' if changed else 'restored' if restored else 'untouched',
        'canRecover': True, 'reason': 'sealed_effects' if changed else 'original_targets'}


def _inspect_committed_first_install(journal):
    """A committed target can resume acceptance; its runtime observations vary."""
    unknown = {'effectState': 'unknown', 'canRecover': False, 'canResume': False, 'reason': 'committed_target_invalid'}
    target_digest = journal.record.get('targetDigest')
    if not isinstance(target_digest, str) or not re.fullmatch(r'[a-f0-9]{64}', target_digest): return unknown
    targets = {(item['namespace'], item['path']): item for item in journal.record['targets']}
    receipts = []
    for relative in ('tavern-updates/installed.json', 'tavern-updates/installed-manifest.json'):
        item = targets.get(('tavern', relative))
        if item is None: return unknown
        path = journal.target(item)
        if (_recovery.identity(path) != item.get('newIdentity')
                or _recovery.digest(path) != item.get('newDigest')): return unknown
        receipts.append(_recovery.read_object(path))
    receipt, manifest = receipts
    versions = manifest.get('versions')
    if not isinstance(versions, dict) or not isinstance(versions.get('tavern'), str) or not versions['tavern']: return unknown
    if hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest() != target_digest: return unknown
    if (receipt.get('schema') != 1 or receipt.get('mode') != 'first-install'
            or receipt.get('manifestDigest') != target_digest or receipt.get('sourceDigest') != manifest.get('sourceDigest')
            or receipt.get('version') != manifest.get('versions', {}).get('tavern')
            or receipt.get('components') != manifest.get('versions', {})
            or receipt.get('commit') != manifest.get('commit')
            or receipt.get('hermesRuntime') != manifest.get('hermesRuntime')): return unknown
    mutable = {'tavern-state/native-runtime/runs', 'tavern-state/native-runtime/dependencies.json',
        'tavern-state/native-runtime/ready.json'}
    for item in journal.record['targets']:
        target = journal.target(item)  # Validate every path even when its data can change.
        if not journal.managed_code(item) or item['namespace'] == 'tavern' and item['path'] in mutable: continue
        if item['namespace'] == 'tavern' and item['path'] == 'apps/tavern-runtime':
            if (item.get('codeDigestPolicy') != 'nora-first-install-code/1'
                    or _recovery.identity(target) != item.get('codeIdentity')
                    or not re.fullmatch(r'[a-f0-9]{64}', item.get('codeDigest', ''))
                    or first_install_code_digest(target) != item['codeDigest']): return unknown
            continue
        digest = item.get('newDigest')
        if digest is None:
            digest = next((entry.get('newDigest') for entry in reversed(item.get('exchanges', []))
                if entry.get('newIdentity') == item.get('newIdentity')), None)
        if (_recovery.identity(target) != item.get('newIdentity')
                or target.exists() and _recovery.digest(target) != digest): return unknown
    return {'operationId': journal.record['operationId'], 'status': 'committed', 'effectState': 'changed',
        'canRecover': False, 'canResume': True, 'reason': 'committed_target', 'targetDigest': target_digest,
        'version': receipt['version']}


def first_install_code_digest(path):
    """Hash program bytes, excluding only the engine's user migration backups.

    Normal chat/settings backups live below dataRoot. This legacy migration
    directory lives inside the program tree, is created even on fresh startup,
    and may contain user data. Its fixed path is not an extensible ignore rule.
    """
    root = Path(filesystem_path(path)); result = hashlib.sha256()
    def visit(current, relative):
        if relative == '/engine/sillytavern/backups':
            if _recovery.linked(current) or not current.is_dir():
                raise RuntimeError('用户迁移备份目录不是受管目录，已保留现场')
            return
        value = current.lstat()
        if _recovery.linked(current):
            result.update(b'L' + relative.encode() + b'\0' + os.fsencode(os.readlink(current))); return
        if stat.S_ISDIR(value.st_mode):
            result.update(b'D' + relative.encode() + b'\0')
            for child in sorted(current.iterdir(), key=lambda entry: entry.name):
                visit(child, relative + '/' + child.name)
        elif stat.S_ISREG(value.st_mode):
            result.update(b'F' + relative.encode() + b'\0')
            with current.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''): result.update(block)
        else: raise RuntimeError('首装程序目录含不支持的文件类型')
    visit(root, '')
    return result.hexdigest()


def inspect_first_install(journal_path):
    """Read sealed intent, identities and bytes; never mutate recovery state."""
    try:
        return _inspect_first_install_journal(FirstInstallJournal.load(journal_path))
    except (OSError, RuntimeError, ValueError, TypeError, KeyError, IndexError, AttributeError):
        return {'effectState': 'unknown', 'canRecover': False, 'reason': 'journal_invalid'}


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
        probe = maintenance_run(
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


def mark_bundled_dependencies(source: Path, install_root: Path, manifest: dict, journal=None) -> None:
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
    write = journal.apply_bytes if journal is not None else atomic
    write(marker, (json.dumps({
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


def copy_tree(source: Path, target: Path, journal=None) -> None:
    if journal is not None:
        journal.apply(source, target); return
    source, target = Path(filesystem_path(source)), Path(filesystem_path(target))
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target, symlinks=True)


def prepare_runtime_source(source: Path, work: Path) -> Path:
    """Materialize trusted file dependencies in an isolated tree before sealing.

    This calls only the existing local-copy method. Runtime installation,
    dependency downloads, configuration and user asset writes happen later.
    """
    assert_operation()
    prepared = Path(work) / 'runtime-source'
    shutil.copytree(filesystem_path(source), filesystem_path(prepared), symlinks=True)
    lifecycle = module_at('nora_first_install_prepared_lifecycle', prepared / 'native_lifecycle.py')
    contract = lifecycle.RuntimeContract.from_dict(json.loads((prepared / 'native-runtime.json').read_text(encoding='utf-8')))
    runtime = lifecycle.NativeRuntime(prepared, prepared, prepared / '.unused-runtime-state', contract)
    runtime.materialize_local_dependencies()
    return prepared


def install_host_hook(home: Path, source: Path, journal=None) -> str:
    origin = source / "ops" / HOST_HOOK
    required = ("HOOK.yaml", "handler.py", "run.sh")
    missing = [name for name in required if not (origin / name).is_file()]
    if missing:
        raise RuntimeError("发布包缺少 Tavern 启动钩子：" + ", ".join(missing))
    target = home / HOST_HOOK
    copy_tree(origin, target, journal)
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
    return installer.prepare_skill_trees(source, work / "prepared-skills", local=True)


def install_skills(home: Path, prepared: dict[str, Path], journal=None) -> list[str]:
    installed = []
    for relative, origin in prepared.items():
        target = Path(filesystem_path(home / "skills" / relative))
        copy_tree(origin, target, journal)
        installed.append(relative)
    return sorted(installed)


def restore_retained_config(install_root: Path, journal=None) -> Path:
    retained = install_root / "tavern-state/nora-retained-config.yaml"
    target = install_root / "tavern-state/native-runtime/config.yaml"
    for candidate in (retained, target):
        if candidate.is_symlink() or not candidate.resolve().is_relative_to(install_root.resolve()):
            raise RuntimeError("保留的酒馆配置不能重定向到隔离目录外")
    if retained.is_file():
        write = journal.apply_bytes if journal is not None else atomic
        write(target, retained.read_bytes(), mode=0o600)
    return retained


def install_agents(home: Path, document: str, journal=None) -> str:
    context = module_at("first_install_managed_context", ROOT / "ops/updater/managed_context.py")
    if journal is not None:
        content = context.agents_document(document)
        target = context.checked_path(home, 'AGENTS.md')
        previous = context.checked_path(home, 'AGENTS.md.bak')
        if target.exists():
            current = target.read_bytes()
            if current == content: return str(target)
            journal.apply_bytes(previous, current)
        journal.apply_bytes(target, content)
        return str(target)
    return context.install_agents(home, document)


def render_mcp(hermes_home: Path, install_root: Path, port: int = 8799) -> bytes:
    updater = module_at("first_install_mcp", HERE.parent / "updater/update.py")
    import yaml
    config = yaml.safe_load(updater.render_mcp(hermes_home, install_root, port))
    # Installation default only; updates and explicit user preferences survive.
    config.setdefault("approvals", {}).setdefault("destructive_slash_confirm", False)
    return yaml.safe_dump(config, allow_unicode=True, sort_keys=False).encode()


def install_soul(home: Path, source: Path, *, replace: bool, dedicated: bool = False, journal=None) -> dict:
    template = source / "ops/installer/templates/SOUL.md"
    if not template.is_file():
        raise RuntimeError("发布包缺少 Nora SOUL 模板")
    target = home / "SOUL.md"
    example = home / "SOUL.nora-tavern.example.md"
    write = journal.apply_bytes if journal is not None else atomic
    if dedicated and target.exists() and not replace:
        defaults = home / "hermes-agent/hermes_cli/default_soul.py"
        if defaults.is_file():
            upstream = module_at("nora_upstream_default_soul", defaults)
            replace = target.read_text(encoding="utf-8").strip() == upstream.DEFAULT_SOUL_MD.strip()
    if target.exists() and not replace:
        write(example, template.read_bytes(), mode=0o600)
        return {"status": "preserved-existing", "path": str(target), "example": str(example)}
    replaced = target.exists()
    write(target, template.read_bytes(), mode=0o600)
    return {"status": "replaced-with-backup" if replaced else "installed", "path": str(target)}


def write_install_receipt(root: Path, manifest: dict, journal=None) -> None:
    write = journal.apply_bytes if journal is not None else atomic
    write(root / "tavern-updates/installed-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
    write(root / "tavern-updates/installed.json", json.dumps({
        "schema": 1, "mode": "first-install", "version": manifest.get("versions", {}).get("tavern"),
        "commit": manifest.get("commit"), "installedAt": time.time(),
        "components": manifest.get("versions", {}), "hermesRuntime": manifest.get("hermesRuntime"),
        "sourceDigest": manifest.get("sourceDigest"),
        "manifestDigest": hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest(),
    }, ensure_ascii=False, indent=2).encode("utf-8"))


def install_update_check(home: Path, ops_root: Path, journal=None, work=None) -> dict:
    update = module_at("nora_tavern_update_installed", ops_root / "updater/update.py")
    if journal is not None:
        staged = Path(work) / 'cron-home'; staged.mkdir(mode=0o700)
        for relative in ('config.yaml', 'cron/jobs.json'):
            target = home / relative
            if target.exists():
                _recovery.reject_links(target)
                destination = staged / relative; destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(filesystem_path(target), filesystem_path(destination))
        def run(command, *, cwd=None, env=None, timeout=300, capture=False):
            return maintenance_run(command, cwd=cwd, env=env, timeout=timeout,
                check=True, text=True, capture_output=capture)
        update.run = run  # Local module adapter; no global subprocess interception.
        report = update.install_update_check(staged, ops_root)
        for relative in [*['scripts/' + name for name in update.UPDATE_CHECK_FILES], 'cron/jobs.json']:
            journal.apply(staged / relative, home / relative)
        return report
    return update.install_update_check(home, ops_root)


def start_tavern(hermes_home: Path, install_root: Path, port: int, journal=None, allow_dependency_install=False) -> dict:
    app = install_root / "apps/tavern-runtime"
    lifecycle = module_at("nora_tavern_native_lifecycle", app / "native_lifecycle.py")
    contract = lifecycle.RuntimeContract.from_dict(json.loads((app / "native-runtime.json").read_text(encoding="utf-8")))
    runtime = lifecycle.NativeRuntime(install_root, app, install_root / "tavern-state", contract)
    runtime.install(journal=journal, allow_dependency_install=allow_dependency_install)
    return runtime.start(port=port)


def stop_install_runtime(install_root: Path) -> dict:
    app = install_root / "apps/tavern-runtime"
    lifecycle = module_at("nora_tavern_rollback_lifecycle", app / "native_lifecycle.py")
    contract = lifecycle.RuntimeContract.from_dict(json.loads((app / "native-runtime.json").read_text(encoding="utf-8")))
    runtime = lifecycle.NativeRuntime(install_root, app, install_root / "tavern-state", contract)
    runtime.stop_run()
    processes = runtime.process_module()
    metadata = runtime.run_dir('production') / 'run.json'
    record = json.loads(metadata.read_text()) if metadata.exists() else {}
    if processes.find_processes(runtime.engine_root / 'server.js') or record.get('port') and processes.port_open(record['port']):
        raise RuntimeError('未能确认失败酒馆进程已经退出，已保留现场')
    return {'offline': True}


def initialize_liveware(hermes_home: Path, install_root: Path, port: int) -> dict:
    try:
        integration = module_at("nora_tavern_liveware", install_root / "apps/tavern-ops/updater/liveware_integration.py")
        return integration.initialize(install_root, port, hermes_home=hermes_home)
    except Exception as error:
        return {"status": "pending", "warnings": [str(error)]}


def _install(args, operation_id, context_ref) -> dict:
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
    context_ref.update(nora_home=nora_home, install_root=install_root)
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
        event("task", stage_id="install_components", milestone=0, task="正在解压诺拉与酒馆文件")
        source, manifest = source_from_release(args, work)
        version = manifest.get("versions", {}).get("tavern", "unknown")
        prepared_app = prepare_runtime_source(source / 'app', work)
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
            *[install_root / ('tavern-state/native-runtime/' + name) for name in ('config.yaml', 'dependencies.json', 'ready.json', 'runs')],
            *[install_root / relative for relative in sorted(FirstInstallJournal.TAVERN)
                if relative.startswith('tavern-state/native/default-user/extensions/')],
            install_root / "tavern-updates/installed.json",
            install_root / "tavern-updates/installed-manifest.json",
            install_root / "tavern-updates/nora-system.json",
        ]
        hermes_targets = [
            hermes_home / "config.yaml",
            hermes_home / "AGENTS.md",
            hermes_home / "AGENTS.md.bak",
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
        journal = FirstInstallJournal.create(nora_home, hermes_home, install_root, operation_id=operation_id)
        journal.record['hermesRuntimeVerified'] = dedicated
        journal.checkpoint('hermes_runtime', 'result')
        journal.prepare({'tavern': tavern_targets, 'hermes': hermes_targets}, manifest=manifest)
        context_ref['journal'] = journal
        runtime_attempted = False
        try:
            journal.checkpoint('apply', 'intent')
            journal.checkpoint('hermes_apply', 'intent')
            event("task", stage_id="runtime_init", milestone=0, task="配置诺拉")
            for _, prepared, target in gateway_swaps:
                journal.apply_bytes(target, prepared.read_bytes(), mode=prepared.stat().st_mode & 0o777)
            for _, prepared, target in context_swaps:
                journal.apply_bytes(target, prepared.read_bytes(), mode=0o600)
            if gateway_swaps:
                gateway_report = {**gateway_report, "status": "installed"}
            log("安装 Hermes skills、AGENTS 和 Nora MCP 配置")
            skills = install_skills(hermes_home, prepared_skills, journal)
            host_hook = install_host_hook(hermes_home, source, journal)
            agents = install_agents(hermes_home, document, journal)
            journal.apply_bytes(hermes_home / "config.yaml", render_mcp(hermes_home, install_root, args.port), mode=0o600)
            soul = install_soul(hermes_home, source, replace=args.replace_soul, dedicated=dedicated, journal=journal)
            if dedicated:
                system = module_at("nora_install_system", HERE / "nora_system.py")
                system.configure_managed(hermes_home, install_root, nora_home, args.port, source,
                                         sys.executable, dict(os.environ), journal=journal, work=work)
            update_check = install_update_check(hermes_home, source / "ops", journal, work)
            if update_check.get("status") != "installed":
                raise RuntimeError("诺拉更新提醒任务未成功注册")
            if dedicated:
                problems = system.managed_problems(hermes_home, install_root, args.port)
                if problems:
                    raise RuntimeError("；".join(problems))
                system.record_files_ready(hermes_home, journal)
            journal.checkpoint('hermes_apply', 'result')
            event("milestone", index=0, state="done", task="诺拉文件安装完成")
            event("milestone", stage_id="install_components", index=1, state="running", task="安装酒馆本体")
            journal.checkpoint('tavern_apply', 'intent')
            copy_tree(prepared_app, install_root / "apps/tavern-runtime", journal)
            copy_tree(source / "ops", install_root / "apps/tavern-ops", journal)
            copy_tree(source / "nora-mcp", install_root / "apps/nora-mcp", journal)
            retained_config = restore_retained_config(install_root, journal)
            retained_identity = _recovery.identity(retained_config)
            retained_digest = _recovery.digest(retained_config) if retained_config.exists() else None
            mark_bundled_dependencies(source, install_root, manifest, journal)
            journal.checkpoint('tavern_apply', 'result')
            event("task", stage_id="install_verify", milestone=1, task="启动并检查酒馆")
            log("准备并启动本地 Tavern")
            runtime_attempted = True
            runtime = start_tavern(hermes_home, install_root, args.port, journal, bool(getattr(args, 'source_root', None)))
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
                system.record_initialization(hermes_home, install_root, manifest, proof, journal=journal)
            write_install_receipt(install_root, manifest, journal)
            if retained_identity is not None:
                if _recovery.identity(retained_config) != retained_identity or _recovery.digest(retained_config) != retained_digest:
                    raise RuntimeError('保留配置在安装期间变化，未删除原文件')
                retained_config.unlink()
            event("milestone", index=1, state="done", task="酒馆安装检查完成")
            event("task", task="系统已安装，等待配置模型和连接 ClawChat")
            for index, item in enumerate(journal.record['targets']): journal.archive_exchanges(item, index)
            journal.checkpoint('commit', 'result')
            journal.record['status'] = 'installed'
            journal.checkpoint('apply', 'result')
        except Exception as error:
            # Freeze the actual failure while the launch log and failed tree
            # still exist. Cleanup and persistence failures remain secondary.
            error._diagnostic_missing = [*getattr(error, '_diagnostic_missing', ()), *journal.record.get('missingReasons', ())]
            _operation_evidence.freeze(error, nora_home=nora_home, operation_id=operation_id,
                install_root=install_root, context={'stage': 'first_install'})
            try: journal.checkpoint('apply', 'failed')
            except Exception as recording:
                error.secondary_errors = [*getattr(error, 'secondary_errors', ()), recording]
            event("milestone", index=1, state="error", task="安装失败")
            log("安装失败，恢复安装前的程序和 Hermes 配置")
            try:
                restored = journal.restore(stop=(lambda: stop_install_runtime(install_root)) if runtime_attempted else None)
            except Exception as restoration:
                restored = {'status': 'recovery_failed', 'errors': [restoration],
                    'unrestored': [{'namespace': item['namespace'], 'path': item['path'], 'reason': 'recovery_interrupted'}
                        for item in journal.record['targets'] if item['phase'] != 'restored']}
            error.secondary_errors = [*getattr(error, 'secondary_errors', ()), *restored['errors']]
            error.first_install_recovery = {'operationId': operation_id, 'journalPath': str(journal.file),
                'targetDigest': journal.record['targetDigest'], 'status': restored['status'],
                'unrestored': restored['unrestored'], 'hermesRuntimeVerified': dedicated}
            _operation_evidence.freeze(error, nora_home=nora_home, operation_id=operation_id,
                install_root=install_root, context={'stage': 'restoring'})
            if restored['status'] == 'restored':
                event("milestone", index=0, state="pending", task="安装已回滚")
            else: event("milestone", index=0, state="error", task="安装恢复未完成，已保留恢复记录")
            raise

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


def install(args) -> dict:
    context = {}
    operation_id = os.environ.get('NORA_OPERATION_ID') or str(uuid.uuid4())
    try:
        return _install(args, operation_id, context)
    except Exception as error:
        if context and not getattr(error, 'first_install_recovery', None):
            _operation_evidence.freeze(error, nora_home=context['nora_home'], operation_id=operation_id,
                install_root=context['install_root'], context={'stage': 'first_install'})
        raise


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
    operation_cli = module_at('nora_first_install_operation_cli', _control_path.with_name('operation_cli.py'))
    operation_cli.ensure_operation('install', nora_home=args.nora_home or os.environ.get('NORA_TAVERN_HOME'))
    install(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = _error_diagnostics.exception_diagnostic(error, project_root=ROOT)
        event("diagnostic", component="installer", error=detail)
        event("error", message=detail["message"], code=detail["code"])
        import traceback
        traceback.print_exc(file=sys.stderr)
        print("[nora-tavern-install] 安装失败：" + str(error), file=sys.stderr)
        raise SystemExit(1)
