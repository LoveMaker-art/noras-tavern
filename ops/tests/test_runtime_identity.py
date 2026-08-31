"""Public lifecycle regression tests; only owned temporary subprocesses are used."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_full_update
from update import module_at
import maintenance


class RuntimeIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tavern-identity-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.app = self.home / 'app'
        self.engine = self.app / 'engine/sillytavern'
        self.engine.mkdir(parents=True)
        self.script = self.engine / 'server.js'
        self.script.write_text('setInterval(() => {}, 1000);\n')
        self.module = module_at('identity_native', test_full_update.OPS.parent / 'app/native_lifecycle.py')
        self.runtime = self.module.NativeRuntime(self.home, self.app, self.home / 'state',
            SimpleNamespace(source_dir='engine/sillytavern', commit='a' * 40))
        self.run = self.runtime.run_dir('test')
        self.run.mkdir(parents=True)

    def child(self, argv, cwd):
        process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        def cleanup():
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=5)
        self.addCleanup(cleanup)
        time.sleep(0.1)
        self.assertIsNone(process.poll())
        return process

    def node(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node executable unavailable')
        return node

    def test_python_argument_is_not_the_executed_script(self):
        script = self.app / 'server.py'
        script.write_text('# not executed\n')
        process = self.child([sys.executable, '-c', 'import time; time.sleep(60)', str(script)], self.home)
        with self.assertRaisesRegex(ValueError, 'reviewed Tavern program'):
            maintenance.process_record(process.pid, script)

    def test_local_paths_with_spaces_keep_exact_argv(self):
        directory = self.home / 'path with spaces'
        directory.mkdir()
        script = directory / 'server.py'
        script.write_text('import time\ntime.sleep(60)\n')
        argv = [sys.executable, str(script), 'argument with spaces']
        process = self.child(argv, self.home)
        observed = maintenance.process_record(process.pid, script)['argv']
        # macOS' Python launcher may exec its framework binary; script/options
        # must remain exact, including spaces. Recovery records that real argv.
        self.assertEqual(observed[1:], argv[1:])
        self.assertTrue(Path(observed[0]).name.lower().startswith('python'))

    def test_other_node_instance_is_not_reported_as_our_runtime(self):
        other = self.home / 'other'
        other.mkdir()
        (other / 'server.js').write_text(self.script.read_text())
        process = self.child([self.node(), 'server.js'], other)
        pid_file = self.run / 'native.pid'
        pid_file.write_text(str(process.pid))
        with patch.object(self.runtime, 'health', return_value={'ok': True}):
            result = self.runtime.status('test')
        self.assertFalse(result['processes']['native'])
        self.assertEqual(pid_file.read_text(), str(process.pid), 'status must not remove evidence')
        self.assertIsNone(process.poll())

    def test_stop_rejects_other_instance_without_sending_a_signal(self):
        other = self.home / 'other'
        other.mkdir()
        (other / 'server.js').write_text(self.script.read_text())
        process = self.child([self.node(), 'server.js'], other)
        (self.run / 'native.pid').write_text(str(process.pid))
        # Intercept signals in the old implementation so the failing test cannot kill it.
        with patch.object(self.module.os, 'killpg') as killpg, \
             patch.object(self.module.os, 'kill') as kill:
            with self.assertRaisesRegex((ValueError, self.module.NativeLifecycleError), 'reviewed Tavern program'):
                self.runtime.stop_run('test')
        killpg.assert_not_called()
        self.assertFalse(any(call.args[1] != 0 for call in kill.call_args_list))

    def test_status_does_not_delete_stale_pid_file(self):
        pid_file = self.run / 'native.pid'
        pid_file.write_text('87654321')
        result = self.runtime.status('test')
        self.assertFalse(result['processes']['native'])
        self.assertTrue(pid_file.exists(), 'a read-only inspection must preserve the stale evidence')

    def test_same_script_with_different_state_root_is_not_our_run(self):
        command = self.runtime.node_command(54321, self.home / 'other-state')
        process = self.child(command, self.engine)
        (self.run / 'native.pid').write_text(str(process.pid))
        (self.run / 'run.json').write_text(json.dumps({'port': 54321,
            'data_root': str(self.runtime.native_data_root)}))
        status = self.runtime.status('test')
        self.assertFalse(status['processes']['native'])
        self.assertIn('configuration differs', status['inspection_error'])
        with self.assertRaisesRegex(self.module.NativeLifecycleError, 'configuration differs'):
            self.runtime.stop_run('test')
        self.assertIsNone(process.poll())

    def test_missing_pid_and_warming_runtime_cannot_be_treated_as_offline(self):
        process = self.child([self.node(), str(self.script)], self.home)
        status = self.runtime.status('test')
        self.assertIn('run ownership', status['inspection_error'])
        with self.assertRaisesRegex(self.module.NativeLifecycleError, 'run ownership'):
            self.runtime.stop_run('test')
        self.assertIsNone(process.poll())

    def test_warming_process_is_not_reported_offline_just_because_port_is_closed(self):
        process = self.child([self.node(), str(self.script)], self.home)
        (self.run / 'native.pid').write_text(str(process.pid))
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        (self.run / 'run.json').write_text(json.dumps({'port': port}))
        status = self.runtime.status('test')
        self.assertTrue(status['processes']['native'])
        self.assertFalse(status['health']['ok'])

    def test_exact_node_entry_can_be_stopped_without_signalling_process_group(self):
        process = self.child([self.node(), str(self.script)], self.home)
        (self.run / 'native.pid').write_text(str(process.pid))
        with patch.object(self.module.os, 'killpg', wraps=os.killpg) as groups:
            result = self.runtime.stop_run('test')
        self.assertTrue(result['ok'])
        process.wait(timeout=5)
        groups.assert_not_called()

    def test_native_start_status_repeat_start_and_stop_use_one_identity(self):
        shutil.copyfile(Path(__file__).parent / 'fixtures/native-server.js', self.script)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        try:
            with patch.object(self.runtime, 'verify_install'):
                started = self.runtime.start('test', port, assets_prepared=True)
                again = self.runtime.start('test', port, assets_prepared=True)
            status = self.runtime.status('test')
            self.assertTrue(started['health']['ok'])
            self.assertTrue(again['already_running'])
            self.assertEqual(started['native_pid'], again['native_pid'])
            self.assertTrue(status['processes']['native'])
            self.assertTrue(status['health']['ok'])
        finally:
            self.runtime.stop_run('test')
        self.assertFalse(self.runtime.process_module().port_open(port))

    def test_occupied_port_never_starts_a_second_node(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            sock.listen(1)
            with patch.object(self.runtime, 'verify_install'), patch.object(self.runtime, 'spawn') as spawn:
                with self.assertRaisesRegex(self.module.NativeLifecycleError, 'port is occupied'):
                    self.runtime.start('test', sock.getsockname()[1], assets_prepared=True)
        spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
