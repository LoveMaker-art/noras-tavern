"""Linux observation and stop failure classification at the shared interface."""
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_full_update
import runtime_process as processes


class RuntimeProcessTests(unittest.TestCase):
    def setUp(self):
        self.script = Path('/reviewed/server.py')
        self.record = {'pid': 12345, 'identity': '901', 'argv': ['python3', str(self.script)], 'cwd': '/different'}
        self.readlink = os.readlink

    def cwd_link(self, path, *args, **kwargs):
        return '/different' if str(path) == '/proc/12345/cwd' else self.readlink(path, *args, **kwargs)

    def stat(self, state='S', start='901'):
        fields = [state, '1', '12345', '12345'] + ['0'] * 15 + [start] + ['0'] * 5
        return '12345 (name (with spaces)) ' + ' '.join(fields)

    def test_linux_absolute_entry_unrelated_cwd_preserves_identity(self):
        with patch.object(Path, 'exists', return_value=True), \
             patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=os.getuid())), \
             patch.object(Path, 'read_text', side_effect=[self.stat(), self.stat()]), \
             patch.object(Path, 'read_bytes', return_value=b'/usr/bin/python3\0/reviewed/server.py\0--port\08799\0'), \
             patch.object(os, 'readlink', side_effect=self.cwd_link):
            record = processes.process_record(12345, self.script)
        self.assertEqual(record['identity'], '901')
        self.assertEqual(record['cwd'], '/different')
        self.assertEqual(record['uid'], os.getuid())
        self.assertEqual(record['pgid'], 12345)

    def test_linux_exit_during_observation_is_not_pid_reuse(self):
        with patch.object(Path, 'exists', return_value=True), \
             patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=os.getuid())), \
             patch.object(Path, 'read_text', side_effect=[self.stat(), self.stat('Z')]), \
             patch.object(Path, 'read_bytes', return_value=b''), \
             patch.object(os, 'readlink', side_effect=self.cwd_link):
            self.assertIsNone(processes.process_record(12345, self.script))

    def test_linux_identity_change_during_observation_is_refused(self):
        with patch.object(Path, 'exists', return_value=True), \
             patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=os.getuid())), \
             patch.object(Path, 'read_text', side_effect=[self.stat(), self.stat(start='902')]), \
             patch.object(Path, 'read_bytes', return_value=b'python3\0/reviewed/server.py\0'), \
             patch.object(os, 'readlink', side_effect=self.cwd_link):
            with self.assertRaises(processes.ProcessError) as caught:
                processes.process_record(12345, self.script)
        self.assertEqual(caught.exception.code, 'process-changed')

    def test_reused_pid_is_never_signalled(self):
        with patch.object(processes, 'process_record', return_value={**self.record, 'identity': 'new'}), \
             patch.object(os, 'kill') as kill:
            with self.assertRaises(processes.ProcessError) as caught:
                processes.stop_process(self.record, self.script, timeout=0)
        self.assertEqual(caught.exception.code, 'process-changed')
        kill.assert_not_called()

    def test_alive_timeout_differs_from_replacement_listener(self):
        for current, owners, expected in ((self.record, [12345], 'stop-timeout'),
                                           (None, [54321], 'listener-remains')):
            with self.subTest(expected=expected), \
                 patch.object(processes, 'process_record', side_effect=[self.record, current]), \
                 patch.object(processes, 'listener_pids', return_value=owners), \
                 patch.object(os, 'kill') as kill, patch.object(os, 'killpg') as group:
                with self.assertRaises(processes.ProcessError) as caught:
                    processes.stop_process(self.record, self.script, port=54321, timeout=0)
                self.assertEqual(caught.exception.code, expected)
                self.assertEqual(caught.exception.evidence['listenerPids'], owners)
                kill.assert_called_once_with(12345, processes.signal.SIGTERM)
                group.assert_not_called()

    def test_manager_stop_uses_only_the_reviewed_manager(self):
        with patch.object(processes, 'process_record', side_effect=[self.record, None]), \
             patch.object(processes, 'listener_pids', return_value=[]), \
             patch.object(os, 'kill') as kill:
            calls = []
            result = processes.stop_process(self.record, self.script, stop=lambda: calls.append('stop'), timeout=0)
        self.assertFalse(result['originalAlive'])
        self.assertEqual(calls, ['stop'])
        kill.assert_not_called()

    def test_historical_receipt_still_matches_new_observation(self):
        self.assertTrue(processes.same_process({**self.record, 'uid': os.getuid(), 'pgid': 12345}, self.record))


if __name__ == '__main__':
    unittest.main()
