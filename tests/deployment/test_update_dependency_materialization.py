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
                           check=True, capture_output=True, timeout=30)
            self.assertEqual(link.lstat().st_reparse_tag, 0xA0000003)
            self.assertFalse(link.is_symlink())
        else:
            link.symlink_to(source, target_is_directory=True)

    def test_bundled_local_dependency_is_materialized_before_directory_swap(self):
        with tempfile.TemporaryDirectory(prefix="nora-pre-swap-local-dependency-") as temporary:
            root = Path(temporary)
            source = root / "stage/source"
            engine, vendor = self.source_fixture(source)
            target = engine / "node_modules/image-size"

            self.directory_link(target, vendor)
            with mock.patch.object(UPDATER, "run", side_effect=AssertionError("must not install dependencies during update")) as npm_run:
                report = UPDATER.prepare_dependencies(source, root / "old-app", root / "old-mcp",
                                                      app_changed=True, mcp_changed=False)
            npm_run.assert_not_called()
            self.assertEqual(report, {"tavern": "bundled", "mcp": "unchanged"})
            self.assertFalse(target.is_symlink())
            self.assertEqual(getattr(target.lstat(), "st_reparse_tag", 0), 0)

            active = root / "active-app"
            os.replace(source / "app", active)
            installed = active / "engine/sillytavern/node_modules/image-size"
            self.assertEqual(installed.joinpath("index.js").read_text(), "module.exports = 'preserved';\n")
            self.assertEqual((active / "engine/sillytavern/vendor/image-size/index.js").read_text(),
                             "module.exports = 'preserved';\n")

    def test_full_platform_bundle_materializes_tar_directory_links_before_validation(self):
        with tempfile.TemporaryDirectory(prefix="nora-full-bundle-local-dependency-") as temporary:
            root = Path(temporary)
            source = root / "stage/source"
            engine, vendor = self.source_fixture(source)
            target = engine / "node_modules/image-size"
            target.parent.mkdir()
            # tarfile creates this link without a directory flag on Windows.
            target.symlink_to('../vendor/image-size')
            old_app = root / 'old-app'
            old_app.mkdir(); (old_app / 'preserve.txt').write_text('old installation')
            with mock.patch.object(UPDATER, 'run', side_effect=AssertionError('must not install dependencies')) as npm_run:
                report = UPDATER.prepare_dependencies(source, old_app, root / 'old-mcp',
                    app_changed=True, mcp_changed=False, bundled=True)
            npm_run.assert_not_called()
            self.assertEqual(report, {'tavern': 'bundled', 'mcp': 'unchanged'})
            self.assertFalse(target.is_symlink())
            self.assertEqual((old_app / 'preserve.txt').read_text(), 'old installation')
            self.assertEqual(vendor.joinpath('index.js').read_text(), "module.exports = 'preserved';\n")
            active = root / 'active-app'; os.replace(source / 'app', active)
            self.assertEqual((active / 'engine/sillytavern/node_modules/image-size/index.js').read_text(),
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

            with self.assertRaisesRegex(RuntimeError, "更新资源依赖不完整") as failure:
                UPDATER.install(SimpleNamespace(home=hermes, install_root=install_root,
                                               release_dir=root / "release", manifest_sha256=None))
            self.assertEqual(failure.exception.code, 'RESOURCE_INCOMPLETE')
            preparation.assert_not_called()
            stop.assert_not_called()
            start.assert_not_called()
            self.assertFalse((install_root / "tavern-updates/transaction.json").exists())
            self.assertEqual(installed.joinpath("preserve.txt").read_text(), "unchanged install")
            self.assertFalse((install_root / "tavern-backups").exists())

    def test_unchanged_dependencies_do_not_require_a_staging_runtime(self):
        with tempfile.TemporaryDirectory(prefix="nora-unmodified-dependency-preparation-") as temporary:
            source = Path(temporary)
            engine, vendor = self.source_fixture(source)
            shutil.copytree(vendor, engine / 'node_modules/image-size')
            mcp = source / 'nora-mcp'
            mcp.mkdir()
            (mcp / 'package.json').write_text(json.dumps({'dependencies': {}}))
            with mock.patch.object(UPDATER, "module_at") as native_loader:
                self.assertEqual(UPDATER.prepare_dependencies(source, source / "old-app", source / "old-mcp",
                                                             app_changed=False, mcp_changed=False),
                                 {"tavern": "unchanged", "mcp": "unchanged"})
            native_loader.assert_not_called()
            before = (engine / 'node_modules/image-size/index.js').stat()
            self.assertEqual(UPDATER.prepare_dependencies(source, source / 'old-app', source / 'old-mcp',
                app_changed=True, mcp_changed=True, bundled=True), {'tavern': 'bundled', 'mcp': 'bundled'})
            after = (engine / 'node_modules/image-size/index.js').stat()
            self.assertEqual((after.st_dev, after.st_ino, after.st_mtime_ns),
                (before.st_dev, before.st_ino, before.st_mtime_ns))


class StandaloneDependencyPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nora-independent-deps-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / 'tavern-updates/direct-test/source'
        self.engine = self.source / 'app/engine/sillytavern'
        self.engine.mkdir(parents=True)
        (self.engine / 'package.json').write_text(json.dumps({'dependencies': {'fixture': '1.0.0'}}))
        (self.engine / 'package-lock.json').write_text(json.dumps({'lockfileVersion': 3, 'packages': {}}))
        self.old = self.root / 'apps/tavern-runtime/engine/sillytavern'
        self.old.mkdir(parents=True)
        (self.old / 'package-lock.json').write_text('{"historical":"different lock"}')
        (self.old / 'keep.txt').write_text('original program')
        self.lease = tempfile.TemporaryFile()
        self.addCleanup(self.lease.close)
        self.state = {'root': self.root, 'lock': self.lease}
        self.required = ('fixture/package.json',)

    def prepare(self):
        return UPDATER.component_dependencies(self.source, self.engine, self.old,
            'package-lock.json', self.required)

    def completed_npm(self, command, **options):
        self.assertEqual(options['cwd'], self.engine)
        self.assertEqual(options['timeout'], 300)
        self.assertIn('--ignore-scripts', command)
        self.assertEqual(command[1:3], ['ci', '--omit=dev'])
        package = self.engine / 'node_modules/fixture/package.json'
        package.parent.mkdir(parents=True)
        package.write_text('{"name":"fixture","version":"1.0.0"}')

    def test_different_historical_lock_can_prepare_without_touching_old_program(self):
        with mock.patch.object(UPDATER.sys, 'platform', 'linux'), \
                mock.patch.object(UPDATER, '_standalone_execution', self.state), \
                mock.patch.object(UPDATER.shutil, 'which', return_value='/fixture/npm'), \
                mock.patch.object(UPDATER, 'standalone_run', side_effect=self.completed_npm) as npm:
            self.assertEqual(self.prepare(), 'prepared-standalone')
        npm.assert_called_once()
        self.assertEqual((self.old / 'keep.txt').read_text(), 'original program')
        self.assertFalse((self.root / 'tavern-updates/transaction.json').exists())

    def test_missing_scope_or_lock_does_not_enable_npm_for_desktop(self):
        for state in (None, {'root': self.root, 'lock': None}):
            with self.subTest(state=bool(state)), mock.patch.object(UPDATER.sys, 'platform', 'linux'), \
                    mock.patch.object(UPDATER, '_standalone_execution', state), \
                    mock.patch.object(UPDATER, 'standalone_run') as npm:
                with self.assertRaises(RuntimeError): self.prepare()
                npm.assert_not_called()

    def test_no_npm_outside_owned_staging_or_with_install_script(self):
        with mock.patch.object(UPDATER.sys, 'platform', 'linux'), \
                mock.patch.object(UPDATER, '_standalone_execution', self.state), \
                mock.patch.object(UPDATER, 'standalone_run') as npm:
            with self.assertRaisesRegex(RuntimeError, '临时程序目录'):
                UPDATER.standalone_dependencies(self.source, self.old, 'package-lock.json', self.required)
            (self.engine / 'package-lock.json').write_text(json.dumps({'lockfileVersion': 3,
                'packages': {'node_modules/fixture': {'hasInstallScript': True}}}))
            with self.assertRaisesRegex(RuntimeError, '额外安装脚本'): self.prepare()
            npm.assert_not_called()

    def test_failed_preparation_or_changed_lock_never_touches_old_program(self):
        for failure in ('network', 'changed-lock'):
            with self.subTest(failure=failure):
                def npm(*_args, **_kwargs):
                    if failure == 'network': raise subprocess.TimeoutExpired('npm', 300)
                    (self.engine / 'package-lock.json').write_text('changed')
                with mock.patch.object(UPDATER.sys, 'platform', 'linux'), \
                        mock.patch.object(UPDATER, '_standalone_execution', self.state), \
                        mock.patch.object(UPDATER.shutil, 'which', return_value='/fixture/npm'), \
                        mock.patch.object(UPDATER, 'standalone_run', side_effect=npm):
                    with self.assertRaises((RuntimeError, subprocess.TimeoutExpired)): self.prepare()
                self.assertEqual((self.old / 'keep.txt').read_text(), 'original program')
                self.assertFalse((self.root / 'tavern-updates/transaction.json').exists())


if __name__ == "__main__":
    unittest.main()
