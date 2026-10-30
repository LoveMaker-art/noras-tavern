#!/usr/bin/env python3
"""Direct Tavern updater: backup, replace, start."""
import argparse
from contextlib import contextmanager
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from managed_context import agents_document, install_agents, snapshot_agents, restore_agents
# These defaults are also the updater module's public compatibility interface.
from bootstrap import default_hermes_home, default_install_root, resolve_update_target, managed_instance, filesystem_path, validate_partial_repair, verify_metadata, publication_tag, TAG_PATTERN

UPDATE_CHECK_JOB_NAME = "Nora Tavern daily update check (09:00 Hermes timezone)"
UPDATE_CHECK_SCRIPT = "nora-tavern-update-check.py"
UPDATE_CHECK_SCHEDULE = "0 9 * * *"
UPDATE_CHECK_FILES = (UPDATE_CHECK_SCRIPT, "nora-tavern-card-send.py", "nora-instance.py")
NORA_USER_CHAR_LIMIT = 2000
HOST_HOOK = Path("hooks/tavern-liveware-register")
MANAGED_BACKUP_FILES = ("SOUL.md", "SOUL.nora-tavern.example.md",
                        "nora-installation.json", "cron/jobs.json", "clawchat-skills")


def log(message):
    print("[tavern-updater] " + message, file=sys.stderr, flush=True)


def safe(path):
    value = Path(path).expanduser().absolute()
    if value == Path("/"):
        raise RuntimeError("拒绝使用根目录")
    return value


def _space_error(code, message):
    error = RuntimeError(message)
    error.code = code
    return error


def _space_redirect(info):
    # Python 3.11 on Windows has no Path.is_junction(). Junctions and other
    # reparse points must not redirect a capacity check to another volume.
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))


