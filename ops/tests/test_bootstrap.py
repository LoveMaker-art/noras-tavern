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
    def test_review_preserves_all_active_skills_byte_for_byte(self):
        self.fixture.write('skills/system/tavern-updater/SKILL.md', 'existing updater skill')
        before = self.fixture.snapshot()
        result = self.run_bootstrap('--allow-candidate')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.fixture.snapshot(), before)
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

    def test_review_stages_engine_and_leaves_active_installation_unchanged(self):
        before = self.fixture.snapshot()
        result = self.run_bootstrap('--allow-candidate')
        self.assertEqual(result.returncode, 0, result.stderr)
        review = json.loads(result.stdout)
        self.assertFalse(review['updater_installed'])
        self.assertTrue(review['updater_staged'])
        self.assertNotIn('restartCommand', review)
        self.assertNotIn('/restart', review['next_step'])
        after = self.fixture.snapshot()
        for name, value in before.items():
            self.assertEqual(after[name], value, name)
        self.assertEqual(after, before)
        launcher = Path(review['review']['engine']['entry'])
        self.assertIn(str(launcher), review['applyCommand'])
        wrong = subprocess.run([sys.executable, '-B', str(launcher), '--hermes-home', str(self.home), 'apply', '--plan', 'wrong-plan', '--confirm'],
                               env=self.env, capture_output=True, text=True)
        self.assertNotEqual(wrong.returncode, 0)
        self.assertIn('differs from the pinned', wrong.stderr)
        transaction = Path(review['review']['transaction'])
        plan = json.loads((transaction / 'plan.json').read_text())
        plan['commit'] = 'changed-after-review'
        (transaction / 'plan.json').write_text(json.dumps(plan))
        changed = subprocess.run([sys.executable, '-B', str(launcher), '--hermes-home', str(self.home), 'apply', '--plan', review['report']['plan_id'], '--confirm'],
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

    def test_repeated_review_does_not_modify_skills_or_reuse_unreviewed_code(self):
        before = self.fixture.snapshot()
        first = self.run_bootstrap('--allow-candidate')
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.run_bootstrap('--allow-candidate')
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertNotEqual(json.loads(first.stdout)['review']['transaction'], json.loads(second.stdout)['review']['transaction'])
        self.assertEqual(self.fixture.snapshot(), before)
        digest = fixtures.digest((self.fixture.release / 'release-manifest.json').read_bytes())
        staged = self.home / 'tavern-updates-v2' / ('bootstrap-' + digest)
        (staged / 'ops/updater/unreviewed.py').write_text('raise RuntimeError("not part of release")\n')
        changed = self.run_bootstrap('--allow-candidate')
        self.assertNotEqual(changed.returncode, 0)
        self.assertIn('unreviewed files', changed.stderr)
        self.assertEqual(self.fixture.snapshot(), before)

    def test_apply_requires_explicit_confirmation(self):
        result = self.run_bootstrap('--apply')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--apply requires --confirm', result.stderr)
        self.assertFalse((self.home / 'skills/system/tavern-updater').exists())

    def test_auth_preparation_requires_confirmed_apply_and_precedes_review(self):
        with patch('liveware_integration.prepare_update') as prepare:
            self.completed_bootstrap()
        prepare.assert_called_once_with(self.home, allow_login=True, isolated=False)

    def test_failed_login_stops_before_review_or_service_changes(self):
        from liveware_integration import PlatformError
        before = self.fixture.snapshot()
        with patch('liveware_integration.prepare_update', side_effect=PlatformError('AUTH', 'synthetic auth failure')), \
             self.assertRaises(bootstrap.UpdateFailure) as raised:
            self.completed_bootstrap()
        self.assertEqual(raised.exception.result['status'], 'refused-before-maintenance')
        self.assertEqual(raised.exception.result['phase'], 'liveware-auth')
        self.assertEqual(self.fixture.snapshot(), before)

    def test_review_only_checks_auth_without_logging_in(self):
        args = ['bootstrap.py', '--data-root', str(self.home), '--release-dir', str(self.fixture.release),
                '--manifest-sha256', fixtures.digest((self.fixture.release / 'release-manifest.json').read_bytes())]
        def review(*args, **kwargs):
            prepare.assert_called_once_with(self.home, allow_login=False, isolated=False)
            raise RuntimeError('stop at review boundary')
        with patch.object(sys, 'argv', args), patch.dict(os.environ, self.env), \
             patch('liveware_integration.prepare_update') as prepare, \
             patch.object(bootstrap, 'run_cli', side_effect=review), \
             redirect_stderr(io.StringIO()), self.assertRaisesRegex(RuntimeError, 'review boundary'):
            bootstrap.main()

    def completed_bootstrap(self, *, status='installed-awaiting-hermes-reload', returncode=0, isolated=False, check_progress=False):
        """Real bundle/adoption; substitute only the child review/apply processes."""
        transaction = self.home / 'tavern-updates-v2/review-completion'
        review = {'transaction': str(transaction), 'planDigest': 'fixture-digest',
                  'engine': {'entry': str(transaction / 'engine/update.py')}}
        def apply(command, **_kwargs):
            if 'review' in command:
                return subprocess.CompletedProcess(command, 0, json.dumps(review), '')
            self.assertIn('apply', command)
            if check_progress:
                self.assertIn('[tavern-updater]', notice.getvalue(), 'Show progress before waiting for apply')
            transaction.mkdir(parents=True, exist_ok=True)
            (transaction / 'receipt.json').write_text(json.dumps({'status': status, 'commit': 'a' * 40}))
            return subprocess.CompletedProcess(command, returncode, 'npm progress\n', 'fixture apply error' if returncode else '')
        args = ['bootstrap.py', '--data-root', str(self.home), '--release-dir', str(self.fixture.release),
                '--manifest-sha256', fixtures.digest((self.fixture.release / 'release-manifest.json').read_bytes()),
                '--apply', '--confirm']
        if isolated:
            self.fixture.write('.tavern-isolated-update.json', json.dumps({
                'schema': 1, 'home': str(self.home), 'purpose': 'isolated-update-test'}))
            args += ['--isolated-test-port', '54321']
        output = io.StringIO()
        notice = io.StringIO()
        with patch.object(sys, 'argv', args), patch.dict(os.environ, self.env), \
             patch.object(bootstrap, 'run_cli', side_effect=apply) as applied, \
             redirect_stdout(output), redirect_stderr(notice):
            bootstrap.main()
        self.assertEqual(applied.call_count, 2, 'Only review and apply; no restart or retry')
        result = json.loads(output.getvalue())
        self.assertIn('[tavern-updater]', notice.getvalue())
        if isolated:
            self.assertNotIn('/restart', notice.getvalue())
        else:
            self.assertTrue(notice.getvalue().endswith(result['next_step'] + '\n'))
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

    def test_apply_failure_reports_cause_instead_of_asking_agent_to_read_logs(self):
        with self.assertRaisesRegex(ValueError, 'fixture apply error'):
            self.completed_bootstrap(status='rolled-back', returncode=1)

    def test_progress_is_visible_before_apply_returns(self):
        self.completed_bootstrap(check_progress=True)

    def test_downloaded_standalone_bootstrap_resolves_completion_after_stage_moves(self):
        # Reproduce curl's single-file download, without repo sys.path or cached
        # completion imports from this test runner. Only child processes are stubbed.
        script = r'''
import importlib.util, json, pathlib, subprocess, sys
from unittest.mock import patch
source, target, bundle, digest = sys.argv[1:]
spec = importlib.util.spec_from_file_location('downloaded_bootstrap', source)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
transaction = pathlib.Path(target) / 'tavern-updates-v2/review-completion'
review = {'transaction': str(transaction), 'planDigest': 'fixture-digest',
          'engine': {'entry': str(transaction / 'engine/update.py')}}
def apply(command, **kwargs):
    if 'review' in command:
        return subprocess.CompletedProcess(command, 0, json.dumps(review), '')
    transaction.mkdir(parents=True)
    (transaction / 'receipt.json').write_text(json.dumps({'status': 'installed-awaiting-hermes-reload', 'commit': 'a' * 40}))
    return subprocess.CompletedProcess(command, 0, '', '')
sys.argv = [source, '--data-root', target, '--release-dir', bundle, '--manifest-sha256', digest, '--apply', '--confirm']
with patch.object(bootstrap, 'run_cli', side_effect=apply):
    bootstrap.main()
'''
        downloaded = self.fixture.root / 'tavern-updater-bootstrap.py'
        downloaded.write_bytes((fixtures.OPS / 'updater/bootstrap.py').read_bytes())
        result = subprocess.run([sys.executable, '-c', script, str(downloaded), str(self.home),
                                 str(self.fixture.release), fixtures.digest((self.fixture.release / 'release-manifest.json').read_bytes())],
                                env={k: v for k, v in self.env.items() if k != 'PYTHONPATH'},
                                cwd=self.fixture.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['restartCommand'], '/restart')
        self.assertIn('/restart', result.stderr)

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
