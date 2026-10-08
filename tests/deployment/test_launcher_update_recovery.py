import io
import json
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ops.installer import launcher_bridge as bridge
from ops.installer import operation_cli


class LauncherRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nora-launcher-recovery-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.args = SimpleNamespace(nora_home=self.root, hermes_home=self.root / 'hermes',
                                    install_root=self.root / 'tavern', port=18899,
                                    command='recover-update')

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

    @unittest.skipUnless(os.environ.get('NORA_TEST_NODE') or os.environ.get('TAVERN_NODE_EXECUTABLE') or shutil.which('node'), 'Node fixture requires a real executable')
    def test_missing_controller_detects_live_native_process_before_it_listens(self):
        script = self.args.install_root / 'apps/tavern-runtime/engine/sillytavern/server.js'
        script.parent.mkdir(parents=True)
        script.write_text("process.stdout.write('fixture-ready\\n'); setInterval(() => {}, 1000);", encoding='utf-8')
        node = os.environ.get('NORA_TEST_NODE') or os.environ.get('TAVERN_NODE_EXECUTABLE') or shutil.which('node')
        child = subprocess.Popen([node, str(script)], cwd=script.parent,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'fixture-ready')
            with self.assertRaisesRegex(RuntimeError, '酒馆进程仍在运行'):
                bridge._recovery_require_native_offline(self.args)
            self.assertIsNone(child.poll())
        finally:
            child.terminate(); child.wait(timeout=5)
            child.stdout.close(); child.stderr.close()


if __name__ == '__main__':
    unittest.main()
