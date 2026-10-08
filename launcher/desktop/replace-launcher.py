"""Replace only the desktop application; run from the existing Hermes Python."""
import hashlib
import argparse
import errno
from contextlib import contextmanager
import json
import ntpath
import os
import plistlib
import shutil
import stat
import re
import subprocess
import sys
import time
import traceback
import tempfile
import importlib.util
import uuid
import math
import zipfile
from pathlib import Path, PurePosixPath


def io_path(path):
    value = os.fspath(path)
    if os.name == 'nt':
        value = ntpath.normpath(ntpath.abspath(value.replace('/', '\\')))
        if not value.startswith('\\\\?\\'):
            value = '\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value
    return Path(value)


def exists(path):
    return os.path.lexists(io_path(path))


def error_data(error, depth=0):
    return shared_module('error_diagnostics').exception_diagnostic(error, project_root=Path(__file__).resolve().parent)


def shared_module(name, job=None):
    here = Path(__file__).resolve().parent
    candidates = ([Path(job) / (name + '.py')] if job else []) + [here / (name + '.py'),
        here.parent / (name + '.py'), here.parents[1] / 'deployment/shared' / (name + '.py')]
    path = next((path for path in candidates if path.is_file() and not path.is_symlink()), None)
    if path is None: raise ValueError('启动器执行协议资源不完整')
    spec = importlib.util.spec_from_file_location('_launcher_' + name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def read_json(path):
    file = io_path(path)
    if file.is_symlink() or file.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('启动器恢复记录不是有效文件')
    value = json.loads(file.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError('启动器恢复记录必须是对象')
    return value


def write_json(file, value):
    file = io_path(file)
    if file.is_symlink() or file.parent.is_symlink(): raise ValueError('启动器记录不能是链接')
    encoded = json.dumps(value, ensure_ascii=False).encode('utf-8')
    if len(encoded) > 2 * 1024 * 1024: raise ValueError('启动器记录容量超限')
    descriptor, temporary = tempfile.mkstemp(prefix='.' + file.name + '-', dir=file.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded); stream.flush(); os.fsync(stream.fileno())
        os.chmod(temporary, 0o600); os.replace(temporary, file); fsync_directory(file.parent)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def fsync_directory(path):
    if os.name == 'nt': return
    descriptor = os.open(io_path(path), os.O_RDONLY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def digest(file):
    result = hashlib.sha256()
    with io_path(file).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def contained(file, root):
    return file == root or root in file.parents


def extract(archive, destination, platform):
    destination = io_path(destination)
    with zipfile.ZipFile(io_path(archive)) as bundle:
        members = bundle.infolist()
        if len(members) > 100000 or sum(item.file_size for item in members) > 3 * 1024 ** 3:
            raise ValueError('更新包解压大小超限')
        names = set()
        for item in members:
            # Validate archive bytes before Windows normalizes separators or NULs.
            name = item.orig_filename
            if '\x00' in name:
                raise ValueError('更新包包含非法路径')
            # 7-Zip can write UTF-8 names without setting the ZIP UTF-8 flag.
            if not item.flag_bits & 0x800:
                try:
                    name = name.encode('cp437').decode('utf-8')
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass
            parts = PurePosixPath(name).parts
            if not parts or name.startswith('/') or '\\' in name or ':' in name or '..' in parts:
                raise ValueError('更新包包含非法路径')
            key = name.rstrip('/').casefold()
            if key in names:
                raise ValueError('更新包包含重复路径')
            names.add(key)
            target = destination.joinpath(*parts)
            if any(parent.is_symlink() for parent in target.parents if contained(parent, destination)):
                raise ValueError('更新包不能通过符号链接写入文件')
            mode = item.external_attr >> 16
            if stat.S_ISLNK(mode):
                link = bundle.read(item).decode('utf-8')
                resolved = Path(os.path.abspath(target.parent / link))
                if platform != 'darwin' or os.path.isabs(link) or not contained(resolved, destination):
                    raise ValueError('更新包包含非法链接')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(link)
            elif item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            elif stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise ValueError('更新包包含特殊文件')
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(item) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                if platform == 'darwin':
                    target.chmod(0o755 if mode & 0o111 else 0o644)


def process_identity(pid):
    import psutil
    if type(pid) is not int or pid <= 0: raise ValueError('进程标识无效')
    created = psutil.Process(pid).create_time()
    if not math.isfinite(created) or created <= 0: raise ValueError('进程出生时间无法确认')
    return {'pid': pid, 'creationTime': created}


def parent_alive(pid, creation_time=None):
    if type(pid) is not int or pid <= 0:
        return False
    if creation_time is not None:
        import psutil
        if type(creation_time) not in (int, float) or not math.isfinite(creation_time) or creation_time <= 0:
            raise ValueError('进程出生时间无效')
        try:
            process = psutil.Process(pid)
            return process.create_time() == creation_time and process.is_running() and process.status() != psutil.STATUS_ZOMBIE
        except (psutil.NoSuchProcess, psutil.ZombieProcess): return False
    if os.name == 'nt':
        import ctypes
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.WaitForSingleObject.restype = ctypes.c_ulong
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x100000, False, pid)
        if not handle:
            code = kernel.GetLastError()
            if code == 87:  # Invalid positive PID: no process object exists.
                return False
            raise ctypes.WinError(code)
        try:
            state = kernel.WaitForSingleObject(handle, 0)
            if state == 258:
                return True
            if state == 0:
                return False
            if state == 0xffffffff:
                raise ctypes.WinError(kernel.GetLastError())
            raise RuntimeError('无法确认启动器父进程已退出，未替换程序')
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def retry_rename(source, target):
    for attempt in range(100):
        try:
            os.replace(io_path(source), io_path(target))
            fsync_directory(Path(source).parent); fsync_directory(Path(target).parent)
            return
        except PermissionError:
            if attempt == 99:
                raise
            time.sleep(0.2)


def file_identity(path):
    if not exists(path):
        return None
    value = io_path(path).lstat()
    if stat.S_ISLNK(value.st_mode) or getattr(value, 'st_file_attributes', 0) & 0x400 or value.st_ino <= 0:
        raise ValueError('启动器恢复目标身份无法确认')
    return [value.st_dev, value.st_ino]


def tree_digest(root, platform):
    result = hashlib.sha256()
    count = 0
    def visit(file, relative):
        nonlocal count
        count += 1
        if count > 100000:
            raise ValueError('启动器程序文件数量超限')
        value = file.lstat()
        if stat.S_ISLNK(value.st_mode):
            link = os.readlink(file)
            resolved = Path(os.path.abspath(file.parent / link))
            if platform != 'darwin' or os.path.isabs(link) or not contained(resolved, io_path(root)):
                raise ValueError('启动器程序含目录外链接')
            result.update(b'L' + relative.encode() + b'\0' + os.fsencode(link))
            result.update(b'\0')
        elif getattr(value, 'st_file_attributes', 0) & 0x400:
            raise ValueError('启动器程序包含不支持的重解析目录')
        elif stat.S_ISDIR(value.st_mode):
            result.update(b'D' + relative.encode() + b'\0')
            for child in sorted(file.iterdir(), key=lambda item: item.name):
                visit(child, relative + '/' + child.name)
        elif stat.S_ISREG(value.st_mode):
            result.update(b'F' + relative.encode() + b'\0')
            result.update(str(value.st_size).encode() + b'\0')
            if platform == 'darwin':
                result.update(str(value.st_mode & 0o777).encode() + b'\0')
            with file.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    result.update(block)
        else:
            raise ValueError('启动器程序含不支持的文件类型')
    visit(io_path(root), '')
    return result.hexdigest()


def context(job):
    job = Path(job).resolve()
    plan = read_json(job / 'plan.json')
    app = Path(plan['appRoot'])
    home = Path(plan['home'])
    token = plan['token']
    if (plan.get('schema') not in (1, 2) or not app.is_absolute() or not home.is_absolute()
            or app == Path(app.anchor) or contained(home.resolve(), app.resolve())
            or job.parent != home / 'installer/launcher-update'
            or not re.fullmatch(r'job-[\w-]+', job.name) or not isinstance(token, str) or len(token) != 36
            or any(c not in '0123456789abcdef-' for c in token)
            or plan['platform'] not in ('darwin', 'win32')
            or app != app.resolve() or home != home.resolve()
            or any(io_path(item).is_symlink() for item in (home, job.parent.parent, job.parent, job))):
        raise ValueError('更新计划中的目录无效')
    if plan['schema'] == 2:
        compatibility = {'operationSchema': 'nora-operation/1', 'executorProtocol': 'nora-operation-executor/1',
            'telemetrySchema': 3, 'faultSchema': 2, 'compatible': True}
        try: operation_id = uuid.UUID(plan.get('operationId', ''))
        except (ValueError, TypeError, AttributeError): raise ValueError('启动器操作标识无效')
        if (operation_id.version != 4 or str(operation_id) != plan['operationId']
                or type(plan.get('ownerEpoch')) is not int or not 0 < plan['ownerEpoch'] <= 2**53 - 1
                or not re.fullmatch(r'[a-f0-9]{64}', str(plan.get('planDigest', '')))
                or plan.get('executorProtocol') != 'nora-operation-executor/1'
                or plan.get('rollbackCompatibility') != compatibility
                or not isinstance(plan.get('releasePlan'), dict) or plan['releasePlan'].get('schema') != 'nora-release-plan/1'
                or len(json.dumps(plan['releasePlan']).encode()) > 256 * 1024
                or type(plan.get('parentPid')) is not int or plan['parentPid'] <= 0
                or type(plan.get('parentCreationTime')) not in (int, float)
                or not math.isfinite(plan['parentCreationTime']) or plan['parentCreationTime'] <= 0):
            raise ValueError('启动器操作或回滚协议不受支持，未修改程序')
    executable = Path(plan['executable'])
    if executable.anchor or '..' in executable.parts or not executable.parts:
        raise ValueError('更新计划中的程序无效')
    return {'job': job, 'plan': plan, 'app': app, 'home': home, 'executable': executable,
            'stage': app.parent / ('.nora-stage-' + token),
            'backup': app.parent / ('.nora-previous-' + token),
            'failed': app.parent / ('.nora-failed-' + token)}


@contextmanager
def native_lock(file, *, readonly=False):
    file = io_path(file)
    if file.is_symlink(): raise ValueError('启动器所有者锁不能是链接')
    if readonly and not file.exists():
        yield; return
    with file.open('r+b' if readonly else 'a+b') as stream:
        if not readonly: os.chmod(file, 0o600)
        try:
            if os.name == 'nt':
                import msvcrt
                if os.fstat(stream.fileno()).st_size == 0 and not readonly:
                    stream.write(b'\0'); stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError('启动器更新或恢复正在进行，请等待完成。') from error
        try:
            yield
        finally:
            if os.name == 'nt':
                stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def job_lock(job, *, readonly=False):
    return native_lock(Path(job) / 'replace.lock', readonly=readonly)


@contextmanager
def writer_lock(ctx, *, successor=False):
    gate = getattr(sys, '_nora_operation_delegate', None)
    if gate is not None or any(name.startswith('NORA_OPERATION_DELEGATE') for name in os.environ):
        if gate is None: gate = shared_module('operation_control', ctx['job']).require_operation()
        gate.assert_active()
        if ctx['plan'].get('schema') == 2:
            epoch = getattr(gate, 'owner_epoch', ctx['plan']['ownerEpoch'])
            if (getattr(gate, 'operation_id', ctx['plan']['operationId']) != ctx['plan']['operationId']
                    or type(epoch) is not int or (epoch < ctx['plan']['ownerEpoch'] if successor else epoch != ctx['plan']['ownerEpoch'])):
                raise ValueError('启动器委托与当前操作不一致')
        yield; gate.assert_active(); return
    directory = ctx['home'] / 'installer/operations'
    if io_path(directory).is_symlink(): raise ValueError('启动器所有者目录不能是链接')
    io_path(directory).mkdir(mode=0o700, exist_ok=True); io_path(directory).chmod(0o700)
    with native_lock(directory / '.writer.lock'): yield


def checkpoint(ctx, snapshot, phase, **extra):
    snapshot.update(phase=phase, **extra)
    write_json(ctx['job'] / 'recovery.json', snapshot)
    write_json(ctx['job'] / 'status.json', {'status': phase, 'backup': str(ctx['backup']),
        'workerPid': snapshot.get('workerPid'), 'workerCreationTime': snapshot.get('workerCreationTime'),
        'operationId': snapshot.get('operationId'), 'planDigest': snapshot.get('planDigest'), **extra})


def recovery_entry(ctx):
    job, home, platform = ctx['job'], ctx['home'], ctx['plan']['platform']
    helper = job / 'replace.py'
    if not io_path(helper).is_file() or io_path(helper).is_symlink():
        raise ValueError('缺少本地启动器恢复程序，旧启动器未退出')
    if platform == 'win32':
        python = home / 'hermes/hermes-agent/venv/Scripts/python.exe'
        script = job / '恢复旧启动器.cmd'
        body = '@echo off\r\nsetlocal DisableDelayedExpansion\r\ncd /d "%SystemRoot%"\r\n"%~dp0..\\..\\..\\hermes\\hermes-agent\\venv\\Scripts\\python.exe" -B "%~dp0replace.py" --recover "%~dp0."\r\nif errorlevel 1 pause\r\n'
    else:
        directory = home / 'hermes/hermes-agent/venv/bin'
        name = next((name for name in ('python3', 'python') if io_path(directory / name).is_file()), None)
        if name is None:
            raise ValueError('未找到受管 Python，旧启动器未退出')
        python = directory / name
        script = job / '恢复旧启动器.command'
        body = '#!/bin/sh\nset -eu\njob=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec "$job/../../../hermes/hermes-agent/venv/bin/' + name + '" -B "$job/replace.py" --recover "$job"\n'
    if not io_path(python).is_file():
        raise ValueError('未找到受管 Python，旧启动器未退出')
    io_path(script).write_text(body, encoding='utf-8', newline='')
    io_path(script).chmod(0o700)
    return script


RECOVERABLE_PHASES = frozenset(('prepared', 'waiting-parent', 'moving-old', 'installing-new', 'awaiting-launcher',
                              'awaiting-system', 'recovery-prepared', 'moving-failed',
                              'restoring-old', 'recovery-failed'))


def validate_snapshot(ctx, *, full):
    snapshot = read_json(ctx['job'] / 'recovery.json')
    plan = ctx['plan']
    phase = snapshot.get('phase')
    if (snapshot.get('schema') != 'nora-launcher-recovery/1'
            or any(snapshot.get(key) != plan.get(key) for key in ('token', 'home', 'appRoot', 'executable', 'platform', 'arch', 'version', 'target'))
            or file_identity(ctx['home']) != snapshot.get('homeIdentity')
            or not isinstance(snapshot.get('old'), dict) or not isinstance(snapshot.get('incoming'), dict)
            or phase not in RECOVERABLE_PHASES | {'committed', 'restored', 'cancelled'}
            or snapshot.get('helperDigest') != digest(ctx['job'] / 'replace.py')):
        raise ValueError('启动器恢复计划与原安装身份不一致，未覆盖程序')
    if plan['schema'] == 2:
        bound = ('operationId', 'ownerEpoch', 'planDigest', 'releasePlan', 'executorProtocol', 'rollbackCompatibility',
            'parentPid', 'parentCreationTime')
        if (any(snapshot.get(key) != plan.get(key) for key in bound)
                or snapshot.get('planSeal') != hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                or not isinstance(snapshot.get('resourceDigests'), dict)
                or set(snapshot['resourceDigests']) != {'operation_control.py', 'operation_evidence.py', 'error_diagnostics.py', 'operation-budget.json'}
                or any(file_identity(ctx['job'] / name) is None or snapshot['resourceDigests'][name] != digest(ctx['job'] / name)
                    for name in snapshot['resourceDigests']) or file_identity(ctx['job'] / 'replace.py') is None):
            raise ValueError('启动器固定操作或执行资源已变化，未覆盖程序')
        if phase not in ('prepared', 'cancelled') and (type(snapshot.get('workerPid')) is not int
                or snapshot['workerPid'] <= 0 or type(snapshot.get('workerCreationTime')) not in (int, float)
                or not math.isfinite(snapshot['workerCreationTime']) or snapshot['workerCreationTime'] <= 0):
            raise ValueError('启动器工作进程身份记录不完整')
    old, incoming = snapshot['old'], snapshot['incoming']
    for item in (old, incoming):
        if (not isinstance(item.get('identity'), list) or len(item['identity']) != 2
                or any(type(value) is not int or value < 0 for value in item['identity'])
                or item['identity'][1] <= 0
                or not re.fullmatch(r'[a-f0-9]{64}', str(item.get('digest', '')))):
            raise ValueError('启动器恢复计划缺少原程序快照')
    if not old.get('version') or old.get('version') != plan.get('previousVersion'):
        raise ValueError('启动器恢复计划缺少旧版本')
    current, backup, failed = (file_identity(ctx[key]) for key in ('app', 'backup', 'failed'))
    if phase == 'committed':
        if current != incoming['identity'] or (full and tree_digest(ctx['app'], plan['platform']) != incoming['digest']):
            raise ValueError('已提交启动器的身份或内容已变化')
        return snapshot
    if failed is not None and (failed != incoming['identity'] or (full and tree_digest(ctx['failed'], plan['platform']) != incoming['digest'])):
        raise ValueError('失败程序现场身份或内容已变化，未覆盖证据')
    if backup is not None:
        if backup != old['identity'] or (full and tree_digest(ctx['backup'], plan['platform']) != old['digest']):
            raise ValueError('旧启动器备份身份或内容已变化，未覆盖程序')
        if current is not None and current != incoming['identity']:
            raise ValueError('当前启动器身份未知，未覆盖程序')
        if full and current is not None and tree_digest(ctx['app'], plan['platform']) != incoming['digest']:
            raise ValueError('当前启动器内容已变化，未覆盖程序')
    elif current != old['identity'] or (full and tree_digest(ctx['app'], plan['platform']) != old['digest']):
        raise ValueError('旧启动器备份缺失，尚未确认已安全恢复')
    return snapshot


def untouched(ctx, snapshot):
    return (not exists(ctx['backup']) and file_identity(ctx['app']) == snapshot['old']['identity']
        and tree_digest(ctx['app'], ctx['plan']['platform']) == snapshot['old']['digest'])


def assess(job, *, allow_legacy=False):
    try:
        ctx = context(job)
        # Old successful jobs had no durable recovery contract and no retained backup.
        if not exists(ctx['job'] / 'recovery.json'):
            status = read_json(ctx['job'] / 'status.json') if exists(ctx['job'] / 'status.json') else {}
            if status.get('status') == 'success' and not exists(ctx['backup']):
                return None
            if (status.get('status') == 'not-replaced' and not exists(ctx['backup'])
                    and file_identity(ctx['app']) == status.get('appIdentity')
                    and file_identity(ctx['home']) == status.get('homeIdentity')):
                return None
            raise ValueError('旧更新记录缺少完整恢复计划，不能安全恢复。请保留日志和备份。')
        snapshot = validate_snapshot(ctx, full=False)
        phase = snapshot['phase']
        if phase in ('committed', 'restored', 'cancelled'):
            return None
        busy = False
        try:
            with job_lock(ctx['job'], readonly=True):
                pass
        except RuntimeError:
            busy = True
        current, backup, failed = (file_identity(ctx[key]) for key in ('app', 'backup', 'failed'))
        is_untouched = current == snapshot['old']['identity'] and backup is None and failed is None and phase in ('prepared', 'waiting-parent', 'moving-old')
        effect = 'untouched' if is_untouched else 'restored' if current == snapshot['old']['identity'] and backup is None else 'changed'
        worker_offline = False
        worker_error = None
        if type(snapshot.get('workerPid')) is int and snapshot.get('workerCreationTime') is not None:
            import psutil
            try: worker_offline = not parent_alive(snapshot['workerPid'], snapshot['workerCreationTime'])
            except (psutil.Error, OSError, ValueError) as error: worker_error = error
        supported = ctx['plan']['schema'] == 2 or allow_legacy or is_untouched
        return {'job': str(ctx['job']), 'status': phase, 'canRecover': not busy and supported and worker_error is None, 'busy': busy,
                'workerOffline': worker_offline, 'untouched': is_untouched, 'effectState': effect,
                'operationId': snapshot.get('operationId'), 'planDigest': snapshot.get('planDigest'),
                'reason': '启动器更新或恢复正在进行，请等待完成。' if busy else '工作进程身份无法确认，已保留现场' if worker_error else '' if supported else '旧启动器恢复记录不支持当前操作协议',
                'version': snapshot['old']['version'], 'backup': str(ctx['backup']),
                'log': str(ctx['job'] / 'replace.log'),
                'script': str(ctx['job'] / ('恢复旧启动器.cmd' if ctx['plan']['platform'] == 'win32' else '恢复旧启动器.command'))}
    except (OSError, ValueError, KeyError, TypeError) as error:
        reason = '启动器恢复记录暂时无法读取。请保留日志和备份。' if isinstance(error, OSError) else str(error)
        return {'job': str(job), 'canRecover': False, 'reason': reason, 'effectState': 'unknown', 'workerOffline': False,
                'diagnosticError': error_data(error), 'log': str(Path(job) / 'replace.log')}


def require_launcher_offline(ctx):
    import psutil
    current_user = psutil.Process().username()
    for process in psutil.process_iter():
        try:
            executable = process.exe()
            if executable and any(contained(Path(executable), root) for root in (ctx['app'], ctx['backup'])):
                raise RuntimeError('启动器仍在运行，请先关闭启动器后再恢复。')
        except (psutil.NoSuchProcess, psutil.ZombieProcess): continue
        except psutil.AccessDenied as error:
            try: other_user = process.username() != current_user
            except (psutil.NoSuchProcess, psutil.ZombieProcess): continue
            except psutil.AccessDenied: other_user = False
            if not other_user:
                raise RuntimeError('当前用户进程路径无法确认，已保留启动器现场') from error


def launcher_environment(ctx):
    env = {key: value for key, value in os.environ.items() if not key.startswith('NORA_OPERATION_DELEGATE')}
    env.pop('ELECTRON_RUN_AS_NODE', None); env.pop('NODE_OPTIONS', None); env.pop('NODE_PATH', None)
    env.pop('__PYVENV_LAUNCHER__', None)
    env['NORA_TAVERN_HOME'] = str(ctx['home'])
    return env


def launcher_cwd(home):
    # CreateProcessW rejects a >MAX_PATH cwd, including extended namespace paths.
    # Program assets and user data are already addressed absolutely.
    if os.name != 'nt' or len(str(home)) < 248:
        return home
    directory = Path(Path(sys.executable).anchor)
    if not directory.is_absolute() or len(str(directory)) >= 248 or not directory.is_dir():
        raise ValueError('没有可用的短启动目录，请保留程序和恢复日志')
    return directory


def launch_old(ctx):
    env = launcher_environment(ctx)
    args = [str(ctx['app'] / ctx['executable'])]
    if ctx['plan'].get('localRelease'):
        args.append('--nora-local-release=' + ctx['plan']['localRelease'])
    options = {'executable': str(io_path(ctx['app'] / ctx['executable']))} if os.name == 'nt' else {}
    return subprocess.Popen(args, cwd=launcher_cwd(ctx['home']), env=env,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=os.name != 'nt', **options)


def worker_identity():
    return {'workerPid': os.getpid(), 'workerCreationTime': process_identity(os.getpid())['creationTime']}


def freeze_failure(ctx, error):
    seen = set()
    def capture(current):
        if current is None or id(current) in seen or len(seen) >= 4: return
        seen.add(id(current))
        if getattr(current, '_bridge_diagnostic_stack', None) is None:
            current._bridge_diagnostic_stack = [traceback.FrameSummary(frame.f_code.co_filename, line, frame.f_code.co_name,
                lookup_line=False) for frame, line in traceback.walk_tb(current.__traceback__)
                if Path(frame.f_code.co_filename).resolve() == Path(__file__).resolve()
                or Path(frame.f_code.co_filename).resolve().parent == ctx['job']]
        capture(current.__cause__ or (None if current.__suppress_context__ else current.__context__))
        for secondary in getattr(current, 'secondary_errors', ()): capture(secondary)
    capture(error)
    try:
        shared_module('operation_evidence', ctx['job']).freeze(error, nora_home=ctx['home'],
            operation_id=ctx['plan'].get('operationId') or ctx['plan']['token'],
            installer_directory=ctx['home'] / 'installer', context={'stage': 'restoring'})
    except Exception as saving:
        error.secondary_errors = [*getattr(error, 'secondary_errors', ()), saving]
        error._diagnostic_missing = [*getattr(error, '_diagnostic_missing', ()), 'evidence_save_failed']


def report_failure(ctx, snapshot, phase, error, **extra):
    try: checkpoint(ctx, snapshot, phase, diagnosticError=error_data(error), **extra)
    except Exception as recording:
        error.secondary_errors = [*getattr(error, 'secondary_errors', ()), recording]
        error._diagnostic_missing = [*getattr(error, '_diagnostic_missing', ()), 'status_save_failed']


def clean_stage(ctx, snapshot):
    if not exists(ctx['stage']): return
    if file_identity(ctx['stage']) != snapshot.get('stageIdentity'):
        raise ValueError('启动器准备目录身份变化，已保留现场')
    incoming = incoming_path(ctx, snapshot)
    if exists(incoming):
        if tree_digest(ctx['stage'], ctx['plan']['platform']) != snapshot.get('stageDigest'):
            raise ValueError('启动器准备目录内容变化，已保留现场')
    elif any(io_path(ctx['stage']).iterdir()):
        raise ValueError('启动器准备目录含未知文件，已保留现场')
    shutil.rmtree(io_path(ctx['stage'])); fsync_directory(ctx['stage'].parent)


def incoming_path(ctx, snapshot):
    relative = snapshot.get('incomingRelative')
    if relative == '.': return ctx['stage']
    if not isinstance(relative, str) or Path(relative).name != relative or relative in ('', '.', '..'):
        raise ValueError('启动器准备路径不受信任')
    return ctx['stage'] / relative


def wait_parent(pid, created, *, cancel=None):
    deadline = time.monotonic() + 60
    while parent_alive(pid, created):
        if cancel is not None and exists(cancel) or time.monotonic() > deadline:
            raise TimeoutError('启动器尚未退出，已保留程序和备份')
        time.sleep(0.1)


def cancel_untouched(ctx, snapshot):
    if not untouched(ctx, snapshot): raise ValueError('原程序现场发生变化，未取消恢复')
    checkpoint(ctx, snapshot, 'cancelled', **worker_identity())
    try: clean_stage(ctx, snapshot)
    except (OSError, ValueError) as cleanup:
        checkpoint(ctx, snapshot, 'cancelled', cleanupError=error_data(cleanup))
    return {'restored': False, 'untouched': True, 'restarting': False}


def restore(ctx, *, parent_pid=0, parent_creation_time=None, allow_legacy=False):
    snapshot = validate_snapshot(ctx, full=True)
    if snapshot.get('phase') == 'cancelled': return {'restored': False, 'untouched': True, 'restarting': False}
    if snapshot.get('phase') == 'committed': raise ValueError('此启动器更新已提交，无需恢复')
    if snapshot.get('phase') == 'restored': return {'restored': True, 'restarting': False}
    if snapshot['phase'] in ('prepared', 'waiting-parent', 'moving-old') and untouched(ctx, snapshot):
        return cancel_untouched(ctx, snapshot)
    if ctx['plan']['schema'] != 2 and not allow_legacy:
        raise ValueError('旧启动器回滚协议未知，未覆盖程序')
    if parent_pid and ctx['plan']['schema'] == 2:
        if parent_creation_time is None: raise ValueError('恢复父进程缺少出生时间，未覆盖程序')
        sealed = snapshot.get('recoveryParent')
        if sealed != {'pid': parent_pid, 'creationTime': parent_creation_time}:
            raise ValueError('恢复父进程与准备记录不一致')
    checkpoint(ctx, snapshot, 'recovery-prepared', **worker_identity())
    if parent_pid: wait_parent(parent_pid, parent_creation_time)
    require_launcher_offline(ctx)
    validate_snapshot(ctx, full=True)
    if file_identity(ctx['app']) != snapshot['old']['identity']:
        if exists(ctx['app']):
            if exists(ctx['failed']): raise ValueError('失败程序现场已存在，未覆盖证据')
            checkpoint(ctx, snapshot, 'moving-failed'); retry_rename(ctx['app'], ctx['failed'])
        checkpoint(ctx, snapshot, 'restoring-old'); retry_rename(ctx['backup'], ctx['app'])
    validate_snapshot(ctx, full=True)
    should_launch = not snapshot.get('launchAttempted')
    checkpoint(ctx, snapshot, 'restored', launchAttempted=True)
    state_file = ctx['home'] / 'installer/state.json'
    try: state = read_json(state_file) if exists(state_file) else {}
    except (OSError, ValueError): state = {}
    state.update(phase='error', resumeTarget=None, task='', error='已恢复旧启动器。请检查更新日志后再决定是否重新更新。')
    try: write_json(state_file, state)
    except OSError as error:
        snapshot['stateWriteError'] = error_data(error); checkpoint(ctx, snapshot, 'restored')
        print('旧程序已恢复，但状态写入失败', file=sys.stderr, flush=True)
    if should_launch:
        try: launch_old(ctx)
        except OSError as error:
            checkpoint(ctx, snapshot, 'restored', relaunchError=error_data(error))
            raise RuntimeError('旧程序已恢复，但无法重新打开。请手动打开原启动器。') from error
    return {'restored': True, 'restarting': False}


def prepare_recovery(job, *, parent_pid, parent_creation_time):
    ctx = context(job)
    with writer_lock(ctx, successor=True), job_lock(ctx['job']):
        snapshot = validate_snapshot(ctx, full=True)
        if ctx['plan']['schema'] != 2 and not untouched(ctx, snapshot):
            raise ValueError('旧启动器回滚协议未知，未覆盖程序')
        if process_identity(parent_pid) != {'pid': parent_pid, 'creationTime': parent_creation_time}:
            raise ValueError('恢复父进程身份不一致')
        checkpoint(ctx, snapshot, snapshot['phase'], recoveryParent={'pid': parent_pid, 'creationTime': parent_creation_time})
        return {'prepared': True, 'job': str(ctx['job']), 'operationId': ctx['plan'].get('operationId')}


def recover(job, *, parent_pid=0, parent_creation_time=None, allow_legacy=False):
    ctx = context(job)
    with writer_lock(ctx, successor=True), job_lock(ctx['job']):
        snapshot = validate_snapshot(ctx, full=True)
        # No default legacy rollback across an unrecognized operation protocol.
        if ctx['plan']['schema'] != 2 and not allow_legacy and not untouched(ctx, snapshot):
            raise ValueError('旧启动器回滚协议未知，未覆盖程序')
        try: return restore(ctx, parent_pid=parent_pid, parent_creation_time=parent_creation_time, allow_legacy=allow_legacy)
        except Exception as error:
            freeze_failure(ctx, error)
            try: phase = read_json(ctx['job'] / 'recovery.json').get('phase')
            except Exception as recording:
                error.secondary_errors = [*getattr(error, 'secondary_errors', ()), recording]; phase = snapshot.get('phase')
            if phase not in ('committed', 'restored', 'cancelled'): report_failure(ctx, snapshot, 'recovery-failed', error, **worker_identity())
            freeze_failure(ctx, error)
            raise


def finalize(job, *, target, version, verified, allow_legacy=False):
    ctx = context(job)
    with writer_lock(ctx, successor=True), job_lock(ctx['job']):
        snapshot = validate_snapshot(ctx, full=True)
        if ctx['plan']['schema'] != 2 and not allow_legacy: raise ValueError('旧启动器提交协议未知')
        if (verified is not True or target.lstrip('v') != str(ctx['plan'].get('target', '')).lstrip('v')
                or version != ctx['plan']['version']):
            raise ValueError('联合更新尚未通过实际验收，旧启动器备份继续保留')
        if snapshot.get('phase') == 'committed': return {'status': 'committed'}
        if snapshot.get('phase') != 'awaiting-system' or file_identity(ctx['app']) != snapshot['incoming']['identity']:
            raise ValueError('启动器尚未确认成功，旧备份继续保留')
        if ctx['plan']['schema'] == 2 and parent_alive(snapshot['workerPid'], snapshot['workerCreationTime']):
            raise ValueError('启动器替换助手尚未退出，旧备份继续保留')
        checkpoint(ctx, snapshot, 'committed')
        try: shutil.rmtree(io_path(ctx['backup'])); fsync_directory(ctx['backup'].parent)
        except OSError: return {'status': 'committed', 'retainedBackup': str(ctx['backup'])}
        return {'status': 'committed'}


def prepare(job, *, allow_legacy=False):
    ctx = context(job)
    if ctx['plan']['schema'] != 2 and not allow_legacy: raise ValueError('旧启动器准备协议未知')
    with writer_lock(ctx), job_lock(ctx['job']): return prepare_context(ctx)


def prepare_context(ctx):
    job, plan, app, home, executable, stage, backup = (ctx[key] for key in ('job', 'plan', 'app', 'home', 'executable', 'stage', 'backup'))
    if (not io_path(app).is_dir() or file_identity(app) is None or not io_path(app / executable).is_file()
            or not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][\w.-]+)?', str(plan.get('previousVersion', '')))):
        raise ValueError('更新计划中的原程序或版本无效')
    if exists(job / 'recovery.json') or exists(stage) or exists(backup) or exists(ctx['failed']):
        raise ValueError('此更新任务已有恢复现场，请先恢复旧启动器')
    initial_identity, home_identity = file_identity(app), file_identity(home)
    snapshot = None
    try:
        if digest(Path(plan['archive'])) != plan['sha256']:
            raise ValueError('更新包校验失败')
        io_path(stage).mkdir(mode=0o700)
        extract(Path(plan['archive']), stage, plan['platform'])
        if plan['platform'] == 'darwin':
            apps = list(io_path(stage).glob('*.app'))
            if len(apps) != 1:
                raise ValueError('更新包必须包含唯一应用')
            incoming = stage / apps[0].name
            with io_path(incoming / 'Contents/Info.plist').open('rb') as file:
                info = plistlib.load(file)
            with io_path(app / 'Contents/Info.plist').open('rb') as file:
                previous = plistlib.load(file)
            if (info['CFBundleIdentifier'] != previous['CFBundleIdentifier']
                    or info['CFBundleShortVersionString'] != plan['version']
                    or previous['CFBundleShortVersionString'] != plan['previousVersion']):
                raise ValueError('应用标识与原安装不一致')
            subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(incoming)], check=True, timeout=60)
            resources = incoming / 'Contents/Resources'
        else:
            incoming = stage
            resources = incoming / 'resources'
            # NSIS owns the existing uninstall registration and executable.
            for uninstaller in io_path(app).glob('Uninstall*.exe'):
                if uninstaller.is_symlink():
                    raise ValueError('卸载程序不能是符号链接')
                shutil.copy2(uninstaller, io_path(incoming / uninstaller.name))
        identity = read_json(resources / 'launcher-update-info.json')
        if (identity['version'] != plan['version'] or identity['platform'] != plan['platform']
                or identity['arch'] != plan['arch'] or not io_path(incoming / executable).is_file()):
            raise ValueError('更新包身份不匹配')
        script = recovery_entry(ctx)
        if plan['platform'] == 'darwin' and list(io_path(stage).iterdir()) != [io_path(incoming)]:
            raise ValueError('更新包必须只包含受管应用')
        snapshot = {key: plan.get(key) for key in ('token', 'home', 'appRoot', 'executable', 'platform', 'arch', 'version', 'target')}
        snapshot.update(schema='nora-launcher-recovery/1', homeIdentity=home_identity, helperDigest=digest(job / 'replace.py'),
            old={'identity': initial_identity, 'digest': tree_digest(app, plan['platform']), 'version': plan['previousVersion']},
            incoming={'identity': file_identity(incoming), 'digest': tree_digest(incoming, plan['platform'])},
            stageIdentity=file_identity(stage), stageDigest=tree_digest(stage, plan['platform']),
            incomingRelative='.' if incoming == stage else incoming.name)
        if plan['schema'] == 2:
            snapshot.update({key: plan[key] for key in ('operationId', 'ownerEpoch', 'planDigest', 'releasePlan', 'executorProtocol',
                'rollbackCompatibility', 'parentPid', 'parentCreationTime')})
            snapshot['planSeal'] = hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            snapshot['resourceDigests'] = {name: digest(job / name) for name in
                ('operation_control.py', 'operation_evidence.py', 'error_diagnostics.py', 'operation-budget.json')}
        checkpoint(ctx, snapshot, 'prepared', **worker_identity())
        return {'prepared': True, 'job': str(job), 'status': 'prepared', 'operationId': plan.get('operationId'), 'planDigest': plan.get('planDigest')}
    except Exception as error:
        freeze_failure(ctx, error)
        # The failed extraction is retained. No unsealed directory is erased.
        try:
            write_json(job / 'status.json', {'status': 'not-replaced', 'appIdentity': initial_identity,
                'homeIdentity': home_identity, **worker_identity(), 'diagnosticError': error_data(error)})
        except Exception as recording: error.secondary_errors = [*getattr(error, 'secondary_errors', ()), recording]
        raise


