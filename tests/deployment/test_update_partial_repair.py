"""Repair a proven partial managed instance using the existing update journal."""
from contextlib import ExitStack
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ops.installer import first_install, launcher_bridge as bridge, nora_system
from ops.updater import bootstrap, bundle, update

ROOT = Path(__file__).resolve().parents[2]


class PartialUpdateTransactionTests(unittest.TestCase):
    def transaction(self, *, missing_app=True, fail=False, mutate_config=False, mutate_story=False,
                    bad_preflight=False, bad_stop=False, legacy_entry=None):
        with tempfile.TemporaryDirectory(prefix='nora-partial-update-') as temporary, ExitStack() as stack:
            root = Path(temporary).resolve() / 'existing Nora'
            home, tavern = root / 'hermes', root / 'tavern'
            def write(file, value):
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(json.dumps(value) if isinstance(value, dict) else value, encoding='utf-8')
            instance = {'schema': 1, 'noraHome': str(root), 'hermesHome': str(home),
                        'installRoot': str(tavern), 'port': 18899}
            write(home / 'nora-instance.json', instance)
            write(home / 'hermes-agent/.hermes-bootstrap-complete', {
                'schema': 1, 'source': 'nora-integrated-runtime', 'sha256': 'c' * 64,
                'platform': 'win32' if os.name == 'nt' else 'darwin', 'arch': 'x64'})
            old_manifest = {'schema': 'tavern-release/v2', 'versions': {'tavern': '2.4.5'}, 'commit': 'a' * 40}
            write(tavern / 'tavern-updates/installed.json', {'schema': 2, 'version': '2.4.5', 'commit': 'a' * 40})
            write(tavern / 'tavern-updates/installed-manifest.json', old_manifest)
            write(tavern / 'tavern-updates/nora-system.json', {
                'schema': 1, 'version': '2.4.5', 'commit': 'a' * 40,
                'proof': dict.fromkeys(nora_system.PROOFS, True), 'setupCompleted': True})
            if not missing_app:
                write(tavern / 'apps/tavern-runtime/native-runtime.json', '{"old":true}')
                write(tavern / 'apps/tavern-runtime/native_lifecycle.py', 'pass\n')
            if legacy_entry:
                write(tavern / 'apps/tavern-runtime' / legacy_entry, '# obsolete program residue\n')
            write(home / 'config.yaml', update.render_mcp(home, tavern, 18899).decode())
            # Formatting is user-owned, even when parsed bindings already agree.
            with (home / 'config.yaml').open('a') as stream:
                stream.write('\n# operator comment must survive repair\n')
            write(home / '.env', 'TEST_ONLY=keep\n')
            write(home / 'SOUL.md', 'custom persona')
            write(home / 'AGENTS.md', 'old instructions')
            write(home / 'cron/jobs.json', '{"jobs":[{"id":"unrelated"}]}')
            write(home / 'sessions/keep.json', '{"testOnly":true}')
            for relative in nora_system.SKILLS:
                write(home / 'skills' / relative / 'SKILL.md', 'old skill')
            for relative in nora_system.MANAGED_FILES:
                write(home / relative, 'old managed file')
            state = tavern / 'tavern-state'
            story = state / 'native/default-user/nora-world-core/worlds/story.json'
            chat = state / 'native/default-user/chats/story/chat.jsonl'
            native_config = state / 'native-runtime/config.yaml'
            write(story, '{"worldId":"story"}')
            write(chat, '{"message":"keep","variables":{"score":7}}\n')
            write(native_config, '# user settings\nport: 18899\n')
            old_files = {p: p.read_bytes() for p in root.rglob('*') if p.is_file()}
            args = SimpleNamespace(nora_home=root, hermes_home=home, install_root=tavern, port=18899)
            snapshot = bridge.partial_installation_snapshot(args)
            before = {'version': '2.4.5', 'systemReady': False, 'running': False,
                      'gatewayRunning': False, 'clawchatConnected': False}
            lifecycle_plan = {**instance, 'bridge': 'test-only-bridge', 'before': before, 'partialRepair': snapshot}
            manifest = {'schema': 'tavern-release/v2', 'versions': {'tavern': '2.4.6'},
                        'commit': 'b' * 40, 'artifacts': {}}
            def extract(_release, source, _manifest, **_kwargs):
                write(source / 'app/native-runtime.json', '{"new":true}')
                write(source / 'app/native_lifecycle.py', 'pass\n')
                write(source / 'app/engine/sillytavern/package.json', '{"dependencies":{}}')
                for name in ('first_install.py', 'nora_system.py', 'templates/SOUL.md', 'templates/greeting.md'):
                    destination = source / 'ops/installer' / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(ROOT / 'ops/installer' / name, destination)
                for name in ('managed_context.py', 'clawchat_greeting_patch.py', 'clawchat-greeting-order.patch'):
                    destination = source / 'ops/updater' / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(ROOT / 'ops/updater' / name, destination)
                for name in update.UPDATE_CHECK_FILES:
                    write(source / 'ops/scripts' / name, 'new managed script')
                write(source / 'ops/skills/agents-tavern.md', '# New Nora instructions\n')
                for name in ('HOOK.yaml', 'handler.py', 'run.sh'):
                    write(source / 'ops/hooks/tavern-liveware-register' / name, 'new hook')
                return {'changedModules': ['tavern-engine', 'updater']}
            def skills(_source, destination, *, local=False):
                self.assertTrue(local)
                result = {}
                for relative in nora_system.SKILLS:
                    target = destination / relative
                    write(target / 'SKILL.md', 'new skill')
                    result[relative] = target
                return result
            calls, world_apps = [], []
            def lifecycle(phase, *_args):
                calls.append(phase)
                if phase in ('preflight', 'stop'):
                    return {**before, 'offline': not ((phase == 'preflight' and bad_preflight)
                            or (phase == 'stop' and bad_stop)), 'partialRepair': snapshot}
                if phase == 'recover-stop':
                    return {'offline': True}
                if phase in ('rollback', 'recover-verify'):
                    self.assertEqual(bridge.partial_installation_snapshot(args), snapshot)
                    return {**before, 'offline': True}
                return {**before, 'systemReady': True, 'version': '2.4.6'}
            def worlds(app, _state):
                world_apps.append(Path(app))
                self.assertTrue((Path(app) / 'native-runtime.json').is_file(), 'old missing app cannot parse Worlds')
                return {'default-user': [{'worldId': 'story', 'sessions': ['story-session']}]}
            original_module = update.module_at
            def module(name, file):
                if name == 'update_nora_system': return nora_system
                if name == 'update_install_helpers': return first_install
                if name == 'simple_service_manager':
                    return SimpleNamespace(ManagedService=SimpleNamespace(discover=lambda *_: None))
                if name == 'simple_skill_names': return SimpleNamespace(RETIRED=[])
                return original_module(name, file)
            def start(*_args, **_kwargs):
                if mutate_config: native_config.write_text('damaged config')
                if mutate_story: write(state / 'native/default-user/chats/new/new.jsonl', 'unexpected story')
                return {'health': {'ok': True}}
            def proof(*_args):
                if fail:
                    story.unlink()
                    chat.write_text('damaged session')
                    raise RuntimeError('injected candidate runtime failure')
                return dict.fromkeys(nora_system.PROOFS, True)
            stack.enter_context(patch.dict(os.environ, {'HERMES_HOME': str(home), 'NORA_TAVERN_HOME': str(root),
                'NORA_UPDATE_LIFECYCLE': json.dumps(lifecycle_plan)}, clear=True))
            stack.enter_context(patch.dict(sys.modules, bundle=bundle))
            stack.enter_context(patch.object(bundle, 'read_bundle', return_value=manifest))
            stack.enter_context(patch.object(bundle, 'extract_bundle', side_effect=extract))
            stack.enter_context(patch.object(update, 'module_at', side_effect=module))
            stack.enter_context(patch.object(update, 'changed_roots', return_value={'app', 'ops'}))
            stack.enter_context(patch.object(update, 'roots_with_unmanaged_files', return_value=set()))
            stack.enter_context(patch.object(update, 'prepare_dependencies', return_value={'tavern': 'prepared'}))
            stack.enter_context(patch.object(update, 'prepare_skills', side_effect=skills))
            stack.enter_context(patch.object(update, 'dependency_marker', return_value={}))
            stack.enter_context(patch.object(update, 'managed_lifecycle', side_effect=lifecycle))
            stack.enter_context(patch.object(update, 'verify_worlds', side_effect=worlds))
            if legacy_entry:
                stack.enter_context(patch.object(update, 'migration_copy',
                    side_effect=AssertionError('partial repair must not migrate user data')))
                stack.enter_context(patch.object(update, 'fallback_python_state',
                    side_effect=AssertionError('partial repair must not archive or replace user data')))
            stack.enter_context(patch.object(update, 'configure_update_check_job', return_value={'id': 'new'}))
            stack.enter_context(patch.object(first_install, 'extract_dependency_bundle', return_value=None))
            legacy_stop = stack.enter_context(patch.object(first_install, 'stop_install_runtime',
                side_effect=AssertionError('missing old native controller must not be invoked')))
            stack.enter_context(patch.object(nora_system, 'seed_clawchat_skills'))
            stack.enter_context(patch.object(nora_system, 'verify_runtime', side_effect=proof))
            no_install = stack.enter_context(patch.object(first_install, 'install',
                side_effect=AssertionError('partial repair is never first install')))
            stack.enter_context(patch.object(update, 'install_runtime', side_effect=start))
            stack.enter_context(patch.object(update, 'refresh_liveware', side_effect=AssertionError('desktop owns services')))
            stack.enter_context(patch('sys.stdout', new_callable=io.StringIO))
            invocation = SimpleNamespace(home=home, install_root=tavern, managed_home=root,
                release_dir=root / 'payload', manifest_sha256='d' * 64)
            if bad_preflight:
                with self.assertRaisesRegex(RuntimeError, '停服证据'):
                    update.install(invocation)
                for file, content in old_files.items(): self.assertEqual(file.read_bytes(), content, str(file))
                self.assertFalse((tavern / 'tavern-updates/transaction.json').exists())
                self.assertEqual(calls, ['preflight'])
                legacy_stop.assert_not_called()
                no_install.assert_not_called()
                return
            if fail or mutate_config or mutate_story or bad_stop:
                with self.assertRaisesRegex(RuntimeError, 'recovery=restored'):
                    update.install(invocation)
                for file, content in old_files.items(): self.assertEqual(file.read_bytes(), content, str(file))
                self.assertEqual(bridge.partial_installation_snapshot(args), snapshot)
                self.assertFalse((state / 'native/default-user/chats/new/new.jsonl').exists())
                record = json.loads((tavern / 'tavern-updates/transaction.json').read_text())
                self.assertEqual(record['status'], 'restored')
                self.assertFalse(record['recoveryPlan']['before']['systemReady'])
                self.assertEqual(calls[-2:], ['rollback', 'recover-verify'])
                if not bad_stop:
                    baseline = record['recoveryPlan']['partialBaseline']
                    self.assertEqual(baseline['partialRepair'], snapshot)
                    self.assertEqual(baseline['worlds'], record['recoveryPlan']['worlds'])
                    self.assertEqual(baseline['stateDigest'], record['recoveryPlan']['state']['savedDigest'])
                    self.assertTrue(Path(record['backup'], 'failed-new/app').is_dir())
                    self.assertFalse(any('failed-new' in app.parts for app in world_apps),
                                     'rollback must not execute the failed candidate parser')
            else:
                update.install(invocation)
                record = json.loads((tavern / 'tavern-updates/transaction.json').read_text())
                self.assertEqual(record['status'], 'committed')
                self.assertEqual(record['recoveryPlan']['lifecycle']['partialRepair'], snapshot)
                self.assertEqual(record['recoveryPlan']['partialBaseline']['partialRepair'], snapshot)
                self.assertEqual(json.loads((tavern / 'tavern-updates/installed.json').read_text())['version'], '2.4.6')
                for file in (story, chat, native_config, home / 'config.yaml', home / '.env', home / 'sessions/keep.json'):
                    self.assertEqual(file.read_bytes(), old_files[file])
                self.assertEqual(calls, ['preflight', 'stop', 'verify'])
            if not bad_stop:
                self.assertTrue(world_apps)
            no_install.assert_not_called()
            legacy_stop.assert_not_called()

    def test_missing_native_tree_repair_commits_and_preserves_worlds_sessions_configuration(self):
        self.transaction()

    def test_missing_python_repair_uses_existing_native_tree_and_same_journal(self):
        self.transaction(missing_app=False)

    def test_partial_repair_with_legacy_program_residue_never_migrates_user_data(self):
        for entry in ('server.py', 'backend/server.py'):
            for fail in (False, True):
                with self.subTest(entry=entry, candidate_fails=fail):
                    self.transaction(legacy_entry=entry, fail=fail)

    def test_candidate_failure_restores_exact_partial_state_without_claiming_old_ready(self):
        self.transaction(fail=True)

    def test_partial_repair_rejects_config_change_and_restores_original_bytes(self):
        self.transaction(mutate_config=True)

    def test_partial_repair_rejects_added_story_and_restores_original_inventory(self):
        self.transaction(mutate_story=True)

    def test_partial_preflight_requires_positive_offline_proof_before_journal_or_swaps(self):
        self.transaction(bad_preflight=True)

    def test_partial_stop_proof_cannot_be_assumed_from_earlier_preflight(self):
        self.transaction(bad_stop=True)

    def test_real_candidate_world_reader_is_read_only_and_rejects_unreadable_world(self):
        with tempfile.TemporaryDirectory(prefix='nora-partial-world-reader-') as temporary:
            state = Path(temporary) / 'state'
            directory = state / 'native/default-user/nora-world-core/worlds'
            directory.mkdir(parents=True)
            record = {
                'schema_version': 2, 'world_id': 'world:partial', 'revision': 1,
                'name': 'Preserved World', 'persona': {'name': '', 'description': ''},
                'lifecycle': {'status': 'READY', 'error': None},
                'source': {'type': 'manual', 'sha256': '', 'original_name': '', 'format': ''},
                'runtime_card': {'resource_id': 'resource:partial', 'engine': 'sillytavern',
                                 'binding': {'avatar': 'preserved.png'}, 'ownership': 'owned'},
                'sessions': {'default_session_id': 'session:partial', 'items': [
                    {'session_id': 'session:partial', 'engine': 'sillytavern',
                     'binding': {'chat_id': 'preserved-chat'}, 'opening_state': 'empty'}]},
                'knowledge': [], 'capabilities': {'declared': [], 'status': 'READY', 'items': {}},
                'created_at': '2026-10-11T00:00:00.000Z', 'updated_at': '2026-10-11T00:00:00.000Z',
            }
            file = directory / 'world.json'
            file.write_text(json.dumps(record), encoding='utf-8')
            original = file.read_bytes()
            # Exercise the actual parser subprocess; operation capability itself
            # is covered at the launcher boundary, outside this read-only check.
            with patch.object(update._operation_control, 'managed_run', side_effect=subprocess.run):
                loaded = update.verify_worlds(ROOT / 'app', state)
            self.assertEqual(loaded, {'default-user': [{'worldId': 'world:partial', 'sessions': ['session:partial']}]})
            self.assertEqual(file.read_bytes(), original)
            self.assertFalse((directory.parent / 'quarantine').exists())
            file.write_text('{invalid-world-json', encoding='utf-8')
            damaged = file.read_bytes()
            with patch.object(update._operation_control, 'managed_run', side_effect=subprocess.run), \
                    self.assertRaisesRegex(RuntimeError, '世界读取验证失败'):
                update.verify_worlds(ROOT / 'app', state)
            self.assertEqual(file.read_bytes(), damaged)
            self.assertFalse((directory.parent / 'quarantine').exists())


if __name__ == '__main__':
    unittest.main()
