import json
from contextlib import ExitStack
import importlib.util
import multiprocessing
import os
from pathlib import Path, PureWindowsPath
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ops.installer import update_recovery as recovery
from ops.installer import first_install
from ops.installer import nora_system
from ops.updater import bundle


def load_updater():
    path=Path(__file__).resolve().parents[2]/'ops/updater/update.py'
    spec=importlib.util.spec_from_file_location('integration_recovery_updater',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def install_fixture(base,*,interrupt=False,success=False,cron_mutation=None):
    """Run the real managed transaction, substituting only release/services."""
    updater=load_updater();base=Path(base).resolve();home=base/'hermes';root=base/'tavern'
    (home/'skills').mkdir(parents=True);(root/'apps/tavern-runtime').mkdir(parents=True)
    (root/'apps/tavern-runtime/program.txt').write_text('old program')
    (root/'apps/tavern-runtime/native-runtime.json').write_text('{}')
    (root/'tavern-state/native/default-user/chats').mkdir(parents=True)
    (root/'tavern-state/native/default-user/chats/story.jsonl').write_text('old story')
    (root/'tavern-updates').mkdir()
    (root/'tavern-updates/installed.json').write_text('{"version":"2.3.17"}')
    (root/'tavern-updates/nora-system.json').write_text('{"schema":1,"setupCompleted":true}')
    (home/'config.yaml').write_text('old config');(home/'AGENTS.md').write_text('old agents')
    (home/'SOUL.md').write_text('old soul')
    if success:
        for relative in [*(f'skills/{skill}/SKILL.md' for skill in nora_system.SKILLS),*nora_system.MANAGED_FILES]:
            file=home/relative;file.parent.mkdir(parents=True,exist_ok=True)
            file.write_text('fixture managed content')
    if cron_mutation:
        cron=home/'cron/jobs.json';cron.parent.mkdir(exist_ok=True)
        cron.write_text(json.dumps({'jobs':[{'id':'daily','script':'check.py','enabled':True,
            'schedule':{'kind':'cron','expr':'0 9 * * *'},'state':'scheduled',
            'fire_claim':{'by':'fixture-gateway'},'last_run_at':None}], 'updated_at':'before'}))
    before={'version':'2.3.17','running':True,'gatewayRunning':False,
            'clawchatConnected':False,'systemReady':True}
    instance={'schema':1,'noraHome':str(base),'hermesHome':str(home),'installRoot':str(root),'port':8799}
    (home/'nora-instance.json').write_text(json.dumps(instance))
    lifecycle={**instance,'before':before,'bridge':'unused-test-bridge'}
    manifest={'versions':{'tavern':'2.4.2'},'commit':'a'*40,'artifacts':{}}
    phases=[]
    def extract(_release,source,_manifest,**_kwargs):
        (source/'app').mkdir(parents=True);(source/'app/program.txt').write_text('new program')
        (source/'ops/skills').mkdir(parents=True)
        (source/'ops/skills/agents-tavern.md').write_text('old agents')
        return {'changedModules':['nora-runtime']}
    def service(phase,*_):
        phases.append(phase)
        if phase=='stop':
            if cron_mutation:
                value=json.loads(cron.read_text());value['updated_at']='stopped'
                value['jobs'][0].update(fire_claim=None,last_run_at='2026-10-11T02:00:00Z',last_status='ok')
                if cron_mutation=='definition':value['jobs'][0]['script']='user-selected-private-task.py'
                cron.write_text(json.dumps(value))
            return {'offline':True}
        if phase=='recover-stop':
            evidence=base/'installer/operations/11111111-1111-4111-8111-111111111111/evidence/python.json'
            message=json.loads(evidence.read_text())['primary']['message']
            assert ('配置已发生变化' in message if cron_mutation=='definition' else message=='new runtime failed')
            return {'offline':True}
        if phase=='verify':return {**before,'version':manifest['versions']['tavern']}
        return dict(before)
    helpers=SimpleNamespace(extract_dependency_bundle=lambda *_:False,
        snapshot_targets=first_install.snapshot_targets,stop_install_runtime=lambda *_:None,
        install_soul=lambda home,*_args,**_kwargs:(home/'SOUL.md').write_text('new soul'))
    managed=SimpleNamespace(read_json=lambda path:json.loads(path.read_text()),
        seed_clawchat_skills=lambda *_:None,record_files_ready=lambda *_:None,
        verify_runtime=lambda *_:{name:True for name in nora_system.PROOFS},
        record_initialization=nora_system.record_initialization,
        mark_setup_complete=nora_system.mark_setup_complete)
    modules={'update_nora_system':managed,'update_install_helpers':helpers,
             'simple_service_manager':SimpleNamespace(ManagedService=SimpleNamespace(discover=lambda *_:None)),
             'release_managed_context':SimpleNamespace(prepare_greeting=lambda *_:([],{})),
             'release_clawchat_greeting_patch':SimpleNamespace(prepare=lambda *_:([],{'status':'unchanged'})),
             'simple_skill_names':SimpleNamespace(RETIRED=())}
    original_loader=updater.module_at
    helper=updater.recovery_module()
    def module(name,path):return helper if name=='tavern_update_recovery' else modules.get(name) or original_loader(name,path)
    original_replace=helper.os.replace
    def replace(source,target):
        original_replace(source,target)
        if interrupt and Path(first_install.filesystem_path(target))==Path(first_install.filesystem_path(root/'apps/tavern-runtime')):
            os._exit(91)
    with ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ,{'NORA_UPDATE_LIFECYCLE':json.dumps(lifecycle),'NORA_OPERATION_ID':'11111111-1111-4111-8111-111111111111','NORA_INSTALLER_DIRECTORY':str(base/'installer')}))
        stack.enter_context(patch.dict(sys.modules,{'bundle':bundle}))
        stack.enter_context(patch.object(updater,'resolve_update_target',return_value=(home,root)))
        stack.enter_context(patch.object(updater,'managed_instance',return_value=instance))
        stack.enter_context(patch.object(updater,'module_at',side_effect=module))
        stack.enter_context(patch.object(bundle,'read_bundle',return_value=manifest))
        stack.enter_context(patch.object(bundle,'extract_bundle',side_effect=extract))
        stack.enter_context(patch.object(updater,'prepare_dependencies',return_value={}))
        stack.enter_context(patch.object(updater,'changed_roots',return_value={'app'}))
        stack.enter_context(patch.object(updater,'roots_with_unmanaged_files',return_value=set()))
        stack.enter_context(patch.object(updater,'prepare_skills',return_value={}))
        stack.enter_context(patch.object(updater,'prepare_host_hook_swap',return_value=None))
        stack.enter_context(patch.object(updater,'render_mcp',return_value=b'old config'))
        stack.enter_context(patch.object(updater,'managed_lifecycle',side_effect=service))
        stack.enter_context(patch.object(updater,'verify_worlds',return_value={}))
        stack.enter_context(patch.object(updater,'verify_preserved_worlds',return_value={'status':'verified'}))
        stack.enter_context(patch.object(updater,'dependency_marker',return_value={}))
        stack.enter_context(patch.object(updater,'install_update_check',return_value={'status':'installed'}))
        stack.enter_context(patch.object(updater,'install_runtime',**(
            {'return_value':{'native_pid':None,'health':{'ok':True}}} if success else
            {'side_effect':RuntimeError('new runtime failed')})))
        stack.enter_context(patch.object(helper.os,'replace',side_effect=replace))
        updater.install(SimpleNamespace(home=home,install_root=root,managed_home=base,
            release_dir=base/'release',manifest_sha256=None))
    return phases