def _space_path(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or path == Path(path.anchor):
        raise _space_error('SPACE_PATH_UNSAFE', '空间检查路径不安全，尚未替换程序或数据。')
    current = Path(path.anchor)
    nearest = current
    for index, part in enumerate(path.parts[1:]):
        current = current / part
        try:
            info = Path(filesystem_path(current)).lstat()
        except FileNotFoundError:
            break
        if _space_redirect(info) or (index < len(path.parts)-2 and not stat.S_ISDIR(info.st_mode)):
            raise _space_error('SPACE_PATH_UNSAFE', '空间检查路径包含链接或非目录，尚未替换程序或数据。')
        nearest = current
    return path, nearest


def _space_measure(path, links):
    """Measure copytree's payload without reading file contents or following links."""
    payload, entries = 0, 0
    pending = [path]
    while pending:
        current = pending.pop()
        info = Path(filesystem_path(current)).lstat()
        entries += 1
        if _space_redirect(info):
            if links != 'preserve' or not stat.S_ISLNK(info.st_mode):
                raise _space_error('SPACE_PATH_UNSAFE', '待备份目录含不安全链接，尚未替换程序或数据。')
            # Program copytree(symlinks=True) copies the link, never its target.
            payload += len(os.fsencode(os.readlink(filesystem_path(current))))
        elif stat.S_ISREG(info.st_mode):
            payload += info.st_size
        elif stat.S_ISDIR(info.st_mode):
            with os.scandir(filesystem_path(current)) as children:
                pending.extend(current / child.name for child in children)
            after = Path(filesystem_path(current)).lstat()
            if ((info.st_dev, info.st_ino, info.st_mtime_ns) !=
                    (after.st_dev, after.st_ino, after.st_mtime_ns) or _space_redirect(after)):
                raise _space_error('SPACE_UNCONFIRMED', '空间检查期间目录发生变化，请重新检查；尚未替换程序或数据。')
        else:
            raise _space_error('SPACE_PATH_UNSAFE', '待备份目录含特殊文件，尚未替换程序或数据。')
    return payload, entries


def check_update_space(copies, *, disk_usage=None, volume_identity=None):
    """Admit *future* copies per destination volume, never delete to make room.

    Each task contains source (or a known in-memory byte length), destination, a safe purpose label, links
    ('reject' for user state; 'preserve' for program copytree), and optional.
    Already extracted candidates and old trees moved by rename are omitted by
    the caller. Metadata restoration copies are listed on their target volume.
    Reserve is 10% of logical payload + 4096 bytes per entry + 65536 bytes per
    target volume for allocation rounding and transaction writes. This is a
    conservative admission estimate, not a guarantee against concurrent writes
    or a filesystem with unusual allocation units; actual ENOSPC still fails.
    Calling again remeasures everything, including data added before stopping.
    The returned/error receipt contains quantities and purpose labels only.
    """
    query = disk_usage or shutil.disk_usage
    identity = volume_identity or (lambda path: Path(filesystem_path(path)).stat().st_dev)
    volumes = {}
    try:
        for task in copies:
            if (not isinstance(task, dict) or set(task) - {'source', 'bytes', 'destination', 'label', 'links', 'optional'}
                    or not {'destination', 'label'} <= set(task)
                    or ('source' in task) == ('bytes' in task)
                    or ('bytes' in task and (type(task['bytes']) is not int or task['bytes'] < 0))
                    or not isinstance(task['label'], str)
                    or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', task['label'])
                    or task.get('links', 'reject') not in ('reject', 'preserve')
                    or type(task.get('optional', False)) is not bool):
                raise _space_error('SPACE_PATH_UNSAFE', '空间检查任务无效，尚未替换程序或数据。')
            source = _space_path(task['source'])[0] if 'source' in task else None
            destination, ancestor = _space_path(task['destination'])
            if source is not None and (destination == source or destination.is_relative_to(source)):
                raise _space_error('SPACE_PATH_UNSAFE', '备份目标不能位于待备份目录中，尚未替换程序或数据。')
            if not Path(filesystem_path(ancestor)).is_dir():
                ancestor = ancestor.parent
            key = identity(ancestor)
            if key not in volumes:
                usage = query(filesystem_path(ancestor))
                if (any(type(getattr(usage, field, None)) is not int or getattr(usage, field) < 0
                        for field in ('total', 'used', 'free')) or usage.free > usage.total):
                    raise _space_error('SPACE_UNCONFIRMED', '无法确认目标磁盘可用空间，尚未替换程序或数据。')
                volumes[key] = {'volume': len(volumes)+1, 'copyBytes': 0, 'entries': 0,
                                'freeBytes': usage.free, 'copies': []}
            if source is None:
                payload, entries = task['bytes'], 1
            else:
                try:
                    Path(filesystem_path(source)).lstat()
                except FileNotFoundError:
                    if not task.get('optional', False):
                        raise
                    payload, entries = 0, 0
                else:
                    # Once observed present, a disappearing source/child is an
                    # unconfirmed measurement, not an optional zero-byte copy.
                    payload, entries = _space_measure(source, task.get('links', 'reject'))
            volume = volumes[key]
            volume['copyBytes'] += payload
            volume['entries'] += entries
            volume['copies'].append({'label': task['label'], 'bytes': payload, 'entries': entries})
    except OSError as cause:
        raise _space_error('SPACE_UNCONFIRMED', '无法读取备份目录或确认磁盘空间，尚未替换程序或数据。') from cause
    report = {'schema': 'nora-update-space/1', 'status': 'sufficient', 'volumes': list(volumes.values())}
    for volume in report['volumes']:
        volume['reserveBytes'] = (volume['copyBytes']+9)//10 + 4096*volume['entries'] + 65536
        volume['requiredBytes'] = volume['copyBytes'] + volume['reserveBytes']
    if any(volume['freeBytes'] < volume['requiredBytes'] for volume in report['volumes']):
        report['status'] = 'insufficient'
        error = OSError(errno.ENOSPC, '目标磁盘空间不足以保留完整备份和恢复临时副本；尚未替换程序或数据。')
        error.code, error.space_report = 'ENOSPC', report
        raise error
    return report


def update_space_tasks(hermes_home, install_root, backup, work, *, managed,
                       runtime_changed, migration, restore_only=False, journal=None,
                       service_snapshot=None):
    """Match the actual backup copies and possible metadata restore temporaries.

    Program and original-state rollback use same-volume rename. Candidates have
    already been materialized and are reflected in disk_usage's free space.
    Legacy preparation and failed-conversion fallback can coexist, so reserve
    two original-state copies before conversion. Rechecking uses current sizes.
    """
    pairs = [(hermes_home / 'config.yaml', backup / 'host/config.yaml')]
    pairs += [(hermes_home / name, backup / 'agents-rollback' / name)
              for name in ('AGENTS.md', 'AGENTS.md.bak')]
    pairs += [(install_root / 'tavern-updates' / name, backup / 'host/update-receipts' / name)
              for name in ('installed.json', 'installed-manifest.json', 'nora-system.json')]
    pairs.append((install_root / 'tavern-state/native-runtime/dependencies.json',
                  backup / 'host/native-runtime/dependencies.json'))
    if managed:
        pairs += [(hermes_home / name, backup / 'managed/targets' / name)
                  for name in MANAGED_BACKUP_FILES]
        pairs += [(hermes_home / 'scripts' / name, backup / 'managed/targets/scripts' / name)
                  for name in UPDATE_CHECK_FILES]
    # A stopped managed cron store may have a new run timestamp. The journal
    # seals that logical equivalent in a separate snapshot before any write.
    tasks = []
    if managed and not restore_only:
        tasks.append({'source': hermes_home / 'cron/jobs.json',
                      'destination': backup / 'runtime-state/cron-jobs.json',
                      'label': 'cron-offline-snapshot', 'optional': True})
    if restore_only and journal is not None:
        pairs = [(target, journal.metadata_saved(target, saved))
                 for target, saved in journal.metadata_items()]
    for target, saved in pairs:
        if not restore_only:
            tasks.append({'source': target, 'destination': saved,
                          'label': 'metadata-backup', 'optional': True, 'links': 'preserve'})
        tasks.append({'source': saved if restore_only else target,
                      'destination': target.parent / '.nora-space-restore',
                      'label': 'metadata-restore', 'optional': True, 'links': 'preserve'})
    if service_snapshot is not None:
        descriptor = service_snapshot.get('descriptor') if isinstance(service_snapshot, dict) else None
        if (not isinstance(descriptor, dict) or not isinstance(descriptor.get('file'), str)
                or not isinstance(service_snapshot.get('text'), str)):
            raise _space_error('SPACE_UNCONFIRMED', '无法确认受管服务配置备份和恢复空间，尚未替换安装。')
        if not restore_only:
            tasks.append({'bytes': len((json.dumps(service_snapshot, ensure_ascii=False, indent=2) + '\n').encode()),
                          'destination': backup / 'host/service.json', 'label': 'service-backup'})
        service_file = Path(descriptor['file'])
        # Atomic service replacement/restoration needs a temporary on the
        # service's own volume, which can differ from the installation volume.
        tasks.append({'bytes': len(service_snapshot['text'].encode()),
                      'destination': service_file.parent / '.nora-space-service',
                      'label': 'service-restore'})
    if runtime_changed:
        state = install_root / 'tavern-state'
        if migration:
            tasks += [{'source': state, 'destination': work / relative,
                       'label': label, 'links': 'reject'} for relative, label in (
                           ('prepared/state', 'legacy-preparation'),
                           ('prepared-fallback/state', 'legacy-fallback'))]
        else:
            tasks.append({'source': state, 'destination': backup / 'state',
                          'label': 'state-snapshot', 'links': 'reject'})
    return tasks


def atomic(path, data, mode=0o600):
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


def json_write(path, value):
    atomic(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())


def module_at(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        if sys.modules.get(name) is module:
            del sys.modules[name]
        raise
    return module


_diagnostics_path = HERE.parent / "installer/error_diagnostics.py"
if not _diagnostics_path.is_file():
    _diagnostics_path = HERE.parent / "shared/error_diagnostics.py"
_error_diagnostics = module_at("nora_update_error_diagnostics", _diagnostics_path)
_control_path = HERE.parent / 'installer/operation_control.py'
if not _control_path.is_file(): _control_path = HERE.parent / 'shared/operation_control.py'
_operation_control = module_at('nora_update_operation_control', _control_path)
_evidence_path = HERE.parent / 'installer/operation_evidence.py'
if not _evidence_path.is_file(): _evidence_path = HERE.parent / 'shared/operation_evidence.py'
_operation_evidence = module_at('nora_update_operation_evidence', _evidence_path)
_standalone_execution = None


@contextmanager
def guarded_standalone_execution(home, root):
    """Use the same standalone transaction under the shared task's live guard."""
    global _standalone_execution
    gate = _operation_control.require_operation()
    gate.assert_active()
    if _standalone_execution is not None:
        raise RuntimeError('已有独立更新上下文，禁止创建第二个执行者。')
    verified = resolve_update_target(home, root)
    if (verified[0] / 'nora-instance.json').exists():
        raise RuntimeError('受管实例必须使用已有系统更新后端，未改为独立更新。')
    _standalone_execution = {'home': verified[0], 'root': verified[1], 'lock': None, 'guarded': True}
    try:
        yield
    finally:
        _standalone_execution = None


def standalone_run(command, *, input=None, capture_output=False, timeout=None, check=False, **options):
    state = _standalone_execution
    if not state or state.get('guarded') is not True:
        raise RuntimeError('独立更新必须通过现有任务执行维护进程。')
    # The existing task guard owns every maintenance child and its close event.
    return _operation_control.managed_run(command, input=input, capture_output=capture_output,
        timeout=timeout, check=check, **options)


def resource_incomplete(message):
    error = RuntimeError(message)
    error.code = 'RESOURCE_INCOMPLETE'
    return error


def recovery_module():
    # The updater module carries the same standalone helper as the desktop.
    # Load before any operations-tree swap, so recovery needs no missing ops.
    path = HERE.parent / "installer/update_recovery.py"
    if not path.is_file():
        path = HERE / "recovery.py"
    return module_at("tavern_update_recovery", path)


def remove(path):
    path = Path(filesystem_path(path))
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


BACKUP_RECEIPT = "nora-update-backup.json"


def backup_root_safe(home, root):
    if root not in (home / "tavern-backups", home / "tavern-updates/backups"):
        return False
    current = home
    for part in root.relative_to(home).parts:
        current = current / part
        if current.is_symlink():
            return False
    return True


def record_backup(home, backup, status):
    home, backup = Path(home).absolute(), Path(backup).absolute()
    if not backup_root_safe(home, backup.parent) or backup.is_symlink() or not backup.is_dir():
        raise RuntimeError("invalid owned backup path")
    if status not in ("prepared", "committed", "restored", "recovery-failed"):
        raise RuntimeError("invalid backup lifecycle status")
    json_write(backup / BACKUP_RECEIPT, {
        "schema": "nora-update-backup/1", "owner": "nora-tavern-updater",
        "installRoot": str(home.resolve()), "backupId": backup.name,
        "status": status, "updatedAt": int(time.time()), "mayContainUserData": True,
    })


def backup_receipt(home, backup):
    marker = backup / BACKUP_RECEIPT
    if backup.is_symlink() or not backup.is_dir() or marker.is_symlink():
        return None
    try:
        before = marker.stat()
        if not marker.is_file() or before.st_size > 65536:
            return None
        value = json.loads(marker.read_text(encoding="utf-8"))
        after = marker.stat()
        if (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_size) != (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_size):
            return None
        if value.get("schema") != "nora-update-backup/1" or value.get("owner") != "nora-tavern-updater" \
                or value.get("installRoot") != str(home.resolve()) or value.get("backupId") != backup.name:
            return None
        return value
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def prune_backup_history(home, keep):
    home = Path(home).absolute()
    primary = home / "tavern-backups"
    keep = Path(keep).absolute()
    if keep.parent != primary or not keep.is_dir() or keep.is_symlink() or primary.is_symlink():
        raise RuntimeError(f"refusing to prune backups with invalid keep path: {keep}")

    removed, retained = [], []
    if (backup_receipt(home, keep) or {}).get("status") != "committed":
        return {"status": "retained", "kept": str(keep), "removed": [], "reason": "current-backup-unverified"}
    # Retiring the last physical source requires the guard-bound closure. A
    # failed metadata read retains backups; it is never a cleanup permission.
    try:
        helper=recovery_module();references=helper.effect_closure_refs(home.parent/'hermes',home)
        closed=set()
        for ref in references:
            proof=helper.read_object(helper.safe_path(home.parent,ref['path']),max_bytes=helper.MAX_TRANSACTION_BYTES)
            closed.update(item['record']['operationId'] for item in proof['closed'])
        operations=home.parent/'installer/operations'
        if operations.exists():
            for directory in operations.iterdir():
                if not re.fullmatch('[a-f0-9-]{36}',directory.name,re.I):continue
                file=helper.safe_path(home.parent,'installer/operations/'+directory.name+'/runtime-bootstrap.json')
                if not helper._io_path(file).exists():continue
                runtime=helper.read_object(file,max_bytes=4*1024*1024)
                if runtime.get('status')=='rolled-back' and runtime.get('originalPartial') and directory.name not in closed:
                    return {'status':'retained','kept':str(keep),'removed':[], 'reason':'history-proof-pending'}
    except (OSError,ValueError,TypeError,KeyError,RuntimeError):
        return {'status':'retained','kept':str(keep),'removed':[], 'reason':'history-proof-unconfirmed'}
    for root in (primary, home / "tavern-updates" / "backups"):
        if not backup_root_safe(home, root) or not root.is_dir():
            continue
        for candidate in sorted(root.iterdir()):
            if candidate.absolute() == keep:
                continue
            receipt = backup_receipt(home, candidate)
            if not receipt or receipt.get("status") != "committed":
                retained.append({"path": str(candidate), "reason": "unowned-or-recovery-protected"})
                continue
            before = candidate.stat()
            if backup_receipt(home, candidate) != receipt or candidate.is_symlink() or candidate.stat() != before:
                retained.append({"path": str(candidate), "reason": "changed-during-check"})
                continue
            remove(candidate)
            removed.append(str(candidate))
    return {"status": "pruned", "kept": str(keep), "removed": removed, "retained": retained}


def port_open(port=8799):
    with socket.socket() as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


@contextmanager
def installer_lock(home):
    from runtime_lock import installation_lock
    state = _standalone_execution
    with installation_lock(home, "tavern-installer.lock", blocking=state is None, descriptor=state is not None) as lease:
        if lease is False:
            raise RuntimeError('另一项安装或更新操作正在进行，请等待原任务结束。')
        if state is not None:
            if Path(home).resolve() != state['root'] or state['lock'] is not None:
                raise RuntimeError('独立更新目录或锁状态不一致。')
            state['lock'] = lease
        try:
            yield
        finally:
            if state is not None:
                state['lock'] = None


def python_layout(app):
    app = Path(app)
    if (app / "native-runtime.json").is_file():
        return None
    for entry, web in (
        ("backend/server.py", "frontend"),
        ("server.py", "web"),
    ):
        if (app / entry).is_file():
            if entry == "backend/server.py" and not (app / web).is_dir():
                web = "backend/web"
            return {"entry": entry, "web": web}
    return None


def path_is_within(path, root):
    return path == root or root in path.parents


def runtime_process_belongs_to_app(app, cwd, argv):
    app = Path(app).resolve()
    cwd = Path(cwd).resolve()
    for value in argv:
        if not value.endswith(("server.py", "server.js")):
            continue
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = cwd / candidate
        if path_is_within(candidate.resolve(), app):
            return True
    return False


def process_rows(app):
    app = Path(app).resolve()
    if python_layout(app) is None:
        # Native installations share the runtime's OS reader. /proc alone is
        # not an absence proof on Windows or macOS.
        processes = module_at('updater_native_process_reader', HERE / 'runtime_process.py')
        return [record['pid'] for record in processes.find_processes(app / 'engine/sillytavern/server.js')]
    rows = []
    if not Path("/proc").is_dir():
        return rows
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cwd = Path(entry / "cwd").resolve()
            argv = [os.fsdecode(value) for value in (entry / "cmdline").read_bytes().split(b"\0") if value]
        except OSError:
            continue
        if not runtime_process_belongs_to_app(app, cwd, argv):
            continue
        rows.append(int(entry.name))
    return rows


def stop_unmanaged(app):
    app = Path(app)
    if (app / 'native-runtime.json').is_file() and (app / 'native_lifecycle.py').is_file():
        pids = process_rows(app)
        # Reuse the runtime's saved argv/cwd/config, OS identity and confirmed
        # process-close checks. Unknown ownership is a stop error, not permission
        # to rename a still-running installation or signal an unrelated PID.
        standalone_runtime(app.parent.parent).stop_run()
        if process_rows(app):
            raise RuntimeError('原酒馆停止后仍有归属本安装的进程，未替换程序。')
        return pids
    pids = process_rows(app)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 8
    # A terminated child can remain as a zombie in /proc until its parent
    # reaps it.  A zombie no longer owns the Tavern listener and must not keep
    # the update in maintenance for the full timeout.
    while time.monotonic() < deadline and any(pid in process_rows(app) for pid in pids):
        time.sleep(0.1)
    remaining = set(process_rows(app))
    for pid in pids:
        if pid in remaining:
            os.kill(pid, signal.SIGKILL)
    return pids


def _legacy_proc_candidate(entry, bound):
    if bound:
        return True
    try:
        name = (entry / 'comm').read_text().strip().casefold()
        if not name.startswith(('python', 'node', 'pypy')):
            return False
        try:
            return hasattr(os, 'getuid') and entry.stat().st_uid == os.getuid()
        except OSError:
            # A readable runtime kind with an unreadable owner is unknown.
            return True
    except (FileNotFoundError, OSError):
        return False


def _legacy_proc_processes(app, proc):
    rows = []
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cwd = (entry / 'cwd').resolve(strict=True)
        except FileNotFoundError:
            continue
        except OSError:
            cwd = None
        bound = cwd is not None and path_is_within(cwd, app)
        try:
            argv = [os.fsdecode(value) for value in (entry / 'cmdline').read_bytes().split(b'\0') if value]
        except FileNotFoundError:
            continue
        except OSError as error:
            if _legacy_proc_candidate(entry, bound):
                raise RuntimeError('旧酒馆候选进程不可读，未确认停服，原数据尚未迁移。') from error
            continue
        if not argv and _legacy_proc_candidate(entry, bound):
            raise RuntimeError('旧酒馆候选进程命令为空，未确认停服，原数据尚未迁移。')
        scripts = [value for value in argv if value.endswith(('server.py', 'server.js'))]
        if not scripts:
            continue
        if cwd is None and any(not Path(value).is_absolute() for value in scripts):
            raise RuntimeError('旧酒馆候选进程目录不可读，未确认停服，原数据尚未迁移。')
        if any(path_is_within((Path(value) if Path(value).is_absolute() else cwd / value).resolve(), app)
               for value in scripts):
            rows.append({'pid': int(entry.name)})
    return rows


def legacy_migration_processes(app):
    """Find only root-bound server actors; an unreadable candidate is unknown."""
    app = Path(app).resolve()
    try:
        import psutil
    except ImportError:
        proc = Path('/proc')
        if proc.is_dir():
            return _legacy_proc_processes(app, proc)
        raise RuntimeError('无法核验旧 Python 酒馆进程，原数据尚未迁移。')
    rows = []
    current_user = psutil.Process().username().casefold()
    for process in psutil.process_iter(['pid', 'name']):
        name = str(process.info.get('name') or '').casefold()
        runtime_name = name.startswith(('python', 'node')) or name in ('pypy', 'pypy3')
        try:
            argv = process.cmdline()
        except psutil.NoSuchProcess:
            continue
        except (psutil.AccessDenied, OSError) as error:
            if not runtime_name:
                continue
            try:
                owner = process.username().casefold()
            except psutil.NoSuchProcess:
                continue
            except (psutil.AccessDenied, OSError):
                owner = current_user
            if owner == current_user:
                raise RuntimeError('旧酒馆候选进程不可读，未确认停服，原数据尚未迁移。') from error
            continue
        if not argv and runtime_name:
            try:
                if process.status() == psutil.STATUS_ZOMBIE:
                    continue
                if process.username().casefold() == current_user:
                    raise RuntimeError('旧酒馆候选进程命令为空，未确认停服，原数据尚未迁移。')
            except psutil.NoSuchProcess:
                continue
            except (psutil.AccessDenied, OSError) as error:
                raise RuntimeError('旧酒馆候选进程身份不可确认，原数据尚未迁移。') from error
        scripts = [value for value in argv if value.endswith(('server.py', 'server.js'))]
        if not scripts:
            continue
        cwd = None
        if any(not Path(value).is_absolute() for value in scripts):
            try:
                cwd = Path(process.cwd()).resolve()
            except psutil.NoSuchProcess:
                continue
            except (psutil.AccessDenied, OSError) as error:
                raise RuntimeError('旧酒馆候选进程目录不可读，未确认停服，原数据尚未迁移。') from error
        if not any(path_is_within((Path(value) if Path(value).is_absolute() else cwd / value).resolve(), app)
                   for value in scripts):
            continue
        try:
            if process.status() == psutil.STATUS_ZOMBIE:
                continue
            if process.username().casefold() != current_user:
                raise RuntimeError('旧酒馆进程属于其他系统用户，原数据尚未迁移。')
            rows.append({'pid': process.pid, 'argv': argv, 'created': process.create_time()})
        except psutil.NoSuchProcess:
            continue
        except (psutil.AccessDenied, OSError) as error:
            raise RuntimeError('旧酒馆进程身份不可确认，原数据尚未迁移。') from error
    return rows


def stop_legacy_for_migration(app, service):
    """A legacy state copy is allowed only after its writer is confirmed closed."""
    if service is None:
        error = RuntimeError('旧 Python 酒馆缺少可恢复的服务管理，原数据尚未迁移。')
        error.code = 'LEGACY_RUNTIME_UNSUPPORTED'
        raise error
    service.stop()
    info = service.info()
    if (not isinstance(info, dict) or type(info.get('pid')) is not int or info['pid'] != 0
            or str(info.get('statename', '')).upper() not in ('STOPPED', 'EXITED')):
        raise RuntimeError('旧酒馆服务未确认停服，原数据尚未迁移。')
    if legacy_migration_processes(app):
        raise RuntimeError('仍有旧酒馆进程运行，原数据尚未迁移。')


def run(command, *, cwd=None, env=None, timeout=None, capture=False):
    command=[str(value) for value in command]
    name=Path(command[0]).name.lower() if command else ''
    if name in ('npm', 'npm.cmd', 'npm.exe'):
        raise resource_incomplete('更新资源缺少完整依赖，当前安装尚未替换。请重新下载完整正式安装包。')
    if name in ('node','node.exe') and command[1:]==['--version']:
        # Exact read-only probe; arbitrary Node programs use the owned guard.
        return subprocess.run(command,cwd=cwd,env=env,timeout=timeout,check=True,text=True,capture_output=capture)
    if name in ('hermes','hermes.exe'):
        entry=Path(command[0])
        if not entry.is_absolute():raise RuntimeError('维护任务必须使用 Nora 自带的 Hermes CLI。')
        command=[sys.executable,'-B','-c',
            'import runpy,sys; p=sys.argv.pop(1); sys.argv[0]=p; runpy.run_path(p,run_name="__main__")',*command]
    execute = standalone_run if _standalone_execution is not None else _operation_control.managed_run
    return execute(
        command,
        cwd=cwd,
        env=env,
        timeout=timeout,
        check=True,
        text=True,
        capture_output=capture,
    )


def file_sha(path):
    digest = hashlib.sha256()
    with Path(filesystem_path(path)).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def same_file(left, right):
    try:
        return Path(left).is_file() and Path(right).is_file() and file_sha(left) == file_sha(right)
    except OSError:
        return False


def world_data_inventory(state, *, full=False):
    """Hash existing story resources, excluding logs and runtime bookkeeping."""
    state = Path(filesystem_path(state))
    native = Path(state) / "native"
    result = {}
    if not native.is_dir():
        return result
    for user in native.iterdir():
        if not user.is_dir():
            continue
        directories = ("nora-world-core/worlds", "chats", "group chats", "worlds", "characters")
        if full:
            directories += ("backups", "nora-story-ledger", "nora-world-core/operations")
        for relative in directories:
            directory = user / relative
            if not directory.is_dir():
                continue
            for file in directory.rglob("*"):
                if file.is_file():
                    result[str(file.relative_to(state))] = file_sha(file)
    return result


def verify_worlds(app, state):
    native = Path(state) / "native"
    if not native.is_dir():
        return {}
    node = shutil.which("node")
    if not node:
        raise RuntimeError("无法验证原有世界：未找到 Node.js")
    def node_path(value):
        # Node's module loader cannot resolve Win32 device-prefixed entry paths.
        value = str(value)
        if sys.platform == "win32":
            if value.startswith("\\\\?\\UNC\\"):
                return "\\\\" + value[8:]
            if value.startswith("\\\\?\\"):
                return value[4:]
        return value
    try:
        result = run([node_path(value) for value in (node, HERE / "verify-worlds.mjs", app, native)],
                     capture=True, timeout=120)
    except subprocess.CalledProcessError as error:
        raise RuntimeError("世界读取验证失败：" + (error.stderr or "验证程序退出异常").strip()[:1000]) from error
    return json.loads(result.stdout)


def verify_story_inventory(state, inventory, *, exact=False):
    current = world_data_inventory(state, full=exact)
    changed = [name for name, digest in inventory.items() if current.get(name) != digest]
    if changed:
        raise RuntimeError("原有世界或会话文件发生变化，更新验收失败：" + "; ".join(changed[:5]))
    if exact and current != inventory:
        raise RuntimeError("部分安装修复改变了原有剧情数据清单，未接受此次更新。")


def verify_preserved_worlds(app, state, inventory, worlds, *, exact=False):
    verify_story_inventory(state, inventory, exact=exact)
    loaded = verify_worlds(app, state)
    if exact and loaded != worlds:
        raise RuntimeError("部分安装修复改变了原有世界或会话身份，未接受此次更新。")
    for user, expected in worlds.items():
        actual = {world["worldId"]: world for world in loaded.get(user, [])}
        if any(actual.get(world["worldId"]) != world for world in expected):
            raise RuntimeError("原有世界或会话未能完整加载，更新验收失败：" + user)
    return {"status": "verified", "worlds": sum(len(value) for value in worlds.values()),
            "files": len(inventory)}


def verify_partial_configuration(home, root, snapshot):
    """A program repair does not authorize rewriting existing user settings."""
    if not snapshot:
        return
    for name, file in (('config', Path(home) / 'config.yaml'),
                       ('nativeConfig', Path(root) / 'tavern-state/native-runtime/config.yaml')):
        expected = snapshot['bindings'][name]
        # A missing native config can be initialized by the normal runtime.
        if expected is not None and (file.is_symlink() or not file.is_file() or file_sha(file) != expected):
            raise RuntimeError('部分安装修复改变了原有配置，未接受此次更新：' + file.name)


def verify_partial_baseline(home, root, plan, snapshot, recovery):
    """Restore known original bytes without executing the failed candidate."""
    baseline = plan.get('partialBaseline')
    state = plan.get('state')
    if baseline is None and isinstance(state, dict) and state.get('phase') in ('pending', 'untouched'):
        return  # The stop gate failed before a state snapshot or any swap.
    keys = {'schema', 'partialRepair', 'stateDigest', 'storyInventory', 'worlds',
            'readerManifestSha256', 'readerCommit'}
    if (not isinstance(baseline, dict) or set(baseline) != keys
            or baseline.get('schema') != 'nora-managed-partial-repair-baseline/1'
            or baseline.get('partialRepair') != snapshot
            or not isinstance(state, dict) or baseline.get('stateDigest') != state.get('savedDigest')
            or not re.fullmatch(r'[a-f0-9]{64}', str(baseline.get('stateDigest') or ''))
            or not re.fullmatch(r'[a-f0-9]{64}', str(baseline.get('readerManifestSha256') or ''))
            or not re.fullmatch(r'[a-f0-9]{40}', str(baseline.get('readerCommit') or ''))
            or not isinstance(baseline.get('storyInventory'), dict)
            or baseline.get('worlds') is not None and baseline['worlds'] != plan.get('worlds')):
        raise RuntimeError('部分安装的原数据或只读验收基线未封存，未确认恢复完成。')
    if recovery.digest(Path(root) / 'tavern-state') != baseline['stateDigest']:
        raise RuntimeError('部分安装恢复后的原数据不一致，未确认恢复完成。')
    verify_story_inventory(Path(root) / 'tavern-state', baseline['storyInventory'], exact=True)


def package_dependency_manifests(root):
    root = Path(root)
    try:
        package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError(f"无法读取生产依赖清单：{error}") from error
    dependencies = package.get("dependencies")
    if not isinstance(dependencies, dict):
        raise RuntimeError("生产依赖清单格式无效")
    manifests = []
    for name in sorted(dependencies):
        path = Path(name)
        if path.is_absolute() or not path.parts or ".." in path.parts:
            raise RuntimeError(f"生产依赖名称无效：{name}")
        manifests.append(str(path / "package.json"))
    return tuple(manifests)


def link_or_copy(source, target):
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)
    return target


def reuse_dependencies(target, current, lock_name, required):
    target = Path(target)
    current = Path(current)
    modules = target / "node_modules"
    if modules.is_dir() and all((modules / relative).is_file() for relative in required):
        return 'bundled'
    reusable = same_file(target / lock_name, current / lock_name) and all(
        (current / "node_modules" / relative).is_file() for relative in required
    )
    if reusable:
        shutil.copytree(current / "node_modules", modules, symlinks=True, copy_function=link_or_copy)
        return "reused"
    raise resource_incomplete('更新资源依赖不完整，且现有依赖不能安全复用；当前安装尚未替换。请重新下载完整正式安装包。')


def standalone_dependencies(source, target, lock_name, required):
    """Prepare a verified Linux component in private staging, before stopping.

    This is not a fallback for desktop updates: it requires the independently
    authenticated installation and its live lock, plus the installer's own
    temporary source directory. npm executes no package lifecycle scripts.
    """
    state = _standalone_execution
    lease = state.get('lock') if state else None
    if not sys.platform.startswith('linux') or lease is None or lease.closed:
        raise resource_incomplete('独立更新尚未取得安装目录锁，未准备依赖或停止服务。')
    source, target = Path(source), Path(target)
    staging = state['root'] / 'tavern-updates'
    if (source.name != 'source' or not source.parent.name.startswith('direct-')
            or source.parent.parent != staging or source.resolve() != source.absolute()
            or target not in (source / 'app/engine/sillytavern', source / 'nora-mcp')
            or target.resolve() != target.absolute()):
        raise RuntimeError('独立更新依赖目标不是已核验的临时程序目录。')
    lock = target / lock_name
    before = {name: file_sha(target / name) for name in ('package.json', lock_name)}
    value = json.loads(lock.read_text(encoding='utf-8'))
    if (value.get('lockfileVersion') not in (2, 3) or not isinstance(value.get('packages'), dict)
            or any(package.get('hasInstallScript') for package in value['packages'].values())):
        raise resource_incomplete('独立更新依赖清单需要额外安装脚本，尚未停止服务；请保留当前安装并反馈日志。')
    npm = shutil.which('npm')
    if not npm:
        raise resource_incomplete('独立更新需要现有 Node.js 对应的 npm，尚未停止服务或修改安装。')
    log('在临时目录准备锁定的 Linux 依赖，原服务继续运行')
    standalone_run([npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
        '--userconfig', os.devnull, '--cache', str(source.parent / 'npm-cache')],
        cwd=target, timeout=300, check=True, text=True)
    if (any(file_sha(target / name) != digest for name, digest in before.items())
            or any(not (target / 'node_modules' / name).is_file() for name in required)):
        raise resource_incomplete('新版依赖准备或清单校验未通过，尚未停止服务或替换安装。')
    return 'prepared-standalone'


def component_dependencies(source, target, current, lock_name, required):
    try:
        return reuse_dependencies(target, current, lock_name, required)
    except RuntimeError as error:
        if (getattr(error, 'code', None) != 'RESOURCE_INCOMPLETE'
                or _standalone_execution is None or not sys.platform.startswith('linux')):
            raise
        return standalone_dependencies(source, target, lock_name, required)


def materialize_staged_local_dependencies(source):
    """Copy reviewed file dependencies inside staging, without installation."""
    source = Path(source)
    native = module_at("prepared_native_lifecycle", source / "app/native_lifecycle.py")
    contract = native.RuntimeContract.from_dict(json.loads(
        (source / "app/native-runtime.json").read_text(encoding="utf-8"),
    ))
    runtime = native.NativeRuntime(source, source / "app", source / "tavern-state", contract)
    materialized = runtime.materialize_local_dependencies()
    if materialized:
        log("Tavern 本地依赖已准备为独立目录：" + ", ".join(materialized))


def prepare_dependencies(source, old_app, old_mcp, *, app_changed, mcp_changed, bundled=False):
    if bundled:
        for name, changed in (('app/engine/sillytavern', app_changed), ('nora-mcp', mcp_changed)):
            if not changed: continue
            target=Path(source)/name
            try: required=package_dependency_manifests(target)
            except (OSError, RuntimeError) as error:
                raise resource_incomplete('完整更新包缺少生产依赖清单，当前安装尚未替换。') from error
            if name == 'app/engine/sillytavern':
                package = json.loads((target / 'package.json').read_text(encoding='utf-8'))
                if any(isinstance(value, str) and value.startswith('file:') for value in package['dependencies'].values()):
                    try: materialize_staged_local_dependencies(source)
                    except (OSError, RuntimeError) as error:
                        raise resource_incomplete('完整更新包的本地生产依赖无法安全准备，当前安装尚未替换。') from error
            if any(not (target/'node_modules'/relative).is_file() for relative in required):
                raise resource_incomplete('完整更新包缺少生产依赖，当前安装尚未替换。请重新下载完整正式安装包。')
        return {"tavern": "bundled" if app_changed else 'unchanged', "mcp": "bundled" if mcp_changed else 'unchanged'}
    report = {"tavern": "unchanged", "mcp": "unchanged"}
    if app_changed:
        log("准备 Tavern 依赖")
        engine = source / "app/engine/sillytavern"
        report["tavern"] = component_dependencies(
            source,
            engine,
            Path(old_app) / "engine/sillytavern",
            "package-lock.json",
            package_dependency_manifests(engine),
        )
        # npm's Windows junctions contain staging paths. Materialize them while
        # those paths are still valid, before stopping services or moving app.
        materialize_staged_local_dependencies(source)
    if mcp_changed:
        log("准备 Nora MCP 依赖")
        report["mcp"] = component_dependencies(
            source,
            source / "nora-mcp",
            old_mcp,
            "npm-shrinkwrap.json",
            package_dependency_manifests(source / "nora-mcp"),
        )
    return report


def prepare_skills(source, destination, *, local=False):
    installer = module_at("simple_skill_installer", source / "ops/scripts/install-hermes-skills.py")
    return installer.prepare_skill_trees(source, destination, **({"local": True} if local else {}))


def prepare_host_hook_swap(hermes_home, source, prepared_root):
    origin = Path(source) / "ops" / HOST_HOOK
    required = ("HOOK.yaml", "handler.py", "run.sh")
    missing = [name for name in required if not (origin / name).is_file()]
    if missing:
        raise RuntimeError("发布包缺少 Tavern 启动钩子：" + ", ".join(missing))
    target = Path(hermes_home) / HOST_HOOK
    if trees_equal(origin, target):
        return None
    prepared_root = Path(prepared_root)
    prepared_root.mkdir(parents=True, exist_ok=True)
    prepared = prepared_root / HOST_HOOK.name
    shutil.copytree(origin, prepared, symlinks=False)
    return "host-hook-tavern-liveware-register", prepared, target


def hermes_model(hermes_home, source):
    try:
        model = module_at("release_native_model", source / "app/native_model_config.py")
        return model.load_model_config(hermes_home / "config.yaml")
    except Exception:
        return None


def legacy_model(home):
    try:
        from python_model import load_python_model
        return load_python_model(home)
    except Exception:
        return None


def migration_copy(hermes_home, install_root, source, work, layout):
    old_state = install_root / "tavern-state"
    prepared = work / "prepared/state"
    if old_state.is_dir():
        shutil.copytree(old_state, prepared, symlinks=False)
    else:
        prepared.mkdir(parents=True)
    legacy_source = prepared / 'python-source' if (prepared / 'python-source').is_dir() else prepared
    if not (legacy_source / 'productions').is_dir():
        # The converter explicitly supports Python production stores only.
        # This known input-format case may retain the entire sealed original;
        # failed processes, dependency errors and I/O errors may not.
        error = RuntimeError('旧数据不是受支持的 Python productions 格式，保留完整原数据。')
        error.code = 'LEGACY_MIGRATION_UNSUPPORTED'
        raise error
    options = {
        "hermesModel": hermes_model(hermes_home, source),
        "legacyModel": legacy_model(hermes_home),
        "legacyApp": str(install_root / "apps/tavern-runtime"),
        "legacyWeb": layout["web"],
    }
    options_path = work / "model-input.json"
    json_write(options_path, options)
    result = run(
        ["node", source / "ops/updater/prepare-state.mjs", prepared, source / "app", options_path],
        timeout=300,
        capture=True,
    )
    return prepared, json.loads(result.stdout)


def fallback_python_state(install_root, work, reason):
    old = install_root / "tavern-state"
    prepared = work / "prepared-fallback/state"
    if old.is_dir():
        # An unsupported legacy record must not turn into lost configuration.
        # Keep the complete state tree so Liveware identities, model settings,
        # Story Profile data and the original import material remain usable or
        # recoverable.  The native runtime can create its own missing layout.
        shutil.copytree(old, prepared, symlinks=False)
    else:
        prepared.mkdir(parents=True)
    report = {
        "status": "archived",
        "reason": reason,
        "importedWorlds": 0,
        "note": "原 Python 数据完整保存在更新备份中，可后续手动导入",
    }
    return prepared, report


def render_mcp(hermes_home, install_root, port=8799):
    try:
        import yaml
    except ImportError as error:
        raise RuntimeError("Hermes Python 缺少 PyYAML，无法写入 MCP 配置") from error
    path = hermes_home / "config.yaml"
    value = yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else {}
    value = {} if value is None else value
    if not isinstance(value, dict):
        raise RuntimeError("Hermes 配置格式无效，未修改配置")
    memory = value.setdefault("memory", {})
    if not isinstance(memory, dict):
        raise RuntimeError("Hermes 记忆配置格式无效，未修改配置")
    if "user_char_limit" not in memory:
        memory["user_char_limit"] = NORA_USER_CHAR_LIMIT
    elif type(memory["user_char_limit"]) is not int or memory["user_char_limit"] <= 0:
        raise RuntimeError("Hermes USER.md 容量配置无效，未修改配置")
    elif memory["user_char_limit"] in (1375, 1875):
        # Migrate previous defaults to the fixed target; repeated updates are idempotent.
        memory["user_char_limit"] = NORA_USER_CHAR_LIMIT
    servers = value.setdefault("mcp_servers", {})
    current = servers.get("nora") if isinstance(servers.get("nora"), dict) else {}
    env = current.get("env") if isinstance(current.get("env"), dict) else {}
    env.update({
        "NORA_MCP_PROJECT_ROOT": str(install_root / "apps/tavern-runtime"),
        "NORA_MCP_ST_ROOT": str(install_root / "apps/tavern-runtime/engine/sillytavern"),
        "NORA_MCP_STATE_ROOT": str(install_root / "tavern-state"),
        "NORA_MCP_NATIVE_DATA_ROOT": str(install_root / "tavern-state/native"),
        "NORA_MCP_USER_DATA_ROOT": str(install_root / "tavern-state/native/default-user"),
        "NORA_MCP_CONFIG_PATH": str(install_root / "tavern-state/native-runtime/config.yaml"),
        "NORA_MCP_UPLOAD_ROOT": str(install_root / "tavern-state/imports"),
        "NORA_MCP_BASE_URL": f"http://127.0.0.1:{port}",
        "NORA_MCP_MODE": "operator",
    })
    servers["nora"] = {
        **current,
        "command": shutil.which("node") or "node",
        "args": [str(install_root / "apps/nora-mcp/dist/server.js")],
        "env": env,
        "timeout": current.get("timeout", 420),
    }
    return yaml.safe_dump(value, allow_unicode=True, sort_keys=False).encode()


def merged_agents(home, managed):
    # Keep the public helper name for installer compatibility; no merging remains.
    return agents_document(managed)


def tree_inventory(root):
    root = Path(filesystem_path(root))
    if not root.is_dir():
        return None
    inventory = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        inventory[relative] = file_sha(path)
    return inventory


def trees_equal(left, right):
    return tree_inventory(left) == tree_inventory(right)


def changed_roots(manifest, changed_modules):
    modules = manifest.get("modules") or {}
    if not modules:
        return {"app", "ops", "nora-mcp"}
    roots = set()
    for module in changed_modules:
        for artifact in modules[module]["artifacts"]:
            roots.add(artifact.split("/", 1)[0])
    return roots


def dependency_marker(app_root):
    """Describe dependencies for an installed Tavern application tree.

    Release staging keeps the application below ``source/app`` while the
    installed tree itself is ``apps/tavern-runtime``.  Keeping this function
    explicitly on the installed-tree contract prevents callers from applying
    the staging prefix twice during a legacy-to-native upgrade.
    """
    result = run(["node", "--version"], capture=True)
    value = result.stdout.strip()
    if not value.startswith("v") or not value[1:].split(".", 1)[0].isdigit():
        raise RuntimeError("无法识别 Node.js 版本：" + value)
    return {
        "schema": 1,
        "lock_sha256": file_sha(Path(app_root) / "engine/sillytavern/package-lock.json"),
        "node_major": int(value[1:].split(".", 1)[0]),
        "prepared_at": int(time.time()),
    }


def roots_with_unmanaged_files(home, manifest):
    expected = set(manifest.get("artifacts") or {})
    roots = {
        "app": Path(home) / "apps/tavern-runtime",
        "ops": Path(home) / "apps/tavern-ops",
        "nora-mcp": Path(home) / "apps/nora-mcp",
    }
    changed = set()
    for name, root in roots.items():
        if not root.is_dir():
            changed.add(name)
            continue
        for directory, directories, files in os.walk(root):
            directories[:] = [entry for entry in directories if entry != "node_modules"]
            base = Path(directory)
            for filename in files:
                path = base / filename
                if path.is_symlink():
                    changed.add(name)
                    break
                relative = f"{name}/{path.relative_to(root).as_posix()}"
                if relative not in expected:
                    changed.add(name)
                    break
            if name in changed:
                break
    return changed


def copy_host_backup(hermes_home, install_root, backup, service_snapshot):
    host = Path(filesystem_path(backup / "host"))
    host.mkdir(parents=True)
    for name in ("config.yaml",):
        source = hermes_home / name
        if source.is_file():
            shutil.copy2(source, host / name)
    marker = install_root / "tavern-state/native-runtime/dependencies.json"
    if marker.is_file():
        (host / "native-runtime").mkdir()
        shutil.copy2(marker, host / "native-runtime/dependencies.json")
    if service_snapshot:
        json_write(host / "service.json", service_snapshot)
    receipts = host / "update-receipts"
    receipts.mkdir()
    for name in ("installed.json", "installed-manifest.json", "nora-system.json"):
        source = install_root / "tavern-updates" / name
        if source.is_file():
            shutil.copy2(source, receipts / name)


def restore_host(hermes_home, install_root, backup):
    host = Path(filesystem_path(backup / "host"))
    for name in ("config.yaml",):
        saved = host / name
        target = hermes_home / name
        if saved.is_file():
            shutil.copy2(saved, target)
        else:
            target.unlink(missing_ok=True)
    marker = install_root / "tavern-state/native-runtime/dependencies.json"
    saved_marker = host / "native-runtime/dependencies.json"
    if saved_marker.is_file():
        marker.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(saved_marker, marker)
    else:
        marker.unlink(missing_ok=True)
    receipts = host / "update-receipts"
    if receipts.is_dir():
        for name in ("installed.json", "installed-manifest.json", "nora-system.json"):
            target = install_root / "tavern-updates" / name
            saved = receipts / name
            if saved.is_file():
                shutil.copy2(saved, target)
            else:
                target.unlink(missing_ok=True)


def swap_tree(source, target, backup_target):
    source, target, backup_target = [Path(filesystem_path(p)) for p in (source, target, backup_target)]
    target.parent.mkdir(parents=True, exist_ok=True)
    backup_target.parent.mkdir(parents=True, exist_ok=True)
    had_target = target.exists()
    if had_target:
        os.replace(target, backup_target)
    try:
        os.replace(source, target)
    except BaseException:
        if had_target and backup_target.exists() and not target.exists():
            os.replace(backup_target, target)
        raise


def restore_tree(target, backup_target, failed):
    target, backup_target, failed = [Path(filesystem_path(p)) for p in (target, backup_target, failed)]
    if target.exists():
        failed.parent.mkdir(parents=True, exist_ok=True)
        if failed.exists():
            remove(failed)
        os.replace(target, failed)
    if backup_target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(backup_target, target)


def start_old(hermes_home, install_root, service, snapshot):
    app = install_root / "apps/tavern-runtime"
    if _standalone_execution is not None and (app / 'native_lifecycle.py').is_file():
        runtime = standalone_runtime(install_root)
        runtime.install()
        if service and snapshot:
            service.restore(snapshot)
            service.start()
        else:
            runtime.start(port=standalone_port(hermes_home, install_root))
        return
    if (app / "native_lifecycle.py").is_file():
        environment = {**os.environ, "HERMES_HOME": str(hermes_home), "TAVERN_DATA_ROOT": str(install_root)}
        run([sys.executable, "-B", app / "native_lifecycle.py", "install"], env=environment)
        if service and snapshot:
            service.restore(snapshot)
            service.start()
        else:
            run([sys.executable, "-B", app / "native_lifecycle.py", "start"], env=environment)
        return
    if service and snapshot:
        service.restore(snapshot)
        service.start()
        return
    layout = python_layout(app)
    if layout:
        error=RuntimeError('旧 Python 酒馆无法由新版启动器安全接管。文件和数据已保留，请使用完整正式包重新安装启动器。')
        error.code='LEGACY_RUNTIME_UNSUPPORTED';raise error


def standalone_port(home, root):
    """Read this instance's configured port; never probe a different Tavern."""
    import urllib.parse
    import yaml
    config = Path(home) / 'config.yaml'
    if not config.is_file():
        return 8799
    value = yaml.safe_load(config.read_text(encoding='utf-8')) or {}
    url = value.get('mcp_servers', {}).get('nora', {}).get('env', {}).get('NORA_MCP_BASE_URL')
    if not url:
        return 8799
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
            or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment
            or parsed.port is None or not 1024 <= parsed.port <= 65535):
        raise RuntimeError('现有酒馆端口配置无效，未修改安装。')
    return parsed.port


