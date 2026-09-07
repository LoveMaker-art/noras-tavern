from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


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


if __name__ == "__main__":
    unittest.main()
