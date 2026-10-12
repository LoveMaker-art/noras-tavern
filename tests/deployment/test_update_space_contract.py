"""Exercise capacity gates through the real updater and automatic recovery."""
import errno
import json
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ops.installer import first_install
from ops.tests.test_update_migration_contract import MigrationInstallFixture


def chain(error):
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        yield error
        error = error.__cause__


class UpdateSpaceInstallContractTests(unittest.TestCase):
    @staticmethod
    def usage(free):
        return SimpleNamespace(total=100_000_000, used=100_000_000-free, free=free)

    @staticmethod
    def native(fixture):
        (fixture.root / 'apps/tavern-runtime/server.py').unlink()
        (fixture.root / 'apps/tavern-runtime/program.txt').write_text('old native program')
        (fixture.root / 'apps/tavern-runtime/native-runtime.json').write_text('{}')

    def assert_preserved(self, fixture, *, stopped, native=False):
        self.assertEqual(fixture.chat.read_bytes(), fixture.final if stopped else fixture.original)
        self.assertEqual(json.loads((fixture.root / 'tavern-updates/installed.json').read_text())['version'], '2.0.1')
        self.assertNotIn('new-runtime', fixture.events)
        self.assertTrue((fixture.root / 'apps/tavern-runtime' /
                         ('program.txt' if native else 'server.py')).is_file())
        if stopped:
            self.assertEqual(fixture.transaction()['status'], 'restored')
            self.assertIn('rollback' if fixture.managed else 'service-start', fixture.events)
        else:
            self.assertNotIn('stop', fixture.events)
            self.assertNotIn('service-stop', fixture.events)
            self.assertFalse((fixture.root / 'tavern-backups').exists())
            self.assertFalse((fixture.root / 'tavern-updates/transaction.json').exists())

    def test_before_stop_shortage_never_creates_backup_or_stops_or_replaces(self):
        for managed in (False, True):
            for native in (False, True):
                with self.subTest(managed=managed, native=native), tempfile.TemporaryDirectory(prefix='nora-space-admission-') as temporary:
                    fixture = MigrationInstallFixture(temporary, managed=managed)
                    if native:
                        self.native(fixture)
                    with patch.object(fixture.updater.shutil, 'disk_usage', return_value=self.usage(1)), \
                            self.assertRaises(OSError) as failure:
                        fixture.run()
                    self.assertEqual(failure.exception.errno, errno.ENOSPC)
                    self.assert_preserved(fixture, stopped=False, native=native)
                    self.assertNotIn('convert', fixture.events)

    def test_after_stop_capacity_loss_restores_service_without_conversion_or_swap(self):
        for managed in (False, True):
            for native in (False, True):
                with self.subTest(managed=managed, native=native), tempfile.TemporaryDirectory(prefix='nora-space-after-stop-') as temporary:
                    fixture = MigrationInstallFixture(temporary, managed=managed)
                    if native:
                        self.native(fixture)
                    capacities = []
                    def usage(_path):
                        capacities.append(fixture.stopped)
                        return self.usage(1 if fixture.stopped else 50_000_000)
                    with patch.object(fixture.updater.shutil, 'disk_usage', side_effect=usage), \
                            self.assertRaises(RuntimeError) as failure:
                        fixture.run()
                    self.assertTrue(any(isinstance(cause, OSError) and cause.errno == errno.ENOSPC
                                        for cause in chain(failure.exception)), str(failure.exception))
                    self.assertIn(False, capacities)
                    self.assertIn(True, capacities)
                    self.assert_preserved(fixture, stopped=True, native=native)
                    self.assertNotIn('convert', fixture.events)

    def test_post_stop_added_data_is_remeasured_and_kept(self):
        for managed in (False, True):
            with self.subTest(managed=managed), tempfile.TemporaryDirectory(prefix='nora-space-last-write-') as temporary:
                fixture = MigrationInstallFixture(temporary, managed=managed)
                extra = fixture.state / 'last-write-large.jsonl'
                original_lifecycle = fixture.lifecycle
                original_stop = fixture.service.stop
                def lifecycle(phase, *args):
                    result = original_lifecycle(phase, *args)
                    if phase == 'stop':
                        extra.write_bytes(b'x' * 5_000_000)
                    return result
                def stop():
                    original_stop()
                    extra.write_bytes(b'x' * 5_000_000)
                fixture.lifecycle = lifecycle
                fixture.service.stop = stop
                with patch.object(fixture.updater.shutil, 'disk_usage', return_value=self.usage(1_000_000)), \
                        self.assertRaises(RuntimeError) as failure:
                    fixture.run()
                self.assertTrue(any(isinstance(cause, OSError) and cause.errno == errno.ENOSPC
                                    for cause in chain(failure.exception)))
                self.assert_preserved(fixture, stopped=True)
                self.assertEqual(extra.stat().st_size, 5_000_000)
                self.assertNotIn('convert', fixture.events)

    def test_converted_output_space_loss_does_not_activate_candidate_state(self):
        for managed in (False, True):
            with self.subTest(managed=managed), tempfile.TemporaryDirectory(prefix='nora-space-after-conversion-') as temporary:
                fixture = MigrationInstallFixture(temporary, managed=managed)
                def usage(_path):
                    return self.usage(1 if 'convert' in fixture.events else 50_000_000)
                with patch.object(fixture.updater.shutil, 'disk_usage', side_effect=usage), \
                        self.assertRaises(RuntimeError) as failure:
                    fixture.run()
                self.assertTrue(any(isinstance(cause, OSError) and cause.errno == errno.ENOSPC
                                    for cause in chain(failure.exception)))
                self.assertIn('convert', fixture.events)
                self.assertTrue(fixture.converted_after_stop)
                self.assertFalse((fixture.state / 'converted.txt').exists())
                self.assert_preserved(fixture, stopped=True)

    def test_sufficient_capacity_allows_native_and_legacy_managed_and_direct_updates(self):
        for managed in (False, True):
            for native in (False, True):
                with self.subTest(managed=managed, native=native), tempfile.TemporaryDirectory(prefix='nora-space-sufficient-') as temporary:
                    fixture = MigrationInstallFixture(temporary, managed=managed)
                    if native:
                        self.native(fixture)
                    with patch.object(fixture.updater.shutil, 'disk_usage', return_value=self.usage(50_000_000)) as query:
                        fixture.run()
                    self.assertGreaterEqual(query.call_count, 2)
                    self.assertEqual(fixture.transaction()['status'], 'committed')
                    self.assertEqual(fixture.chat.read_bytes(), fixture.final)
                    self.assertIn('new-runtime', fixture.events)
                    self.assertEqual('convert' in fixture.events, not native)

    def test_copy_enospc_after_successful_admission_preserves_actual_failure_and_last_write(self):
        for managed in (False, True):
            for native in (False, True):
                with self.subTest(managed=managed, native=native), tempfile.TemporaryDirectory(prefix='nora-space-copy-failure-') as temporary:
                    fixture = MigrationInstallFixture(temporary, managed=managed)
                    if native:
                        self.native(fixture)
                    extra = fixture.state / 'another-story'
                    extra.write_text('original extra data')
                    original_copy = shutil.copyfile
                    io_state = Path(fixture.updater.filesystem_path(fixture.state))
                    copied = []
                    original_error = OSError(errno.ENOSPC, 'space exhausted during actual state copy')
                    def copy(*args, **kwargs):
                        source = Path(args[0])
                        if source.is_relative_to(io_state) or source.is_relative_to(fixture.state):
                            if copied:
                                raise original_error
                            copied.append(source)
                        return original_copy(*args, **kwargs)
                    with patch.object(fixture.updater.shutil, 'disk_usage', return_value=self.usage(50_000_000)), \
                            patch.object(shutil, 'copyfile', side_effect=copy), \
                            patch.object(fixture.updater, 'fallback_python_state',
                                         wraps=fixture.updater.fallback_python_state) as fallback, \
                            self.assertRaises(RuntimeError) as failure:
                        fixture.run()
                    text = '; '.join(str(cause) for cause in chain(failure.exception))
                    self.assertIn('[Errno 28]', text)
                    self.assertIn('space exhausted during actual state copy', text)
                    self.assertEqual(len(copied), 1)
                    self.assert_preserved(fixture, stopped=True, native=native)
                    self.assertEqual(extra.read_text(), 'original extra data')
                    self.assertNotIn('convert', fixture.events)
                    fallback.assert_not_called()


