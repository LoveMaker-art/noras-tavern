"""Standalone task adapter uses existing identity checks and journal ownership."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class UpdaterTaskBackendTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nora-task-backend-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.backend = load('task_backend_test', 'ops/updater/task_backend.py')
        self.update = load('task_backend_updater_test', 'ops/updater/update.py')
        self.home = self.root / 'hermes'
        self.home.mkdir()
        self.args = SimpleNamespace(nora_home=self.root, hermes_home=self.home,
            install_root=self.root, port=18999, operation_id='575d9fda-ed38-4b96-93fd-3b39a34148e7')

    def identity(self):
        app = self.root / 'apps/tavern-runtime'
        app.mkdir(parents=True)
        (app / 'program.js').write_text('original program')
        metadata = self.root / 'tavern-updates'
        metadata.mkdir()
        manifest = {'schema': 'tavern-release/v2', 'commit': 'a' * 40, 'versions': {'tavern': '2.4.2'},
            'artifacts': {'app/program.js': self.update.file_sha(app / 'program.js')}}
        (metadata / 'installed-manifest.json').write_text(json.dumps(manifest))
        receipt = {'schema': 2, 'version': '2.4.2', 'commit': 'a' * 40,
            'releaseManifestSha256': self.update.file_sha(metadata / 'installed-manifest.json')}
        (metadata / 'installed.json').write_text(json.dumps(receipt))
        return app, metadata

    def test_fixed_standalone_target_uses_publication_batch_separate_from_core_version(self):
        from contextlib import nullcontext
        release = self.root / 'release'
        release.mkdir()
        self.args.command = 'update'
        self.args.release_dir = release
        self.args.manifest_sha256 = None
        self.args.target_commit = 'b' * 40
        self.args.allow_candidate = False
        for publication, requested, allowed in [(None, 'v2.5.2', True),
                ({'schema': 'nora-component-publication/1', 'tag': 'v2.5.3'}, 'v2.5.3', True),
                ({'schema': 'nora-component-publication/1', 'tag': 'v2.5.3'}, 'v2.5.2', False)]:
            with self.subTest(publication=publication, requested=requested):
                manifest = {'versions': {'tavern': '2.5.2'}, 'commit': 'b' * 40}
                if publication:
                    manifest['publication'] = publication
                (release / 'release-manifest.json').write_text(json.dumps(manifest))
                self.args.tag = requested
                with patch.object(self.backend, 'updater', return_value=self.update), \
                        patch.object(self.backend, 'roots', return_value=(self.home, self.root, self.root)), \
                        patch.object(self.backend, 'require_owner'), \
                        patch.object(self.update, 'guarded_standalone_execution', return_value=nullcontext()), \
                        patch.object(self.update._operation_control, 'managed_run') as run, \
                        patch.object(self.backend, 'verify_committed', return_value={'updateVerified': True}):
                    if allowed:
                        self.assertTrue(self.backend.execute(self.args)['updateVerified'])
                        run.assert_called_once()
                    else:
                        with self.assertRaisesRegex(RuntimeError, '固定发布身份'):
                            self.backend.execute(self.args)
                        run.assert_not_called()

    def test_status_requires_receipt_manifest_program_and_real_world_reader_even_when_process_is_healthy(self):
        app, metadata = self.identity()
        runtime = SimpleNamespace(verify_install=lambda: {'dependencies': 'ready'},
            status=lambda: {'port': 18999, 'processes': {'native': True}, 'health': {'ok': True}})
        with patch.object(self.backend, 'roots', return_value=(self.home, self.root, self.root)), \
                patch.object(self.update, 'standalone_runtime', return_value=runtime), \
                patch.object(self.backend, 'world_read', return_value={'default-user': [{'worldId': 'world'}]}) as worlds:
            current = self.backend.status(self.args, self.update)
            self.assertEqual(current['worldVerification']['worlds'], 1)
            self.assertIsNone(current['gatewayRunning'])
            self.assertFalse(current['gatewayManaged'])
            worlds.assert_called_once()
            (app / 'program.js').write_text('damaged but still healthy')
            with self.assertRaisesRegex(RuntimeError, '程序文件'):
                self.backend.status(self.args, self.update)
            (app / 'program.js').write_text('original program')
            receipt = json.loads((metadata / 'installed.json').read_text())
            receipt['commit'] = 'b' * 40
            (metadata / 'installed.json').write_text(json.dumps(receipt))
            with self.assertRaisesRegex(RuntimeError, '收据'):
                self.backend.status(self.args, self.update)

    def test_completed_legacy_journal_allows_new_task_only_after_real_installation_verification(self):
        app, metadata = self.identity()
        transaction = metadata / 'transaction.json'
        legacy = {'schema': 1, 'status': 'committed', 'version': '2.4.2',
            'backup': '/unavailable-historical-backup/old-update'}
        transaction.write_text(json.dumps(legacy))
        saved = transaction.read_bytes()
        runtime = SimpleNamespace(verify_install=lambda: None,
            status=lambda: {'port': 18999, 'processes': {'native': True}, 'health': {'ok': True}})
        with patch.object(self.backend, 'roots', return_value=(self.home, self.root, self.root)), \
                patch.object(self.update, 'standalone_runtime', return_value=runtime), \
                patch.object(self.backend, 'world_read', return_value={'default-user': []}) as worlds:
            effects = self.backend.effects(self.args, self.update)
            self.assertEqual(effects['effectState'], 'untouched')
            self.assertEqual(effects['recoveryOutcome'], 'not-required')
            self.assertFalse(effects['canResume'])
            self.assertEqual(transaction.read_bytes(), saved)
            worlds.assert_called_once()
            (app / 'program.js').write_text('damaged but healthy process')
            with self.assertRaisesRegex(RuntimeError, '程序文件'):
                self.backend.effects(self.args, self.update)
            (app / 'program.js').write_text('original program')
            transaction.write_text(json.dumps({**legacy, 'version': '2.4.1'}))
            with self.assertRaisesRegex(RuntimeError, '历史事务'):
                self.backend.effects(self.args, self.update)

    def test_pending_or_malformed_journals_never_use_completed_legacy_acceptance(self):
        _, metadata = self.identity()
        legacy = {'schema': 1, 'status': 'committed', 'version': '2.4.2', 'backup': '/old/backup'}
        for record in ({**legacy, 'status': 'prepared'}, {**legacy, 'status': 'restored'},
                {**legacy, 'recoveryPlan': None}, {**legacy, 'operationId': self.args.operation_id}):
            with self.subTest(record=record), \
                    patch.object(self.backend, 'roots', return_value=(self.home, self.root, self.root)), \
                    patch.object(self.backend, 'status', side_effect=AssertionError('must retain strict recovery path')):
                (metadata / 'transaction.json').write_text(json.dumps(record))
                effects = self.backend.effects(self.args, self.update)
                self.assertEqual(effects['effectState'], 'unknown')
                self.assertEqual(effects['recoveryOutcome'], 'recovery-required')

    def test_legacy_journal_change_during_read_only_verification_is_rejected(self):
        _, metadata = self.identity()
        transaction = metadata / 'transaction.json'
        legacy = {'schema': 1, 'status': 'committed', 'version': '2.4.2', 'backup': '/old/backup'}
        transaction.write_text(json.dumps(legacy))
        def changed(*_args):
            transaction.write_text(json.dumps({**legacy, 'status': 'prepared'}))
            return {'version': '2.4.2'}
        with patch.object(self.backend, 'roots', return_value=(self.home, self.root, self.root)), \
                patch.object(self.backend, 'status', side_effect=changed):
            with self.assertRaisesRegex(RuntimeError, '历史事务'):
                self.backend.effects(self.args, self.update)

    def test_guarded_standalone_context_keeps_children_under_the_existing_owner(self):
        gate = SimpleNamespace(operation_id=self.args.operation_id, owner_epoch=7, assert_active=lambda: None)
        with patch.object(self.update, 'resolve_update_target', return_value=(self.home, self.root)), \
                patch.object(self.update._operation_control, 'require_operation', return_value=gate), \
                patch.object(self.update._operation_control, 'managed_run', return_value='owned child') as run, \
                patch.object(self.update.subprocess, 'Popen', side_effect=AssertionError('unguarded child')):
            with self.update.guarded_standalone_execution(self.home, self.root):
                self.assertTrue(self.update._standalone_execution['guarded'])
                self.assertEqual(self.update.standalone_run(['owned-command'], check=True), 'owned child')
                with self.assertRaisesRegex(RuntimeError, '第二个执行者'):
                    with self.update.guarded_standalone_execution(self.home, self.root):
                        pass
            self.assertIsNone(self.update._standalone_execution)
            run.assert_called_once()
        with patch.object(self.update._operation_control, 'require_operation', side_effect=RuntimeError('guard lost')):
            with self.assertRaisesRegex(RuntimeError, 'guard lost'):
                with self.update.guarded_standalone_execution(self.home, self.root):
                    pass

    def test_standalone_children_never_escape_the_task_owner(self):
        lease = SimpleNamespace(closed=False, fileno=lambda: 123)
        child = SimpleNamespace(returncode=0, communicate=lambda **_options: ('', ''))
        for state in (None, {'home': self.home, 'root': self.root, 'lock': lease}):
            with self.subTest(state=state), \
                    patch.object(self.update, '_standalone_execution', state), \
                    patch.object(self.update.subprocess, 'Popen', return_value=child) as spawn, \
                    patch.object(self.update._operation_control, 'managed_run') as delegated:
                with self.assertRaisesRegex(RuntimeError, '现有任务'):
                    self.update.standalone_run(['maintenance-command'], check=True)
                spawn.assert_not_called()
                delegated.assert_not_called()

    def test_preflight_preserves_damaged_program_for_transactional_repair_but_rejects_bad_receipt(self):
        app, metadata = self.identity()
        (app / 'program.js').write_text('damaged program awaiting replacement')
        chat = self.root / 'tavern-state/native/default-user/chats/story.jsonl'
        chat.parent.mkdir(parents=True)
        chat.write_text('original chat remains here')
        runtime = SimpleNamespace(verify_install=lambda: {'dependencies': 'ready'},
            status=lambda: {'port': 18999, 'processes': {'native': False}, 'health': {'ok': False}})
        with patch.object(self.backend, 'roots', return_value=(self.home, self.root, self.root)), \
                patch.object(self.update, 'standalone_runtime', return_value=runtime), \
                patch.object(self.backend, 'world_read', side_effect=AssertionError('preflight must not run damaged application reader')):
            current = self.backend.status(self.args, self.update, verify=False)
            self.assertEqual(current['version'], '2.4.2')
            self.assertIsNone(current['worldVerification'])
            self.assertEqual(chat.read_text(), 'original chat remains here')
            self.assertEqual((app / 'program.js').read_text(), 'damaged program awaiting replacement')
            self.assertFalse((metadata / 'transaction.json').exists())
            with self.assertRaisesRegex(RuntimeError, '程序文件'):
                self.backend.status(self.args, self.update)
            receipt = json.loads((metadata / 'installed.json').read_text())
            receipt['commit'] = 'b' * 40
            (metadata / 'installed.json').write_text(json.dumps(receipt))
            with self.assertRaisesRegex(RuntimeError, '收据'):
                self.backend.status(self.args, self.update, verify=False)

    def test_current_version_acceptance_is_guarded_checks_real_files_and_does_not_create_a_journal(self):
        app, _ = self.identity()
        self.args.command = 'verify-current-update'
        self.args.version = 'v2.4.2'
        gate = SimpleNamespace(operation_id=self.args.operation_id, owner_epoch=7, assert_active=lambda: None)
        runtime = SimpleNamespace(verify_install=lambda: {'dependencies': 'ready'},
            status=lambda: {'port': 18999, 'processes': {'native': True}, 'health': {'ok': True}})
        with patch.object(self.backend, 'updater', return_value=self.update), \
                patch.object(self.backend, 'roots', return_value=(self.home, self.root, self.root)), \
                patch.object(self.update, 'resolve_update_target', return_value=(self.home, self.root)), \
                patch.object(self.update._operation_control, 'require_operation', return_value=gate), \
                patch.object(self.update, 'standalone_runtime', return_value=runtime), \
                patch.object(self.backend, 'world_read', return_value={}):
            result = self.backend.execute(self.args)
            self.assertTrue(result['noUpdate'])
            self.assertTrue(result['updateVerified'])
            self.assertFalse((self.root / 'tavern-updates/transaction.json').exists())
            self.args.version = '2.5.2'
            with self.assertRaisesRegex(RuntimeError, '固定验收版本'):
                self.backend.execute(self.args)
            self.args.version = '2.4.2'
            (app / 'program.js').write_text('wrong bytes')
            with self.assertRaisesRegex(RuntimeError, '程序文件'):
                self.backend.execute(self.args)

    def test_guarded_standalone_journal_keeps_operation_identity_and_recovers_real_program_bytes(self):
        app, _ = self.identity()
        state = self.root / 'tavern-state/native/default-user/chats/chat.jsonl'
        state.parent.mkdir(parents=True)
        state.write_text('original chat')
        gate = SimpleNamespace(operation_id=self.args.operation_id, owner_epoch=7, assert_active=lambda: None)
        helper = self.update.recovery_module()
        backup = self.root / 'tavern-backups/owned'
        backup.mkdir(parents=True)
        self.update.record_backup(self.root, backup, 'prepared')
        self.update.copy_host_backup(self.home, self.root, backup, None)
        self.update.snapshot_agents(self.home, backup / 'agents-rollback')
        stage = self.root / 'prepared'
        stage.mkdir()
        (stage / 'program.js').write_text('replacement')
        with patch.object(sys, '_nora_operation_delegate', gate, create=True), \
                patch.object(self.update, 'resolve_update_target', return_value=(self.home, self.root)):
            with self.update.guarded_standalone_execution(self.home, self.root):
                journal = helper.Journal.create(self.home, self.root, backup, [('app', stage, app)], version='2.5.2',
                    before={'scope': 'standalone-tavern', 'version': '2.4.2', 'running': False}, state=self.root / 'tavern-state')
                self.assertEqual(journal.record['operationId'], gate.operation_id)
                self.assertEqual(journal.record['ownerEpoch'], gate.owner_epoch)
                journal.seal_offline({'offline': True})
                journal.snapshot_state()
                journal.swap('app')
                self.assertEqual((app / 'program.js').read_text(), 'replacement')
                restored = helper.recover(self.home, self.root, stop=lambda *_: {'offline': True}, resume=lambda *_: None,
                    verify=lambda *_: {'version': '2.4.2', 'running': False})
                self.assertEqual(restored['status'], 'restored')
                self.assertEqual((app / 'program.js').read_text(), 'original program')
                self.assertEqual(state.read_text(), 'original chat')
                self.assertEqual(helper.effects(self.home, self.root)['recoveryOutcome'], 'restored-and-verified')

    def test_previously_offline_installation_is_stopped_after_temporary_acceptance(self):
        stopped = []
        runtime = SimpleNamespace(stop_run=lambda: stopped.append(True))
        with patch.object(self.update, 'standalone_runtime', return_value=runtime), \
                patch.object(self.update, 'standalone_snapshot', return_value={'running': False}):
            self.update.restore_standalone_running_state(self.root, {'running': False})
            self.assertEqual(stopped, [True])
            self.update.restore_standalone_running_state(self.root, {'running': True})
            self.assertEqual(stopped, [True])
        with patch.object(self.update, 'standalone_runtime', return_value=runtime), \
                patch.object(self.update, 'standalone_snapshot', return_value={'running': True}):
            with self.assertRaisesRegex(RuntimeError, '停止状态'):
                self.update.restore_standalone_running_state(self.root, {'running': False})

    def test_shared_root_evidence_stays_outside_replaceable_program_tree_and_preserves_user_bytes(self):
        chat = self.root / 'tavern-state/native/default-user/chats/story.jsonl'
        chat.parent.mkdir(parents=True)
        chat.write_text('user story remains unchanged')
        before = self.update.file_sha(chat)
        evidence = self.update._operation_evidence
        saved = evidence.freeze(RuntimeError('temporary failure'), nora_home=self.root,
            operation_id=self.args.operation_id, install_root=self.root / 'apps')
        file = self.root / 'installer/operations' / self.args.operation_id / 'evidence/python.json'
        self.assertTrue(file.is_file())
        self.assertEqual(json.loads(file.read_text())['operationId'], self.args.operation_id)
        self.assertFalse(any(reason.startswith('save_failed:') for reason in saved.get('missingReasons', [])))
        self.assertEqual(self.update.file_sha(chat), before)
        with self.assertRaisesRegex(ValueError, '恢复目录之外'):
            evidence.operation_directory(self.root, operation_id=self.args.operation_id,
                installer_directory=self.root / 'apps/installer', install_root=self.root / 'apps')
        self.assertFalse((self.root / 'apps/installer').exists())

    def test_native_process_discovery_uses_the_existing_cross_platform_reader(self):
        app, _ = self.identity()
        (app / 'native-runtime.json').write_text('{}')
        records = [{'pid': 7711, 'script': str(app / 'engine/sillytavern/server.js')}]
        reader = SimpleNamespace(find_processes=lambda script: records)
        with patch.object(self.update, 'module_at', return_value=reader) as loaded:
            self.assertEqual(self.update.process_rows(app), [7711])
            self.assertEqual(loaded.call_args.args[1], self.update.HERE / 'runtime_process.py')

    def test_native_stop_uses_existing_runtime_ownership_and_refuses_unconfirmed_shutdown(self):
        app, _ = self.identity()
        (app / 'native-runtime.json').write_text('{}')
        (app / 'native_lifecycle.py').write_text('')
        stopped = []
        runtime = SimpleNamespace(stop_run=lambda: stopped.append(True))
        with patch.object(self.update, 'standalone_runtime', return_value=runtime), \
                patch.object(self.update, 'process_rows', side_effect=[[7711], []]), \
                patch.object(self.update.os, 'kill', side_effect=AssertionError('native stop escaped ownership')):
            self.assertEqual(self.update.stop_unmanaged(app), [7711])
            self.assertEqual(stopped, [True])
        with patch.object(self.update, 'standalone_runtime', return_value=runtime), \
                patch.object(self.update, 'process_rows', return_value=[7711]):
            with self.assertRaisesRegex(RuntimeError, '仍有'):
                self.update.stop_unmanaged(app)


if __name__ == '__main__':
    unittest.main()
