"""Old Bootstrap adoption reaches the new pinned CLI without touching runtime data."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import test_full_update as fixtures


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.FullUpdateTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.home = self.fixture.home
        self.env = {**os.environ, 'HERMES_HOME': str(self.home)}

    def run_bootstrap(self, *extra):
        f = self.fixture
        return subprocess.run([sys.executable, str(fixtures.OPS / 'updater/bootstrap.py'), '--data-root', str(self.home),
            '--release-dir', str(f.release), '--manifest-sha256', fixtures.digest((f.release / 'release-manifest.json').read_bytes()),
            *extra], env=self.env, capture_output=True, text=True)

    def test_review_adopts_updater_but_preserves_app_state_and_agents(self):
        before = self.fixture.snapshot()
        result = self.run_bootstrap('--allow-candidate')
        self.assertEqual(result.returncode, 0, result.stderr)
        review = json.loads(result.stdout)
        self.assertTrue(review['updater_installed'])
        after = self.fixture.snapshot()
        for name, value in before.items():
            self.assertEqual(after[name], value, name)
        launcher = self.home / 'skills/system/tavern-updater/scripts/update.py'
        wrong = subprocess.run([sys.executable, str(launcher), 'apply', '--plan', 'wrong-plan', '--confirm'],
                               env=self.env, capture_output=True, text=True)
        self.assertNotEqual(wrong.returncode, 0)
        self.assertIn('differs from the pinned', wrong.stderr)
        transaction = Path(review['review']['transaction'])
        plan = json.loads((transaction / 'plan.json').read_text())
        plan['commit'] = 'changed-after-review'
        (transaction / 'plan.json').write_text(json.dumps(plan))
        changed = subprocess.run([sys.executable, str(launcher), 'apply', '--plan', review['report']['plan_id'], '--confirm'],
                                 env=self.env, capture_output=True, text=True)
        self.assertNotEqual(changed.returncode, 0)
        self.assertIn('Plan changed', changed.stderr)
        self.assertFalse((transaction / 'receipt.json').exists())

    def test_corrupt_archive_is_rejected_before_skill_adoption(self):
        (self.fixture.release / 'nora-tavern-ops.tar.gz').write_bytes(b'corrupt')
        result = self.run_bootstrap('--allow-candidate')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum', result.stderr)
        self.assertFalse((self.home / 'skills/system/tavern-updater').exists())

    def test_apply_requires_explicit_confirmation(self):
        result = self.run_bootstrap('--apply')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--apply requires --confirm', result.stderr)
        self.assertFalse((self.home / 'skills/system/tavern-updater').exists())

    def test_existing_skill_symlink_is_rejected_before_copy(self):
        skill = self.home / 'skills/system/tavern-updater'
        skill.mkdir(parents=True)
        (skill / 'private-link').symlink_to(self.home / 'config.yaml')
        result = self.run_bootstrap('--allow-candidate')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('symlink', result.stderr.lower())
        self.assertFalse(list((self.home / 'tavern-updates-v2').glob('bootstrap-updater-backup-*')))


if __name__ == '__main__':
    unittest.main()