def standalone_runtime(root):
    app = Path(root) / 'apps/tavern-runtime'
    module = module_at('standalone_native_lifecycle', app / 'native_lifecycle.py')
    contract = module.RuntimeContract.from_dict(json.loads((app / 'native-runtime.json').read_text(encoding='utf-8')))
    return module.NativeRuntime(root, app, Path(root) / 'tavern-state', contract)


def standalone_snapshot(root):
    receipt = json.loads((Path(root) / 'tavern-updates/installed.json').read_text(encoding='utf-8'))
    status = standalone_runtime(root).status()
    if status.get('inspection_error'):
        raise RuntimeError('无法核验独立酒馆进程归属，已保留现场。')
    return {'scope': 'standalone-tavern', 'version': receipt['version'],
            'running': status.get('processes', {}).get('native') is True}


def restore_standalone_running_state(root, before):
    if before.get('running') is not False:
        return
    standalone_runtime(root).stop_run()
    if standalone_snapshot(root)['running']:
        raise RuntimeError('新版已通过检查，但未恢复原有停止状态。')


def recover_standalone(home, root, *, helper=None):
    helper = helper or recovery_module()
    journal = helper.load(home, root)
    if journal.plan['before'].get('scope') != 'standalone-tavern':
        raise RuntimeError('历史事务不属于可核验的独立更新，已保留日志和备份。')
    before = journal.plan['before']
    saved_service = journal.backup / 'host/service.json'
    snapshot = json.loads(saved_service.read_text(encoding='utf-8')) if saved_service.is_file() else None
    def stop(_plan, _backup):
        service = module_at('standalone_service_manager', HERE / 'service_manager.py').ManagedService.discover(
            root, Path(root) / 'apps/tavern-runtime')
        if service:
            service.stop()
        stop_unmanaged(Path(root) / 'apps/tavern-runtime')
        if process_rows(Path(root) / 'apps/tavern-runtime'):
            raise RuntimeError('独立酒馆尚未停止，未恢复文件。')
        return {'offline': True}
    def resume(_plan, _backup):
        service = module_at('standalone_service_manager', HERE / 'service_manager.py').ManagedService.discover(
            root, Path(root) / 'apps/tavern-runtime')
        if before['running']:
            start_old(home, root, service, snapshot)
        elif service and snapshot:
            service.restore(snapshot)
    def verify(_plan, _backup):
        result = standalone_snapshot(root)
        runtime = standalone_runtime(root)
        if before['running'] and runtime.status().get('health', {}).get('ok') is not True:
            raise RuntimeError('旧版文件已恢复，但服务健康检查未通过。')
        return result
    def verify_files(_plan, _backup):
        if journal.plan.get('worlds') is not None:
            verify_preserved_worlds(Path(root) / 'apps/tavern-runtime', Path(root) / 'tavern-state',
                                   journal.plan.get('storyInventory', {}), journal.plan['worlds'])
    return helper.recover(home, root, stop=stop, resume=resume, verify=verify, verify_files=verify_files)


