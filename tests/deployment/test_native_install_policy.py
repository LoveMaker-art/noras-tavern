from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import Mock, patch

from .test_native_lifecycle_dependencies import load_lifecycle


class NativeInstallPolicyTests(unittest.TestCase):
    def fixture(self, root):
        lifecycle = load_lifecycle()
        runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
        runtime.engine_root = root
        runtime.contract = Mock(node_min_major=20)
        runtime.verify_source = Mock(return_value={})
        runtime.node_major = Mock(return_value=26)
        runtime.dependencies_ready = Mock(return_value=False)
        runtime.materialize_local_dependencies = Mock(return_value=[])
        runtime.verify_install = Mock(return_value={})
        runtime.sync_assets = Mock()
        runtime.assert_operation = Mock()
        runtime.dependencies_marker = root / 'dependencies.json'
        runtime.lock_digest = Mock(return_value='fixture digest')
        return lifecycle, runtime

    def test_formal_install_missing_prebuilt_dependencies_fails_without_npm_or_source_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            lifecycle, runtime = self.fixture(Path(temporary))
            with patch.object(lifecycle.subprocess, 'run') as run:
                with self.assertRaises(lifecycle.NativeLifecycleError) as caught: runtime.install()
            self.assertEqual(caught.exception.code, 'RESOURCE_INCOMPLETE')
            self.assertIn('完整', str(caught.exception))
            run.assert_not_called(); runtime.materialize_local_dependencies.assert_not_called()
            self.assertFalse(runtime.dependencies_marker.exists())

    def test_explicit_source_build_can_prepare_dependencies_without_maintenance_delegation(self):
        with tempfile.TemporaryDirectory() as temporary:
            lifecycle, runtime = self.fixture(Path(temporary))
            with patch.object(lifecycle.subprocess, 'run') as run:
                report = runtime.install(allow_dependency_install=True)
            self.assertTrue(report['installed'])
            self.assertEqual(run.call_args.args[0][:2], ['npm', 'ci'])
            self.assertTrue(runtime.dependencies_marker.exists())

    def test_source_build_cannot_spawn_untracked_npm_inside_maintenance_operation(self):
        with tempfile.TemporaryDirectory() as temporary:
            lifecycle, runtime = self.fixture(Path(temporary))
            with patch.dict(os.environ, {'NORA_OPERATION_DELEGATE_ENDPOINT': '127.0.0.1:1'}), patch.object(lifecycle.subprocess, 'run') as run:
                with self.assertRaises(lifecycle.NativeLifecycleError) as caught: runtime.install(allow_dependency_install=True)
            self.assertEqual(caught.exception.code, 'RESOURCE_INCOMPLETE'); run.assert_not_called()


if __name__ == '__main__': unittest.main()
