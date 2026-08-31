"""The shell entry must select the requested Bootstrap before executing it."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

INSTALLER = Path(__file__).resolve().parents[1] / 'updater/install.sh'


class InstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='tavern-installer-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        script = b'import json, sys; print(json.dumps(sys.argv[1:]))\n'
        (self.root / 'tavern-updater-bootstrap.py').write_bytes(script)
        (self.root / 'bootstrap-manifest.json').write_text(json.dumps({
            'scope': 'tavern-updater-bootstrap', 'sha256': hashlib.sha256(script).hexdigest()}))
        binaries = self.root / 'bin'
        binaries.mkdir()
        curl = binaries / 'curl'
        curl.write_text('#!' + sys.executable + '\n' + '''import json, os, pathlib, sys
root = pathlib.Path(os.environ['TAVERN_INSTALLER_FIXTURE'])
args = sys.argv[1:]
url = next(arg for arg in args if arg.startswith('https://'))
with (root / 'requests.jsonl').open('a') as log:
    log.write(json.dumps(url) + '\\n')
target = pathlib.Path(args[args.index('-o') + 1])
target.write_bytes((root / url.rsplit('/', 1)[-1]).read_bytes())
''')
        curl.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(binaries) + os.pathsep + os.environ['PATH'],
                    'TAVERN_INSTALLER_FIXTURE': str(self.root), 'TMPDIR': str(self.root),
                    'TAVERN_PYTHON': sys.executable}

    def test_explicit_python_is_used_even_when_path_python_has_no_yaml(self):
        python = self.root / 'bin/python3'
        python.write_text('#!/bin/sh\nexec "' + sys.executable + '" -S "$@"\n')
        python.chmod(0o755)
        script = b'import yaml, json, sys; print(json.dumps(sys.argv[1:]))\n'
        (self.root / 'tavern-updater-bootstrap.py').write_bytes(script)
        (self.root / 'bootstrap-manifest.json').write_text(json.dumps({
            'scope': 'tavern-updater-bootstrap', 'sha256': hashlib.sha256(script).hexdigest()}))
        result = self.run_installer('--tag', 'v1.26.0-rc.1')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_bad_explicit_python_fails_before_downloading_or_refreshing_skills(self):
        self.env['TAVERN_PYTHON'] = str(self.root / 'nonexistent-python')
        result = self.run_installer('--tag', 'v1.26.0-rc.1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('TAVERN_PYTHON', result.stderr)
        self.assertEqual(self.requests(), [])

    def test_automatic_selection_skips_path_python_without_yaml(self):
        self.env.pop('TAVERN_PYTHON')
        venv = self.root / 'venv/bin'
        venv.mkdir(parents=True)
        (venv / 'python3').symlink_to(sys.executable)
        self.env['VIRTUAL_ENV'] = str(venv.parent)
        python = self.root / 'bin/python3'
        python.write_text('#!/bin/sh\nexec "' + sys.executable + '" -S "$@"\n')
        python.chmod(0o755)
        script = b'import yaml, json, sys; print(json.dumps(sys.argv[1:]))\n'
        (self.root / 'tavern-updater-bootstrap.py').write_bytes(script)
        (self.root / 'bootstrap-manifest.json').write_text(json.dumps({
            'scope': 'tavern-updater-bootstrap', 'sha256': hashlib.sha256(script).hexdigest()}))
        result = self.run_installer('--tag', 'v1.26.0-rc.1')
        self.assertEqual(result.returncode, 0, result.stderr)

    def run_installer(self, *args):
        return subprocess.run(['sh', str(INSTALLER), *args], env=self.env, capture_output=True, text=True)

    def requests(self):
        log = self.root / 'requests.jsonl'
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def test_explicit_tag_selects_both_bootstrap_files_and_preserves_arguments(self):
        for tag_args in [('--tag', 'v1.26.0-rc.1'), ('--tag=v1.26.0-rc.1',)]:
            with self.subTest(tag_args=tag_args):
                args = (*tag_args, '--data-root', '/test/hermes', '--allow-candidate')
                result = self.run_installer(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), list(args))
                self.assertTrue(all('/releases/download/v1.26.0-rc.1/' in url for url in self.requests()))

    def test_default_stays_on_latest(self):
        result = self.run_installer('--data-root', '/test/hermes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.requests()), 2)
        self.assertTrue(all('/releases/latest/download/' in url for url in self.requests()))

    def test_invalid_or_missing_tag_is_rejected_before_download(self):
        for args in [('--tag', '../main'), ('--tag', ''), ('--tag',), ('--tag', 'one', '--tag', 'two')]:
            with self.subTest(args=args):
                result = self.run_installer(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.requests(), [])

    def test_bad_checksum_never_executes_bootstrap(self):
        (self.root / 'tavern-updater-bootstrap.py').write_text('raise RuntimeError("must not execute")\n')
        result = self.run_installer('--tag', 'v1.26.0-rc.1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum mismatch', result.stderr)
        self.assertNotIn('must not execute', result.stderr)


if __name__ == '__main__':
    unittest.main()
