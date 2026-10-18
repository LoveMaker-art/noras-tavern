"""Standalone updates use the real durable journal, including shared roots."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StandaloneRecoveryTests(unittest.TestCase):
    def test_atomic_json_retries_only_bounded_windows_sharing_denials(self):
        helper=load('standalone_atomic_retry','ops/installer/update_recovery.py')
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'transaction.json'
            target.write_text('{"old":true}')
            original=helper.os.replace
            denial=PermissionError('sharing denial');denial.winerror=5
            attempts=[]
            def temporary(source,destination):
                attempts.append(1)
                if len(attempts)<3:raise denial
                return original(source,destination)
            with patch.object(helper.sys,'platform','win32'),patch.object(helper.os,'replace',side_effect=temporary),patch.object(helper.time,'sleep'):
                helper.atomic_json(target,{'new':True})
            self.assertEqual(len(attempts),3)
            self.assertEqual(json.loads(target.read_text()),{'new':True})
            for platform,code in [('darwin',5),('win32',112)]:
                error=PermissionError('permanent denial');error.winerror=code
                with self.subTest(platform=platform,code=code),patch.object(helper.sys,'platform',platform),patch.object(helper.os,'replace',side_effect=error) as replace,patch.object(helper.time,'sleep') as sleep:
                    with self.assertRaises(PermissionError) as caught:helper.atomic_json(target,{'unexpected':True})
                    self.assertIs(caught.exception,error);self.assertEqual(replace.call_count,1);sleep.assert_not_called()
                self.assertEqual(json.loads(target.read_text()),{'new':True})
            error=PermissionError('persistent access denied');error.winerror=5
            with patch.object(helper.sys,'platform','win32'),patch.object(helper.os,'replace',side_effect=error) as replace,patch.object(helper.time,'monotonic',side_effect=[0,3]):
                with self.assertRaises(PermissionError) as caught:helper.atomic_json(target,{'unexpected':True})
                self.assertIs(caught.exception,error);self.assertEqual(replace.call_count,1)
            self.assertEqual(list(Path(directory).glob('.transaction.json.*')),[])

    def test_atomic_json_cannot_retry_over_a_changed_target_or_temporary_source(self):
        helper=load('standalone_atomic_identity','ops/installer/update_recovery.py')
        for changed in ('target','source'):
            with self.subTest(changed=changed),tempfile.TemporaryDirectory() as directory:
                target=Path(directory)/'transaction.json';target.write_text('{"old":true}')
                denial=PermissionError('sharing denial');denial.winerror=32
                def changed_file(source,destination):
                    (Path(destination) if changed=='target' else Path(source)).write_text('{"foreign":true}')
                    raise denial
                with patch.object(helper.sys,'platform','win32'),patch.object(helper.os,'replace',side_effect=changed_file) as replace,patch.object(helper.time,'sleep') as sleep:
                    with self.assertRaises(PermissionError) as caught:helper.atomic_json(target,{'new':True})
                    self.assertIs(caught.exception,denial);self.assertEqual(replace.call_count,1);sleep.assert_not_called()
                self.assertEqual(json.loads(target.read_text()),{'foreign':True} if changed=='target' else {'old':True})

    def test_interrupted_settings_copy_cannot_publish_a_partial_backup(self):
        updater = load('settings_copy_updater','ops/updater/update.py')
        helper = updater.recovery_module()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source.json';target=root/'saved/settings.json'
            source.write_text('original complete settings')
            def partial_copy(_source,destination):
                Path(destination).write_text('partial')
                raise SystemExit('interrupted copy')
            with patch.object(helper.shutil,'copyfile',side_effect=partial_copy), self.assertRaises(SystemExit):
                helper.copy_startup_backup(source,target,helper.digest(source))
            self.assertFalse(target.exists())
            helper.copy_startup_backup(source,target,helper.digest(source))
            self.assertEqual(target.read_bytes(),source.read_bytes())
            with self.assertRaisesRegex(RuntimeError,'未覆盖现有文件'):
                helper.copy_startup_backup(source,target,helper.digest(source))

    def test_settings_backup_rotation_preserves_bytes_and_interrupted_recovery_is_resumable(self):
        for cut in (False, True):
            with self.subTest(cut=cut), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve() / 'installation'
                app = root / 'apps/tavern-runtime'; app.mkdir(parents=True)
                (app / 'program.txt').write_text('old program')
                state = root / 'tavern-state'
                automatic = state / 'native/default-user/backups/settings_default-user_20260918-111135.json'
                automatic.parent.mkdir(parents=True); automatic.write_text('original automatic backup')
                manual = automatic.parent / 'manual-settings.json'; manual.write_text('manual backup')
                receipts = root / 'tavern-updates'; receipts.mkdir()
                (receipts/'installed.json').write_text('{"version":"2.4.2"}')
                updater = load('settings_rotation_updater', 'ops/updater/update.py')
                helper = updater.recovery_module()
                backup = root / 'tavern-backups/owned'; backup.mkdir(parents=True)
                updater.record_backup(root, backup, 'prepared')
                updater.copy_host_backup(root, root, backup, None)
                updater.snapshot_agents(root, backup / 'agents-rollback')
                prepared = root / 'prepared'; prepared.mkdir(); (prepared/'program.txt').write_text('new program')
                journal = helper.Journal.create(root,root,backup,[('app',prepared,app)],version='2.5.2',
                    before={'scope':'standalone-tavern','version':'2.4.2','running':True},state=state)
                journal.seal_offline({'offline':True}); journal.snapshot_state(); journal.swap('app')
                def resume(_plan, _backup):
                    automatic.unlink(missing_ok=True)
                    if cut: raise SystemExit('cut after old runtime rotates settings backup')
                args = {'stop':lambda *_:{'offline':True},'resume':resume,
                        'verify':lambda *_:{'version':'2.4.2','running':True}}
                if cut:
                    with self.assertRaises(SystemExit): helper.recover(root,root,**args)
                    helper.load(root,root)  # Missing file is recoverable only with a verified archive.
                    args['resume'] = lambda *_:None
                result = helper.recover(root,root,**args)
                self.assertEqual(result['status'],'restored')
                self.assertEqual(automatic.read_text(),'original automatic backup')
                self.assertEqual(manual.read_text(),'manual backup')
                archive = backup / 'startup-settings-backups' / automatic.relative_to(state)
                archive.write_text('tampered archive')
                with self.assertRaisesRegex(RuntimeError,'设置备份已变化'):
                    journal.preserve_startup_backups(restore=True)
                archive.write_text('original automatic backup')
                manual.unlink()
                with self.assertRaisesRegex(RuntimeError,'剧情数据发生变化'):
                    helper.load(root,root)

    def test_shared_root_and_interrupted_swaps_restore_data_configuration_and_old_program(self):
        for interrupted in (False, True):
            with self.subTest(interrupted=interrupted), tempfile.TemporaryDirectory() as directory:
                base = Path(directory).resolve()
                root = base / 'installation'
                app = root / 'apps/tavern-runtime'
                skill = root / 'skills/system/tavern-updater'
                app.mkdir(parents=True); skill.mkdir(parents=True)
                (app / 'program.txt').write_text('old program')
                (app / 'native-runtime.json').write_text('{}')
                (skill / 'SKILL.md').write_text('old skill')
                state = root / 'tavern-state/native/default-user/chats/story.jsonl'
                state.parent.mkdir(parents=True); state.write_text('original chat')
                (root / 'config.yaml').write_text('model: {api_key: acceptance-placeholder}\n')
                (root / 'AGENTS.md').write_text('old instructions')
                receipts = root / 'tavern-updates'; receipts.mkdir()
                (receipts / 'installed.json').write_text('{"version":"2.4.2"}')
                updater = load('standalone_recovery_updater', 'ops/updater/update.py')
                helper = updater.recovery_module()
                backup = root / 'tavern-backups/owned'; backup.mkdir(parents=True)
                updater.record_backup(root, backup, 'prepared')
                updater.copy_host_backup(root, root, backup, None)
                updater.snapshot_agents(root, backup / 'agents-rollback')
                prepared = base / 'prepared'; prepared.mkdir()
                new_app = prepared / 'app'; new_app.mkdir(); (new_app / 'program.txt').write_text('new program')
                new_skill = prepared / 'skill'; new_skill.mkdir(); (new_skill / 'SKILL.md').write_text('new skill')
                before = {'scope':'standalone-tavern','version':'2.4.2','running':False}
                journal = helper.Journal.create(root, root, backup,
                    [('app',new_app,app),('skill-system-tavern-updater',new_skill,skill)],
                    version='2.5.2',before=before,state=root/'tavern-state')
                self.assertEqual([item['namespace'] for item in journal.plan['targets']], ['install','hermes'])
                journal.seal_offline({'offline':True}); journal.snapshot_state()
                original_replace = helper.os.replace
                def replace(source, target):
                    original_replace(source, target)
                    if interrupted and helper._io_path(target) == helper._io_path(backup / 'trees/app'):
                        raise SystemExit('interrupted after old directory move')
                if interrupted:
                    with patch.object(helper.os, 'replace', side_effect=replace), self.assertRaises(SystemExit):
                        journal.swap('app')
                    self.assertFalse(app.exists())
                    self.assertEqual(updater.resolve_update_target(root,root),(root,root),
                                     'missing program must not prevent discovering its pending recovery')
                else:
                    journal.swap('app'); journal.swap('skill-system-tavern-updater')
                    journal.mark_metadata([root/'config.yaml'])
                    (root/'config.yaml').write_text('model: {api_key: changed-placeholder}\n')
                    journal.finish_metadata([root/'config.yaml'])
                runtime = SimpleNamespace(status=lambda:{'processes':{'native':False},'health':{'ok':False}})
                with patch.object(updater,'standalone_runtime',return_value=runtime):
                    result = updater.recover_standalone(root, root, helper=helper)
                self.assertEqual(result['status'],'restored')
                self.assertEqual(result['version'],'2.4.2')
                self.assertEqual((app/'program.txt').read_text(),'old program')
                self.assertEqual((skill/'SKILL.md').read_text(),'old skill')
                self.assertEqual(state.read_text(),'original chat')
                self.assertEqual((root/'config.yaml').read_text(),'model: {api_key: acceptance-placeholder}\n')
                self.assertEqual(json.loads((receipts/'transaction.json').read_text())['status'],'restored')
                self.assertEqual((root/'AGENTS.md').read_text(),'old instructions')


if __name__ == '__main__':
    unittest.main()
