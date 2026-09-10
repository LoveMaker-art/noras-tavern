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

    def test_start_uses_install_path_that_can_repair_dependencies(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory(prefix="nora-native-start-repair-") as temporary:
            root = Path(temporary)
            runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
            runtime.engine_root = root
            runtime.native_data_root = root / "data"
            runtime.install = mock.Mock(return_value={"ok": True})
            runtime.verify_install = mock.Mock(
                side_effect=AssertionError("start bypassed dependency repair"),
            )
            runtime.sync_assets = mock.Mock(return_value={})
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

            runtime.install.assert_called_once_with()
            self.assertTrue(result["already_running"])


if __name__ == "__main__":
    unittest.main()