@contextmanager
def temporary_content_check_skip(config_path, enabled):
    """Skip ST's content scan only for a restart whose engine did not change."""
    config_path = Path(config_path)
    if not enabled:
        yield
        return
    original = config_path.read_bytes()
    text = original.decode("utf-8")
    patched, count = re.subn(
        r"(?m)^skipContentCheck:\s*(?:false|true)\s*$",
        "skipContentCheck: true",
        text,
        count=1,
    )
    if count != 1:
        raise RuntimeError("无法定位 SillyTavern 内容检查配置")
    changed = patched.encode("utf-8") != original
    if changed:
        atomic(config_path, patched.encode("utf-8"), mode=config_path.stat().st_mode & 0o777)
    try:
        yield
    finally:
        if changed:
            atomic(config_path, original, mode=config_path.stat().st_mode & 0o777)


def install_runtime(hermes_home, install_root, *, skip_content_check=False, port=8799):
    app = install_root / "apps/tavern-runtime"
    module = module_at("installed_native_lifecycle", app / "native_lifecycle.py")
    contract = module.RuntimeContract.from_dict(json.loads((app / "native-runtime.json").read_text(encoding="utf-8")))
    runtime = module.NativeRuntime(install_root, app, install_root / "tavern-state", contract)
    runtime.install()
    service = runtime.managed_service()
    if service:
        text = service.node_text(runtime.node_command(port, runtime.native_data_root), runtime.engine_root)
        service.install_text(text, accepted_hash=None, mode=service.file.stat().st_mode & 0o777)
    with temporary_content_check_skip(runtime.config_path, skip_content_check):
        return runtime.start(port=port)


