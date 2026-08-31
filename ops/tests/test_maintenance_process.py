"""Actual subprocess coverage; no original server or model requests are run."""
import json
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.request

import test_full_update
import maintenance


class MaintenanceProcessTests(unittest.TestCase):
    def test_flat_relative_entry_stale_pid_stop_and_restore(self):
        self.exercise(False)

    def test_absolute_entry_unrelated_cwd_stale_pid_stop_and_restore(self):
        self.exercise(True)

    def exercise(self, absolute):
        with tempfile.TemporaryDirectory(prefix='python-process-test-') as temporary:
            home = Path(temporary).resolve()
            app = home / 'app'
            state = home / 'tavern-state'
            transaction = home / 'transaction'
            for directory in (app, state, transaction):
                directory.mkdir()
            shutil.copyfile(Path(__file__).parent / 'fixtures/maintenance-server.py', app / 'server.py')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            lifecycle = SimpleNamespace(source_runtime='python', port=port,
                u=SimpleNamespace(home=home, state=state, targets={'app': app}))
            command = ([sys.executable, str(app / 'server.py'), '--port', str(port)] if absolute
                       else [sys.executable, '-B', 'server.py', str(port)])
            child = subprocess.Popen(command, cwd=home if absolute else app,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            restarted = []
            original_popen = subprocess.Popen
            def remember_restart(*args, **kwargs):
                process = original_popen(*args, **kwargs)
                restarted.append(process)
                return process
            def wait_up():
                deadline = time.monotonic() + 8
                while not maintenance.port_open(port) and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(maintenance.port_open(port))
            try:
                wait_up()
                (state / 'server.pid').write_text('87654321')
                self.assertEqual([r['pid'] for r in maintenance.python_processes(app)], [child.pid])
                maintenance.pause(lifecycle, transaction)
                child.wait(timeout=5)
                self.assertFalse(maintenance.port_open(port))
                journal = json.loads((transaction / 'maintenance.json').read_text())
                self.assertEqual(journal['script'], str(app / 'server.py'))
                with patch.object(maintenance.subprocess, 'Popen', side_effect=remember_restart):
                    maintenance.resume(lifecycle, transaction)
                wait_up()
                resumed = int((state / 'server.pid').read_text())
                self.assertNotEqual(resumed, child.pid)
                self.assertEqual(maintenance.process_record(resumed, app / 'server.py')['argv'], journal['process']['argv'])
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=3) as response:
                    self.assertTrue(json.load(response)['ok'])
            finally:
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=5)
                # Stop only subprocesses verified against this temporary entry.
                for record in maintenance.python_processes(app):
                    import os
                    os.kill(record['pid'], signal.SIGTERM)
                for process in restarted:
                    process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
