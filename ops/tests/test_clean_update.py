"""Clean-update acceptance tests use only disposable Hermes installations."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_full_update as fixtures
from clean_update import CleanUpdater, MARKER
import tree_transaction as trees


class CleanUpdateTests(unittest.TestCase):
    def test_verified_pre_switch_python_receipt_can_be_closed_before_next_update(self):
        (self.home / 'apps/tavern-runtime/native-runtime.json').unlink()
        self.fixture.write('apps/tavern-runtime/server.py', '# legacy fixture')
        (self.home / 'tavern-state/productions').mkdir()
        old = self.fixture.review()
        receipt_path = Path(old['transaction']) / 'receipt.json'
        from update import json_write
        json_write(receipt_path, {'status': 'files-restored', 'cleanTransaction': True,
                                 'planDigest': old['planDigest'], 'applied': [], 'restored': [], 'entries': []})
        next_review = self.fixture.review()
        with patch('maintenance.verify_source_running') as verify:
            result = self.fixture.apply(next_review)
        verify.assert_not_called()
        self.assertEqual(json.loads(receipt_path.read_text())['status'], 'rolled-back')
        self.assertEqual(result['status'], 'installed-awaiting-hermes-reload')

    def test_pre_switch_recovery_closes_without_intents_even_if_source_changed(self):
        (self.home / 'apps/tavern-runtime/native-runtime.json').unlink()
        script = self.fixture.write('apps/tavern-runtime/server.py', '# legacy fixture')
        (self.home / 'tavern-state/productions').mkdir()
        old = self.fixture.review()
        receipt_path = Path(old['transaction']) / 'receipt.json'
        from update import json_write
        receipt = {'status': 'files-restored', 'cleanTransaction': True, 'planDigest': old['planDigest'],
                   'applied': [], 'restored': [], 'entries': []}
        json_write(receipt_path, receipt)
        script.write_text('# owner changed version')
        with patch('maintenance.verify_source_running') as verify:
            self.u._close_pre_switch_recovery(receipt_path)
        verify.assert_not_called()
        self.assertEqual(json.loads(receipt_path.read_text())['status'], 'rolled-back')
        script.write_text('# legacy fixture')
        json_write(receipt_path, {**receipt, 'applied': [0]})
        with self.assertRaisesRegex(ValueError, 'recovery first'):
            self.u._close_pre_switch_recovery(receipt_path)
        self.assertEqual(json.loads(receipt_path.read_text())['status'], 'files-restored')

    def test_fully_restored_receipt_does_not_block_the_next_update(self):
        old = self.fixture.review()
        receipt_path = Path(old['transaction']) / 'receipt.json'
        from update import json_write
        json_write(receipt_path, {'status': 'files-restored', 'cleanTransaction': True,
            'planDigest': old['planDigest'], 'entries': [{'name': 'old switch'}],
            'applied': [0], 'restored': [0]})
        result = self.fixture.apply(self.fixture.review())
        self.assertEqual(json.loads(receipt_path.read_text())['status'], 'rolled-back')
        self.assertEqual(result['status'], 'installed-awaiting-hermes-reload')

    def test_native_review_does_not_inventory_live_code_or_user_state(self):
        with patch.object(trees, 'inventory', wraps=trees.inventory) as inventory:
            self.fixture.review()
        live_app = self.home / 'apps/tavern-runtime'
        live_state = self.home / 'tavern-state'
        inspected = [Path(call.args[0]) for call in inventory.call_args_list]
        self.assertFalse(any(path == live_app or path == live_state or live_state in path.parents
                             for path in inspected), inspected)

    def test_partial_import_is_installed_with_separate_data_outcome_and_archive(self):
        self.use_python_installation()
        self.fixture.service.migrate = lambda transaction, state: {
            'pythonMigration': True, 'status': 'partial', 'cards': 2, 'worldbooks': 1,
            'worlds': [{'id': 'world_ok'}], 'profile': {'preserved': True},
            'deferred': [{'kind': 'world', 'file': 'productions/bad.json', 'code': 'PENDING_CONVERSION'}],
            'warnings': [], 'archive': 'python-source'}
        result = self.fixture.apply(self.fixture.review())
        self.assertEqual(result['status'], 'installed-awaiting-hermes-reload')
        self.assertEqual(result['dataImport']['status'], 'partial')
        self.assertEqual(result['dataImport']['worldsImported'], 1)
        self.assertEqual(result['dataImport']['deferredCount'], 1)
        self.assertTrue(Path(result['dataImport']['reportPath']).is_file())
        self.assertTrue(Path(result['dataImport']['backupPath']).is_dir())
        self.assertIn('待转换', result['next_step'])
        self.assertNotIn('restore', self.fixture.service.calls)

    def test_pause_failure_receipt_keeps_original_reason_after_recovery(self):
        review = self.fixture.review()
        before = self.fixture.snapshot()
        reason = 'Tavern did not stop or its supervisor restarted it; no directory was switched'
        with patch.object(self.fixture.service, 'pause', side_effect=ValueError(reason)):
            with self.assertRaisesRegex(ValueError, 'Tavern did not stop'):
                self.fixture.apply(review)
        receipt = json.loads((Path(review['transaction']) / 'receipt.json').read_text())
        self.assertEqual(receipt['status'], 'rolled-back')
        self.assertEqual(receipt['applied'], [])
        self.assertEqual(receipt['failure']['phase'], 'stop-runtime')
        self.assertEqual(receipt['failure']['reason'], reason)
        self.assertEqual(self.fixture.snapshot(), before)

    def test_live_apply_receipt_tells_owner_to_restart_without_running_restart(self):
        self.fixture.u = CleanUpdater(self.home, lifecycle=self.fixture.service)
        result = self.fixture.apply(self.fixture.review())
        self.assertEqual(result['restartCommand'], '/restart')
        self.assertIn('/restart', result['next_step'])
        self.assertNotIn('activationCommand', result)
        self.assertEqual(self.fixture.service.calls, ['prepare', 'activate', 'verify'])
        receipt = next((self.home / 'tavern-updates-v2').glob('review-*/receipt.json'))
        self.assertEqual(json.loads(receipt.read_text())['restartCommand'], '/restart')

    def test_isolated_apply_receipt_does_not_request_live_restart(self):
        result = self.fixture.apply(self.fixture.review())
        self.assertNotIn('restartCommand', result)
        self.assertNotIn('/restart', result['next_step'])

    def test_new_install_does_not_install_or_enable_activation_bridge(self):
        import yaml
        before = self.fixture.snapshot()
        review = self.fixture.review()
        self.assertEqual(self.fixture.snapshot(), before)
        self.fixture.apply(review)
        plugin = self.home / 'plugins/tavern-update-activation/__init__.py'
        self.assertFalse(plugin.exists())
        config = yaml.safe_load((self.home / 'config.yaml').read_text())
        self.assertNotIn('tavern-update-activation', config.get('plugins', {}).get('enabled', []))
        self.assertIn('other', config['mcp_servers'])
        self.u.rollback(review['transaction'], review['planDigest'])
        self.assertEqual(self.fixture.snapshot(), before)

    def test_disabled_activation_plugin_and_unrelated_plugins_stay_unchanged(self):
        import yaml
        self.fixture.write('config.yaml', 'plugins:\n  enabled: [clawchat]\n  disabled: [tavern-update-activation]\n')
        self.fixture.apply(self.fixture.review())
        config = yaml.safe_load((self.home / 'config.yaml').read_text())
        self.assertEqual(config['plugins'], {'enabled': ['clawchat'], 'disabled': ['tavern-update-activation']})

    def test_modified_activation_plugin_is_not_overwritten(self):
        self.fixture.write('plugins/tavern-update-activation/__init__.py', 'custom owner code')
        before = self.fixture.snapshot()
        with self.assertRaisesRegex(ValueError, 'Modified activation plugin'):
            self.fixture.review()
        self.assertEqual(self.fixture.snapshot(), before)

    def setUp(self):
        self.fixture = fixtures.FullUpdateTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.home = self.fixture.home
        (self.home / MARKER).write_text(json.dumps({'schema': 1, 'home': str(self.home), 'purpose': 'isolated-update-test'}))
        self.fixture.service.require_offline = lambda: None
        self.fixture.service.pause = lambda transaction: None
        self.fixture.service.migrate = lambda transaction, state: {'fixtureAdapter': True}
        self.u = CleanUpdater(self.home, lifecycle=self.fixture.service, port=54321)
        self.fixture.u = self.u
        self.fixture.initial = self.fixture.snapshot()

    def use_python_installation(self):
        """Select the one-time legacy migration path for migration tests."""
        (self.home / 'apps/tavern-runtime/native-runtime.json').unlink()
        self.fixture.write('apps/tavern-runtime/server.py', '# legacy fixture')
        (self.home / 'tavern-state/productions').mkdir(exist_ok=True)
        self.u = CleanUpdater(self.home, lifecycle=self.fixture.service, port=54321)
        self.fixture.u = self.u
        self.fixture.initial = self.fixture.snapshot()

    def test_unknown_old_program_is_not_in_the_active_release(self):
        review = self.fixture.review()
        self.fixture.apply(review)
        self.assertFalse((self.home / "apps/tavern-runtime/custom-plugin.js").exists())
        recovery = Path(review["transaction"]) / "backup"
        self.assertTrue(any(p.read_bytes() == b"user plugin" for p in recovery.rglob("custom-plugin.js")))

    def test_official_python_profile_helper_moves_with_transaction_and_rolls_back(self):
        original = (fixtures.OPS / 'tests/fixtures/profile-helper-v1.24.12.txt').read_bytes()
        old = 'skills/creative/tavern-story-profile/scripts/profile_memory.py'
        self.fixture.write(old, original.decode())
        self.fixture.write('skills/creative/tavern-story-profile/SKILL.md', '---\nname: tavern-story-profile\n---\nOld official skill\n')
        before = self.fixture.snapshot()
        review = self.fixture.review()
        self.assertEqual(self.fixture.snapshot(), before)
        self.fixture.apply(review)
        self.assertFalse((self.home / old).exists())
        self.assertEqual((self.home / 'skills/creative/tavern/scripts/profile_memory.py').read_bytes(),
                         (fixtures.OPS / 'scripts/profile_memory.py').read_bytes())
        self.u.rollback(review['transaction'], review['planDigest'])
        self.assertEqual(self.fixture.snapshot(), before)

    def test_official_python_startup_hook_is_replaced_and_restored(self):
        # Exact upstream v1.24.12 bytes, also observed on the failed rc.4 host.
        original = (fixtures.OPS / 'tests/fixtures/startup-hook-v1.24.12.sh.txt').read_bytes()
        self.assertEqual(fixtures.digest(original), '52960f374d813fc9b4b46c704062680d2cd76b092f1805991a2ca66b21127f1a')
        hook = 'hooks/tavern-liveware-register/run.sh'
        self.fixture.write(hook, original.decode())
        before = self.fixture.snapshot()
        review = self.fixture.review()
        self.assertEqual(self.fixture.snapshot(), before, 'Review must not replace the old hook')
        self.fixture.apply(review)
        self.assertEqual((self.home / hook).read_bytes(), (fixtures.OPS / hook).read_bytes())
        self.u.rollback(review['transaction'], review['planDigest'])
        self.assertEqual(self.fixture.snapshot(), before)

    def test_modified_python_startup_hook_still_requires_owner_review(self):
        original = (fixtures.OPS / 'tests/fixtures/startup-hook-v1.24.12.sh.txt').read_text()
        self.fixture.write('hooks/tavern-liveware-register/run.sh', original + '\n# Owner customization\n')
        before = self.fixture.snapshot()
        with self.assertRaisesRegex(ValueError, 'Modified startup hook'):
            self.fixture.review()
        self.assertEqual(self.fixture.snapshot(), before)
        self.assertEqual(self.fixture.service.calls, [], 'Refused review must not stop or start the runtime')

    def test_failed_startup_restores_full_story_state(self):
        self.use_python_installation()
        def fail(_transaction):
            self.fixture.write("tavern-state/native/default-user/chats/story.jsonl", "startup rewrote data")
            self.fixture.write("tavern-state/new-migration.json", '{"created":true}')
            raise RuntimeError("startup failure after data write")
        self.fixture.service.activate = fail
        with self.assertRaisesRegex(RuntimeError, "startup failure"):
            self.fixture.apply(self.fixture.review())
        self.assertEqual(self.fixture.snapshot(), self.fixture.initial)

    def test_three_updates_then_latest_rollback_preserve_context_and_state(self):
        for number in range(3):
            release, _ = self.fixture.bundle('release-' + str(number), {'app/hello.js': str(number).encode()})
            review = self.fixture.review(release)
            before = self.fixture.snapshot()
            self.fixture.apply(review)
            self.assertIn('Keep my instructions', (self.home / 'AGENTS.md').read_text())
        self.u.rollback(review['transaction'], review['planDigest'])
        self.assertEqual(self.fixture.snapshot(), before)
        self.assertEqual(self.u.rollback(review['transaction'], review['planDigest'])['status'], 'rolled-back')

    def test_native_code_rollback_preserves_new_user_dialogue(self):
        review = self.fixture.review()
        self.fixture.apply(review)
        self.fixture.write('tavern-state/native/default-user/chats/story.jsonl', 'new user conversation')
        self.u.rollback(review['transaction'], review['planDigest'])
        self.assertEqual((self.home / 'tavern-state/native/default-user/chats/story.jsonl').read_text(),
                         'new user conversation')
        self.assertEqual((self.home / 'apps/tavern-runtime/hello.js').read_text(), 'old-app')

    def test_custom_server_and_frontend_plugins_are_preserved(self):
        self.fixture.write('apps/tavern-runtime/engine/sillytavern/plugins/custom/index.js', 'user server plugin')
        self.fixture.write('tavern-state/native/default-user/extensions/my-plugin/index.js', 'user browser plugin')
        self.fixture.write('tavern-state/native/default-user/extensions/nora-ui/obsolete.js', 'old shipped plugin code')
        self.fixture.write('skills/creative/tavern-world/scripts/retired.py', 'old specialist helper')
        review = self.fixture.review()
        self.assertIn('after the runtime stops', review['pluginPreservation'])
        self.fixture.apply(review)
        self.assertEqual((self.home / 'apps/tavern-runtime/engine/sillytavern/plugins/custom/index.js').read_text(), 'user server plugin')
        self.assertEqual((self.home / 'tavern-state/native/default-user/extensions/my-plugin/index.js').read_text(), 'user browser plugin')
        self.assertFalse((self.home / 'tavern-state/native/default-user/extensions/nora-ui/obsolete.js').exists())
        self.assertFalse((self.home / 'skills/creative/tavern-world').exists())

    def test_interruption_between_directory_renames_restores_original(self):
        original = trees.rename
        fired = False
        def interrupted(source, target):
            nonlocal fired
            original(source, target)
            if not fired and '/backup/trees/' in str(target):
                fired = True
                raise KeyboardInterrupt('crash between old and new directory')
        review = self.fixture.review()
        with patch('tree_transaction.rename', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.fixture.apply(review)
        self.assertEqual(self.fixture.snapshot(), self.fixture.initial)

    def test_corrupt_state_backup_blocks_all_recovery(self):
        self.use_python_installation()
        review = self.fixture.review()
        self.fixture.apply(review)
        backup = Path(review['transaction']) / 'backup/state/native/default-user/chats/story.jsonl'
        backup.write_text('corrupted backup')
        before = self.fixture.snapshot()
        with self.assertRaisesRegex(ValueError, 'backup checksum'):
            self.u.rollback(review['transaction'], review['planDigest'])
        self.assertEqual(self.fixture.snapshot(), before)

    def test_missing_marker_prevents_clean_apply(self):
        review = self.fixture.review()
        (self.home / MARKER).unlink()
        with self.assertRaisesRegex(ValueError, 'marker'):
            self.fixture.apply(review)

    def test_unknown_inactive_code_changed_after_review_is_backed_up_and_removed(self):
        review = self.fixture.review()
        self.fixture.write('apps/tavern-runtime/custom-plugin.js', 'new custom edit')
        self.fixture.apply(review)
        self.assertFalse((self.home / 'apps/tavern-runtime/custom-plugin.js').exists())
        backup = Path(review['transaction']) / 'backup'
        self.assertTrue(any(p.read_text() == 'new custom edit'
                            for p in backup.rglob('custom-plugin.js')))

    def test_migration_failure_does_not_touch_original_data(self):
        self.use_python_installation()
        def migrate(transaction, state):
            (state / 'migration-error.json').write_text('{}')
            raise ValueError('invalid data mapping')
        self.fixture.service.migrate = migrate
        with self.assertRaisesRegex(ValueError, 'invalid data mapping'):
            self.fixture.apply(self.fixture.review())
        self.assertEqual(self.fixture.snapshot(), self.fixture.initial)

    def test_profile_markdown_projections_restore_after_failed_startup(self):
        self.use_python_installation()
        self.fixture.write('memories/USER.md', 'personal content\noriginal profile')
        before = self.fixture.snapshot()
        def fail(transaction):
            self.fixture.write('memories/USER.md', 'startup changed shared document')
            self.fixture.write('memories/MEMORY.md', 'startup created new projection')
            raise RuntimeError('projection write followed by failure')
        self.fixture.service.activate = fail
        with self.assertRaisesRegex(RuntimeError, 'projection write'):
            self.fixture.apply(self.fixture.review())
        self.assertEqual(self.fixture.snapshot(), before)

    def test_force_killed_process_can_replay_persisted_rename_intent(self):
        review = self.fixture.review()
        code = """
