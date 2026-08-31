"""Status separates historical receipts, current runtime and external activation."""
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_clean_update as fixtures
from update import json_write
from update_status import inspect, receipt_result, observe_runtime


class UpdateStatusTests(unittest.TestCase):
    def test_rollback_result_does_not_repeat_installation_success_instruction(self):
        result = receipt_result({'status': 'rolled-back', 'next_step': 'installed; restart now'})
        self.assertNotIn('restart now', result['next_step'])
        self.assertEqual(result['hermes']['status'], 'not-verified')

    def setUp(self):
        fixture = fixtures.CleanUpdateTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture, self.u = fixture.fixture, fixture.u

    def review(self):
        return Path(self.fixture.review()['transaction'])

    def snapshot(self):
        return {str(p.relative_to(self.u.home)): p.read_bytes()
                for p in self.u.home.rglob('*') if p.is_file()}

    def test_status_of_review_is_read_only_even_with_stale_pid(self):
        transaction = self.review()
        pid = self.u.state / 'native-runtime/runs/production/native.pid'
        pid.parent.mkdir(parents=True, exist_ok=True)
        pid.write_text('99999999\n')
        before = self.snapshot()
        with patch('update_status.observe_runtime', return_value={'status': 'offline'}) as observe:
            result = inspect(self.u, transaction)
        self.assertEqual(result['status'], 'reviewed')
        self.assertEqual(result['runtime']['status'], 'offline')
        self.assertEqual(result['liveware']['status'], 'not-verified')
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.fixture.service.calls, [])
        observe.assert_called_once_with(self.u.home, 54321)

    def test_old_rollback_does_not_claim_current_service_is_healthy(self):
        transaction = self.review()
        json_write(transaction / 'receipt.json', {'status': 'rolled-back',
                   'failure': {'phase': 'stop-runtime', 'reason': 'old failure'}})
        with patch('update_status.observe_runtime', return_value={'status': 'offline', 'observedAt': 123}):
            result = inspect(self.u)
        self.assertEqual(result['outcome'], 'failed-rolled-back')
        self.assertTrue(result['installation']['historical'])
        self.assertEqual(result['runtime'], {'status': 'offline', 'observedAt': 123})

    def test_local_verification_is_not_liveware_or_gateway_verification(self):
        result = receipt_result({'status': 'installed-awaiting-hermes-reload',
            'verification': {'tavernHealth': True, 'storyProfileRoute': True,
                             'newMcpProcess': {'server': {'version': '0.3.1'}}, 'gatewayMcpReloaded': False}})
        self.assertTrue(result['installation']['runtimeVerifiedAtInstall'])
        self.assertEqual(result['runtime']['status'], 'not-checked')
        self.assertEqual(result['liveware']['status'], 'not-verified')
        self.assertEqual(result['hermes']['status'], 'awaiting-owner-restart')

    def test_status_rejects_foreign_transaction_and_receipt_identity(self):
        with self.assertRaisesRegex(ValueError, 'another installation'):
            inspect(self.u, self.u.home / 'review-outside')
        transaction = self.review()
        json_write(transaction / 'receipt.json', {'status': 'rolled-back', 'planDigest': 'wrong'})
        with self.assertRaisesRegex(ValueError, 'identity differ'):
            inspect(self.u, transaction)

    def test_cli_status_does_not_create_transaction_or_change_files(self):
        self.review()
        before = self.snapshot()
        result = subprocess.run([sys.executable, str(fixtures.fixtures.OPS / 'updater/update.py'),
            '--hermes-home', str(self.u.home), '--isolated-test-port', '54321', 'status'],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['readOnly'])
        self.assertEqual(self.snapshot(), before)

    def test_current_process_failure_is_unknown_not_false_offline(self):
        script = self.u.targets['app'] / 'engine/sillytavern/server.js'
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text('// fixture')
        with patch('runtime_process.find_processes', side_effect=ValueError('inspection failed')):
            result = observe_runtime(self.u.home, 54321)
        self.assertEqual(result['status'], 'unknown')
        self.assertIn('inspection failed', result['reason'])

    def test_recovery_failure_keeps_both_causes_in_receipt(self):
        review = self.fixture.review()
        def fail_pause(_):
            raise ValueError('original stop failure')
        def fail_restore(_):
            raise ValueError('original runtime could not restart')
        self.u.lifecycle.pause, self.u.lifecycle.restore = fail_pause, fail_restore
        with self.assertRaisesRegex(ValueError, 'could not restart'):
            self.u.apply(review['transaction'], review['planDigest'])
        transaction = Path(review['transaction'])
        receipt = json.loads((transaction / 'receipt.json').read_text())
        self.assertEqual(receipt['failure']['reason'], 'original stop failure')
        self.assertEqual(receipt['recoveryFailure']['reason'], 'original runtime could not restart')
        with patch('update_status.observe_runtime', return_value={'status': 'offline'}):
            result = inspect(self.u, transaction)
        self.assertEqual(result['outcome'], 'recovery-required')
        self.assertEqual(result['lastProgress']['phase'], 'recovery')
        self.assertEqual(result['lastProgress']['status'], 'failed')

    def test_dependency_failure_is_durable_without_stopping_runtime(self):
        review = self.fixture.review()
        def fail(_):
            raise ValueError('dependency download failed')
        self.u.lifecycle.prepare = fail
        with self.assertRaisesRegex(ValueError, 'dependency download failed'):
            self.u.apply(review['transaction'], review['planDigest'])
        receipt = json.loads((Path(review['transaction']) / 'receipt.json').read_text())
        self.assertEqual(receipt['status'], 'refused-before-maintenance')
        self.assertEqual(receipt['failure']['phase'], 'dependencies')
        self.assertEqual(self.fixture.service.calls, [])


if __name__ == '__main__':
    unittest.main()
