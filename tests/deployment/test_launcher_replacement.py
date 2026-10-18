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
        (app / 'Uninstall Nora.exe').write_text('uninstaller')
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
        self.assertEqual((app / 'Uninstall Nora.exe').read_text(), 'uninstaller')
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
        worker.io_path(app / 'Uninstall Nora.exe').write_text('uninstaller')
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
 (job/'ready.json').write_text(json.dumps({'token':plan['token'],'version':plan['version']}),encoding='utf-8')
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
        self.assertEqual(worker.io_path(f['app'] / 'Uninstall Nora.exe').read_text(), 'uninstaller')

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
        launcher = launcher.replace("(job/'ready.json').write_text(json.dumps({'token':plan['token'],'version':plan['version']}),encoding='utf-8')",
            "(job/'ready.json').write_text(json.dumps({'schema':'nora-launcher-handoff/1','token':plan['token'],'version':plan['version'],'operationId':plan['operationId'],'planDigest':plan['planDigest']}),encoding='utf-8')")
        f['launcher'].write_text(launcher)
        return f

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
            with self.assertRaises(RuntimeError): worker.require_launcher_offline(worker.context(f['job']))

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

    def test_successor_gate_can_prepare_recovery_and_finalize_same_plan_but_not_another_operation(self):
        f = self.fixture(); f['plan']['parentCreationTime'] -= 100
        worker.write_json(f['job'] / 'plan.json', f['plan']); worker.prepare(f['job']); f['owner'].execute(f)
        gate = SimpleNamespace(operation_id=f['plan']['operationId'], owner_epoch=2, assert_active=lambda: None)
        created = worker.process_identity(os.getpid())['creationTime']
        with patch.object(sys, '_nora_operation_delegate', gate, create=True):
            result = worker.prepare_recovery(f['job'], parent_pid=os.getpid(), parent_creation_time=created)
            self.assertTrue(result['prepared'])
            snapshot = worker.read_json(f['job'] / 'recovery.json')
            self.assertEqual(snapshot['recoveryParent'], {'pid': os.getpid(), 'creationTime': created})
            worker.finalize(f['job'], target=f['plan']['target'], version=f['plan']['version'], verified=True)
            gate.operation_id = str(uuid.uuid4())
            with self.assertRaises(ValueError): worker.finalize(f['job'], target=f['plan']['target'], version=f['plan']['version'], verified=True)


if __name__ == '__main__':
    unittest.main()
