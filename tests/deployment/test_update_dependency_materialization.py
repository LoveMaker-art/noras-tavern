from contextlib import ExitStack
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

if __package__:
    from .launcher_test_environment import resolve_node
else:
    from launcher_test_environment import resolve_node


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
        self.node = self.root / 'runtime/bin/node'
        self.node.parent.mkdir(parents=True)
        self.node.touch()
        self.npm = self.root / 'runtime/lib/node_modules/npm/bin/npm-cli.js'
        self.npm.parent.mkdir(parents=True)
        self.npm.touch()
        (self.npm.parent.parent / 'package.json').write_text('{"name":"npm"}')
        node_env = mock.patch.dict(os.environ, {'TAVERN_NODE_EXECUTABLE': str(self.node)})
        node_env.start()
        self.addCleanup(node_env.stop)

    def prepare(self):
        return UPDATER.component_dependencies(self.source, self.engine, self.old,
            'package-lock.json', self.required)

    def completed_npm(self, command, **options):
        self.assertEqual(options['cwd'], self.engine)
        self.assertEqual(options['timeout'], 300)
        self.assertIn('--ignore-scripts', command)
        self.assertEqual(command[:4], [str(self.node), str(self.npm), 'ci', '--omit=dev'])
        package = self.engine / 'node_modules/fixture/package.json'
        package.parent.mkdir(parents=True)
        package.write_text('{"name":"fixture","version":"1.0.0"}')

    def test_different_historical_lock_can_prepare_without_touching_old_program(self):
        with mock.patch.object(UPDATER.sys, 'platform', 'linux'), \
                mock.patch.object(UPDATER, '_standalone_execution', self.state), \
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
                        mock.patch.object(UPDATER, 'standalone_run', side_effect=npm):
                    with self.assertRaises((RuntimeError, subprocess.TimeoutExpired)): self.prepare()
                self.assertEqual((self.old / 'keep.txt').read_text(), 'original program')
                self.assertFalse((self.root / 'tavern-updates/transaction.json').exists())

    def test_missing_bound_node_or_npm_cannot_use_an_unrelated_path_command(self):
        for missing in ('node', 'npm'):
            with self.subTest(missing=missing), mock.patch.object(UPDATER, '_standalone_execution', self.state), \
                    mock.patch.object(UPDATER.shutil, 'which', return_value='/unrelated/npm') as lookup, \
                    mock.patch.object(UPDATER, 'standalone_run') as execute:
                if missing == 'node':
                    self.node.unlink()
                else:
                    self.node.touch()
                    self.npm.unlink()
                with self.assertRaises(RuntimeError) as caught:
                    self.prepare()
                self.assertEqual(caught.exception.code, 'RESOURCE_INCOMPLETE')
                if missing == 'node':
                    lookup.assert_not_called()
                else:
                    lookup.assert_called_once_with('npm')
                execute.assert_not_called()
                self.assertEqual((self.old / 'keep.txt').read_text(), 'original program')

    def test_separate_path_npm_still_executes_with_the_bound_node(self):
        self.npm.unlink()
        cli = self.root / 'system-tools/npm/bin/npm-cli.js'
        cli.parent.mkdir(parents=True)
        cli.touch()
        (cli.parent.parent / 'package.json').write_text('{"name":"npm"}')
        with mock.patch.object(UPDATER.shutil, 'which', return_value=str(cli)):
            self.assertEqual(UPDATER.standalone_npm_command(), [str(self.node), str(cli)])

    def test_real_guard_prepares_offline_npm_and_retains_old_program_on_npm_failure(self):
        node = resolve_node(required=True)
        desktop = ROOT / 'launcher/desktop'
        if not (desktop / 'operation-lock.js').is_file():
            desktop = ROOT / 'ops/installer/desktop'
        helper = Path(__file__).with_name('launcher_owned_test_actor.cjs')
        control = UPDATER._control_path
        for fail in (False, True):
            with self.subTest(npm_failure=fail):
                root = Path(tempfile.mkdtemp(prefix='nora-real-npm-guard-')).resolve()
                closed = False
                try:
                    engine = root / 'tavern-updates/direct-fixture/source/app/engine/sillytavern'
                    engine.mkdir(parents=True)
                    archive = engine / 'fixture.tgz'
                    with tarfile.open(archive, 'w:gz') as stream:
                        content = b'{"name":"fixture","version":"1.0.0"}'
                        member = tarfile.TarInfo('package/package.json'); member.size = len(content)
                        stream.addfile(member, io.BytesIO(content))
                    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
                    package = {'name': 'owned-fixture', 'version': '1.0.0', 'dependencies': {'fixture': 'file:fixture.tgz'}}
                    (engine / 'package.json').write_text(json.dumps(package))
                    (engine / 'package-lock.json').write_text(json.dumps({'name': package['name'], 'version': '1.0.0',
                        'lockfileVersion': 3, 'requires': True, 'packages': {'': package,
                            'node_modules/fixture': {'version': '1.0.0', 'resolved': 'file:fixture.tgz', 'integrity': integrity}}}))
                    if fail:
                        archive.unlink()
                    old = root / 'apps/tavern-runtime/engine/sillytavern'; old.mkdir(parents=True)
                    (old / 'package-lock.json').write_text('{"historical":"different lock"}')
                    (old / 'keep.txt').write_text('original program')
                    script = root / 'actor.py'
                    script.write_text('''import importlib.util,json,sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(sys.argv[2]).parent))
spec=importlib.util.spec_from_file_location('real_npm_updater',sys.argv[1])
update=importlib.util.module_from_spec(spec);sys.modules[spec.name]=update;spec.loader.exec_module(update)
update._operation_control.require_operation()
root=Path(sys.argv[3]);source=root/'tavern-updates/direct-fixture/source'
engine=source/'app/engine/sillytavern';old=root/'apps/tavern-runtime/engine/sillytavern'
expected_failure=sys.argv[4]=='failure'
before={p.name:p.read_bytes() for p in old.iterdir()}
locks={p.name:p.read_bytes() for p in [engine/'package.json',engine/'package-lock.json']}
update._standalone_execution={'root':root,'home':root,'lock':None,'guarded':True}
with update.installer_lock(root),patch.object(update.subprocess,'run',side_effect=AssertionError('unmanaged npm')):
    try:
        prepared=update.component_dependencies(source,engine,old,'package-lock.json',('fixture/package.json',))
    except update.subprocess.CalledProcessError as error:
        assert expected_failure and error.returncode!=0
    else:
        assert not expected_failure and prepared=='prepared-standalone'
        assert json.loads((engine/'node_modules/fixture/package.json').read_text())['version']=='1.0.0'
assert before=={p.name:p.read_bytes() for p in old.iterdir()}
assert all((engine/name).read_bytes()==value for name,value in locks.items())
assert not (root/'tavern-updates/transaction.json').exists()
print(json.dumps({'prepared':not expected_failure,'oldProgramUnchanged':True,'lockUnchanged':True}),flush=True)
''', encoding='utf-8')
                    env = {**os.environ, 'HOME': str(root), 'HERMES_HOME': str(root),
                        'PATH': str(Path(node).parent) + os.pathsep + os.environ.get('PATH', ''),
                        'TAVERN_NODE_EXECUTABLE': node, 'NPM_CONFIG_OFFLINE': 'true',
                        'NORA_TEST_MANAGED_PYTHON_ROOT': sys.base_prefix, 'NORA_TEST_VENV_HOME': sys.prefix}
                    result = subprocess.run([node, str(helper), str(desktop / 'operation-lock.js'), str(root),
                        sys.executable, str(script), str(UPDATE_ROOT / 'update.py'), str(control), str(root),
                        'failure' if fail else 'success'], env=env, text=True, capture_output=True, timeout=25)
                    receipts = [json.loads(line.split(' ', 1)[1]) for line in result.stderr.splitlines()
                        if line.startswith('NORA_FIXTURE_CLOSURE ')]
                    closed = bool(receipts and receipts[-1]['closed'])
                    self.assertTrue(closed, result.stdout + result.stderr)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    sessions = [json.loads(p.read_text()) for p in (root / 'installer/operations/.guards').glob('*.json')]
                    jobs = [job for session in sessions for job in session['jobs']]
                    npm = [job for job in jobs if job['kind'] == 'node-maintenance']
                    self.assertEqual(len(npm), 1)
                    self.assertTrue(all(job.get('closedAt') and job['delegation']['identityStatus'] == 'reported' for job in jobs))
                    self.assertTrue(Path(npm[0]['executionIdentity']['executable']).samefile(node))
                    self.assertEqual(npm[0]['exitCode'] == 0, not fail)
                finally:
                    if closed:
                        shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main()
