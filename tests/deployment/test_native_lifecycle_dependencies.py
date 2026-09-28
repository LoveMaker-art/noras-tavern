from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
LIFECYCLE = ROOT / "app/native_lifecycle.py"


def load_lifecycle():
    spec = importlib.util.spec_from_file_location("tavern_native_lifecycle_dependency_test", LIFECYCLE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class NativeLifecycleDependencyTests(unittest.TestCase):
    def test_ready_marker_does_not_hide_a_missing_direct_dependency(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory(prefix="nora-native-dependencies-") as temporary:
            root = Path(temporary)
            engine = root / "engine"
            engine.mkdir()
            package = {
                "dependencies": {
                    "express": "1.0.0",
                    "image-size": "file:vendor/image-size",
                    "showdown": "file:vendor/showdown",
                    "webpack": "1.0.0",
                },
            }
            engine.joinpath("package.json").write_text(json.dumps(package), encoding="utf-8")
            lock = engine / "package-lock.json"
            lock.write_text('{"lockfileVersion":3}\n', encoding="utf-8")
            for relative in ("express/package.json", "webpack/package.json"):
                path = engine / "node_modules" / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("{}\n", encoding="utf-8")

            runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
            runtime.engine_root = engine
            runtime.dependencies_marker = root / "dependencies.json"
            runtime.dependencies_marker.write_text(json.dumps({
                "schema": 1,
                "lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
                "node_major": 26,
            }), encoding="utf-8")

            self.assertFalse(runtime.dependencies_ready(node_major=26))

            for relative in ("image-size/package.json", "showdown/package.json"):
                path = engine / "node_modules" / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("{}\n", encoding="utf-8")

            self.assertTrue(runtime.dependencies_ready(node_major=26))

    def test_local_file_dependencies_are_materialized_as_directories(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory(prefix="nora-native-local-dependencies-") as temporary:
            root = Path(temporary)
            engine = root / "engine"
            vendor = engine / "vendor/image-size"
            vendor.mkdir(parents=True)
            vendor.joinpath("package.json").write_text(
                json.dumps({"name": "image-size", "version": "1.0.0"}),
                encoding="utf-8",
            )
            vendor.joinpath("index.js").write_text("module.exports = {};\n", encoding="utf-8")
            engine.joinpath("package.json").write_text(json.dumps({
                "dependencies": {"image-size": "file:vendor/image-size"},
            }), encoding="utf-8")
            target = engine / "node_modules/image-size"
            target.parent.mkdir(parents=True)
            target.symlink_to(Path("../vendor/image-size"), target_is_directory=True)

            runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
            runtime.engine_root = engine

            repaired = runtime.materialize_local_dependencies()

            self.assertEqual(repaired, ["image-size"])
            self.assertTrue(target.is_dir())
            self.assertFalse(target.is_symlink())
            self.assertEqual(target.joinpath("index.js").read_text(), "module.exports = {};\n")

            target.rename(engine / "node_modules/image-size.lost")
            self.assertEqual(runtime.materialize_local_dependencies(), ["image-size"])
            self.assertTrue(target.joinpath("package.json").is_file())

    def test_start_does_not_install_validate_or_overwrite_user_files(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory(prefix="nora-native-start-repair-") as temporary:
            root = Path(temporary)
            runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
            runtime.engine_root = root
            runtime.native_data_root = root / "data"
            runtime.install = mock.Mock(side_effect=AssertionError('start attempted installation'))
            runtime.dependencies_ready = mock.Mock(side_effect=AssertionError('start hashed dependency files'))
            runtime.verify_install = mock.Mock(
                side_effect=AssertionError("start repeated installation acceptance"),
            )
            runtime.sync_assets = mock.Mock(side_effect=AssertionError('start overwrote extensions'))
            (root / 'server.js').write_text('// user implementation')
            runtime.config_path = root / 'config.yaml'
            runtime.config_path.write_text('user settings')
            runtime.run_dir = mock.Mock(return_value=root / "run")
            runtime.managed_service = mock.Mock(return_value=None)
            runtime._read_pid = mock.Mock(return_value=123)
            runtime.node_command = mock.Mock(return_value=["node", "server.js"])
            runtime.health = mock.Mock(return_value={"ok": True, "checks": {}})
            processes = mock.Mock()
            processes.process_record.return_value = {
                "argv": ["node", "server.js"],
                "cwd": str(root),
            }
            runtime.process_module = mock.Mock(return_value=processes)

            result = runtime._start("production", 8799, None, assets_prepared=False)

            runtime.install.assert_not_called()
            runtime.verify_install.assert_not_called()
            runtime.sync_assets.assert_not_called()
            self.assertTrue(result["already_running"])

    def test_start_reuses_node_symlink_but_rejects_different_arguments(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory(prefix='nora-start-identity-') as temporary:
            root = Path(temporary)
            executable = root / 'node-real'
            executable.write_text('fixture')
            alias = root / 'node-link'
            alias.symlink_to(executable)
            runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
            runtime.engine_root = root
            runtime.native_data_root = root / 'data'
            (root / 'server.js').write_text('// fixture server')
            runtime.config_path = root / 'config.yaml'
            runtime.config_path.write_text('fixture config')
            for name, value in [('dependencies_ready', True), ('verify_install', None), ('sync_assets', None),
                                ('run_dir', root / 'run'), ('managed_service', None), ('_read_pid', 123),
                                ('health', {'ok': True, 'checks': {}})]:
                setattr(runtime, name, mock.Mock(return_value=value))
            expected = [str(alias), 'server.js', '--port', '8799', '--dataRoot', str(root / 'data')]
            runtime.node_command = mock.Mock(return_value=expected)
            processes = mock.Mock()
            actual = [str(executable), *expected[1:]]
            processes.process_record.return_value = {'argv': actual, 'cwd': str(root)}
            runtime.process_module = mock.Mock(return_value=processes)
            self.assertTrue(runtime._start('production', 8799, None, assets_prepared=False)['already_running'])
            for index, value in [(0, str(root / 'other-node')), (1, 'other.js'), (3, '8800'), (5, str(root / 'other-data'))]:
                changed = actual.copy(); changed[index] = value
                processes.process_record.return_value = {'argv': changed, 'cwd': str(root)}
                with self.subTest(index=index), self.assertRaisesRegex(lifecycle.NativeLifecycleError, 'configuration differs'):
                    runtime._start('production', 8799, None, assets_prepared=False)
            processes.process_record.return_value = {'argv': actual, 'cwd': str(root / 'other-cwd')}
            with self.assertRaisesRegex(lifecycle.NativeLifecycleError, 'configuration differs'):
                runtime._start('production', 8799, None, assets_prepared=False)

    def test_missing_start_files_report_failure_without_reinstalling(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
            runtime.engine_root = root
            runtime.config_path = root / 'config.yaml'
            runtime.install = mock.Mock(side_effect=AssertionError('unrequested install'))
            runtime.sync_assets = mock.Mock(side_effect=AssertionError('unrequested sync'))
            with self.assertRaisesRegex(lifecycle.NativeLifecycleError, 'startup entry is missing'):
                runtime._start('production', 8799, None, assets_prepared=False)
            (root / 'server.js').write_text('// custom server')
            with self.assertRaisesRegex(lifecycle.NativeLifecycleError, 'configuration is missing'):
                runtime._start('production', 8799, None, assets_prepared=False)
            runtime.install.assert_not_called()
            runtime.sync_assets.assert_not_called()


if __name__ == "__main__":
    unittest.main()
