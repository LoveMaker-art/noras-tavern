"""Runtime process identity checks and legacy stop behavior."""
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

    def test_legacy_stop_uses_name_matched_pkill(self):
        with patch.object(processes.subprocess, 'run') as run, \
             patch.object(processes.time, 'sleep') as sleep, \
             patch.object(processes, 'port_open', return_value=True):
            result = processes.stop_process(self.record, self.script, port=8799, timeout=0)
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            ['pkill', '-f', 'server.py --port 8799'],
            ['pkill', '-f', 'server.py .*--port 8799'],
            ['pkill', '-f', 'server.py 8799'],
        ])
        sleep.assert_called_once_with(1)
        self.assertEqual(result['mode'], 'legacy-pkill')
        self.assertIsNone(result['originalAlive'])
        self.assertEqual(result['listenerPids'], [])
        self.assertTrue(result['portOpenAfterStop'])

    def test_legacy_stop_does_not_recheck_listener_ownership(self):
        with patch.object(processes.subprocess, 'run'), \
             patch.object(processes.time, 'sleep'), \
             patch.object(processes, 'port_open', return_value=False), \
             patch.object(processes, 'listener_pids') as listener_pids, \
             patch.object(processes, 'process_record') as process_record:
            result = processes.stop_process(self.record, self.script, port=8799, timeout=0)
        listener_pids.assert_not_called()
        process_record.assert_not_called()
        self.assertFalse(result['portOpenAfterStop'])

    def test_manager_stop_uses_only_the_reviewed_manager(self):
        with patch.object(processes.subprocess, 'run') as run, \
             patch.object(processes.time, 'sleep') as sleep, \
             patch.object(processes, 'port_open', return_value=False):
            calls = []
            result = processes.stop_process(self.record, self.script, stop=lambda: calls.append('stop'), timeout=0)
        self.assertEqual(calls, ['stop'])
        run.assert_not_called()
        sleep.assert_called_once_with(1)
        self.assertEqual(result['mode'], 'manager-stop')

    def test_historical_receipt_still_matches_new_observation(self):
        self.assertTrue(processes.same_process({**self.record, 'uid': os.getuid(), 'pgid': 12345}, self.record))


if __name__ == '__main__':
    unittest.main()