def refresh_liveware(hermes_home, install_root, source):
    try:
        source = Path(source)
        path = source / "updater/liveware_integration.py"
        if not path.is_file():
            path = source / "ops/updater/liveware_integration.py"
        integration = module_at("simple_liveware", path)
        return integration.repair(install_root, hermes_home=hermes_home)
    except Exception as error:
        return {"status": "pending", "warnings": [str(error)]}


def read_cron_jobs(home):
    path = Path(home) / "cron/jobs.json"
    if not path.is_file():
        return []
    value = json.loads(path.read_text(encoding="utf-8"))
    jobs = value.get("jobs", []) if isinstance(value, dict) else []
    if not isinstance(jobs, list):
        raise RuntimeError("Hermes cron jobs.json 格式无效")
    return [job for job in jobs if isinstance(job, dict)]


def hermes_command():
    candidates = (
        Path(sys.executable).with_name("hermes"),
        Path(sys.executable).with_name("hermes.exe"),
        Path("/opt/hermes/.venv/bin/hermes"),
    )
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which("hermes")
    if found:
        return Path(found)
    raise RuntimeError("未找到 Hermes CLI，无法安装更新提醒任务")


def update_check_jobs(home):
    return [
        job for job in read_cron_jobs(home)
        if job.get("name") in (UPDATE_CHECK_JOB_NAME, "Nora Tavern daily update check (09:00 Asia/Shanghai)")
        or job.get("script") in (UPDATE_CHECK_SCRIPT, "nora-tavern-update-check.sh")
    ]


def configure_update_check_job(home):
    cli = hermes_command()
    environment = {**os.environ, "HERMES_HOME": str(home)}
    existing = update_check_jobs(home)
    if existing:
        primary = existing[0]
        run([
            cli, "cron", "edit", primary["id"],
            "--schedule", UPDATE_CHECK_SCHEDULE,
            "--prompt", "",
            "--name", UPDATE_CHECK_JOB_NAME,
            "--deliver", "local",
            "--clear-skills",
            "--script", UPDATE_CHECK_SCRIPT,
            "--no-agent",
        ], env=environment, capture=True)
        for duplicate in existing[1:]:
            run([cli, "cron", "remove", duplicate["id"]], env=environment, capture=True)
    else:
        run([
            cli, "cron", "create", UPDATE_CHECK_SCHEDULE,
            "--name", UPDATE_CHECK_JOB_NAME,
            "--deliver", "local",
            "--script", UPDATE_CHECK_SCRIPT,
            "--no-agent",
        ], env=environment, capture=True)

    configured = update_check_jobs(home)
    if len(configured) != 1:
        raise RuntimeError(f"更新提醒任务数量异常：{len(configured)}")
    job = configured[0]
    schedule = job.get("schedule", {})
    if (schedule.get("expr") != UPDATE_CHECK_SCHEDULE
            or job.get("script") != UPDATE_CHECK_SCRIPT
            or job.get("no_agent") is not True
            or job.get("deliver") != "local"
            or job.get("enabled") is not True):
        raise RuntimeError("更新提醒任务配置未生效")
    return job


def install_update_check(home, ops_root):
    """Install the daily checker from an installed or staged operations root."""
    scripts = Path(home) / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    for name in UPDATE_CHECK_FILES:
        origin = Path(ops_root) / "scripts" / name
        if not origin.is_file():
            raise RuntimeError("发布包缺少更新提醒脚本：" + name)
        target = scripts / name
        # nora-instance.py may already have been installed by the durable
        # greeting swap. Keep its recorded identity when bytes are identical.
        if same_file(origin, target):
            os.chmod(target, 0o755)
        else:
            atomic(target, origin.read_bytes(), mode=0o755)
    job = configure_update_check_job(home)
    return {
        "status": "installed",
        "jobId": job["id"],
        "schedule": UPDATE_CHECK_SCHEDULE,
        "mode": "no-agent",
    }


def managed_lifecycle(phase, home, root, version):
    """Run the desktop's existing service controller inside the update transaction."""
    raw = os.environ.get("NORA_UPDATE_LIFECYCLE")
    if not raw:
        raise RuntimeError("缺少启动器事务检查上下文，未确认服务恢复能力")
    plan = json.loads(raw)
    if (Path(plan["hermesHome"]).resolve() != home.resolve()
            or Path(plan["installRoot"]).resolve() != root.resolve()):
        raise RuntimeError("更新事务实例不匹配")
    command = [sys.executable, "-B", plan["bridge"], "--nora-home", plan["noraHome"],
               "--hermes-home", str(home), "--install-root", str(root),
               "--port", str(plan["port"]), "update-lifecycle"]
    result = _operation_control.managed_run(command, input=json.dumps({**plan, "phase": phase, "version": version}),
                            text=True, capture_output=True, timeout=300)
    messages = []
    for line in result.stdout.splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict):
            messages.append(item)
    # Forward diagnostics, but only the transaction itself can report success.
    for item in messages:
        if item.get("event") != "result":
            print(json.dumps(item, ensure_ascii=False), flush=True)
    if result.returncode:
        detail = next((m.get("message") for m in reversed(messages) if m.get("event") == "error"), None)
        raise RuntimeError(f"服务事务检查失败（{phase}）：{detail or result.stderr[-2000:] or result.returncode}")
    state = next((m for m in reversed(messages) if m.get("event") == "result"), None)
    if state is None:
        raise RuntimeError("服务事务检查未返回结果：" + phase)
    return {key: value for key, value in state.items() if key != "event"}


