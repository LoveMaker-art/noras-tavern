"""Exercise legacy migration through install, real copies and real transactions."""
from contextlib import ExitStack
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ops.installer import first_install, nora_system
from ops.updater import bundle


def load_updater():
    path = Path(__file__).resolve().parents[2] / 'ops/updater/update.py'
    spec = importlib.util.spec_from_file_location('migration_contract_updater', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MigrationInstallFixture:
    """Only release preparation, conversion command and services are substituted.

    The converter marks the staged copy; copying, Journal, state exchange and
    automatic recovery execute product code against an isolated directory.
    """
    def __init__(self, base, *, managed, conversion_failure=False, stop_failure=False,
                 offline=False, runtime_failure=False, service_remains_running=False,
                 conversion_error=None):
        self.updater = load_updater()
        self.base = Path(base).resolve()
        self.home = self.base / 'hermes'
        self.root = self.base / 'tavern'
        self.state = self.root / 'tavern-state'
        self.chat = self.state / 'legacy-chat.jsonl'
        self.managed = managed
        self.conversion_failure = conversion_failure
        self.conversion_error = conversion_error
        self.stop_failure = stop_failure
        self.offline = offline
        self.runtime_failure = runtime_failure
        self.service_remains_running = service_remains_running
        self.stopped = False
        self.events = []
        self.converted_bytes = None
        self.converted_after_stop = None
        self.original = b'{"message":"before preparation"}\n'
        self.final = self.original + b'{"message":"last write before stop"}\n'
        (self.home / 'skills').mkdir(parents=True)
        (self.root / 'apps/tavern-runtime').mkdir(parents=True)
        (self.root / 'apps/tavern-runtime/server.py').write_text('# legacy program\n')
        (self.root / 'apps/tavern-runtime/web').mkdir()
        (self.root / 'apps/tavern-ops').mkdir()
        (self.root / 'apps/nora-mcp').mkdir()
        self.state.mkdir()
        (self.state / 'productions').mkdir()
        self.chat.write_bytes(self.original)
        (self.root / 'tavern-updates').mkdir()
        (self.root / 'tavern-updates/installed.json').write_text('{"version":"2.0.1"}')
        (self.root / 'tavern-updates/nora-system.json').write_text('{"schema":1,"setupCompleted":true}')
        # Standalone updates read the actual MCP port from this YAML mapping.
        # Keep a valid existing configuration while substituting only services.
        self.config = b'model: {default: fixture-model}\n'
        (self.home / 'config.yaml').write_bytes(self.config)
        (self.home / 'AGENTS.md').write_text('old agents')
        (self.home / 'SOUL.md').write_text('old soul')
        if managed:
            for relative in [*(f'skills/{skill}/SKILL.md' for skill in nora_system.SKILLS),
                             *nora_system.MANAGED_FILES]:
                file = self.home / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('fixture managed content')
        self.before = {'version':'2.0.1', 'running':True, 'gatewayRunning':False,
                       'clawchatConnected':False, 'systemReady':True}
        self.instance = {'schema':1, 'noraHome':str(self.base), 'hermesHome':str(self.home),
                         'installRoot':str(self.root), 'port':8799}
        (self.home / 'nora-instance.json').write_text(json.dumps(self.instance))
        self.manifest = {'versions':{'tavern':'2.4.2'}, 'commit':'a'*40, 'artifacts':{}}
        self.service_file = self.base/'supervisor.conf'
        self.service_file.write_text('old service configuration')
        owner = self
        class Service:
            def snapshot(self):
                return {'pid':42, 'descriptor':{'file':str(owner.service_file),
                    'name':'tavern','socket':str(owner.base/'supervisor.sock')},
                    'text':owner.service_file.read_text(),'mode':0o600}
            def stop(self):
                owner.events.append('service-stop')
                if owner.stop_failure: raise RuntimeError('stop refused')
                owner.chat.write_bytes(owner.final)
                owner.stopped = not owner.service_remains_running
            def pid(self): return 42 if not owner.stopped else 0
            def info(self): return {'pid': self.pid(), 'statename':'STOPPED' if owner.stopped else 'RUNNING'}
            def restore(self, _snapshot): owner.events.append('service-restore')
            def start(self): owner.events.append('service-start'); owner.stopped = False
        self.service = Service()

    def extract(self, _release, source, _manifest, **_kwargs):
        for name in ('app', 'ops/skills', 'nora-mcp'):
            (source / name).mkdir(parents=True)
        (source / 'app/program.txt').write_text('new program')
        (source / 'ops/skills/agents-tavern.md').write_text('old agents')
        return {'changedModules':['nora-runtime']}

    def lifecycle(self, phase, *_):
        self.events.append(phase)
        if phase == 'stop':
            if self.stop_failure: raise RuntimeError('stop refused')
            self.chat.write_bytes(self.final)
            self.stopped = not self.offline
            return {'offline':self.stopped}
        if phase == 'recover-stop': return {'offline':True}
        if phase == 'verify': return {**self.before, 'version':'2.4.2'}
        return dict(self.before)

    def converter(self, command, **_kwargs):
        self.events.append('convert')
        prepared = Path(command[2])
        self.converted_bytes = (prepared / 'legacy-chat.jsonl').read_bytes()
        self.converted_after_stop = self.stopped
        if self.conversion_failure or self.conversion_error is not None:
            # A failing converter may already have changed its private copy.
            (prepared / 'legacy-chat.jsonl').write_bytes(b'partial conversion')
            if self.conversion_error is not None:
                raise self.conversion_error
            error = RuntimeError('unsupported legacy record')
            error.code = 'LEGACY_MIGRATION_UNSUPPORTED'
            raise error
        (prepared / 'converted.txt').write_text('converted from sealed data')
        return SimpleNamespace(stdout=json.dumps({'status':'migrated', 'importedWorlds':1}))

    def runtime(self, *_args, **_kwargs):
        self.events.append('new-runtime')
        if self.runtime_failure:
            (self.root / 'tavern-state/new-runtime-write.txt').write_text('failed-new evidence')
            raise RuntimeError('new runtime failed')
        return {'native_pid':None, 'health':{'ok':True}}

    def run(self):
        updater = self.updater
        helpers = SimpleNamespace(extract_dependency_bundle=lambda *_:False,
            snapshot_targets=first_install.snapshot_targets, stop_install_runtime=lambda *_:None,
            install_soul=lambda home,*_args,**_kwargs:(home/'SOUL.md').write_text('new soul'))
        managed_module = SimpleNamespace(read_json=lambda path:json.loads(path.read_text()),
            seed_clawchat_skills=lambda *_:None, record_files_ready=lambda *_:None,
            verify_runtime=lambda *_:{name:True for name in nora_system.PROOFS},
            record_initialization=nora_system.record_initialization,
            acceptance_record_problems=nora_system.acceptance_record_problems,
            mark_setup_complete=nora_system.mark_setup_complete)
        modules = {'update_nora_system':managed_module, 'update_install_helpers':helpers,
            'simple_service_manager':SimpleNamespace(ManagedService=SimpleNamespace(
                discover=lambda *_:None if self.managed else self.service)),
            'release_managed_context':SimpleNamespace(prepare_greeting=lambda *_:([],{})),
            'release_clawchat_greeting_patch':SimpleNamespace(prepare=lambda *_:([],{'status':'unchanged'})),
            'simple_skill_names':SimpleNamespace(RETIRED=())}
        original_loader = updater.module_at
        recovery = updater.recovery_module()
        def module(name, path):
            return recovery if name == 'tavern_update_recovery' else modules.get(name) or original_loader(name,path)
        lifecycle = {**self.instance, 'before':self.before, 'bridge':'fixture-only'}
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {'NORA_UPDATE_LIFECYCLE':json.dumps(lifecycle),
                'NORA_OPERATION_ID':'11111111-1111-4111-8111-111111111111',
                'NORA_INSTALLER_DIRECTORY':str(self.base/'installer')}))
            stack.enter_context(patch.dict(sys.modules, {'bundle':bundle}))
            substitutions = {
                'resolve_update_target':{'return_value':(self.home,self.root)},
                'managed_instance':{'return_value':self.instance},
                'module_at':{'side_effect':module},
                'prepare_dependencies':{'return_value':{}},
                'changed_roots':{'return_value':{'app'}},
                'roots_with_unmanaged_files':{'return_value':set()},
                'prepare_skills':{'return_value':{}},
                'prepare_host_hook_swap':{'return_value':None},
                'render_mcp':{'return_value':self.config},
                'managed_lifecycle':{'side_effect':self.lifecycle},
                'verify_worlds':{'return_value':{}},
                'verify_preserved_worlds':{'return_value':{'status':'verified'}},
                'dependency_marker':{'return_value':{}},
                'install_update_check':{'return_value':{'status':'installed'}},
                'install_runtime':{'side_effect':self.runtime},
                'refresh_liveware':{'return_value':{'status':'unchanged'}},
                'hermes_model':{'return_value':None}, 'legacy_model':{'return_value':None},
                'run':{'side_effect':self.converter},
            }
            for name, options in substitutions.items():
                stack.enter_context(patch.object(updater,name,**options))
            stack.enter_context(patch.object(bundle,'read_bundle',return_value=self.manifest))
            stack.enter_context(patch.object(bundle,'extract_bundle',side_effect=self.extract))
            stack.enter_context(patch('sys.stdout',new=io.StringIO()))
            updater.install(SimpleNamespace(home=self.home,install_root=self.root,
                managed_home=self.base if self.managed else None,
                release_dir=self.base/'release',manifest_sha256=None))

    def transaction(self):
        return json.loads((self.root/'tavern-updates/transaction.json').read_text())


