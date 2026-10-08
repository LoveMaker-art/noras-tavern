import importlib.util
import json
import os
import subprocess
import shutil
import sys
import tempfile
import unittest
import uuid
import zipfile
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent.parent / 'installer/desktop/replace-launcher.py'
SPEC = importlib.util.spec_from_file_location('replace_launcher', SOURCE)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class ReplacementTests(unittest.TestCase):
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
                subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(application)], check=True)
            subprocess.run([shutil.which('node'), str(Path(__file__).with_name('verify_launcher_update.cjs')),
                            str(application), os.environ['NORA_TEST_LAUNCHER_DESKTOP'], sys.platform], check=True)

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
        temporary = tempfile.TemporaryDirectory(prefix='nora recovery 中文 &%!() ')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
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
        launcher = Path(temporary.name).resolve() / 'fixture-launcher.py'
        launcher.write_text('''import json,os,sys,time
from pathlib import Path
job=Path(sys.argv[1]);kind=sys.argv[2]
if os.name=='nt': job=Path(chr(92)*2+'?'+chr(92)+str(job))
with (job/'children.jsonl').open('a',encoding='utf-8') as file:
 file.write(json.dumps({'pid':os.getpid(),'kind':kind})+'\\n')
if kind=='new' and sys.argv[3]=='fail': sys.exit(3)
if kind=='new':
 plan=json.loads((job/'plan.json').read_text(encoding='utf-8'))
 (job/'ready.json').write_text(json.dumps({'token':plan['token'],'version':plan['version']}),encoding='utf-8')
time.sleep(0.15)
''')
        runner = Path(temporary.name).resolve() / 'fixture-worker.py'
        runner.write_text('''import importlib.util,os,subprocess,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('replace_worker',sys.argv[1]);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
job=Path(sys.argv[2]);mode=sys.argv[3];edge=sys.argv[4];fail=sys.argv[5];launcher=sys.argv[6]
ctx=w.context(job);real_popen=w.subprocess.Popen;real_replace=w.os.replace

def launch(args,**options):
 if Path(args[0]).name=='launcher.exe':
  kind='new' if any(arg.startswith('--nora-self-update=') for arg in args[1:]) else 'old'
  options.pop('executable',None)
  return real_popen([sys.executable,'-B',launcher,str(job),kind,fail],**options)
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
        result = {'root': root, 'home': home, 'app': app, 'job': job, 'plan': plan,
                  'runner': runner, 'launcher': launcher, 'fail': 'fail' if fail else 'ok'}
        self.addCleanup(self.wait_children, result)
        return result

    def wait_children(self, f):
        import psutil
        for child in self.children(f):
            try:
                process = psutil.Process(child['pid'])
                if str(f['launcher']) in process.cmdline():
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
        self.addCleanup(owner.doCleanups)
        f = owner.fixture()
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
            result = subprocess.run([sys.executable, '-B', str(SOURCE), '--prepare', str(f['job'])], capture_output=True, text=True)
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
            child.terminate(); child.communicate(timeout=5)
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
        owner = DurableReplacementTests('test_real_ack_retains_backup_until_verified_combined_commit'); self.addCleanup(owner.doCleanups)
        f = owner.fixture(); owner.execute(f)
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
