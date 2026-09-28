import importlib.util
import json
import os
import subprocess
import shutil
import sys
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent.parent / 'installer/desktop/replace-launcher.py'
SPEC = importlib.util.spec_from_file_location('replace_launcher', SOURCE)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class ReplacementTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('NORA_TEST_LAUNCHER_ARCHIVE'), 'Optional real archive acceptance')
    def test_real_archive_matches_build_inputs_without_runtime_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.assertIn(sys.platform, ('darwin', 'win32'))
            worker.extract(Path(os.environ['NORA_TEST_LAUNCHER_ARCHIVE']), root, sys.platform)
            application = root
            if sys.platform == 'darwin':
                apps = list(root.glob('*.app'))
                self.assertEqual(len(apps), 1)
                application = apps[0]
                subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(application)], check=True)
            subprocess.run([shutil.which('node'), str(Path(__file__).with_name('verify_launcher_update.cjs')),
                            str(application), os.environ['NORA_TEST_LAUNCHER_DESKTOP'], sys.platform], check=True)

    def test_rejects_zip_escape(self):
        for name in ('../outside', '/outside', 'C:/outside', 'safe/../../outside', 'safe\\outside'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / 'bad.zip'
                with zipfile.ZipFile(archive, 'w') as bundle:
                    info = zipfile.ZipInfo()
                    info.filename = name
                    bundle.writestr(info, 'bad')
                with self.assertRaises(ValueError):
                    worker.extract(archive, root / 'stage', 'win32')

    def scenario(self, fail=False, corrupt_state=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        home = root / 'data'
        app = root / 'application'
        app.mkdir()
        (app / 'launcher.exe').write_text('old')
        (app / 'Uninstall Nora.exe').write_text('uninstaller')
        job = home / 'installer/launcher-update/job-test'
        job.mkdir(parents=True)
        if corrupt_state:
            (home / 'installer/state.json').write_text('{broken')
        (home / 'world.json').write_text('user-world')
        archive = root / 'update.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('launcher.exe', 'new')
            bundle.writestr('resources/launcher-update-info.json', json.dumps({'version': '1.1.0', 'platform': 'win32', 'arch': 'x64'}))
        plan = {'schema': 1, 'token': str(uuid.uuid4()), 'home': str(home), 'appRoot': str(app),
                'executable': 'launcher.exe', 'platform': 'win32', 'arch': 'x64', 'version': '1.1.0',
                'archive': str(archive), 'sha256': worker.digest(archive), 'parentPid': 100}
        (job / 'plan.json').write_text(json.dumps(plan))
        calls = []

        class Child:
            def poll(self):
                return 1 if fail else None

        def launch(args, **kwargs):
            calls.append(args)
            self.assertEqual(kwargs['env']['NORA_TAVERN_HOME'], str(home))
            if not fail:
                worker.write_json(job / 'ready.json', {'token': plan['token'], 'version': plan['version']})
            return Child()

        with patch.object(worker, 'parent_alive', return_value=False), patch.object(worker.subprocess, 'Popen', side_effect=launch):
            if fail:
                with self.assertRaisesRegex(RuntimeError, '提前退出'):
                    worker.run(job)
            else:
                worker.run(job)
        self.assertEqual((home / 'world.json').read_text(), 'user-world')
        self.assertEqual((app / 'Uninstall Nora.exe').read_text(), 'uninstaller')
        self.assertEqual((app / 'launcher.exe').read_text(), 'old' if fail else 'new')
        self.assertEqual(json.loads((job / 'status.json').read_text())['status'], 'error' if fail else 'success')
        self.assertEqual(len(calls), 2 if fail else 1)

    def test_replaces_only_application_preserving_data_and_windows_uninstaller(self):
        self.scenario()

    def test_failed_launch_restores_original_application(self):
        self.scenario(fail=True)

    def test_corrupted_status_file_does_not_prevent_restoring_and_relaunching_old_app(self):
        self.scenario(fail=True, corrupt_state=True)


if __name__ == '__main__':
    unittest.main()
