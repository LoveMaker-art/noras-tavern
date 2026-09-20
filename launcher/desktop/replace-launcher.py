"""Replace only the desktop application; run from the existing Hermes Python."""
import hashlib
import json
import os
import plistlib
import shutil
import stat
import subprocess
import sys
import time
import zipfile
from pathlib import Path, PurePosixPath


def write_json(file, value):
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.replace(temporary, file)


def digest(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def contained(file, root):
    return file == root or root in file.parents


def extract(archive, destination, platform):
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if len(members) > 100000 or sum(item.file_size for item in members) > 3 * 1024 ** 3:
            raise ValueError('更新包解压大小超限')
        names = set()
        for item in members:
            name = item.filename
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


def parent_alive(pid):
    if os.name == 'nt':
        import ctypes
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x100000, False, pid)
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(handle, 0) == 258
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
            os.replace(source, target)
            return
        except PermissionError:
            if attempt == 99:
                raise
            time.sleep(0.2)


def run(job):
    plan = json.loads((job / 'plan.json').read_text(encoding='utf-8'))
    app = Path(plan['appRoot'])
    home = Path(plan['home'])
    token = plan['token']
    if (plan.get('schema') != 1 or not app.is_absolute() or not home.is_absolute()
            or app == Path(app.anchor) or contained(home.resolve(), app.resolve())
            or job.parent != home / 'installer/launcher-update'
            or not job.name.startswith('job-') or len(token) != 36
            or any(c not in '0123456789abcdef-' for c in token)
            or plan['platform'] not in ('darwin', 'win32')
            or not app.is_dir() or app.is_symlink()):
        raise ValueError('更新计划中的目录无效')
    executable = Path(plan['executable'])
    if executable.is_absolute() or '..' in executable.parts or not (app / executable).is_file():
        raise ValueError('更新计划中的程序无效')
    stage = app.parent / ('.nora-stage-' + token)
    backup = app.parent / ('.nora-previous-' + token)
    status = lambda state, **extra: write_json(job / 'status.json', {'status': state, **extra})
    moved = False
    child = None
    env = os.environ.copy()
    env.pop('ELECTRON_RUN_AS_NODE', None)
    env['NORA_TAVERN_HOME'] = str(home)
    try:
        if digest(Path(plan['archive'])) != plan['sha256']:
            raise ValueError('更新包校验失败')
        stage.mkdir(mode=0o700)
        extract(Path(plan['archive']), stage, plan['platform'])
        if plan['platform'] == 'darwin':
            apps = list(stage.glob('*.app'))
            if len(apps) != 1:
                raise ValueError('更新包必须包含唯一应用')
            incoming = apps[0]
            with (incoming / 'Contents/Info.plist').open('rb') as file:
                info = plistlib.load(file)
            with (app / 'Contents/Info.plist').open('rb') as file:
                previous = plistlib.load(file)
            if info['CFBundleIdentifier'] != previous['CFBundleIdentifier'] or info['CFBundleShortVersionString'] != plan['version']:
                raise ValueError('应用标识与原安装不一致')
            subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(incoming)], check=True, timeout=60)
            resources = incoming / 'Contents/Resources'
        else:
            incoming = stage
            resources = incoming / 'resources'
            # NSIS owns the existing uninstall registration and executable.
            for uninstaller in app.glob('Uninstall*.exe'):
                if uninstaller.is_symlink():
                    raise ValueError('卸载程序不能是符号链接')
                shutil.copy2(uninstaller, incoming / uninstaller.name)
        identity = json.loads((resources / 'launcher-update-info.json').read_text(encoding='utf-8'))
        if (identity['version'] != plan['version'] or identity['platform'] != plan['platform']
                or identity['arch'] != plan['arch'] or not (incoming / executable).is_file()):
            raise ValueError('更新包身份不匹配')
        status('prepared')
        deadline = time.monotonic() + 60
        while parent_alive(plan['parentPid']):
            if (job / 'cancel').exists() or time.monotonic() > deadline:
                raise TimeoutError('旧启动器尚未退出，已取消替换')
            time.sleep(0.1)
        if (job / 'cancel').exists():
            raise RuntimeError('更新已取消')
        status('replacing')
        retry_rename(app, backup)
        moved = True
        retry_rename(incoming, app)
        args = [str(app / executable), '--nora-self-update=' + str(job)]
        if plan.get('localRelease'):
            args.append('--nora-local-release=' + plan['localRelease'])
        child = subprocess.Popen(args, cwd=home, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=os.name != 'nt')
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            ready = job / 'ready.json'
            if ready.exists():
                ack = json.loads(ready.read_text(encoding='utf-8'))
                if ack == {'token': token, 'version': plan['version']}:
                    status('success')
                    try:
                        shutil.rmtree(backup)
                    except OSError:
                        status('success', retainedBackup=str(backup))
                    return
            if child.poll() is not None:
                raise RuntimeError('新版启动器提前退出')
            time.sleep(0.2)
        raise TimeoutError('新版启动器未确认启动')
    except Exception as error:
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
        if moved:
            try:
                if app.exists():
                    retry_rename(app, app.parent / ('.nora-failed-' + token))
                retry_rename(backup, app)
            except Exception as rollback_error:
                status('error', error=str(error), rollbackError=str(rollback_error), backup=str(backup))
                raise
            state_file = home / 'installer/state.json'
            try:
                state = json.loads(state_file.read_text(encoding='utf-8')) if state_file.is_file() else {}
                if not isinstance(state, dict):
                    state = {}
            except (OSError, ValueError):
                state = {}
            try:
                state.update(phase='error', resumeTarget=plan.get('target'),
                             error='启动器更新失败，已恢复旧程序：' + str(error), task='')
                write_json(state_file, state)
            except OSError as state_error:
                print('旧程序已恢复，但状态记录写入失败：' + str(state_error), flush=True)
            args = [str(app / executable)]
            if plan.get('localRelease'):
                args.append('--nora-local-release=' + plan['localRelease'])
            try:
                subprocess.Popen(args, cwd=home, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=os.name != 'nt')
            except OSError as launch_error:
                status('error', error=str(error), rolledBack=True, relaunchError=str(launch_error), restoredApp=str(app))
                raise
        status('error', error=str(error), rolledBack=moved)
        raise
    finally:
        if stage.exists():
            try:
                shutil.rmtree(stage)
            except OSError as cleanup_error:
                print('临时目录未能清理：' + str(cleanup_error), flush=True)


if __name__ == '__main__':
    job = Path(sys.argv[1]).absolute()
    try:
        run(job)
    except Exception as error:
        if not (job / 'status.json').exists():
            write_json(job / 'status.json', {'status': 'error', 'error': str(error)})
        print(str(error), flush=True)
        sys.exit(1)
