import io
import contextlib
import json
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ops.installer import launcher_bridge as bridge
from ops.installer import operation_cli

if __package__:
    from .launcher_test_environment import resolve_node
else:
    from launcher_test_environment import resolve_node

NODE = resolve_node()
CLOSURE_PREFIX = 'NORA_FIXTURE_CLOSURE '

@contextlib.contextmanager
def owned_fixture_directory(prefix):
    """Retain a fresh root whenever an admitted helper lacks actual close proof."""
    fixture = SimpleNamespace(root=Path(tempfile.mkdtemp(prefix=prefix)).resolve(), closed=True)
    try:
        yield fixture
    finally:
        if fixture.closed:
            shutil.rmtree(fixture.root)
        else:
            message = f'Retaining owned fixture without closure proof: {fixture.root}'
            primary = sys.exc_info()[1]
            if primary is None:
                raise RuntimeError(message)
            if hasattr(primary, 'add_note'):
                primary.add_note(message)
            else:
                primary.fixture_root = str(fixture.root)

def require_fixture_closure(fixture, output):
    fixture.closed = False
    records = [json.loads(line[len(CLOSURE_PREFIX):]) for line in output.splitlines()
               if line.startswith(CLOSURE_PREFIX)]
    if (len(records) != 1 or set(records[0]) != {'schema', 'root', 'closed'}
            or records[0]['schema'] != 'nora-fixture-closure/1'
            or not isinstance(records[0]['root'], str)
            or Path(records[0]['root']).resolve() != fixture.root
            or records[0]['closed'] is not True):
        raise RuntimeError(f'Owned fixture closure proof is missing or invalid; retained: {fixture.root}')
    fixture.closed = True

def close_fixture_child(child, timeout=2):
    """Close only the Popen we held; a TERM request is not proof of exit."""
    if child.poll() is None:
        try:
            child.terminate()
        except ProcessLookupError:
            pass
    streams = [getattr(child, name, None) for name in ('stdin', 'stdout', 'stderr')]
    try:
        if any(stream is not None and not stream.closed for stream in streams):
            child.communicate(timeout=timeout)
        else:
            child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        child.kill()
        if any(stream is not None and not stream.closed for stream in streams):
            child.communicate(timeout=timeout)
        else:
            child.wait(timeout=timeout)
    if child.poll() is None:
        raise RuntimeError('Held fixture child closure remains unconfirmed')
    for stream in streams:
        if stream is not None and not stream.closed:
            stream.close()

class LauncherRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='nora-launcher-recovery-')).resolve()
        self.fixture_children = []
        self.addCleanup(self.cleanup_fixture)
        self.args = SimpleNamespace(nora_home=self.root, hermes_home=self.root / 'hermes',
                                    install_root=self.root / 'tavern', port=18899,
                                    command='recover-update')

    def cleanup_fixture(self):
        failures = []
        for child in self.fixture_children:
            try:
                close_fixture_child(child)
            except Exception as error:
                failures.append(error)
        if failures:
            raise RuntimeError(f'Retaining fixture with unconfirmed child closure: {self.root}') from failures[0]
        shutil.rmtree(self.root)

    def test_real_recovery_entry_accepts_original_operation_id(self):
        operation_id = '91672b04-efb3-4874-b187-94f4230711e2'
        argv = ['launcher_bridge.py', '--nora-home', str(self.root),
                '--hermes-home', str(self.args.hermes_home), '--install-root', str(self.args.install_root),
                'recover-update', '--operation-id', operation_id]
        with patch.object(sys, 'argv', argv), patch.dict(sys.modules, {'operation_cli': operation_cli}), \
                patch.object(operation_cli, 'ensure_operation') as admission, \
                patch.object(bridge, 'command_recover_update') as recover, patch.object(bridge, 'emit'):
            bridge.main()
        admission.assert_called_once_with('recover', nora_home=self.root)
        self.assertEqual(recover.call_args.args[0].operation_id, operation_id)

    def test_recovery_id_must_match_held_operation_before_reading_or_changing_transaction(self):
        self.args.operation_id = '91672b04-efb3-4874-b187-94f4230711e2'
        gate = SimpleNamespace(operation_id='8f493c20-d8eb-4466-869c-271bca234402')
        with patch.object(bridge.operation_control, 'require_operation', return_value=gate), \
                patch.object(bridge.nora_system, 'recovery_module') as helper:
            with self.assertRaisesRegex(RuntimeError, '恢复编号'):
                bridge.command_recover_update(self.args)
        helper.assert_not_called()

    def test_missing_programs_only_allow_recovery_after_proven_offline(self):
        with patch.object(bridge, '_recovery_require_native_offline') as offline, \
                patch.object(bridge, 'stop_gateway') as gateway, \
                patch.object(bridge, 'stop_liveware') as liveware, \
                patch.object(bridge, 'command_stop') as normal, patch.object(bridge, 'emit'):
            bridge.recovery_stop(self.args)
        self.assertEqual(offline.call_count, 2)
        gateway.assert_called_once_with(self.root, hermes_home=self.args.hermes_home)
        liveware.assert_called_once_with(self.args.hermes_home)
        normal.assert_not_called()

    def test_unknown_active_runtime_refuses_without_stopping_other_services(self):
        with patch.object(bridge, '_recovery_require_native_offline', side_effect=RuntimeError('unowned listener')), \
                patch.object(bridge, 'stop_gateway') as gateway, patch.object(bridge, 'stop_liveware') as liveware:
            with self.assertRaisesRegex(RuntimeError, 'unowned listener'):
                bridge.recovery_stop(self.args)
        gateway.assert_not_called(); liveware.assert_not_called()

    def test_recovery_stop_phase_is_available_to_the_real_updater_transport(self):
        plan = {'phase': 'recover-stop', 'before': {}, 'noraHome': str(self.root),
                'hermesHome': str(self.args.hermes_home), 'installRoot': str(self.args.install_root)}
        with patch.object(bridge.sys, 'stdin', io.StringIO(json.dumps(plan))), \
                patch.object(bridge, 'recovery_stop') as stop, patch.object(bridge, 'emit'):
            bridge.command_update_lifecycle(self.args)
        stop.assert_called_once_with(self.args)

    def test_recovery_status_does_not_expose_service_plan_or_config_hashes(self):
        journal = self.args.install_root / 'tavern-updates/transaction.json'
        journal.parent.mkdir(parents=True)
        journal.write_text(json.dumps({'schema': 1, 'status': 'prepared', 'backup': 'saved',
                                       'recoveryPlan': {'lifecycle': {'before': 'private'}, 'instanceDigest': 'private'}}))
        with patch.object(bridge.nora_system, 'recovery_module') as module:
            module.return_value.assess.return_value = {'canRecover': False, 'reason': 'incomplete'}
            state = bridge.nora_system.update_recovery(self.args.install_root, self.args.hermes_home)
        self.assertEqual(state, {'status': 'prepared', 'backup': 'saved', 'canRecover': False, 'reason': 'incomplete'})

    @unittest.skipIf(os.name == 'nt', 'file symlink requires Windows developer mode')
    def test_dangling_transaction_link_does_not_clear_the_recovery_guard(self):
        journal = self.args.install_root / 'tavern-updates/transaction.json'
        journal.parent.mkdir(parents=True)
        journal.symlink_to(journal.parent / 'missing-record.json')
        state = bridge.nora_system.update_recovery(self.args.install_root, self.args.hermes_home)
        self.assertIsNotNone(state)
        self.assertFalse(state['canRecover'])

    def test_recovery_verify_does_not_restart_and_rejects_failed_old_health(self):
        before = {'version': '2.3.17', 'systemReady': True, 'running': True, 'gatewayRunning': False}
        plan = {'phase': 'recover-verify', 'before': before, 'noraHome': str(self.root),
                'hermesHome': str(self.args.hermes_home), 'installRoot': str(self.args.install_root)}
        with patch.object(bridge, 'status_payload', return_value=before), \
                patch.object(bridge, 'command_stop') as stop, patch.object(bridge, 'command_start') as start, \
                patch.object(bridge, 'emit'):
            bridge.command_update_lifecycle(self.args, plan)
        stop.assert_not_called(); start.assert_not_called()
        with patch.object(bridge, 'status_payload', return_value={**before, 'running': False}):
            with self.assertRaisesRegex(RuntimeError, '原有服务状态'):
                bridge.recovery_verify(self.args, before)

    def test_missing_controller_never_overwrites_a_port_owned_by_another_program(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0)); listener.listen()
            self.args.port = listener.getsockname()[1]
            with self.assertRaisesRegex(RuntimeError, '端口仍被占用'):
                bridge._recovery_require_native_offline(self.args)
            with socket.create_connection(listener.getsockname(), timeout=1):
                pass  # The unrelated listener remains alive.

    @unittest.skipUnless(NODE, 'requires NORA_TEST_NODE or a local Node executable')
    def test_missing_controller_detects_live_native_process_before_it_listens(self):
        script = self.args.install_root / 'apps/tavern-runtime/engine/sillytavern/server.js'
        script.parent.mkdir(parents=True)
        ready = self.root / 'fixture-ready'
        script.write_text("require('node:fs').writeFileSync(process.argv[2],'ready'); "
                          "process.stdout.write('fixture-ready\\n'); setInterval(() => {}, 1000);", encoding='utf-8')
        child = subprocess.Popen([NODE, str(script), str(ready)], cwd=script.parent,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.fixture_children.append(child)
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready.is_file(), 'The actual child must acknowledge readiness before the deadline')
            self.assertEqual(ready.read_text(), 'ready')
            with self.assertRaisesRegex(RuntimeError, '酒馆进程仍在运行'):
                bridge._recovery_require_native_offline(self.args)
            self.assertIsNone(child.poll())
        finally:
            close_fixture_child(child)


