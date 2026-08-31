"""Maintenance refuses unknown processes and retains original running state."""
import io
import json
from pathlib import Path
import tempfile
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

import test_full_update  # Makes the reviewed updater modules importable.
import maintenance
import signal


class MaintenanceTests(unittest.TestCase):
    def test_linux_exit_between_stat_and_cmdline_is_normal_shutdown(self):
        running = '87654321 (python3) S ' + '0 ' * 30
        zombie = '87654321 (python3) Z ' + '0 ' * 30
        with patch.object(Path, 'exists', return_value=True), \
             patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=maintenance.os.getuid())), \
             patch.object(Path, 'read_text', side_effect=[running, zombie]), \
             patch.object(Path, 'read_bytes', return_value=b''):
            self.assertIsNone(maintenance.process_record(87654321, self.home / 'server.py'))

    def test_managed_stop_never_signals_child_directly(self):
        service = Mock()
        service.pid.return_value = self.record['pid']
        service.snapshot.return_value = {'descriptor': {'name': 'tavern-runtime'}, 'text': 'private', 'mode': 384}
        with patch.object(maintenance, 'managed_service', return_value=service), \
             patch.object(maintenance, 'process_record', side_effect=[self.record, self.record, None, None]), \
             patch.object(maintenance, 'python_processes', return_value=[self.record]), \
             patch.object(maintenance.urllib.request, 'urlopen', return_value=self.health(0)), \
             patch.object(maintenance, 'port_open', return_value=False), \
             patch.object(maintenance.os, 'kill') as kill:
            maintenance.pause(self.lifecycle, self.transaction)
        service.stop.assert_called_once()
        kill.assert_not_called()
        saved = json.loads((self.transaction / 'maintenance.json').read_text())
        self.assertTrue(saved['paused'])
        self.assertEqual(saved['service']['descriptor']['name'], 'tavern-runtime')

    def test_legacy_receipt_recovers_restarted_managed_source(self):
        service = Mock()
        service.pid.return_value = self.record['pid'] + 1
        replacement = {**self.record, 'pid': self.record['pid'] + 1, 'identity': 'new'}
        (self.transaction / 'maintenance.json').write_text(json.dumps({'wasRunning': True,
            'sourceRuntime': 'python', 'process': self.record}))
        with patch.object(maintenance, 'managed_service', return_value=service), \
             patch.object(maintenance, 'process_record', side_effect=[None, replacement]), \
             patch.object(maintenance, 'verify_restored') as verify, \
             patch.object(maintenance.urllib.request, 'urlopen', return_value=self.health(0)), \
             patch.object(maintenance.subprocess, 'Popen') as spawn:
            maintenance.resume(self.lifecycle, self.transaction)
        spawn.assert_not_called()
        verify.assert_called_once_with(self.lifecycle, replacement, self.home / 'app/backend/server.py')
        self.assertEqual(int((self.state / 'server.pid').read_text()), replacement['pid'])

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='tavern-maintenance-test-')
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()
        self.state = self.home / 'tavern-state'
        self.state.mkdir()
        self.transaction = self.home / 'transaction'
        self.transaction.mkdir()
        self.lifecycle = SimpleNamespace(source_runtime='python', port=54321,
            u=SimpleNamespace(home=self.home, state=self.state, targets={'app': self.home / 'app'}))
        (self.home / 'app/backend').mkdir(parents=True)
        (self.home / 'app/backend/server.py').write_text('# fixture\n')
        processes = patch.object(maintenance, 'python_processes', return_value=[])
        processes.start()
        self.addCleanup(processes.stop)
        self.record = {'pid': 87654321, 'identity': 'test', 'argv': ['python3', str(self.home / 'app/backend/server.py')], 'cwd': str(self.home)}
        # Process observation/stop has its own real subprocess tests. These
        # tests exercise durable maintenance intent and manager delegation.
        def stopped(record, script, *, port, stop=None):
            if stop:
                stop()
            else:
                maintenance.os.kill(record['pid'], signal.SIGTERM)
            return {'pid': record['pid'], 'originalAlive': False, 'listenerPids': [], 'port': port}
        stopping = patch.object(maintenance, 'stop_process', side_effect=stopped)
        stopping.start()
        self.addCleanup(stopping.stop)
        listener = patch.object(maintenance, 'require_listener')
        listener.start()
        self.addCleanup(listener.stop)

    def health(self, running):
        return io.BytesIO(json.dumps({'ok': True, 'background_jobs': {'running': running, 'queued': 0}}).encode())

    def test_flat_installation_and_stale_pid_use_verified_process_and_record_entry(self):
        (self.home / 'app/backend/server.py').unlink()
        script = self.home / 'app/server.py'
        script.write_text('# installed fixture\n')
        record = {**self.record, 'argv': ['python3', 'server.py'], 'cwd': str(self.home / 'app')}
        (self.state / 'server.pid').write_text('87654320')
        with patch.object(maintenance, 'process_record', side_effect=[None, record, None, None]) as check, \
             patch.object(maintenance, 'python_processes', return_value=[record]), \
             patch.object(maintenance, 'port_open', return_value=False), \
             patch.object(maintenance.urllib.request, 'urlopen', return_value=self.health(0)), \
             patch.object(maintenance.os, 'kill') as kill:
            maintenance.pause(self.lifecycle, self.transaction)
        self.assertTrue(all(call.args[1] == script for call in check.call_args_list))
        kill.assert_called_once_with(record['pid'], signal.SIGTERM)
        journal = json.loads((self.transaction / 'maintenance.json').read_text())
        self.assertEqual(journal['script'], str(script))
        self.assertEqual(journal['process'], record)

    def test_two_matching_python_processes_are_never_stopped(self):
        with patch.object(maintenance, 'python_processes', return_value=[self.record, {**self.record, 'pid': 87654322}]), \
             patch.object(maintenance.os, 'kill') as kill:
            with self.assertRaisesRegex(ValueError, 'Multiple or changing'):
                maintenance.pause(self.lifecycle, self.transaction)
        kill.assert_not_called()

    def test_process_exit_between_ps_and_cwd_is_normal_shutdown(self):
        running = subprocess.CompletedProcess([], 0, f'{maintenance.os.getuid()} 87654321 S Mon Aug 31 10:00:00 2026 node server.js\n')
        gone = subprocess.CompletedProcess([], 1, '')
        with patch.object(Path, 'exists', return_value=False), patch.object(maintenance.subprocess, 'run', side_effect=[running, gone, gone]):
            self.assertIsNone(maintenance.process_record(87654321, self.home / 'server.js'))

    def test_unreadable_cwd_of_still_running_process_is_not_ignored(self):
        running = subprocess.CompletedProcess([], 0, f'{maintenance.os.getuid()} 87654321 S Mon Aug 31 10:00:00 2026 node server.js\n')
        unknown = subprocess.CompletedProcess([], 1, '')
        with patch.object(Path, 'exists', return_value=False), patch.object(maintenance.subprocess, 'run', side_effect=[running, unknown, running]):
            with self.assertRaisesRegex(ValueError, 'working directory'):
                maintenance.process_record(87654321, self.home / 'server.js')

    def test_busy_python_is_not_killed(self):
        (self.state / 'server.pid').write_text(str(self.record['pid']))
        with patch.object(maintenance, 'process_record', return_value=self.record), patch.object(maintenance.urllib.request, 'urlopen', return_value=self.health(1)), patch.object(maintenance.os, 'kill') as kill:
            with self.assertRaisesRegex(ValueError, 'background work is active'):
                maintenance.pause(self.lifecycle, self.transaction)
            kill.assert_not_called()
        self.assertFalse((self.transaction / 'maintenance.json').exists())

    def test_unowned_listener_is_never_stopped(self):
        with patch.object(maintenance, 'port_open', return_value=True), patch.object(maintenance.os, 'kill') as kill:
            with self.assertRaisesRegex(ValueError, 'unowned process'):
                maintenance.pause(self.lifecycle, self.transaction)
            kill.assert_not_called()

    def test_pid_reuse_is_not_signalled(self):
        (self.state / 'server.pid').write_text(str(self.record['pid']))
        with patch.object(maintenance, 'process_record', side_effect=[self.record, {**self.record, 'identity': 'new'}]), patch.object(maintenance.urllib.request, 'urlopen', return_value=self.health(0)), patch.object(maintenance.os, 'kill') as kill:
            with self.assertRaisesRegex(ValueError, 'process changed'):
                maintenance.pause(self.lifecycle, self.transaction)
            kill.assert_not_called()

    def test_offline_source_is_not_started_during_recovery(self):
        with patch.object(maintenance, 'port_open', return_value=False):
            maintenance.pause(self.lifecycle, self.transaction)
        with patch.object(maintenance.subprocess, 'Popen') as start:
            maintenance.resume(self.lifecycle, self.transaction)
            start.assert_not_called()
        self.assertFalse(json.loads((self.transaction / 'maintenance.json').read_text())['wasRunning'])

    def test_stop_intent_is_durable_before_signal_and_record_is_private(self):
        (self.state / 'server.pid').write_text(str(self.record['pid']))
        def signal_checked(pid, sig):
            record = json.loads((self.transaction / 'maintenance.json').read_text())
            self.assertTrue(record['wasRunning'])
            self.assertFalse(record['paused'])
            self.assertEqual(pid, self.record['pid'])
        with patch.object(maintenance, 'process_record', side_effect=[self.record, self.record, None, None]), patch.object(maintenance, 'port_open', return_value=False), patch.object(maintenance.urllib.request, 'urlopen', return_value=self.health(0)), patch.object(maintenance.os, 'kill', side_effect=signal_checked):
            maintenance.pause(self.lifecycle, self.transaction)
        file = self.transaction / 'maintenance.json'
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertTrue(json.loads(file.read_text())['paused'])


if __name__ == '__main__':
    unittest.main()
