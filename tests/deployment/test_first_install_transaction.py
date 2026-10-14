import json
from contextlib import ExitStack
import os
from pathlib import Path
import tempfile
import shutil
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ops.installer import first_install

OPERATION_ID = '11111111-1111-4111-8111-111111111111'


def same_filesystem_path(left, right):
    return Path(first_install.filesystem_path(left)) == Path(first_install.filesystem_path(right))


class FirstInstallTransactionTests(unittest.TestCase):
    def test_indexed_backups_bind_each_target_to_its_exact_stable_list_index(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir()
            config, agents = hermes / 'config.yaml', hermes / 'AGENTS.md'
            config.write_bytes(b'original config'); agents.write_bytes(b'original rules')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config, agents]}, manifest={})
                self.assertEqual(journal.record['backupLayout'], 'indexed-v1')
                for index, item in enumerate(journal.record['targets']):
                    self.assertIs(type(item['backupIndex']), int); self.assertEqual(item['backupIndex'], index)
                    saved = journal.backup_target(item)
                    self.assertEqual(saved, journal.directory / f'backups/{index:03d}')
                    self.assertEqual(saved.read_bytes(), (config, agents)[index].read_bytes())
                    with self.assertRaisesRegex(RuntimeError, '备份'): journal.backup_target(dict(item))
                journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'first candidate'); journal.apply_bytes(config, b'second candidate')
                journal.apply_bytes(agents, b'candidate rules')
                self.assertEqual(first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})['status'], 'restored')
                self.assertEqual(config.read_bytes(), b'original config'); self.assertEqual(agents.read_bytes(), b'original rules')

    def test_backup_layout_rejects_unknown_legacy_indices_reordered_and_noninteger_indices(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir()
            config, agents = hermes / 'config.yaml', hermes / 'AGENTS.md'
            config.write_bytes(b'config'); agents.write_bytes(b'rules')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config, agents]}, manifest={})
                for layout in (None, '', 'legacy', 'indexed-v2', 1):
                    with self.subTest(layout=layout):
                        journal.record['backupLayout'] = layout
                        with self.assertRaisesRegex(RuntimeError, '备份'): journal.validate()
                        with self.assertRaisesRegex(RuntimeError, '备份'): journal.backup_target(journal.record['targets'][0])
                journal.record['backupLayout'] = 'indexed-v1'
                targets = journal.record['targets']
                journal.record['targets'] = list(reversed(targets))
                with self.assertRaisesRegex(RuntimeError, '备份'): journal.validate()
                with self.assertRaisesRegex(RuntimeError, '备份'): journal.backup_target(targets[0])
                journal.record['targets'] = targets
                for index in (True, 0.0, -1, 1, '0', None):
                    with self.subTest(index=index):
                        targets[0]['backupIndex'] = index
                        with self.assertRaisesRegex(RuntimeError, '备份'): journal.validate()
                        with self.assertRaisesRegex(RuntimeError, '备份'): journal.backup_target(targets[0])
                targets[0]['backupIndex'] = 0
                journal.record.pop('backupLayout')
                with self.assertRaisesRegex(RuntimeError, '备份'): journal.validate()
                with self.assertRaisesRegex(RuntimeError, '备份'): journal.backup_target(targets[0])
                self.assertEqual(config.read_bytes(), b'config'); self.assertEqual(agents.read_bytes(), b'rules')

    def test_cross_target_backup_identity_swap_blocks_restore_and_preserves_both_targets(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir()
            config, agents = hermes / 'config.yaml', hermes / 'AGENTS.md'
            config.write_bytes(b'original config'); agents.write_bytes(b'original rules')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config, agents]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'candidate config'); journal.apply_bytes(agents, b'candidate rules')
                first, second = [journal.backup_target(item) for item in journal.record['targets']]
                temporary_backup = journal.directory / 'swapped-backup'
                os.replace(first_install.filesystem_path(first), first_install.filesystem_path(temporary_backup))
                os.replace(first_install.filesystem_path(second), first_install.filesystem_path(first))
                os.replace(first_install.filesystem_path(temporary_backup), first_install.filesystem_path(second))
                self.assertEqual(first_install.inspect_first_install(journal.file)['reason'], 'backup_invalid')
                result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                self.assertEqual(result['status'], 'recovery_failed'); self.assertEqual(len(result['unrestored']), 2)
                self.assertEqual(config.read_bytes(), b'candidate config'); self.assertEqual(agents.read_bytes(), b'candidate rules')
                self.assertEqual(first.read_bytes(), b'original rules'); self.assertEqual(second.read_bytes(), b'original config')

    def test_new_exchange_and_restore_names_are_short_with_full_role_specific_uuid(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'candidate')
                exchange = journal.record['targets'][0]['exchanges'][0]
                self.assertRegex(Path(exchange['staged']).name, r'^\.nfi-a-[a-f0-9]{32}$')
                self.assertRegex(Path(exchange['old']).name, r'^\.nfi-o-[a-f0-9]{32}$')
                result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                self.assertEqual(result['status'], 'restored'); self.assertEqual(config.read_bytes(), b'original')
                item = first_install.FirstInstallJournal.load(journal.file).record['targets'][0]
                self.assertRegex(Path(item['staged']).name, r'^\.nfi-r-[a-f0-9]{32}$')
                self.assertEqual(Path(item['staged']).parent, Path(item['path']).parent)
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.remove(config)
                self.assertRegex(Path(journal.record['targets'][0]['exchanges'][0]['old']).name, r'^\.nfi-o-[a-f0-9]{32}$')
                self.assertEqual(first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})['status'], 'restored')
                self.assertEqual(config.read_bytes(), b'original')

    def test_legacy_exchange_and_interrupted_restore_names_still_resume_owned_files(self):
        class PowerLoss(BaseException): pass
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'candidate')
                item = journal.record['targets'][0]; exchange = item['exchanges'][0]
                actual_replace = os.replace
                # A genuine pre-layout record stores the same owned snapshot at
                # its original namespace/path; never infer or migrate on load.
                saved = journal.backup_target(item)
                legacy_saved = journal.directory / 'backups/hermes/config.yaml'
                legacy_saved.parent.mkdir(parents=True)
                actual_replace(first_install.filesystem_path(saved), first_install.filesystem_path(legacy_saved))
                journal.record.pop('backupLayout'); item.pop('backupIndex')
                for key, prefix in [('old', '.nora-first-install-old-'), ('staged', '.nora-first-install-apply-')]:
                    before = hermes / exchange[key]
                    after = before.with_name(prefix + before.name.rsplit('-', 1)[-1])
                    if before.exists(): actual_replace(first_install.filesystem_path(before), first_install.filesystem_path(after))
                    exchange[key] = after.relative_to(hermes).as_posix()
                journal.save(); first_install.FirstInstallJournal.load(journal.file)
                self.assertEqual(journal.backup_target(item), legacy_saved)
                def interrupted(source, target):
                    if same_filesystem_path(target, config) and Path(source).name.startswith(('.nfi-r-', '.nora-first-install-restore-')):
                        raise PowerLoss()
                    actual_replace(source, target)
                with patch.object(first_install.os, 'replace', side_effect=interrupted):
                    with self.assertRaises(PowerLoss): first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                journal = first_install.FirstInstallJournal.load(journal.file); item = journal.record['targets'][0]
                before = hermes / item['staged']
                after = before.with_name('.nora-first-install-restore-' + before.name.rsplit('-', 1)[-1])
                actual_replace(first_install.filesystem_path(before), first_install.filesystem_path(after))
                item['staged'] = after.relative_to(hermes).as_posix(); journal.save()
                before_identity = first_install._recovery.identity(after)
                self.assertEqual(before_identity, item['stagedIdentity'])
                result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                self.assertEqual(result['status'], 'restored'); self.assertEqual(config.read_bytes(), b'original')
                self.assertEqual(first_install._recovery.identity(config), before_identity)
                self.assertEqual(first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})['status'], 'restored')
                self.assertNotIn('backupLayout', first_install.FirstInstallJournal.load(journal.file).record)
                self.assertEqual(legacy_saved.read_bytes(), b'original')
                self.assertEqual(list(hermes.glob('.nora-first-install-*')), [])
                self.assertEqual(list(hermes.glob('.nfi-*')), [])

    def test_exchange_names_reject_wrong_roles_parents_and_incomplete_uuids(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'candidate')
                item = journal.record['targets'][0]; exchange = item['exchanges'][0]
                for container, key, valid, invalid in [
                        (exchange, 'old', '.nfi-o-', ['.nfi-a-', '.nfi-r-', '.nora-first-install-apply-', '.nora-first-install-restore-']),
                        (exchange, 'staged', '.nfi-a-', ['.nfi-o-', '.nfi-r-', '.nora-first-install-old-', '.nora-first-install-restore-']),
                        (item, 'staged', '.nfi-r-', ['.nfi-o-', '.nfi-a-', '.nora-first-install-old-', '.nora-first-install-apply-'])]:
                    original = container.get(key)
                    for value in [*[prefix + 'a' * 32 for prefix in invalid], valid + 'a' * 31,
                            valid + 'A' * 32, 'other/' + valid + 'a' * 32, '../' + valid + 'a' * 32,
                            '/' + valid + 'a' * 32]:
                        with self.subTest(key=key, value=value):
                            container[key] = value
                            with self.assertRaisesRegex(RuntimeError, '不受信任'): journal.validate()
                    if original is None: container.pop(key)
                    else: container[key] = original
                journal.validate()
                self.assertEqual(config.read_bytes(), b'candidate')

    def test_code_digest_progress_preserves_original_hash_and_excludes_migration_backup_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'a-empty').write_bytes(b'')
            engine=root/'engine/sillytavern';engine.mkdir(parents=True)
            (engine/'server.js').write_bytes(b'code');(engine/'backups').mkdir()
            (engine/'backups/private.dat').write_bytes(b'ignored'*100)
            (root/'z-large').write_bytes(b'x'*(1024*1024+7))
            expected='08c0c337ebda3ab6204ca665726bbffed24ae0fb29c2b7aa390e74332d843b7c'
            self.assertEqual(first_install.first_install_code_digest(root),expected)
            progress=[]
            self.assertEqual(first_install.first_install_code_digest(root,on_progress=lambda size,entries:progress.append((size,entries))),expected)
            self.assertEqual(progress,[(0,1),(0,1),(0,1),(0,1),(0,1),(4,0),(0,1),(1024*1024,0),(7,0)])
            self.assertEqual((engine/'backups/private.dat').read_bytes(),b'ignored'*100)
            progress=[]
            empty=root/'empty';empty.mkdir()
            self.assertEqual(first_install.first_install_code_digest(empty,on_progress=lambda size,entries:progress.append((size,entries))),
                first_install.first_install_code_digest(empty))
            self.assertEqual(progress,[(0,1)])

    def test_code_digest_progress_reports_no_bytes_for_a_failed_read(self):
        with tempfile.TemporaryDirectory() as temporary:
            file=Path(temporary)/'program';file.write_bytes(b'read must succeed before counting')
            progress=[]
            with patch.object(Path,'open',side_effect=OSError('read failed')):
                with self.assertRaisesRegex(OSError,'read failed'):
                    first_install.first_install_code_digest(file,on_progress=lambda size,entries:progress.append((size,entries)))
            self.assertEqual(progress,[(0,1)])

    def test_declared_skill_io_path_round_trips_without_admitting_unknown_targets(self):
        for existed in (False, True):
            with self.subTest(existed=existed), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
                hermes.mkdir(); tavern.mkdir()
                skill = hermes / 'skills/creative/tavern'; skill.parent.mkdir(parents=True)
                if existed:
                    skill.mkdir(); (skill / 'SKILL.md').write_bytes(b'original skill')
                source = home / 'prepared-skill'; source.mkdir(); (source / 'SKILL.md').write_bytes(b'candidate skill')
                with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                    journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                    journal.prepare({'hermes': [skill]}, manifest={})
                    io_path = Path(first_install.filesystem_path(skill))
                    self.assertIs(journal.item_for(skill), journal.item_for(io_path))
                    with self.assertRaisesRegex(RuntimeError, '受管清单'):
                        journal.item_for(Path(first_install.filesystem_path(skill.with_name('not-declared'))))
                    journal.checkpoint('apply', 'intent'); journal.apply(source, io_path)
                    self.assertEqual((skill / 'SKILL.md').read_bytes(), b'candidate skill')
                    result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                self.assertEqual(result['status'], 'restored')
                if existed: self.assertEqual((skill / 'SKILL.md').read_bytes(), b'original skill')
                else: self.assertFalse(skill.exists())

    def test_declared_skill_link_after_prepare_cannot_redirect_a_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir()
            skill = hermes / 'skills/creative/tavern'; skill.parent.mkdir(parents=True)
            outside = home / 'user-content'; outside.mkdir(); (outside / 'SKILL.md').write_bytes(b'preserve user content')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [skill]}, manifest={})
                skill.symlink_to(outside, target_is_directory=True)
                with self.assertRaisesRegex(RuntimeError, '链接'):
                    journal.item_for(Path(first_install.filesystem_path(skill)))
            self.assertEqual((outside / 'SKILL.md').read_bytes(), b'preserve user content')

    def test_fsync_tree_flushes_owned_files_without_changing_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            file = root / 'prepared' / 'nested' / 'config.yaml'
            file.parent.mkdir(parents=True)
            content = b'user_preference: preserve\n'
            file.write_bytes(content)
            before = file.stat()
            first_install.fsync_tree(root / 'prepared')
            after = file.stat()
            self.assertEqual(file.read_bytes(), content)
            self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
            self.assertEqual(after.st_mtime_ns, before.st_mtime_ns)

    def committed_fixture(self, home, *, during_startup=None):
        hermes, tavern = home / 'hermes', home / 'tavern'
        hermes.mkdir(); tavern.mkdir()
        app = tavern / 'apps/tavern-runtime'
        config = hermes / 'config.yaml'
        runs = tavern / 'tavern-state/native-runtime/runs'
        config.write_text('user_preference: original\n')
        manifest = {'schema': 'tavern-release/v2', 'commit': 'a' * 40,
            'sourceDigest': 'b' * 64, 'sourceFiles': {'app/server.js': 'c' * 64},
            'artifacts': {'app/server.js': 'c' * 64},
            'versions': {'tavern': '2.4.2', 'ops': '2.4.2', 'nora-mcp': '1.0.0'},
            'hermesRuntime': {'schema': 1, 'sha256': 'd' * 64}}
        receipts = [tavern / 'tavern-updates' / name for name in ('installed.json', 'installed-manifest.json')]
        journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
        journal.prepare({'hermes': [config], 'tavern': [app, runs, *receipts]}, manifest=manifest)
        journal.checkpoint('apply', 'intent')
        prepared = home / 'prepared-app'; prepared.mkdir(); (prepared / 'server.js').write_text('candidate code')
        (prepared / 'engine/sillytavern').mkdir(parents=True)
        journal.apply(prepared, app)
        prepared_runs = home / 'prepared-runs'; prepared_runs.mkdir(); (prepared_runs / 'native.log').write_text('startup')
        journal.apply(prepared_runs, runs)
        if during_startup: during_startup(app)
        first_install.write_install_receipt(tavern, manifest, journal)
        journal.checkpoint('commit', 'result'); journal.checkpoint('apply', 'result')
        return journal, hermes, tavern, manifest

    def test_committed_install_keeps_migration_backups_mutable_without_reauthorizing_program_bytes(self):
        for during_startup in ('empty_backup', 'program_changed', 'program_identity_changed'):
            with self.subTest(during_startup=during_startup), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                def startup(app):
                    (app / 'engine/sillytavern/backups').mkdir()
                    if during_startup == 'program_changed': (app / 'server.js').write_text('changed before commit')
                    elif during_startup == 'program_identity_changed':
                        app.rename(app.with_name('original-runtime'))
                        shutil.copytree(app.with_name('original-runtime'), app)
                with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                    journal, _hermes, tavern, _manifest = self.committed_fixture(home, during_startup=startup)
                    before = journal.file.read_bytes()
                    backups = tavern / 'apps/tavern-runtime/engine/sillytavern/backups'
                    (backups / '_migration').mkdir()
                    (backups / '_migration/chat.json').write_text('user migration backup')
                    result = first_install.inspect_first_install(journal.file)
                    self.assertEqual(result['effectState'], 'changed' if during_startup == 'empty_backup' else 'unknown')
                    self.assertEqual(result.get('canResume', False), during_startup == 'empty_backup')
                    self.assertEqual(journal.file.read_bytes(), before)
                    self.assertEqual((backups / '_migration/chat.json').read_text(), 'user migration backup')

    def test_committed_install_rejects_unrecognized_program_file_or_linked_backup_root(self):
        for changed in ('unrecognized_file', 'backup_link'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                    journal, _hermes, tavern, _manifest = self.committed_fixture(home)
                    engine = tavern / 'apps/tavern-runtime/engine/sillytavern'
                    if changed == 'unrecognized_file': (engine / 'unrecognized.js').write_text('unrecognized code')
                    else:
                        outside = home / 'outside-backup'; outside.mkdir()
                        (engine / 'backups').symlink_to(outside, target_is_directory=True)
                    result = first_install.inspect_first_install(journal.file)
                    self.assertEqual(result['effectState'], 'unknown')
                    self.assertFalse(result.get('canResume', False))

    def test_runtime_file_dependencies_are_materialized_in_prepared_source_before_code_seal(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            source = home / 'source-app'; work = home / 'work'
            engine = source / 'engine/sillytavern'; engine.mkdir(parents=True); work.mkdir()
            shutil.copy2(first_install.ROOT / 'app/native_lifecycle.py', source)
            shutil.copy2(first_install.ROOT / 'app/native-runtime.json', source)
            (engine / 'package.json').write_text(json.dumps({'dependencies': {'fixture-local': 'file:local-package'}}))
            package = engine / 'local-package'; package.mkdir()
            (package / 'package.json').write_text('{"name":"fixture-local"}')
            (package / 'index.js').write_text('export const fixture = true;')
            (engine / 'node_modules').mkdir()
            linked = engine / 'node_modules/fixture-local'; linked.symlink_to('../local-package', target_is_directory=True)
            original = first_install._recovery.digest(source)
            prepared = first_install.prepare_runtime_source(source, work)
            self.assertTrue(linked.is_symlink())
            self.assertEqual(first_install._recovery.digest(source), original)
            copied = prepared / 'engine/sillytavern/node_modules/fixture-local'
            self.assertTrue(copied.is_dir()); self.assertFalse(copied.is_symlink())
            hermes, tavern = home / 'hermes', home / 'tavern'; hermes.mkdir(); tavern.mkdir()
            target = tavern / 'apps/tavern-runtime'
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'tavern': [target]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply(prepared, target)
            sealed = first_install._recovery.digest(target)
            lifecycle = first_install.module_at('first_install_prepared_native_test', target / 'native_lifecycle.py')
            contract = lifecycle.RuntimeContract.from_dict(json.loads((target / 'native-runtime.json').read_text()))
            runtime = lifecycle.NativeRuntime(tavern, target, tavern / 'tavern-state', contract)
            self.assertEqual(runtime.materialize_local_dependencies(), [])
            self.assertEqual(first_install._recovery.digest(target), sealed)
            self.assertEqual(journal.item_for(target)['codeDigest'], first_install.first_install_code_digest(target))
            self.assertFalse((tavern / 'tavern-state').exists())

    def test_committed_install_can_resume_acceptance_after_runtime_log_and_user_config_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal, hermes, tavern, _manifest = self.committed_fixture(home)
                (tavern / 'tavern-state/native-runtime/runs/native.log').write_text('startup\nruntime observation')
                (hermes / 'config.yaml').write_text('user_preference: updated\n')
                before = journal.file.read_bytes()
                result = first_install.inspect_first_install(journal.file)
                self.assertEqual(result['status'], 'committed')
                self.assertEqual(result['operationId'], OPERATION_ID)
                self.assertEqual(result['effectState'], 'changed'); self.assertTrue(result['canResume'])
                self.assertEqual(journal.file.read_bytes(), before)

    def test_committed_install_rejects_changed_manifest_receipt_code_or_root_identity(self):
        for changed in ('manifest', 'receipt', 'code', 'root', 'journal'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                    journal, hermes, tavern, manifest = self.committed_fixture(home)
                    if changed == 'manifest':
                        manifest['artifacts']['app/server.js'] = 'e' * 64
                        # Even a known owned exchange cannot replace the frozen target.
                        journal.apply_bytes(tavern / 'tavern-updates/installed-manifest.json', json.dumps(manifest).encode())
                    elif changed == 'receipt':
                        file = tavern / 'tavern-updates/installed.json'
                        value = json.loads(file.read_text()); value['version'] = '9.9.9'
                        journal.apply_bytes(file, json.dumps(value).encode())
                    elif changed == 'code':
                        (tavern / 'apps/tavern-runtime/server.js').write_text('unrecognized code')
                    elif changed == 'root':
                        hermes.rename(home / 'original-hermes'); hermes.mkdir()
                    else:
                        value = json.loads(journal.file.read_text()); value['checkpoints'] = []
                        journal.file.write_text(json.dumps(value))
                    result = first_install.inspect_first_install(journal.file)
                    self.assertEqual(result['effectState'], 'unknown'); self.assertFalse(result.get('canResume', False))

    def installation(self, home, failure, stop):
        source, hermes, tavern = home / 'source', home / 'hermes', home / 'tavern'
        hermes.mkdir()
        (hermes / 'config.yaml').write_bytes(b'original config')
        for name in ('app', 'nora-mcp', 'ops/skills', 'ops/installer/templates'):
            (source / name).mkdir(parents=True)
        (source / 'app/server.js').write_text('failed runtime fixture')
        (source / 'ops/skills/agents-tavern.md').write_text('Nora fixture instructions\n')
        for relative in ('ops/updater/managed_context.py', 'ops/updater/clawchat_greeting_patch.py',
                         'ops/scripts/nora-instance.py', 'ops/installer/templates/greeting.md',
                         'ops/installer/templates/SOUL.md'):
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(first_install.ROOT / relative, target)
        args = SimpleNamespace(apply=True, confirm=True, nora_home=str(home), hermes_home=str(hermes),
            install_root=str(tavern), port=18899, dedicated_nora=False, force_first_install=False,
            replace_soul=False, skip_liveware=True)
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer'), 'NORA_OPERATION_ID': OPERATION_ID}))
            for name, replacement in {
                'validate_hermes': lambda *_args, **_kwargs: {},
                'source_from_release': lambda *_args: (source, {'versions': {'tavern': '2.2.8'}}),
                'prepare_runtime_source': lambda app, _work: app,
                'prepare_skills': lambda *_args: {},
                'install_host_hook': lambda *_args: 'fixture hook',
                'render_mcp': lambda *_args: b'new config',
                'install_update_check': lambda *_args: {'status': 'installed'},
                'start_tavern': lambda *_args: (_ for _ in ()).throw(failure),
                'stop_install_runtime': stop,
                'event': lambda *_args, **_kwargs: None,
                'log': lambda *_args: None,
            }.items(): stack.enter_context(patch.object(first_install, name, replacement))
            try: first_install.install(args)
            except Exception as caught: return caught, hermes, tavern
            self.fail('fixture must fail during actual first installation')

    def test_durable_journal_restores_config_and_preserves_failed_runtime_and_story_data(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {}, clear=False):
            home = Path(temporary)
            hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir()
            config = hermes / 'config.yaml'
            config.write_bytes(b'original user config')
            data = tavern / 'tavern-state/native/default-user/chats/story.json'
            data.parent.mkdir(parents=True); data.write_bytes(b'original story')
            app = tavern / 'apps/tavern-runtime'
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config], 'tavern': [app]}, manifest={'versions': {'tavern': '2.2.8'}})
                journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'new config')
                app.mkdir(parents=True); (app / 'server.js').write_bytes(b'failed runtime')
                journal.checkpoint('apply', 'result')
                result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
            self.assertEqual(result['status'], 'restored')
            self.assertEqual(config.read_bytes(), b'original user config')
            self.assertEqual(data.read_bytes(), b'original story')
            self.assertFalse(app.exists())
            self.assertTrue(any(path.read_bytes() == b'failed runtime' for path in journal.directory.rglob('server.js')))
            saved = json.loads(journal.file.read_text())
            self.assertEqual(saved['operationId'], OPERATION_ID)
            self.assertEqual(saved['checkpoints']['apply']['state'], 'result')
            self.assertFalse(journal.directory.is_relative_to(tavern))

    def test_first_install_freezes_before_stop_and_stop_failure_keeps_original_and_blocks_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            original = RuntimeError('actual startup failure')
            stop_error = RuntimeError('runtime stop denied')
            def stop(_root):
                evidence = home / 'installer/operations' / OPERATION_ID / 'evidence/python.json'
                self.assertEqual(json.loads(evidence.read_text())['primary']['message'], str(original))
                raise stop_error
            caught, hermes, tavern = self.installation(home, original, stop)
            self.assertIs(caught, original)
            self.assertIn(stop_error, caught.secondary_errors)
            self.assertEqual((hermes / 'config.yaml').read_bytes(), b'new config')
            self.assertTrue((tavern / 'apps/tavern-runtime/server.js').exists())
            journal = json.loads((home / 'installer/operations' / OPERATION_ID / 'first-install/transaction.json').read_text())
            self.assertEqual(journal['status'], 'blocked_stop')
            self.assertTrue(journal['unrestored'])

    def test_restore_can_resume_after_both_archive_and_install_rename_interruptions(self):
        class PowerLoss(BaseException): pass
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir()
            config = hermes / 'config.yaml'; config.write_bytes(b'original config')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={'versions': {'tavern': '2.2.8'}})
                journal.checkpoint('apply', 'intent'); journal.apply_bytes(config, b'failed new config')
                journal.checkpoint('apply', 'result')
                actual_replace = os.replace
                def interrupted(phase):
                    def replace(source, target):
                        actual_replace(source, target)
                        if phase == 'archive' and 'failed-new' in Path(target).parts: raise PowerLoss()
                        if phase == 'install' and same_filesystem_path(target, config): raise PowerLoss()
                    return replace
                for phase in ('archive', 'install'):
                    with self.subTest(phase=phase), patch.object(first_install.os, 'replace', side_effect=interrupted(phase)):
                        with self.assertRaises(PowerLoss): first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                restored = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
            self.assertEqual(restored['status'], 'restored')
            self.assertEqual(config.read_bytes(), b'original config')
            archived = [path.read_bytes() for path in (journal.directory / 'failed-new').rglob('*') if path.is_file()]
            self.assertIn(b'failed new config', archived)
            self.assertEqual(list(hermes.glob('.nora-first-install-restore-*')), [])
            self.assertEqual(list(hermes.glob('.nfi-r-*')), [])

    def test_corrupt_backup_preserves_that_target_while_other_managed_targets_restore(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir()
            config = hermes / 'config.yaml'; config.write_bytes(b'original config')
            app = tavern / 'apps/tavern-runtime'
            app.mkdir(parents=True); (app / 'server.js').write_bytes(b'original runtime')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config], 'tavern': [app]}, manifest={'versions': {'tavern': '2.2.8'}})
                journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'failed config'); (app / 'server.js').write_bytes(b'failed runtime')
                journal.checkpoint('apply', 'result')
                saved = journal.backup_target(journal.record['targets'][0])
                saved.write_bytes(b'corrupt backup')
                result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                self.assertEqual(result['status'], 'recovery_failed')
                self.assertEqual(config.read_bytes(), b'failed config')
                self.assertEqual((app / 'server.js').read_bytes(), b'original runtime')
                self.assertEqual(result['unrestored'][0]['path'], 'config.yaml')
                saved.write_bytes(b'original config')
                self.assertEqual(first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})['status'], 'restored')
            self.assertEqual(config.read_bytes(), b'original config')

    def test_unknown_target_identity_is_preserved_and_reported_as_unrestored(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir()
            config = hermes / 'config.yaml'; config.write_bytes(b'original config')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={'versions': {'tavern': '2.2.8'}})
                config.rename(hermes / 'original-retained.yaml')
                config.write_bytes(b'unknown external config')
                result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
            self.assertEqual(result['status'], 'recovery_failed')
            self.assertEqual(config.read_bytes(), b'unknown external config')
            self.assertEqual(result['unrestored'][0]['path'], 'config.yaml')
            self.assertTrue(any(path.read_bytes() == b'unknown external config'
                for path in (journal.directory / 'failed-new').rglob('*') if path.is_file()))

    def test_apply_rename_crash_keeps_config_identity_for_resumable_recovery(self):
        class PowerLoss(BaseException): pass
        for boundary in ('archive', 'install'):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                hermes, tavern = home / 'hermes', home / 'tavern'
                hermes.mkdir(); tavern.mkdir()
                config = hermes / 'config.yaml'; config.write_bytes(b'original config')
                with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                    journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                    journal.prepare({'hermes': [config]}, manifest={'versions': {'tavern': '2.2.8'}})
                    journal.checkpoint('apply', 'intent')
                    actual_replace = os.replace
                    def replace(source, target):
                        actual_replace(source, target)
                        if boundary == 'archive' and same_filesystem_path(source, config): raise PowerLoss()
                        if boundary == 'install' and same_filesystem_path(target, config): raise PowerLoss()
                    with patch.object(first_install.os, 'replace', side_effect=replace):
                        with self.assertRaises(PowerLoss): journal.apply_bytes(config, b'new configuration')
                    restored = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                self.assertEqual(restored['status'], 'restored')
                self.assertEqual(config.read_bytes(), b'original config')
                self.assertEqual(list(hermes.glob('.nora-first-install-*')), [])
                self.assertEqual(list(hermes.glob('.nfi-*')), [])
                self.assertTrue(any(path.read_bytes() in (b'new configuration', b'original config')
                    for path in (journal.directory / 'failed-new').rglob('*') if path.is_file()))

    def test_managed_configuration_seeder_runs_in_prepared_home_before_journal_exchange(self):
        from ops.installer import nora_system
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            hermes, tavern, source = home / 'hermes', home / 'tavern', home / 'source'
            hermes.mkdir(); tavern.mkdir()
            for relative in ('ops/updater/managed_context.py', 'ops/scripts/nora-instance.py', 'ops/installer/templates/greeting.md'):
                target = source / relative; target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(first_install.ROOT / relative, target)
            plugin = hermes / 'plugins/clawchat/clawchat_gateway'
            (plugin / 'bundled/fixture').mkdir(parents=True)
            (plugin / '__init__.py').write_text('')
            (plugin / 'bundled/fixture/SKILL.md').write_text('fixture skill')
            (plugin / 'skill_update.py').write_text('''
import os
from pathlib import Path
def bundled_skill_ids(): return ['fixture']
def bundled_skills_dir(): return Path(__file__).parent / 'bundled'
def seed_managed_skill(name, origin):
    home = Path(os.environ['HERMES_HOME'])
    assert home == Path.cwd()
    assert not home.joinpath('ORIGINAL_HOME').exists(), 'must seed isolated prepared home'
    target = home / 'clawchat-skills' / name / 'SKILL.md'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(origin.read_bytes())
def ensure_external_skills_dir():
    import yaml
    config = Path(os.environ['HERMES_HOME']) / 'config.yaml'
    value = yaml.safe_load(config.read_text()) if config.exists() else {}
    value.setdefault('skills', {})['external_dirs'] = ['clawchat-skills']
    config.write_text(yaml.safe_dump(value))
''')
            (hermes / 'ORIGINAL_HOME').write_text('existing home')
            (hermes / 'config.yaml').write_text('user_setting: kept\n')
            targets = [hermes / relative for relative in ('config.yaml', 'nora-instance.json', 'clawchat/greeting.md',
                'clawchat/nora-greeting.json', 'clawchat/greeting.nora-example.md', 'scripts/nora-instance.py', 'clawchat-skills')]
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': targets}, manifest={'versions': {'tavern': '2.2.8'}})
                journal.checkpoint('apply', 'intent')
                nora_system.configure_managed(hermes, tavern, home, 18899, source, sys.executable, dict(os.environ),
                    journal=journal, work=home / 'work')
            self.assertEqual(json.loads((hermes / 'nora-instance.json').read_text())['port'], 18899)
            self.assertEqual((hermes / 'clawchat-skills/fixture/SKILL.md').read_text(), 'fixture skill')
            import yaml
            config = yaml.safe_load((hermes / 'config.yaml').read_text())
            self.assertEqual(config['user_setting'], 'kept')
            self.assertEqual(config['skills']['external_dirs'], ['clawchat-skills'])
            self.assertTrue(all(item['exchanges'][-1]['phase'] == 'new-rename-result'
                for item in journal.record['targets'] if item.get('exchanges')))

    def test_resume_requires_positive_offline_proof_before_any_target_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir()
            config = hermes / 'config.yaml'; config.write_bytes(b'original config')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={})
                journal.checkpoint('apply', 'intent'); journal.apply_bytes(config, b'new config')
                result = first_install.resume_first_install(journal.file, stop=lambda: None)
            self.assertEqual(result['status'], 'blocked_stop')
            self.assertEqual(config.read_bytes(), b'new config')
            self.assertEqual(result['unrestored'][0]['reason'], 'runtime_not_stopped')

    def test_failed_managed_code_changed_after_apply_is_archived_and_restored_when_offline(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir()
            app = tavern / 'apps/tavern-runtime'; app.mkdir(parents=True)
            (app / 'server.js').write_bytes(b'original code')
            source = home / 'staged'; source.mkdir(); (source / 'server.js').write_bytes(b'candidate code')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'tavern': [app]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply(source, app)
                shutil.rmtree(app); app.mkdir(); (app / 'server.js').write_bytes(b'failed runtime changed code')
                result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
            self.assertEqual(result['status'], 'restored')
            self.assertEqual((app / 'server.js').read_bytes(), b'original code')
            self.assertTrue(any(path.read_bytes() == b'failed runtime changed code'
                for path in (journal.directory / 'failed-new').rglob('server.js')))

    def test_actual_install_hard_exit_after_configuration_exchange_recovers_original_configuration(self):
        class PowerLoss(BaseException): pass
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); config = home / 'hermes/config.yaml'
            actual_replace = os.replace
            def replace(source, target):
                actual_replace(source, target)
                if same_filesystem_path(target, config): raise PowerLoss()
            with patch.object(first_install.os, 'replace', side_effect=replace):
                with self.assertRaises(PowerLoss): self.installation(home, RuntimeError('unreached'), lambda _root: {'offline': True})
            journal_file = home / 'installer/operations' / OPERATION_ID / 'first-install/transaction.json'
            restored = first_install.resume_first_install(journal_file, stop=lambda: {'offline': True})
            self.assertEqual(restored['status'], 'restored')
            self.assertEqual(config.read_bytes(), b'original config')

    def test_readonly_effect_inspection_uses_actual_exchange_and_restore_facts(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={})
                untouched = first_install.inspect_first_install(journal.file)
                self.assertEqual(untouched['effectState'], 'untouched')
                journal.checkpoint('apply', 'intent'); journal.apply_bytes(config, b'changed')
                before = journal.file.read_bytes(), journal.file.stat().st_mtime_ns
                changed = first_install.inspect_first_install(journal.file)
                self.assertEqual(changed['effectState'], 'changed'); self.assertTrue(changed['canRecover'])
                self.assertEqual((journal.file.read_bytes(), journal.file.stat().st_mtime_ns), before)
                first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                self.assertEqual(first_install.inspect_first_install(journal.file)['effectState'], 'restored')

    def test_readonly_effect_inspection_reports_unknown_configuration_and_corrupt_backup(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'changed')
                config.write_bytes(b'concurrent user configuration')
                result = first_install.inspect_first_install(journal.file)
                self.assertEqual(result['effectState'], 'unknown'); self.assertFalse(result['canRecover'])
                journal.backup_target(journal.record['targets'][0]).write_bytes(b'corrupt')
                self.assertEqual(first_install.inspect_first_install(journal.file)['reason'], 'backup_invalid')

    def test_actual_install_resumes_after_every_managed_apply_rename_boundary(self):
        class PowerLoss(BaseException): pass
        actual_replace = os.replace
        def managed(source, target):
            return Path(source).name.startswith(('.nora-first-install-apply-', '.nfi-a-')) or Path(target).name.startswith(('.nora-first-install-old-', '.nfi-o-'))
        boundaries = []
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            def record(source, target):
                actual_replace(source, target)
                if managed(source, target): boundaries.append((Path(target).name, len(boundaries)))
            with patch.object(first_install.os, 'replace', side_effect=record):
                caught, _hermes, _tavern = self.installation(home, RuntimeError('fixture startup failed'), lambda _root: {'offline': True})
            self.assertEqual(str(caught), 'fixture startup failed'); self.assertGreaterEqual(len(boundaries), 5)
        for label, boundary in boundaries:
            with self.subTest(target=label, boundary=boundary), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve(); current = 0
                def interrupted(source, target):
                    nonlocal current
                    actual_replace(source, target)
                    if managed(source, target):
                        if current == boundary: raise PowerLoss()
                        current += 1
                with patch.object(first_install.os, 'replace', side_effect=interrupted):
                    with self.assertRaises(PowerLoss): self.installation(home, RuntimeError('unreached'), lambda _root: {'offline': True})
                file = home / 'installer/operations' / OPERATION_ID / 'first-install/transaction.json'
                result = first_install.resume_first_install(file, stop=lambda: {'offline': True})
                self.assertEqual(result['status'], 'restored')
                self.assertEqual((home / 'hermes/config.yaml').read_bytes(), b'original config')
                self.assertFalse((home / 'tavern/apps/tavern-runtime').exists())
                self.assertEqual(list((home / 'hermes').glob('.nora-first-install-*')), [])
                self.assertEqual(list((home / 'hermes').glob('.nfi-*')), [])
                self.assertTrue(all(item.get('phase') == 'restored' for item in json.loads(file.read_text())['targets']))

    def test_exchange_artifact_archive_can_resume_after_hard_exit(self):
        class PowerLoss(BaseException): pass
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'failed config')
                actual_replace = os.replace
                def interrupted(source, target):
                    actual_replace(source, target)
                    if Path(source).name.startswith(('.nora-first-install-old-', '.nfi-o-')): raise PowerLoss()
                with patch.object(first_install.os, 'replace', side_effect=interrupted):
                    with self.assertRaises(PowerLoss): first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                self.assertEqual(result['status'], 'restored'); self.assertEqual(config.read_bytes(), b'original')
                self.assertEqual(list(hermes.glob('.nora-first-install-*')), [])
                self.assertEqual(list(hermes.glob('.nfi-*')), [])

    def test_completed_install_strict_restore_preserves_code_changed_after_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); app = tavern / 'apps/tavern-runtime'; app.mkdir(parents=True)
            (app / 'server.js').write_bytes(b'original')
            source = home / 'candidate'; source.mkdir(); (source / 'server.js').write_bytes(b'candidate')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'tavern': [app]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply(source, app); journal.checkpoint('commit', 'result')
                (app / 'server.js').write_bytes(b'changed after success')
                result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
            self.assertEqual(result['status'], 'recovery_failed')
            self.assertEqual((app / 'server.js').read_bytes(), b'changed after success')

    def test_trusted_flat_recovery_closure_resumes_without_installed_operations_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original')
            closure = home / 'trusted/resources'; closure.mkdir(parents=True)
            for source, name in [(Path(first_install.__file__), 'first_install.py'),
                    (first_install._shared_paths_path, 'update_paths.py'),
                    (first_install._diagnostics_path, 'error_diagnostics.py'),
                    (first_install._evidence_path, 'operation_evidence.py'),
                    (first_install._recovery_path, 'update_recovery.py'),
                    (first_install._control_path, 'operation_control.py'),
                    (first_install._control_path.with_name('operation-budget.json'), 'operation-budget.json')]:
                shutil.copy2(source, closure / name)
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'failed configuration')
                trusted = first_install.module_at('fixture_flat_first_install', closure / 'first_install.py')
                self.assertEqual(trusted.inspect_first_install(journal.file)['effectState'], 'changed')
                result = trusted.resume_first_install(journal.file, stop=lambda: {'offline': True})
            self.assertEqual(result['status'], 'restored'); self.assertEqual(config.read_bytes(), b'original')

    def test_same_bytes_exchange_is_observed_as_restored_after_permission_restore(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'original')
                result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                self.assertEqual(result['status'], 'restored')
                self.assertEqual(first_install.inspect_first_install(journal.file)['effectState'], 'restored')

    def test_unknown_configuration_link_blocks_only_its_target_without_reading_external_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original config')
            app = tavern / 'apps/tavern-runtime'; app.mkdir(parents=True); (app / 'server.js').write_bytes(b'original code')
            source = home / 'candidate'; source.mkdir(); (source / 'server.js').write_bytes(b'failed candidate')
            external = home / 'external'; external.write_bytes(b'PRIVATE_EXTERNAL_CONFIG')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config], 'tavern': [app]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply(source, app)
                config.unlink(); config.symlink_to(external)
                result = first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
            self.assertEqual(result['status'], 'recovery_failed'); self.assertTrue(config.is_symlink())
            self.assertEqual(external.read_bytes(), b'PRIVATE_EXTERNAL_CONFIG')
            self.assertEqual((app / 'server.js').read_bytes(), b'original code')
            self.assertEqual([item['path'] for item in result['unrestored']], ['config.yaml'])
            self.assertFalse(any(path.read_bytes() == b'PRIVATE_EXTERNAL_CONFIG'
                for path in (journal.directory / 'failed-new').rglob('*') if path.is_file()))

    def test_delegated_windows_hermes_entrypoint_runs_the_module_under_owned_python(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary).resolve() / 'hermes.exe'
            executable.write_bytes(b'MZ binary fixture cannot be run_path')
            with patch.dict(os.environ, {'NORA_OPERATION_DELEGATE_ENDPOINT': '127.0.0.1:1'}), \
                    patch.object(first_install._operation_control, 'managed_run', return_value=SimpleNamespace(returncode=0)) as run:
                first_install.maintenance_run([str(executable), 'cron', 'create', 'fixture'], capture_output=True)
            command = run.call_args.args[0]
            self.assertEqual(command[:3], [sys.executable, '-B', '-c'])
            self.assertIn('from hermes_cli.main import main', command[3])
            self.assertNotIn('run_path', command[3])
            self.assertNotIn(str(executable), command)
            self.assertEqual(command[4:], ['cron', 'create', 'fixture'])

    def test_same_operation_retry_archives_restored_attempt_without_losing_backup_or_primary(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={}); journal.checkpoint('apply', 'intent')
                journal.apply_bytes(config, b'failed config')
                evidence = first_install._operation_evidence.freeze(RuntimeError('first actual failure'), nora_home=home, operation_id=OPERATION_ID)
                primary = Path(evidence['path']).read_bytes()
                first_install.resume_first_install(journal.file, stop=lambda: {'offline': True})
                retry = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                retry.prepare({'hermes': [config]}, manifest={}); retry.checkpoint('apply', 'intent')
                retry.apply_bytes(config, b'retry configuration')
                first_install._operation_evidence.freeze(RuntimeError('later failure'), nora_home=home, operation_id=OPERATION_ID)
            self.assertEqual(retry.record['attempt'], 2)
            self.assertEqual(retry.record['operationId'], OPERATION_ID)
            archive = home / 'installer/operations' / OPERATION_ID / 'attempts/attempt-0001'
            self.assertEqual((archive / 'first-install/backups/000').read_bytes(), b'original')
            self.assertEqual((archive / 'evidence/python.json').read_bytes(), primary)
            self.assertEqual(json.loads(Path(evidence['path']).read_text())['primary']['message'], 'first actual failure')
            self.assertEqual(config.read_bytes(), b'retry configuration')

    def test_same_operation_retry_continues_after_attempt_directory_archive_hard_exit(self):
        class PowerLoss(BaseException): pass
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                journal.prepare({'hermes': [config]}, manifest={})
                actual_replace = os.replace
                def interrupted(source, target):
                    actual_replace(source, target)
                    if same_filesystem_path(source, journal.directory): raise PowerLoss()
                with patch.object(first_install.os, 'replace', side_effect=interrupted):
                    with self.assertRaises(PowerLoss): first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                retry = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
            self.assertEqual(retry.record['attempt'], 2); self.assertEqual(config.read_bytes(), b'original')
            self.assertTrue((home / 'installer/operations' / OPERATION_ID / 'attempts/attempt-0001/first-install/transaction.json').exists())

    def test_same_operation_retry_rejects_actual_unknown_effects_and_allows_unapplied_prepare_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir(); config = hermes / 'config.yaml'; config.write_bytes(b'original')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                self.assertEqual(first_install.inspect_first_install(journal.file)['effectState'], 'untouched')
                retry = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                retry.prepare({'hermes': [config]}, manifest={}); retry.checkpoint('apply', 'intent')
                retry.apply_bytes(config, b'candidate'); config.write_bytes(b'concurrent user config')
                before = retry.file.read_bytes()
                with self.assertRaises(RuntimeError): first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
            self.assertEqual(retry.file.read_bytes(), before); self.assertEqual(config.read_bytes(), b'concurrent user config')

    def test_retry_resumes_after_empty_new_directory_creation_and_does_not_erase_unknown_files(self):
        class PowerLoss(BaseException): pass
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve(); hermes, tavern = home / 'hermes', home / 'tavern'
            hermes.mkdir(); tavern.mkdir()
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                journal = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                real_mkdir = Path.mkdir
                def interrupted(path, *args, **kwargs):
                    result = real_mkdir(path, *args, **kwargs)
                    if path == journal.directory and (journal.directory.parent / 'attempts/attempt-0001/first-install').exists(): raise PowerLoss()
                    return result
                with patch.object(Path, 'mkdir', side_effect=interrupted, autospec=True):
                    with self.assertRaises(PowerLoss): first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                self.assertFalse(journal.file.exists())
                retry = first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                self.assertEqual(retry.record['attempt'], 2)
                retry.file.unlink(); (retry.directory / 'unknown').write_bytes(b'user content')
                with self.assertRaises(RuntimeError): first_install.FirstInstallJournal.create(home, hermes, tavern, operation_id=OPERATION_ID)
                self.assertEqual((retry.directory / 'unknown').read_bytes(), b'user content')


if __name__ == '__main__':
    unittest.main()