class ManagedInstallRecoveryTests(unittest.TestCase):
    def test_real_install_allows_offline_cron_bookkeeping_and_commits_verified_version(self):
        with tempfile.TemporaryDirectory(prefix='nora-managed-update-cron-') as temporary:
            base=Path(temporary).resolve()
            self.assertEqual(install_fixture(base,success=True,cron_mutation='runtime'),['preflight','stop','verify'])
            transaction=json.loads((base/'tavern/tavern-updates/transaction.json').read_text())
            self.assertEqual(transaction['status'],'committed')
            backup=Path(transaction['backup'])
            original=json.loads((backup/'managed/targets/cron/jobs.json').read_text())
            stopped=json.loads((backup/'runtime-state/cron-jobs.json').read_text())
            self.assertIsNotNone(original['jobs'][0]['fire_claim'])
            self.assertIsNone(stopped['jobs'][0]['fire_claim'])
            self.assertEqual(json.loads((base/'hermes/cron/jobs.json').read_text()),stopped)

    def test_real_install_rejects_task_change_and_keeps_user_definition_while_resuming_old_version(self):
        with tempfile.TemporaryDirectory(prefix='nora-managed-update-cron-user-') as temporary:
            base=Path(temporary).resolve()
            with self.assertRaisesRegex(RuntimeError,'配置已发生变化.*recovery=restored'):
                install_fixture(base,success=True,cron_mutation='definition')
            self.assertEqual((base/'tavern/apps/tavern-runtime/program.txt').read_text(),'old program')
            self.assertEqual(json.loads((base/'hermes/cron/jobs.json').read_text())['jobs'][0]['script'],
                             'user-selected-private-task.py')
            self.assertEqual(json.loads((base/'tavern/tavern-updates/transaction.json').read_text())['status'],'restored')

    def test_real_install_committed_journal_keeps_sealed_metadata_after_success_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='nora-managed-update-committed-') as temporary:
            base=Path(temporary).resolve();home=base/'hermes';root=base/'tavern'
            self.assertEqual(install_fixture(base,success=True),['preflight','stop','verify'])
            transaction_file=root/'tavern-updates/transaction.json'
            transaction=json.loads(transaction_file.read_text())
            self.assertEqual(transaction['status'],'committed')
            self.assertEqual(json.loads((root/'tavern-updates/installed.json').read_text())['commit'],'a'*40)
            backup=Path(transaction['backup'])
            receipt=backup/'nora-update-backup.json'
            self.assertEqual(json.loads(receipt.read_text())['status'],'committed')
            metadata=transaction['recoveryPlan']['metadata']
            self.assertEqual(set(metadata),{'host','agents-rollback','managed'})
            for name,expected in metadata.items():
                self.assertTrue((backup/name).is_dir(),name)
                self.assertEqual(recovery.digest(backup/name),expected,name)
            self.assertEqual((backup/'agents-rollback/AGENTS.md').read_text(),'old agents')
            previous={path:path.read_bytes() for path in (transaction_file,receipt)}
            self.assertEqual(recovery.load(home,root).record['status'],'committed')
            effects=recovery.effects(home,root)
            self.assertEqual(effects['effectState'],'changed')
            self.assertEqual(effects['status'],'committed')
            self.assertEqual(effects['reason'],'')
            self.assertFalse(effects['canRecover'])
            self.assertEqual(recovery.assess(home,root),
                             {'canRecover':False,'reason':'更新已提交，无需恢复'})
            self.assertEqual({path:path.read_bytes() for path in previous},previous)

    def test_real_install_automatic_recovery_restores_before_reporting_failure(self):
        with tempfile.TemporaryDirectory(prefix='nora-managed-update-recovery-') as temporary:
            base=Path(temporary).resolve()
            with self.assertRaisesRegex(RuntimeError,'new runtime failed; recovery=restored'):
                install_fixture(base)
            root=base/'tavern'
            transaction=json.loads((root/'tavern-updates/transaction.json').read_text())
            self.assertEqual(transaction['status'],'restored')
            self.assertEqual((root/'apps/tavern-runtime/program.txt').read_text(),'old program')
            self.assertEqual((root/'tavern-state/native/default-user/chats/story.jsonl').read_text(),'old story')
            self.assertEqual((base/'hermes/SOUL.md').read_text(),'old soul')
            self.assertEqual(json.loads((root/'tavern-updates/installed.json').read_text())['version'],'2.3.17')

    def test_real_install_process_death_after_new_rename_can_restore_from_journal(self):
        with tempfile.TemporaryDirectory(prefix='nora-managed-update-interrupted-') as temporary:
            base=Path(temporary).resolve()
            process=multiprocessing.get_context('spawn').Process(target=install_fixture,args=(str(base),),kwargs={'interrupt':True})
            process.start();process.join(20)
            if process.is_alive():process.terminate();process.join();self.fail('isolated update worker did not finish')
            self.assertEqual(process.exitcode,91)
            root=base/'tavern';home=base/'hermes'
            transaction=json.loads((root/'tavern-updates/transaction.json').read_text())
            self.assertEqual(transaction['status'],'prepared')
            self.assertEqual(transaction['recoveryPlan']['targets'][0]['phase'],'installing-new')
            self.assertEqual((root/'apps/tavern-runtime/program.txt').read_text(),'new program')
            self.assertTrue(recovery.assess(home,root)['canRecover'])
            recovery.recover(home,root,stop=lambda *_:{'offline':True},resume=lambda *_:None,
                             verify=lambda plan,_:dict(plan['before']))
            self.assertEqual((root/'apps/tavern-runtime/program.txt').read_text(),'old program')
            self.assertEqual((root/'tavern-state/native/default-user/chats/story.jsonl').read_text(),'old story')
            self.assertEqual((home/'SOUL.md').read_text(),'old soul')