import os, sys
sys.path.insert(0, sys.argv[1])
sys.path.insert(0, sys.argv[2])
from clean_update import CleanUpdater
from test_full_update import Service
import tree_transaction as trees
service = Service()
service.require_offline = lambda: None
service.pause = lambda transaction: None
service.migrate = lambda transaction, state: {'fixtureAdapter': True}
original = trees.rename
def kill_after_rename(source, target):
    original(source, target)
    if '/backup/trees/0' in str(target):
        os._exit(73)
trees.rename = kill_after_rename
CleanUpdater(sys.argv[3], lifecycle=service, port=54321).apply(sys.argv[4], sys.argv[5])
"""
        result = subprocess.run([sys.executable, '-c', code, str(fixtures.OPS / 'updater'), str(fixtures.OPS / 'tests'),
                                 str(self.home), review['transaction'], review['planDigest']], capture_output=True, text=True)
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertFalse((self.home / 'apps/tavern-runtime').exists())
        receipt = json.loads((Path(review['transaction']) / 'receipt.json').read_text())
        self.assertEqual(receipt['applied'], [0])
        self.u.rollback(review['transaction'], review['planDigest'])
        self.assertEqual(self.fixture.snapshot(), self.fixture.initial)

    def test_receipt_disk_error_does_not_skip_restoring_original_trees(self):
        import clean_update
        original = clean_update.json_write
        failed = False
        def fail_once(path, value):
            nonlocal failed
            if not failed and Path(path).name == 'receipt.json' and len(value.get('applied', [])) == 2:
                failed = True
                raise OSError('simulated full disk')
            return original(path, value)
        with patch('clean_update.json_write', side_effect=fail_once):
            with self.assertRaisesRegex(OSError, 'full disk'):
                self.fixture.apply(self.fixture.review())
        self.assertEqual(self.fixture.snapshot(), self.fixture.initial)

    def test_normal_updater_cannot_apply_an_isolated_clean_plan(self):
        review = self.fixture.review()
        ordinary = fixtures.Updater(self.home, lifecycle=self.fixture.service)
        with self.assertRaisesRegex(ValueError, 'mode/port differs'):
            ordinary.apply(review['transaction'], review['planDigest'])

    def test_non_temporary_home_is_rejected_before_any_operation(self):
        from clean_update import require_isolation
        with self.assertRaisesRegex(ValueError, 'temporary isolated copy'):
            require_isolation(Path('/opt/data'))


if __name__ == "__main__":
    unittest.main()
