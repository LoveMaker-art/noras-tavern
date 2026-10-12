"""Capacity admission measures future copies without touching user data."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load_updater():
    path = Path(__file__).resolve().parents[2] / 'ops/updater/update.py'
    spec = importlib.util.spec_from_file_location('capacity_updater', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class UpdateSpaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nora-update-space-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.updater = load_updater()

    def file(self, relative, size):
        path = self.base / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'x' * size)
        return path

    def copy(self, source, destination, **options):
        return {'source': source, 'destination': self.base / destination,
                'label': 'state-snapshot', 'links': 'reject', **options}

    @staticmethod
    def capacity(free):
        return lambda _path: SimpleNamespace(total=10_000_000, used=10_000_000-free, free=free)

    def check(self, copies, **options):
        return self.updater.check_update_space(copies, **options)

    def test_shortage_is_enospc_before_creating_backup_or_modifying_source(self):
        story = self.file('state/private-story.jsonl', 100_000)
        before = story.read_bytes()
        with self.assertRaises(OSError) as caught:
            self.check([self.copy(story.parent, 'backups/next/state')], disk_usage=self.capacity(1))
        self.assertEqual(caught.exception.errno, errno.ENOSPC)
        self.assertEqual(caught.exception.code, 'ENOSPC')
        self.assertEqual(story.read_bytes(), before)
        self.assertFalse((self.base / 'backups').exists())
        report = caught.exception.space_report
        self.assertEqual(report['volumes'][0]['copyBytes'], 100_000)
        self.assertNotIn('private-story', json.dumps(report))
        self.assertNotIn(str(self.base), json.dumps(report))

    def test_sufficient_space_reports_only_future_copy_not_existing_candidates(self):
        state = self.file('state/story', 100_000).parent
        self.file('candidate/node_modules/already-materialized', 1_000_000)
        self.file('backups/old/protected-user-data', 900_000)
        report = self.check([self.copy(state, 'backups/next/state')], disk_usage=self.capacity(200_000))
        self.assertEqual(report['status'], 'sufficient')
        self.assertEqual(report['volumes'][0]['copyBytes'], 100_000)
        self.assertGreater(report['volumes'][0]['reserveBytes'], 0)
        self.assertEqual((self.base / 'backups/old/protected-user-data').stat().st_size, 900_000)
        self.assertFalse((self.base / 'backups/next').exists())

    def test_same_volume_copies_are_aggregated(self):
        one = self.file('one', 100_000)
        two = self.file('two', 100_000)
        with self.assertRaises(OSError) as caught:
            self.check([self.copy(one, 'backup/one'), self.copy(two, 'backup/two', label='config-restore')],
                       disk_usage=self.capacity(250_000), volume_identity=lambda _path: 'same-volume')
        self.assertEqual(len(caught.exception.space_report['volumes']), 1)
        self.assertEqual(caught.exception.space_report['volumes'][0]['copyBytes'], 200_000)

    def test_different_target_volumes_have_independent_budgets(self):
        one = self.file('one', 100_000)
        two = self.file('two', 100_000)
        (self.base / 'volume-one').mkdir()
        (self.base / 'volume-two').mkdir()
        report = self.check([self.copy(one, 'volume-one/backup'), self.copy(two, 'volume-two/backup')],
                            disk_usage=self.capacity(200_000), volume_identity=lambda path: Path(path).name)
        self.assertEqual(len(report['volumes']), 2)
        self.assertEqual([volume['copyBytes'] for volume in report['volumes']], [100_000, 100_000])

    def test_second_admission_remeasures_new_data_after_stop(self):
        state = self.file('state/story', 100_000).parent
        copies = [self.copy(state, 'backups/next/state')]
        self.check(copies, disk_usage=self.capacity(200_000))
        self.file('state/late-message', 100_000)
        with self.assertRaises(OSError) as caught:
            self.check(copies, disk_usage=self.capacity(200_000))
        self.assertEqual(caught.exception.errno, errno.ENOSPC)
        self.assertEqual(caught.exception.space_report['volumes'][0]['copyBytes'], 200_000)
        self.assertTrue((state / 'late-message').is_file())

    def test_capacity_unknown_preserves_original_query_error(self):
        state = self.file('state/story', 100).parent
        cause = PermissionError(errno.EACCES, 'capacity denied')
        with self.assertRaises(RuntimeError) as caught:
            self.check([self.copy(state, 'backup/state')], disk_usage=lambda _path: (_ for _ in ()).throw(cause))
        self.assertEqual(caught.exception.code, 'SPACE_UNCONFIRMED')
        self.assertIs(caught.exception.__cause__, cause)
        self.assertFalse((self.base / 'backup').exists())

    def test_invalid_capacity_values_do_not_grant_admission(self):
        source = self.file('state/story', 100)
        for free in (-1, True, float('nan'), '500000'):
            with self.subTest(free=free):
                with self.assertRaises(RuntimeError) as caught:
                    self.check([self.copy(source, 'backup/story')],
                               disk_usage=lambda _path: SimpleNamespace(total=1000, used=1, free=free))
                self.assertEqual(caught.exception.code, 'SPACE_UNCONFIRMED')

    def test_userdata_links_and_linked_destination_ancestors_are_rejected(self):
        external = self.file('external/private-secret', 1_000_000)
        state = self.file('state/story', 100).parent
        (state / 'redirect').symlink_to(external)
        with self.assertRaises(RuntimeError) as caught:
            self.check([self.copy(state, 'backup/state')], disk_usage=self.capacity(2_000_000))
        self.assertEqual(caught.exception.code, 'SPACE_PATH_UNSAFE')
        (state / 'redirect').unlink()
        (self.base / 'linked-backups').symlink_to(external.parent, target_is_directory=True)
        with self.assertRaises(RuntimeError) as caught:
            self.check([self.copy(state, 'linked-backups/state')], disk_usage=self.capacity(2_000_000))
        self.assertEqual(caught.exception.code, 'SPACE_PATH_UNSAFE')
        self.assertEqual(external.stat().st_size, 1_000_000)

    def test_program_leaf_symlinks_are_preserved_without_reading_their_targets(self):
        source = self.file('program/node_modules/package/bin.js', 100).parents[2]
        binary = source / 'node_modules/.bin/tool'
        binary.parent.mkdir()
        binary.symlink_to('../package/bin.js')
        outside = self.file('external/private-content', 1_000_000)
        (source / 'unread-link').symlink_to(outside)
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('capacity must not read contents')):
            report = self.check([self.copy(source, 'backup/program', links='preserve')],
                                disk_usage=self.capacity(200_000))
        self.assertEqual(report['volumes'][0]['copyBytes'],
                         100 + len(os.fsencode(os.readlink(binary)))
                         + len(os.fsencode(os.readlink(source / 'unread-link'))))

    def test_top_level_program_symlink_is_rejected_even_in_preserve_mode(self):
        source = self.file('program/entry', 100).parent
        linked = self.base / 'redirected-program'
        linked.symlink_to(source, target_is_directory=True)
        with self.assertRaises(RuntimeError) as caught:
            self.check([self.copy(linked, 'backup/program', links='preserve')], disk_usage=self.capacity(200_000))
        self.assertEqual(caught.exception.code, 'SPACE_PATH_UNSAFE')

    @unittest.skipUnless(hasattr(os, 'mkfifo') and os.name != 'nt', 'FIFO is POSIX only')
    def test_special_files_are_not_treated_as_zero_byte_safe_copies(self):
        state = self.file('state/story', 100).parent
        os.mkfifo(state / 'socket-like-source')
        with self.assertRaises(RuntimeError) as caught:
            self.check([self.copy(state, 'backup/state')], disk_usage=self.capacity(200_000))
        self.assertEqual(caught.exception.code, 'SPACE_PATH_UNSAFE')

    def test_optional_missing_files_are_zero_but_required_missing_source_is_rejected(self):
        missing = self.base / 'missing-config'
        report = self.check([self.copy(missing, 'backup/config', optional=True)], disk_usage=self.capacity(200_000))
        self.assertEqual(report['volumes'][0]['copyBytes'], 0)
        with self.assertRaises(RuntimeError) as caught:
            self.check([self.copy(missing, 'backup/config')], disk_usage=self.capacity(200_000))
        self.assertEqual(caught.exception.code, 'SPACE_UNCONFIRMED')

    def test_preflight_does_not_swallow_a_later_actual_copy_enospc(self):
        source = self.file('install/tavern-state/story', 100).parent
        self.file('install/tavern-state/another-story', 100)
        self.check([self.copy(source, 'work/prepared-fallback/state')], disk_usage=self.capacity(200_000))
        failure = OSError(errno.ENOSPC, 'another writer filled the disk')
        original_copy = shutil.copyfile
        copied = []
        def copy_then_fill(*args, **kwargs):
            if copied:
                raise failure
            copied.append(args[0])
            return original_copy(*args, **kwargs)
        with patch.object(shutil, 'copyfile', side_effect=copy_then_fill), self.assertRaises(OSError) as caught:
            self.updater.fallback_python_state(self.base / 'install', self.base / 'work', 'legacy unsupported')
        # shutil aggregates copy errors; the OS failure remains explicit.
        self.assertIn('[Errno 28]', str(caught.exception))
        self.assertIn('another writer filled the disk', str(caught.exception))
        self.assertEqual((source / 'story').stat().st_size, 100)
        self.assertEqual((source / 'another-story').stat().st_size, 100)
        self.assertEqual(len(list((self.base / 'work/prepared-fallback/state').iterdir())), 1)

    def test_known_memory_bytes_are_counted_on_destination_volume(self):
        (self.base / 'service-volume').mkdir()
        report = self.check([{'bytes': 100_000, 'destination': self.base / 'service-volume/.restore',
                              'label': 'service-restore'}], disk_usage=self.capacity(200_000))
        self.assertEqual(report['volumes'][0]['copyBytes'], 100_000)
        self.assertEqual(report['volumes'][0]['entries'], 1)
        with self.assertRaises(OSError) as failure:
            self.check([{'bytes': 100_000, 'destination': self.base / 'service-volume/.restore',
                         'label': 'service-restore'}], disk_usage=self.capacity(1))
        self.assertEqual(failure.exception.errno, errno.ENOSPC)
        self.assertFalse((self.base / 'service-volume/.restore').exists())

    def test_known_memory_bytes_reject_invalid_values_and_ambiguous_sources(self):
        for size in (-1, True, None, 1.5, float('nan'), '100000'):
            with self.subTest(size=size):
                with self.assertRaises(RuntimeError) as failure:
                    self.check([{'bytes': size, 'destination': self.base / 'backup/.restore',
                                 'label': 'service-restore'}], disk_usage=self.capacity(200_000))
                self.assertEqual(failure.exception.code, 'SPACE_PATH_UNSAFE')
        source = self.file('source', 100)
        with self.assertRaises(RuntimeError) as failure:
            self.check([{'bytes':100, 'source':source, 'destination':self.base/'backup/.restore',
                         'label':'service-restore'}], disk_usage=self.capacity(200_000))
        self.assertEqual(failure.exception.code, 'SPACE_PATH_UNSAFE')

    def test_optional_source_permission_failure_never_becomes_a_zero_byte_copy(self):
        source = self.file('state/story', 100)
        original_lstat = Path.lstat
        original_error = PermissionError(errno.EACCES, 'source metadata denied')
        io_source = Path(self.updater.filesystem_path(source))
        def lstat(path, *args, **kwargs):
            if path == io_source:
                raise original_error
            return original_lstat(path, *args, **kwargs)
        with patch.object(Path, 'lstat', new=lstat), self.assertRaises(RuntimeError) as failure:
            self.check([self.copy(source, 'backup/story', optional=True)], disk_usage=self.capacity(200_000))
        self.assertEqual(failure.exception.code, 'SPACE_UNCONFIRMED')
        self.assertIs(failure.exception.__cause__, original_error)
        self.assertFalse((self.base / 'backup').exists())

    def test_optional_directory_disappearing_during_scan_is_unknown_not_zero_bytes(self):
        source = self.file('optional-managed/story', 100).parent
        original_measure = self.updater._space_measure
        def remove_after_initial_stat(path, links):
            shutil.rmtree(path)
            return original_measure(path, links)
        with patch.object(self.updater, '_space_measure', side_effect=remove_after_initial_stat), \
                self.assertRaises(RuntimeError) as failure:
            self.check([self.copy(source, 'backup/managed', optional=True)], disk_usage=self.capacity(200_000))
        self.assertEqual(failure.exception.code, 'SPACE_UNCONFIRMED')
        self.assertIsInstance(failure.exception.__cause__, FileNotFoundError)
        self.assertFalse((self.base / 'backup').exists())

    def test_windows_junction_metadata_is_rejected_on_all_test_hosts(self):
        source = self.file('state/story', 100).parent
        redirect = self.base / 'redirect'
        redirect.mkdir()
        original_lstat = Path.lstat
        io_redirect = Path(self.updater.filesystem_path(redirect))
        def lstat(path, *args, **kwargs):
            if path == io_redirect:
                return SimpleNamespace(st_mode=stat.S_IFDIR,
                                       st_file_attributes=getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))
            return original_lstat(path, *args, **kwargs)
        with patch.object(Path, 'lstat', new=lstat), self.assertRaises(RuntimeError) as failure:
            self.check([self.copy(source, 'redirect/backup')], disk_usage=self.capacity(200_000))
        self.assertEqual(failure.exception.code, 'SPACE_PATH_UNSAFE')

    @unittest.skipUnless(os.name == 'nt', 'Actual NTFS junction creation is Windows only')
    def test_actual_windows_junction_never_redirects_capacity_or_backup(self):
        source = self.file('state/story', 100).parent
        outside = self.file('external/private-data', 100).parent
        link = self.base / 'junction'
        subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)],
                       capture_output=True, check=True)
        with self.assertRaises(RuntimeError) as failure:
            self.check([self.copy(source, 'junction/backup')], disk_usage=self.capacity(200_000))
        self.assertEqual(failure.exception.code, 'SPACE_PATH_UNSAFE')
        self.assertFalse((outside / 'backup').exists())
        self.assertEqual((outside / 'private-data').stat().st_size, 100)


if __name__ == '__main__':
    unittest.main()
