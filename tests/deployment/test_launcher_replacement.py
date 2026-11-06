import importlib.util
import hashlib
import json
import math
import os
import subprocess
import shutil
import stat
import sys
import tempfile
import unittest
import uuid
import zipfile
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

if __package__:
    from .launcher_test_environment import resolve_node
else:
    from launcher_test_environment import resolve_node
if __package__:
    from .test_launcher_update_recovery import close_fixture_child
else:
    from test_launcher_update_recovery import close_fixture_child
SOURCE = Path(__file__).resolve().parent.parent / 'installer/desktop/replace-launcher.py'
SPEC = importlib.util.spec_from_file_location('replace_launcher', SOURCE)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class ReplacementTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin exception ports are platform-specific')
    def test_recovery_worker_releases_inherited_crashpad_while_worker_stays_alive(self):
        import psutil
        import time
        modules = Path(os.environ.get('NORA_TEST_DESKTOP_NODE_MODULES', SOURCE.parent / 'node_modules'))
        electron = modules / 'electron/dist/Electron.app/Contents/MacOS/Electron'
        self.assertTrue(electron.is_file(), 'Mac recovery regression requires the installed Electron binary')
        with tempfile.TemporaryDirectory(prefix='nora-crashpad-recovery-') as directory:
            root = Path(directory).resolve()
            child_script = root / 'child.py'
            child_script.write_text('''import ctypes,json,os,runpy,sys,time
from pathlib import Path
root=Path(sys.argv[1])
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib');port=ctypes.c_uint32;integer=ctypes.c_int32
task=port.in_dll(lib,'mach_task_self_').value;masks=(port*32)();ports=(port*32)();behaviors=(integer*32)();flavors=(integer*32)();count=port(32)
get=lib.task_get_exception_ports;get.argtypes=[port,port,ctypes.POINTER(port),ctypes.POINTER(port),ctypes.POINTER(port),ctypes.POINTER(integer),ctypes.POINTER(integer)];get.restype=integer
dealloc=lib.mach_port_deallocate;dealloc.argtypes=[port,port];dealloc.restype=integer
assert get(task,0x1c00,masks,ctypes.byref(count),ports,behaviors,flavors)==0
registered=sum(bool(ports[i]) for i in range(count.value))
for i in range(count.value):
 if ports[i]:assert dealloc(task,ports[i])==0
assert registered,'Actual Electron parent did not install an inherited crash handler'
runpy.run_path(sys.argv[2])['detach_inherited_crash_handler']()
(root/'ready.json').write_text(json.dumps({'pid':os.getpid(),'inheritedHandlers':registered}))
deadline=time.monotonic()+15
while time.monotonic()<deadline and not (root/'stop').exists():time.sleep(.05)
(root/'exited').touch()
''')
            main = root / 'main.cjs'
            main.write_text('''const {app,crashReporter}=require('electron'),{spawn}=require('child_process'),fs=require('fs'),path=require('path');
const root=process.argv[2];app.setPath('userData',path.join(root,'profile'));app.setPath('crashDumps',path.join(root,'crashes'));
app.whenReady().then(()=>{crashReporter.start({productName:'Nora recovery regression',submitURL:'https://127.0.0.1/disabled',uploadToServer:false});
const c=spawn(process.argv[3],['-B',path.join(root,'child.py'),root,process.argv[4]],{detached:true,stdio:'ignore'});c.unref();fs.writeFileSync(path.join(root,'spawned.json'),JSON.stringify({pid:c.pid}));
const deadline=Date.now()+10000,t=setInterval(()=>{if(fs.existsSync(path.join(root,'ready.json'))){clearInterval(t);app.exit(0);}else if(Date.now()>deadline){clearInterval(t);app.exit(1);}},20);});
''')
            env = {key: value for key, value in os.environ.items()
                   if key not in ('ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH')}
            child = None
            def handlers():
                result = []
                for process in psutil.process_iter(['pid', 'exe', 'cmdline']):
                    try:
                        if (Path(process.info['exe'] or '/').name == 'chrome_crashpad_handler'
                                and any(str(root) in arg for arg in process.info['cmdline'] or [])):
                            result.append(process.pid)
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue
                return result
            try:
                result = subprocess.run([str(electron), str(main), str(root), sys.executable, str(SOURCE)],
                    env=env, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                ready = json.loads((root / 'ready.json').read_text())
                self.assertGreater(ready['inheritedHandlers'], 0)
                child = psutil.Process(ready['pid'])
                deadline = time.monotonic() + 3
                while handlers() and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertTrue(child.is_running(), 'Recovery worker must remain alive after the parent exits')
                self.assertNotEqual(child.status(), psutil.STATUS_ZOMBIE)
                self.assertFalse((root / 'exited').exists())
                self.assertFalse(handlers(), 'Inherited crash reporter must exit without excluding or killing it')
            finally:
                (root / 'stop').touch()
                if child is None and (root / 'spawned.json').exists():
                    try:
                        candidate = psutil.Process(json.loads((root / 'spawned.json').read_text())['pid'])
                        if str(child_script) in candidate.cmdline() and str(root) in candidate.cmdline():
                            child = candidate
                    except psutil.NoSuchProcess:
                        pass
                if child:
                    deadline = time.monotonic() + 5
                    while child.is_running() and child.status() != psutil.STATUS_ZOMBIE and time.monotonic() < deadline:
                        time.sleep(.05)
                    self.assertTrue((root / 'exited').exists(), 'Owned child must finish normally')

    def test_crash_handler_detach_failure_stops_recovery_before_modifying_program(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            program = root / 'program'
            program.write_bytes(b'original program')
            (root / 'status.json').write_text(json.dumps({'status': 'awaiting-system', 'workerPid': 1}))
            with patch.object(sys, 'argv', [str(SOURCE), '--recover', str(root)]), \
                    patch.object(worker, 'detach_inherited_crash_handler', side_effect=RuntimeError('native detach refused')), \
                    patch.object(worker, 'recover') as recover:
                with self.assertRaises(SystemExit) as result:
                    worker.main()
                self.assertEqual(result.exception.code, 1)
                recover.assert_not_called()
            self.assertEqual(program.read_bytes(), b'original program')

    def test_file_digest_progress_counts_only_read_blocks_and_preserves_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'blocks.bin'
            payload = b'a' * (1024 * 1024) + b'actual-tail'
            file.write_bytes(payload)
            events = []
            expected = hashlib.sha256(payload).hexdigest()
            self.assertEqual(worker.digest(file), expected)
            self.assertEqual(worker.digest(file, on_progress=lambda size, entries: events.append((size, entries))), expected)
            self.assertEqual(events, [(1024 * 1024, 0), (len(b'actual-tail'), 0)])
            file.write_bytes(b'')
            events.clear()
            self.assertEqual(worker.digest(file, on_progress=lambda size, entries: events.append((size, entries))), hashlib.sha256(b'').hexdigest())
            self.assertEqual(events, [])

    def test_tree_digest_progress_preserves_size_mode_order_and_empty_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / 'data.bin'
            payload = b'x' * (1024 * 1024) + b'last-block'
            data.write_bytes(payload)
            (root / 'empty').mkdir()
            empty = root / 'empty/zero.dat'
            empty.write_bytes(b'')
            for platform in ('win32', 'darwin'):
                with self.subTest(platform=platform):
                    encoded = b'D\0F/data.bin\0' + str(len(payload)).encode() + b'\0'
                    if platform == 'darwin': encoded += str(data.stat().st_mode & 0o777).encode() + b'\0'
                    encoded += payload + b'D/empty\0F/empty/zero.dat\x000\0'
                    if platform == 'darwin': encoded += str(empty.stat().st_mode & 0o777).encode() + b'\0'
                    expected = hashlib.sha256(encoded).hexdigest()
                    events = []
                    self.assertEqual(worker.tree_digest(root, platform), expected)
                    self.assertEqual(worker.tree_digest(root, platform,
                        on_progress=lambda size, entries: events.append((size, entries))), expected)
                    self.assertEqual(events, [(0, 1), (0, 1), (1024 * 1024, 0), (len(b'last-block'), 0), (0, 1), (0, 1)])

    def test_windows_tree_digest_accepts_only_stable_empty_files_without_reading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            locked = worker.io_path(root / 'run.lock')
            locked.touch()
            expected = hashlib.sha256(b'D\0F/run.lock\x000\0').hexdigest()
            original_open = Path.open

            def deny_read(file, *args, **options):
                if file == locked:
                    error = PermissionError(13, 'controlled deny-read on a program file')
                    error.winerror = 33
                    raise error
                return original_open(file, *args, **options)

            with patch.object(Path, 'open', deny_read):
                for scope in (None, {'': ['run.lock']}):
                    self.assertEqual(worker.tree_digest(root, 'win32', scope=scope), expected)
            original_lstat = Path.lstat
            for mutation in ('growth', 'replacement'):
                locked.write_bytes(b'')
                replacement = root / 'replacement.lock'
                replacement.touch()
                reads = 0

                def mutate_before_recheck(file):
                    nonlocal reads
                    if file == locked:
                        reads += 1
                        if reads == 2:
                            if mutation == 'growth':
                                locked.write_bytes(b'new content')
                            else:
                                replacement.replace(locked)
                    return original_lstat(file)

                with self.subTest(mutation=mutation), patch.object(Path, 'lstat', mutate_before_recheck):
                    with self.assertRaisesRegex(ValueError, '空文件.*变化'):
                        worker.tree_digest(root, 'win32')
            locked.write_bytes(b'nonempty content')
            with patch.object(Path, 'open', deny_read):
                with self.assertRaises(PermissionError):
                    worker.tree_digest(root, 'win32')

    def test_digest_progress_does_not_count_unread_bytes_on_read_failure(self):
        class InterruptedRead:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size):
                if getattr(self, 'read_once', False): raise OSError('actual second read failed')
                self.read_once = True
                return b'b' * size
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'partial.bin'
            file.write_bytes(b'b' * (1024 * 1024) + b'not-read')
            for tree in (False, True):
                with self.subTest(tree=tree):
                    events = []
                    with patch.object(Path, 'open', return_value=InterruptedRead()):
                        with self.assertRaisesRegex(OSError, 'actual second read failed'):
                            if tree:
                                worker.tree_digest(file, 'win32', on_progress=lambda size, entries: events.append((size, entries)))
                            else:
                                worker.digest(file, on_progress=lambda size, entries: events.append((size, entries)))
                    self.assertEqual(events, ([(0, 1)] if tree else []) + [(1024 * 1024, 0)])

    def test_tree_digest_progress_does_not_confirm_failed_or_unsupported_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for failure in (OSError('actual lstat failed'), SimpleNamespace(st_mode=stat.S_IFIFO),
                            SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)):
                events = []
                options = {'side_effect': failure} if isinstance(failure, OSError) else {'return_value': failure}
                with patch.object(Path, 'lstat', **options):
                    with self.assertRaises((OSError, ValueError)):
                        worker.tree_digest(root, 'win32', on_progress=lambda size, entries: events.append((size, entries)))
                self.assertEqual(events, [])

    @unittest.skipIf(os.name == 'nt', 'Creating symlinks requires Windows developer mode or administrator privileges')
    def test_tree_digest_progress_counts_only_accepted_internal_mac_link(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'actual').write_bytes(b'content')
            link = root / 'current'
            link.symlink_to('actual')
            events = []
            expected = worker.tree_digest(root, 'darwin')
            self.assertEqual(worker.tree_digest(root, 'darwin', on_progress=lambda size, entries: events.append((size, entries))), expected)
            self.assertEqual(sum(size for size, _ in events), len(b'content'))
            self.assertEqual(sum(entries for _, entries in events), 3)
            events.clear()
            with self.assertRaisesRegex(ValueError, '目录外链接'):
                worker.tree_digest(link, 'win32', on_progress=lambda size, entries: events.append((size, entries)))
            self.assertEqual(events, [])
            link.unlink(); link.symlink_to('../outside')
            with self.assertRaisesRegex(ValueError, '目录外链接'):
                worker.tree_digest(link, 'darwin', on_progress=lambda size, entries: events.append((size, entries)))
            self.assertEqual(events, [])

    def test_desktop_relaunch_preserves_user_profile_and_removes_python_execution_flags(self):
        original = {'HOME': '/fixture/user', 'USERPROFILE': r'C:\Users\fixture',
                    'APPDATA': r'C:\Users\fixture\AppData\Roaming',
                    'LOCALAPPDATA': r'C:\Users\fixture\AppData\Local',
                    'TMPDIR': '/fixture/user-temp', 'TEMP': r'C:\fixture\temp',
                    'XDG_CACHE_HOME': '/fixture/user-cache', 'XDG_DATA_HOME': '/fixture/user-data'}
        python_flags = {'__PYVENV_LAUNCHER__': '/fixture/managed/venv/python',
                        'ELECTRON_RUN_AS_NODE': '1', 'NODE_OPTIONS': '--fixture', 'NODE_PATH': '/fixture/modules',
                        'NORA_OPERATION_DELEGATE_TOKEN': 'fixture-delegate-token'}
        with patch.dict(os.environ, {**original, **python_flags}, clear=True):
            environment = worker.launcher_environment({'home': Path('/fixture/nora')})
        for name, expected in original.items():
            self.assertEqual(environment[name], expected)
        for name in python_flags:
            self.assertNotIn(name, environment)
        self.assertEqual(environment['NORA_TAVERN_HOME'], str(Path('/fixture/nora')))

    def test_desktop_relaunch_restores_profile_from_private_helper(self):
        desktop = {'HOME': '/fixture/desktop', 'USERPROFILE': '/fixture/desktop',
                   'APPDATA': None, 'LOCALAPPDATA': '/fixture/desktop/local',
                   'TMPDIR': '/fixture/desktop-temp', 'TEMP': None, 'TMP': '/fixture/desktop-temp'}
        helper = {name: '/fixture/private-helper' for name in desktop}
        with patch.dict(os.environ, {**helper, 'NORA_TAVERN_HOME': '/fixture/untrusted',
                'NORA_APP_RELAUNCH_PROFILE': json.dumps(desktop)}, clear=True):
            home = Path('/fixture/nora')
            environment = worker.launcher_environment({'home': home})
        self.assertEqual(environment, {**{key: value for key, value in desktop.items() if value is not None},
                                      'NORA_TAVERN_HOME': str(home)})

    def test_desktop_relaunch_rejects_invalid_or_unbounded_profile(self):
        for profile in ('[]', '{', json.dumps({'PATH': '/fixture/foreign'}),
                        json.dumps({'NORA_TAVERN_HOME': '/fixture/foreign'}),
                        json.dumps({'HOME': 0}), json.dumps({'HOME': 'invalid\0path'}),
                        json.dumps({'HOME': 'a' * (16 * 1024)})):
            with self.subTest(profile_prefix=profile[:48]), \
                    patch.dict(os.environ, {'NORA_APP_RELAUNCH_PROFILE': profile}, clear=True):
                with self.assertRaisesRegex(ValueError, '启动器重启环境无效'):
                    worker.launcher_environment({'home': Path('/fixture/nora')})

    def test_windows_unknown_parent_state_is_never_treated_as_exit(self):
        import ctypes
        from unittest.mock import Mock
        for handle, wait, error_code, expected in (
            (None, 0, 5, 'error'), (None, 0, 87, False),
            (10, 0xffffffff, 5, 'error'), (10, 258, 0, True), (10, 0, 0, False),
        ):
            with self.subTest(handle=handle, wait=wait, error_code=error_code):
                kernel = SimpleNamespace(OpenProcess=Mock(return_value=handle),
                    WaitForSingleObject=Mock(return_value=wait), GetLastError=Mock(return_value=error_code),
                    CloseHandle=Mock())
                failure = PermissionError(13, 'fixture OpenProcess access denied')
                with patch.object(worker.os, 'name', 'nt'), patch.object(ctypes, 'windll', SimpleNamespace(kernel32=kernel), create=True), \
                        patch.object(ctypes, 'WinError', side_effect=lambda code: failure, create=True):
                    if expected == 'error':
                        with self.assertRaises(OSError) as raised:
                            worker.parent_alive(12345)
                        self.assertIs(raised.exception, failure)
                    else:
                        self.assertIs(worker.parent_alive(12345), expected)
                if handle:
                    kernel.CloseHandle.assert_called_once_with(handle)

    def test_windows_relaunch_does_not_use_filesystem_namespace_for_native_executable(self):
        application = Path('/fixture/application')
        home = Path('/fixture/home')
        context = {'app': application, 'executable': 'launcher.exe', 'home': home, 'plan': {}}
        with patch.object(worker.os, 'name', 'nt'), \
                patch.object(worker, 'launcher_cwd', return_value=home), \
                patch.object(worker.subprocess, 'Popen') as launch:
            worker.launch_old(context)
        arguments, options = launch.call_args
        self.assertEqual(arguments[0][0], str(application / 'launcher.exe'))
        self.assertEqual(options['executable'], arguments[0][0],
                         'The real Electron GUI exits before main.js when started with a filesystem namespace prefix')

    @unittest.skipUnless(os.environ.get('NORA_TEST_LAUNCHER_ARCHIVE'), 'Optional real archive acceptance')
    def test_real_archive_matches_build_inputs_without_runtime_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.assertIn(sys.platform, ('darwin', 'win32'))
            worker.extract(Path(os.environ['NORA_TEST_LAUNCHER_ARCHIVE']), root, sys.platform)
            application = root
            if sys.platform == 'darwin':
                apps = list(root.glob('*.app'))
                self.assertEqual(len(apps), 1)
                application = apps[0]
                subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(application)], check=True, timeout=60)
            subprocess.run([resolve_node(required=True), str(Path(__file__).with_name('verify_launcher_update.cjs')),
                            str(application), os.environ['NORA_TEST_LAUNCHER_DESKTOP'], sys.platform], check=True, timeout=30)

    def test_rejects_zip_escape(self):
        for name in ('../outside', '/outside', 'C:/outside', 'safe/../../outside', 'safe\\outside'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / 'bad.zip'
                with zipfile.ZipFile(archive, 'w') as bundle:
                    info = zipfile.ZipInfo()
                    info.filename = name
                    bundle.writestr(info, 'bad')
                with self.assertRaises(ValueError):
                    worker.extract(archive, root / 'stage', 'win32')

    def scenario(self, fail=False, corrupt_state=False, local_release=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        home = root / 'data'
        app = root / 'application'
        app.mkdir()
        (app / 'launcher.exe').write_text('old')
        (app / 'Uninstall launcher.exe').write_text('uninstaller')
        job = home / 'installer/launcher-update/job-test'
        job.mkdir(parents=True)
        shutil.copy2(SOURCE, job / 'replace.py')
        python = home / 'hermes/hermes-agent/venv/Scripts/python.exe'
        python.parent.mkdir(parents=True)
        python.write_text('existing managed interpreter fixture')
        if corrupt_state:
            (home / 'installer/state.json').write_text('{broken')
        (home / 'world.json').write_text('user-world')
        archive = root / 'update.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('launcher.exe', 'new')
            bundle.writestr('resources/launcher-update-info.json', json.dumps({'version': '1.1.0', 'platform': 'win32', 'arch': 'x64'}))
        plan = {'schema': 1, 'token': str(uuid.uuid4()), 'home': str(home), 'appRoot': str(app),
                'executable': 'launcher.exe', 'platform': 'win32', 'arch': 'x64', 'version': '1.1.0',
                'previousVersion': '1.0.0', 'target': 'v2.4.2',
                'archive': str(archive), 'sha256': worker.digest(archive), 'parentPid': 100}
        if local_release:
            plan['localRelease'] = str(root / 'offline release 中文 &%!()')
        (job / 'plan.json').write_text(json.dumps(plan))
        calls = []

        class Child:
            def poll(self):
                return 1 if fail else None

        def launch(args, **kwargs):
            calls.append(args)
            self.assertEqual(kwargs['env']['NORA_TAVERN_HOME'], str(home))
            if not fail:
                worker.write_json(job / 'ready.json', {'token': plan['token'], 'version': plan['version']})
            return Child()

        with patch.object(worker, 'parent_alive', return_value=False), patch.object(worker.subprocess, 'Popen', side_effect=launch):
            if fail:
                with self.assertRaisesRegex(RuntimeError, '提前退出'):
                    worker.run(job, allow_legacy=True)
            else:
                worker.run(job, allow_legacy=True)
        self.assertEqual((home / 'world.json').read_text(), 'user-world')
        self.assertEqual((app / 'Uninstall launcher.exe').read_text(), 'uninstaller')
        self.assertEqual((app / 'launcher.exe').read_text(), 'old' if fail else 'new')
        self.assertEqual(json.loads((job / 'status.json').read_text())['status'], 'restored' if fail else 'awaiting-system')
        self.assertEqual(len(calls), 2 if fail else 1)
        if local_release:
            self.assertIn('--nora-local-release=' + plan['localRelease'], calls[-1])
        self.assertEqual(worker.assess(job, allow_legacy=True) is None, fail)
        if not fail:
            ctx = worker.context(job)
            self.assertTrue(worker.exists(ctx['backup']))
            with self.assertRaisesRegex(ValueError, '尚未通过实际验收'):
                worker.finalize(job, allow_legacy=True, target=plan['target'], version=plan['version'], verified=False)
            worker.finalize(job, allow_legacy=True, target=plan['target'], version=plan['version'], verified=True)
            self.assertFalse(worker.exists(ctx['backup']))
            self.assertIsNone(worker.assess(job, allow_legacy=True))

    def test_replaces_only_application_preserving_data_and_windows_uninstaller(self):
        self.scenario()

    def test_failed_launch_restores_original_application(self):
        self.scenario(fail=True)

    def test_corrupted_status_file_does_not_prevent_restoring_and_relaunching_old_app(self):
        self.scenario(fail=True, corrupt_state=True)

    def test_old_launcher_relaunch_preserves_authorized_offline_release_argument(self):
        self.scenario(fail=True, local_release=True)


class DurableReplacementTests(unittest.TestCase):
    """Real workers and launcher child processes; only the executable boundary is adapted.

    The fixture uses native Python instead of a graphical Electron binary, so this
    exercises actual fsync/rename/locks/process exits on either OS without GUI or
    any user's installation. The generated recovery script still needs native
    double-click acceptance with a real installed launcher.
    """
    def fixture(self, *, fail=False, long=False):
        base = Path(tempfile.mkdtemp(prefix='nora recovery 中文 &%!() ')).resolve()
        root = base
        if long:
            root = root.joinpath(*(['long-directory-0123456789'] * 12))
            worker.io_path(root).mkdir(parents=True)
        home, app = root / 'data', root / 'application'
        worker.io_path(app).mkdir()
        worker.io_path(app / 'launcher.exe').write_text('old')
        worker.io_path(app / 'Uninstall launcher.exe').write_text('uninstaller')
        job = home / 'installer/launcher-update/job-test'
        worker.io_path(job).mkdir(parents=True)
        shutil.copy2(worker.io_path(SOURCE), worker.io_path(job / 'replace.py'))
        managed = home / 'hermes/hermes-agent/venv/Scripts/python.exe'
        worker.io_path(managed.parent).mkdir(parents=True)
        worker.io_path(managed).write_text('existing managed interpreter fixture')
        worker.io_path(home / 'world.json').write_text('user-world')
        archive = root / 'update.zip'
        with zipfile.ZipFile(worker.io_path(archive), 'w') as bundle:
            bundle.writestr('launcher.exe', 'new')
            bundle.writestr('resources/launcher-update-info.json', json.dumps({'version': '1.1.0', 'platform': 'win32', 'arch': 'x64'}))
        plan = {'schema': 1, 'token': str(uuid.uuid4()), 'home': str(home), 'appRoot': str(app),
                'executable': 'launcher.exe', 'platform': 'win32', 'arch': 'x64', 'version': '1.1.0',
                'previousVersion': '1.0.0', 'target': 'v2.4.2', 'archive': str(archive),
                'sha256': worker.digest(archive), 'parentPid': 0}
        worker.write_json(job / 'plan.json', plan)
        # The launcher child records its actual PID, acknowledges only the new
        # executable, and exits. No .exe, GUI, installer, service or network runs.
        launcher = base / 'fixture-launcher.py'
        launcher.write_text('''import json,os,psutil,sys,time
from pathlib import Path
job=Path(sys.argv[1]);kind=sys.argv[2]
if os.name=='nt': job=Path(chr(92)*2+'?'+chr(92)+str(job))
with (job/'children.jsonl').open('a',encoding='utf-8') as file:
 file.write(json.dumps({'pid':os.getpid(),'creationTime':psutil.Process().create_time(),'kind':kind,'spawnId':sys.argv[4],'executable':psutil.Process().exe(),'cwd':os.getcwd()})+'\\n')
if kind=='new' and sys.argv[3]=='fail': sys.exit(3)
if kind=='new':
 plan=json.loads((job/'plan.json').read_text(encoding='utf-8'))
 ready={'token':plan['token'],'version':plan['version']}
 # Match launcher-update.js: readers must never see a partially written ACK.
 temporary=job/('ready-'+str(os.getpid())+'.tmp')
 with temporary.open('x',encoding='utf-8') as file:
  file.write(json.dumps(ready));file.flush();os.fsync(file.fileno())
 os.replace(temporary,job/'ready.json')
time.sleep(0.15)
''')
        runner = base / 'fixture-worker.py'
        runner.write_text('''import importlib.util,json,os,subprocess,sys,time,uuid
from pathlib import Path
spec=importlib.util.spec_from_file_location('replace_worker',sys.argv[1]);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
job=Path(sys.argv[2]);mode=sys.argv[3];edge=sys.argv[4];fail=sys.argv[5];launcher=sys.argv[6]
ctx=w.context(job);real_popen=w.subprocess.Popen;real_replace=w.os.replace

def launch(args,**options):
 if Path(args[0]).name=='launcher.exe':
  kind='new' if any(arg.startswith('--nora-self-update=') for arg in args[1:]) else 'old'
  if os.name=='nt' and options.get('executable')!=args[0]:
   raise AssertionError('Native launcher executable must retain its ordinary application path')
  options.pop('executable',None)
  spawn_id=str(uuid.uuid4())
  with w.io_path(job/'spawns.jsonl').open('a',encoding='utf-8') as file:
   file.write(json.dumps({'spawnId':spawn_id,'kind':kind})+'\\n')
  child=real_popen([sys.executable,'-B',launcher,str(job),kind,fail,spawn_id],**options)
  deadline=time.monotonic()+5
  while time.monotonic()<deadline:
   file=w.io_path(job/'children.jsonl')
   records=[json.loads(line) for line in file.read_text(encoding='utf-8').splitlines()] if file.exists() else []
   matches=[record for record in records if record.get('spawnId')==spawn_id]
   if len(matches)>1: raise RuntimeError('Duplicate fixture launcher birth ACK')
   if matches:
    if matches[0].get('kind')!=kind: raise RuntimeError('Fixture launcher birth ACK kind differs')
    return child
   time.sleep(.005)
  raise RuntimeError('Fixture launcher birth ACK deadline expired; preserve the fixture')
 return real_popen(args,**options)
w.subprocess.Popen=launch

if edge=='unowned-lock':
 real_open=Path.open
 def locked(path,*args,**options):
  if path.name=='clawchat.lock':
   error=PermissionError(13,'fixture byte-range lock',str(path));error.winerror=33;raise error
  return real_open(path,*args,**options)
 Path.open=locked

def rename(source,target):
 real_replace(source,target)
 source,target=Path(source),Path(target)
 pairs={'moving-old':('app','backup'),'installing-new':('stage','app'),'moving-failed':('app','failed'),'restoring-old':('backup','app')}
 if edge in pairs:
  left,right=pairs[edge]
  if source==w.io_path(ctx[left]) and target==w.io_path(ctx[right]): os._exit(91)
w.os.replace=rename
if mode=='run': w.run(job,allow_legacy=True)
else: w.recover(job,allow_legacy=True)
''')
        result = {'base': base, 'held_children': [], 'root': root, 'home': home, 'app': app, 'job': job, 'plan': plan,
                  'runner': runner, 'launcher': launcher, 'fail': 'fail' if fail else 'ok'}
        self.addCleanup(self.cleanup_fixture, result)
        return result

    def cleanup_fixture(self, f):
        failures = []
        for child in f['held_children']:
            try:
                close_fixture_child(child)
            except Exception as error:
                failures.append(error)
        try:
            self.wait_children(f)
        except Exception as error:
            failures.append(error)
        if failures:
            raise RuntimeError(f'Retaining replacement fixture with unconfirmed children: {f["base"]}') from failures[0]
        shutil.rmtree(f['base'])

    def wait_children(self, f):
        import psutil
        spawns_file = worker.io_path(f['job'] / 'spawns.jsonl')
        spawns = [json.loads(line) for line in spawns_file.read_text(encoding='utf-8').splitlines()] if spawns_file.exists() else []
        children = self.children(f)
        expected = [spawn.get('spawnId') for spawn in spawns]
        actual = [child.get('spawnId') for child in children]
        if (any(not isinstance(token, str) or not token for token in expected)
                or len(set(expected)) != len(expected) or len(set(actual)) != len(actual)
                or set(expected) != set(actual)):
            raise RuntimeError('Fixture launcher spawn lacks an exact birth ACK; retaining fixture')
        kinds = {spawn['spawnId']: spawn.get('kind') for spawn in spawns}
        for child in children:
            if (child.get('kind') != kinds[child['spawnId']] or child.get('kind') not in {'old', 'new'}
                    or type(child.get('pid')) is not int or child['pid'] <= 0
                    or type(child.get('creationTime')) not in {int, float} or child['creationTime'] <= 0
                    or not math.isfinite(child['creationTime'])
                    or not isinstance(child.get('executable'), str) or not Path(child['executable']).is_absolute()):
                raise RuntimeError('Fixture launcher birth ACK identity is invalid; retaining fixture')
            try:
                process = psutil.Process(child['pid'])
                if process.create_time() != child['creationTime']:
                    continue  # The original fixture birth is gone; never touch a reused PID.
                try:
                    arguments = process.cmdline()
                except psutil.AccessDenied:
                    # macOS may deny KERN_PROCARGS2 while this exact child is
                    # exiting. A bounded read-only wait can prove closure; a
                    # still-live or unidentified process must retain its files.
                    process.wait(timeout=1)
                    if process.is_running() and process.status() != psutil.STATUS_ZOMBIE:
                        raise
                    continue
                if (str(f['launcher']) not in arguments or child['spawnId'] not in arguments
                        or process.exe() != child['executable']):
                    raise RuntimeError('Original launcher child has unknown command ownership; retaining fixture')
                process.wait(timeout=5)
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                pass

    def execute(self, f, mode='run', edge='', *, check=True):
        result = subprocess.run([sys.executable, '-B', str(f['runner']), str(SOURCE), str(f['job']),
                                 mode, edge, f['fail'], str(f['launcher'])],
                                cwd=f['runner'].parent, capture_output=True, text=True, timeout=30)
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def children(self, f):
        file = worker.io_path(f['job'] / 'children.jsonl')
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def assert_preserved(self, f, old=True):
        self.assertEqual(worker.io_path(f['home'] / 'world.json').read_text(), 'user-world')
        self.assertEqual(worker.io_path(f['app'] / 'launcher.exe').read_text(), 'old' if old else 'new')
        self.assertEqual(worker.io_path(f['app'] / 'Uninstall launcher.exe').read_text(), 'uninstaller')

    def test_real_ack_retains_backup_until_verified_combined_commit(self):
        f = self.fixture()
        self.execute(f)
        self.assert_preserved(f, old=False)
        ctx = worker.context(f['job'])
        self.assertTrue(worker.exists(ctx['backup']))
        self.assertTrue(worker.assess(f['job'], allow_legacy=True)['canRecover'])
        self.assertEqual([item['kind'] for item in self.children(f)], ['new'])
        for proof in ((False, 'v2.4.2', '1.1.0'), (True, 'v2.4.1', '1.1.0'), (True, 'v2.4.2', '1.0.0')):
            with self.assertRaises(ValueError):
                worker.finalize(f['job'], allow_legacy=True, verified=proof[0], target=proof[1], version=proof[2])
            self.assertTrue(worker.exists(ctx['backup']))
        worker.finalize(f['job'], allow_legacy=True, verified=True, target='v2.4.2', version='1.1.0')
        self.assertIsNone(worker.assess(f['job'], allow_legacy=True))
        self.assertFalse(worker.exists(ctx['backup']))

    def test_actual_launcher_failure_restores_and_starts_old_child_once(self):
        f = self.fixture(fail=True)
        result = self.execute(f, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('提前退出', result.stderr)
        self.assert_preserved(f)
        self.assertEqual(worker.read_json(f['job'] / 'recovery.json')['phase'], 'restored')
        self.execute(f, 'recover')
        time_limit = __import__('time').monotonic() + 2
        while len(self.children(f)) < 2 and __import__('time').monotonic() < time_limit:
            __import__('time').sleep(0.01)
        self.assertEqual([item['kind'] for item in self.children(f)], ['new', 'old'])
        self.assertEqual(len({item['pid'] for item in self.children(f)}), 2)

    def test_hard_process_exit_at_each_rename_is_recoverable_and_idempotent(self):
        for edge in ('moving-old', 'installing-new', 'moving-failed', 'restoring-old'):
            with self.subTest(edge=edge):
                f = self.fixture()
                if edge in ('moving-old', 'installing-new'):
                    result = self.execute(f, edge=edge, check=False)
                else:
                    self.execute(f)
                    result = self.execute(f, 'recover', edge=edge, check=False)
                self.assertEqual(result.returncode, 91, result.stdout + result.stderr)
                self.assertTrue(worker.assess(f['job'], allow_legacy=True)['canRecover'])
                self.execute(f, 'recover')
                self.assert_preserved(f)
                snapshot = worker.read_json(f['job'] / 'recovery.json')
                self.assertEqual(snapshot['phase'], 'restored')
                self.execute(f, 'recover')
                deadline = __import__('time').monotonic() + 2
                while not any(item['kind'] == 'old' for item in self.children(f)) and __import__('time').monotonic() < deadline:
                    __import__('time').sleep(0.01)
                self.assertEqual(sum(item['kind'] == 'old' for item in self.children(f)), 1)
                self.assertIsNone(worker.assess(f['job'], allow_legacy=True))

    def test_missing_or_tampered_backup_and_unknown_current_preserve_all_evidence(self):
        for invalid in ('missing', 'tampered', 'unknown-current', 'unknown-phase'):
            with self.subTest(invalid=invalid):
                f = self.fixture()
                self.execute(f)
                ctx = worker.context(f['job'])
                if invalid == 'missing':
                    shutil.rmtree(worker.io_path(ctx['backup']))
                elif invalid == 'tampered':
                    worker.io_path(ctx['backup'] / 'launcher.exe').write_text('tampered')
                elif invalid == 'unknown-current':
                    moved = f['root'] / 'foreign'
                    worker.retry_rename(f['app'], moved)
                    worker.io_path(f['app']).mkdir()
                    worker.io_path(f['app'] / 'launcher.exe').write_text('foreign')
                else:
                    snapshot = worker.read_json(f['job'] / 'recovery.json')
                    snapshot['phase'] = 'arbitrary-new-state'
                    worker.write_json(f['job'] / 'recovery.json', snapshot)
                before = worker.io_path(f['job'] / 'recovery.json').read_bytes()
                content = worker.io_path(f['app'] / 'launcher.exe').read_bytes()
                with self.assertRaises(ValueError):
                    worker.recover(f['job'], allow_legacy=True)
                self.assertEqual(worker.io_path(f['job'] / 'recovery.json').read_bytes(), before)
                self.assertEqual(worker.io_path(f['app'] / 'launcher.exe').read_bytes(), content)
                self.assertFalse(worker.exists(ctx['failed']))
                self.assertEqual(worker.io_path(f['home'] / 'world.json').read_text(), 'user-world')

    def test_long_native_paths_support_snapshot_hash_rename_and_recovery(self):
        f = self.fixture(long=True)
        self.assertGreater(len(str(f['app'])), 260)
        self.assertEqual(self.execute(f, edge='moving-old', check=False).returncode, 91)
        self.assertTrue(worker.assess(f['job'], allow_legacy=True)['canRecover'])
        self.execute(f, 'recover')
        self.assert_preserved(f)
        script = worker.io_path(f['job'] / '恢复旧启动器.cmd').read_text()
        self.assertIn('setlocal DisableDelayedExpansion', script)
        self.assertIn('"%~dp0replace.py" --recover "%~dp0."', script)
        self.assertNotIn(str(f['home']), script)

    def test_state_permission_failure_does_not_block_old_launch_after_restore(self):
        f = self.fixture()
        self.execute(f)
        original_write = worker.write_json
        calls = []
        def write(file, value):
            if Path(file) == f['home'] / 'installer/state.json':
                raise PermissionError('fixture state EPERM')
            return original_write(file, value)
        with patch.object(worker, 'write_json', side_effect=write), patch.object(worker, 'launch_old', side_effect=lambda ctx: calls.append(ctx)):
            worker.recover(f['job'], allow_legacy=True)
        self.assert_preserved(f)
        self.assertEqual(len(calls), 1)
        self.assertEqual(worker.read_json(f['job'] / 'recovery.json')['phase'], 'restored')
        worker.recover(f['job'], allow_legacy=True)
        self.assertEqual(len(calls), 1)


class OperationReplacementTests(unittest.TestCase):
    def bound_app_rollback(self, *, old_helper=False):
        f = self.fixture()
        f['plan']['parentCreationTime'] -= 100
        sequence_id, launcher_request, core_request = (str(uuid.uuid4()) for _ in range(3))
        root = f['home'] / 'installer'
        operation_id = f['plan']['operationId']
        operation = root / 'operations' / operation_id / 'operation.json'
        manifest = '{"version":"2.6.5"}'
        sha = hashlib.sha256(manifest.encode()).hexdigest()
        relative = f'release-plan/{sha}.json'
        artifact = operation.parent / relative
        artifact.parent.mkdir(parents=True)
        artifact.write_text(manifest)
        full_release = {**f['plan']['releasePlan'], 'releaseManifestText': manifest}
        f['plan']['releasePlan'].update(manifestSha256=sha, manifestRef={'schema': 'nora-operation-manifest/1',
            'operationId': operation_id, 'file': relative, 'size': len(manifest), 'sha256': sha})
        target = {'request': {'action': 'update', 'launcherOnly': True, 'sequenceId': sequence_id,
                              'expectedCoreVersion': '2.6.4'}, 'releasePlan': f['plan']['releasePlan']}
        digest = lambda value: hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        f['plan']['planDigest'] = digest(target)
        worker.write_json(f['job'] / 'plan.json', f['plan'])
        record = {'schema': 'nora-operation/1', 'kind': 'update', 'operationId': f['plan']['operationId'],
                  'ownerEpoch': 2, 'sequence': 8, 'state': 'awaiting-handoff', 'stageId': 'recovering',
                  'requestId': launcher_request, 'target': target, 'planDigest': f['plan']['planDigest'],
                  'handoffRef': str(f['job']), 'verification': 'unconfirmed', 'currentFailure': {'code': 'ORIGINAL'},
                  'primaryFailure': {'code': 'ORIGINAL'}, 'result': {'job': str(f['job'])}}
        worker.write_json(operation, record)
        pointer = root / 'current-update-sequence.json'
        request = root / 'update-sequences' / sequence_id / 'request.json'
        request.parent.mkdir(parents=True)
        reference = {'schema': 'nora-update-sequence/1', 'id': sequence_id}
        worker.write_json(pointer, reference)
        content = {**reference, 'order': ['launcher', 'core'],
                   'requests': {'launcher': launcher_request, 'core': core_request},
                   'before': {'launcher': f['plan']['previousVersion'], 'core': '2.6.4'},
                   'plan': full_release}
        worker.write_json(request, {**content, 'digest': digest(content)})
        if old_helper:
            with (f['job'] / 'replace.py').open('ab') as stream:
                stream.write(b'\n# Previously sealed helper bytes\n')
        worker.prepare(f['job']); f['owner'].execute(f)
        return f, operation, pointer, request, core_request

    def test_bound_app_rollback_settles_before_old_window_and_retires_only_legacy_pointer(self):
        f, operation, pointer, request, _ = self.bound_app_rollback()
        original_pointer, original_request = pointer.read_bytes(), request.read_bytes()

        def old_window(ctx):
            result = worker.read_json(operation)
            self.assertEqual((result['state'], result['effectState'], result['verification']),
                             ('rolled-back', 'restored', 'confirmed'))
            self.assertEqual(result['recoveryOutcome'], 'restored-and-verified')
            self.assertEqual(result['result']['launcherVersion'], f['plan']['previousVersion'])
            self.assertEqual(result['primaryFailure'], {'code': 'ORIGINAL'})
            self.assertIsNone(result['currentFailure'])
            self.assertFalse(pointer.exists())
            self.assertEqual(request.with_name(pointer.name).read_bytes(), original_pointer)
            self.assertEqual(request.read_bytes(), original_request)
            self.assertEqual((f['home'] / 'world.json').read_text(), 'user-world')
            with worker.writer_lock(ctx): pass

        with patch.object(worker, 'launch_old', side_effect=old_window) as launch:
            self.assertTrue(worker.recover(f['job'], app_revision=(2, 8))['restored'])
            committed = operation.read_bytes()
            self.assertTrue(worker.recover(f['job'], app_revision=(2, 8))['restored'])
        launch.assert_called_once()
        self.assertEqual(operation.read_bytes(), committed)
        self.assertEqual(worker.read_json(operation)['sequence'], 9)

    def test_bound_app_rollback_keeps_admitted_core_and_refuses_stale_revision(self):
        f, operation, pointer, request, core_request = self.bound_app_rollback()
        before = operation.read_bytes()
        with self.assertRaisesRegex(ValueError, '原操作记录'):
            worker.recover(f['job'], app_revision=(2, 7))
        self.assertEqual(operation.read_bytes(), before)
        core_job = pointer.parent / 'update-jobs' / str(uuid.uuid4()) / 'request.json'
        core_job.parent.mkdir(parents=True)
        worker.write_json(core_job, {'operationRequestId': core_request})
        with patch.object(worker, 'launch_old') as launch:
            self.assertTrue(worker.recover(f['job'], app_revision=(2, 8))['restored'])
        launch.assert_called_once()
        self.assertEqual(worker.read_json(operation)['state'], 'rolled-back')
        self.assertTrue(pointer.exists())
        self.assertFalse(request.with_name(pointer.name).exists())
        self.assertEqual(worker.read_json(core_job), {'operationRequestId': core_request})

    def test_bound_app_rollback_retries_after_terminal_record_before_generation(self):
        f, operation, pointer, request, _ = self.bound_app_rollback()
        generation = operation.parent.parent / '.history-generation.json'
        write = worker.write_json

        def cut(file, value):
            if file == generation and value['writing'] is False:
                raise OSError('injected after canonical record')
            write(file, value)

        with patch.object(worker, 'launch_old') as launch:
            with patch.object(worker, 'write_json', side_effect=cut):
                with self.assertRaisesRegex(OSError, 'injected after canonical record'):
                    worker.recover(f['job'], app_revision=(2, 8))
            launch.assert_not_called()
            self.assertTrue(worker.read_json(generation)['writing'])
            self.assertEqual(worker.read_json(f['job'] / 'recovery.json')['phase'], 'restored')
            self.assertTrue(pointer.exists())
            original = operation.read_bytes()
            self.assertTrue(worker.recover(f['job'], app_revision=(2, 8))['restored'])
        launch.assert_called_once()
        self.assertFalse(worker.read_json(generation)['writing'])
        self.assertEqual(operation.read_bytes(), original)
        self.assertTrue(request.with_name(pointer.name).exists())

    def test_rollback_entry_preserves_the_current_helper_and_revision_before_the_swap(self):
        f, operation, _, _, _ = self.bound_app_rollback(old_helper=True)
        job = f['job']
        entry = job / '恢复旧启动器.cmd'
        sealed = {name: (job / name).read_bytes() for name in ('plan.json', 'replace.py')}
        previous_entry = entry.read_bytes()
        with patch.object(worker, 'settle_app_rollback', side_effect=OSError('injected before canonical commit')):
            with self.assertRaisesRegex(OSError, 'injected before canonical commit'):
                worker.recover(job, app_revision=(2, 8))
        self.assertEqual(worker.read_json(job / 'recovery.json')['phase'], 'restored')
        self.assertEqual(worker.read_json(operation)['state'], 'awaiting-handoff')
        published = entry.read_bytes()
        self.assertNotEqual(published, previous_entry)
        self.assertIn(b'--settle-app-revision 2 8', published)
        helpers = list(job.glob('r-*.py'))
        self.assertEqual(len(helpers), 1)
        self.assertEqual(helpers[0].read_bytes(), SOURCE.read_bytes())
        self.assertIn(helpers[0].name.encode(), published)
        self.assertIn(worker.digest(helpers[0]).encode(), published)
        self.assertEqual({name: (job / name).read_bytes() for name in sealed}, sealed)
        rejected = subprocess.run([sys.executable, '-I', '-B', '-c', worker.ROLLBACK_BOOTSTRAP,
            str(helpers[0]), '0' * 64, '--recover', str(job), '--settle-app-revision', '2', '8'],
            capture_output=True, text=True, timeout=10)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn('Recovery helper digest mismatch', rejected.stderr)
        self.assertEqual(worker.read_json(operation)['state'], 'awaiting-handoff')
        with patch.object(worker, 'launch_old') as launch:
            worker.recover(job, app_revision=(2, 8))
        launch.assert_called_once()
        self.assertEqual(worker.read_json(operation)['state'], 'rolled-back')
        self.assertEqual(entry.read_bytes(), published)

    def test_bound_app_rollback_keeps_legacy_pointer_for_unknown_other_records(self):
        for kind in ('operation', 'submission'):
            with self.subTest(kind=kind):
                f, operation, pointer, request, _ = self.bound_app_rollback()
                other_id = str(uuid.uuid4())
                if kind == 'operation':
                    unknown = pointer.parent / 'operations' / other_id / 'operation.json'
                    contents = {'schema': 'nora-operation/1', 'operationId': other_id}
                else:
                    unknown = pointer.parent / 'update-jobs' / other_id / 'request.json'
                    contents = {}
                unknown.parent.mkdir(parents=True)
                worker.write_json(unknown, contents)
                with patch.object(worker, 'launch_old'):
                    worker.recover(f['job'], app_revision=(2, 8))
                self.assertTrue(pointer.exists())
                self.assertFalse(request.with_name(pointer.name).exists())
                self.assertEqual(worker.read_json(unknown), contents)

    def test_bound_app_rollback_keeps_closed_guard_ledgers_and_refuses_unknown_executors(self):
        f, operation, _, _, _ = self.bound_app_rollback()
        ledger = operation.parent.parent / '.guards' / 'original.json'
        ledger.parent.mkdir()
        worker.write_json(ledger, {'schema': 'nora-operation-guard/1', 'jobs': [{'jobId': 'unknown'}]})
        original = operation.read_bytes()
        with self.assertRaisesRegex(ValueError, '原执行者尚未确认退出'):
            worker.recover(f['job'], app_revision=(2, 8))
        self.assertEqual(operation.read_bytes(), original)
        worker.write_json(ledger, {'schema': 'nora-operation-guard/1', 'jobs': []})
        saved = ledger.read_bytes()
        with patch.object(worker, 'launch_old'):
            worker.recover(f['job'], app_revision=(2, 8))
        self.assertEqual(ledger.read_bytes(), saved)
        self.assertEqual(worker.read_json(operation)['state'], 'rolled-back')

    def test_legacy_full_tree_cancel_retains_sealed_program_and_denied_empty_runtime_lock(self):
        f = self.fixture()
        locked = worker.io_path(f['app'] / '.sentry-native/run.lock')
        locked.parent.mkdir(); locked.touch()
        worker.prepare(f['job'])
        snapshot = worker.read_json(f['job'] / 'recovery.json')
        self.assertNotIn('.sentry-native/run.lock', snapshot['old']['programPaths'])
        # Recreate a previously shipped whole-tree snapshot without changing its contract.
        snapshot['old'].pop('programPaths')
        snapshot['old']['digest'] = worker.tree_digest(f['app'], 'win32')
        worker.write_json(f['job'] / 'recovery.json', snapshot)
        sealed = {name: (f['job'] / name).read_bytes() for name in ('replace.py', 'plan.json')}
        original_open = Path.open

        def deny_read(file, *args, **options):
            if file == locked:
                error = PermissionError(13, 'controlled legacy Sentry deny-read')
                error.winerror = 33
                raise error
            return original_open(file, *args, **options)

        with patch.object(Path, 'open', deny_read):
            result = worker.recover(f['job'])
        self.assertTrue(result['untouched'])
        self.assertEqual(worker.read_json(f['job'] / 'recovery.json')['old'], snapshot['old'])
        self.assertEqual({name: (f['job'] / name).read_bytes() for name in sealed}, sealed)
        self.assertEqual((f['app'] / 'launcher.exe').read_text(), 'old')
        self.assertEqual(locked.stat().st_size, 0)

    def test_uninstall_pending_launcher_reports_phase_effects_and_reason(self):
        import io
        from contextlib import redirect_stdout
        f=self.fixture();worker.prepare(f['job'])
        source=(SOURCE.parent/'uninstall.js').read_text(encoding='utf-8')
        body=source.split('const PYTHON_TRANSACTION_FACTS=String.raw`',1)[1].split('`;',1)[0]
        args={'root':str(f['home']),'hermesHome':str(f['home']/'hermes'),'installRoot':str(f['home']/'tavern'),
              'system':False,'systemHistory':False,'first':[],'legacy':None,'appJobs':[str(f['job'])],
              'requiredHandoffs':[],'executable':str(f['app']/'launcher.exe'),
              'resources':{name:{'path':str((SOURCE.parent if name=='replace-launcher.py' else SOURCE.parents[1])/name)}
                           for name in ('replace-launcher.py','update_recovery.py','first_install.py')}}
        def inspect():
            with patch.object(sys,'stdin',io.StringIO(json.dumps(args))),redirect_stdout(io.StringIO()):
                exec(compile(body,'uninstall-readonly-inspector','exec'),{'__name__':'uninstall_fixture'})
        snapshot=worker.read_json(f['job']/'recovery.json')
        with self.assertRaises(RuntimeError) as prepared:inspect()
        self.assertIn('phase=prepared',str(prepared.exception));self.assertIn('effect=untouched',str(prepared.exception))
        self.assertIn('job=job-test',str(prepared.exception))
        damaged=json.loads(json.dumps(snapshot));damaged['old']['digest']='invalid'
        worker.write_json(f['job']/'recovery.json',damaged)
        with self.assertRaises(RuntimeError) as invalid:inspect()
        self.assertIn('effect=unknown',str(invalid.exception));self.assertIn('恢复计划缺少原程序快照',str(invalid.exception))
        worker.write_json(f['job']/'recovery.json',snapshot);worker.recover(f['job']);inspect()
        self.assertEqual((f['app']/'launcher.exe').read_text(),'old')
        self.assertEqual((f['home']/'world.json').read_text(),'user-world')

    def fixture(self):
        owner = DurableReplacementTests('test_real_ack_retains_backup_until_verified_combined_commit')
        f = owner.fixture()
        self.addCleanup(owner.cleanup_fixture, f)
        import psutil
        plan = f['plan']
        plan.update(schema=2, operationId=str(uuid.uuid4()), ownerEpoch=1, planDigest='a' * 64,
            parentPid=os.getpid(), parentCreationTime=psutil.Process().create_time(),
            executorProtocol='nora-operation-executor/1',
            releasePlan={'schema': 'nora-release-plan/1', 'planId': 'fixture', 'target': 'v2.4.2'},
            rollbackCompatibility={'operationSchema': 'nora-operation/1', 'executorProtocol': 'nora-operation-executor/1',
                'telemetrySchema': 3, 'faultSchema': 2, 'compatible': True})
        worker.write_json(f['job'] / 'plan.json', plan)
        for name in ('operation_control.py', 'operation_evidence.py', 'error_diagnostics.py', 'operation-budget.json'):
            shutil.copy2(SOURCE.parents[1] / name, f['job'] / name)
        f['owner'] = owner
        launcher = f['launcher'].read_text()
        launcher = launcher.replace("ready={'token':plan['token'],'version':plan['version']}",
            "ready={'schema':'nora-launcher-handoff/1','token':plan['token'],'version':plan['version'],'operationId':plan['operationId'],'planDigest':plan['planDigest']}")
        f['launcher'].write_text(launcher)
        return f

    def test_prepare_and_recovery_bind_the_packaged_helper_without_hermes(self):
        for short in (False, True):
            with self.subTest(short=short):
                self.packaged_helper_recovery(short=short)

    def packaged_helper_recovery(self, *, short):
        f = self.fixture()
        shutil.rmtree(worker.io_path(f['home'] / 'hermes'))
        image_id = '1' * 64
        base = f['home'] / 'installer/app-helper-runtime'
        image = base / (image_id[:20] if short else image_id)
        executable = 'python/python.exe'
        files = []
        for relative, contents in [(executable, b'APP interpreter fixture'), ('python/psutil.py', b'APP psutil fixture')]:
            file = worker.io_path(image / relative)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(contents)
            files.append({'path': relative, 'type': 'file', 'size': len(contents), 'sha256': worker.digest(file)})
        descriptor_file = base / f'{image_id}.json'
        worker.write_json(descriptor_file, {'schema': 'nora-app-helper-runtime/1', 'imageSha256': image_id,
            'platform': 'win32', 'arch': 'x64', 'root': 'app-helper-runtime', 'pythonRoot': 'python',
            'executable': executable, 'files': files})
        f['plan']['helperRuntime'] = {'schema': 'nora-app-helper-runtime-ref/1', 'imageSha256': image_id,
            'descriptorSha256': worker.digest(descriptor_file), 'root': str(image), 'executable': executable}
        worker.write_json(f['job'] / 'plan.json', f['plan'])
        self.assertTrue(worker.prepare(f['job'])['prepared'])
        receipt = worker.read_json(f['job'] / 'recovery.json')
        self.assertEqual(receipt['helperRuntime'], f['plan']['helperRuntime'])
        script = worker.io_path(f['job'] / '恢复旧启动器.cmd').read_text()
        self.assertIn(f'app-helper-runtime\\{image.name}\\python\\python.exe', script)
        self.assertIn(' -I -B ', script)
        self.assertIn('WindowsPowerShell\\v1.0\\powershell.exe', script)
        self.assertIn('[IO.Path]::GetFullPath($env:NORA_APP_RECOVERY_PYTHON)', script)
        self.assertIn("($env:NORA_APP_RECOVERY_JOB+'replace.py') --recover", script)
        self.assertNotIn(str(f['home']), script)
        worker.io_path(image / executable).write_bytes(b'replaced APP interpreter')
        with self.assertRaisesRegex(ValueError, 'APP助手文件已变化'):
            worker.recover(f['job'])
        self.assertEqual(worker.read_json(f['job'] / 'recovery.json')['phase'], 'recovery-failed')
        self.assertEqual(worker.io_path(f['app'] / 'launcher.exe').read_text(), 'old')
        self.assertEqual(worker.io_path(f['home'] / 'world.json').read_text(), 'user-world')

    @unittest.skipUnless(os.name == 'nt', 'Requires the native Windows current-directory handle')
    def test_real_windows_directory_lock_ends_untouched_and_reopens_original(self):
        f = self.fixture(); f['plan']['parentCreationTime'] -= 100
        worker.write_json(f['job'] / 'plan.json', f['plan']); worker.prepare(f['job'])
        # The test process owns this directory as its cwd; the independent
        # replacement worker must encounter a real WinError32 when moving it.
        # A plain directory read handle permits rename on current Windows.
        previous = os.getcwd(); os.chdir(f['app'])
        try:
            result = f['owner'].execute(f, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('WinError 32', result.stderr)
            snapshot = worker.read_json(f['job'] / 'recovery.json')
            self.assertEqual(snapshot['phase'], 'cancelled')
            self.assertTrue(snapshot['launchAttempted'])
            self.assertEqual([item['kind'] for item in f['owner'].children(f)], ['old'])
            outcome = worker.inspect_outcome(f['job'])
            self.assertEqual(outcome['effectState'], 'untouched')
            self.assertTrue(outcome['workerOffline'])
            self.assertIn('32', json.dumps(outcome['diagnosticError']))
        finally:
            os.chdir(previous)
        f['owner'].assert_preserved(f)
        # Once the controlled handle is released the same original directory
        # must be movable; no system setting or user data cleanup is required.
        moved = f['app'].with_name('after-busy-check')
        worker.retry_rename(f['app'], moved); worker.retry_rename(moved, f['app'])

    def test_cleanup_refuses_returned_spawn_without_exact_birth_ack(self):
        f = self.fixture()
        pending = f['job'] / 'spawns.jsonl'
        pending.write_text(json.dumps({'spawnId': str(uuid.uuid4()), 'kind': 'old'}) + '\n')
        try:
            with patch.object(shutil, 'rmtree') as remove:
                with self.assertRaisesRegex(RuntimeError, 'unconfirmed children'):
                    f['owner'].cleanup_fixture(f)
                remove.assert_not_called()
            self.assertTrue(f['base'].is_dir())
        finally:
            # This obligation is synthetic: no process was created by this pure
            # negative case. Remove it only after proving guarded retention.
            pending.unlink()

    def test_cleanup_retains_malformed_birth_ack_and_unknown_live_command(self):
        import psutil
        current = psutil.Process()
        for mutation in ('duplicate', 'wrong-kind', 'invalid-birth', 'unknown-command'):
            with self.subTest(mutation=mutation):
                f = self.fixture()
                token = str(uuid.uuid4())
                pending = f['job'] / 'spawns.jsonl'
                births = f['job'] / 'children.jsonl'
                pending.write_text(json.dumps({'spawnId': token, 'kind': 'old'}) + '\n')
                record = {'spawnId': token, 'kind': 'old', 'pid': current.pid,
                          'creationTime': current.create_time(), 'executable': current.exe()}
                if mutation == 'wrong-kind': record['kind'] = 'new'
                if mutation == 'invalid-birth': record['creationTime'] = float('nan')
                records = [record, record] if mutation == 'duplicate' else [record]
                births.write_text(''.join(json.dumps(item) + '\n' for item in records))
                try:
                    with patch.object(shutil, 'rmtree') as remove, patch.object(psutil.Process, 'wait') as wait:
                        with self.assertRaisesRegex(RuntimeError, 'unconfirmed children'):
                            f['owner'].cleanup_fixture(f)
                        remove.assert_not_called()
                        wait.assert_not_called()
                    self.assertTrue(f['base'].is_dir())
                finally:
                    # These rows are pure fault inputs; no child was launched.
                    pending.unlink()
                    births.unlink()

    def test_cleanup_never_waits_or_stops_a_reused_pid(self):
        import psutil
        current = psutil.Process()
        f = self.fixture()
        token = str(uuid.uuid4())
        pending = f['job'] / 'spawns.jsonl'
        births = f['job'] / 'children.jsonl'
        pending.write_text(json.dumps({'spawnId': token, 'kind': 'old'}) + '\n')
        births.write_text(json.dumps({'spawnId': token, 'kind': 'old', 'pid': current.pid,
            'creationTime': current.create_time() - 100, 'executable': current.exe()}) + '\n')
        try:
            with patch.object(shutil, 'rmtree') as remove, patch.object(psutil.Process, 'wait') as wait:
                f['owner'].cleanup_fixture(f)
                wait.assert_not_called()
                remove.assert_called_once_with(f['base'])
            self.assertTrue(current.is_running())
        finally:
            pending.unlink()
            births.unlink()

    def test_preparation_only_seals_current_operation_without_waiting_or_replacing(self):
        f = self.fixture()
        with patch.object(worker, 'parent_alive', side_effect=AssertionError('prepare must not wait')), \
                patch.object(worker.subprocess, 'Popen', side_effect=AssertionError('prepare must not launch')):
            result = worker.prepare(f['job'])
        self.assertTrue(result['prepared']); self.assertEqual(result['job'], str(f['job']))
        self.assertEqual((f['app'] / 'launcher.exe').read_text(), 'old')
        snapshot = worker.read_json(f['job'] / 'recovery.json')
        for key in ('operationId', 'ownerEpoch', 'planDigest', 'releasePlan', 'parentCreationTime', 'executorProtocol'):
            self.assertEqual(snapshot[key], f['plan'][key])
        self.assertTrue(worker.exists(worker.context(f['job'])['stage']))
        (f['job'] / 'replace.lock').unlink()
        before = {path.relative_to(f['job']): path.read_bytes() for path in f['job'].rglob('*') if path.is_file()}
        state = worker.assess(f['job'])
        after = {path.relative_to(f['job']): path.read_bytes() for path in f['job'].rglob('*') if path.is_file()}
        self.assertEqual(before, after); self.assertFalse(state['busy']); self.assertTrue(state['untouched'])

    def test_operation_ack_is_bound_and_worker_is_not_offline_until_actual_instance_exits(self):
        f = self.fixture(); worker.prepare(f['job']); seen = []
        class Child:
            def poll(self): return None
        def launch(args, **options):
            state = worker.read_json(f['job'] / 'recovery.json')
            seen.append(state)
            worker.write_json(f['job'] / 'ready.json', {'schema': 'nora-launcher-handoff/1',
                'token': f['plan']['token'], 'version': f['plan']['version'],
                'operationId': f['plan']['operationId'], 'planDigest': f['plan']['planDigest']})
            return Child()
        with patch.object(worker, 'parent_alive', return_value=False), patch.object(worker.subprocess, 'Popen', side_effect=launch):
            worker.run(f['job'])
        self.assertEqual(seen[0]['workerPid'], os.getpid())
        self.assertGreater(seen[0]['workerCreationTime'], 0)
        state = worker.assess(f['job']); self.assertFalse(state['workerOffline']); self.assertFalse(state['busy'])
        with self.assertRaisesRegex(ValueError, '尚未退出'):
            worker.finalize(f['job'], target=f['plan']['target'], version=f['plan']['version'], verified=True)
        self.assertTrue(worker.exists(worker.context(f['job'])['backup']))
        snapshot = worker.read_json(f['job'] / 'recovery.json'); snapshot['workerCreationTime'] -= 100
        worker.write_json(f['job'] / 'recovery.json', snapshot)
        self.assertTrue(worker.assess(f['job'])['workerOffline'])

    def test_pre_swap_failure_records_cause_reopens_original_and_proves_untouched_only_after_worker_exit(self):
        f = self.fixture(); worker.prepare(f['job'])
        original = PermissionError(13, 'original directory sharing violation')
        with patch.object(worker, 'parent_alive', return_value=False), \
                patch.object(worker, 'retry_rename', side_effect=original), \
                patch.object(worker, 'launch_old') as launch:
            with self.assertRaises(PermissionError) as raised:
                worker.run(f['job'])
            self.assertIs(raised.exception, original)
            launch.assert_called_once()
        snapshot = worker.read_json(f['job'] / 'recovery.json')
        self.assertEqual(snapshot['phase'], 'cancelled')
        self.assertIn('original directory sharing violation', json.dumps(snapshot.get('diagnosticError')))
        self.assertIsNone(worker.inspect_outcome(f['job']), 'a live worker must never grant terminalization')
        with patch.object(worker, 'parent_alive', return_value=False):
            outcome = worker.inspect_outcome(f['job'])
        self.assertEqual(outcome['status'], 'cancelled')
        self.assertEqual(outcome['effectState'], 'untouched')
        self.assertTrue(outcome['workerOffline'])
        self.assertEqual(outcome['operationId'], f['plan']['operationId'])
        (f['app'] / 'launcher.exe').write_text('tampered')
        with patch.object(worker, 'parent_alive', return_value=False), self.assertRaises(ValueError):
            worker.inspect_outcome(f['job'])

    def test_prepared_or_moving_old_unchanged_original_can_cancel_without_relaunch(self):
        for phase in ('prepared', 'waiting-parent', 'moving-old'):
            with self.subTest(phase=phase):
                f = self.fixture(); worker.prepare(f['job'])
                snapshot = worker.read_json(f['job'] / 'recovery.json')
                worker.checkpoint(worker.context(f['job']), snapshot, phase)
                with patch.object(worker, 'launch_old', side_effect=AssertionError('untouched must not relaunch')):
                    result = worker.recover(f['job'])
                self.assertTrue(result['untouched']); self.assertFalse(result['restarting'])
                self.assertEqual(worker.read_json(f['job'] / 'recovery.json')['phase'], 'cancelled')
                self.assertEqual((f['app'] / 'launcher.exe').read_text(), 'old')

    def test_cancelled_outcome_rejects_missing_worker_foreign_status_and_failed_tree(self):
        for mutation in ('worker-pid', 'worker-birth', 'status-operation', 'status-plan', 'status-worker', 'failed-tree'):
            with self.subTest(mutation=mutation):
                f = self.fixture(); worker.prepare(f['job']); worker.recover(f['job'])
                snapshot = worker.read_json(f['job'] / 'recovery.json')
                status = worker.read_json(f['job'] / 'status.json')
                if mutation == 'worker-pid': snapshot.pop('workerPid')
                if mutation == 'worker-birth': snapshot['workerCreationTime'] = float('nan')
                if mutation == 'status-operation': status['operationId'] = str(uuid.uuid4())
                if mutation == 'status-plan': status['planDigest'] = 'b' * 64
                if mutation == 'status-worker': status['workerCreationTime'] -= 1
                if mutation == 'failed-tree':
                    worker.io_path(worker.context(f['job'])['failed']).mkdir()
                    # Unknown failed trees must remain untouched, even if the
                    # original application itself still has its exact digest.
                    with self.assertRaises(ValueError): worker.inspect_outcome(f['job'])
                    continue
                worker.write_json(f['job'] / 'recovery.json', snapshot)
                worker.write_json(f['job'] / 'status.json', status)
                with patch.object(worker, 'parent_alive', return_value=False):
                    self.assertIsNone(worker.inspect_outcome(f['job']))

    def test_plan_and_snapshot_binding_reject_unknown_compatibility_and_tampering(self):
        f = self.fixture(); f['plan']['rollbackCompatibility']['compatible'] = False
        worker.write_json(f['job'] / 'plan.json', f['plan'])
        with self.assertRaises(ValueError): worker.prepare(f['job'])
        self.assertFalse((f['job'] / 'recovery.json').exists())
        f['plan']['rollbackCompatibility']['compatible'] = True
        worker.write_json(f['job'] / 'plan.json', f['plan']); worker.prepare(f['job'])
        before = (f['job'] / 'recovery.json').read_bytes(); f['plan']['planDigest'] = 'b' * 64
        worker.write_json(f['job'] / 'plan.json', f['plan'])
        with self.assertRaises(ValueError): worker.run(f['job'])
        self.assertEqual((f['job'] / 'recovery.json').read_bytes(), before)
        self.assertEqual((f['app'] / 'launcher.exe').read_text(), 'old')

    def test_native_writer_lock_blocks_independent_mutation_and_gate_preparation_does_not_relock(self):
        f = self.fixture()
        with worker.writer_lock(worker.context(f['job'])):
            result = subprocess.run([sys.executable, '-B', str(SOURCE), '--prepare', str(f['job'])],
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((f['job'] / 'recovery.json').exists())
            gate = SimpleNamespace(assert_active=lambda: None)
            with patch.object(sys, '_nora_operation_delegate', gate, create=True):
                self.assertTrue(worker.prepare(f['job'])['prepared'])

    def test_parent_instance_and_own_unknown_executable_cannot_be_assumed_offline(self):
        import psutil
        self.assertFalse(worker.parent_alive(os.getpid(), psutil.Process().create_time() - 100))
        self.assertEqual(worker.process_identity(os.getpid())['creationTime'], psutil.Process().create_time())
        f = self.fixture()
        from unittest.mock import Mock
        process = Mock(); process.pid = os.getpid(); process.exe.side_effect = psutil.AccessDenied(process.pid)
        process.username.return_value = psutil.Process().username()
        with patch.object(psutil, 'process_iter', return_value=[process]):
            with self.assertRaises(RuntimeError): worker.require_launcher_offline(worker.context(f['job']), {})

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin Crashpad uses a separate orphan executable')
    def test_mac_recovery_retires_only_the_verified_old_orphan_crash_reporter(self):
        import itertools
        import psutil
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            home, app, backup = (root / name for name in ('home', 'current.app', '.nora-previous-app'))
            framework = backup / 'Contents/Frameworks/Electron Framework.framework'
            executable = framework / 'Versions/A/Helpers/chrome_crashpad_handler'
            executable.parent.mkdir(parents=True); executable.touch()
            (framework / 'Helpers').symlink_to('Versions/A/Helpers')
            database = home / 'launcher/diagnostics/native-crashes'
            database.mkdir(parents=True)
            ctx = {'home': home, 'app': app, 'backup': backup,
                   'plan': {'platform': 'darwin', 'schema': 2, 'parentCreationTime': 100}}
            snapshot = {'old': {'identity': worker.file_identity(backup), 'version': '2.2.8'},
                        'workerCreationTime': 120}
            reporter_args = [str(app / executable.relative_to(backup)),
                             '--monitor-self-annotation=ptype=crashpad-handler',
                             '--annotation=_productName=Nora Tavern Launcher', '--annotation=prod=Electron',
                             '--annotation=_version=2.2.8', f'--database={database}']
            for scenario in ('owned', 'other-profile', 'different-owner', 'active-parent',
                             'another-app-actor', 'reused-pid', 'survivor'):
                with self.subTest(scenario=scenario):
                    reporter = Mock(pid=42)
                    reporter.exe.return_value = str(executable)
                    reporter.ppid.return_value = 2 if scenario == 'active-parent' else 1
                    reporter.create_time.return_value = 110
                    uid = os.getuid() + (1 if scenario == 'different-owner' else 0)
                    reporter.uids.return_value = SimpleNamespace(real=uid, effective=uid)
                    reporter.cmdline.return_value = [*reporter_args[:-1], (
                        '--database=/other/profile' if scenario == 'other-profile' else reporter_args[-1])]
                    service = Mock(pid=43)
                    service.exe.return_value = str(home / 'hermes/node')
                    actors = [reporter, service]
                    if scenario == 'another-app-actor':
                        main = Mock(pid=44)
                        main.exe.return_value = str(app / 'Contents/MacOS/Launcher')
                        actors.append(main)
                    candidate = reporter
                    if scenario == 'reused-pid':
                        candidate = Mock(pid=42)
                        candidate.create_time.return_value = 130
                    if scenario == 'owned':
                        reporter.terminate.side_effect = lambda: actors.remove(reporter)
                    current_user = psutil.Process()
                    with patch.object(psutil, 'process_iter', side_effect=lambda: list(actors)), \
                            patch.object(psutil, 'Process', side_effect=lambda pid=None: current_user if pid is None else candidate), \
                            patch.object(worker.time, 'monotonic', side_effect=itertools.count(0, 2).__next__), \
                            patch.object(worker.time, 'sleep'):
                        if scenario == 'owned':
                            worker.require_launcher_offline(ctx, snapshot)
                        else:
                            with self.assertRaisesRegex(RuntimeError, '启动器仍在运行'):
                                worker.require_launcher_offline(ctx, snapshot)
                    if scenario in ('owned', 'survivor'):
                        reporter.terminate.assert_called_once_with()
                    else:
                        reporter.terminate.assert_not_called()
                        candidate.terminate.assert_not_called()
                    service.terminate.assert_not_called()

    def test_recovery_waits_for_remaining_launcher_process_before_restoring_without_rewriting_history(self):
        import psutil
        from unittest.mock import Mock
        f = self.fixture(); f['plan']['parentCreationTime'] -= 100
        worker.write_json(f['job'] / 'plan.json', f['plan'])
        worker.prepare(f['job']); f['owner'].execute(f)
        ctx = worker.context(f['job'])
        protected = {'world.json': b'user-world', 'chat.jsonl': b'chat-fixture',
                     'character.json': b'character-fixture', 'config.yaml': b'model: fixture-model\n'}
        for name, data in protected.items(): (f['home'] / name).write_bytes(data)
        sealed = {name: (f['job'] / name).read_bytes() for name in ('plan.json', 'replace.py')}
        reporter = Mock(); reporter.exe.return_value = str(ctx['app'] / 'chrome_crashpad_handler')
        with patch.object(psutil, 'process_iter', side_effect=[[reporter], []]), \
                patch.object(worker.time, 'sleep') as pause, patch.object(worker, 'launch_old') as launch:
            self.assertTrue(worker.recover(f['job'])['restored'])
        pause.assert_called(); launch.assert_called_once()
        f['owner'].assert_preserved(f)
        self.assertEqual(worker.read_json(f['job'] / 'recovery.json')['phase'], 'restored')
        for name, data in protected.items(): self.assertEqual((f['home'] / name).read_bytes(), data)
        for name, data in sealed.items(): self.assertEqual((f['job'] / name).read_bytes(), data)

    def test_recovery_keeps_programs_and_data_when_launcher_process_does_not_exit_before_deadline(self):
        import itertools
        import psutil
        from unittest.mock import Mock
        f = self.fixture(); f['plan']['parentCreationTime'] -= 100
        worker.write_json(f['job'] / 'plan.json', f['plan'])
        worker.prepare(f['job']); f['owner'].execute(f); ctx = worker.context(f['job'])
        before = {name: worker.file_identity(ctx[name]) for name in ('app', 'backup')}
        reporter = Mock(); reporter.exe.return_value = str(ctx['app'] / 'chrome_crashpad_handler')
        with patch.object(psutil, 'process_iter', return_value=[reporter]), \
                patch.object(worker.time, 'monotonic', side_effect=itertools.count(0, 31).__next__), \
                patch.object(worker.time, 'sleep'), patch.object(worker, 'launch_old') as launch:
            with self.assertRaisesRegex(RuntimeError, '启动器仍在运行'):
                worker.recover(f['job'])
        launch.assert_not_called()
        self.assertEqual({name: worker.file_identity(ctx[name]) for name in before}, before)
        self.assertEqual((f['home'] / 'world.json').read_text(), 'user-world')

    def test_real_worker_holds_both_locks_and_waits_for_exact_parent_instance(self):
        import time
        f = self.fixture(); worker.prepare(f['job'])
        # Match managed-python.js: Windows venv launchers redirect to a second
        # process, so a handle for that launcher cannot own the actual writer.
        executable = sys._base_executable if os.name == 'nt' else sys.executable
        environment = dict(os.environ)
        if os.name == 'nt': environment['__PYVENV_LAUNCHER__'] = sys.executable
        child = subprocess.Popen([executable, '-B', str(f['runner']), str(SOURCE), str(f['job']),
            'run', '', 'ok', str(f['launcher'])], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        f['held_children'].append(child)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                status = worker.read_json(f['job'] / 'status.json')
                if status.get('status') == 'waiting-parent': break
                time.sleep(.01)
            self.assertEqual(status['status'], 'waiting-parent', str(status)); self.assertEqual(status['workerPid'], child.pid)
            self.assertGreater(status['workerCreationTime'], 0)
            state = worker.assess(f['job']); self.assertTrue(state['busy']); self.assertFalse(state['workerOffline'])
            self.assertEqual((f['app'] / 'launcher.exe').read_text(), 'old')
            with self.assertRaises(RuntimeError): worker.prepare_recovery(f['job'], parent_pid=os.getpid(), parent_creation_time=f['plan']['parentCreationTime'])
        finally:
            close_fixture_child(child)
        state = worker.assess(f['job']); self.assertFalse(state['busy']); self.assertTrue(state['workerOffline'])
        self.assertTrue(worker.recover(f['job'])['untouched'])

    def test_real_schema_two_hard_exit_at_each_rename_restores_and_freezes_same_operation(self):
        for edge in ('moving-old', 'installing-new', 'moving-failed', 'restoring-old'):
            with self.subTest(edge=edge):
                f = self.fixture(); f['plan']['parentCreationTime'] -= 100
                worker.write_json(f['job'] / 'plan.json', f['plan']); worker.prepare(f['job'])
                owner = f['owner']
                if edge in ('moving-old', 'installing-new'):
                    result = owner.execute(f, edge=edge, check=False)
                else:
                    owner.execute(f); result = owner.execute(f, 'recover', edge=edge, check=False)
                self.assertEqual(result.returncode, 91, result.stdout + result.stderr)
                self.assertTrue(worker.assess(f['job'])['canRecover'])
                owner.execute(f, 'recover'); owner.assert_preserved(f)
                owner.execute(f, 'recover')
                self.assertEqual(worker.read_json(f['job'] / 'recovery.json')['phase'], 'restored')

    def test_first_failure_is_frozen_before_restore_and_restoration_cannot_replace_it(self):
        f = self.fixture(); worker.prepare(f['job']); first = RuntimeError('first actual launcher fault')
        rollback = PermissionError(13, 'fixture restore denied')
        class Child:
            polls = 0
            def poll(self):
                self.polls += 1
                if self.polls == 1: raise first
                return 1
        with patch.object(worker, 'parent_alive', return_value=False), patch.object(worker.subprocess, 'Popen', return_value=Child()), \
                patch.object(worker, 'restore', side_effect=rollback):
            with self.assertRaises(RuntimeError) as raised: worker.run(f['job'])
        self.assertIs(raised.exception, first)
        record = worker.read_json(f['home'] / 'installer/operations' / f['plan']['operationId'] / 'evidence/python.json')
        self.assertEqual(record['primary']['message'], str(first)); self.assertIn('replace', record['primary']['stack'])
        self.assertTrue(any(item['error']['name'] == 'PermissionError' for item in record.get('secondaryErrors', [])))
        self.assertEqual(worker.read_json(f['job'] / 'recovery.json')['phase'], 'recovery-failed')

    def test_auto_rollback_keeps_verified_old_app_when_automatic_reopen_fails(self):
        f = self.fixture(); f['plan']['releasePlan']['client'] = 'app'
        worker.write_json(f['job'] / 'plan.json', f['plan']); worker.prepare(f['job'])
        with patch.object(worker, 'parent_alive', return_value=False), \
                patch.object(worker, 'require_launcher_offline'), \
                patch.object(worker.subprocess, 'Popen', return_value=SimpleNamespace(poll=lambda: 1)), \
                patch.object(worker, 'launch_old', side_effect=OSError('old executable launch failed')):
            with self.assertRaisesRegex(RuntimeError, '新版启动器提前退出'):
                worker.run(f['job'])
            outcome = worker.read_outcome(f['job'])
        self.assertEqual((f['app'] / 'launcher.exe').read_text(), 'old')
        self.assertEqual(outcome['kind'], 'terminal')
        self.assertEqual(outcome['outcome']['status'], 'restored')
        self.assertTrue(outcome['outcome']['relaunchFailed'])
        self.assertEqual(outcome['outcome']['version'], f['plan']['previousVersion'])
        self.assertIn('新版启动器提前退出', outcome['outcome']['diagnosticError']['message'])

    def test_retry_proof_is_only_for_supported_native_errors_before_first_move(self):
        cases = ((32, False, True), (33, False, True), (5, False, True), (5, False, False),
                 (33, True, True), (5, True, True))
        for winerror, after_move, bound in cases:
            with self.subTest(winerror=winerror, after_move=after_move, bound=bound):
                f = self.fixture(); f['plan']['releasePlan']['client'] = 'app'
                worker.write_json(f['job'] / 'plan.json', f['plan']); worker.prepare(f['job'])
                context = worker.context(f['job'])
                original_rename = worker.retry_rename
                error = PermissionError(13, 'native sharing fixture'); error.winerror = winerror

                def rename(source, target):
                    if target == (context['app'] if after_move else context['backup']) and source != context['backup']:
                        if bound:
                            error.filename, error.filename2 = str(worker.io_path(source)), str(worker.io_path(target))
                        raise error
                    original_rename(source, target)

                with patch.object(worker, 'parent_alive', return_value=False), \
                        patch.object(worker, 'require_launcher_offline'), patch.object(worker, 'launch_old'), \
                        patch.object(worker, 'retry_rename', side_effect=rename):
                    with self.assertRaises(PermissionError): worker.run(f['job'])
                    outcome = worker.read_outcome(f['job'])['outcome']
                if not after_move and bound:
                    schema = 'nora-app-move-denied/1' if winerror == 5 else 'nora-app-sharing-failure/1'
                    self.assertEqual(outcome['sharingFailure'], {'schema': schema,
                        'phase': 'moving-old', 'winerror': winerror})
                else:
                    self.assertNotIn('sharingFailure', outcome)
                self.assertEqual((f['app'] / 'launcher.exe').read_text(), 'old')

    def test_detached_diagnostics_consume_saved_proof_without_rehashing_or_unlocking_legacy_records(self):
        f = self.fixture(); worker.prepare(f['job'])
        with patch.object(worker, 'parent_alive', return_value=False), patch.object(worker, 'launch_old'), \
                patch.object(worker, 'retry_rename', side_effect=PermissionError(13, 'controlled replacement denied')):
            with self.assertRaises(PermissionError): worker.run(f['job'])
        with patch.object(worker, 'parent_alive', return_value=False), \
                patch.object(worker, 'tree_digest', side_effect=AssertionError('diagnostic read must not hash program trees')):
            observed = worker.inspect_diagnostics(f['job'])
            self.assertEqual(observed['verification'], 'confirmed')
            self.assertEqual(observed['failurePhase'], 'moving-old')
            snapshot = worker.read_json(f['job'] / 'recovery.json')
            snapshot.pop('diagnosticVerification')
            worker.write_json(f['job'] / 'recovery.json', snapshot)
            observed = worker.inspect_diagnostics(f['job'])
            self.assertEqual(observed['verification'], 'unconfirmed')
            self.assertEqual(observed['effectState'], 'unknown')
            self.assertIn('controlled replacement denied', observed['diagnosticError']['message'])

    def test_evidence_budget_is_sealed_before_replacement_and_tampering_preserves_application(self):
        f = self.fixture(); worker.prepare(f['job'])
        snapshot = worker.read_json(f['job'] / 'recovery.json')
        budget = f['job'] / 'operation-budget.json'
        self.assertEqual(snapshot['resourceDigests']['operation-budget.json'], worker.digest(budget))
        budget.write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '执行资源已变化'):
            worker.run(f['job'])
        self.assertEqual((f['app'] / 'launcher.exe').read_text(), 'old')
        self.assertFalse(worker.exists(worker.context(f['job'])['backup']))

    def test_schema_one_changed_program_has_no_implicit_cross_protocol_rollback(self):
        owner = DurableReplacementTests('test_real_ack_retains_backup_until_verified_combined_commit')
        f = owner.fixture(); self.addCleanup(owner.cleanup_fixture, f); owner.execute(f)
        before = (f['job'] / 'recovery.json').read_bytes()
        with self.assertRaisesRegex(ValueError, '协议未知'): worker.recover(f['job'])
        self.assertEqual((f['job'] / 'recovery.json').read_bytes(), before)
        self.assertFalse(worker.assess(f['job'])['canRecover'])

    def test_foreign_ack_does_not_complete_handoff(self):
        f = self.fixture(); worker.prepare(f['job'])
        class Child:
            def poll(self): return 9
        def launch(args, **options):
            worker.write_json(f['job'] / 'ready.json', {'schema': 'nora-launcher-handoff/1',
                'token': f['plan']['token'], 'version': f['plan']['version'],
                'operationId': str(uuid.uuid4()), 'planDigest': f['plan']['planDigest']})
            return Child()
        with patch.object(worker, 'parent_alive', return_value=False), patch.object(worker.subprocess, 'Popen', side_effect=launch):
            with self.assertRaisesRegex(RuntimeError, '提前退出'): worker.run(f['job'])
        self.assertEqual((f['app'] / 'launcher.exe').read_text(), 'old')
        self.assertEqual(worker.read_json(f['job'] / 'recovery.json')['phase'], 'restored')

    def test_evidence_and_status_save_failure_do_not_replace_the_actual_first_error(self):
        f = self.fixture(); worker.prepare(f['job']); first = RuntimeError('actual failure before rollback')
        class Child:
            polls = 0
            def poll(self):
                self.polls += 1
                if self.polls == 1: raise first
                return 1
        real_module = worker.shared_module
        def load(name, job=None):
            if name == 'operation_evidence':
                return SimpleNamespace(freeze=lambda *args, **kwargs: (_ for _ in ()).throw(PermissionError(13, 'fixture evidence denied')))
            return real_module(name, job)
        real_write = worker.write_json
        def write(path, value):
            if value.get('diagnosticError'): raise PermissionError(13, 'fixture status denied')
            return real_write(path, value)
        with patch.object(worker, 'parent_alive', return_value=False), patch.object(worker.subprocess, 'Popen', return_value=Child()), \
                patch.object(worker, 'shared_module', side_effect=load), patch.object(worker, 'write_json', side_effect=write):
            with self.assertRaises(RuntimeError) as raised: worker.run(f['job'])
        self.assertIs(raised.exception, first); self.assertIn('evidence_save_failed', first._diagnostic_missing)

    def test_readonly_assessment_does_not_hash_the_app_or_claim_permission_unknown_worker_is_offline(self):
        import psutil
        f = self.fixture(); worker.prepare(f['job'])
        before = (f['job'] / 'recovery.json').read_bytes()
        with patch.object(worker, 'tree_digest', side_effect=AssertionError('polling must not hash the app')), \
                patch.object(worker, 'parent_alive', side_effect=psutil.AccessDenied(os.getpid())):
            state = worker.assess(f['job'])
        self.assertEqual(state['effectState'], 'untouched'); self.assertFalse(state['workerOffline']); self.assertFalse(state['canRecover'])
        self.assertEqual((f['job'] / 'recovery.json').read_bytes(), before)

    def fixture_with_app_asar(self):
        f = self.fixture(); f['plan']['parentCreationTime'] -= 100
        resources = f['app'] / 'resources'
        resources.mkdir()
        (resources / 'app.asar').write_bytes(b'old package')
        with zipfile.ZipFile(f['plan']['archive'], 'a') as archive:
            archive.writestr('resources/app.asar', b'new package')
        f['plan']['sha256'] = worker.digest(f['plan']['archive'])
        worker.write_json(f['job'] / 'plan.json', f['plan'])
        return f

    @unittest.skipUnless(os.name == 'nt', 'Requires a native Windows byte-range lock')
    def test_native_foreign_byte_lock_preserves_untouched_app_and_allows_retry_after_release(self):
        import ctypes
        from ctypes import wintypes

        class Overlapped(ctypes.Structure):
            _fields_ = [('internal', ctypes.c_size_t), ('internal_high', ctypes.c_size_t),
                        ('offset', wintypes.DWORD), ('offset_high', wintypes.DWORD), ('event', wintypes.HANDLE)]

        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.LockFileEx.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                      wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped))
        kernel.LockFileEx.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel.CloseHandle.restype = wintypes.BOOL

        f = self.fixture_with_app_asar()
        f['plan']['releasePlan']['client'] = 'app'
        worker.write_json(f['job'] / 'plan.json', f['plan'])
        relative = Path('resources/clawchat/session.run.lock')
        foreign = f['app'] / relative
        foreign.parent.mkdir()
        foreign.touch()
        # GENERIC_READ | GENERIC_WRITE, all share flags, OPEN_EXISTING.
        handle = kernel.CreateFileW(str(foreign), 0xc0000000, 7, None, 3, 128, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            # Lock the first byte exclusively, even though the file is empty.
            if not kernel.LockFileEx(handle, 3, 0, 1, 0, ctypes.byref(Overlapped())):
                raise ctypes.WinError(ctypes.get_last_error())
            with foreign.open('rb') as stream, self.assertRaises(PermissionError):
                stream.read(1)
            self.assertTrue(worker.prepare(f['job'])['prepared'])
            result = f['owner'].execute(f, check=False)
            if result.returncode:
                outcome = worker.read_outcome(f['job'])['outcome']
                self.assertEqual(outcome['status'], 'cancelled')
                self.assertEqual(outcome['effectState'], 'untouched')
                self.assertTrue(outcome['workerOffline'])
                proof = outcome['sharingFailure']
                self.assertIn(proof['winerror'], (5, 32, 33))
                self.assertEqual(proof['schema'], 'nora-app-move-denied/1' if proof['winerror'] == 5
                                 else 'nora-app-sharing-failure/1')
                self.assertEqual(proof['phase'], 'moving-old')
                self.assertEqual([item['kind'] for item in f['owner'].children(f)], ['old'])
                f['owner'].assert_preserved(f)
        finally:
            if not kernel.CloseHandle(handle):
                raise ctypes.WinError(ctypes.get_last_error())

        if result.returncode:
            self.assertEqual(foreign.read_bytes(), b'')
            f['owner'].wait_children(f)
            first_job = f['job']
            f['job'] = first_job.with_name('job-retry')
            f['job'].mkdir()
            for name in ('replace.py', 'operation_control.py', 'operation_evidence.py', 'error_diagnostics.py', 'operation-budget.json'):
                shutil.copy2(first_job / name, f['job'] / name)
            f['plan']['token'] = str(uuid.uuid4())
            worker.write_json(f['job'] / 'plan.json', f['plan'])
            self.assertTrue(worker.prepare(f['job'])['prepared'])
            f['owner'].execute(f)
            self.assertEqual(worker.read_json(first_job / 'recovery.json')['sharingFailure'], proof)
        committed = worker.finalize(f['job'], target=f['plan']['target'], version=f['plan']['version'], verified=True)
        self.assertEqual(committed['status'], 'committed')
        self.assertEqual((Path(committed['retainedBackup']) / relative).read_bytes(), b'')
        self.assertEqual((f['app'] / 'resources/app.asar').read_bytes(), b'new package')
        f['owner'].assert_preserved(f, old=False)

    def test_unowned_windows_file_lock_does_not_block_update_and_backup_retirement_preserves_unknown_files(self):
        f = self.fixture_with_app_asar()
        resources = f['app'] / 'resources'
        (resources / 'clawchat').mkdir()
        (resources / 'clawchat' / 'clawchat.lock').write_bytes(b'external lock')
        (f['app'] / 'Uninstall other.exe').write_bytes(b'unowned executable')
        real_open = Path.open

        def locked(path, *args, **kwargs):
            if path.name == 'clawchat.lock':
                error = PermissionError(13, 'fixture byte-range lock', str(path))
                error.winerror = 33
                raise error
            return real_open(path, *args, **kwargs)

        with patch.object(Path, 'open', locked):
            worker.prepare(f['job'])
            f['owner'].execute(f, edge='unowned-lock')
            outcome = worker.finalize(f['job'], target=f['plan']['target'], version=f['plan']['version'], verified=True)
        self.assertEqual(outcome['status'], 'committed')
        backup = Path(outcome['retainedBackup'])
        self.assertEqual((backup / 'resources' / 'clawchat' / 'clawchat.lock').read_bytes(), b'external lock')
        self.assertEqual((backup / 'Uninstall other.exe').read_bytes(), b'unowned executable')
        self.assertFalse((backup / 'resources' / 'app.asar').exists())
        self.assertFalse((f['app'] / 'Uninstall other.exe').exists())
        self.assertEqual((resources / 'app.asar').read_bytes(), b'new package')
        f['owner'].assert_preserved(f, old=False)

    def test_recovery_checks_managed_old_program_and_keeps_latest_unknown_file(self):
        f = self.fixture_with_app_asar()
        relative = Path('resources/clawchat.lock')
        (f['app'] / relative).write_bytes(b'old lock bytes')
        worker.prepare(f['job']); f['owner'].execute(f, edge='unowned-lock')
        backup = worker.context(f['job'])['backup']
        (backup / relative).write_bytes(b'latest lock bytes')
        old_identity = worker.file_identity(backup / relative)
        asar = backup / 'resources/app.asar'
        asar.write_bytes(b'damaged old program')
        result = f['owner'].execute(f, mode='recover', edge='unowned-lock', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('旧启动器备份身份或内容已变化', result.stderr)
        self.assertEqual((f['app'] / 'resources/app.asar').read_bytes(), b'new package')
        asar.write_bytes(b'old package')
        f['owner'].execute(f, mode='recover', edge='unowned-lock')
        self.assertEqual((f['app'] / relative).read_bytes(), b'latest lock bytes')
        self.assertEqual(worker.file_identity(f['app'] / relative), old_identity)
        self.assertEqual((f['app'] / 'resources/app.asar').read_bytes(), b'old package')
        self.assertEqual(worker.inspect_outcome(f['job'])['status'], 'restored')

    def test_committed_outcome_survives_cut_before_status_and_requires_bound_ready_and_exact_program(self):
        f = self.fixture(); f['plan']['parentCreationTime'] -= 100
        worker.write_json(f['job'] / 'plan.json', f['plan']); worker.prepare(f['job']); f['owner'].execute(f)
        status = f['job'] / 'status.json'
        stale_status = status.read_bytes()
        real_write = worker.write_json

        def cut(path, value):
            if path == status and value.get('status') == 'committed':
                raise OSError('cut after durable commit before updating status')
            return real_write(path, value)

        with patch.object(worker, 'write_json', side_effect=cut):
            with self.assertRaisesRegex(OSError, 'cut after durable commit'):
                worker.finalize(f['job'], target=f['plan']['target'], version=f['plan']['version'], verified=True)
        recovery = f['job'] / 'recovery.json'
        committed_snapshot = recovery.read_bytes()
        self.assertEqual(worker.read_json(recovery)['phase'], 'committed')
        result = subprocess.run([sys.executable, '-B', str(f['job'] / 'replace.py'), '--inspect-outcome', str(f['job'])],
            check=True, capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertEqual(json.loads(result.stdout), {'job': str(f['job']), 'status': 'committed', 'verification': 'confirmed',
            'effectState': 'changed', 'busy': False, 'workerOffline': True, 'operationId': f['plan']['operationId'],
            'planDigest': f['plan']['planDigest'], 'version': f['plan']['version']})
        self.assertEqual(status.read_bytes(), stale_status)
        self.assertEqual(recovery.read_bytes(), committed_snapshot)
        status.unlink()
        self.assertEqual(worker.inspect_outcome(f['job'])['status'], 'committed')
        with patch.object(worker, 'parent_alive', return_value=True):
            self.assertIsNone(worker.inspect_outcome(f['job']))
        ready = f['job'] / 'ready.json'
        exact_ack = worker.read_json(ready)
        worker.write_json(ready, dict(exact_ack, planDigest='b' * 64))
        self.assertIsNone(worker.inspect_outcome(f['job']))
        ready.unlink()
        self.assertIsNone(worker.inspect_outcome(f['job']))
        worker.write_json(ready, exact_ack)
        (f['app'] / 'launcher.exe').write_text('bad')
        with self.assertRaisesRegex(ValueError, '已提交启动器的身份或内容已变化'):
            worker.inspect_outcome(f['job'])

    def test_successor_gate_reserves_recovery_and_refuses_unrelated_finalization(self):
        f = self.fixture(); f['plan']['parentCreationTime'] -= 100
        worker.write_json(f['job'] / 'plan.json', f['plan']); worker.prepare(f['job']); f['owner'].execute(f)
        gate = SimpleNamespace(operation_id=f['plan']['operationId'], owner_epoch=2, assert_active=lambda: None)
        created = worker.process_identity(os.getpid())['creationTime']
        with patch.object(sys, '_nora_operation_delegate', gate, create=True):
            result = worker.prepare_recovery(f['job'], parent_pid=os.getpid(), parent_creation_time=created)
            self.assertTrue(result['prepared'])
            snapshot = worker.read_json(f['job'] / 'recovery.json')
            self.assertEqual(snapshot['recoveryParent'], {'pid': os.getpid(), 'creationTime': created})
            with self.assertRaisesRegex(ValueError, '已准备恢复'):
                worker.finalize(f['job'], target=f['plan']['target'], version=f['plan']['version'], verified=True)
            self.assertTrue(worker.context(f['job'])['backup'].exists())
            gate.operation_id = str(uuid.uuid4())
            with self.assertRaisesRegex(ValueError, '启动器委托与当前操作不一致'):
                worker.finalize(f['job'], target=f['plan']['target'], version=f['plan']['version'], verified=True)


if __name__ == '__main__':
    unittest.main()