class LegacyMigrationInstallContractTests(unittest.TestCase):
    def test_last_write_enters_active_and_backup_after_confirmed_stop(self):
        for managed in (False, True):
            with self.subTest(managed=managed), tempfile.TemporaryDirectory(prefix='nora-migrate-last-write-') as temporary:
                fixture = MigrationInstallFixture(temporary,managed=managed)
                fixture.run()
                self.assertTrue(fixture.converted_after_stop, fixture.events)
                self.assertEqual(fixture.converted_bytes,fixture.final)
                self.assertEqual(fixture.chat.read_bytes(),fixture.final)
                backup = Path(fixture.transaction()['backup'])
                self.assertEqual((backup/'state/legacy-chat.jsonl').read_bytes(),fixture.final)
                self.assertTrue((fixture.state/'converted.txt').is_file())
                self.assertEqual(fixture.transaction()['status'],'committed')

    def test_conversion_failure_archives_fresh_complete_original_not_partial_copy(self):
        for managed in (False, True):
            with self.subTest(managed=managed), tempfile.TemporaryDirectory(prefix='nora-migrate-fallback-') as temporary:
                fixture = MigrationInstallFixture(temporary,managed=managed,conversion_failure=True)
                fixture.run()
                self.assertTrue(fixture.converted_after_stop,fixture.events)
                self.assertEqual(fixture.chat.read_bytes(),fixture.final)
                self.assertFalse((fixture.state/'converted.txt').exists())
                backup = Path(fixture.transaction()['backup'])
                self.assertEqual((backup/'state/legacy-chat.jsonl').read_bytes(),fixture.final)
                installed = json.loads((fixture.root/'tavern-updates/installed.json').read_text())
                self.assertEqual(installed['migration']['status'],'archived')

    def test_stop_failure_never_copies_converts_or_exchanges_user_data(self):
        for managed in (False, True):
            with self.subTest(managed=managed), tempfile.TemporaryDirectory(prefix='nora-migrate-stop-failure-') as temporary:
                fixture = MigrationInstallFixture(temporary,managed=managed,stop_failure=True)
                with self.assertRaises(RuntimeError) as failure:
                    fixture.run()
                causes = []
                current = failure.exception
                while current is not None:
                    causes.append(str(current))
                    current = current.__cause__
                self.assertIn('stop refused','; '.join(causes))
                self.assertNotIn('convert',fixture.events)
                self.assertEqual(fixture.chat.read_bytes(),fixture.original)
                self.assertTrue((fixture.root/'apps/tavern-runtime/server.py').is_file())
                self.assertFalse((Path(fixture.transaction()['backup'])/'state').exists())

    def test_managed_offline_false_never_copies_or_exchanges_data(self):
        with tempfile.TemporaryDirectory(prefix='nora-migrate-unconfirmed-stop-') as temporary:
            fixture = MigrationInstallFixture(temporary,managed=True,offline=True)
            with self.assertRaisesRegex(RuntimeError,'未确认服务停止状态'):
                fixture.run()
            self.assertNotIn('convert',fixture.events)
            self.assertEqual(fixture.chat.read_bytes(),fixture.final)
            self.assertTrue((fixture.root/'apps/tavern-runtime/server.py').is_file())

    def test_direct_service_still_running_never_copies_or_exchanges_data(self):
        with tempfile.TemporaryDirectory(prefix='nora-migrate-service-still-running-') as temporary:
            fixture = MigrationInstallFixture(temporary,managed=False,service_remains_running=True)
            with self.assertRaisesRegex(RuntimeError,'未确认停服'):
                fixture.run()
            self.assertNotIn('convert',fixture.events)
            self.assertEqual(fixture.chat.read_bytes(),fixture.final)
            self.assertTrue((fixture.root/'apps/tavern-runtime/server.py').is_file())

    def test_direct_without_restore_capable_service_refuses_before_backup_or_stop(self):
        with tempfile.TemporaryDirectory(prefix='nora-migrate-no-service-') as temporary:
            fixture = MigrationInstallFixture(temporary,managed=False)
            fixture.service = None
            with self.assertRaises(RuntimeError) as failure:
                fixture.run()
            self.assertEqual(getattr(failure.exception,'code',None),'LEGACY_RUNTIME_UNSUPPORTED')
            self.assertEqual(fixture.events,[])
            self.assertEqual(fixture.chat.read_bytes(),fixture.original)
            self.assertTrue((fixture.root/'apps/tavern-runtime/server.py').is_file())
            self.assertFalse((fixture.root/'tavern-backups').exists())

    def test_explicit_unsupported_format_archives_complete_stopped_source(self):
        for managed in (False, True):
            with self.subTest(managed=managed), tempfile.TemporaryDirectory(prefix='nora-migrate-unsupported-format-') as temporary:
                fixture = MigrationInstallFixture(temporary,managed=managed)
                (fixture.state/'productions').rmdir()
                fixture.run()
                self.assertNotIn('convert',fixture.events)
                self.assertEqual(fixture.chat.read_bytes(),fixture.final)
                backup = Path(fixture.transaction()['backup'])
                self.assertEqual((backup/'state/legacy-chat.jsonl').read_bytes(),fixture.final)
                self.assertEqual(fixture.transaction()['status'],'committed')
                installed = json.loads((fixture.root/'tavern-updates/installed.json').read_text())
                self.assertEqual(installed['migration']['status'],'archived')

    def test_false_string_setup_receipt_never_becomes_completed(self):
        with tempfile.TemporaryDirectory(prefix='nora-migrate-setup-proof-') as temporary:
            fixture = MigrationInstallFixture(temporary,managed=True)
            file = fixture.root/'tavern-updates/nora-system.json'
            file.write_text('{"schema":1,"setupCompleted":"false"}')
            fixture.run()
            self.assertIs(json.loads(file.read_text())['setupCompleted'],False)

    def test_missing_receipt_truthy_model_fields_never_become_completed(self):
        with tempfile.TemporaryDirectory(prefix='nora-migrate-missing-setup-proof-') as temporary:
            fixture = MigrationInstallFixture(temporary,managed=True)
            fixture.instance['missingSystemReceipt'] = True
            previous = fixture.lifecycle
            def lifecycle(phase,*args):
                state = previous(phase,*args)
                return {**state,'modelConfigured':'true','clawchatProfileReady':'false'} if phase == 'preflight' else state
            fixture.lifecycle = lifecycle
            fixture.run()
            file = fixture.root/'tavern-updates/nora-system.json'
            self.assertIs(json.loads(file.read_text())['setupCompleted'],False)

    def test_fatal_converter_errors_restore_data_and_service_instead_of_archived_success(self):
        errors = [subprocess.CalledProcessError(1,['node','prepare-state.mjs'],stderr='conversion failed'),
                  subprocess.TimeoutExpired(['node','prepare-state.mjs'],300),
                  OSError(errno.ENOSPC,'converter disk full'),
                  OSError(errno.EIO,'converter read failed'),
                  PermissionError(errno.EACCES,'converter denied'),
                  RuntimeError('unexpected converter error')]
        for managed in (False, True):
            for error in errors:
                with self.subTest(managed=managed,error=type(error).__name__,detail=str(error)), \
                        tempfile.TemporaryDirectory(prefix='nora-migrate-converter-fatal-') as temporary:
                    fixture = MigrationInstallFixture(temporary,managed=managed,conversion_error=error)
                    with self.assertRaisesRegex(RuntimeError,'recovery=restored'):
                        fixture.run()
                    self.assertTrue(fixture.converted_after_stop,fixture.events)
                    self.assertEqual(fixture.chat.read_bytes(),fixture.final)
                    self.assertTrue((fixture.root/'apps/tavern-runtime/server.py').is_file())
                    self.assertEqual(fixture.transaction()['status'],'restored')
                    self.assertIn('rollback' if managed else 'service-start',fixture.events)
                    installed = json.loads((fixture.root/'tavern-updates/installed.json').read_text())
                    self.assertEqual(installed['version'],'2.0.1')

    def test_real_copy_io_failure_is_not_archived_and_restores_original_service(self):
        for managed in (False, True):
            with self.subTest(managed=managed), tempfile.TemporaryDirectory(prefix='nora-migrate-copy-fatal-') as temporary:
                fixture = MigrationInstallFixture(temporary,managed=managed)
                original_copy = fixture.updater.shutil.copytree
                def copy(source, destination, *args, **kwargs):
                    if Path(source) == fixture.state and Path(destination).parts[-2:] == ('prepared','state'):
                        raise OSError(errno.EIO,'original state read failed')
                    return original_copy(source,destination,*args,**kwargs)
                with patch.object(fixture.updater.shutil,'copytree',side_effect=copy), \
                        self.assertRaisesRegex(RuntimeError,'original state read failed; recovery=restored'):
                    fixture.run()
                self.assertNotIn('convert',fixture.events)
                self.assertEqual(fixture.chat.read_bytes(),fixture.final)
                self.assertTrue((fixture.root/'apps/tavern-runtime/server.py').is_file())
                self.assertEqual(fixture.transaction()['status'],'restored')
                self.assertIn('rollback' if managed else 'service-start',fixture.events)

    def test_failure_after_state_exchange_restores_last_write_and_keeps_failed_new(self):
        for managed in (False, True):
            with self.subTest(managed=managed), tempfile.TemporaryDirectory(prefix='nora-migrate-rollback-') as temporary:
                fixture = MigrationInstallFixture(temporary,managed=managed,runtime_failure=True)
                with self.assertRaisesRegex(RuntimeError,'new runtime failed; recovery=restored'):
                    fixture.run()
                self.assertTrue(fixture.converted_after_stop,fixture.events)
                self.assertEqual(fixture.chat.read_bytes(),fixture.final)
                self.assertTrue((fixture.root/'apps/tavern-runtime/server.py').is_file())
                backup = Path(fixture.transaction()['backup'])
                self.assertEqual((backup/'failed-new/state/legacy-chat.jsonl').read_bytes(),fixture.final)
                self.assertEqual((backup/'failed-new/state/new-runtime-write.txt').read_text(),'failed-new evidence')
                self.assertFalse((fixture.state/'converted.txt').exists())
                self.assertEqual(fixture.transaction()['status'],'restored')
                self.assertIn('rollback' if managed else 'service-start',fixture.events)


