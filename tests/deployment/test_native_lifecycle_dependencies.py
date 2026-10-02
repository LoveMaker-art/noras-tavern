from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
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
    def _local_dependency_fixture(self, root, lifecycle=None):
        lifecycle = lifecycle or load_lifecycle()
        engine = root / "staging" / "engine"
        vendor = engine / "vendor" / "image-size"
        vendor.mkdir(parents=True)
        vendor.joinpath("package.json").write_text(
            json.dumps({"name": "image-size", "version": "1.0.0"}), encoding="utf-8",
        )
        vendor.joinpath("index.js").write_text("module.exports = {};\n", encoding="utf-8")
        engine.joinpath("package.json").write_text(json.dumps({
            "dependencies": {"image-size": "file:vendor/image-size"},
        }), encoding="utf-8")
        target = engine / "node_modules" / "image-size"
        target.parent.mkdir(parents=True)
        runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
        runtime.engine_root = engine
        return runtime, vendor, target

    def _directory_link(self, link, source):
        if os.name == "nt":
            subprocess.run(
                ["cmd.exe", "/c", "mklink", "/J", str(link), str(source)],
                check=True, capture_output=True,
            )
            self.assertEqual(link.lstat().st_reparse_tag, 0xA0000003)
            self.assertFalse(link.is_symlink())
        else:
            link.symlink_to(source, target_is_directory=True)

    def _assert_materialized(self, runtime, vendor, target):
        self.assertEqual(runtime.materialize_local_dependencies(), ["image-size"])
        self.assertTrue(target.is_dir())
        self.assertFalse(target.is_symlink())
        self.assertEqual(getattr(target.lstat(), "st_reparse_tag", 0), 0)
        self.assertEqual(target.joinpath("index.js").read_text(), "module.exports = {};\n")
        self.assertEqual(vendor.joinpath("index.js").read_text(), "module.exports = {};\n")
        self.assertTrue(vendor.joinpath("package.json").is_file())
        self.assertEqual(runtime.materialize_local_dependencies(), [])

    def test_shipped_source_matches_runtime_version_contract(self):
        lifecycle = load_lifecycle()
        app = ROOT / "app"
        contract = json.loads(
            (app / "native-runtime.json").read_text(encoding="utf-8")
        )
        with tempfile.TemporaryDirectory(prefix="nora-source-contract-") as temporary:
            runtime = lifecycle.NativeRuntime.for_test(temporary, app, contract)
            runtime.verify_source()

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

    def test_local_dependency_directory_link_is_materialized_without_removing_vendor(self):
        with tempfile.TemporaryDirectory(prefix="nora-valid-dependency-link-") as temporary:
            runtime, vendor, target = self._local_dependency_fixture(Path(temporary))
            self._directory_link(target, vendor)
            self.assertTrue(target.joinpath("package.json").is_file())
            self._assert_materialized(runtime, vendor, target)

    def test_local_dependency_link_survives_staging_move_as_a_real_directory(self):
        with tempfile.TemporaryDirectory(prefix="nora-moved-dependency-link-") as temporary:
            root = Path(temporary)
            runtime, vendor, target = self._local_dependency_fixture(root)
            self._directory_link(target, vendor)
            os.replace(root / "staging", root / "active")
            runtime.engine_root = root / "active" / "engine"
            vendor = runtime.engine_root / "vendor" / "image-size"
            target = runtime.engine_root / "node_modules" / "image-size"
            # npm junctions contain an absolute staging path. The node is still
            # present after the move even though following its target fails.
            self.assertFalse(target.exists())
            target.lstat()
            self._assert_materialized(runtime, vendor, target)

    def test_dangling_local_dependency_link_is_replaced_without_touching_source(self):
        with tempfile.TemporaryDirectory(prefix="nora-dangling-dependency-link-") as temporary:
            root = Path(temporary)
            runtime, vendor, target = self._local_dependency_fixture(root)
            obsolete = root / "obsolete"
            obsolete.mkdir()
            self._directory_link(target, obsolete)
            obsolete.rmdir()
            self.assertFalse(target.exists())
            target.lstat()
            self._assert_materialized(runtime, vendor, target)

    def test_prepared_directory_link_residue_does_not_delete_its_destination(self):
        for dangling in (False, True):
            with self.subTest(dangling=dangling), tempfile.TemporaryDirectory(
                prefix="nora-prepared-dependency-link-",
            ) as temporary:
                root = Path(temporary)
                runtime, vendor, target = self._local_dependency_fixture(root)
                destination = root / "unrelated"
                destination.mkdir()
                marker = destination / "keep.txt"
                marker.write_text("retain unrelated files", encoding="utf-8")
                prepared = target.with_name(target.name + ".nora-prepared")
                self._directory_link(prepared, destination)
                if dangling:
                    destination.rename(root / "retained")
                    marker = root / "retained" / "keep.txt"
                    self.assertFalse(prepared.exists())
                self._assert_materialized(runtime, vendor, target)
                self.assertEqual(marker.read_text(), "retain unrelated files")
                self.assertFalse(prepared.exists())
                with self.assertRaises(FileNotFoundError):
                    prepared.lstat()

    def test_regular_local_dependency_directory_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix="nora-existing-dependency-directory-") as temporary:
            runtime, vendor, target = self._local_dependency_fixture(Path(temporary))
            target.mkdir()
            target.joinpath("package.json").write_text("{}", encoding="utf-8")
            target.joinpath("local.txt").write_text("existing installed dependency", encoding="utf-8")
            self.assertEqual(runtime.materialize_local_dependencies(), [])
            self.assertEqual(target.joinpath("local.txt").read_text(), "existing installed dependency")
            self.assertEqual(vendor.joinpath("index.js").read_text(), "module.exports = {};\n")

    def test_incomplete_directory_and_regular_prepared_residue_are_replaced(self):
        for residue in ("file", "directory"):
            with self.subTest(residue=residue), tempfile.TemporaryDirectory(
                prefix="nora-incomplete-local-dependency-",
            ) as temporary:
                runtime, vendor, target = self._local_dependency_fixture(Path(temporary))
                target.mkdir()
                target.joinpath("incomplete.txt").write_text("old partial copy", encoding="utf-8")
                prepared = target.with_name(target.name + ".nora-prepared")
                if residue == "file":
                    prepared.write_text("old staging file", encoding="utf-8")
                else:
                    prepared.mkdir()
                    prepared.joinpath("partial.txt").write_text("old staging copy", encoding="utf-8")
                self._assert_materialized(runtime, vendor, target)
                self.assertFalse(target.joinpath("incomplete.txt").exists())

    def test_local_dependency_source_path_rejects_parent_or_absolute_paths(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory(prefix="nora-invalid-dependency-source-") as temporary:
            root = Path(temporary)
            runtime, vendor, target = self._local_dependency_fixture(root, lifecycle)
            for value in ("file:../outside", "file:" + str(vendor.resolve())):
                with self.subTest(value=value):
                    runtime.engine_root.joinpath("package.json").write_text(json.dumps({
                        "dependencies": {"image-size": value},
                    }), encoding="utf-8")
                    with self.assertRaisesRegex(lifecycle.NativeLifecycleError, "local dependency is invalid"):
                        runtime.materialize_local_dependencies()
                    self.assertFalse(target.exists())
                    self.assertTrue(vendor.joinpath("package.json").is_file())

    def test_local_dependency_source_link_cannot_escape_engine(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory(prefix="nora-escaping-dependency-source-") as temporary:
            root = Path(temporary)
            runtime, vendor, target = self._local_dependency_fixture(root, lifecycle)
            outside = root / "outside"
            vendor.rename(outside)
            self._directory_link(vendor, outside)
            with self.assertRaisesRegex(lifecycle.NativeLifecycleError, "escapes the engine"):
                runtime.materialize_local_dependencies()
            self.assertFalse(target.exists())
            self.assertEqual(outside.joinpath("index.js").read_text(), "module.exports = {};\n")

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
