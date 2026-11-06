"""Run a copied, standalone bootstrap through archive verification and the existing guard."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class FirstBootstrapEntry(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.entry = self.directory / 'entry/bootstrap.py'
        self.entry.parent.mkdir()
        self.entry.write_bytes((ROOT / 'ops/installer/bootstrap.py').read_bytes())
        self.home = self.directory / 'home'
        self.release = self.directory / 'release'
        self.release.mkdir()
        self.files = {name: b'fixture file\n' for name in [
            'ops/installer/templates/SOUL.md', 'ops/installer/templates/greeting.md',
            'ops/updater/managed_context.py', 'ops/installer/nora_system.py',
            'ops/scripts/nora-instance.py', 'ops/scripts/nora-tavern-update-check.py',
            'ops/hooks/tavern-liveware-register/handler.py', 'ops/updater/bundle.py',
            'ops/scripts/install-hermes-skills.py']}
        self.files['ops/installer/first_install.py'] = b"raise AssertionError('The real installer must never execute in this entry test')\n"
        for name in ['operation_cli.py', 'operation_control.py', 'operation_evidence.py']:
            self.files['ops/installer/'+name] = (ROOT / 'ops/installer'/name).read_bytes()
        self.seal()

    def seal(self, *, bad_member=False):
        archive = self.release / 'nora-tavern-ops.tar.gz'
        with tarfile.open(archive, 'w:gz') as stream:
            for name, body in self.files.items():
                data = body + b'changed' if bad_member and name.endswith('operation_cli.py') else body
                member = tarfile.TarInfo(name)
                member.size = len(data)
                member.mode = 0o644
                stream.addfile(member, io.BytesIO(data))
        for name in ['nora-tavern-app.tar.gz', 'nora-tavern-nora-mcp.tar.gz']:
            (self.release/name).write_bytes(b'other sealed archives are not installed')
        self.manifest = {'schema': 'tavern-release/v2', 'candidate': False,
            'archives': {'ops': {'name': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}},
            'artifacts': {name: hashlib.sha256(body).hexdigest() for name, body in self.files.items()}}
        (self.release/'release-manifest.json').write_text(json.dumps(self.manifest))
        (self.release/'SHA256SUMS').write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest()+'  '+file.name+'\n'
            for file in sorted(self.release.iterdir()) if file.name != 'SHA256SUMS'))

    def command(self):
        return [sys.executable, '-B', str(self.entry), '--release-dir', str(self.release),
            '--nora-home', str(self.home), '--apply', '--confirm']

    def execute(self):
        environment = {key: value for key, value in os.environ.items()
            if not key.startswith('NORA_OPERATION_') and key not in {'PYTHONPATH', 'PYTHONHOME'}}
        return subprocess.run(self.command(), cwd=self.entry.parent, env=environment,
            input='', capture_output=True, text=True, timeout=10)

    def assert_managed_installer_command(self, command, verified_installer):
        self.assertEqual(command[:3], [sys.executable, '-u', '-B'])
        self.assertIsInstance(command[3], str)
        installer = type(verified_installer)(command[3])
        self.assertTrue(installer.is_absolute())
        self.assertEqual(installer, verified_installer)
        self.assertEqual(installer.parts[-3:], ('ops', 'installer', 'first_install.py'))

    def test_managed_installer_path_contract_accepts_native_separators_and_keeps_exact_target(self):
        for path_type, root in [(PurePosixPath, '/verified/runner'),
                                (PureWindowsPath, 'C:/verified/runner')]:
            expected = path_type(root) / 'ops/installer/first_install.py'
            command = [sys.executable, '-u', '-B', str(expected)]
            with self.subTest(path_type=path_type.__name__):
                self.assert_managed_installer_command(command, expected)
            for invalid in [path_type('ops/installer/first_install.py'),
                            path_type(root) / 'other/installer/first_install.py',
                            path_type(root) / 'ops/installer/other.py',
                            path_type(root).parent / 'other/ops/installer/first_install.py']:
                with self.subTest(path_type=path_type.__name__, invalid=str(invalid)), \
                        self.assertRaises(AssertionError):
                    self.assert_managed_installer_command(command[:3] + [str(invalid)], expected)
            for wrong_extraction in [path_type(root) / 'other/installer/first_install.py',
                                     path_type(root) / 'ops/installer/other.py']:
                with self.subTest(path_type=path_type.__name__, wrong_extraction=str(wrong_extraction)), \
                        self.assertRaises(AssertionError):
                    self.assert_managed_installer_command(command[:3] + [str(wrong_extraction)], wrong_extraction)
            with self.subTest(path_type=path_type.__name__, invalid='missing isolation flag'), \
                    self.assertRaises(AssertionError):
                self.assert_managed_installer_command([sys.executable, '-u', '-c', str(expected)], expected)

    def test_desktop_install_requires_existing_guard_before_any_install_write(self):
        command = self.command
        self.command = lambda: command() + ['--dedicated-nora']
        result = self.execute()
        self.assertEqual(result.returncode, 1)
        self.assertIn('无法核验已安装的新版启动器', result.stderr)
        self.assertNotIn('No such file', result.stderr)
        self.assertNotIn('real installer must never execute', result.stderr)
        self.assertFalse(self.home.exists())

    def test_headless_entry_executes_only_verified_installer_without_desktop_receipt(self):
        self.files['ops/installer/first_install.py'] = b'import json; print(json.dumps({"verifiedHeadlessInstaller": True}))\n'
        self.seal()
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['verifiedHeadlessInstaller'])
        self.assertFalse(self.home.exists(), 'dispatcher test must not create a user installation')

    def test_unverified_operation_module_is_rejected_before_importing_guard(self):
        self.seal(bad_member=True)
        result = self.execute()
        self.assertEqual(result.returncode, 1)
        self.assertIn('ops 文件校验失败', result.stderr)
        self.assertFalse(self.home.exists())

    def test_verified_entry_uses_existing_live_delegate_for_installer_execution(self):
        spec = importlib.util.spec_from_file_location('isolated_first_entry', self.entry)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        events = []
        verified_installers = []
        class Process:
            returncode = 0
            def communicate(self, **kwargs):
                return None, None
        class Delegate:
            def assert_active(self):
                events.append('guard')
            def popen(self, args, **kwargs):
                events.append(('managed installer', args))
                return Process()
        original_extract = module.extract_ops_runner
        def extract(*args, **kwargs):
            installer = original_extract(*args, **kwargs)
            verified_installers.append(installer)
            events.append('verified extraction')
            return installer
        with patch.object(sys, 'argv', self.command()[2:]), patch.dict(sys.modules, {'operation_cli': None}), \
                patch.object(sys, '_nora_operation_delegate', Delegate(), create=True), \
                patch.object(module, 'extract_ops_runner', side_effect=extract):
            with self.assertRaises(SystemExit) as result:
                module.main()
        self.assertEqual(result.exception.code, 0)
        self.assertEqual(events[:3], ['verified extraction', 'guard', 'guard'])
        command = events[3][1]
        self.assertEqual(len(verified_installers), 1)
        self.assert_managed_installer_command(command, verified_installers[0])
        self.assertIn('--manifest-sha256', command)
        self.assertFalse(self.home.exists())

    def test_packaged_retry_runs_current_writer_with_the_unchanged_fixed_release(self):
        self.packaged_retry()

    def test_packaged_retry_rejects_changed_current_writer(self):
        self.packaged_retry(tamper='writer')

    def test_packaged_retry_rejects_a_resealed_different_release(self):
        self.packaged_retry(tamper='release')

    def test_packaged_retry_requires_the_existing_native_delegate(self):
        command = self.command
        self.command = lambda: command() + [
            '--dedicated-nora', '--use-packaged-install-runner', '--manifest-sha256',
            hashlib.sha256((self.release / 'release-manifest.json').read_bytes()).hexdigest(),
        ]
        result = self.execute()
        self.assertEqual(result.returncode, 1)
        self.assertIn('首装重试必须由当前启动器和原固定发布计划授权', result.stderr)
        self.assertFalse(self.home.exists())

    def packaged_retry(self, *, tamper=None):
        from ops.installer import operation_cli

        if sys.platform not in ('darwin', 'win32'):
            self.skipTest('Requires a supported desktop capability receipt platform')
        executable = self.directory / ('Contents/MacOS/Nora' if sys.platform == 'darwin' else 'Nora.exe')
        resources = self.directory / ('Contents/Resources' if sys.platform == 'darwin' else 'resources')
        resources.mkdir(parents=True)
        writer_bytes = b'# first-install writer from the current desktop APP\n'
        (resources / 'bootstrap.py').write_bytes(self.entry.read_bytes())
        self.entry = resources / 'bootstrap.py'
        (resources / 'first_install.py').write_bytes(writer_bytes)
        (resources / 'operation_cli.py').write_bytes(Path(operation_cli.__file__).read_bytes())
        (resources / 'operation_control.py').write_bytes(self.files['ops/installer/operation_control.py'])

        def descriptor(file):
            if not file.exists():
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'APP capability fixture')
            data = file.read_bytes()
            return {'path': str(file), 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

        resource_descriptors = {name: descriptor(resources / name) for name in operation_cli.RESOURCE_NAMES}
        asar = descriptor(resources / 'app.asar')
        native = descriptor(resources / f'app.asar.unpacked/node_modules/fs-native-extensions/prebuilds/{sys.platform}-x64/fs-native-extensions.node')
        source = [asar['sha256'], native['sha256'], [[name, item['sha256']] for name, item in resource_descriptors.items()]]
        installer_dir = self.home / 'installer'
        installer_dir.mkdir(parents=True)
        (installer_dir / 'launcher-control.json').write_text(json.dumps({
            'schema': 'nora-launcher-control/1', 'capabilityVersion': 1, 'executorProtocol': 'nora-operation-executor/1',
            'operationSchema': 'nora-operation/1', 'telemetrySchema': 3, 'faultSchema': 2,
            'platform': sys.platform, 'arch': 'x64', 'channel': 'beta', 'port': 18998,
            'noraHome': str(self.home), 'installerDirectory': str(installer_dir),
            'hermesHome': str(self.home / 'hermes'), 'installRoot': str(self.home / 'tavern'),
            'resourcesRoot': str(resources), 'entry': str(resources / 'app.asar/operation-cli.js'),
            'executable': descriptor(executable), 'asar': asar, 'native': native, 'resources': resource_descriptors,
            'sourceHash': hashlib.sha256(json.dumps(source, separators=(',', ':')).encode()).hexdigest(),
        }), encoding='utf-8')
        release_before = {file.name: file.read_bytes() for file in self.release.iterdir()}
        old_digest = hashlib.sha256(release_before['release-manifest.json']).hexdigest()
        if tamper == 'writer':
            (resources / 'first_install.py').write_bytes(b'# untrusted replacement\n')
        if tamper == 'release':
            self.files['ops/installer/templates/SOUL.md'] += b'different publication'
            self.seal()
        spec = importlib.util.spec_from_file_location('packaged_retry_bootstrap', self.entry)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        commands = []

        class Process:
            returncode = 0

            def communicate(self, **kwargs):
                return None, None

        class Delegate:
            def assert_active(self):
                pass

            def popen(delegate, args, **kwargs):
                commands.append(args)
                writer = Path(args[3])
                self.assertEqual(writer.read_bytes(), writer_bytes)
                self.assertEqual(writer.parent.parts[-2:], ('ops', 'installer'))
                self.assertNotEqual(writer.name, 'first_install.py')
                self.assertEqual(writer.with_name('first_install.py').read_bytes(),
                                 self.files['ops/installer/first_install.py'])
                return Process()

        args = self.command()[2:] + ['--dedicated-nora', '--use-packaged-install-runner', '--manifest-sha256', old_digest]
        with patch.object(sys, 'argv', args), patch.object(sys, '_nora_operation_delegate', Delegate(), create=True):
            if tamper:
                with self.assertRaisesRegex(RuntimeError, '无法核验已安装的新版启动器' if tamper == 'writer' else '固定发布清单'):
                    module.main()
                self.assertEqual(commands, [])
                return
            with self.assertRaises(SystemExit) as result:
                module.main()
        self.assertEqual(result.exception.code, 0)
        command, = commands
        self.assertEqual(command[command.index('--manifest-sha256') + 1], old_digest)
        self.assertEqual(Path(command[command.index('--release-dir') + 1]), self.release.resolve())
        self.assertEqual({file.name: file.read_bytes() for file in self.release.iterdir()}, release_before)


if __name__ == '__main__':
    unittest.main()