class LegacyMigrationOfflineEvidenceTests(unittest.TestCase):
    def test_supervisor_backoff_or_missing_pid_never_authorizes_copy(self):
        for info in ({'pid':0,'statename':'BACKOFF'}, {'pid':0,'statename':'RUNNING'},
                     {'pid':False,'statename':'STOPPED'}, {'statename':'STOPPED'},
                     {'pid':7,'statename':'STOPPED'}):
            with self.subTest(info=info):
                updater = load_updater()
                service = SimpleNamespace(stop=lambda:None, info=lambda:info)
                with patch.object(updater,'legacy_migration_processes',return_value=[]) as scan:
                    with self.assertRaisesRegex(RuntimeError,'未确认停服'):
                        updater.stop_legacy_for_migration(Path.cwd(),service)
                    scan.assert_not_called()

    def test_supervisor_zero_pid_stopped_still_requires_no_root_writer(self):
        updater = load_updater()
        service = SimpleNamespace(stop=lambda:None, info=lambda:{'pid':0,'statename':'STOPPED'})
        with patch.object(updater,'legacy_migration_processes',return_value=[{'pid':42}]), \
                self.assertRaisesRegex(RuntimeError,'仍有旧酒馆进程'):
            updater.stop_legacy_for_migration(Path.cwd(),service)

    def test_unreadable_current_user_python_actor_is_unknown_not_offline(self):
        import psutil
        updater = load_updater()
        own = psutil.Process().username()
        def denied(): raise psutil.AccessDenied(42)
        actor = SimpleNamespace(info={'pid':42,'name':'python'},cmdline=denied,username=lambda:own)
        with patch.object(psutil,'process_iter',return_value=[actor]), \
                self.assertRaisesRegex(RuntimeError,'候选进程不可读'):
            updater.legacy_migration_processes(Path.cwd())

    def test_unreadable_unrelated_system_process_does_not_block(self):
        import psutil
        updater = load_updater()
        def denied(): raise psutil.AccessDenied(42)
        actor = SimpleNamespace(info={'pid':42,'name':'system'},cmdline=denied)
        with patch.object(psutil,'process_iter',return_value=[actor]):
            self.assertEqual(updater.legacy_migration_processes(Path.cwd()),[])

    def test_empty_runtime_command_is_unknown_but_reaped_zombie_is_not_a_writer(self):
        import psutil
        updater = load_updater()
        own = psutil.Process().username()
        actor = SimpleNamespace(info={'pid':42,'name':'python'},cmdline=lambda:[],
            username=lambda:own,status=lambda:psutil.STATUS_RUNNING)
        with patch.object(psutil,'process_iter',return_value=[actor]):
            with self.assertRaisesRegex(RuntimeError,'命令为空'):
                updater.legacy_migration_processes(Path.cwd())
            actor.status = lambda:psutil.STATUS_ZOMBIE
            self.assertEqual(updater.legacy_migration_processes(Path.cwd()),[])

    def test_no_service_never_attempts_to_terminate_or_scan_unowned_processes(self):
        updater = load_updater()
        with patch.object(updater,'legacy_migration_processes') as scan, \
                patch.object(updater.os,'kill') as kill, self.assertRaises(RuntimeError) as failure:
            updater.stop_legacy_for_migration(Path.cwd(),None)
        self.assertEqual(getattr(failure.exception,'code',None),'LEGACY_RUNTIME_UNSUPPORTED')
        scan.assert_not_called()
        kill.assert_not_called()

    def test_relative_server_with_unreadable_cwd_is_unknown(self):
        import psutil
        updater = load_updater()
        def denied(): raise psutil.AccessDenied(42)
        actor = SimpleNamespace(info={'pid':42,'name':'python'},
            cmdline=lambda:['python','server.py'],cwd=denied)
        with patch.object(psutil,'process_iter',return_value=[actor]), \
                self.assertRaisesRegex(RuntimeError,'目录不可读'):
            updater.legacy_migration_processes(Path.cwd())

    def test_no_psutil_linux_fallback_rejects_writer_after_supervisor_stop(self):
        updater = load_updater()
        with tempfile.TemporaryDirectory(prefix='nora-migrate-proc-writer-') as temporary:
            base = Path(temporary).resolve()
            app = base/'app';app.mkdir()
            proc = base/'proc';actor = proc/'42';actor.mkdir(parents=True)
            (actor/'cwd').symlink_to(app,target_is_directory=True)
            (actor/'cmdline').write_bytes(b'python\0server.py\0')
            original_path = Path
            def selected_path(value): return proc if value == '/proc' else original_path(value)
            service = SimpleNamespace(stop=lambda:None, info=lambda:{'pid':0,'statename':'STOPPED'})
            with patch.dict(sys.modules,{'psutil':None}), \
                    patch.object(updater,'Path',side_effect=selected_path), \
                    patch.object(updater,'stop_unmanaged') as stop, \
                    self.assertRaisesRegex(RuntimeError,'仍有旧酒馆进程'):
                updater.stop_legacy_for_migration(app,service)
            stop.assert_not_called()

    def test_no_psutil_proc_bound_cwd_with_unreadable_command_is_not_offline(self):
        updater = load_updater()
        with tempfile.TemporaryDirectory(prefix='nora-migrate-proc-denied-') as temporary:
            base = Path(temporary).resolve()
            app = base/'app';app.mkdir()
            proc = base/'proc';actor = proc/'42';actor.mkdir(parents=True)
            (actor/'cwd').symlink_to(app,target_is_directory=True)
            command = actor/'cmdline';command.write_bytes(b'python\0server.py\0')
            original_path, original_read = Path, Path.read_bytes
            def selected_path(value): return proc if value == '/proc' else original_path(value)
            def read(path):
                if path == command: raise PermissionError(errno.EACCES,'process command denied')
                return original_read(path)
            with patch.dict(sys.modules,{'psutil':None}), \
                    patch.object(updater,'Path',side_effect=selected_path), \
                    patch.object(Path,'read_bytes',read), \
                    self.assertRaisesRegex(RuntimeError,'未确认停服'):
                updater.legacy_migration_processes(app)

    def test_no_psutil_linux_without_actor_remains_supported(self):
        updater = load_updater()
        with tempfile.TemporaryDirectory(prefix='nora-migrate-proc-empty-') as temporary:
            proc = Path(temporary).resolve()
            original_path = Path
            def selected_path(value): return proc if value == '/proc' else original_path(value)
            service = SimpleNamespace(stop=lambda:None, info=lambda:{'pid':0,'statename':'STOPPED'})
            with patch.dict(sys.modules,{'psutil':None}), \
                    patch.object(updater,'Path',side_effect=selected_path), \
                    patch.object(updater,'stop_unmanaged') as stop:
                updater.stop_legacy_for_migration(Path.cwd(),service)
                stop.assert_not_called()

    def test_no_psutil_proc_root_bound_empty_command_is_unknown_not_offline(self):
        updater = load_updater()
        with tempfile.TemporaryDirectory(prefix='nora-migrate-proc-empty-command-') as temporary:
            base = Path(temporary).resolve()
            app = base/'app';app.mkdir()
            proc = base/'proc';actor = proc/'42';actor.mkdir(parents=True)
            (actor/'cwd').symlink_to(app,target_is_directory=True)
            (actor/'comm').write_text('python')
            (actor/'cmdline').write_bytes(b'')
            original_path = Path
            def selected_path(value): return proc if value == '/proc' else original_path(value)
            service = SimpleNamespace(stop=lambda:None, info=lambda:{'pid':0,'statename':'STOPPED'})
            with patch.dict(sys.modules,{'psutil':None}), \
                    patch.object(updater,'Path',side_effect=selected_path), \
                    self.assertRaisesRegex(RuntimeError,'命令为空'):
                updater.stop_legacy_for_migration(app,service)
            # An unrelated known system process's empty command is not a writer.
            (actor/'cwd').unlink()
            (actor/'comm').write_text('system')
            with patch.dict(sys.modules,{'psutil':None}), \
                    patch.object(updater,'Path',side_effect=selected_path):
                updater.stop_legacy_for_migration(app,service)

    def test_no_psutil_proc_unrelated_unreadable_system_actor_does_not_block(self):
        updater = load_updater()
        with tempfile.TemporaryDirectory(prefix='nora-migrate-proc-unrelated-') as temporary:
            base = Path(temporary).resolve()
            app = base/'app';app.mkdir()
            other = base/'other';other.mkdir()
            proc = base/'proc';actor = proc/'42';actor.mkdir(parents=True)
            (actor/'cwd').symlink_to(other,target_is_directory=True)
            (actor/'comm').write_text('system')
            command = actor/'cmdline';command.write_bytes(b'')
            original_path, original_read = Path, Path.read_bytes
            def selected_path(value): return proc if value == '/proc' else original_path(value)
            def read(path):
                if path == command: raise PermissionError(errno.EACCES,'system command denied')
                return original_read(path)
            with patch.dict(sys.modules,{'psutil':None}), \
                    patch.object(updater,'Path',side_effect=selected_path), patch.object(Path,'read_bytes',read):
                self.assertEqual(updater.legacy_migration_processes(app),[])

    def test_no_psutil_proc_runtime_candidate_with_unknown_command_or_owner_is_not_offline(self):
        updater = load_updater()
        with tempfile.TemporaryDirectory(prefix='nora-migrate-proc-runtime-') as temporary:
            base = Path(temporary).resolve()
            app = base/'app';app.mkdir()
            other = base/'other';other.mkdir()
            proc = base/'proc';actor = proc/'42';actor.mkdir(parents=True)
            (actor/'cwd').symlink_to(other,target_is_directory=True)
            (actor/'comm').write_text('python')
            command = actor/'cmdline';command.write_bytes(b'')
            own_uid = actor.stat().st_uid
            original_path, original_read, original_stat = Path, Path.read_bytes, Path.stat
            def selected_path(value): return proc if value == '/proc' else original_path(value)
            def read(path):
                if path == command: raise PermissionError(errno.EACCES,'runtime command denied')
                return original_read(path)
            for denied_owner in (False,True):
                def stat_value(path,*args,**kwargs):
                    if path == actor and denied_owner:
                        raise PermissionError(errno.EACCES,'process owner denied')
                    return original_stat(path,*args,**kwargs)
                with self.subTest(denied_owner=denied_owner), \
                        patch.dict(sys.modules,{'psutil':None}), \
                        patch.object(os,'getuid',return_value=own_uid,create=True), \
                        patch.object(updater,'Path',side_effect=selected_path), \
                        patch.object(Path,'read_bytes',read), patch.object(Path,'stat',stat_value), \
                        self.assertRaisesRegex(RuntimeError,'未确认停服'):
                    updater.legacy_migration_processes(app)

    def test_no_psutil_no_proc_refuses_without_false_offline(self):
        updater = load_updater()
        with patch.dict(sys.modules,{'psutil':None}), patch.object(Path,'is_dir',return_value=False), \
                self.assertRaisesRegex(RuntimeError,'无法核验'):
            updater.legacy_migration_processes(Path.cwd())

    def test_real_root_actor_is_rejected_after_supervisor_stop_without_extra_kill(self):
        updater = load_updater()
        with tempfile.TemporaryDirectory(prefix='nora-migrate-process-proof-') as temporary:
            root = Path(temporary).resolve()
            app = root/'apps/tavern-runtime'
            unrelated = root/'unrelated'
            actors = []
            try:
                for directory in (app, unrelated):
                    directory.mkdir(parents=True)
                    script = directory/'server.py'
                    script.write_text('from pathlib import Path\nimport os,time\n'
                        'Path(__file__).with_suffix(".ready").write_text(str(os.getpid()))\n'
                        'while True: time.sleep(0.05)\n')
                    environment = dict(os.environ)
                    executable = sys.executable
                    if os.name == 'nt':
                        executable = sys._base_executable
                        environment['__PYVENV_LAUNCHER__'] = sys.executable
                    child = subprocess.Popen([executable,'-B',str(script)],cwd=root,env=environment,
                        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                    actors.append(child)
                    deadline = time.monotonic()+3
                    while not script.with_suffix('.ready').is_file() and child.poll() is None and time.monotonic()<deadline:
                        time.sleep(0.01)
                    self.assertIsNone(child.poll())
                    self.assertTrue(script.with_suffix('.ready').is_file())
                    self.assertEqual(int(script.with_suffix('.ready').read_text()), child.pid)
                found = updater.legacy_migration_processes(app)
                self.assertEqual([row['pid'] for row in found],[actors[0].pid])
                service = SimpleNamespace(stop=lambda:None, info=lambda:{'pid':0,'statename':'STOPPED'})
                with self.assertRaisesRegex(RuntimeError,'仍有旧酒馆进程'):
                    updater.stop_legacy_for_migration(app,service)
                self.assertIsNone(actors[0].poll())
                self.assertIsNone(actors[1].poll())
            finally:
                for child in actors:
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=3)


if __name__ == '__main__':
    unittest.main()