class UpdateSpaceTaskContractTests(unittest.TestCase):
    def test_native_budget_tracks_metadata_destination_volumes_without_recounting_programs(self):
        with tempfile.TemporaryDirectory(prefix='nora-space-tasks-volumes-') as temporary:
            fixture = MigrationInstallFixture(temporary, managed=True)
            backup = fixture.root / 'tavern-backups/next'
            work = fixture.root / 'tavern-updates/prepared'
            (work / 'candidate').mkdir(parents=True)
            (work / 'candidate/already-extracted').write_bytes(b'x' * 1_000_000)
            (fixture.root / 'apps/tavern-runtime/already-installed').write_bytes(b'x' * 1_000_000)
            (fixture.root / 'tavern-backups/old').mkdir(parents=True)
            (fixture.root / 'tavern-backups/old/protected-data').write_bytes(b'x' * 1_000_000)
            tasks = fixture.updater.update_space_tasks(fixture.home, fixture.root, backup, work,
                managed=True, runtime_changed=True, migration=False)
            def volume(path):
                return 'hermes' if Path(path).is_relative_to(fixture.home) else 'install'
            report = fixture.updater.check_update_space(tasks,
                disk_usage=lambda _path: UpdateSpaceInstallContractTests.usage(50_000_000),
                volume_identity=volume)
            copies = [copy for item in report['volumes'] for copy in item['copies']]
            self.assertEqual(sum(copy['label'] == 'state-snapshot' for copy in copies), 1)
            self.assertNotIn('legacy-preparation', [copy['label'] for copy in copies])
            install, hermes = report['volumes']
            self.assertTrue(all(copy['label'] == 'metadata-restore' for copy in hermes['copies']))
            self.assertGreater(hermes['copyBytes'], 0)
            self.assertLess(install['copyBytes'] + hermes['copyBytes'], 10_000)
            self.assertEqual((fixture.root / 'tavern-backups/old/protected-data').stat().st_size, 1_000_000)
            self.assertFalse(backup.exists())

    def test_post_backup_budget_uses_saved_original_metadata_not_later_active_growth(self):
        with tempfile.TemporaryDirectory(prefix='nora-space-saved-budget-') as temporary:
            fixture = MigrationInstallFixture(temporary, managed=False)
            backup = fixture.root / 'tavern-backups/next'
            work = fixture.root / 'tavern-updates/prepared'
            tasks = fixture.updater.update_space_tasks(fixture.home, fixture.root, backup, work,
                managed=False, runtime_changed=True, migration=False)
            for task in tasks:
                if task['label'] != 'metadata-backup' or not task['source'].exists():
                    continue
                task['destination'].parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(task['source'], task['destination'])
            (fixture.home / 'config.yaml').write_bytes(b'x' * 1_000_000)
            tasks = fixture.updater.update_space_tasks(fixture.home, fixture.root, backup, work,
                managed=False, runtime_changed=True, migration=False, restore_only=True)
            report = fixture.updater.check_update_space(tasks,
                disk_usage=lambda _path: UpdateSpaceInstallContractTests.usage(200_000))
            copies = [copy for item in report['volumes'] for copy in item['copies']]
            self.assertTrue(all(copy['label'] in ('metadata-restore', 'state-snapshot') for copy in copies))
            self.assertLess(sum(item['copyBytes'] for item in report['volumes']), 10_000)
            self.assertEqual((fixture.home / 'config.yaml').stat().st_size, 1_000_000)

    def test_legacy_peak_reserves_preparation_and_partial_conversion_fallback_together(self):
        with tempfile.TemporaryDirectory(prefix='nora-space-legacy-peak-') as temporary:
            fixture = MigrationInstallFixture(temporary, managed=False)
            tasks = fixture.updater.update_space_tasks(fixture.home, fixture.root,
                fixture.root / 'tavern-backups/next', fixture.root / 'tavern-updates/prepared',
                managed=False, runtime_changed=True, migration=True)
            report = fixture.updater.check_update_space(tasks,
                disk_usage=lambda _path: UpdateSpaceInstallContractTests.usage(200_000))
            copies = [copy for item in report['volumes'] for copy in item['copies']]
            state = [copy for copy in copies if copy['label'].startswith('legacy-')]
            self.assertEqual([copy['label'] for copy in state], ['legacy-preparation', 'legacy-fallback'])
            self.assertEqual([copy['bytes'] for copy in state], [len(fixture.original), len(fixture.original)])
            self.assertFalse(any(copy['label'] == 'state-snapshot' for copy in copies))

    def test_supervisor_snapshot_and_restore_are_reserved_on_their_actual_target_volumes(self):
        with tempfile.TemporaryDirectory(prefix='nora-space-service-volume-') as temporary:
            fixture = MigrationInstallFixture(temporary, managed=False)
            service_root = fixture.base / 'service-volume'
            service_root.mkdir()
            text = 'private supervisor environment and socket configuration'
            snapshot = {'descriptor':{'file':str(service_root/'supervisor.conf'),
                                      'socket':str(service_root/'private.sock'), 'name':'tavern'},
                        'text':text, 'mode':0o600}
            backup = fixture.root/'tavern-backups/next'
            work = fixture.root/'tavern-updates/prepared'
            def volume(path):
                return 'service' if Path(path).is_relative_to(service_root) else 'install'
            tasks = fixture.updater.update_space_tasks(fixture.home, fixture.root, backup, work,
                managed=False, runtime_changed=True, migration=False, service_snapshot=snapshot)
            report = fixture.updater.check_update_space(tasks,
                disk_usage=lambda _path: UpdateSpaceInstallContractTests.usage(200_000), volume_identity=volume)
            service = next(item for item in report['volumes'] if any(copy['label']=='service-restore' for copy in item['copies']))
            self.assertEqual(service['copyBytes'], len(text.encode()))
            self.assertEqual([copy['label'] for copy in service['copies']], ['service-restore'])
            copies = [copy for item in report['volumes'] for copy in item['copies']]
            serialized = next(copy for copy in copies if copy['label']=='service-backup')
            self.assertEqual(serialized['bytes'], len((json.dumps(snapshot,ensure_ascii=False,indent=2)+'\n').encode()))
            self.assertNotIn(text, json.dumps(report))
            self.assertNotIn('private.sock', json.dumps(report))
            tasks = fixture.updater.update_space_tasks(fixture.home, fixture.root, backup, work,
                managed=False, runtime_changed=False, migration=False, restore_only=True, service_snapshot=snapshot)
            self.assertFalse(any(task['label']=='service-backup' for task in tasks))
            self.assertEqual(sum(task['label']=='service-restore' for task in tasks), 1)

    def test_discovered_service_empty_or_invalid_snapshot_is_not_treated_as_no_service(self):
        with tempfile.TemporaryDirectory(prefix='nora-space-service-unknown-') as temporary:
            fixture = MigrationInstallFixture(temporary,managed=False)
            for snapshot in ({}, [], [1], '', True, False, 0, {'text':'missing descriptor'},
                             {'descriptor':{}, 'text':'missing file'},
                             {'descriptor':{'file':str(fixture.base/'supervisor.conf')},'text':None}):
                with self.subTest(snapshot=snapshot):
                    with self.assertRaises(RuntimeError) as failure:
                        fixture.updater.update_space_tasks(fixture.home,fixture.root,
                            fixture.root/'tavern-backups/next',fixture.root/'tavern-updates/prepared',
                            managed=False,runtime_changed=True,migration=False,service_snapshot=snapshot)
                    self.assertEqual(failure.exception.code,'SPACE_UNCONFIRMED')
            self.assertFalse((fixture.root/'tavern-backups').exists())

    def test_saved_cron_runtime_variant_is_used_for_post_stop_restore_budget(self):
        with tempfile.TemporaryDirectory(prefix='nora-space-cron-variant-') as temporary:
            fixture = MigrationInstallFixture(temporary, managed=True)
            cron = fixture.home/'cron/jobs.json'
            cron.parent.mkdir()
            value = {'jobs':[{'id':'daily', 'script':'check.py', 'enabled':True,
                'schedule':{'kind':'cron','expr':'0 9 * * *'}, 'state':'scheduled',
                'last_run_at':None, 'last_error':''}], 'updated_at':'before'}
            cron.write_text(json.dumps(value))
            backup = fixture.root/'tavern-backups/next'
            work = fixture.root/'tavern-updates/prepared'
            tasks = fixture.updater.update_space_tasks(fixture.home, fixture.root, backup, work,
                managed=True, runtime_changed=True, migration=False)
            self.assertEqual(sum(task['label']=='cron-offline-snapshot' for task in tasks), 1)
            backup.mkdir(parents=True)
            fixture.updater.record_backup(fixture.root, backup, 'prepared')
            fixture.updater.copy_host_backup(fixture.home, fixture.root, backup, None)
            fixture.updater.snapshot_agents(fixture.home, backup/'agents-rollback')
            first_install.snapshot_targets(fixture.home,
                [fixture.home/name for name in fixture.updater.MANAGED_BACKUP_FILES]
                + [fixture.home/'scripts'/name for name in fixture.updater.UPDATE_CHECK_FILES], backup/'managed')
            recovery = fixture.updater.recovery_module()
            journal = recovery.Journal.create(fixture.home,fixture.root,backup,[],version='2.4.2',
                before=fixture.before,state=fixture.state)
            value['updated_at'] = 'stopped'
            value['jobs'][0].update(last_run_at='2026-10-12T01:00:00Z',last_error='x'*1_000_000)
            cron.write_text(json.dumps(value))
            journal.seal_offline({'offline':True})
            tasks = fixture.updater.update_space_tasks(fixture.home,fixture.root,backup,work,
                managed=True,runtime_changed=False,migration=False,restore_only=True,journal=journal)
            self.assertEqual(sum(task['source']==backup/'runtime-state/cron-jobs.json' for task in tasks), 1)
            self.assertFalse(any(task['label']=='cron-offline-snapshot' for task in tasks))
            with self.assertRaises(OSError) as failure:
                fixture.updater.check_update_space(tasks,
                    disk_usage=lambda _path: UpdateSpaceInstallContractTests.usage(200_000))
            self.assertEqual(failure.exception.errno, errno.ENOSPC)
            self.assertGreater(failure.exception.space_report['volumes'][0]['copyBytes'],1_000_000)
            self.assertEqual((backup/'runtime-state/cron-jobs.json').read_text(),cron.read_text())


if __name__ == '__main__':
    unittest.main()
