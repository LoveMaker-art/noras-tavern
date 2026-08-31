"""One installation lock, exercised across updater, runtime and subprocesses."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_full_update
from update import Updater, module_at
from runtime_lock import installation_lock, FD_ENV

RUNNER = test_full_update.OPS / 'updater/runtime_lock.py'


class RuntimeLockTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='tavern-lock-test-')
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()

    def run_command(self, *, env=None, pass_fds=()):
        return subprocess.run([sys.executable, str(RUNNER), '--home', str(self.home), '--',
                               sys.executable, '-c', 'print("operation ran")'],
                              env=env, pass_fds=pass_fds, capture_output=True, text=True)

    def test_updater_blocks_independent_launcher_before_execution(self):
        with Updater(self.home).lock():
            result = self.run_command()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('operation ran', result.stdout)
        self.assertIn('maintenance is already running', result.stderr)

    def test_child_with_real_inherited_descriptor_can_run(self):
        with installation_lock(self.home) as fd:
            result = self.run_command(env={**os.environ, FD_ENV: str(fd)}, pass_fds=(fd,))
            # Child release must not release the parent's ownership.
            blocked = self.run_command()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'operation ran')
        self.assertNotEqual(blocked.returncode, 0)

    def test_environment_boolean_cannot_bypass_lock(self):
        result = self.run_command(env={**os.environ, FD_ENV: '1'})
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('operation ran', result.stdout)

    def test_descriptor_for_another_installation_is_refused(self):
        with installation_lock(self.home / 'other') as fd:
            result = self.run_command(env={**os.environ, FD_ENV: str(fd)}, pass_fds=(fd,))
        self.assertNotEqual(result.returncode, 0)

    def test_lock_is_released_after_exception(self):
        with self.assertRaises(RuntimeError):
            with installation_lock(self.home):
                raise RuntimeError('failure')
        self.assertEqual(self.run_command().returncode, 0)

    def test_node_lifecycle_reuses_updater_lock_in_same_process(self):
        module = module_at('locked_native', test_full_update.OPS.parent / 'app/native_lifecycle.py')
        runtime = module.NativeRuntime(self.home, self.home / 'app', self.home / 'state',
            SimpleNamespace(source_dir='engine/sillytavern', commit='a' * 40))
        with Updater(self.home).lock(), patch.object(runtime, '_start', return_value={'ok': True}) as start:
            self.assertTrue(runtime.start(assets_prepared=True)['ok'])
        start.assert_called_once()

    def test_actual_startup_hook_stops_at_maintenance_lock(self):
        installed = self.home / 'apps/tavern-ops/updater/runtime_lock.py'
        installed.parent.mkdir(parents=True)
        shutil.copyfile(RUNNER, installed)
        hook = test_full_update.OPS / 'hooks/tavern-liveware-register/run.sh'
        with Updater(self.home).lock():
            result = subprocess.run(['sh', str(hook)], capture_output=True, text=True,
                env={**os.environ, 'HERMES_HOME': str(self.home), 'TAVERN_PYTHON': sys.executable,
                     'TAVERN_DATA_ROOT': str(self.home)})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('maintenance is already running', result.stderr)
        self.assertFalse((self.home / 'tavern-state').exists())

    def test_cli_restart_stays_inside_one_maintenance_window(self):
        module = module_at('restart_native', test_full_update.OPS.parent / 'app/native_lifecycle.py')
        runtime = module.NativeRuntime(self.home, self.home / 'app', self.home / 'state',
            SimpleNamespace(source_dir='engine/sillytavern', commit='a' * 40))
        phases = []
        def operation(name):
            phases.append(name)
            self.assertNotEqual(self.run_command().returncode, 0)
            return {'ok': True}
        with patch.object(module.NativeRuntime, 'from_environment', return_value=runtime), \
             patch.object(runtime, 'stop_run', side_effect=lambda *a: operation('stop')), \
             patch.object(runtime, 'start', side_effect=lambda *a: operation('start')):
            module.main(['restart', '--run-id', 'test', '--port', '54321'])
        self.assertEqual(phases, ['stop', 'start'])


if __name__ == '__main__':
    unittest.main()