class DigestProgressTests(unittest.TestCase):
    def test_digest_progress_preserves_original_tree_hash_and_reports_actual_chunks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'a-empty').write_bytes(b'');(root/'nested').mkdir()
            (root/'nested/big').write_bytes(b'x'*(1024*1024+7));(root/'nested/small').write_bytes(b'end')
            expected='f3ba1b2f46141fad5063c213f451a57ef5abac3ce5fe1e93f2e18c386da8358b'
            self.assertEqual(recovery.digest(root),expected)
            progress=[]
            self.assertEqual(recovery.digest(root,on_progress=lambda size,entries:progress.append((size,entries))),expected)
            self.assertEqual(progress,[(0,1),(0,1),(0,1),(0,1),(1024*1024,0),(7,0),(0,1),(3,0)])
            self.assertEqual((root/'nested/big').read_bytes(),b'x'*(1024*1024+7))
            progress=[]
            empty=root/'empty';empty.mkdir()
            self.assertEqual(recovery.digest(empty,on_progress=lambda size,entries:progress.append((size,entries))),recovery.digest(empty))
            self.assertEqual(progress,[(0,1)])

    def test_digest_progress_reports_no_bytes_for_a_failed_read(self):
        with tempfile.TemporaryDirectory() as temporary:
            file=Path(temporary)/'program';file.write_bytes(b'read must succeed before counting')
            progress=[]
            with patch.object(Path,'open',side_effect=OSError('read failed')):
                with self.assertRaisesRegex(OSError,'read failed'):
                    recovery.digest(file,on_progress=lambda size,entries:progress.append((size,entries)))
            self.assertEqual(progress,[(0,1)])

    def test_digest_progress_confirms_links_only_after_hashing_the_link_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);outside=root/'outside';outside.write_bytes(b'not followed')
            link=root/'link';link.symlink_to('outside');progress=[]
            self.assertEqual(recovery.digest(link,on_progress=lambda size,entries:progress.append((size,entries))),recovery.digest(link))
            self.assertEqual(progress,[(0,1)])
            progress=[]
            with patch.object(os,'readlink',side_effect=OSError('link read failed')):
                with self.assertRaisesRegex(OSError,'link read failed'):
                    recovery.digest(link,on_progress=lambda size,entries:progress.append((size,entries)))
            self.assertEqual(progress,[])


class CronMetadataClassificationTests(unittest.TestCase):
    def test_only_proven_unbounded_run_state_is_exempt_from_definition_digest(self):
        original={'jobs':[{'id':'daily','script':'private-task.py','prompt':'private-fixture',
            'enabled':True,'paused_at':None,'schedule':{'kind':'cron','expr':'0 9 * * *'},
            'state':'scheduled','repeat':{'times':None,'completed':0},'fire_claim':{'by':'scheduler'}}],
            'updated_at':'before'}
        mutations={
            'runtime':lambda item:item['jobs'][0].update(last_run_at='now',last_status='ok',fire_claim=None,
                next_run_at='later',state='error',repeat={'times':None,'completed':1}),
            'script':lambda item:item['jobs'][0].update(script='other.py'),
            'schedule':lambda item:item['jobs'][0].update(schedule={'kind':'cron','expr':'0 8 * * *'}),
            'enabled':lambda item:item['jobs'][0].update(enabled=False),
            'paused':lambda item:item['jobs'][0].update(state='paused'),
            'unknown-running':lambda item:item['jobs'][0].update(state='running'),
            'identity':lambda item:item['jobs'][0].update(id='different'),
            'unknown':lambda item:item['jobs'][0].update(new_user_field='private'),
            'top-level':lambda item:item.update(new_config='private'),
        }
        with tempfile.TemporaryDirectory(prefix='nora-cron-definition-') as temporary:
            path=Path(temporary)/'jobs.json';path.write_text(json.dumps(original))
            before=recovery.cron_definition(path)
            for name,mutate in mutations.items():
                with self.subTest(name=name):
                    candidate=json.loads(json.dumps(original));candidate['updated_at']='after';mutate(candidate)
                    path.write_text(json.dumps(candidate))
                    self.assertEqual(recovery.cron_definition(path)==before,name=='runtime')

    def test_finite_repeat_budget_and_malformed_or_duplicate_tasks_stay_protected(self):
        with tempfile.TemporaryDirectory(prefix='nora-cron-definition-invalid-') as temporary:
            path=Path(temporary)/'jobs.json'
            finite={'jobs':[{'id':'daily','enabled':True,'schedule':{'kind':'cron'},
                            'state':'scheduled','repeat':{'times':2,'completed':0}}]}
            path.write_text(json.dumps(finite));before=recovery.cron_definition(path)
            finite['jobs'][0]['repeat']['completed']=1;path.write_text(json.dumps(finite))
            self.assertNotEqual(recovery.cron_definition(path),before)
            for invalid in [[],{}, {'jobs':[{'id':'daily'},{'id':'daily'}]}, {'jobs':[{'id':None}]}]:
                with self.subTest(invalid=invalid):
                    path.write_text(json.dumps(invalid))
                    with self.assertRaises(ValueError):recovery.cron_definition(path)
            path.write_text('incomplete private-fixture')
            with self.assertRaises(ValueError):recovery.cron_definition(path)


class InterruptedRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nora-recovery-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.home = self.base / 'hermes'
        self.root = self.base / 'tavern'
        self.home.mkdir(); self.root.mkdir()
        self.backup = self.root / 'tavern-backups/owned-backup'
        self.backup.mkdir(parents=True)
        (self.backup / 'host/update-receipts').mkdir(parents=True)
        (self.backup / 'host/update-receipts/installed.json').write_text('{"version":"2.3.17"}')
        (self.backup / 'agents-rollback').mkdir()
        (self.backup / 'host/config.yaml').write_text('old config')
        (self.backup / 'agents-rollback/AGENTS.md').write_text('old instructions')
        (self.home / 'config.yaml').write_text('failed version config')
        (self.home / 'AGENTS.md').write_text('failed version instructions')
        (self.backup / 'nora-update-backup.json').write_text(json.dumps({
            'schema':'nora-update-backup/1', 'owner':'nora-tavern-updater',
            'installRoot':str(self.root),'backupId':self.backup.name,'status':'prepared'}))
        self.old = self.root / 'apps/tavern-runtime'
        self.old.mkdir(parents=True)
        (self.old / 'program.txt').write_text('old program')
        self.new = self.base / 'prepared'
        self.new.mkdir(); (self.new / 'program.txt').write_text('new program')
        self.state = self.root / 'tavern-state'
        self.state.mkdir(); (self.state / 'chat.txt').write_text('old chat')
        self.before = {'version':'2.3.17','running':True,'gatewayRunning':False,'clawchatConnected':False}
        self.stop_calls = []; self.resume_calls = []

    def journal(self, *, state=True, metadata_changes=True):
        journal=recovery.Journal.create(self.home, self.root, self.backup,
            [('app',self.new,self.old)], version='2.4.2', before=self.before,
            state=self.state if state else None)
        if metadata_changes:
            journal.plan['metadataPhase']='applying'
            journal.plan['metadataIntents']=[journal.metadata_key(target) for target,_ in journal.metadata_items()]
            journal.finish_metadata([target for target,_ in journal.metadata_items()])
        return journal

    def committed_journal(self):
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        journal.save('committed')
        load_updater().record_backup(self.root,self.backup,'committed')
        return journal

    def long_cache_file(self):
        directory=self.state/'native/_cache/nora-assets-v3/extensions/JS-Slash-Runner/package'
        while len(str(directory/'asset.woff2'))<=280:
            directory=directory/'nested-assets-0123456789'
        physical=Path(first_install.filesystem_path(directory))
        physical.mkdir(parents=True)
        (physical/'asset.woff2').write_bytes(b'cached font bytes')
        return directory/'asset.woff2'

    def test_independent_io_path_matches_installer_windows_namespace(self):
        cases=(r'C:\Nora Tavern\cache\..\source', r'\\server\share\Nora\source',
               r'\\?\C:\Nora\source', r'\\?\UNC\server\share\Nora')
        # PureWindowsPath tests conversion on any host without performing Win32 I/O.
        with patch.object(recovery.os,'name','nt'),patch.object(recovery,'Path',PureWindowsPath):
            for value in cases:
                self.assertEqual(str(recovery._io_path(value)),first_install.filesystem_path(value))

    def exercise_long_path_recovery(self,file):
        document=file.with_name('manifest.json')
        Path(first_install.filesystem_path(document)).write_text('{"retained":true}')
        self.assertEqual(recovery.read(document),{'retained':True})
        # Exercise a managed directory snapshot as well as the state cache.
        managed=self.backup/'managed';directory=managed/'targets/clawchat-skills'
        while len(str(directory/'skill.json'))<=280:directory=directory/'nested-skills-0123456789'
        physical=Path(first_install.filesystem_path(directory));physical.mkdir(parents=True)
        (physical/'skill.json').write_text('{"managed":"original"}')
        (managed/'snapshot.json').write_text('[{"path":"clawchat-skills","existed":true}]')
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        self.run_recover();self.assert_restored()
        self.assertEqual(Path(first_install.filesystem_path(file)).read_bytes(),b'cached font bytes')
        record=json.loads((self.root/'tavern-updates/transaction.json').read_text())
        self.assertEqual(record['backup'],str(self.backup))
        self.assertEqual(record['recoveryPlan']['installRoot'],str(self.root))
        self.assertEqual(record['recoveryPlan']['hermesHome'],str(self.home))
        self.assertNotIn('\\\\?\\',json.dumps(record))
        relative=directory.relative_to(managed/'targets/clawchat-skills')/'skill.json'
        self.assertEqual(recovery.read(self.home/'clawchat-skills'/relative),{'managed':'original'})

    @unittest.skipIf(os.name=='nt','Windows runs the real extended-path regression below')
    def test_long_path_recovery_with_legacy_stat_limit(self):
        file=self.long_cache_file()
        # A short alias stands in for Win32's extended-path namespace locally;
        # all bytes, copies, journal loading and recovery remain real filesystem I/O.
        with tempfile.TemporaryDirectory(prefix='nora-path-',dir='/tmp') as temporary:
            alias=Path(temporary)/'io';alias.symlink_to(self.base,target_is_directory=True)
            original_lstat=Path.lstat;original_stat=Path.stat
            def guarded(operation):
                def call(path,*args,**kwargs):
                    if path.is_relative_to(self.base) and len(str(path))>260:
                        raise FileNotFoundError(3,'simulated legacy Win32 path limit',str(path))
                    return operation(path,*args,**kwargs)
                return call
            def physical(path):
                path=Path(path)
                # The alias emulates the extended namespace for descendants.
                # The logical Nora root itself remains the original directory;
                # mapping it to the alias symlink would invent a redirected
                # installation root absent from Windows extended-path I/O.
                if path==self.base:return path
                return alias/path.relative_to(self.base) if path.is_relative_to(self.base) else path
            with patch.object(Path,'lstat',guarded(original_lstat)), \
                    patch.object(Path,'stat',guarded(original_stat)), \
                    patch.object(recovery,'_io_path',side_effect=physical,create=True):
                self.exercise_long_path_recovery(file)

    @unittest.skipUnless(os.name=='nt','requires actual Windows extended-path I/O')
    def test_windows_long_path_snapshot_and_recovery(self):
        # Cleanup must work even with LongPathsEnabled=0, as in the release CI.
        self.addCleanup(lambda:shutil.rmtree(first_install.filesystem_path(self.base),ignore_errors=False)
                        if Path(first_install.filesystem_path(self.base)).exists() else None)
        self.exercise_long_path_recovery(self.long_cache_file())

    def run_recover(self, *, resume=None):
        return recovery.recover(self.home,self.root,
            stop=lambda *_:(self.stop_calls.append(True) or {'offline':True}),
            resume=resume or (lambda *_:self.resume_calls.append(True)),
            verify=lambda *_:dict(self.before))

    def assert_restored(self):
        self.assertEqual((self.old/'program.txt').read_text(),'old program')
        self.assertEqual((self.state/'chat.txt').read_text(),'old chat')
        self.assertEqual((self.home/'config.yaml').read_text(),'old config')
        self.assertEqual((self.home/'AGENTS.md').read_text(),'old instructions')
        self.assertEqual(json.loads((self.root/'tavern-updates/transaction.json').read_text())['status'],'restored')

    def interrupt_replace(self, operation, wanted):
        replace = recovery.os.replace
        def abrupt(source, target):
            replace(source,target)
            if Path(first_install.filesystem_path(target)) == Path(first_install.filesystem_path(wanted)):
                raise KeyboardInterrupt('simulated hard interruption after rename')
        with patch.object(recovery.os,'replace',side_effect=abrupt):
            with self.assertRaises(KeyboardInterrupt): operation()

    def test_interrupted_after_old_swap_rename_restores_without_new_target(self):
        journal=self.journal(); journal.snapshot_state()
        self.interrupt_replace(lambda:journal.swap('app'),self.backup/'trees/app')
        self.assertFalse(self.old.exists())
        self.run_recover(); self.assert_restored()

    def test_interrupted_after_new_swap_rename_restores_before_journal_advances(self):
        journal=self.journal(); journal.snapshot_state()
        self.interrupt_replace(lambda:journal.swap('app'),self.old)
        self.run_recover(); self.assert_restored()
        self.assertEqual((self.backup/'failed-new/app/program.txt').read_text(),'new program')

    def test_interrupted_after_failed_target_rename_is_idempotent(self):
        journal=self.journal(); journal.snapshot_state(); journal.swap('app')
        self.interrupt_replace(self.run_recover,self.backup/'failed-new/app')
        self.run_recover(); self.assert_restored()

    def test_interrupted_after_old_restore_rename_preserves_restored_inode(self):
        journal=self.journal(); journal.snapshot_state(); journal.swap('app')
        self.interrupt_replace(self.run_recover,self.old)
        inode=self.old.stat().st_ino
        self.run_recover(); self.assert_restored()
        self.assertEqual(self.old.stat().st_ino,inode)

    def interrupt_metadata_restore(self,point,*,legacy=False):
        target=self.home/'config.yaml';saved=self.backup/'host/config.yaml'
        shutil.copy2(saved,target)
        shutil.copy2(self.backup/'agents-rollback/AGENTS.md',self.home/'AGENTS.md')
        journal=self.journal(metadata_changes=False)
        journal.mark_metadata([target]);target.write_text('owned failed configuration');journal.finish_metadata([target])
        if legacy:journal.plan.pop('metadataWrites');journal.save()
        journal.snapshot_state();journal.swap('app')
        interruptions=[]
        if point=='move':
            replace=recovery.os.replace
            def interrupt(source,destination):
                replace(source,destination)
                if Path(first_install.filesystem_path(source))==Path(first_install.filesystem_path(target)):
                    interruptions.append(point)
                    raise KeyboardInterrupt('metadata move completed')
            context=patch.object(recovery.os,'replace',side_effect=interrupt)
        else:
            copy=recovery.shutil.copy2
            def interrupt(source,destination,*args,**kwargs):
                if Path(first_install.filesystem_path(source))==Path(first_install.filesystem_path(saved)):
                    if point=='copied':copy(source,destination,*args,**kwargs)
                    interruptions.append(point)
                    raise KeyboardInterrupt('metadata copy interrupted')
                return copy(source,destination,*args,**kwargs)
            context=patch.object(recovery.shutil,'copy2',side_effect=interrupt)
        with context:
            with self.assertRaises(KeyboardInterrupt):self.run_recover()
        self.assertEqual(interruptions,[point])
        self.assertFalse(target.exists())
        return journal,target

    def test_metadata_restore_retry_after_owned_archive_move_restores_original_configuration(self):
        self.interrupt_metadata_restore('move');self.run_recover();self.assert_restored()

    def test_metadata_restore_retry_before_copy_restores_original_configuration(self):
        self.interrupt_metadata_restore('copy');self.run_recover();self.assert_restored()

    def test_metadata_restore_retry_after_copy_before_replace_restores_original_configuration(self):
        self.interrupt_metadata_restore('copied');self.run_recover();self.assert_restored()

    def test_legacy_schema_one_metadata_restore_checkpoint_can_resume_its_owned_move(self):
        self.interrupt_metadata_restore('move',legacy=True);self.run_recover();self.assert_restored()

    def test_metadata_restore_checkpoint_cannot_overwrite_a_new_unknown_user_file(self):
        _,target=self.interrupt_metadata_restore('move')
        target.write_text('new private user configuration after interrupted recovery')
        with self.assertRaisesRegex(RuntimeError,'当前配置已保留'):self.run_recover()
        self.assertEqual(target.read_text(),'new private user configuration after interrupted recovery')

    def test_metadata_restore_retry_rejects_changed_owned_archive(self):
        journal,target=self.interrupt_metadata_restore('move')
        entry=json.loads(journal.file.read_text())['recoveryPlan']['metadataRestores']['hermes:config.yaml']
        (self.backup/entry['archive']).write_text('modified failed output')
        with self.assertRaisesRegex(RuntimeError,'配置恢复归档'):self.run_recover()
        self.assertFalse(target.exists())

    def test_metadata_restore_retry_rejects_same_bytes_under_a_different_archive_identity(self):
        journal,target=self.interrupt_metadata_restore('move')
        entry=json.loads(journal.file.read_text())['recoveryPlan']['metadataRestores']['hermes:config.yaml']
        archive=self.backup/entry['archive'];replacement=self.base/'replacement'
        replacement.write_bytes(archive.read_bytes());os.replace(replacement,archive)
        with self.assertRaisesRegex(RuntimeError,'配置恢复归档'):self.run_recover()
        self.assertFalse(target.exists())

    def test_service_restore_failure_can_retry_without_replacing_old_files(self):
        journal=self.journal(); journal.snapshot_state(); journal.swap('app')
        def fail(*_): raise RuntimeError('service restore failed')
        with self.assertRaisesRegex(RuntimeError,'service restore failed'):self.run_recover(resume=fail)
        inode=self.old.stat().st_ino
        self.run_recover(); self.assert_restored()
        self.assertEqual(self.old.stat().st_ino,inode)

    def test_recovery_requires_explicit_offline_proof_before_restoring_files(self):
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        with self.assertRaisesRegex(RuntimeError,'停止状态'):
            recovery.recover(self.home,self.root,stop=lambda *_:{'running':False},
                             resume=lambda *_:self.resume_calls.append(True),verify=lambda *_:dict(self.before))
        self.assertEqual((self.old/'program.txt').read_text(),'new program')
        self.assertEqual(self.resume_calls,[])

    def test_recovery_missing_service_facts_are_not_treated_as_stopped(self):
        self.before.update(running=False,gatewayRunning=False)
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        with self.assertRaisesRegex(RuntimeError,'服务状态'):
            recovery.recover(self.home,self.root,stop=lambda *_:{'offline':True},resume=lambda *_:None,
                             verify=lambda *_:{'version':self.before['version']})

    def test_successful_start_may_change_managed_code_without_false_recovery_failure(self):
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        def start(*_): (self.old/'generated.txt').write_text('runtime generated file')
        result=recovery.recover(self.home,self.root,stop=lambda *_:{'offline':True},resume=start,
                                verify=lambda *_:dict(self.before))
        self.assertEqual(result['status'],'restored')
        self.assertEqual((self.old/'generated.txt').read_text(),'runtime generated file')

    def test_user_config_change_before_first_write_is_retained_during_recovery(self):
        journal=self.journal(metadata_changes=False)
        (self.home/'config.yaml').write_text('user changed config after preparation')
        with self.assertRaises(RuntimeError) as raised: journal.seal_offline({'offline':True})
        self.assertEqual(raised.exception.code,'CONDITIONS_CHANGED')
        self.run_recover()
        self.assertEqual((self.home/'config.yaml').read_text(),'user changed config after preparation')

    def cron_journal(self):
        # Only the gateway's run bookkeeping changes while services stop.
        # The task definition and all user configuration remain unchanged.
        for name, saved in [('config.yaml','host/config.yaml'),('AGENTS.md','agents-rollback/AGENTS.md')]:
            shutil.copy2(self.backup/saved,self.home/name)
        (self.root/'tavern-updates').mkdir()
        shutil.copy2(self.backup/'host/update-receipts/installed.json',self.root/'tavern-updates/installed.json')
        cron=self.home/'cron/jobs.json';cron.parent.mkdir()
        prepared={'jobs':[{'id':'daily','script':'nora-tavern-update-check.py',
            'schedule':{'kind':'cron','expr':'0 9 * * *'},'enabled':True,'state':'scheduled',
            'run_claim':{'by':'fixture-gateway'},'last_run_at':None}], 'updated_at':'before-stop'}
        cron.write_text(json.dumps(prepared))
        first_install.snapshot_targets(self.home,[cron],self.backup/'managed')
        journal=self.journal(state=False,metadata_changes=False)
        offline={'jobs':[{**prepared['jobs'][0],'run_claim':None,'last_run_at':'2026-10-11T02:00:00Z',
            'last_status':'ok','next_run_at':'2026-10-12T01:00:00Z'}], 'updated_at':'after-stop'}
        cron.write_text(json.dumps(offline))
        return journal,cron,offline

    def test_offline_cron_runtime_updates_keep_task_definitions_and_latest_state_on_recovery(self):
        journal,cron,offline=self.cron_journal()
        journal.seal_offline({'offline':True})
        journal.mark_metadata([cron]);journal.swap('app')
        self.run_recover()
        self.assertEqual(json.loads(cron.read_text()),offline)
        self.assertEqual(len(journal.metadata_diagnostics()),1)
        self.assertIn('classification=runtime-state-only',journal.metadata_diagnostics()[0])
        self.assertNotIn(str(self.home),journal.metadata_diagnostics()[0])

    def test_runtime_snapshot_tampering_is_rejected_before_service_or_file_changes(self):
        journal,cron,_=self.cron_journal();journal.seal_offline({'offline':True})
        (self.backup/'runtime-state/cron-jobs.json').write_text('{"jobs":[]}')
        with self.assertRaisesRegex(RuntimeError,'运行状态恢复快照'):self.run_recover()
        self.assertEqual(self.stop_calls,[])
        self.assertEqual((self.old/'program.txt').read_text(),'old program')

    def test_cron_definition_change_is_rejected_and_unknown_user_content_survives_recovery(self):
        journal,cron,offline=self.cron_journal()
        offline['jobs'][0]['script']='user-selected-script.py'
        offline['jobs'][0]['prompt']='private user task secret-fixture'
        cron.write_text(json.dumps(offline))
        with self.assertRaises(RuntimeError) as raised:journal.seal_offline({'offline':True})
        self.assertEqual(raised.exception.code,'CONDITIONS_CHANGED')
        self.assertIn('path=hermes:cron/jobs.json',str(raised.exception))
        self.assertIn('type=task-definitions-and-runtime-state',str(raised.exception))
        self.assertNotIn('private user task',str(raised.exception))
        self.run_recover()
        self.assertEqual(json.loads(cron.read_text()),offline)

    def test_cron_definition_changed_after_updater_write_is_not_overwritten_by_recovery(self):
        journal,cron,offline=self.cron_journal();journal.seal_offline({'offline':True})
        journal.mark_metadata([cron])
        changed={**offline,'jobs':[{**offline['jobs'][0],'script':'new-updater-script.py'}]}
        cron.write_text(json.dumps(changed));journal.finish_metadata([cron])
        changed['jobs'][0]['script']='user-edited-after-update.py'
        cron.write_text(json.dumps(changed));journal.swap('app')
        with self.assertRaisesRegex(RuntimeError,'当前配置已保留'):self.run_recover()
        self.assertEqual(json.loads(cron.read_text()),changed)

    def test_unreceipted_deletion_is_not_assumed_to_be_an_owned_writer_output(self):
        journal,cron,_=self.cron_journal();journal.seal_offline({'offline':True})
        journal.mark_metadata([cron]);cron.unlink();journal.swap('app')
        with self.assertRaisesRegex(RuntimeError,'当前配置已保留'):self.run_recover()
        self.assertFalse(cron.exists())

    def test_interrupted_partial_owned_write_preserves_unknown_current_bytes_and_original_backup(self):
        journal,cron,_=self.cron_journal();journal.seal_offline({'offline':True})
        journal.mark_metadata([cron]);journal.swap('app')
        original=(self.backup/'managed/targets/cron/jobs.json').read_bytes()
        partial=b'{"jobs": [uncompleted writer output'
        cron.write_bytes(partial)
        with self.assertRaisesRegex(RuntimeError,'未归属的变化'):self.run_recover()
        self.assertEqual(cron.read_bytes(),partial)
        self.assertEqual((self.backup/'managed/targets/cron/jobs.json').read_bytes(),original)
        self.assertEqual(json.loads(journal.file.read_text())['status'],'recovery-failed')

    def test_schema_one_legacy_journal_without_write_receipts_keeps_existing_recovery_contract(self):
        journal=self.journal();journal.plan.pop('metadataWrites');journal.save()
        journal.snapshot_state();journal.swap('app');self.run_recover();self.assert_restored()

    def test_retry_after_metadata_restored_does_not_overwrite_new_user_configuration(self):
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        with self.assertRaisesRegex(RuntimeError,'service restore failed'):
            self.run_recover(resume=lambda *_:(_ for _ in ()).throw(RuntimeError('service restore failed')))
        (self.home/'config.yaml').write_text('user changed config while recovery waits')
        self.run_recover()
        self.assertEqual((self.home/'config.yaml').read_text(),'user changed config while recovery waits')

    def test_pending_code_snapshot_is_sealed_after_offline_without_changing_identity(self):
        journal=self.journal(state=False,metadata_changes=False)
        # This simulates an ordinary file generated before service stop. It is
        # updater-managed code, while user configuration remains authoritative.
        (self.old/'generated.txt').write_text('generated before stop')
        (self.home/'config.yaml').write_text('old config')
        (self.home/'AGENTS.md').write_text('old instructions')
        (self.root/'tavern-updates/installed.json').write_text('{"version":"2.3.17"}')
        journal.seal_offline({'offline':True});journal.swap('app');self.run_recover()
        self.assertEqual((self.old/'generated.txt').read_text(),'generated before stop')

    def test_effects_require_trusted_intents_instead_of_nonterminal_status_alone(self):
        journal=self.journal(metadata_changes=False)
        self.assertEqual(recovery.effects(self.home,self.root)['effectState'],'untouched')
        journal.swap('app')
        self.assertEqual(recovery.effects(self.home,self.root)['effectState'],'changed')
        self.run_recover()
        self.assertEqual(recovery.effects(self.home,self.root)['effectState'],'restored')
        record=json.loads(journal.file.read_text());record['recoveryPlan']['targets'][0]['phase']='invented';journal.file.write_text(json.dumps(record))
        self.assertEqual(recovery.effects(self.home,self.root)['effectState'],'unknown')

    def test_effects_do_not_authorize_a_prepared_record_with_changed_backup_bytes(self):
        self.journal(metadata_changes=False)
        (self.backup/'host/config.yaml').write_text('tampered backup')
        self.assertEqual(recovery.effects(self.home,self.root)['effectState'],'unknown')

    def test_committed_backup_can_be_observed_but_never_recovered(self):
        journal=self.committed_journal()
        receipt=self.backup/'nora-update-backup.json'
        self.assertEqual(json.loads(receipt.read_text())['status'],'committed')
        previous={path:path.read_bytes() for path in (journal.file,receipt,
            self.old/'program.txt',self.state/'chat.txt',self.home/'config.yaml')}
        self.assertEqual(recovery.load(self.home,self.root).record['status'],'committed')
        effects=recovery.effects(self.home,self.root)
        self.assertEqual(effects['effectState'],'changed')
        self.assertEqual(effects['status'],'committed')
        self.assertEqual(effects['reason'],'')
        self.assertFalse(effects['canRecover'])
        self.assertEqual(recovery.assess(self.home,self.root),
                         {'canRecover':False,'reason':'更新已提交，无需恢复'})
        with self.assertRaisesRegex(RuntimeError,'更新已提交，无需恢复'):self.run_recover()
        self.assertEqual(self.stop_calls,[]);self.assertEqual(self.resume_calls,[])
        self.assertEqual({path:path.read_bytes() for path in previous},previous)

    def test_committed_backup_tampering_still_refuses_before_stop(self):
        for mode in ('receipt','config','program','state'):
            with self.subTest(mode=mode):
                self.setUp();journal=self.committed_journal()
                self.assertEqual(recovery.effects(self.home,self.root)['effectState'],'changed')
                if mode=='receipt':
                    receipt=self.backup/'nora-update-backup.json'
                    record=json.loads(receipt.read_text());record['owner']='unknown-updater'
                    receipt.write_text(json.dumps(record))
                elif mode=='config':(self.backup/'host/config.yaml').write_text('tampered backup')
                elif mode=='program':(self.backup/'trees/app/program.txt').write_text('tampered backup')
                else:(self.backup/'state/chat.txt').write_text('tampered backup')
                effects=recovery.effects(self.home,self.root)
                self.assertEqual(effects['effectState'],'unknown')
                self.assertFalse(effects['canRecover'])
                self.assertIn('备份',effects['reason'])
                previous=journal.file.read_bytes()
                with self.assertRaisesRegex(RuntimeError,'备份'):self.run_recover()
                self.assertEqual(self.stop_calls,[]);self.assertEqual(self.resume_calls,[])
                self.assertEqual(journal.file.read_bytes(),previous)
                self.assertEqual((self.old/'program.txt').read_text(),'new program')
                self.assertEqual((self.state/'chat.txt').read_text(),'old chat')

    def test_recovery_never_overwrites_configuration_without_its_write_intent(self):
        journal=self.journal(metadata_changes=False);journal.swap('app')
        (self.home/'config.yaml').write_text('latest user-owned configuration')
        self.run_recover()
        self.assertEqual((self.home/'config.yaml').read_text(),'latest user-owned configuration')

    def test_failed_checkpoint_save_does_not_replace_recovery_primary_error(self):
        journal=self.journal();journal.swap('app')
        original_save=recovery.Journal.save
        def save(journal,status=None):
            if journal.record.get('error'): raise PermissionError('checkpoint write denied')
            return original_save(journal,status)
        failure=RuntimeError('actual service recovery failure')
        with patch.object(recovery.Journal,'save',save):
            with self.assertRaises(RuntimeError) as raised:
                recovery.recover(self.home,self.root,stop=lambda *_:{'offline':True},
                    resume=lambda *_:(_ for _ in ()).throw(failure),verify=lambda *_:dict(self.before))
        self.assertIs(raised.exception,failure)
        self.assertIsInstance(failure.secondary_errors[0],PermissionError)

    def test_partial_state_snapshot_keeps_original_state(self):
        journal=self.journal(); journal.swap('app')
        journal.plan['state']['phase']='copying';journal.save()
        (self.backup/'state').mkdir();(self.backup/'state/partial').write_text('partial')
        self.run_recover(); self.assert_restored()
        self.assertEqual((self.backup/'state/partial').read_text(),'partial')

    def test_state_archive_interruption_restores_snapshot_exactly(self):
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        (self.state/'chat.txt').write_text('changed by new runtime')
        self.interrupt_replace(self.run_recover,self.backup/'failed-new/state')
        self.run_recover();self.assert_restored()
        self.assertEqual((self.backup/'failed-new/state/chat.txt').read_text(),'changed by new runtime')

    def test_tampered_or_missing_backup_refuses_before_stop(self):
        for mode in ('receipt','program','missing','path'):
            with self.subTest(mode=mode):
                self.setUp()
                journal=self.journal();journal.snapshot_state();journal.swap('app')
                if mode=='receipt':(self.backup/'nora-update-backup.json').write_text('{}')
                if mode=='program':(self.backup/'trees/app/program.txt').write_text('tampered')
                if mode=='missing':(self.backup/'trees/app/program.txt').unlink()
                if mode=='path':
                    journal.plan['targets'][0]['relative']='../../outside';journal.save()
                with self.assertRaises(RuntimeError):self.run_recover()
                self.assertEqual(self.stop_calls,[])
                self.assertEqual((self.old/'program.txt').read_text(),'new program')

    def test_unknown_target_identity_refuses_without_deleting_it(self):
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        outside=self.base/'outside'; self.old.rename(outside)
        self.old.mkdir();(self.old/'program.txt').write_text('unknown program')
        with self.assertRaises(RuntimeError):self.run_recover()
        self.assertEqual((self.old/'program.txt').read_text(),'unknown program')
        self.assertEqual(self.stop_calls,[])

    def test_old_schema_without_recovery_plan_stays_blocked(self):
        target=self.root/'tavern-updates/transaction.json';target.parent.mkdir()
        target.write_text(json.dumps({'schema':1,'status':'prepared','backup':str(self.backup),'version':'2.4.1'}))
        with self.assertRaisesRegex(RuntimeError,'恢复计划'):self.run_recover()
        self.assertEqual(self.stop_calls,[])

    def test_terminal_and_unknown_states_are_never_offered_or_rewritten(self):
        for status in ('committed','restored','unexpected',None):
            with self.subTest(status=status):
                self.setUp();journal=self.journal();journal.save(status)
                if status is None:
                    journal.record.pop('status');journal.save()
                previous=journal.file.read_bytes();callbacks=[]
                self.assertFalse(recovery.assess(self.home,self.root)['canRecover'])
                with self.assertRaises(RuntimeError):
                    recovery.recover(self.home,self.root,stop=lambda *_:(callbacks.append('stop') or {'offline':True}),
                        resume=lambda *_:callbacks.append('resume'),verify=lambda *_:callbacks.append('verify'))
                self.assertEqual(callbacks,[])
                self.assertEqual(journal.file.read_bytes(),previous)

    def test_prepared_and_failed_states_use_the_same_real_restore_contract(self):
        for status in ('prepared','recovery-failed'):
            with self.subTest(status=status):
                self.setUp();journal=self.journal();journal.snapshot_state();journal.swap('app');journal.save(status)
                self.assertTrue(recovery.assess(self.home,self.root)['canRecover'])
                self.run_recover();self.assert_restored()

    def test_nonobject_records_and_targets_refuse_before_stop(self):
        for mode in ('record','receipt','installed','targets','target','state','lifecycle'):
            with self.subTest(mode=mode):
                self.setUp();journal=self.journal();journal.snapshot_state();journal.swap('app')
                if mode=='record':recovery.atomic_json(journal.file,[])
                elif mode=='receipt':recovery.atomic_json(self.backup/'nora-update-backup.json',None)
                elif mode=='installed':recovery.atomic_json(self.backup/'host/update-receipts/installed.json',[])
                else:
                    journal.plan[mode if mode!='target' else 'targets']={
                        'targets':{},'target':[None],'state':[],'lifecycle':[]}[mode]
                    journal.save()
                self.assertFalse(recovery.assess(self.home,self.root)['canRecover'])
                with self.assertRaises(RuntimeError):self.run_recover()
                self.assertEqual(self.stop_calls,[])

    def test_service_restart_damage_to_backups_ledgers_or_operations_is_rejected(self):
        for directory in ('backups','nora-story-ledger','nora-world-core/operations'):
            with self.subTest(directory=directory):
                self.setUp()
                document=self.state/'native/default-user'/directory/'saved.json'
                document.parent.mkdir(parents=True);document.write_text('original user data')
                journal=self.journal();journal.snapshot_state();journal.swap('app')
                def damage(*_):document.write_text('damaged during service restart')
                with self.assertRaisesRegex(RuntimeError,'剧情数据发生变化'):
                    self.run_recover(resume=damage)
                self.assertEqual(json.loads(journal.file.read_text())['status'],'recovery-failed')
                self.assertEqual((self.old/'program.txt').read_text(),'old program')

    def test_assessment_does_not_hash_program_or_state_trees(self):
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        with patch.object(recovery,'digest',side_effect=AssertionError('poll must not hash trees')):
            self.assertTrue(recovery.assess(self.home,self.root)['canRecover'])

    def test_large_self_written_transaction_is_readable_and_cap_preserves_checkpoint(self):
        journal=self.journal()
        journal.record['capacityFixture']='x'*(2*1024*1024)
        journal.save();previous=journal.file.read_bytes()
        self.assertGreater(len(previous),2*1024*1024)
        self.assertEqual(recovery.load(self.home,self.root).record['capacityFixture'],journal.record['capacityFixture'])
        self.assertTrue(recovery.assess(self.home,self.root)['canRecover'])
        with patch.object(recovery,'MAX_TRANSACTION_BYTES',len(previous)+100):
            journal.record['capacityFixture']+='y'*1000
            with self.assertRaisesRegex(RuntimeError,'容量'):
                journal.save('recovery-failed')
            self.assertEqual(journal.file.read_bytes(),previous)
            self.assertEqual(recovery.load(self.home,self.root).record['status'],'prepared')

    def test_windows_managed_snapshot_paths_restore_using_exact_whitelist(self):
        managed=self.backup/'managed'
        (managed/'targets/cron').mkdir(parents=True)
        (managed/'targets/scripts').mkdir()
        (managed/'targets/cron/jobs.json').write_text('old jobs')
        (managed/'targets/scripts/nora-instance.py').write_text('old script')
        records=[{'path':'cron\\jobs.json','existed':True},
                 {'path':'scripts\\nora-instance.py','existed':True}]
        (managed/'snapshot.json').write_text(json.dumps(records))
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        (self.home/'cron').mkdir();(self.home/'cron/jobs.json').write_text('new jobs')
        journal.finish_metadata([self.home/'cron/jobs.json'])
        recovery.recover(self.home,self.root,stop=lambda *_:{'offline':True},resume=lambda *_:None,
                         verify=lambda *_:dict(self.before))
        self.assertEqual((self.home/'cron/jobs.json').read_text(),'old jobs')
        self.assertEqual((self.home/'scripts/nora-instance.py').read_text(),'old script')
        self.assertEqual((managed/'targets/cron/jobs.json').read_text(),'old jobs')

    @unittest.skipIf(os.name=='nt','POSIX permission restoration')
    def test_identical_config_bytes_still_restore_original_permissions(self):
        saved=self.backup/'host/config.yaml';saved.write_text('same config');saved.chmod(0o600)
        active=self.home/'config.yaml';active.write_text('same config');active.chmod(0o644)
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        recovery.recover(self.home,self.root,stop=lambda *_:{'offline':True},resume=lambda *_:None,
                         verify=lambda *_:dict(self.before))
        self.assertEqual(active.stat().st_mode&0o777,0o600)

    def test_metadata_backup_link_is_rejected_before_stopping(self):
        managed=self.backup/'managed';(managed/'targets/clawchat-skills').mkdir(parents=True)
        (managed/'snapshot.json').write_text(json.dumps([{'path':'clawchat-skills','existed':True}]))
        outside=self.base/'outside-secret';outside.mkdir();(outside/'untouched').write_text('local-only')
        linked=managed/'targets/clawchat-skills/external'
        if os.name=='nt':
            import subprocess
            subprocess.run(['cmd.exe','/c','mklink','/J',str(linked),str(outside)],check=True,capture_output=True)
        else:linked.symlink_to(outside,target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError,'链接'):
            self.journal()
        self.assertEqual(self.stop_calls,[])
        self.assertEqual((outside/'untouched').read_text(),'local-only')

    def test_recovery_lock_conflicts_with_the_same_installer_lock(self):
        with recovery.recovery_lock(self.root):
            with self.assertRaisesRegex(RuntimeError,'更新.*正在进行'):
                with recovery.recovery_lock(self.root):pass
        with recovery.recovery_lock(self.root):pass

    def test_new_clawchat_connection_is_allowed_if_previously_disconnected(self):
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        recovery.recover(self.home,self.root,stop=lambda *_:{'offline':True},resume=lambda *_:None,
                         verify=lambda *_:{**self.before,'clawchatConnected':True})
        self.assert_restored()

    def test_managed_instance_port_and_original_service_plan_are_required(self):
        instance={'schema':1,'noraHome':str(self.base),'hermesHome':str(self.home),
                  'installRoot':str(self.root),'port':8799}
        (self.home/'nora-instance.json').write_text(json.dumps(instance))
        lifecycle={**instance,'before':dict(self.before)}
        journal=recovery.Journal.create(self.home,self.root,self.backup,
            [('app',self.new,self.old)],version='2.4.2',before=self.before,lifecycle=lifecycle)
        for change in ({'port':True},{'port':80},{'before':{**self.before,'running':False}}):
            with self.subTest(change=change):
                journal.plan['lifecycle']={**lifecycle,**change};journal.save()
                with self.assertRaises(RuntimeError):self.run_recover()
                self.assertEqual(self.stop_calls,[])


if __name__=='__main__':unittest.main()
