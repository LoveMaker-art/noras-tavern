"""Old Bootstrap adoption reaches the new pinned CLI without touching runtime data."""
import json
import io
import os
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_full_update as fixtures
from bootstrap import installation_home
import bootstrap


class BootstrapTests(unittest.TestCase):
    def test_account_home_requires_explicit_existing_hermes_installation(self):
        with patch.object(Path, 'home', return_value=self.home), patch.dict(os.environ, self.env):
            self.assertEqual(installation_home(self.home), self.home)
        with patch.object(Path, 'home', return_value=self.fixture.root), \
             patch.dict(os.environ, {'HERMES_HOME': str(self.fixture.root)}):
            with self.assertRaisesRegex(ValueError, 'exact non-symlink'):
                installation_home(self.fixture.root)

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

    def test_missing_yaml_fails_before_any_bootstrap_state_or_skill_change(self):
        result = subprocess.run([sys.executable, '-S', str(fixtures.OPS / 'updater/bootstrap.py'),
                                 '--data-root', str(self.home)], env=self.env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('TAVERN_PYTHON', result.stderr)
        self.assertFalse((self.home / 'tavern-updates-v2').exists())
        self.assertFalse((self.home / 'skills/system/tavern-updater').exists())

    def test_review_adopts_updater_but_preserves_app_state_and_agents(self):
        before = self.fixture.snapshot()
        result = self.run_bootstrap('--allow-candidate')
        self.assertEqual(result.returncode, 0, result.stderr)
        review = json.loads(result.stdout)
        self.assertTrue(review['updater_installed'])
        self.assertNotIn('restartCommand', review)
        self.assertNotIn('/restart', review['next_step'])
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

    def completed_bootstrap(self, *, status='installed-awaiting-hermes-reload', returncode=0, isolated=False):
        """Real bundle/adoption; substitute only the child review/apply processes."""
        transaction = self.home / 'tavern-updates-v2/review-completion'
        review = {'transaction': str(transaction), 'planDigest': 'fixture-digest'}
        def apply(command, **_kwargs):
            self.assertIn('apply', command)
            transaction.mkdir(parents=True, exist_ok=True)
            (transaction / 'receipt.json').write_text(json.dumps({'status': status, 'commit': 'a' * 40}))
            return subprocess.CompletedProcess(command, returncode, 'npm progress\n', 'fixture apply error' if returncode else '')
        args = ['bootstrap.py', '--data-root', str(self.home), '--release-dir', str(self.fixture.release),
                '--manifest-sha256', fixtures.digest((self.fixture.release / 'release-manifest.json').read_bytes()),
                '--apply', '--confirm']
        if isolated:
            args += ['--isolated-test-port', '54321']
        output = io.StringIO()
        notice = io.StringIO()
        with patch.object(sys, 'argv', args), patch.dict(os.environ, self.env), \
             patch.object(bootstrap.subprocess, 'check_output', return_value=json.dumps(review)), \
             patch.object(bootstrap.subprocess, 'run', side_effect=apply) as applied, \
             redirect_stdout(output), redirect_stderr(notice):
            bootstrap.main()
        self.assertEqual(applied.call_count, 1, 'Bootstrap must not execute a restart')
        result = json.loads(output.getvalue())
        self.assertEqual(notice.getvalue(), '' if isolated else result['next_step'] + '\n')
        return result

    def test_successful_apply_replaces_stale_review_prompt_with_restart_command(self):
        result = self.completed_bootstrap()
        self.assertEqual(result['restartCommand'], '/restart')
        self.assertIn('ClawChat', result['next_step'])
        self.assertIn('/restart', result['next_step'])
        self.assertNotIn('Review migration', result['next_step'])

    def test_isolated_success_does_not_tell_owner_to_restart_live_gateway(self):
        result = self.completed_bootstrap(isolated=True)
        self.assertNotIn('restartCommand', result)
        self.assertNotIn('/restart', result['next_step'])

    def test_zero_exit_without_success_receipt_does_not_report_success(self):
        with self.assertRaises(ValueError):
            self.completed_bootstrap(status='rolled-back')

    def test_failed_apply_does_not_emit_success_or_restart_prompt(self):
        with self.assertRaisesRegex(ValueError, 'Update did not complete'):
            self.completed_bootstrap(returncode=1)

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
