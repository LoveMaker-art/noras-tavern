"""Installed skill selection must not silently prefer a historical Bootstrap."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import test_full_update as fixtures
from engine_snapshot import capture, verify
import update
from clean_update import CleanUpdater


class UpdaterEntryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='tavern-entry-')
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()
        self.launcher = self.home / 'skills/system/tavern-updater/scripts/update.py'
        self.launcher.parent.mkdir(parents=True)
        self.launcher.write_bytes((fixtures.OPS / 'skills/system/tavern-updater/scripts/update.py').read_bytes())

    def test_installed_operations_win_over_stale_bootstrap_pointer(self):
        installed = self.home / 'apps/tavern-ops/updater/update.py'
        installed.parent.mkdir(parents=True)
        installed.write_text('print("installed")\n')
        root = self.home / 'tavern-updates-v2'
        bootstrap = root / ('bootstrap-' + 'a' * 64) / 'ops/updater/update.py'
        bootstrap.parent.mkdir(parents=True)
        bootstrap.write_text('print("historical-bootstrap")\n')
        (root / 'bootstrap-runtime.json').write_text(json.dumps({'schema': 1,
            'entry': str(bootstrap), 'sha256': hashlib.sha256(bootstrap.read_bytes()).hexdigest(),
            'manifestSha256': 'a' * 64}))
        result = subprocess.run([sys.executable, str(self.launcher), 'status'],
            env={**os.environ, 'HERMES_HOME': str(self.home)}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'installed')
        installed.unlink()
        missing = subprocess.run([sys.executable, str(self.launcher), 'status'],
            env={**os.environ, 'HERMES_HOME': str(self.home)}, capture_output=True, text=True)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn('Installed updater is missing', missing.stderr)
        self.assertNotIn('historical-bootstrap', missing.stdout)

    def snapshot(self):
        source = self.home / 'source'
        source.mkdir()
        (source / 'update.py').write_text('print("reviewed")\n')
        (source / 'helper.py').write_text('value = 1\n')
        transaction = self.home / 'review-test'
        transaction.mkdir()
        return transaction, capture(transaction, source)

    def test_snapshot_is_independent_of_changed_installed_code(self):
        transaction, descriptor = self.snapshot()
        (self.home / 'source/helper.py').write_text('value = 2\n')
        self.assertEqual(verify(transaction, descriptor), transaction / 'engine/update.py')
        self.assertEqual((transaction / 'engine/helper.py').read_text(), 'value = 1\n')

    def test_changed_helper_or_extra_code_cannot_execute(self):
        transaction, descriptor = self.snapshot()
        helper = transaction / 'engine/helper.py'
        helper.write_text('value = 2\n')
        with self.assertRaisesRegex(ValueError, 'engine changed'):
            verify(transaction, descriptor)
        helper.write_text('value = 1\n')
        (transaction / 'engine/sitecustomize.py').write_text('raise RuntimeError()\n')
        with self.assertRaisesRegex(ValueError, 'engine changed'):
            verify(transaction, descriptor)

    def test_symlink_or_bytecode_in_snapshot_is_not_trusted(self):
        transaction, descriptor = self.snapshot()
        helper = transaction / 'engine/helper.py'
        helper.unlink()
        helper.symlink_to(self.home / 'source/helper.py')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            verify(transaction, descriptor)
        helper.unlink()
        helper.write_text('value = 1\n')
        (transaction / 'engine/__pycache__').mkdir()
        with self.assertRaisesRegex(ValueError, 'bytecode'):
            verify(transaction, descriptor)

    def test_cli_verifies_plan_then_delegates_to_exact_reviewed_engine(self):
        fixture = fixtures.FullUpdateTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        updater = CleanUpdater(fixture.home, lifecycle=fixtures.Service())
        result = updater.review(fixture.release, fixtures.digest((fixture.release / 'release-manifest.json').read_bytes()), candidate=True)
        args = ['update.py', '--hermes-home', str(fixture.home), 'apply', '--transaction', result['transaction'],
                '--expected-plan', result['planDigest'], '--confirm']
        class Delegated(BaseException):
            pass
        with patch.object(sys, 'argv', args), patch('update.os.execv', side_effect=Delegated) as execute:
            with self.assertRaises(Delegated):
                update.main()
        self.assertEqual(execute.call_args.args, (sys.executable,
            [sys.executable, '-B', '-u', result['engine']['entry'], *args[1:]]))
        plan = Path(result['transaction']) / 'plan.json'
        changed = json.loads(plan.read_text())
        changed['commit'] = 'unreviewed'
        plan.write_text(json.dumps(changed))
        with patch.object(sys, 'argv', args), patch('update.os.execv') as execute:
            with self.assertRaisesRegex(ValueError, 'Plan changed'):
                update.main()
            execute.assert_not_called()
        self.assertFalse((plan.parent / 'receipt.json').exists())


if __name__ == '__main__':
    unittest.main()
