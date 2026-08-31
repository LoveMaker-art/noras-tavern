"""Observable subprocess progress and truthful, bounded failure reporting."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'updater'))
from feedback import PREFIX, failure_report, phase, public_reason, run_cli
import bootstrap
import test_clean_update as clean


class FeedbackTests(unittest.TestCase):
    def test_disconnected_terminal_does_not_fail_the_update_operation(self):
        with patch('feedback.sys.stderr.write', side_effect=BrokenPipeError):
            with phase('fixture', 'fixture operation'):
                completed = True
        self.assertTrue(completed)

    def test_actual_child_progress_arrives_before_child_is_allowed_to_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            gate = root / 'allow-exit'
            log = root / 'private.log'
            seen = threading.Event()
            results = []
            class Output(io.StringIO):
                def write(self, text):
                    if 'child-ready' in text:
                        seen.set()
                    return super().write(text)
            output = Output()
            script = '''
import json, pathlib, sys, time
print('private diagnostic only', file=sys.stderr, flush=True)
print('[tavern-updater] ' + json.dumps({'event': 'progress', 'phase': 'child-ready'}), file=sys.stderr, flush=True)
deadline = time.monotonic() + 5
while not pathlib.Path(sys.argv[1]).exists():
    if time.monotonic() > deadline:
        raise SystemExit(2)
    time.sleep(.01)
print(json.dumps({'ok': True}))
'''
            def invoke():
                results.append(run_cli([sys.executable, '-u', '-c', script, str(gate)], env=os.environ, log=log))
            with redirect_stderr(output):
                thread = threading.Thread(target=invoke)
                thread.start()
                try:
                    self.assertTrue(seen.wait(3), 'Progress was buffered until process exit')
                    self.assertTrue(thread.is_alive(), 'Child must still be waiting for parent authorization to exit')
                finally:
                    gate.touch()
                    thread.join(6)
            self.assertFalse(thread.is_alive())
            self.assertEqual(results[0].returncode, 0)
            self.assertEqual(json.loads(results[0].stdout), {'ok': True})
            self.assertNotIn('private diagnostic only', output.getvalue())
            self.assertIn('private diagnostic only', log.read_text())
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_slow_phase_reports_heartbeat_and_stops_worker(self):
        seen = threading.Event()
        events = []
        def collect(event):
            events.append(event)
            if event['status'] == 'running':
                seen.set()
        with patch('feedback.emit', side_effect=collect), patch('feedback.HEARTBEAT_SECONDS', .01):
            with phase('dependencies', '准备依赖'):
                self.assertTrue(seen.wait(1))
            count = len(events)
            self.assertEqual(events[-1]['status'], 'completed')
        self.assertEqual(len(events), count)
        self.assertEqual(events[0]['status'], 'started')
        self.assertTrue(all(event['phase'] == 'dependencies' for event in events))

    def test_failure_without_a_receipt_never_claims_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            report = failure_report(ValueError('fixture failure'), Path(directory).resolve())
            self.assertEqual(report['status'], 'unconfirmed')
            self.assertNotIn('已回滚', report['recovery'])
            self.assertNotIn('restartCommand', report)

    def test_failed_recovery_preserves_both_causes_and_never_claims_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / 'receipt.json').write_text(json.dumps({'status': 'files-restored', 'applied': [0],
                'restored': [0], 'failure': {'phase': 'stop-runtime', 'reason': 'original stop failure'}}))
            report = failure_report(ValueError('restore failed'), root)
            self.assertEqual(report['error'], 'original stop failure')
            self.assertEqual(report['recoveryError'], 'restore failed')
            self.assertEqual(report['status'], 'files-restored')
            self.assertIn('未确认', report['recovery'])
            self.assertNotIn('restartCommand', report)

    def test_public_failure_redacts_keys_and_subprocess_arguments(self):
        text = public_reason(ValueError('api_key=private-value token:secret-value Bearer secret-bearer sk-example-secret https://user:password@example.com/a?token=private'))
        for secret in ('private-value', 'secret-value', 'secret-bearer', 'sk-example-secret', 'password'):
            self.assertNotIn(secret, text)
        error = subprocess.CalledProcessError(1, ['tool', '--key', 'private-key'])
        self.assertNotIn('private-key', public_reason(error))

    def test_bootstrap_failure_uses_structured_cause_without_another_tool_call(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory).resolve() / 'apply-error.log'
            event = {'event': 'failure', 'ok': False, 'phase': 'stop-runtime',
                     'error': 'verified stop failure', 'status': 'rolled-back', 'next_step': 'report and stop'}
            script = 'import sys; print(' + repr(PREFIX + json.dumps(event)) + ', file=sys.stderr); sys.exit(7)'
            with self.assertRaises(bootstrap.UpdateFailure) as raised:
                bootstrap.checked_cli([sys.executable, '-c', script], env=os.environ, log=log)
            self.assertEqual(raised.exception.result['error'], event['error'])
            self.assertEqual(raised.exception.result['status'], 'rolled-back')
            self.assertEqual(raised.exception.result['errorLog'], str(log))

    def test_cli_real_transaction_pause_failure_returns_reason_and_recovery(self):
        fixture = clean.CleanUpdateTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        review = fixture.fixture.review()
        # Real CLI/apply/recovery against disposable data; only runtime operations
        # are the existing fixture adapter. No service or user installation touched.
        script = '''
import sys
from unittest.mock import patch
from clean_update import CleanUpdater
from test_full_update import Service
import update
service = Service()
service.require_offline = lambda: None
def fail(_):
    raise ValueError('Tavern did not stop or its supervisor restarted it; no directory was switched')
service.pause = fail
home, transaction, digest = sys.argv[1:]
updater = CleanUpdater(home, lifecycle=service, port=54321)
sys.argv = ['update.py', '--hermes-home', home, '--isolated-test-port', '54321', 'apply', '--transaction', transaction, '--expected-plan', digest, '--confirm']
try:
    # Engine routing is covered independently. Keep this failure test on the
    # fixture lifecycle instead of replacing it with the real service adapter.
    with patch('clean_update.CleanUpdater', return_value=updater), patch('update.os.execv'):
        update.main()
except Exception as error:
    from feedback import emit, failure_report
    emit(failure_report(error, getattr(error, 'update_transaction', None)))
    sys.exit(1)
'''
        root = Path(__file__).resolve().parents[1]
        env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(root / 'updater'), str(root / 'tests')])}
        output = io.StringIO()
        with redirect_stderr(output):
            result = run_cli([sys.executable, '-c', script, str(fixture.home), review['transaction'], review['planDigest']],
                             env=env, log=Path(review['transaction']) / 'apply-error.log')
        self.assertEqual(result.returncode, 1, result.stderr)
        report = json.loads(result.stderr)
        self.assertEqual(report['status'], 'rolled-back')
        self.assertEqual(report['phase'], 'stop-runtime')
        self.assertIn('Tavern did not stop', report['error'])
        self.assertEqual(report['switchIntents'], 0)
        self.assertIn('已回滚', report['recovery'])
        self.assertIn('recovery', output.getvalue())
        self.assertNotIn('/restart', result.stderr)


if __name__ == '__main__':
    unittest.main()