class FixtureChildLifecycleTests(unittest.TestCase):
    def test_missing_false_and_mismatched_receipts_preserve_the_fixture(self):
        for invalid in ('missing', 'false', 'wrong-root', 'duplicate'):
            with self.subTest(receipt=invalid):
                fixture = None
                try:
                    with self.assertRaises(RuntimeError), owned_fixture_directory('nora-pure-receipt-') as fixture:
                        (fixture.root / 'evidence').write_text('retain')
                        fixture.closed = False
                        record = {'schema': 'nora-fixture-closure/1', 'root': str(fixture.root), 'closed': True}
                        if invalid == 'false': record['closed'] = False
                        if invalid == 'wrong-root': record['root'] = str(fixture.root / 'other')
                        output = CLOSURE_PREFIX + json.dumps(record)
                        if invalid == 'missing': output = 'original stderr remains visible'
                        if invalid == 'duplicate': output += '\n' + output
                        require_fixture_closure(fixture, output)
                    self.assertFalse(fixture.closed)
                    self.assertEqual((fixture.root / 'evidence').read_text(), 'retain')
                finally:
                    # These pure cases admitted no actor; remove only their fresh roots.
                    if fixture and fixture.root.exists(): shutil.rmtree(fixture.root)

    def test_closed_receipt_allows_cleanup_after_an_expected_program_failure(self):
        fixture = None
        with self.assertRaisesRegex(ValueError, 'original expected program failure'):
            with owned_fixture_directory('nora-pure-closed-receipt-') as fixture:
                fixture.closed = False
                require_fixture_closure(fixture, CLOSURE_PREFIX + json.dumps({
                    'schema': 'nora-fixture-closure/1', 'root': str(fixture.root), 'closed': True}))
                raise ValueError('original expected program failure')
        self.assertTrue(fixture.closed)
        self.assertFalse(fixture.root.exists())

    def test_term_timeout_requires_kill_and_actual_wait(self):
        from unittest.mock import Mock
        child = Mock(stdin=None, stdout=None, stderr=None)
        child.poll.side_effect = [None, 0]
        child.wait.side_effect = [subprocess.TimeoutExpired('fixture', 2), 0]
        close_fixture_child(child)
        child.terminate.assert_called_once_with(); child.kill.assert_called_once_with()
        self.assertEqual(child.wait.call_count, 2)

    def test_missing_close_remains_a_failure_after_forced_stop(self):
        from unittest.mock import Mock
        child = Mock(stdin=None, stdout=None, stderr=None)
        child.poll.return_value = None
        child.wait.side_effect = subprocess.TimeoutExpired('fixture', 2)
        with self.assertRaises(subprocess.TimeoutExpired):
            close_fixture_child(child)
        child.kill.assert_called_once_with()

    def test_unconfirmed_child_keeps_its_fixture_root(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory(prefix='nora-pure-cleanup-') as temporary:
            root = Path(temporary)
            evidence = root / 'evidence'; evidence.write_text('retain')
            child = Mock(stdin=None, stdout=None, stderr=None)
            child.poll.return_value = None
            child.wait.side_effect = subprocess.TimeoutExpired('fixture', 2)
            fixture = SimpleNamespace(root=root, fixture_children=[child])
            with self.assertRaisesRegex(RuntimeError, 'Retaining fixture'):
                LauncherRecoveryTests.cleanup_fixture(fixture)
            self.assertEqual(evidence.read_text(), 'retain')


if __name__ == '__main__':
    unittest.main()
