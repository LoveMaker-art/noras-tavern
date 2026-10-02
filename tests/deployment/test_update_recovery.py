import json
from contextlib import ExitStack
import importlib.util
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ops.installer import update_recovery as recovery
from ops.installer import first_install
from ops.updater import bundle


def load_updater():
    path=Path(__file__).resolve().parents[2]/'ops/updater/update.py'
    spec=importlib.util.spec_from_file_location('integration_recovery_updater',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def install_fixture(base,*,interrupt=False):
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
        return dict(before)
    helpers=SimpleNamespace(extract_dependency_bundle=lambda *_:False,
        snapshot_targets=first_install.snapshot_targets,stop_install_runtime=lambda *_:None,
        install_soul=lambda home,*_args,**_kwargs:(home/'SOUL.md').write_text('new soul'))
    managed=SimpleNamespace(read_json=lambda path:json.loads(path.read_text()),
        seed_clawchat_skills=lambda *_:None,record_files_ready=lambda *_:None)
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
        if interrupt and Path(target)==root/'apps/tavern-runtime':os._exit(91)
    with ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ,{'NORA_UPDATE_LIFECYCLE':json.dumps(lifecycle)}))
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
        stack.enter_context(patch.object(updater,'install_runtime',side_effect=RuntimeError('new runtime failed')))
        stack.enter_context(patch.object(helper.os,'replace',side_effect=replace))
        updater.install(SimpleNamespace(home=home,install_root=root,managed_home=base,
            release_dir=base/'release',manifest_sha256=None))
    return phases


class ManagedInstallRecoveryTests(unittest.TestCase):
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
            recovery.recover(home,root,stop=lambda *_:None,resume=lambda *_:None,
                             verify=lambda plan,_:dict(plan['before']))
            self.assertEqual((root/'apps/tavern-runtime/program.txt').read_text(),'old program')
            self.assertEqual((root/'tavern-state/native/default-user/chats/story.jsonl').read_text(),'old story')
            self.assertEqual((home/'SOUL.md').read_text(),'old soul')


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

    def journal(self, *, state=True):
        return recovery.Journal.create(self.home, self.root, self.backup,
            [('app',self.new,self.old)], version='2.4.2', before=self.before,
            state=self.state if state else None)

    def run_recover(self, *, resume=None):
        return recovery.recover(self.home,self.root,
            stop=lambda *_:self.stop_calls.append(True),
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
            if Path(target) == wanted:
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

    def test_service_restore_failure_can_retry_without_replacing_old_files(self):
        journal=self.journal(); journal.snapshot_state(); journal.swap('app')
        def fail(*_): raise RuntimeError('service restore failed')
        with self.assertRaisesRegex(RuntimeError,'service restore failed'):self.run_recover(resume=fail)
        inode=self.old.stat().st_ino
        self.run_recover(); self.assert_restored()
        self.assertEqual(self.old.stat().st_ino,inode)

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
                    recovery.recover(self.home,self.root,stop=lambda *_:callbacks.append('stop'),
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
        recovery.recover(self.home,self.root,stop=lambda *_:None,resume=lambda *_:None,
                         verify=lambda *_:dict(self.before))
        self.assertEqual((self.home/'cron/jobs.json').read_text(),'old jobs')
        self.assertEqual((self.home/'scripts/nora-instance.py').read_text(),'old script')
        self.assertEqual((managed/'targets/cron/jobs.json').read_text(),'old jobs')

    @unittest.skipIf(os.name=='nt','POSIX permission restoration')
    def test_identical_config_bytes_still_restore_original_permissions(self):
        saved=self.backup/'host/config.yaml';saved.write_text('same config');saved.chmod(0o600)
        active=self.home/'config.yaml';active.write_text('same config');active.chmod(0o644)
        journal=self.journal();journal.snapshot_state();journal.swap('app')
        recovery.recover(self.home,self.root,stop=lambda *_:None,resume=lambda *_:None,
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
        recovery.recover(self.home,self.root,stop=lambda *_:None,resume=lambda *_:None,
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
