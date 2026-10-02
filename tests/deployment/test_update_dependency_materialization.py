from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
UPDATE_ROOT = ROOT / "deployment/update"
if not (UPDATE_ROOT / "update.py").is_file():
    UPDATE_ROOT = ROOT / "ops/updater"
if (ROOT / "deployment/shared").is_dir():
    sys.path.insert(0, str(ROOT / "deployment/shared"))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


UPDATER = load("dependency_preparation_updater", UPDATE_ROOT / "update.py")
BUNDLE = load("dependency_preparation_bundle", UPDATE_ROOT / "bundle.py")


class UpdateDependencyMaterializationTests(unittest.TestCase):
    def source_fixture(self, source):
        app = source / "app"
        engine = app / "engine/sillytavern"
        vendor = engine / "vendor/image-size"
        vendor.mkdir(parents=True)
        vendor.joinpath("package.json").write_text(json.dumps({
            "name": "image-size", "version": "1.0.0", "main": "index.js",
        }), encoding="utf-8")
        vendor.joinpath("index.js").write_text("module.exports = 'preserved';\n", encoding="utf-8")
        engine.joinpath("package.json").write_text(json.dumps({
            "dependencies": {"image-size": "file:vendor/image-size"},
        }), encoding="utf-8")
        engine.joinpath("package-lock.json").write_text('{"lockfileVersion":3}\n', encoding="utf-8")
        for name in ("native_lifecycle.py", "native-runtime.json"):
            shutil.copy2(ROOT / "app" / name, app / name)
        return engine, vendor

    def directory_link(self, link, source):
        link.parent.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":
            subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(source)],
                           check=True, capture_output=True)
            self.assertEqual(link.lstat().st_reparse_tag, 0xA0000003)
            self.assertFalse(link.is_symlink())
        else:
            link.symlink_to(source, target_is_directory=True)

    def test_installed_local_dependency_is_materialized_before_directory_swap(self):
        with tempfile.TemporaryDirectory(prefix="nora-pre-swap-local-dependency-") as temporary:
            root = Path(temporary)
            source = root / "stage/source"
            engine, vendor = self.source_fixture(source)
            target = engine / "node_modules/image-size"

            def npm(_command, *, cwd):
                self.assertEqual(cwd, engine)
                self.directory_link(target, vendor)

            with mock.patch.object(UPDATER, "run", side_effect=npm) as npm_run:
                report = UPDATER.prepare_dependencies(source, root / "old-app", root / "old-mcp",
                                                      app_changed=True, mcp_changed=False)
            npm_run.assert_called_once()
            self.assertEqual(report, {"tavern": "installed", "mcp": "unchanged"})
            self.assertFalse(target.is_symlink())
            self.assertEqual(getattr(target.lstat(), "st_reparse_tag", 0), 0)

            active = root / "active-app"
            os.replace(source / "app", active)
            installed = active / "engine/sillytavern/node_modules/image-size"
            self.assertEqual(installed.joinpath("index.js").read_text(), "module.exports = 'preserved';\n")
            self.assertEqual((active / "engine/sillytavern/vendor/image-size/index.js").read_text(),
                             "module.exports = 'preserved';\n")

    def test_reused_local_dependency_is_materialized_before_directory_swap(self):
        with tempfile.TemporaryDirectory(prefix="nora-pre-swap-reused-dependency-") as temporary:
            root = Path(temporary)
            source = root / "stage/source"
            engine, _vendor = self.source_fixture(source)
            old_source = root / "old-source"
            old_engine, old_vendor = self.source_fixture(old_source)
            self.directory_link(old_engine / "node_modules/image-size", old_vendor)
            with mock.patch.object(UPDATER, "run", side_effect=AssertionError("npm should be reused")):
                report = UPDATER.prepare_dependencies(source, old_source / "app", root / "old-mcp",
                                                      app_changed=True, mcp_changed=False)
            self.assertEqual(report, {"tavern": "reused", "mcp": "unchanged"})
            target = engine / "node_modules/image-size"
            self.assertFalse(target.is_symlink())
            self.assertEqual(getattr(target.lstat(), "st_reparse_tag", 0), 0)
            active = root / "active-app"
            os.replace(source / "app", active)
            old_source.rename(root / "retained-old-source")
            self.assertEqual((active / "engine/sillytavern/node_modules/image-size/index.js").read_text(),
                             "module.exports = 'preserved';\n")

    def test_invalid_local_dependency_stops_before_service_stop_or_transaction(self):
        with tempfile.TemporaryDirectory(prefix="nora-dependency-preflight-failure-") as temporary, ExitStack() as stack:
            root = Path(temporary)
            hermes, install_root = root / "hermes", root / "tavern"
            hermes.joinpath("skills").mkdir(parents=True)
            installed = install_root / "apps/tavern-runtime"
            installed.mkdir(parents=True)
            installed.joinpath("preserve.txt").write_text("unchanged install", encoding="utf-8")
            manifest = {"versions": {"tavern": "2.4.1"}, "commit": "a" * 40, "artifacts": {}}

            def extract(_release, source, _manifest, **_kwargs):
                engine, _vendor = self.source_fixture(source)
                engine.joinpath("package.json").write_text(json.dumps({
                    "dependencies": {"image-size": "file:../outside"},
                }), encoding="utf-8")
                return {"changedModules": ["nora-runtime"]}

            stack.enter_context(mock.patch.dict(os.environ))
            stack.enter_context(mock.patch.dict(sys.modules, bundle=BUNDLE))
            stack.enter_context(mock.patch.object(UPDATER, "resolve_update_target", return_value=(hermes, install_root)))
            stack.enter_context(mock.patch.object(BUNDLE, "read_bundle", return_value=manifest))
            stack.enter_context(mock.patch.object(BUNDLE, "extract_bundle", side_effect=extract))
            stack.enter_context(mock.patch.object(UPDATER, "changed_roots", return_value={"app"}))
            stack.enter_context(mock.patch.object(UPDATER, "roots_with_unmanaged_files", return_value=set()))
            stack.enter_context(mock.patch.object(UPDATER, "run"))
            preparation = stack.enter_context(mock.patch.object(UPDATER, "prepare_skills"))
            stop = stack.enter_context(mock.patch.object(UPDATER, "stop_unmanaged"))
            start = stack.enter_context(mock.patch.object(UPDATER, "install_runtime"))

            with self.assertRaisesRegex(RuntimeError, "bundled local dependency is invalid"):
                UPDATER.install(SimpleNamespace(home=hermes, install_root=install_root,
                                               release_dir=root / "release", manifest_sha256=None))
            preparation.assert_not_called()
            stop.assert_not_called()
            start.assert_not_called()
            self.assertFalse((install_root / "tavern-updates/transaction.json").exists())
            self.assertEqual(installed.joinpath("preserve.txt").read_text(), "unchanged install")
            self.assertFalse((install_root / "tavern-backups").exists())

    def test_unchanged_or_bundled_dependencies_do_not_require_a_staging_runtime(self):
        with tempfile.TemporaryDirectory(prefix="nora-unmodified-dependency-preparation-") as temporary:
            source = Path(temporary)
            with mock.patch.object(UPDATER, "module_at") as native_loader:
                self.assertEqual(UPDATER.prepare_dependencies(source, source / "old-app", source / "old-mcp",
                                                             app_changed=False, mcp_changed=False),
                                 {"tavern": "unchanged", "mcp": "unchanged"})
                self.assertEqual(UPDATER.prepare_dependencies(source, source / "old-app", source / "old-mcp",
                                                             app_changed=True, mcp_changed=True, bundled=True),
                                 {"tavern": "bundled", "mcp": "bundled"})
            native_loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
