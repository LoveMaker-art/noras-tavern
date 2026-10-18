"""Independent task submissions bind the Python that is actually invoking them."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('independent_updater_task_entry', ROOT / 'ops/updater/task.py')
TASK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TASK)


class UpdaterTaskEntryTests(unittest.TestCase):
    def test_submission_binds_actual_venv_and_base_python_paths_for_native_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            home, install = root / 'home', root / 'tavern'
            entry = root / 'ops/installer/desktop/updater-task.js'
            entry.parent.mkdir(parents=True)
            entry.write_text('// submission fixture; no updater process is executed\n')
            command = ['task.py', '--apply', '--confirm', '--hermes-home', str(home),
                       '--install-root', str(install), '--port', '18799', '--runner-root', str(root / 'ops')]
            with patch.object(sys, 'argv', command), \
                    patch.object(TASK, 'installation', return_value=(home, install, home)), \
                    patch.object(TASK, 'node_for', return_value=os.environ.get('NORA_TEST_NODE', '/verified/node')), \
                    patch.object(TASK.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as submit:
                with self.assertRaises(SystemExit) as result:
                    TASK.main()
            self.assertEqual(result.exception.code, 0)
            payload = json.loads(submit.call_args.kwargs['input'])
            self.assertEqual(payload['python'], sys.executable)
            self.assertEqual(payload['venvHome'], sys.prefix)
            self.assertEqual(payload['managedPythonRoot'], sys.base_prefix)
            self.assertTrue(Path(payload['venvHome']).is_dir())
            self.assertTrue(Path(payload['managedPythonRoot']).is_dir())
            self.assertNotEqual(payload['venvHome'], str(home / 'hermes-agent/venv'))
            self.assertNotEqual(payload['managedPythonRoot'], str(home / 'python'))

    def test_fixed_target_hash_and_canonical_request_are_separate_from_runner_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            home, install = root / 'home', root / 'tavern'
            entry = root / 'ops/installer/desktop/updater-task.js'
            entry.parent.mkdir(parents=True)
            entry.write_text('// transport fixture\n')
            canonical = '11111111-1111-4111-8111-111111111111'
            command = ['task.py', '--apply', '--confirm', '--hermes-home', str(home),
                       '--install-root', str(install), '--port', '18799', '--runner-root', str(root / 'ops'),
                       '--target-manifest-sha256', 'a' * 64, '--operation-request-id', canonical]
            with patch.object(sys, 'argv', command), \
                    patch.object(TASK, 'installation', return_value=(home, install, home)), \
                    patch.object(TASK, 'node_for', return_value='/verified/node'), \
                    patch.object(TASK.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as submit:
                with self.assertRaises(SystemExit):
                    TASK.main()
            payload = json.loads(submit.call_args.kwargs['input'])
            self.assertEqual(payload['targetManifestSha256'], 'a' * 64)
            self.assertEqual(payload['operationRequestId'], canonical)
            self.assertNotIn('manifestSha256', payload)


if __name__ == '__main__':
    unittest.main()
