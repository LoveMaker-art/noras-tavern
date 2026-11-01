"""Exercise shared instance resolution with real, separate temporary directories."""
import importlib.util
import json
import os
import shutil
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]


def resolver():
    spec = importlib.util.spec_from_file_location('cloud_instance_paths', ROOT / 'ops/scripts/nora-instance.py')
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class CloudInstancePathsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nora-paths-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.home, self.root = self.base / 'agent-data', self.base / 'stories-programs'
        self.home.mkdir()
        self.root.mkdir()
        self.state = self.base / 'story-content'
        self.state.mkdir()
        self.config = {'nora_tavern': {'installRoot': str(self.root)}, 'mcp_servers': {'nora': {'env': {
            'NORA_MCP_PROJECT_ROOT': str(self.root / 'apps/tavern-runtime'),
            'NORA_MCP_STATE_ROOT': str(self.state), 'NORA_MCP_BASE_URL': 'http://127.0.0.1:18899'}}}}
        self.write_config()
        self.environment = patch.dict(os.environ, {'HERMES_HOME': str(self.home)}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def write_config(self):
        (self.home / 'config.yaml').write_text(yaml.safe_dump(self.config), encoding='utf-8')

    def test_cloud_binding_accepts_separate_program_and_state_roots_without_writes(self):
        before = (self.home / 'config.yaml').read_bytes()
        value = resolver().configuration(self.home)
        self.assertEqual(value['installRoot'], str(self.root))
        self.assertEqual(value['stateRoot'], str(self.state))
        self.assertEqual(value['port'], 18899)
        self.assertFalse(value['desktopManaged'])
        self.assertEqual((self.home / 'config.yaml').read_bytes(), before)
        self.assertFalse((self.home / 'nora-instance.json').exists())

    def test_marker_is_identity_not_a_required_parent_directory(self):
        record = {'schema': 1, 'deployment': 'core', 'noraHome': str(self.home),
                  'hermesHome': str(self.home), 'installRoot': str(self.root), 'port': 18899}
        (self.home / 'nora-instance.json').write_text(json.dumps(record), encoding='utf-8')
        value = resolver().configuration(self.home)
        self.assertEqual(value['installRoot'], str(self.root))
        self.assertFalse(value['desktopManaged'])

    def test_conflicting_explicit_program_roots_are_rejected_before_writes(self):
        self.config['nora_tavern']['installRoot'] = str(self.base / 'other-instance')
        self.write_config()
        with self.assertRaisesRegex(RuntimeError, '冲突|conflict'):
            resolver().configuration(self.home)
        self.assertFalse((self.base / 'other-instance').exists())

    def test_first_install_keeps_bound_roots_and_port_and_refuses_overrides(self):
        from ops.installer import first_install
        args = SimpleNamespace(dedicated_nora=False, hermes_home=str(self.home),
                               nora_home=None, install_root=None, port=None)
        self.assertEqual(first_install.installation_paths(args), (self.home, self.home, self.root, 18899))
        args.port = 8799
        with self.assertRaisesRegex(RuntimeError, '端口.*冲突'):
            first_install.installation_paths(args)
        args.port = None
        args.install_root = str(self.base / 'wrong')
        with self.assertRaisesRegex(RuntimeError, '目标.*冲突'):
            first_install.installation_paths(args)
        self.assertFalse((self.base / 'wrong').exists())

    def test_invalid_external_config_target_is_rejected_before_install_configuration_writes(self):
        from ops.installer import first_install
        outside = self.base / 'unrelated'
        outside.mkdir()
        before = (self.home / 'config.yaml').read_bytes()
        args = SimpleNamespace(apply=True, confirm=True, dedicated_nora=False,
            hermes_home=str(self.home), nora_home=None, install_root=None, port=None)
        target = self.state / 'native-runtime'
        for redirected in (True, False):
            with self.subTest(redirected=redirected):
                if redirected:
                    target.symlink_to(outside, target_is_directory=True)
                else:
                    (target / 'config.yaml').mkdir(parents=True)
                with patch.object(first_install, 'validate_hermes') as validate:
                    with self.assertRaisesRegex(RuntimeError, '保留的酒馆配置'):
                        first_install.install(args)
                validate.assert_not_called()
                self.assertEqual((self.home / 'config.yaml').read_bytes(), before)
                self.assertEqual(list(outside.iterdir()), [])
                self.assertFalse((self.home / 'nora-instance.json').exists())
                target.unlink() if redirected else shutil.rmtree(target)

    def test_old_desktop_record_keeps_its_owner_and_layout(self):
        self.config = {}
        self.write_config()
        record = {'schema': 1, 'noraHome': str(self.base), 'hermesHome': str(self.home),
                  'installRoot': str(self.root), 'port': 18899}
        (self.home / 'nora-instance.json').write_text(json.dumps(record), encoding='utf-8')
        value = resolver().configuration(self.home)
        self.assertTrue(value['desktopManaged'])
        self.assertEqual(value['noraHome'], str(self.base))

    def test_headless_install_refuses_existing_desktop_before_entering_writer(self):
        from ops.installer import first_install
        self.config = {}
        self.write_config()
        marker = self.home / 'nora-instance.json'
        original = json.dumps({'schema': 1, 'noraHome': str(self.base),
            'hermesHome': str(self.home), 'installRoot': str(self.root), 'port': 18899})
        marker.write_text(original)
        args = SimpleNamespace(dedicated_nora=False, hermes_home=str(self.home),
                               nora_home=None, install_root=None, port=None)
        with patch.object(first_install, '_install', side_effect=AssertionError('desktop admitted as core')) as writer:
            with self.assertRaisesRegex(RuntimeError, '桌面|启动器'):
                first_install.install(args)
        writer.assert_not_called()
        self.assertEqual(marker.read_text(), original)
        self.assertFalse((self.base / 'installer').exists())

    def test_unmarked_query_and_installed_updater_reader_share_explicit_paths(self):
        functions = resolver()
        self.assertEqual(functions.query_configuration(self.home)['installRoot'], str(self.root))
        scripts = self.home / 'scripts'
        scripts.mkdir()
        shutil.copy2(ROOT / 'ops/scripts/nora-instance.py', scripts / 'nora-instance.py')
        entry = self.home / 'skills/system/tavern-updater/scripts/update.py'
        entry.parent.mkdir(parents=True)
        shutil.copy2(ROOT / 'ops/skills/system/tavern-updater/scripts/update.py', entry)
        spec = importlib.util.spec_from_file_location('cloud_query_skill', entry)
        skill = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(skill)
        inspected = []
        with patch.object(skill, 'query_helper', side_effect=lambda ops, *_args, **_kwargs: inspected.append(ops)):
            self.assertEqual(list(skill.query_entries(self.home, self.home)), [])
        self.assertEqual(inspected, [self.root / 'apps/tavern-ops'])
        self.assertFalse((self.home / 'nora-instance.json').exists())

    def test_marked_query_still_works_when_yaml_and_config_are_broken(self):
        record = {'schema': 1, 'deployment': 'core', 'noraHome': str(self.home),
                  'hermesHome': str(self.home), 'installRoot': str(self.root), 'port': 18899}
        (self.home / 'nora-instance.json').write_text(json.dumps(record))
        (self.home / 'config.yaml').write_text('invalid: [')
        with patch.dict('sys.modules', {'yaml': None}):
            value = resolver().query_configuration(self.home)
        self.assertEqual(value['installRoot'], str(self.root))
        self.assertFalse(value['desktopManaged'])

    def test_unbound_legacy_metadata_is_not_mistaken_for_an_invalid_explicit_binding(self):
        (self.home / 'config.yaml').write_text('legacy unbound configuration')
        functions = resolver()
        self.assertIsNone(functions.existing_configuration(self.home))
        with self.assertRaisesRegex(RuntimeError, '配置不是对象'):
            functions.configuration(self.home)
        (self.home / 'nora-instance.json').write_text(json.dumps({'schema': 1,
            'deployment': 'core', 'noraHome': str(self.home), 'hermesHome': str(self.home),
            'installRoot': str(self.root), 'port': 18899}))
        with self.assertRaisesRegex(RuntimeError, '配置不是对象'):
            functions.existing_configuration(self.home)

    def test_state_cannot_be_a_program_tree_or_an_entire_instance(self):
        for state in (self.root,self.home,self.root/'apps/tavern-runtime',self.home/'skills'):
            with self.subTest(path=state):
                self.config['nora_tavern']['stateRoot']=str(state)
                self.write_config()
                with self.assertRaisesRegex(RuntimeError,'重叠'):
                    resolver().configuration(self.home)

    def test_liveware_and_updater_use_the_same_separate_state_and_port(self):
        from ops.updater import update, liveware_integration
        self.assertEqual(update.standalone_port(self.home,self.root),18899)
        self.assertEqual(liveware_integration.state_root(self.root,hermes_home=self.home),self.state)
        env=liveware_integration.environment(self.root,hermes_home=self.home)
        self.assertEqual(env['TAVERN_STATE_DIR'],str(self.state))
        with liveware_integration.registration_lock(self.root,hermes_home=self.home):
            self.assertTrue((self.state/'liveware-registration.lock').is_file())
        self.assertFalse((self.root/'tavern-state').exists())

    def test_read_only_runtime_query_uses_bound_state_without_a_writer_context(self):
        from ops.updater import update
        app=self.root/'apps/tavern-runtime'
        app.mkdir(parents=True)
        for name in ('native_lifecycle.py','native-runtime.json'):
            shutil.copy2(ROOT/'app'/name,app/name)
        self.assertIsNone(update._standalone_execution)
        runtime=update.standalone_runtime(self.root,home=self.home)
        self.assertEqual(runtime.state_root,self.state)
        self.assertFalse((self.root/'tavern-state').exists())

    def test_cloud_history_never_reads_neighboring_desktop_operations(self):
        from ops.installer import update_recovery
        neighbor=self.base/'installer/operations/11111111-1111-4111-8111-111111111111'
        neighbor.mkdir(parents=True)
        file=neighbor/'operation.json'
        file.write_text('{"effectClosureRefs":"foreign invalid records"}')
        self.assertEqual(update_recovery.operation_owner(self.home,self.root),self.home)
        self.assertEqual(update_recovery.effect_closure_refs(self.home,self.root),[])
        self.assertIn('foreign invalid records',file.read_text())
        # Desktop-shaped directory names do not make a cloud instance desktop-owned.
        canonical=self.base/'canonical'
        canonical_home,canonical_root=canonical/'hermes',canonical/'tavern'
        self.assertEqual(update_recovery.operation_owner(canonical_home,canonical_root),canonical_home)

    def test_downloaded_bootstrap_can_discover_explicit_paths_before_resolver_is_installed(self):
        copied=self.base/'standalone/bootstrap.py'
        copied.parent.mkdir()
        shutil.copy2(ROOT/'ops/updater/bootstrap.py',copied)
        spec=importlib.util.spec_from_file_location('raw_cloud_bootstrap',copied)
        raw=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(raw)
        (self.home/'skills').mkdir()
        app=self.root/'apps/tavern-runtime'
        app.mkdir(parents=True)
        (app/'native-runtime.json').write_text('{}')
        self.assertFalse((self.home/'scripts/nora-instance.py').exists())
        warm, cold = resolver().configuration(self.home), raw.instance_paths(self.home)
        for name in ('installRoot', 'stateRoot', 'appRoot', 'desktopManaged'):
            self.assertEqual(cold[name], warm[name], name)
        self.assertEqual(raw.resolve_update_target(self.home,self.root),(self.home,self.root))
        self.assertEqual(raw.state_root(self.home,self.root),self.state)
        self.assertFalse((self.root/'tavern-state').exists())
        explicit=self.config.pop('nora_tavern')
        self.write_config()
        (self.home/'nora-instance.json').write_text(json.dumps({'schema':1,'deployment':'core',
            'hermesHome':str(self.home),'noraHome':str(self.home),'installRoot':str(self.root),'port':18899}))
        self.assertEqual(raw.resolve_update_target(self.home,self.root),(self.home,self.root))
        self.config['nora_tavern']=explicit
        self.config['nora_tavern']['stateRoot']=str(self.base/'conflicting-data')
        self.write_config()
        with self.assertRaisesRegex(RuntimeError,'MCP'):
            raw.resolve_update_target(self.home,self.root)

    def test_installed_and_cold_resolvers_reject_bad_config_without_exposing_credentials(self):
        copied = self.base / 'cold-runner/updater/bootstrap.py'
        copied.parent.mkdir(parents=True)
        shutil.copy2(ROOT / 'ops/updater/bootstrap.py', copied)
        spec = importlib.util.spec_from_file_location('cold_config_redaction', copied)
        cold = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cold)
        sentinel = 'SYNTHETIC_CONFIG_CREDENTIAL'
        file = self.home / 'config.yaml'
        for payload in ((f'api_key: [{sentinel}\n').encode(),
                        (f'api_key: {sentinel}\n').encode() + b'\xff'):
            for resolve in (resolver().configuration, cold.instance_paths):
                with self.subTest(payload=payload[-1:], resolver=resolve.__name__):
                    file.write_bytes(payload)
                    with self.assertRaisesRegex(RuntimeError, '配置格式无效') as rejected:
                        resolve(self.home)
                    self.assertNotIn(sentinel, str(rejected.exception))
                    self.assertEqual(file.read_bytes(), payload)
                    self.assertFalse((self.home / 'installer').exists())
                    self.assertFalse((self.home / 'nora-instance.json').exists())

    def test_first_install_journal_can_restore_bound_external_metadata(self):
        spec = importlib.util.spec_from_file_location('cloud_first_install', ROOT / 'ops/installer/first_install.py')
        first = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(first)
        metadata = self.state / 'native-runtime/config.yaml'
        metadata.parent.mkdir()
        metadata.write_text('original: true\n')
        story = self.state / 'chat-sentinel.txt'
        story.write_text('keep original chat')
        journal = first.FirstInstallJournal.create(self.home, self.home, self.root, state=self.state)
        journal.prepare({'state': [metadata]}, manifest={})
        journal.apply_bytes(metadata, b'new: true\n')
        first.resume_first_install(journal.file, stop=lambda: {'offline': True})
        self.assertEqual(metadata.read_text(), 'original: true\n')
        self.assertEqual(story.read_text(), 'keep original chat')

    def test_external_state_first_install_resumes_after_config_exchange_gap(self):
        from ops.installer import first_install
        original = (self.home / 'config.yaml').read_bytes()
        journal = first_install.FirstInstallJournal.create(self.home, self.home, self.root, state=self.state)
        journal.prepare({'hermes': [self.home / 'config.yaml']}, manifest={})
        replace = first_install.os.replace
        class PowerLoss(BaseException):
            pass
        def exchange_then_interrupt(source, target):
            replace(source, target)
            if Path(source) == Path(first_install.filesystem_path(self.home / 'config.yaml')):
                raise PowerLoss()
        with patch.object(first_install.os, 'replace', side_effect=exchange_then_interrupt):
            with self.assertRaises(PowerLoss):
                journal.apply_bytes(self.home / 'config.yaml', original + b'new_setting: true\n')
        self.assertFalse((self.home / 'config.yaml').exists())
        saved = journal.backup_target(journal.record['targets'][0])
        saved.write_bytes(original + b'changed_backup: true\n')
        with self.assertRaisesRegex(RuntimeError, '配置备份已变化'):
            first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
        self.assertFalse((self.home / 'config.yaml').exists())
        saved.write_bytes(original)
        result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
        self.assertEqual(result['status'], 'restored')
        self.assertEqual((self.home / 'config.yaml').read_bytes(), original)

    def test_update_journal_restores_program_and_keeps_separate_story_data(self):
        spec = importlib.util.spec_from_file_location('cloud_update', ROOT / 'ops/updater/update.py')
        update = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(update)
        app = self.root / 'apps/tavern-runtime'
        app.mkdir(parents=True)
        (app / 'program.txt').write_text('original program')
        (self.state / 'chat.txt').write_text('original chat')
        prepared = self.base / 'prepared'
        prepared.mkdir()
        (prepared / 'program.txt').write_text('new program')
        backup = self.root / 'tavern-backups/owned'
        backup.mkdir(parents=True)
        receipts = self.root / 'tavern-updates'
        receipts.mkdir()
        (receipts / 'installed.json').write_text('{"version":"2.4.2"}')
        update.record_backup(self.root, backup, 'prepared')
        helper = update.recovery_module()
        with patch.object(update, '_standalone_execution', {'home': self.home, 'root': self.root}):
            update.copy_host_backup(self.home, self.root, backup, None)
            update.snapshot_agents(self.home, backup / 'agents-rollback')
            journal = helper.Journal.create(self.home, self.root, backup, [('app', prepared, app)],
                version='2.5.2', before={'scope': 'standalone-tavern', 'version': '2.4.2', 'running': False}, state=self.state)
            journal.seal_offline({'offline': True})
            journal.snapshot_state()
            journal.swap('app')
            result = helper.recover(self.home, self.root, stop=lambda *_: {'offline': True},
                                    resume=lambda *_: None, verify=lambda *_: {'version': '2.4.2', 'running': False})
        self.assertEqual(result['status'], 'restored')
        self.assertEqual((app / 'program.txt').read_text(), 'original program')
        self.assertEqual((self.state / 'chat.txt').read_text(), 'original chat')
        self.assertFalse((self.root / 'tavern-state').exists())
