"""Cold public entry and standalone execution admission, without user data."""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StandaloneUpdateEntryTests(unittest.TestCase):
    def release_metadata(self, directory, *, candidate=False):
        directory.mkdir(parents=True, exist_ok=True)
        raw = json.dumps({'schema':'tavern-release/v2','candidate':candidate,
                          'versions':{'tavern':'2.5.2'},'commit':'b' * 40}).encode()
        digest = hashlib.sha256(raw).hexdigest()
        (directory / 'release-manifest.json').write_bytes(raw)
        (directory / 'SHA256SUMS').write_text(digest + '  release-manifest.json\n')
        return digest

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nora-standalone-entry-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.home = self.directory / 'hermes'
        self.install = self.directory / 'tavern'
        (self.home / 'skills').mkdir(parents=True)
        for name in ('apps/tavern-runtime/native-runtime.json',
                     'apps/tavern-runtime/engine/sillytavern/server.js',
                     'apps/tavern-ops/updater/update.py', 'apps/nora-mcp/dist/server.js'):
            file = self.install / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('{}')
        state = self.install / 'tavern-state/native/default-user/chats/story.jsonl'
        state.parent.mkdir(parents=True)
        state.write_text('original chat')
        installed = self.install / 'tavern-updates/installed.json'
        installed.parent.mkdir(parents=True)
        installed.write_text(json.dumps({'version': '2.4.2', 'commit': 'same-commit'}))
        self.environment = {key: value for key, value in os.environ.items()
                            if not key.startswith('NORA_OPERATION_') and key not in
                            ('PYTHONPATH', 'PYTHONHOME', 'NORA_TAVERN_HOME', 'TAVERN_DATA_ROOT')}
        self.environment['HERMES_HOME'] = str(self.home)

    def test_downloaded_single_file_can_check_current_install_without_repository_helpers(self):
        entry = self.directory / 'download/tavern-updater-bootstrap.py'
        entry.parent.mkdir()
        shutil.copyfile(ROOT / 'ops/updater/bootstrap.py', entry)
        before = {str(p): p.read_bytes() for p in self.install.rglob('*') if p.is_file()}
        result = subprocess.run([sys.executable, '-B', str(entry), '--hermes-home', str(self.home),
            '--install-root', str(self.install), '--target-commit', 'same-commit', '--apply', '--confirm'],
            env=self.environment, input='', text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'up-to-date')
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.install.rglob('*') if p.is_file()})

    def test_local_candidate_plan_honors_explicit_admission_without_applying(self):
        bootstrap = load('candidate_plan_bootstrap', ROOT / 'ops/updater/bootstrap.py')
        release = self.directory / 'candidate'
        release.mkdir()
        raw = json.dumps({'schema': 'tavern-release/v2', 'candidate': True,
                          'versions': {'tavern': '2.5.2'}}).encode()
        (release / 'release-manifest.json').write_bytes(raw)
        (release / 'SHA256SUMS').write_text(hashlib.sha256(raw).hexdigest() + '  release-manifest.json\n')
        command = ['bootstrap.py', '--hermes-home', str(self.home), '--install-root', str(self.install),
                   '--release-dir', str(release), '--allow-candidate', '--plan', '--apply', '--confirm']
        output = io.StringIO()
        with patch.dict(os.environ, self.environment, clear=True), patch.object(sys, 'argv', command), \
                patch.object(bootstrap, 'required_archives', return_value=([], 'local')) as plan, \
                patch('sys.stdout', output):
            bootstrap.main()
        plan.assert_called_once()
        self.assertEqual(json.loads(output.getvalue())['version'], '2.5.2')

    def test_old_cached_bootstrap_install_arguments_submit_the_shared_actor(self):
        updater = load('standalone_entry_updater', ROOT / 'ops/updater/update.py')
        digest = self.release_metadata(self.directory, candidate=True)
        command = ['update.py', '--hermes-home', str(self.home), '--install-root', str(self.install),
                   'install', '--release-dir', str(self.directory), '--manifest-sha256', digest,
                   '--confirm', '--allow-candidate']
        with patch.dict(os.environ, self.environment, clear=True), patch.object(sys, 'argv', command), \
                patch.object(updater, 'install') as install, \
                patch.object(updater.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as invoked:
            with self.assertRaises(SystemExit) as closed:
                updater.main()
        self.assertEqual(closed.exception.code, 0)
        install.assert_not_called()
        invoked.assert_called_once_with([sys.executable, '-u', '-B', str(ROOT / 'ops/updater/task.py'),
            '--hermes-home', str(self.home), '--install-root', str(self.install), '--apply', '--confirm',
            '--manifest-sha256', digest,
            '--runner-root', str(ROOT / 'ops'), '--runner-manifest', str(self.directory / 'release-manifest.json'),
            '--tag', 'v2.5.2', '--target-commit', 'b' * 40,
            '--release-dir', str(self.directory), '--allow-candidate'], check=False)

    def test_old_bootstrap_formal_temporary_bundle_is_not_used_after_detached_ack(self):
        updater = load('standalone_temporary_release', ROOT / 'ops/updater/update.py')
        with tempfile.TemporaryDirectory(prefix='install-', dir=self.install / 'tavern-updates') as temporary:
            release = Path(temporary)
            digest = self.release_metadata(release)
            command = ['update.py', '--hermes-home', str(self.home), '--install-root', str(self.install),
                       'install', '--release-dir', str(release), '--manifest-sha256', digest, '--confirm']
            with patch.dict(os.environ, self.environment, clear=True), patch.object(sys, 'argv', command), \
                    patch.object(updater, 'install') as install, \
                    patch.object(updater.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as invoked:
                with self.assertRaises(SystemExit): updater.main()
            forwarded = invoked.call_args.args[0]
            self.assertNotIn('--release-dir', forwarded)
            for flag, value in [('--tag','v2.5.2'),('--target-commit','b' * 40),('--manifest-sha256',digest)]:
                self.assertEqual(forwarded[forwarded.index(flag)+1], value)
            install.assert_not_called()
        self.assertFalse(release.exists(), 'the historical bootstrap removes the bundle immediately after ACK')

    def test_candidate_cannot_depend_on_old_bootstrap_self_cleaning_bundle(self):
        updater = load('standalone_temporary_candidate', ROOT / 'ops/updater/update.py')
        with tempfile.TemporaryDirectory(prefix='install-', dir=self.install / 'tavern-updates') as temporary:
            release = Path(temporary)
            digest = self.release_metadata(release, candidate=True)
            command = ['update.py', '--hermes-home', str(self.home), '--install-root', str(self.install),
                       'install', '--release-dir', str(release), '--manifest-sha256', digest, '--confirm','--allow-candidate']
            with patch.dict(os.environ, self.environment, clear=True), patch.object(sys, 'argv', command), \
                    patch.object(updater.subprocess, 'run') as submit:
                with self.assertRaisesRegex(RuntimeError, '临时目录'): updater.main()
            submit.assert_not_called()

    def test_old_cached_bootstrap_cannot_fall_back_to_direct_write_when_actor_is_missing(self):
        updater = load('standalone_missing_actor', ROOT / 'ops/updater/update.py')
        command = ['update.py', '--hermes-home', str(self.home), '--install-root', str(self.install),
                   'install', '--release-dir', str(self.directory), '--manifest-sha256', 'a' * 64, '--confirm']
        actual_is_file = Path.is_file
        def is_file(file):
            return False if file == ROOT / 'ops/updater/task.py' else actual_is_file(file)
        with patch.dict(os.environ, self.environment, clear=True), patch.object(sys, 'argv', command), \
                patch.object(updater, 'install') as install, patch.object(Path, 'is_file', is_file):
            with self.assertRaisesRegex(RuntimeError, '独立任务执行文件') as raised:
                updater.main()
        self.assertEqual(raised.exception.code, 'RESOURCE_INCOMPLETE')
        install.assert_not_called()

    def test_managed_marker_cannot_silently_downgrade_to_standalone_execution(self):
        updater = load('standalone_marker_updater', ROOT / 'ops/updater/update.py')
        (self.home / 'nora-instance.json').write_text('{}')
        command = ['update.py', '--hermes-home', str(self.home), '--install-root', str(self.install),
                   'install', '--release-dir', str(self.directory), '--manifest-sha256', 'a' * 64, '--confirm']
        with patch.dict(os.environ, self.environment, clear=True), patch.object(sys, 'argv', command), \
                patch.object(updater, 'install') as install:
            with self.assertRaises(RuntimeError):
                updater.main()
        install.assert_not_called()

    def test_damaged_desktop_binding_with_remaining_launcher_receipt_is_not_standalone(self):
        updater = load('standalone_damaged_desktop', ROOT / 'ops/updater/update.py')
        receipt = self.directory / 'installer/launcher-control.json'
        receipt.parent.mkdir(); receipt.write_text('{"damaged":true}')
        with patch.dict(os.environ, self.environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, '启动器管理'):
                updater.resolve_update_target(self.home, self.install)


if __name__ == '__main__':
    unittest.main()
