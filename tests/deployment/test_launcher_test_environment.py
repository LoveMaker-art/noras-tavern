import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

if __package__:
    from .launcher_test_environment import NodeTestFixtureError, resolve_node
else:
    from launcher_test_environment import NodeTestFixtureError, resolve_node


class LauncherNodeEnvironmentTests(unittest.TestCase):
    def test_explicit_real_node_runs_even_when_path_has_no_node(self):
        node = resolve_node()
        if not node:
            self.skipTest('requires NORA_TEST_NODE or a local Node executable')
        resolved = resolve_node(env={**os.environ, 'NORA_TEST_NODE': node, 'PATH': ''})
        self.assertEqual(Path(resolved).resolve(), Path(node).resolve())

    def test_invalid_explicit_node_never_falls_back_to_available_path_node(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = str(Path(directory) / 'missing-node')
            with self.assertRaisesRegex(NodeTestFixtureError, 'LAUNCHER_TEST_NODE_INVALID') as failed:
                resolve_node(env={**os.environ, 'NORA_TEST_NODE': missing})
            self.assertEqual(failed.exception.context['node'], missing)
            self.assertEqual(failed.exception.context['pythonExecutable'], sys.executable)
            self.assertEqual(failed.exception.context['pythonPrefix'], sys.prefix)
            self.assertEqual(failed.exception.context['pythonBasePrefix'], sys.base_prefix)

    def test_no_node_is_optional_only_when_it_was_not_explicitly_configured(self):
        environment = {**os.environ, 'PATH': ''}
        environment.pop('NORA_TEST_NODE', None)
        self.assertIsNone(resolve_node(env=environment))
        with self.assertRaises(NodeTestFixtureError):
            resolve_node(required=True, env=environment)
        with self.assertRaisesRegex(NodeTestFixtureError, 'explicitly empty'):
            resolve_node(env={**environment, 'NORA_TEST_NODE': ''})

    def test_a_bun_process_cannot_certify_a_node_fixture(self):
        # Only the inspection response is mocked; no fake executable is placed
        # on PATH or used by a product test.
        with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess(
                ['inspection'], 0, '{"executable":"/fixture/bun","node":"24.3.0","bun":"1.3.13"}', '')):
            with self.assertRaisesRegex(NodeTestFixtureError, 'compatibility shim'):
                resolve_node(env={**os.environ, 'NORA_TEST_NODE': '/fixture/node'})

    def test_a_wrapper_cannot_certify_a_different_native_executable(self):
        node = resolve_node()
        if not node:
            self.skipTest('requires NORA_TEST_NODE or a local Node executable')
        with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess(
                ['inspection'], 0, json.dumps({'executable': sys.executable, 'node': '24.19.0'}), '')):
            with self.assertRaisesRegex(NodeTestFixtureError, 'another interpreter'):
                resolve_node(env={**os.environ, 'NORA_TEST_NODE': node})


if __name__ == '__main__':
    unittest.main()
