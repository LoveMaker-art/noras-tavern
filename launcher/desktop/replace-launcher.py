"""Replace only the desktop application; run from the existing Hermes Python."""
import hashlib
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import errno
import json
import ntpath
import os
import plistlib
import shutil
import shlex
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


def read_json(path, *, max_bytes=2 * 1024 * 1024):
    file = io_path(path)
    if file.is_symlink() or file.stat().st_size > max_bytes:
        raise ValueError('启动器恢复记录不是有效文件')
    value = json.loads(file.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError('启动器恢复记录必须是对象')
    return value


def write_json(file, value):
    encoded = json.dumps(value, ensure_ascii=False).encode('utf-8')
    if len(encoded) > 2 * 1024 * 1024: raise ValueError('启动器记录容量超限')
    write_bytes(file, encoded)


def write_bytes(file, encoded, *, mode=0o600):
    file = io_path(file)
    if file.is_symlink() or file.parent.is_symlink(): raise ValueError('启动器记录不能是链接')
    descriptor, temporary = tempfile.mkstemp(prefix='.' + file.name + '-', dir=file.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded); stream.flush(); os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        # Windows readers can briefly prevent replacement even when their
        # handles share DELETE. Retain this exact payload and the old record
        # while waiting; permanent denial still fails within a bounded time.
        deadline = time.monotonic() + 2
        while True:
            try:
                os.replace(temporary, file)
                break
            except OSError as error:
                remaining = deadline - time.monotonic()
                if getattr(error, 'winerror', None) not in (5, 32, 33) or remaining <= 0:
                    raise
                time.sleep(min(0.02, remaining))
        fsync_directory(file.parent)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def fsync_directory(path):
    if os.name == 'nt': return
    descriptor = os.open(io_path(path), os.O_RDONLY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def digest(file, *, on_progress=None):
    result = hashlib.sha256()
    with io_path(file).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
            if on_progress is not None: on_progress(len(block), 0)
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


def tree_digest(root, platform, *, on_progress=None, scope=None):
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
            if on_progress is not None: on_progress(0, 1)
        elif getattr(value, 'st_file_attributes', 0) & 0x400:
            raise ValueError('启动器程序包含不支持的重解析目录')
        elif stat.S_ISDIR(value.st_mode):
            result.update(b'D' + relative.encode() + b'\0')
            if on_progress is not None: on_progress(0, 1)
            children = (file / name for name in scope[relative]) if scope is not None else sorted(file.iterdir(), key=lambda item: item.name)
            for child in children:
                visit(child, relative + '/' + child.name)
        elif stat.S_ISREG(value.st_mode):
            empty_windows_file = platform == 'win32' and value.st_size == 0
            if empty_windows_file:
                # The existing protocol hashes no content bytes for an empty file.
                # A Windows deny-read handle need not prevent proving that case.
                after = file.lstat()
                if (value.st_ino <= 0 or not stat.S_ISREG(after.st_mode) or getattr(after, 'st_file_attributes', 0) & 0x400
                        or any(getattr(after, name) != getattr(value, name) for name in
                               ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_mtime_ns', 'st_ctime_ns'))):
                    raise ValueError('启动器空文件在核验期间变化，未覆盖程序')
            result.update(b'F' + relative.encode() + b'\0')
            result.update(str(value.st_size).encode() + b'\0')
            if platform == 'darwin':
                result.update(str(value.st_mode & 0o777).encode() + b'\0')
            if on_progress is not None: on_progress(0, 1)
            if empty_windows_file:
                return
            with file.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    result.update(block)
                    if on_progress is not None: on_progress(len(block), 0)
        else:
            raise ValueError('启动器程序含不支持的文件类型')
    visit(io_path(root), '')
    return result.hexdigest()


def windows_program_paths(old, staged):
    """Use the verified package layout to locate old program files without scanning old extras."""
    paths = []

    def match(current, packaged, prefix=''):
        for source in sorted(packaged.iterdir(), key=lambda item: item.name):
            target = current / source.name
            try:
                value = target.lstat()
            except FileNotFoundError:
                continue
            relative = prefix + source.name
            if getattr(value, 'st_file_attributes', 0) & 0x400 or not (
                    stat.S_ISDIR(value.st_mode) if source.is_dir() else stat.S_ISREG(value.st_mode)):
                raise ValueError('原启动器受管文件类型已变化: ' + relative)
            paths.append(relative)
            if source.is_dir():
                match(target, source, relative + '/')

    match(io_path(old), io_path(staged))
    return sorted(paths)


def previous_app_scope(ctx, old):
    # Old jobs keep their exact original whole-tree contract.
    if 'programPaths' not in old:
        return None
    paths = old['programPaths']
    if (ctx['plan']['schema'] != 2 or ctx['plan']['platform'] != 'win32'
            or not isinstance(paths, list) or not 1 <= len(paths) <= 100000
            or any(not isinstance(item, str) for item in paths)
            or paths != sorted(paths) or len({item.casefold() for item in paths}) != len(paths)
            or ctx['executable'].as_posix() not in paths):
        raise ValueError('启动器恢复计划的受管程序范围无效')
    scope = {'': []}
    for path in paths:
        parent, _, name = path.rpartition('/')
        parent = '/' + parent if parent else ''
        if (path.startswith('/') or not name or name in ('.', '..') or name.endswith((' ', '.'))
                or any(char in name for char in '\\:<>|?*"\x00') or parent not in scope):
            raise ValueError('启动器恢复计划的受管程序路径无效')
        relative = '/' + path
        scope[parent].append(name)
        scope[relative] = []
    return scope


def retire_previous_app(ctx, old):
    backup = io_path(ctx['backup'])
    if 'programPaths' not in old:
        shutil.rmtree(backup)
    else:
        # Only remove the verified paths. rmdir atomically leaves any folder
        # that still contains an old-only or user-created entry.
        for path in reversed([backup, *(backup / path for path in old['programPaths'])]):
            if stat.S_ISDIR(path.lstat().st_mode):
                try:
                    path.rmdir()
                except OSError as error:
                    if error.errno != errno.ENOTEMPTY and getattr(error, 'winerror', None) != 145:
                        raise
            else:
                path.unlink()
    fsync_directory(backup.parent)


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
    file_identity(file)
    if readonly and not file.exists():
        yield; return
    with file.open('r+b' if readonly else 'a+b') as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode): raise ValueError('启动器所有者锁不是有效文件')
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
            if file_identity(file) != [opened.st_dev, opened.st_ino]:
                raise ValueError('启动器所有者锁身份已变化')
            if not readonly: os.chmod(file, 0o600)
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


def helper_runtime(ctx, ref=None):
    if ref is None: ref = ctx['plan'].get('helperRuntime')
    if ref is None: return None  # Preserve the original old-job contract.
    if (not isinstance(ref, dict) or ref.get('schema') != 'nora-app-helper-runtime-ref/1'
            or not re.fullmatch(r'[a-f0-9]{64}', ref.get('imageSha256', ''))
            or not re.fullmatch(r'[a-f0-9]{64}', ref.get('descriptorSha256', ''))
            or not re.fullmatch(r'python/(?:bin/python\d+\.\d+|python\.exe)', ref.get('executable', ''))):
        raise ValueError('APP助手运行引用无效，已保留程序现场')
    base = ctx['home'] / 'installer/app-helper-runtime'
    root = Path(ref.get('root', '')).absolute()
    allowed = {base / ref['imageSha256']}
    if ctx['plan']['platform'] == 'win32':
        allowed.add(base / ref['imageSha256'][:20])
    descriptor_file = base / (ref['imageSha256'] + '.json')
    if (root not in allowed or io_path(root).is_symlink()
            or io_path(base).is_symlink() or io_path(descriptor_file).is_symlink()
            or not io_path(root).is_dir() or not io_path(descriptor_file).is_file()
            or io_path(descriptor_file).stat().st_size > 8 * 1024 * 1024):
        raise ValueError('APP助手运行目录或清单与原任务不符')
    file_identity(base); root_identity = file_identity(root); file_identity(descriptor_file)
    descriptor_bytes = io_path(descriptor_file).read_bytes()
    if hashlib.sha256(descriptor_bytes).hexdigest() != ref['descriptorSha256']:
        raise ValueError('APP助手清单与原任务摘要不符')
    descriptor = json.loads(descriptor_bytes)
    if (descriptor.get('schema') != 'nora-app-helper-runtime/1' or descriptor.get('imageSha256') != ref['imageSha256']
            or descriptor.get('platform') != ctx['plan']['platform'] or descriptor.get('arch') != ctx['plan']['arch']
            or descriptor.get('root') != 'app-helper-runtime' or descriptor.get('pythonRoot') != 'python'
            or not isinstance(descriptor.get('files'), list) or not 1 < len(descriptor['files']) <= 25000):
        raise ValueError('APP助手清单不适用于原任务')
    expected = {item['path']: item for item in descriptor['files']}
    if len(expected) != len(descriptor['files']): raise ValueError('APP助手清单路径重复')
    seen, total, visited = set(), 0, 0
    def visit(directory, prefix='', depth=0):
        nonlocal total, visited
        if depth > 64: raise ValueError('APP助手运行目录层级超限')
        for file in io_path(directory).iterdir():
            visited += 1
            if visited > 50000: raise ValueError('APP助手运行资源数量超限')
            name = prefix + file.name
            value = file.lstat()
            if getattr(value, 'st_file_attributes', 0) & 0x400:
                raise ValueError('APP助手运行目录含重定向文件')
            if stat.S_ISDIR(value.st_mode): visit(file, name + '/', depth + 1); continue
            item = expected.get(name)
            if item is None: raise ValueError('APP助手含未封存文件')
            seen.add(name)
            if stat.S_ISLNK(value.st_mode):
                if (item.get('type') != 'symlink' or os.readlink(file) != item.get('target')
                        or not contained(file.resolve(strict=True), io_path(root).resolve(strict=True))):
                    raise ValueError('APP助手链接无法核验')
            elif stat.S_ISREG(value.st_mode):
                total += value.st_size
                if (total > 512 * 1024 * 1024 or item.get('type') != 'file' or value.st_size != item.get('size')
                        or digest(file) != item.get('sha256')): raise ValueError('APP助手文件已变化')
                after = file.lstat()
                if (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                    raise ValueError('APP助手文件在校验期间变化')
            else: raise ValueError('APP助手文件类型无效')
    visit(root)
    if seen != set(expected) or file_identity(root) != root_identity:
        raise ValueError('APP助手文件缺失或运行目录在校验期间变化')
    python = io_path(root / ref['executable']).resolve(strict=True)
    if (not contained(python, io_path(root / 'python').resolve(strict=True))
            or python != io_path(root / descriptor.get('executable', '')).resolve(strict=True)):
        raise ValueError('APP助手解释器与原任务不符')
    return python


ROLLBACK_BOOTSTRAP = (
    "import hashlib,sys; p=sys.argv.pop(1); sha=sys.argv.pop(1); s=chr(92); u=s*2+'?'+s; "
    "f=(u+'UNC'+s+p[2:] if p.startswith(s*2) else u+p) if sys.platform=='win32' and not p.startswith(u) else p; "
    "b=open(f,'rb').read(2097153); "
    "sys.exit('Recovery helper digest mismatch') if hashlib.sha256(b).hexdigest()!=sha else None; "
    "sys.argv[0]=p; exec(compile(b,p,'exec'),dict(__name__='__main__',__file__=p))"
)


def recovery_entry(ctx, *, runtime_ref=None, helper_name='replace.py', helper_sha=None, revision=None):
    job, home, platform = ctx['job'], ctx['home'], ctx['plan']['platform']
    helper = job / helper_name
    if not io_path(helper).is_file() or io_path(helper).is_symlink():
        raise ValueError('缺少本地启动器恢复程序，旧启动器未退出')
    ref = runtime_ref if runtime_ref is not None else ctx['plan'].get('helperRuntime')
    owned = helper_runtime(ctx, ref)
    if revision is not None:
        args = ['--settle-app-revision', str(revision[0]), str(revision[1])]
        if runtime_ref is not None:
            encoded = base64.b64encode(json.dumps(runtime_ref, ensure_ascii=False).encode()).decode('ascii')
            args.extend(('--app-rollback-runtime', encoded))
        suffix = ' ' + ' '.join(args)
    else:
        suffix = ''
    if owned is not None:
        relative = '../../app-helper-runtime/' + Path(ref['root']).name + '/' + ref['executable']
        python = owned
    elif platform == 'win32':
        relative = '../../../hermes/hermes-agent/venv/Scripts/python.exe'
        python = job / relative
    else:
        directory = home / 'hermes/hermes-agent/venv/bin'
        name = next((name for name in ('python3', 'python') if io_path(directory / name).is_file()), None)
        if name is None:
            raise ValueError('未找到受管 Python，旧启动器未退出')
        python = directory / name
        relative = '../../../hermes/hermes-agent/venv/bin/' + name
    if not io_path(python).is_file():
        raise ValueError('未找到受管 Python，旧启动器未退出')
    if platform == 'win32':
        script = job / '恢复旧启动器.cmd'
        if owned is None and revision is None:
            body = '@echo off\r\nsetlocal DisableDelayedExpansion\r\ncd /d "%SystemRoot%"\r\n"%~dp0..\\..\\..\\hermes\\hermes-agent\\venv\\Scripts\\python.exe" -B "%~dp0replace.py" --recover "%~dp0."\r\nif errorlevel 1 pause\r\n'
        else:
            # The private interpreter needs its extended path for native DLLs.
            extended = r"if($p.StartsWith('\\')){$p='\\?\UNC\'+$p.Substring(2)}else{$p='\\?\'+$p};" if owned else ''
            entry = "($env:NORA_APP_RECOVERY_JOB+'" + helper_name + "')"
            if helper_sha is not None:
                bootstrap = ROLLBACK_BOOTSTRAP.replace("'", "''")
                entry = f"-c '{bootstrap}' {entry} '{helper_sha}'"
            body = (
                '@echo off\r\nsetlocal DisableDelayedExpansion\r\ncd /d "%SystemRoot%"\r\n'
                'set "NORA_APP_RECOVERY_PYTHON=%~dp0' + relative.replace('/', '\\') + '"\r\n'
                'set "NORA_APP_RECOVERY_JOB=%~dp0"\r\n'
                '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive '
                '-Command "$p=[IO.Path]::GetFullPath($env:NORA_APP_RECOVERY_PYTHON);' + extended +
                f"& $p -I -B {entry} --recover ($env:NORA_APP_RECOVERY_JOB+'.'){suffix};"
                'if($null -eq $LASTEXITCODE){exit 1};exit $LASTEXITCODE"\r\n'
                'if errorlevel 1 (pause & exit /b 1)\r\nexit /b 0\r\n'
            )
    else:
        script = job / '恢复旧启动器.command'
        entry = f'"$job/{helper_name}"'
        if helper_sha is not None:
            entry = f'-c {shlex.quote(ROLLBACK_BOOTSTRAP)} {entry} {helper_sha}'
        flags = '-I -B' if owned is not None or revision is not None else '-B'
        body = '#!/bin/sh\nset -eu\njob=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\n'
        body += f'exec "$job/{relative}" {flags} {entry} --recover "$job"{suffix}\n'
    encoded = body.encode('utf-8')
    current = io_path(script)
    if (file_identity(script) is None or not current.is_file() or current.stat().st_size != len(encoded)
            or current.read_bytes() != encoded):
        write_bytes(script, encoded, mode=0o700)
    return script


def stage_app_rollback_entry(ctx, snapshot, revision, runtime_ref):
    with io_path(__file__).open('rb') as stream:
        source = stream.read(2097153)
    if len(source) > 2097152:
        raise ValueError('APP恢复助手容量超限，未覆盖程序')
    sha = hashlib.sha256(source).hexdigest()
    helper = ctx['job'] / ('replace.py' if sha == snapshot['helperDigest'] else f'r-{sha[:20]}.py')
    if file_identity(helper) is None:
        write_bytes(helper, source)
    elif not io_path(helper).is_file() or digest(helper) != sha:
        raise ValueError('APP恢复助手摘要不符，未覆盖程序')
    # Publish the only entry after its helper is durable and before the GUI
    # sees recovery-prepared. The old program can then run the same revision.
    recovery_entry(ctx, runtime_ref=runtime_ref, helper_name=helper.name, helper_sha=sha, revision=revision)


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
            'parentPid', 'parentCreationTime', 'helperRuntime')
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
    old_scope = previous_app_scope(ctx, old)
    current = file_identity(ctx['app'])
    if phase == 'committed':
        if current != incoming['identity'] or (full and tree_digest(ctx['app'], plan['platform']) != incoming['digest']):
            raise ValueError('已提交启动器的身份或内容已变化')
        return snapshot
    backup, failed = (file_identity(ctx[key]) for key in ('backup', 'failed'))
    if failed is not None and (failed != incoming['identity'] or (full and tree_digest(ctx['failed'], plan['platform']) != incoming['digest'])):
        raise ValueError('失败程序现场身份或内容已变化，未覆盖证据')
    if backup is not None:
        if backup != old['identity'] or (full and tree_digest(ctx['backup'], plan['platform'], scope=old_scope) != old['digest']):
            raise ValueError('旧启动器备份身份或内容已变化，未覆盖程序')
        if current is not None and current != incoming['identity']:
            raise ValueError('当前启动器身份未知，未覆盖程序')
        if full and current is not None and tree_digest(ctx['app'], plan['platform']) != incoming['digest']:
            raise ValueError('当前启动器内容已变化，未覆盖程序')
    elif current != old['identity'] or (full and tree_digest(ctx['app'], plan['platform'], scope=old_scope) != old['digest']):
        raise ValueError('旧启动器备份缺失，尚未确认已安全恢复')
    return snapshot


def untouched(ctx, snapshot):
    old = snapshot['old']
    return (not exists(ctx['backup']) and file_identity(ctx['app']) == old['identity']
        and tree_digest(ctx['app'], ctx['plan']['platform'], scope=previous_app_scope(ctx, old)) == old['digest'])


def ready_acknowledged(ctx):
    plan = ctx['plan']
    expected = {'token': plan['token'], 'version': plan['version']}
    if plan['schema'] == 2:
        expected.update(schema='nora-launcher-handoff/1', operationId=plan['operationId'], planDigest=plan['planDigest'])
    ready = ctx['job'] / 'ready.json'
    return file_identity(ready) is not None and io_path(ready).is_file() and read_json(ready) == expected


def inspect_outcome(job, *, typed=False):
    """Explicit full proof of a terminal handoff, never status polling."""
    ctx = context(job)
    if ctx['plan']['schema'] != 2:
        return None
    with job_lock(ctx['job'], readonly=True):
        snapshot = validate_snapshot(ctx, full=True)
        phase = snapshot['phase']
        if phase not in ('committed', 'restored', 'cancelled'):
            return None
        if (type(snapshot.get('workerPid')) is not int or snapshot['workerPid'] <= 0
                or type(snapshot.get('workerCreationTime')) not in (int, float)
                or not math.isfinite(snapshot['workerCreationTime']) or snapshot['workerCreationTime'] <= 0):
            return None
        if parent_alive(snapshot['workerPid'], snapshot['workerCreationTime']):
            return None
        extra = {'target': snapshot['target']} if typed else {}
        if phase == 'committed':
            if not ready_acknowledged(ctx):
                return None
            # Recovery is checkpointed before status.json. A cut between the
            # writes leaves a valid commit with stale or missing display state.
            return {'job': str(ctx['job']), 'status': phase, 'verification': 'confirmed',
                    'effectState': 'changed', 'busy': False, 'workerOffline': True,
                    'operationId': snapshot['operationId'], 'planDigest': snapshot['planDigest'],
                    'version': snapshot['version'], **extra}
        if phase == 'cancelled' and (not untouched(ctx, snapshot) or exists(ctx['failed'])):
            return None
        status = {}
        segment_only = snapshot.get('appSegmentOnly') is True
        if not typed or (snapshot['releasePlan'].get('client') != 'app' and not segment_only):
            # Keep the original proof format for old recovery writers.
            status = read_json(ctx['job'] / 'status.json')
            if status.get('status') != phase or any(status.get(key) != snapshot.get(key)
                    for key in ('operationId', 'planDigest', 'workerPid', 'workerCreationTime')):
                return None
        return {'job': str(ctx['job']), 'status': phase, 'verification': 'confirmed',
                'effectState': 'untouched' if phase == 'cancelled' else 'restored', 'busy': False, 'workerOffline': True,
                'operationId': snapshot['operationId'], 'planDigest': snapshot['planDigest'],
                'version': snapshot['old']['version'],
                **({'appSegmentOnly': True} if typed and segment_only else {}),
                **({'relaunchFailed': True} if typed and phase == 'restored' and snapshot.get('relaunchError') else {}),
                **({'sharingFailure': snapshot['sharingFailure']} if typed and phase == 'cancelled' and 'sharingFailure' in snapshot else {}),
                'diagnosticError': snapshot.get('diagnosticError') or status.get('diagnosticError'), **extra}


def inspect_prepared(job):
    """Read the narrow prepare-before-controller-handoff interruption window."""
    ctx = context(job)
    try:
        with job_lock(ctx['job'], readonly=True):
            snapshot = validate_snapshot(ctx, full=True)
            if ctx['plan']['schema'] != 2 or snapshot['phase'] != 'prepared' or not untouched(ctx, snapshot):
                return None
            pid, created = snapshot.get('workerPid'), snapshot.get('workerCreationTime')
            if (type(pid) is not int or pid <= 0 or type(created) not in (int, float)
                    or not math.isfinite(created) or created <= 0 or parent_alive(pid, created)):
                return None
            return {'job': str(ctx['job']), 'status': 'prepared', 'verification': 'confirmed',
                    'operationId': ctx['plan']['operationId'], 'planDigest': ctx['plan']['planDigest'],
                    'effectState': 'untouched', 'workerOffline': True, 'busy': False, 'canRecover': True}
    except RuntimeError:
        return None  # An active job writer is not an unpublished preparation.


def read_outcome(job):
    """Typed APP facts: absence, a live handoff and a terminal are distinct."""
    ctx = context(job)
    if not exists(ctx['job'] / 'recovery.json'):
        state = assess(job)
        return {'kind': 'unknown' if state else 'idle', 'job': str(ctx['job']),
                **({'state': state} if state else {})}
    snapshot = validate_snapshot(ctx, full=False)
    phase = snapshot['phase']
    if phase in ('committed', 'restored', 'cancelled'):
        pid, created = snapshot.get('workerPid'), snapshot.get('workerCreationTime')
        if (type(pid) is not int or pid <= 0 or type(created) not in (int, float)
                or not math.isfinite(created) or created <= 0):
            return {'kind': 'unknown', 'job': str(ctx['job']), 'reason': 'APP执行者身份缺失，已保留现场'}
        if parent_alive(pid, created):
            return {'kind': 'pending', 'job': str(ctx['job']), 'state': {
                'status': phase, 'effectState': 'unknown', 'busy': True, 'workerOffline': False,
                'canRecover': False, 'reason': 'APP助手尚未退出，等待同一任务完成'}}
        outcome = inspect_outcome(job, typed=True)
        if outcome is not None:
            return {'kind': 'terminal', 'job': str(ctx['job']), 'outcome': outcome}
        return {'kind': 'unknown', 'job': str(ctx['job']), 'reason': 'APP终态程序事实尚未确认'}
    state = assess(job)
    return {'kind': 'unknown' if not state or state.get('effectState') == 'unknown' else 'pending',
            'job': str(ctx['job']), 'state': state}


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
        acknowledged = False
        if phase == 'awaiting-system' and worker_offline and not busy and snapshot.get('recoveryParent') is None:
            try: acknowledged = ready_acknowledged(ctx)
            except (OSError, ValueError): pass  # Retain the explicit recovery option for an invalid acknowledgement.
        return {'job': str(ctx['job']), 'status': phase, 'canRecover': not busy and supported and worker_error is None, 'busy': busy,
                'workerOffline': worker_offline, 'acknowledged': acknowledged, 'untouched': is_untouched, 'effectState': effect,
                'operationId': snapshot.get('operationId'), 'planDigest': snapshot.get('planDigest'),
                'reason': '启动器更新或恢复正在进行，请等待完成。' if busy else '工作进程身份无法确认，已保留现场' if worker_error else '' if supported else '旧启动器恢复记录不支持当前操作协议',
                'version': snapshot['old']['version'], 'backup': str(ctx['backup']),
                'log': str(ctx['job'] / 'replace.log'),
                'script': str(ctx['job'] / ('恢复旧启动器.cmd' if ctx['plan']['platform'] == 'win32' else '恢复旧启动器.command'))}
    except (OSError, ValueError, KeyError, TypeError) as error:
        reason = '启动器恢复记录暂时无法读取。请保留日志和备份。' if isinstance(error, OSError) else str(error)
        return {'job': str(job), 'canRecover': False, 'reason': reason, 'effectState': 'unknown', 'workerOffline': False,
                'diagnosticError': error_data(error), 'log': str(Path(job) / 'replace.log')}


def detach_inherited_crash_handler():
    if sys.platform != 'darwin': return
    import ctypes
    library = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
    port = ctypes.c_uint32
    task = port.in_dll(library, 'mach_task_self_').value
    reset = library.task_set_exception_ports
    reset.argtypes = (port, port, port, ctypes.c_int32, ctypes.c_int32)
    reset.restype = ctypes.c_int32
    # Crashpad's Mac send rights survive exec and keep its APP executable alive
    # until this worker exits. Sever only this worker's inherited crash ports;
    # otherwise waiting for every APP executable creates a circular wait.
    # NULL is Crashpad's own fallback in UseSystemDefaultHandler(). No process
    # is ignored or terminated, and ordinary Python errors still use replace.log.
    if reset(task, (1 << 10) | (1 << 11) | (1 << 12), 0, 1, 0) != 0:
        raise RuntimeError('无法解除恢复进程继承的崩溃报告连接，已保留程序和备份。')


def is_old_orphan_crash_reporter(ctx, snapshot, process, birth):
    backup = ctx['backup']
    reporter = (backup / 'Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler').resolve()
    if (str(reporter) != process.exe() or not contained(reporter, backup)
            or file_identity(backup) != snapshot['old']['identity'] or not reporter.is_file()
            or process.ppid() != 1 or not ctx['plan']['parentCreationTime'] <= birth < snapshot['workerCreationTime']):
        return False
    uids = process.uids()
    if (uids.real, uids.effective) != (os.getuid(), os.geteuid()):
        return False
    database = ctx['home'] / 'launcher/diagnostics/native-crashes'
    args = process.cmdline()[1:]
    return (database.is_dir() and database.resolve() == database
            and [arg for arg in args if arg == '--database' or arg.startswith('--database=')] == [f'--database={database}']
            and '--monitor-self-annotation=ptype=crashpad-handler' in args
            and '--annotation=_productName=Nora Tavern Launcher' in args
            and '--annotation=prod=Electron' in args
            and f"--annotation=_version={snapshot['old']['version']}" in args)


def retire_old_orphan_crash_reporter(ctx, snapshot, observed, signalled):
    import psutil
    try:
        birth = observed.create_time()
        identity = (observed.pid, birth)
        if identity in signalled:
            return
        current = psutil.Process(observed.pid)
        if current.create_time() == birth and is_old_orphan_crash_reporter(ctx, snapshot, current, birth):
            current.terminate()  # psutil checks for PID reuse before signalling.
            signalled.add(identity)
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        pass  # Recheck the entire census before trying again.
    except psutil.AccessDenied as error:
        raise RuntimeError('无法确认旧启动器崩溃报告进程已退出，已保留程序和备份。') from error


def require_launcher_offline(ctx, snapshot):
    import psutil
    current_user = psutil.Process().username()
    mac_transaction = sys.platform == ctx['plan']['platform'] == 'darwin' and ctx['plan']['schema'] == 2
    signalled = set()
    deadline = time.monotonic() + 30
    while True:
        running = []
        if mac_transaction: psutil.process_iter.cache_clear()
        for process in psutil.process_iter():
            try:
                executable = process.exe()
                if executable and any(contained(Path(executable), root) for root in (ctx['app'], ctx['backup'])):
                    running.append(process)
            except (psutil.NoSuchProcess, psutil.ZombieProcess): continue
            except psutil.AccessDenied as error:
                try: other_user = process.username() != current_user
                except (psutil.NoSuchProcess, psutil.ZombieProcess): continue
                except psutil.AccessDenied: other_user = False
                if not other_user:
                    raise RuntimeError('当前用户进程路径无法确认，已保留启动器现场') from error
        if not running: return
        # Give normally exiting children a short grace period. A running Tavern
        # may keep an orphaned old Mac Crashpad alive through inherited Mach
        # rights. Only that verified reporter can be stopped by APP recovery.
        # Keep both trees intact until a fresh census confirms all have exited.
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('启动器仍在运行，请先关闭启动器后再恢复。')
        if mac_transaction and len(running) == 1 and remaining <= 29:
            retire_old_orphan_crash_reporter(ctx, snapshot, running[0], signalled)
        time.sleep(min(0.1, remaining))


def launcher_environment(ctx):
    env = {key: value for key, value in os.environ.items() if not key.startswith('NORA_OPERATION_DELEGATE')}
    env.pop('ELECTRON_RUN_AS_NODE', None); env.pop('NODE_OPTIONS', None); env.pop('NODE_PATH', None)
    env.pop('__PYVENV_LAUNCHER__', None)
    encoded_profile = env.pop('NORA_APP_RELAUNCH_PROFILE', None)
    if encoded_profile is not None:
        # The helper's private Python profile is not the new desktop's profile.
        invalid = '启动器重启环境无效，请保留现有安装和日志。'
        try:
            if len(encoded_profile.encode('utf-8')) > 16 * 1024:
                raise ValueError(invalid)
            profile = json.loads(encoded_profile)
        except (ValueError, RecursionError) as error:
            raise ValueError(invalid) from error
        keys = {'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP'}
        if not isinstance(profile, dict) or any(
                key not in keys or value is not None and (not isinstance(value, str) or '\0' in value)
                for key, value in profile.items()):
            raise ValueError(invalid)
        for key, value in profile.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
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
    # Extended namespace paths are for filesystem IO. Electron exits before
    # loading its app when CreateProcess receives that form as its executable.
    options = {'executable': args[0]} if os.name == 'nt' else {}
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
            installer_directory=ctx['home'] / 'installer', context={'stage': getattr(error, '_launcher_stage', 'restoring')})
    except Exception as saving:
        error.secondary_errors = [*getattr(error, 'secondary_errors', ()), saving]
        error._diagnostic_missing = [*getattr(error, '_diagnostic_missing', ()), 'evidence_save_failed']


def annotate_failure(snapshot, error):
    phase = snapshot.get('phase')
    objects = {'moving-old': ('launcher-app', 'launcher-backup'),
               'installing-new': ('launcher-staged-app', 'launcher-app'),
               'moving-failed': ('launcher-app', 'launcher-failed-app'),
               'restoring-old': ('launcher-backup', 'launcher-app')}
    if phase not in RECOVERABLE_PHASES: return
    snapshot.setdefault('failurePhase', phase)
    error._launcher_stage = 'restoring' if phase in ('recovery-prepared', 'moving-failed', 'restoring-old', 'recovery-failed') else 'update_apply'
    if not isinstance(error, OSError): return
    facts = [f'launcher_step={phase}']
    if phase in objects:
        source, target = objects[phase]
        facts.extend((f'source_object={source}', f'target_object={target}'))
    if type(getattr(error, 'winerror', None)) is int: facts.append(f'winerror={error.winerror}')
    # Only fixed object roles are appended; private absolute paths remain local.
    error._bridge_diagnostic_message = str(error) + '; ' + '; '.join(facts)


def inspect_diagnostics(job, *, details=True):
    """Read a finished worker's evidence; never settle or recover its task."""
    ctx = context(job)
    if ctx['plan']['schema'] != 2: raise ValueError('旧交接缺少诊断身份')
    try:
        with job_lock(ctx['job'], readonly=True):
            snapshot = validate_snapshot(ctx, full=False)
            pid, created = snapshot.get('workerPid'), snapshot.get('workerCreationTime')
            if type(pid) is int and type(created) in (int, float) and parent_alive(pid, created): return None
            if snapshot['phase'] in ('prepared', 'waiting-parent') and parent_alive(
                    ctx['plan']['parentPid'], ctx['plan']['parentCreationTime']): return None
            phase = snapshot['phase']
            if phase == 'committed':
                return {'operationId': ctx['plan']['operationId'], 'planDigest': ctx['plan']['planDigest'], 'status': 'succeeded'}
            if phase == 'awaiting-system': return None  # The new APP still owns verification.
            primary = snapshot.get('diagnosticError') if details else ({'name': 'Error', 'message': '启动器程序替换失败。',
                'code': snapshot.get('diagnosticError', {}).get('code'), 'stack': ''} if snapshot.get('diagnosticError') else None)
            missing, truncated = [], bool(primary and primary.get('truncated'))
            evidence_file = ctx['home'] / 'installer/operations' / ctx['plan']['operationId'] / 'evidence/python.json'
            evidence_module = shared_module('operation_evidence', ctx['job'])
            try:
                if not details: raise FileNotFoundError()
                evidence_module.operation_directory(ctx['home'], operation_id=ctx['plan']['operationId'])
                if evidence_file.parent.is_symlink() or evidence_file.is_symlink() or evidence_file.stat().st_size > evidence_module.MAX_BYTES:
                    raise ValueError('诊断证据路径或容量无效')
                saved = evidence_module._validate_record(read_json(evidence_file), ctx['plan']['operationId'])
                primary = dict(saved['primary'])
                primary['secondaryErrors'] = [*primary.get('secondaryErrors', []), *saved.get('secondaryErrors', [])][:2]
                missing.extend(saved['missingReasons'])
                truncated = saved['truncated'] or primary.get('truncated', False)
            except (OSError, ValueError, TypeError): missing.append('evidence_missing')
            result = {'operationId': ctx['plan']['operationId'], 'planDigest': ctx['plan']['planDigest'],
                      'status': 'failed' if primary else 'interrupted', 'diagnosticError': primary,
                      'phase': phase, 'failurePhase': snapshot.get('failurePhase'), 'missingReasons': missing,
                      'truncated': truncated,
                      'effectState': 'unknown', 'recoveryOutcome': 'recovery-required', 'verification': 'unconfirmed'}
        # Consume the writer's completed check, without re-hashing an APP just
        # to upload its error. Legacy records lack that proof and stay unknown.
        if phase in ('cancelled', 'restored') and snapshot.get('diagnosticVerification') == 'confirmed':
            result.update(effectState='untouched' if phase == 'cancelled' else 'restored', verification='confirmed',
                          recoveryOutcome='not-required' if phase == 'cancelled' else 'restored-and-verified')
        if not primary: result['missingReasons'].append('primary_detail_missing')
        return result
    except RuntimeError:
        # A live worker owns the read lock. It will be inspected on a later drain.
        return None


def report_failure(ctx, snapshot, phase, error, **extra):
    if phase == 'restored': extra['diagnosticVerification'] = 'confirmed'
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


def cancel_untouched(ctx, snapshot, *, error=None, historical_segment=False, sharing_failure=None):
    if not untouched(ctx, snapshot): raise ValueError('原程序现场发生变化，未取消恢复')
    extra = {'diagnosticError': error_data(error)} if error is not None else {}
    if historical_segment: extra['appSegmentOnly'] = True
    if sharing_failure is not None: extra['sharingFailure'] = sharing_failure
    checkpoint(ctx, snapshot, 'cancelled', diagnosticVerification='confirmed', **worker_identity(), **extra)
    try: clean_stage(ctx, snapshot)
    except (OSError, ValueError) as cleanup:
        checkpoint(ctx, snapshot, 'cancelled', cleanupError=error_data(cleanup), **extra)
    return {'restored': False, 'untouched': True, 'restarting': False}


def verify_historical_app_segment(ctx, sequence):
    plan = ctx['plan']
    if plan['schema'] != 2 or plan['releasePlan'].get('client') == 'app' or not 0 < sequence <= 2**53 - 1:
        raise ValueError('历史任务的APP交接协议无效')
    operations = ctx['home'] / 'installer/operations'
    directory = operations / plan['operationId']
    file = directory / 'operation.json'
    if (file_identity(operations) is None or not io_path(operations).is_dir()
            or file_identity(directory) is None or not io_path(directory).is_dir()
            or file_identity(file) is None or not io_path(file).is_file()
            or io_path(file).stat().st_size > 256 * 1024):
        raise ValueError('无法确认历史任务的原操作记录')
    record = read_json(file)
    target = record.get('target')
    request = target.get('request') if isinstance(target, dict) else None
    epoch = record.get('ownerEpoch')
    if (record.get('schema') != 'nora-operation/1' or record.get('kind') != 'update'
            or record.get('operationId') != plan['operationId'] or record.get('sequence') != sequence
            or type(epoch) is not int or not plan['ownerEpoch'] <= epoch <= 2**53 - 1
            or record.get('state') == 'succeeded'
            or record.get('state') == 'rolled-back' and record.get('verification') == 'confirmed'
            or record.get('handoffRef') != str(ctx['job']) or record.get('planDigest') != plan['planDigest']
            or not isinstance(request, dict) or request.get('action') != 'update' or request.get('launcherOnly') is True
            or target.get('releasePlan') != plan['releasePlan']
            or hashlib.sha256(json.dumps(target, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest() != plan['planDigest']):
        raise ValueError('历史任务的APP交接与原操作记录不符，未修改程序')


def record_digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def owned_record(path, limit=256 * 1024):
    if file_identity(path.parent) is None or file_identity(path) is None or not io_path(path).is_file() or io_path(path).stat().st_size > limit:
        raise ValueError('无法确认启动器恢复的原操作记录')
    return read_json(path, max_bytes=limit)


def bound_app_rollback(ctx, revision, snapshot):
    plan = ctx['plan']
    epoch, sequence = revision
    if plan['schema'] != 2 or not plan['ownerEpoch'] <= epoch < 2**53 - 1 or not 0 < sequence < 2**53 - 1:
        raise ValueError('无法确认启动器恢复的原操作记录')
    operations = ctx['home'] / 'installer/operations'
    file_identity(operations)
    file = operations / plan['operationId'] / 'operation.json'
    record = owned_record(file)
    target = record.get('target')
    request = target.get('request') if isinstance(target, dict) else None
    pending = (record.get('ownerEpoch'), record.get('sequence'), record.get('state'), record.get('stageId')) == (
        epoch, sequence, 'awaiting-handoff', 'recovering')
    settled = (snapshot['phase'] == 'restored' and record.get('state') == 'rolled-back'
        and record.get('sequence') == sequence + 1 and type(record.get('ownerEpoch')) is int
        and epoch < record['ownerEpoch'] <= 2**53 - 1 and record.get('verification') == 'confirmed'
        and record.get('stageId') == 'verifying' and record.get('currentFailure', False) is None
        and record.get('effectState') == 'restored' and record.get('recoveryOutcome') == 'restored-and-verified'
        and isinstance(record.get('result'), dict) and record['result'].get('launcherVersion') == snapshot['old']['version']
        and record['result'].get('recoveryVerification') == 'confirmed')
    if (record.get('schema') != 'nora-operation/1' or record.get('kind') != 'update'
            or record.get('operationId') != plan['operationId'] or record.get('archived') is True
            or record.get('handoffRef') != str(ctx['job']) or record.get('planDigest') != plan['planDigest']
            or not isinstance(request, dict) or request.get('action') != 'update' or request.get('launcherOnly') is not True
            or target.get('releasePlan') != plan['releasePlan'] or record_digest(target) != plan['planDigest']
            or not (pending or settled)):
        raise ValueError('APP恢复与原操作记录不符，未覆盖程序')
    ledgers = operations / '.guards'
    sessions = []
    if file_identity(ledgers) is not None:
        for ledger in io_path(ledgers).iterdir():
            if ledger.suffix != '.json':
                continue
            session = owned_record(ledger, 128 * 1024)
            if session.get('schema') != 'nora-operation-guard/1' or not isinstance(session.get('jobs'), list):
                raise ValueError('启动器执行者记录无法确认')
            sessions.append(session)
    jobs = shared_module('operation_control', ctx['job']).inspect_executors(sessions)['jobs'] if sessions else []
    if any(job.get('state') != 'offline' for job in jobs):
        raise ValueError('启动器原执行者尚未确认退出')
    return file, record, settled


def legacy_update_id(value):
    return isinstance(value, str) and bool(re.fullmatch(
        r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', value, re.I))


def same_legacy_release(installer, plan, record):
    sealed = record['target']['releasePlan']
    ref = sealed.get('manifestRef')
    if not isinstance(plan, dict) or not isinstance(ref, dict):
        return False
    fields = ('schema', 'mode', 'tag', 'channel', 'platform', 'arch', 'commit', 'planId', 'launcherManifest', 'systemManifest')
    if any(plan.get(key) != sealed.get(key) for key in fields):
        return False
    manifest = plan.get('releaseManifestText')
    if not isinstance(manifest, str):
        return False
    data = manifest.encode()
    sha = hashlib.sha256(data).hexdigest()
    operation_id = record['operationId']
    relative = f'release-plan/{sha}.json'
    if (sealed.get('manifestSha256') != sha or ref != {'schema': 'nora-operation-manifest/1',
            'operationId': operation_id, 'file': relative, 'size': len(data), 'sha256': sha}):
        return False
    source = installer / 'operations' / operation_id / relative
    return (file_identity(source.parent) is not None and file_identity(source) is not None
            and io_path(source).is_file() and io_path(source).stat().st_size == len(data) and digest(source) == sha)


def retire_legacy_continuation(ctx, record, old_version):
    request = record['target']['request']
    sequence_id = request.get('sequenceId')
    installer = ctx['home'] / 'installer'
    active = installer / 'current-update-sequence.json'
    if not legacy_update_id(sequence_id) or not exists(active):
        return
    # The old APP uses this reference to resume a joint update on ordinary
    # startup. Retire only its launcher-first, never-admitted continuation.
    try:
        reference = owned_record(active, 1024)
        schema = 'nora-update-sequence/1'
        if reference != {'schema': schema, 'id': sequence_id}:
            return
        root = installer / 'update-sequences'
        file_identity(root)
        folder = root / sequence_id
        sequence = owned_record(folder / 'request.json', 8 * 1024 * 1024)
        requests, before = sequence.get('requests'), sequence.get('before')
        if (sequence.get('schema') != schema or sequence.get('id') != sequence_id
                or sequence.get('order') != ['launcher', 'core']
                or sequence.get('digest') != record_digest({key: value for key, value in sequence.items() if key != 'digest'})
                or not same_legacy_release(installer, sequence.get('plan'), record)
                or not isinstance(before, dict) or before.get('launcher') != old_version
                or before.get('core') != request.get('expectedCoreVersion')
                or not isinstance(requests, dict) or not legacy_update_id(requests.get('launcher'))
                or not legacy_update_id(requests.get('core')) or requests['launcher'] == requests['core']
                or requests['launcher'] != record.get('requestId')):
            return
        for entry in io_path(installer / 'operations').iterdir():
            if not legacy_update_id(entry.name) or entry.name == record['operationId']:
                continue
            other = owned_record(entry / 'operation.json')
            if (other.get('schema') != 'nora-operation/1' or other.get('operationId') != entry.name
                    or type(other.get('sequence')) is not int or not 0 <= other['sequence'] <= 2**53 - 1
                    or type(other.get('ownerEpoch')) is not int or not 0 <= other['ownerEpoch'] <= 2**53 - 1
                    or not isinstance(other.get('createdAt'), str) or not isinstance(other.get('target'), dict)
                    or not isinstance(other.get('requestId'), str)
                    or other.get('requestId') in requests.values()):
                return
            datetime.fromisoformat(other['createdAt'].replace('Z', '+00:00'))
        jobs = installer / 'update-jobs'
        if file_identity(jobs) is not None:
            for entry in io_path(jobs).iterdir():
                if entry.name.startswith('.submit-') or entry.name == requests['core']:
                    return
                if legacy_update_id(entry.name):
                    submission = owned_record(entry / 'request.json', 8 * 1024 * 1024)
                    submitted = submission.get('request')
                    if (submission.get('requestId') != entry.name or not isinstance(submitted, dict)
                            or submitted.get('schema') != 'nora-cli-request/1'
                            or submitted.get('kind') not in ('update', 'recover')
                            or not isinstance(submitted.get('argv'), list)
                            or 'operationRequestId' in submission and not legacy_update_id(submission['operationRequestId'])
                            or submission.get('operationRequestId') == requests['core']):
                        return
    except (OSError, ValueError) as error:
        print('未停用旧版联合更新引用：' + str(error), file=sys.stderr, flush=True)
        return
    archive = folder / active.name
    if exists(archive):
        raise ValueError('旧版联合更新引用已存在归档，原引用已保留')
    retry_rename(active, archive)


def settle_app_rollback(ctx, snapshot, bound):
    file, record, settled = bound
    generation = file.parent.parent / '.history-generation.json'
    if file_identity(generation) is not None and not io_path(generation).is_file():
        raise ValueError('启动器任务代次记录无效')
    version = snapshot['old']['version']
    if not settled:
        result = dict(record.get('result') or {}, launcherVersion=version, recoveryVerification='confirmed')
        if not record.get('primaryFailure'):
            technical = snapshot.get('diagnosticError') or {'message': '启动器更新交接未完成，已恢复原程序。'}
            code = technical.get('code') or 'LAUNCHER_START_FAILED'
            failure = {'code': code, 'site': 'launcher.app-recovery', 'technical': technical}
            record.update(primaryFailure=failure, failureSignature=record_digest(failure))
        record.update(ownerEpoch=max(int(time.time() * 1000), record['ownerEpoch']) + 1,
                      sequence=record['sequence'] + 1, updatedAt=datetime.now(timezone.utc).isoformat(),
                      state='rolled-back', stageId='verifying', verification='confirmed', effectState='restored',
                      recoveryOutcome='restored-and-verified', currentFailure=None, result=result)
        if len(json.dumps(record, ensure_ascii=False).encode()) > 256 * 1024:
            raise ValueError('启动器恢复的原操作记录容量超限')
        write_json(generation, {'schema': 1, 'id': str(uuid.uuid4()), 'writing': True})
        write_json(file, record)
    if not settled or exists(generation) and owned_record(generation, 1024).get('writing') is True:
        write_json(generation, {'schema': 1, 'id': str(uuid.uuid4()), 'writing': False})
    retire_legacy_continuation(ctx, record, version)


def restore(ctx, *, parent_pid=0, parent_creation_time=None, allow_legacy=False, historical_segment=False,
            bound=None):
    helper_runtime(ctx)
    snapshot = validate_snapshot(ctx, full=True)
    if snapshot.get('phase') == 'cancelled': return {'restored': False, 'untouched': True, 'restarting': False}
    if snapshot.get('phase') == 'committed': raise ValueError('此启动器更新已提交，无需恢复')
    if snapshot.get('phase') == 'restored' and bound is None: return {'restored': True, 'restarting': False}
    if snapshot['phase'] in ('prepared', 'waiting-parent', 'moving-old') and untouched(ctx, snapshot):
        return cancel_untouched(ctx, snapshot, historical_segment=historical_segment)
    if ctx['plan']['schema'] != 2 and not allow_legacy:
        raise ValueError('旧启动器回滚协议未知，未覆盖程序')
    if parent_pid and ctx['plan']['schema'] == 2:
        if parent_creation_time is None: raise ValueError('恢复父进程缺少出生时间，未覆盖程序')
        sealed = snapshot.get('recoveryParent')
        if sealed != {'pid': parent_pid, 'creationTime': parent_creation_time}:
            raise ValueError('恢复父进程与准备记录不一致')
    if (bound and not bound[2] and snapshot.get('workerPid') not in (None, os.getpid())
            and parent_alive(snapshot['workerPid'], snapshot['workerCreationTime'])):
        raise ValueError('启动器替换助手尚未退出，旧备份继续保留')
    if snapshot['phase'] != 'restored':
        checkpoint(ctx, snapshot, 'recovery-prepared', **worker_identity())
        if parent_pid: wait_parent(parent_pid, parent_creation_time)
        require_launcher_offline(ctx, snapshot)
        validate_snapshot(ctx, full=True)
        if file_identity(ctx['app']) != snapshot['old']['identity']:
            if exists(ctx['app']):
                if exists(ctx['failed']): raise ValueError('失败程序现场已存在，未覆盖证据')
                checkpoint(ctx, snapshot, 'moving-failed'); retry_rename(ctx['app'], ctx['failed'])
            checkpoint(ctx, snapshot, 'restoring-old'); retry_rename(ctx['backup'], ctx['app'])
        validate_snapshot(ctx, full=True)
    elif bound and not bound[2]:
        require_launcher_offline(ctx, snapshot)
    if historical_segment:
        # The restored binary may still have a legacy joint-update entrypoint.
        # Keep the original task and installer state read-only.
        checkpoint(ctx, snapshot, 'restored', appSegmentOnly=True, diagnosticVerification='confirmed')
        return {'restored': True, 'restarting': False, 'appSegmentOnly': True}
    should_launch = not snapshot.get('launchAttempted')
    if bound:
        if snapshot['phase'] != 'restored':
            checkpoint(ctx, snapshot, 'restored', diagnosticVerification='confirmed')
        settle_app_rollback(ctx, snapshot, bound)
    else:
        checkpoint(ctx, snapshot, 'restored', launchAttempted=True, diagnosticVerification='confirmed')
    state_file = ctx['home'] / 'installer/state.json'
    try: state = read_json(state_file) if exists(state_file) else {}
    except (OSError, ValueError): state = {}
    restored_state = dict(state, phase='error', resumeTarget=None, task='', error='已恢复旧启动器。请检查更新日志后再决定是否重新更新。')
    if state != restored_state:
        try: write_json(state_file, restored_state)
        except OSError as error:
            snapshot['stateWriteError'] = error_data(error); checkpoint(ctx, snapshot, 'restored')
            print('旧程序已恢复，但状态写入失败', file=sys.stderr, flush=True)
    if bound:
        if should_launch:
            checkpoint(ctx, snapshot, 'restored', launchAttempted=True, diagnosticVerification='confirmed')
        return {'restored': True, 'restarting': False, '_launch': should_launch}
    if should_launch:
        try: launch_old(ctx)
        except OSError as error:
            checkpoint(ctx, snapshot, 'restored', relaunchError=error_data(error))
            raise RuntimeError('旧程序已恢复，但无法重新打开。请手动打开原启动器。') from error
    return {'restored': True, 'restarting': False}


def prepare_recovery(job, *, parent_pid, parent_creation_time, historical_sequence=None):
    ctx = context(job)
    with writer_lock(ctx, successor=True), job_lock(ctx['job']):
        if historical_sequence is not None: verify_historical_app_segment(ctx, historical_sequence)
        snapshot = validate_snapshot(ctx, full=True)
        if ctx['plan']['schema'] != 2 and not untouched(ctx, snapshot):
            raise ValueError('旧启动器回滚协议未知，未覆盖程序')
        if process_identity(parent_pid) != {'pid': parent_pid, 'creationTime': parent_creation_time}:
            raise ValueError('恢复父进程身份不一致')
        checkpoint(ctx, snapshot, snapshot['phase'], recoveryParent={'pid': parent_pid, 'creationTime': parent_creation_time})
        return {'prepared': True, 'job': str(ctx['job']), 'operationId': ctx['plan'].get('operationId')}


def recover(job, *, parent_pid=0, parent_creation_time=None, allow_legacy=False, historical_sequence=None,
            app_revision=None, app_runtime=None):
    if app_runtime is not None and app_revision is None:
        raise ValueError('APP恢复运行资源缺少原任务修订')
    if app_revision is not None and (historical_sequence is not None or getattr(sys, '_nora_operation_delegate', None) is not None
            or any(name.startswith('NORA_OPERATION_DELEGATE') for name in os.environ)):
        raise ValueError('APP恢复只能由原生写者结束自己的操作')
    ctx = context(job)
    with writer_lock(ctx, successor=True), job_lock(ctx['job']):
        if historical_sequence is not None: verify_historical_app_segment(ctx, historical_sequence)
        snapshot = validate_snapshot(ctx, full=True)
        # No default legacy rollback across an unrecognized operation protocol.
        if ctx['plan']['schema'] != 2 and not allow_legacy and not untouched(ctx, snapshot):
            raise ValueError('旧启动器回滚协议未知，未覆盖程序')
        bound = bound_app_rollback(ctx, app_revision, snapshot) if app_revision is not None else None
        if bound and snapshot['phase'] not in ('cancelled', 'committed'):
            stage_app_rollback_entry(ctx, snapshot, app_revision, app_runtime)
        try: result = restore(ctx, parent_pid=parent_pid, parent_creation_time=parent_creation_time, allow_legacy=allow_legacy,
                              historical_segment=historical_sequence is not None, bound=bound)
        except Exception as error:
            try: phase = read_json(ctx['job'] / 'recovery.json').get('phase')
            except Exception as recording:
                error.secondary_errors = [*getattr(error, 'secondary_errors', ()), recording]; phase = snapshot.get('phase')
            failure_snapshot = dict(snapshot, phase=phase)
            annotate_failure(failure_snapshot, error)
            if failure_snapshot.get('failurePhase'): snapshot.setdefault('failurePhase', failure_snapshot['failurePhase'])
            freeze_failure(ctx, error)
            if phase not in ('committed', 'restored', 'cancelled'): report_failure(ctx, snapshot, 'recovery-failed', error, **worker_identity())
            freeze_failure(ctx, error)
            raise
    if result.pop('_launch', False):
        try: launch_old(ctx)
        except OSError as error:
            with writer_lock(ctx, successor=True), job_lock(ctx['job']):
                snapshot = validate_snapshot(ctx, full=False)
                checkpoint(ctx, snapshot, 'restored', relaunchError=error_data(error))
            raise RuntimeError('旧程序已恢复，但无法重新打开。请手动打开原启动器。') from error
    return result


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
        if snapshot.get('recoveryParent') is not None:
            raise ValueError('启动器已准备恢复，旧备份继续保留')
        if ctx['plan']['schema'] == 2 and parent_alive(snapshot['workerPid'], snapshot['workerCreationTime']):
            raise ValueError('启动器替换助手尚未退出，旧备份继续保留')
        if ctx['plan']['schema'] == 2 and not ready_acknowledged(ctx):
            raise ValueError('新版启动器启动确认不匹配，旧备份继续保留')
        checkpoint(ctx, snapshot, 'committed')
        try: retire_previous_app(ctx, snapshot['old'])
        except OSError: return {'status': 'committed', 'retainedBackup': str(ctx['backup'])}
        if exists(ctx['backup']): return {'status': 'committed', 'retainedBackup': str(ctx['backup'])}
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
            uninstallers = io_path(app).glob('Uninstall*.exe')
            if plan['schema'] == 2:
                uninstaller = io_path(app / f'Uninstall {executable.stem}.exe')
                uninstallers = [uninstaller] if exists(uninstaller) else []
            for uninstaller in uninstallers:
                if file_identity(uninstaller) is None or not uninstaller.is_file():
                    raise ValueError('卸载程序文件类型无效')
                shutil.copy2(uninstaller, io_path(incoming / uninstaller.name))
        identity = read_json(resources / 'launcher-update-info.json')
        if (identity['version'] != plan['version'] or identity['platform'] != plan['platform']
                or identity['arch'] != plan['arch'] or not io_path(incoming / executable).is_file()):
            raise ValueError('更新包身份不匹配')
        script = recovery_entry(ctx)
        if plan['platform'] == 'darwin' and list(io_path(stage).iterdir()) != [io_path(incoming)]:
            raise ValueError('更新包必须只包含受管应用')
        old = {'identity': initial_identity, 'version': plan['previousVersion']}
        if plan['schema'] == 2 and plan['platform'] == 'win32':
            old['programPaths'] = windows_program_paths(app, incoming)
        old['digest'] = tree_digest(app, plan['platform'], scope=previous_app_scope(ctx, old))
        snapshot = {key: plan.get(key) for key in ('token', 'home', 'appRoot', 'executable', 'platform', 'arch', 'version', 'target')}
        snapshot.update(schema='nora-launcher-recovery/1', homeIdentity=home_identity, helperDigest=digest(job / 'replace.py'),
            old=old,
            incoming={'identity': file_identity(incoming), 'digest': tree_digest(incoming, plan['platform'])},
            stageIdentity=file_identity(stage), stageDigest=tree_digest(stage, plan['platform']),
            incomingRelative='.' if incoming == stage else incoming.name)
        if plan['schema'] == 2:
            snapshot.update({key: plan[key] for key in ('operationId', 'ownerEpoch', 'planDigest', 'releasePlan', 'executorProtocol',
                'rollbackCompatibility', 'parentPid', 'parentCreationTime')})
            if 'helperRuntime' in plan: snapshot['helperRuntime'] = plan['helperRuntime']
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
    sharing_failure = None
    try:
        checkpoint(ctx, snapshot, 'waiting-parent', **worker_identity())
        wait_parent(plan['parentPid'], plan.get('parentCreationTime'), cancel=job / 'cancel')
        if exists(job / 'cancel'): raise RuntimeError('更新已取消')
        helper_runtime(ctx)
        validate_snapshot(ctx, full=True)
        if not untouched(ctx, snapshot): raise ValueError('原启动器在准备期间发生变化，未替换程序')
        checkpoint(ctx, snapshot, 'moving-old')
        try:
            retry_rename(app, backup)
        except PermissionError as error:
            code = getattr(error, 'winerror', None)
            if (plan['platform'] == 'win32' and plan['schema'] == 2 and plan['releasePlan'].get('client') == 'app'
                    and type(code) is int):
                if code in (32, 33):
                    sharing_failure = {'schema': 'nora-app-sharing-failure/1', 'phase': 'moving-old', 'winerror': code}
                elif (code == 5 and error.filename == str(io_path(app))
                        and error.filename2 == str(io_path(backup))):
                    # NTFS can deny this rename while an external file is
                    # locked. Error 5 alone does not identify the cause.
                    sharing_failure = {'schema': 'nora-app-move-denied/1', 'phase': 'moving-old', 'winerror': code}
            raise
        moved = True
        checkpoint(ctx, snapshot, 'installing-new'); retry_rename(incoming, app)
        checkpoint(ctx, snapshot, 'awaiting-launcher')
        args = [str(app / executable), '--nora-self-update=' + str(job)]
        if plan.get('localRelease'): args.append('--nora-local-release=' + plan['localRelease'])
        options = {'executable': args[0]} if os.name == 'nt' else {}
        child = subprocess.Popen(args, cwd=launcher_cwd(home), env=launcher_environment(ctx), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=os.name != 'nt', **options)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if ready_acknowledged(ctx):
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
        annotate_failure(snapshot, error)
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
                restored = None
                try:
                    durable = validate_snapshot(ctx, full=True)
                    if durable['phase'] == 'restored': restored = durable
                    annotate_failure(durable, recovery_error)
                except (OSError, ValueError, KeyError, TypeError): pass
                error.secondary_errors = [*getattr(error, 'secondary_errors', ()), recovery_error]
                if restored:
                    report_failure(ctx, restored, 'restored', error, relaunchError=error_data(recovery_error))
                else:
                    report_failure(ctx, snapshot, 'recovery-failed', error, rollbackError=error_data(recovery_error))
            else:
                report_failure(ctx, snapshot, 'restored', error, launchAttempted=True)
        else:
            try: cancel_untouched(ctx, snapshot, error=error, sharing_failure=sharing_failure)
            except Exception as recovery_error:
                error.secondary_errors = [*getattr(error, 'secondary_errors', ()), recovery_error]
                report_failure(ctx, snapshot, 'recovery-failed', error)
        freeze_failure(ctx, error)
        # The parent may already have quit for the handoff. Reopen its verified
        # untouched program only after all slow cleanup/evidence work, so the
        # returning GUI can acquire the writer and end the original task.
        if not moved and snapshot.get('phase') == 'cancelled' and not exists(job / 'cancel'):
            try:
                if not parent_alive(plan['parentPid'], plan.get('parentCreationTime')):
                    checkpoint(ctx, snapshot, 'cancelled', launchAttempted=True, diagnosticError=error_data(error))
                    launch_old(ctx)
            except Exception as relaunch_error:
                error.secondary_errors = [*getattr(error, 'secondary_errors', ()), relaunch_error]
                report_failure(ctx, snapshot, 'cancelled', error, relaunchError=error_data(relaunch_error))
        raise


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--assess', metavar='JOB')
    modes.add_argument('--inspect-outcome', metavar='JOB')
    modes.add_argument('--read-outcome', metavar='JOB')
    modes.add_argument('--inspect-prepared', metavar='JOB')
    modes.add_argument('--diagnostics', metavar='JOB')
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
    parser.add_argument('--no-diagnostic-details', action='store_true')
    parser.add_argument('--historical-app-segment-sequence', type=int)
    parser.add_argument('--settle-app-revision', nargs=2, type=int, metavar=('EPOCH', 'SEQUENCE'))
    parser.add_argument('--app-rollback-runtime')
    args = parser.parse_args()
    if args.historical_app_segment_sequence is not None and not (args.prepare_recovery or args.recover):
        parser.error('历史任务的APP操作只支持原地恢复')
    if args.settle_app_revision is not None and (not args.recover or args.historical_app_segment_sequence is not None):
        parser.error('APP任务结束只支持独立恢复')
    if args.app_rollback_runtime is not None and (args.settle_app_revision is None or len(args.app_rollback_runtime) > 8192):
        parser.error('APP恢复运行资源无效')
    job = Path(args.assess or args.inspect_outcome or args.read_outcome or args.inspect_prepared or args.diagnostics or args.prepare or args.prepare_recovery or args.recover or args.finalize or args.job or '').absolute()
    if not (args.assess or args.inspect_outcome or args.read_outcome or args.inspect_prepared or args.diagnostics or args.prepare or args.prepare_recovery or args.process_identity or args.recover or args.finalize or args.job):
        parser.error('缺少更新任务目录')
    try:
        if args.recover or args.job:
            detach_inherited_crash_handler()
        if args.process_identity:
            result = process_identity(args.process_identity)
        elif args.prepare:
            result = prepare(job)
        elif args.prepare_recovery:
            result = prepare_recovery(job, parent_pid=args.parent_pid, parent_creation_time=args.parent_created,
                                      historical_sequence=args.historical_app_segment_sequence)
        elif args.assess:
            result = assess(job)
        elif args.inspect_outcome:
            result = inspect_outcome(job)
        elif args.read_outcome:
            result = read_outcome(job)
        elif args.inspect_prepared:
            result = inspect_prepared(job)
        elif args.diagnostics:
            result = inspect_diagnostics(job, details=not args.no_diagnostic_details)
        elif args.recover:
            runtime = json.loads(base64.b64decode(args.app_rollback_runtime, validate=True)) if args.app_rollback_runtime else None
            if args.app_rollback_runtime is not None and not isinstance(runtime, dict):
                raise ValueError('APP恢复运行资源无效')
            result = recover(job, parent_pid=args.parent_pid, parent_creation_time=args.parent_created,
                             historical_sequence=args.historical_app_segment_sequence, app_revision=args.settle_app_revision,
                             app_runtime=runtime)
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
        elif args.recover and args.historical_app_segment_sequence is None:
            try:
                status = read_json(job / 'status.json')
                if status.get('workerPid') != os.getpid() and status.get('status') != 'restored':
                    write_json(job / 'status.json', {'status': 'error', 'error': str(error), 'workerPid': os.getpid(), 'diagnosticError': error_data(error)})
            except (OSError, ValueError):
                pass
        if not args.job:
            print(json.dumps({'error': error_data(error)}, ensure_ascii=False), flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