def run(job, *, allow_legacy=False):
    ctx = context(job)
    if ctx['plan']['schema'] != 2 and not allow_legacy: raise ValueError('旧启动器执行协议未知')
    with writer_lock(ctx), job_lock(ctx['job']):
        if ctx['plan']['schema'] == 1: prepare_context(ctx)
        return replace(ctx, allow_legacy=allow_legacy)


def replace(ctx, *, allow_legacy=False):
    job, plan, app, home, executable, stage, backup = (ctx[key] for key in ('job', 'plan', 'app', 'home', 'executable', 'stage', 'backup'))
    snapshot = validate_snapshot(ctx, full=True)
    if snapshot['phase'] != 'prepared': raise ValueError('启动器替换尚未准备或已有恢复现场')
    incoming = incoming_path(ctx, snapshot)
    if (file_identity(stage) != snapshot['stageIdentity'] or file_identity(incoming) != snapshot['incoming']['identity']
            or tree_digest(stage, plan['platform']) != snapshot['stageDigest']):
        raise ValueError('已准备的启动器内容变化，未覆盖程序')
    moved = False; child = None
    try:
        checkpoint(ctx, snapshot, 'waiting-parent', **worker_identity())
        wait_parent(plan['parentPid'], plan.get('parentCreationTime'), cancel=job / 'cancel')
        if exists(job / 'cancel'): raise RuntimeError('更新已取消')
        validate_snapshot(ctx, full=True)
        if not untouched(ctx, snapshot): raise ValueError('原启动器在准备期间发生变化，未替换程序')
        checkpoint(ctx, snapshot, 'moving-old'); retry_rename(app, backup); moved = True
        checkpoint(ctx, snapshot, 'installing-new'); retry_rename(incoming, app)
        checkpoint(ctx, snapshot, 'awaiting-launcher')
        args = [str(app / executable), '--nora-self-update=' + str(job)]
        if plan.get('localRelease'): args.append('--nora-local-release=' + plan['localRelease'])
        options = {'executable': str(io_path(app / executable))} if os.name == 'nt' else {}
        child = subprocess.Popen(args, cwd=launcher_cwd(home), env=launcher_environment(ctx), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=os.name != 'nt', **options)
        expected_ack = {'token': plan['token'], 'version': plan['version']}
        if plan['schema'] == 2: expected_ack.update(schema='nora-launcher-handoff/1', operationId=plan['operationId'], planDigest=plan['planDigest'])
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if exists(job / 'ready.json') and read_json(job / 'ready.json') == expected_ack:
                checkpoint(ctx, snapshot, 'awaiting-system')
                try: clean_stage(ctx, snapshot)
                except (OSError, ValueError) as cleanup: checkpoint(ctx, snapshot, 'awaiting-system', cleanupError=error_data(cleanup))
                return {'status': 'awaiting-system', 'operationId': plan.get('operationId'), 'planDigest': plan.get('planDigest')}
            if child.poll() is not None: raise RuntimeError('新版启动器提前退出')
            time.sleep(0.2)
        raise TimeoutError('新版启动器未确认启动')
    except Exception as error:
        # Freeze before stopping/replacing any failed tree. A later restore error
        # remains secondary to this exact exception instance.
        freeze_failure(ctx, error)
        if child:
            try:
                if child.poll() is not None: child = None
                if child is not None:
                    child.terminate()
                    try: child.wait(timeout=10)
                    except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=10)
            except Exception as stopping: error.secondary_errors = [*getattr(error, 'secondary_errors', ()), stopping]
        if moved:
            try: restore(ctx, allow_legacy=allow_legacy)
            except Exception as recovery_error:
                error.secondary_errors = [*getattr(error, 'secondary_errors', ()), recovery_error]
                report_failure(ctx, snapshot, 'recovery-failed', error, rollbackError=error_data(recovery_error))
            else:
                report_failure(ctx, snapshot, 'restored', error, launchAttempted=True)
        else:
            try: cancel_untouched(ctx, snapshot)
            except Exception as recovery_error:
                error.secondary_errors = [*getattr(error, 'secondary_errors', ()), recovery_error]
                report_failure(ctx, snapshot, 'recovery-failed', error)
        freeze_failure(ctx, error)
        raise


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--assess', metavar='JOB')
    modes.add_argument('--prepare', metavar='JOB')
    modes.add_argument('--prepare-recovery', metavar='JOB')
    modes.add_argument('--process-identity', type=int, metavar='PID')
    modes.add_argument('--recover', metavar='JOB')
    modes.add_argument('--finalize', metavar='JOB')
    parser.add_argument('job', nargs='?')
    parser.add_argument('--parent-pid', type=int, default=0)
    parser.add_argument('--parent-created', '--parent-creation-time', dest='parent_created', type=float)
    parser.add_argument('--target')
    parser.add_argument('--version')
    parser.add_argument('--verified', action='store_true')
    args = parser.parse_args()
    job = Path(args.assess or args.prepare or args.prepare_recovery or args.recover or args.finalize or args.job or '').absolute()
    if not (args.assess or args.prepare or args.prepare_recovery or args.process_identity or args.recover or args.finalize or args.job):
        parser.error('缺少更新任务目录')
    try:
        if args.process_identity:
            result = process_identity(args.process_identity)
        elif args.prepare:
            result = prepare(job)
        elif args.prepare_recovery:
            result = prepare_recovery(job, parent_pid=args.parent_pid, parent_creation_time=args.parent_created)
        elif args.assess:
            result = assess(job)
        elif args.recover:
            result = recover(job, parent_pid=args.parent_pid, parent_creation_time=args.parent_created)
        elif args.finalize:
            result = finalize(job, target=args.target or '', version=args.version or '', verified=args.verified)
        else:
            run(job)
            return
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except Exception as error:
        # Never change a corrupt/unowned recovery plan merely to report its rejection.
        if args.job and not exists(job / 'status.json'):
            write_json(job / 'status.json', {'status': 'error', 'error': str(error), 'workerPid': os.getpid(), 'diagnosticError': error_data(error)})
        elif args.recover:
            try:
                status = read_json(job / 'status.json')
                if status.get('workerPid') != os.getpid():
                    write_json(job / 'status.json', {'status': 'error', 'error': str(error), 'workerPid': os.getpid(), 'diagnosticError': error_data(error)})
            except (OSError, ValueError):
                pass
        if not args.job:
            print(json.dumps({'error': error_data(error)}, ensure_ascii=False), flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