@contextmanager
def reconcile_probe_configuration(journal, home):
    """Account for Hermes' format-only save during plugin verification.

    The bundled offline probe enables the already enabled plugin via Hermes'
    supported API, which can reserialize YAML. Never bless changed settings.
    """
    import yaml
    helper = recovery_module()
    target = helper.safe_path(home, 'config.yaml')

    def capture():
        file = Path(filesystem_path(target))
        helper.reject_links(target)
        before = file.stat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > 2 * 1024 * 1024:
            raise RuntimeError('插件校验配置不是有界普通文件，原配置已保留。')
        data = file.read_bytes()
        after = file.stat()
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, len(data), after.st_mtime_ns):
            raise RuntimeError('插件校验配置读取期间变化，原配置已保留。')
        return yaml.safe_load(data.decode('utf-8')), hashlib.sha256(b'F\0' + data).hexdigest()

    original, _ = capture()
    journal.mark_metadata([target])
    primary = None
    try:
        yield
    except BaseException as error:
        primary = error
        raise
    finally:
        try:
            current, postimage = capture()
            if current != original:
                error = RuntimeError('插件校验期间配置值出现未归属的变化，当前配置已保留。 [path=hermes:config.yaml; owner=user]')
                error.code = 'CONDITIONS_CHANGED'
                raise error
            # Seal the bytes parsed above. A later external edit must not be
            # adopted by a second read while updating the receipt.
            entry = journal.plan['metadataWrites']['hermes:config.yaml']
            entry.update(after=postimage, completed=True)
            journal.save()
        except BaseException as error:
            if primary is None:
                raise
            primary.secondary_errors = [*getattr(primary, 'secondary_errors', []), error]


@contextmanager
def reconcile_setup_metadata(journal, managed, root, manifest):
    """Seal only the first-setup write made by the existing service verifier.

    Initialization is already sealed before services start. A successful first
    start can change only setupCompleted; capture that owned postimage even when
    a later service check fails, so ordinary rollback can restore it safely.
    """
    helper = recovery_module()
    relative = 'tavern-updates/nora-system.json'
    key = 'install:' + relative

    def reject(cause=None):
        error = RuntimeError('服务检查期间初始化记录出现未归属的变化，当前记录已保留。 '
                             '[path=install:tavern-updates/nora-system.json; owner=nora-updater]')
        error.code = 'CONDITIONS_CHANGED'
        if cause is not None:
            raise error from cause
        raise error

    def capture():
        # Parse and hash the same bounded bytes, never two reads of a live file.
        try:
            target = helper.safe_path(journal.root, relative)
            file = Path(filesystem_path(target))
            before = file.lstat()
            if helper.linked(target) or not stat.S_ISREG(before.st_mode) or before.st_size > 2 * 1024 * 1024:
                reject()
            with os.fdopen(os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as stream:
                opened = os.fstat(stream.fileno())
                if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                    reject()
                data = stream.read(2 * 1024 * 1024 + 1)
                read = os.fstat(stream.fileno())
            after = Path(filesystem_path(helper.safe_path(journal.root, relative))).lstat()
            signature = lambda value: (value.st_dev, value.st_ino, value.st_size,
                                        value.st_mtime_ns, value.st_ctime_ns)
            if len(data) != before.st_size or signature(before) != signature(read) or signature(read) != signature(after):
                reject()
            record = json.loads(data.decode('utf-8'))
            if (not isinstance(record, dict) or managed.acceptance_record_problems(record)
                    or record.get('version') != manifest.get('versions', {}).get('tavern')
                    or record.get('commit') != manifest.get('commit')):
                reject()
            return record, hashlib.sha256(b'F\0' + data).hexdigest(), data.decode('utf-8')
        except (OSError, ValueError, TypeError) as error:
            reject(error)

    if (journal is None or Path(root).resolve() != journal.root
            or journal.plan.get('installRoot') != str(journal.root)
            or journal.plan.get('metadataPhase') != 'applying'
            or key not in journal.plan.get('metadataIntents', [])
            or journal.metadata_key(helper.safe_path(journal.root, relative)) != key):
        reject()
    entry = journal.plan.get('metadataWrites', {}).get(key)
    before = journal.plan.get('before')
    lifecycle = journal.plan.get('lifecycle')
    if (not isinstance(entry, dict) or entry.get('completed') is not True
            or not isinstance(entry.get('after'), str)
            or not isinstance(before, dict) or not isinstance(lifecycle, dict)
            or not isinstance(lifecycle.get('before'), dict)
            or any(type(before.get(name)) is not bool
                   or type(lifecycle['before'].get(name)) is not bool
                   or before[name] != lifecycle['before'][name]
                   for name in ('running', 'gatewayRunning'))):
        reject()
    original, sealed, original_text = capture()
    if sealed != entry['after']:
        reject()
    intent = None
    if original.get('setupCompleted') is False and before['running'] is True and before['gatewayRunning'] is True:
        intent = journal.prepare_setup_metadata(original_text)

    def reconcile():
        current, current_digest, _ = capture()
        if current_digest == sealed:
            return
        expected = {**original, 'setupCompleted': True}
        if (original.get('setupCompleted') is not False
                or before['running'] is not True or before['gatewayRunning'] is not True
                or current.get('setupCompleted') is not True
                or intent is None or journal.setup_metadata_intent() != intent
                or current_digest != intent['after']
                or json.dumps(current, sort_keys=True, allow_nan=False) !=
                   json.dumps(expected, sort_keys=True, allow_nan=False)):
            reject()
        # The existing receipt gains this captured, validated postimage only.
        # Unrelated metadata and generic recovery ownership rules stay strict.
        entry['after'] = current_digest
        journal.save()

    try:
        yield
    except BaseException as primary:
        try:
            reconcile()
        except BaseException as secondary:
            primary.secondary_errors = [*getattr(primary, 'secondary_errors', []), secondary]
        raise
    else:
        reconcile()


def install(args):
    managed_home = getattr(args, "managed_home", None)
    def resolve(*, validate_partial=True):
        return resolve_update_target(args.home, args.install_root, managed_home=managed_home,
                                     validate_partial=validate_partial)
    hermes_home, install_root = resolve()
    instance = managed_instance(hermes_home, managed_home) if managed_home else None
    partial = validate_partial_repair(hermes_home, install_root, instance) if instance else None
    port = instance["port"] if instance else standalone_port(hermes_home, install_root)
    os.environ["HERMES_HOME"] = str(hermes_home)
    os.environ["NORA_HERMES_HOME"] = str(hermes_home)
    os.environ["HERMES_INSTALL_DIR"] = str(hermes_home / "hermes-agent")
    os.environ["TAVERN_DATA_ROOT"] = str(install_root)
    if not (hermes_home / "skills").is_dir():
        raise RuntimeError("目标目录不是 Hermes 安装目录：" + str(hermes_home))
    from bundle import extract_bundle, installed_roots, read_bundle
    with installer_lock(install_root):
        # Recheck after waiting for another updater, before downloading or writing.
        resolve()
        update_root = install_root / "tavern-updates"
        update_root.mkdir(parents=True, exist_ok=True)
        transaction_file = update_root / "transaction.json"
        closure_refs=recovery_module().effect_closure_refs(hermes_home,install_root) if instance else []
        if transaction_file.exists():
            previous = json.loads(transaction_file.read_text(encoding="utf-8"))
            if (_standalone_execution is not None and previous.get('status') not in ('committed', 'restored')
                    and previous.get('recoveryPlan', {}).get('before', {}).get('scope') == 'standalone-tavern'):
                result = recover_standalone(hermes_home, install_root)
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return
            if instance:recovery_module().require_partial_history_before_replace(hermes_home,install_root,previous,closure_refs)
            if previous.get("status") not in ("committed", "restored"):
                previous_effects=recovery_module().effects(hermes_home,install_root)
                if previous_effects['effectState']!='untouched':
                    raise RuntimeError("上次更新事务未完成，禁止覆盖恢复现场；请保留备份：" + str(previous.get("backup", "")))
                # A trusted preparation with no remaining write effect is
                # historical evidence, not a permanent lock on later updates.
                json_write(Path(previous['backup'])/'transaction-retired.json',previous)
        with tempfile.TemporaryDirectory(prefix="direct-", dir=filesystem_path(update_root)) as temporary:
            work = Path(temporary)
            source = work / "source"
            manifest = read_bundle(args.release_dir, args.manifest_sha256,
                                   candidate=getattr(args, "allow_candidate", False))
            roots = installed_roots(install_root)
            old_app = roots["app"]
            old_mcp = roots["nora-mcp"]
            # Missing native markers can coexist with obsolete Python program
            # files. Repair preserves the existing state; only an ordinary
            # legacy upgrade may migrate or archive it.
            layout = None if partial else python_layout(old_app)
            bundle_report = extract_bundle(args.release_dir, source, manifest, roots=roots)
            version = manifest["versions"]["tavern"]
            changed = set(bundle_report["changedModules"])
            root_changes = changed_roots(manifest, changed) | roots_with_unmanaged_files(install_root, manifest)
            if layout:
                root_changes.update(("app", "ops", "nora-mcp"))
            app_changed = "app" in root_changes
            ops_changed = "ops" in root_changes
            mcp_changed = "nora-mcp" in root_changes
            managed = None
            bundled = False
            if instance:
                managed = module_at("update_nora_system", source / "ops/installer/nora_system.py")
                helpers = module_at("update_install_helpers", source / "ops/installer/first_install.py")
                bundled = bool(helpers.extract_dependency_bundle(args.release_dir, source))
                # Component updates reuse the same dependency lock comparison as
                # standalone updates; a full platform bundle is optional.
            dependencies = prepare_dependencies(
                source,
                old_app,
                old_mcp,
                app_changed=app_changed,
                mcp_changed=mcp_changed,
                **({"bundled": True} if bundled else {}),
            )
            resolve()
            skills = prepare_skills(source, work / "skills", local=bool(instance))
            agents_bytes = (source / "ops/skills/agents-tavern.md").read_bytes()
            desired_agents = merged_agents(hermes_home, agents_bytes)
            mcp_config = render_mcp(hermes_home, install_root, port)
            if partial:
                # Snapshot admission already authenticated every existing MCP
                # binding. Preserve comments, formatting and operator settings.
                mcp_config = (hermes_home / 'config.yaml').read_bytes()
            agents_changed = not (hermes_home / "AGENTS.md").is_file() or (hermes_home / "AGENTS.md").read_bytes() != desired_agents
            config_changed = not (hermes_home / "config.yaml").is_file() or (hermes_home / "config.yaml").read_bytes() != mcp_config
            migration = {"status": "not-required"}
            prepared_state = None
            service_module = module_at("simple_service_manager", source / "ops/updater/service_manager.py")
            service = service_module.ManagedService.discover(install_root, old_app)
            service_snapshot = service.snapshot() if service else None
            swaps = []
            context = module_at("release_managed_context", source / "ops/updater/managed_context.py")
            context_swaps, greeting_report = context.prepare_greeting(hermes_home, source, work / "greeting")
            swaps.extend(context_swaps)
            if app_changed:
                swaps.append(("app", source / "app", roots["app"]))
            if ops_changed:
                swaps.append(("ops", source / "ops", roots["ops"]))
            if mcp_changed:
                swaps.append(("nora-mcp", source / "nora-mcp", roots["nora-mcp"]))
            # The operations tree is swapped before host hooks. Keep the hook's
            # prepared source outside source/ops so moving that parent tree
            # cannot invalidate a later swap in the same transaction.
            host_hook = prepare_host_hook_swap(hermes_home, source, work / "host-hooks")
            if host_hook:
                swaps.append(host_hook)
            gateway_patch = module_at("release_clawchat_greeting_patch", source / "ops/updater/clawchat_greeting_patch.py")
            gateway_swaps, gateway_report = gateway_patch.prepare(hermes_home, work / "clawchat-greeting")
            swaps.extend(gateway_swaps)
            if gateway_report.get("status") == "pending":
                log("ClawChat 欢迎消息顺序补丁未应用，插件保留原状：" + "; ".join(gateway_report.get("warnings", [])))
            for relative, prepared in skills.items():
                target = hermes_home / "skills" / relative
                if not trees_equal(prepared, target):
                    swaps.append(("skill-" + relative.replace("/", "-"), prepared, target))
            for retired in getattr(module_at("simple_skill_names", source / "ops/scripts/install-hermes-skills.py"), "RETIRED"):
                target = hermes_home / "skills/creative" / retired
                if target.exists():
                    swaps.append(("retired-" + retired, None, target))
            host_changed = agents_changed or config_changed
            runtime_changed = app_changed or layout is not None or bool(managed)
            if layout and not managed and not service:
                # start_old cannot safely restart an unmanaged Python server.
                # Reject before stopping rather than promise unavailable rollback.
                error = RuntimeError('旧 Python 酒馆缺少可恢复的受管服务；未停止服务或修改原安装，请使用完整正式启动器处理。')
                error.code = 'LEGACY_RUNTIME_UNSUPPORTED'
                raise error
            if not managed and not swaps and not host_changed and prepared_state is None:
                result = {
                    "status": "up-to-date",
                    "version": version,
                    "delivery": bundle_report,
                    "dependencies": dependencies,
                    "clawchatGreeting": gateway_report,
                }
                print(json.dumps(result, ensure_ascii=False, indent=2))
                log("已是最新版，无需替换文件。")
                return
            stamp = time.strftime("%Y%m%d-%H%M%S")
            resolve()
            before_state = {}
            standalone_journal = _standalone_execution is not None and layout is None
            if standalone_journal:
                before_state = standalone_snapshot(install_root)
            if managed:
                before_state = managed_lifecycle("preflight", hermes_home, install_root, version)
                if partial and (before_state.get('partialRepair') != partial
                        or before_state.get('offline') is not True
                        or before_state.get('version') != partial['version']
                        or any(before_state.get(key) is not False for key in
                               ('systemReady', 'running', 'gatewayRunning', 'clawchatConnected'))):
                    raise RuntimeError('部分安装修复尚未核验原状态及停服证据，未修改现有安装。')
            backup = install_root / "tavern-backups" / f"{stamp}-{version}-{uuid.uuid4().hex[:8]}"
            # Admission precedes host snapshots and shutdown. Existing backups
            # are never deleted to manufacture free space.
            check_update_space(update_space_tasks(
                hermes_home, install_root, backup, work, managed=bool(managed),
                runtime_changed=runtime_changed, migration=bool(layout),
                service_snapshot=service_snapshot))
            Path(filesystem_path(backup)).mkdir(parents=True)
            record_backup(install_root, backup, "prepared")
            copy_host_backup(hermes_home, install_root, backup, service_snapshot)
            agents_backup = Path(filesystem_path(backup / "agents-rollback"))
            snapshot_agents(hermes_home, agents_backup)
            if managed:
                helpers.snapshot_targets(hermes_home, [
                    hermes_home / name for name in MANAGED_BACKUP_FILES
                ] + [hermes_home / "scripts" / name for name in UPDATE_CHECK_FILES], backup / "managed")
                setup_completed = managed.read_json(update_root / "nora-system.json").get("setupCompleted") is True
                if instance.get("missingSystemReceipt"):
                    setup_completed = (before_state.get("modelConfigured") is True
                                       and before_state.get("clawchatProfileReady") is True)
            applied = []
            state_swapped = False
            state_snapshot = False
            runtime_stopped = False
            story_inventory, story_worlds = {}, {}
            transaction = {"schema": 1, "status": "prepared", "version": version, "backup": str(backup)}
            journal = None
            if managed or standalone_journal:
                recovery_helper = recovery_module()
                journal = recovery_helper.Journal.create(
                    hermes_home, install_root, backup, swaps, version=version,
                    before=before_state,
                    state=install_root / "tavern-state" if runtime_changed else None,
                    lifecycle=json.loads(os.environ["NORA_UPDATE_LIFECYCLE"]) if managed else None,
                )
                transaction = journal.record
            else:
                json_write(transaction_file, transaction)
            committed = False
            try:
                if runtime_changed:
                    log("备份旧版本并停止 Tavern")
                    runtime_stopped = True
                    if standalone_journal:
                        journal.plan['phase'] = 'stopping'
                        journal.save()
                    if managed:
                        journal.plan["phase"] = "stopping"
                        journal.save()
                        stopped=managed_lifecycle("stop", hermes_home, install_root, version)
                        if partial:
                            if (stopped.get('partialRepair') != partial or stopped.get('offline') is not True
                                    or any(stopped.get(key) is not False for key in
                                           ('systemReady', 'running', 'gatewayRunning', 'clawchatConnected'))):
                                raise RuntimeError('部分安装修复的停服或原状态证据已变化，未替换现有程序。')
                        else:
                            helpers.stop_install_runtime(install_root)
                        journal.seal_offline(stopped)
                        for diagnostic in journal.metadata_diagnostics():log('[metadata-check] '+diagnostic)
                        journal.plan["phase"] = "stopped"
                        journal.save()
                    elif layout:
                        stop_legacy_for_migration(old_app, service)
                    elif service:
                        service.stop()
                    else:
                        stop_unmanaged(old_app)
                    if standalone_journal:
                        if process_rows(old_app):
                            raise RuntimeError('原酒馆进程尚未停止，未替换程序。')
                        journal.seal_offline({'offline': True})
                        journal.plan['phase'] = 'stopped'
                        journal.save()
                    runtime_stopped = True
                    # Include the final write before stopping and use saved
                    # metadata, whose backup already occupies disk space.
                    check_update_space(update_space_tasks(
                        hermes_home, install_root, backup, work, managed=bool(managed),
                        runtime_changed=True, migration=bool(layout),
                        restore_only=True, journal=journal, service_snapshot=service_snapshot))
                    if layout:
                        # Only the stopped installation is an authoritative
                        # migration source. Preparation can take minutes while
                        # users are still writing; copying before this boundary
                        # would silently replace their final writes with an old
                        # snapshot. Failed conversion uses a fresh complete
                        # copy of the same sealed source, never its partial output.
                        log("迁移已停服的旧 Python 数据；不兼容记录只归档，不阻止更新")
                        try:
                            prepared_state, migration = migration_copy(
                                hermes_home, install_root, source, work, layout)
                        except Exception as error:
                            # Only an explicitly recognized input format can
                            # become an archive. Crashes, timeout, storage and
                            # invalid converter output keep the update failed.
                            if getattr(error, 'code', '') != 'LEGACY_MIGRATION_UNSUPPORTED':
                                raise
                            prepared_state, migration = fallback_python_state(
                                install_root, work, str(error))
                        # Conversion output can exceed the original copy size.
                        # It is already on disk: reserve only still-future
                        # metadata restoration and transaction headroom here.
                        check_update_space(update_space_tasks(
                            hermes_home, install_root, backup, work, managed=bool(managed),
                            runtime_changed=False, migration=False,
                            restore_only=True, journal=journal, service_snapshot=service_snapshot))
                    if prepared_state is None:
                        # Startup can quarantine incompatible manifests. Keep the
                        # entire state, not only program/configuration backups.
                        if journal is not None:
                            journal.snapshot_state()
                        else:
                            shutil.copytree(filesystem_path(install_root / "tavern-state"), filesystem_path(backup / "state"))
                        state_snapshot = True
                        story_inventory = world_data_inventory(backup / "state", full=bool(partial))
                        if partial:
                            journal.plan['partialBaseline'] = {
                                'schema': 'nora-managed-partial-repair-baseline/1', 'partialRepair': partial,
                                'stateDigest': journal.plan['state']['savedDigest'],
                                'storyInventory': story_inventory, 'worlds': None,
                                'readerManifestSha256': args.manifest_sha256, 'readerCommit': manifest['commit'],
                            }
                            journal.save()
                        # The missing old program is not a usable parser. Only
                        # the hash-verified candidate reads the original backup.
                        baseline_reader = source / 'app' if partial else old_app
                        story_worlds = verify_worlds(baseline_reader, backup / "state")
                        if journal is not None:
                            journal.plan["worlds"] = story_worlds
                            if standalone_journal:
                                journal.plan['storyInventory'] = story_inventory
                                journal.save()
                            if partial:
                                journal.plan['partialBaseline']['worlds'] = story_worlds
                            journal.save()
                        candidate_app = source / "app" if app_changed else old_app
                        verify_preserved_worlds(candidate_app, backup / "state", story_inventory, story_worlds,
                                                exact=bool(partial))
                else:
                    log("应用非运行时更新，Tavern 保持运行")
                if managed:
                    journal.mark_metadata([hermes_home/name for name in ('SOUL.md','SOUL.nora-tavern.example.md')])
                    helpers.install_soul(hermes_home, source, replace=False, dedicated=True)
                    journal.finish_metadata([hermes_home/name for name in ('SOUL.md','SOUL.nora-tavern.example.md')])
                for name, prepared, target in swaps:
                    saved = backup / "trees" / name
                    if journal is not None:
                        journal.swap(name)
                        continue
                    if prepared is None:
                        saved.parent.mkdir(parents=True, exist_ok=True)
                        if target.exists():
                            os.replace(target, saved)
                        applied.append((name, target, saved))
                        continue
                    swap_tree(prepared, target, saved)
                    applied.append((name, target, saved))
                if gateway_swaps:
                    gateway_report = {**gateway_report, "status": "installed"}
                if prepared_state is not None:
                    active_state = install_root / "tavern-state"
                    saved_state = backup / "state"
                    if journal is not None:
                        journal.apply_state(prepared_state)
                    else:
                        os.replace(active_state, saved_state)
                        try:
                            os.replace(prepared_state, active_state)
                        except BaseException:
                            os.replace(saved_state, active_state)
                            raise
                        state_swapped = True
                if agents_changed:
                    if journal is not None:journal.mark_metadata([hermes_home/'AGENTS.md',hermes_home/'AGENTS.md.bak'])
                    install_agents(hermes_home, desired_agents)
                    if journal is not None:journal.finish_metadata([hermes_home/'AGENTS.md',hermes_home/'AGENTS.md.bak'])
                if config_changed:
                    if journal is not None:journal.mark_metadata([hermes_home/'config.yaml'])
                    atomic(hermes_home / "config.yaml", mcp_config, mode=0o600)
                    if journal is not None:journal.finish_metadata([hermes_home/'config.yaml'])
                if managed:
                    log("更新诺拉技能、定时任务并核对当前实例")
                    # The supported ClawChat seeder also normalizes MCP's Node
                    # command in config.yaml. Own both writes so a later failed
                    # startup can restore the pre-update user configuration.
                    seed_metadata = [hermes_home/'clawchat-skills', hermes_home/'config.yaml']
                    journal.mark_metadata(seed_metadata)
                    managed.seed_clawchat_skills(hermes_home, sys.executable, dict(os.environ))
                    journal.finish_metadata(seed_metadata)
                    journal.mark_metadata([hermes_home/'cron/jobs.json']+[hermes_home/'scripts'/name for name in UPDATE_CHECK_FILES])
                    update_check = install_update_check(hermes_home, install_root / "apps/tavern-ops")
                    journal.finish_metadata([hermes_home/'cron/jobs.json']+[hermes_home/'scripts'/name for name in UPDATE_CHECK_FILES])
                    if update_check.get("status") != "installed":
                        raise RuntimeError("诺拉更新提醒任务未成功注册")
                    journal.mark_metadata([hermes_home/'nora-installation.json'])
                    managed.record_files_ready(hermes_home)
                    journal.finish_metadata([hermes_home/'nora-installation.json'])
                if app_changed:
                    if journal is not None:journal.mark_metadata([install_root/'tavern-state/native-runtime/dependencies.json'])
                    json_write(
                        install_root / "tavern-state/native-runtime/dependencies.json",
                        dependency_marker(install_root / "apps/tavern-runtime"),
                    )
                    if journal is not None:journal.finish_metadata([install_root/'tavern-state/native-runtime/dependencies.json'])
                if runtime_changed:
                    log("启动新版 Tavern")
                    if standalone_journal:journal.preserve_startup_backups()
                    runtime = install_runtime(
                        hermes_home,
                        install_root,
                        skip_content_check="tavern-engine" not in changed,
                        port=port,
                    )
                    if not runtime.get("health", {}).get("ok"):
                        raise RuntimeError("新版酒馆健康检查未通过")
                    if standalone_journal:journal.preserve_startup_backups(restore=True)
                else:
                    runtime = {"native_pid": service_snapshot.get("pid") if service_snapshot else None,
                               "health": {"ok": port_open(port)}}
                resolve(validate_partial=False)
                verify_partial_configuration(hermes_home, install_root, partial)
                world_verification = verify_preserved_worlds(
                    install_root / "apps/tavern-runtime", install_root / "tavern-state",
                    story_inventory, story_worlds, exact=bool(partial),
                ) if state_snapshot else {"status": "not-required"}
                liveware_needed = not managed and (app_changed or ops_changed or host_hook is not None)
                liveware = refresh_liveware(hermes_home, install_root, install_root / "apps/tavern-ops") if liveware_needed else {"status": "unchanged"}
                if managed:
                    with reconcile_probe_configuration(journal, hermes_home):
                        proof = managed.verify_runtime(hermes_home, install_root, port, sys.executable, dict(os.environ))
                    world_verification = verify_preserved_worlds(
                        install_root / "apps/tavern-runtime", install_root / "tavern-state",
                        story_inventory, story_worlds, exact=bool(partial))
                    journal.mark_metadata([update_root/'nora-system.json'])
                    managed.record_initialization(hermes_home, install_root, manifest, proof)
                    if setup_completed:
                        managed.mark_setup_complete(install_root)
                    journal.finish_metadata([update_root/'nora-system.json'])
                elif ops_changed:
                    try:
                        update_check = install_update_check(hermes_home, install_root / "apps/tavern-ops")
                    except Exception as update_check_error:
                        update_check = {"status": "pending", "warnings": [str(update_check_error)]}
                else:
                    update_check = {"status": "unchanged"}
                installed = {
                    "schema": 2,
                    "version": version,
                    "commit": manifest["commit"],
                    "candidate": bool(manifest.get("candidate")),
                    "sourceDigest": manifest.get("sourceDigest"),
                    "releaseManifestSha256": args.manifest_sha256,
                    "installedAt": int(time.time()),
                    "backup": str(backup),
                    "migration": migration,
                    "liveware": liveware,
                    "updateCheck": update_check,
                    "delivery": bundle_report,
                    "dependencies": dependencies,
                    "clawchatGreeting": gateway_report,
                    "worldVerification": world_verification,
                }
                if journal is not None:journal.mark_metadata([update_root/'installed.json',update_root/'installed-manifest.json'])
                json_write(update_root / "installed.json", installed)
                json_write(update_root / "installed-manifest.json", manifest)
                if journal is not None:journal.finish_metadata([update_root/'installed.json',update_root/'installed-manifest.json'])
                if managed:
                    with reconcile_setup_metadata(journal, managed, install_root, manifest):
                        verified_state = managed_lifecycle("verify", hermes_home, install_root, version)
                else:
                    verified_state = None
                verify_partial_configuration(hermes_home, install_root, partial)
                if managed and state_snapshot:
                    verify_preserved_worlds(install_root / "apps/tavern-runtime",
                                           install_root / "tavern-state", story_inventory, story_worlds,
                                           exact=bool(partial))
                if standalone_journal and not before_state['running'] and runtime_changed:
                    # Acceptance above proves the replacement can run. Leave a
                    # previously stopped installation stopped before committing.
                    restore_standalone_running_state(install_root, before_state)
                if journal is not None:
                    journal.save("committed")
                else:
                    json_write(transaction_file, {**transaction, "status": "committed"})
                committed = True
                try:
                    record_backup(install_root, backup, "committed")
                    backup_retention = prune_backup_history(install_root, backup)
                    log(f"受管回退包保留最新 1 份，清理 {len(backup_retention['removed'])} 份；未归属或恢复现场继续保留。")
                except Exception as retention_error:
                    backup_retention = {
                        "status": "pending",
                        "kept": str(backup),
                        "warnings": [str(retention_error)],
                    }
                    log(f"旧备份清理未完成，当前备份仍保留：{retention_error}")
                reload_required = (
                    mcp_changed or agents_changed or config_changed
                    or bool(gateway_swaps) or bool(context_swaps)
                    or any(name.startswith(("skill-", "host-hook-")) for name, _, _ in swaps)
                )
                result = {
                    "status": "installed",
                    "version": version,
                    "backup": str(backup),
                    "dataImport": migration,
                    "runtime": {"pid": runtime.get("native_pid"), "health": runtime.get("health", {}).get("ok")},
                    "liveware": liveware,
                    "updateCheck": update_check,
                    "backupRetention": backup_retention,
                    "clawchatGreeting": gateway_report,
                    "delivery": bundle_report,
                    "dependencies": dependencies,
                    "greeting": greeting_report,
                    "worldVerification": world_verification,
                    "next": ("启动器将恢复更新前的运行状态。" if managed else
                             "请在 ClawChat 输入 /restart 重新加载网关、MCP 和技能。" if reload_required else "更新已生效。"),
                }
                print(json.dumps(result, ensure_ascii=False, indent=2))
                if verified_state is not None:
                    print(json.dumps({**verified_state, "updateRecovery": None, "event": "result", "updateVerified": True}, ensure_ascii=False), flush=True)
                log("更新完成。" + ("请在 ClawChat 输入 /restart。" if reload_required and not managed else ""))
                # Managed journals authenticate this snapshot until the whole backup is retired.
                if journal is None:
                    try:
                        shutil.rmtree(agents_backup)
                    except OSError as cleanup_error:
                        log(f"AGENTS 事务快照清理未完成：{cleanup_error}")
                return
            except BaseException as error:
                _operation_evidence.freeze(error, nora_home=managed_home or os.environ.get('NORA_TAVERN_HOME') or install_root.parent,
                    install_root=install_root if managed_home else install_root / 'apps', context={'stage': 'update_apply'})
                if committed:
                    raise RuntimeError(f"更新已验证提交，但结果传递或收尾失败；请检查状态，不要重装：{error}; backup={backup}") from error
                log("更新未完成，恢复旧版本")
                if journal is not None:
                    if standalone_journal:
                        try:
                            recover_standalone(hermes_home, install_root, helper=recovery_helper)
                        except BaseException as recovery_error:
                            failure = RuntimeError('更新失败：'+str(error)+'; 恢复未完成：'+str(recovery_error)+'; backup='+str(backup))
                            failure.code = getattr(error, 'code', None)
                            failure.secondary_errors = [recovery_error]
                            raise failure from error
                        failure = RuntimeError(str(error)+'; recovery=restored; backup='+str(backup))
                        failure.code = getattr(error, 'code', None)
                        raise failure from error
                    def verify_restored(plan, _backup):
                        state = managed_lifecycle("recover-verify", hermes_home, install_root, version)
                        if partial:
                            verify_partial_baseline(hermes_home, install_root, plan, partial, recovery_helper)
                        verify_partial_configuration(hermes_home, install_root, partial)
                        return state
                    def verify_restored_files(plan, _backup):
                        if not partial and plan.get('worlds') is not None:
                            verify_preserved_worlds(install_root / 'apps/tavern-runtime',
                                                   install_root / 'tavern-state', story_inventory, plan['worlds'])
                    try:
                        # install already holds tavern-installer.lock. Both the
                        # automatic rollback and the desktop's later retry use
                        # this exact journal/restore implementation.
                        recovery_helper.recover(
                            hermes_home, install_root,
                            stop=lambda *_: managed_lifecycle("recover-stop", hermes_home, install_root, version),
                            resume=lambda *_: managed_lifecycle("rollback", hermes_home, install_root, version),
                            verify=verify_restored,
                            verify_files=verify_restored_files,
                        )
                    except BaseException as recovery_error:
                        _operation_evidence.freeze(recovery_error, nora_home=managed_home or os.environ.get('NORA_TAVERN_HOME') or install_root.parent,
                            install_root=install_root if managed_home else install_root / 'apps', context={'stage': 'restoring'})
                        failure = RuntimeError(f"更新失败：{error}; 恢复未完成：{recovery_error}; recovery=incomplete; backup={backup}")
                        failure.code = getattr(error,'code',None)
                        failure._bridge_diagnostic_message = "更新失败，旧版本恢复未完成；请保留日志和备份。"
                        failure.secondary_errors = [recovery_error]
                        raise failure from error
                    failure=RuntimeError(f"{error}; recovery=restored; backup={backup}")
                    failure.code=getattr(error,'code',None)
                    raise failure from error
                if runtime_stopped:
                    try:
                        active_app = install_root / "apps/tavern-runtime"
                        active_service = service_module.ManagedService.discover(install_root, active_app)
                        if active_service:
                            active_service.stop()
                        else:
                            stop_unmanaged(active_app)
                    except Exception as stop_error:
                        raise RuntimeError("更新失败且无法停止新进程，未覆盖运行中的数据。请保留备份：" + str(backup)) from stop_error
                try:
                    failed_root = backup / "failed-new"
                    for name, target, saved in reversed(applied):
                        restore_tree(target, saved, failed_root / name)
                    if state_swapped or state_snapshot:
                        active_state = install_root / "tavern-state"
                        if active_state.exists():
                            failed_root.mkdir(parents=True, exist_ok=True)
                            os.replace(active_state, failed_root / "state")
                        os.replace(backup / "state", active_state)
                    restore_host(hermes_home, install_root, backup)
                    restore_agents(hermes_home, agents_backup)
                except BaseException as restore_error:
                    raise RuntimeError(f"更新失败：{error}; 文件恢复失败：{restore_error}; recovery=incomplete; backup={backup}") from restore_error
                recovery = "restored"
                if runtime_stopped:
                    try:
                        start_old(hermes_home, install_root, service, service_snapshot)
                    except Exception as recovery_error:
                        recovery = "files-restored-start-failed: " + str(recovery_error)
                json_write(transaction_file, {**transaction, "status": "restored" if recovery == "restored" else "recovery-failed",
                                              "recovery": recovery, "error": str(error)})
                try:
                    record_backup(install_root, backup, "restored" if recovery == "restored" else "recovery-failed")
                except Exception as receipt_error:
                    log(f"回退包状态记录未更新，保留恢复现场：{receipt_error}")
                raise RuntimeError(f"{error}; recovery={recovery}; backup={backup}") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-home", dest="home", type=Path)
    parser.add_argument("--install-root", type=Path)
    parser.add_argument("--managed-home", type=Path, help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest="command", required=True)
    command = sub.add_parser("install")
    command.add_argument("--release-dir", type=Path, required=True)
    command.add_argument("--manifest-sha256", required=True)
    command.add_argument("--confirm", action="store_true", required=True)
    command.add_argument("--allow-candidate", action="store_true")
    args = parser.parse_args()
    if (args.managed_home is not None or getattr(sys, '_nora_operation_delegate', None) is not None
            or any(name.startswith('NORA_OPERATION_') for name in os.environ)):
        cli = module_at('nora_update_operation_cli', _control_path.with_name('operation_cli.py'))
        cli.ensure_operation('update', nora_home=args.managed_home or os.environ.get('NORA_TAVERN_HOME'))
        if args.managed_home is not None:
            install(args)
        else:
            args.home, args.install_root = resolve_update_target(args.home, args.install_root)
            with guarded_standalone_execution(args.home, args.install_root):
                install(args)
    else:
        args.home, args.install_root = resolve_update_target(args.home, args.install_root)
        # Historical bootstraps call this entry with a verified extracted
        # runner. They must submit the same durable actor as current Nora and
        # desktop callers, rather than taking a separate Python writer lock.
        entry = HERE / 'task.py'
        if not entry.is_file():
            error = RuntimeError('当前更新器缺少独立任务执行文件，未修改现有程序和数据。')
            error.code = 'RESOURCE_INCOMPLETE'
            raise error
        release = args.release_dir.expanduser().resolve()
        manifest, digest, _ = verify_metadata(release, args.manifest_sha256, allow_candidate=args.allow_candidate)
        tag = publication_tag(manifest)
        commit = manifest.get('commit', '')
        if not re.fullmatch(TAG_PATTERN, tag) or not re.fullmatch(r'[a-f0-9]{40}', commit):
            raise RuntimeError('发布清单缺少可固定的版本或提交身份，未开始更新。')
        command = [sys.executable, '-u', '-B', str(entry), '--hermes-home', str(args.home),
            '--install-root', str(args.install_root), '--apply', '--confirm',
            '--manifest-sha256', digest, '--runner-root', str(HERE.parent),
            '--runner-manifest', str(release / 'release-manifest.json'), '--tag', tag, '--target-commit', commit]
        if manifest.get('candidate'):
            # The old bootstrap deletes its downloaded temporary bundle when
            # ACK returns. Only an explicit stable candidate directory may be
            # retained as a local source; formal releases are re-opened by tag.
            try:
                relative = release.relative_to(args.install_root / 'tavern-updates')
            except ValueError:
                relative = None
            if relative is not None and relative.parts and relative.parts[0].startswith('install-'):
                raise RuntimeError('候选资源位于旧更新器自动清理的临时目录，请指定稳定的本地验收目录。')
            command.extend(['--release-dir', str(release), '--allow-candidate'])
        raise SystemExit(subprocess.run(command, check=False).returncode)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = _error_diagnostics.exception_diagnostic(error, project_root=HERE.parents[1])
        print(json.dumps({"event": "diagnostic", "component": "updater", "error": detail}, ensure_ascii=False), flush=True)
        print(json.dumps({"event": "error", "message": detail["message"], "code": detail["code"]}, ensure_ascii=False), flush=True)
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
