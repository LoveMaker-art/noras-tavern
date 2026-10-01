"""Recover the local Node instance only through the explicit start transaction."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
PROCESS_MODULE = ROOT / 'ops/updater/runtime_process.py'
if not PROCESS_MODULE.is_file():
    PROCESS_MODULE = ROOT / 'deployment/shared/runtime_process.py'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class NativeOwnershipRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='nora-owned-node-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.lifecycle = load('native_ownership_lifecycle_test', ROOT / 'app/native_lifecycle.py')
        self.processes = load('native_ownership_process_test', PROCESS_MODULE)
        r = self.runtime = self.lifecycle.NativeRuntime.__new__(self.lifecycle.NativeRuntime)
        r.data_root = root
        r.state_root = root / 'state'
        r.runtime_state = r.state_root / 'native-runtime'
        r.native_data_root = r.state_root / 'native'
        r.engine_root = root / 'engine'
        r.engine_root.mkdir()
        (r.engine_root / 'server.js').write_text('// fixture')
        r.config_path = r.runtime_state / 'config.yaml'
        r.config_path.parent.mkdir(parents=True)
        r.config_path.write_text('fixture configuration')
        r.contract = types.SimpleNamespace(commit='fixture-commit')
        r.source_metadata = mock.Mock(return_value={'commit': r.contract.commit})
        r._children = {}
        r.managed_service = mock.Mock(return_value=None)
        r.operations_module = mock.Mock(return_value=types.SimpleNamespace(
            installation_lock=lambda _root: contextlib.nullcontext()))
        self.node = root / 'node'
        self.node.write_text('fixture executable')
        self.node.chmod(0o755)
        self.environment = mock.patch.dict(os.environ, {'TAVERN_NODE_EXECUTABLE': str(self.node)})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.run = r.run_dir('production')
        self.run.mkdir(parents=True)
        args = [str(self.node), str(r.engine_root / 'server.js'), '--configPath', str(r.config_path),
                '--port', '8799', '--dataRoot', str(r.native_data_root), '--listen', 'false', '--whitelist', 'false']
        self.current = {'pid': 200, 'cwd': str(r.engine_root), 'argv': args,
                        'script': str(r.engine_root / 'server.js')}
        saved = {**self.current, 'pid': 100, 'argv': [str(root / 'bun'), *args[1:]]}
        self.metadata = {'schema': 1, 'run_id': 'production', 'port': 8799,
                         'data_root': str(r.native_data_root), 'native_pid': 100,
                         'started_at': 100, 'contract_commit': r.contract.commit, 'process': saved}
        self.write_metadata()
        self.evidence = {**self.current, 'exe': str(self.node), 'owner': 'fixture-user', 'created_at': 200.5}
        self.operations = types.SimpleNamespace(
            process_record=mock.Mock(side_effect=lambda *_: self.current),
            find_processes=mock.Mock(side_effect=lambda *_: [self.current]),
            same_runtime=self.processes.same_runtime,
            require_listener=mock.Mock(),
            verify_owned_listener=mock.Mock(side_effect=lambda *_: {**self.evidence}),
        )
        r.process_module = mock.Mock(return_value=self.operations)
        r.health = mock.Mock(return_value={'ok': True, 'checks': {'native': True}})
        r.spawn = mock.Mock(side_effect=AssertionError('recovery spawned a duplicate'))

    def write_metadata(self):
        (self.run / 'run.json').write_text(json.dumps(self.metadata, indent=2) + '\n')
        self.original = (self.run / 'run.json').read_bytes()

    def start(self):
        return self.runtime.start('production', 8799)

    def assert_unchanged(self):
        self.assertEqual((self.run / 'run.json').read_bytes(), self.original)
        self.assertFalse((self.run / 'native.pid').exists())
        self.assertEqual(list(self.run.glob('run.json.before-recovery-*.bak')), [])
        self.runtime.spawn.assert_not_called()

    def test_start_recovers_current_node_from_old_bun_record_and_missing_pid(self):
        result = self.start()
        self.assertTrue(result['already_running'])
        self.assertTrue(result['ownership_recovered'])
        self.assertEqual(result['native_pid'], 200)
        updated = json.loads((self.run / 'run.json').read_text())
        self.assertEqual(updated['process'], self.evidence)
        self.assertEqual(updated['started_at'], 200)
        self.assertEqual((self.run / 'native.pid').read_text().strip(), '200')
        backups = list(self.run.glob('run.json.before-recovery-*.bak'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.original)
        self.assertEqual(self.operations.verify_owned_listener.call_count, 2)
        self.runtime.spawn.assert_not_called()
        # Repeating start uses the refreshed ownership without another recovery.
        self.assertTrue(self.start()['already_running'])
        self.assertEqual(len(list(self.run.glob('run.json.before-recovery-*.bak'))), 1)

    def test_status_and_stop_do_not_recover_or_signal_mismatched_ownership(self):
        status = self.runtime.status()
        self.assertFalse(status['health']['ok'])
        self.assertIn('ownership differs', status['inspection_error'])
        with self.assertRaisesRegex(self.lifecycle.NativeLifecycleError, 'ownership differs'):
            self.runtime.stop_run()
        self.assert_unchanged()
        self.operations.verify_owned_listener.assert_not_called()

    def test_recovery_rejects_other_commands_and_installation_metadata(self):
        variants = [
            ('other_node', lambda: self.current['argv'].__setitem__(0, str(self.node.parent / 'other-node'))),
            ('other_script', lambda: self.current['argv'].__setitem__(1, str(self.node.parent / 'other.js'))),
            ('other_data', lambda: self.current['argv'].__setitem__(7, str(self.node.parent / 'other-data'))),
            ('other_port', lambda: self.current['argv'].__setitem__(5, '8800')),
            ('extra_flag', lambda: self.current['argv'].extend(['--port', '8799'])),
            ('other_cwd', lambda: self.current.__setitem__('cwd', str(self.node.parent))),
            ('old_other_config', lambda: self.metadata['process']['argv'].__setitem__(3, 'other-config.yaml')),
            ('old_other_cwd', lambda: self.metadata['process'].__setitem__('cwd', str(self.node.parent))),
            ('other_run', lambda: self.metadata.__setitem__('run_id', 'canary')),
            ('other_metadata_data', lambda: self.metadata.__setitem__('data_root', str(self.node.parent))),
        ]
        original_current = json.loads(json.dumps(self.current))
        original_metadata = json.loads(json.dumps(self.metadata))
        for label, mutate in variants:
            with self.subTest(label=label):
                self.current = json.loads(json.dumps(original_current))
                self.metadata = json.loads(json.dumps(original_metadata))
                mutate()
                self.write_metadata()
                with self.assertRaises(self.lifecycle.NativeLifecycleError):
                    self.start()
                self.assert_unchanged()

    def test_recovery_rejects_multiple_instances(self):
        self.operations.find_processes.side_effect = lambda *_: [self.current, {**self.current, 'pid': 201}]
        with self.assertRaises(self.lifecycle.NativeLifecycleError):
            self.start()
        self.assert_unchanged()

    def test_old_release_receipt_is_recovered_using_the_current_source_contract(self):
        self.metadata['contract_commit'] = 'previous-release'
        self.write_metadata()
        result = self.start()
        self.assertTrue(result['ownership_recovered'])
        self.assertEqual(result['contract_commit'], self.runtime.contract.commit)
        self.runtime.source_metadata.assert_called_once_with()
        self.assertEqual(next(self.run.glob('run.json.before-recovery-*.bak')).read_bytes(), self.original)

    def test_invalid_current_source_contract_cannot_be_recovered(self):
        self.runtime.source_metadata.side_effect = self.lifecycle.NativeLifecycleError('current source contract differs')
        with self.assertRaisesRegex(self.lifecycle.NativeLifecycleError, 'source contract differs'):
            self.start()
        self.assert_unchanged()

    def test_failed_health_owner_or_listener_proof_never_refreshes_record(self):
        for failure in ['health', 'owner_or_listener']:
            with self.subTest(failure=failure):
                self.runtime.health.return_value = {'ok': failure != 'health'}
                self.operations.verify_owned_listener.side_effect = (
                    RuntimeError('unverified owner/listener') if failure == 'owner_or_listener'
                    else lambda *_: {**self.evidence})
                with self.assertRaises(self.lifecycle.NativeLifecycleError):
                    self.start()
                self.assert_unchanged()

    def test_pid_reuse_during_health_check_never_refreshes_record(self):
        self.operations.verify_owned_listener.side_effect = [self.evidence, {**self.evidence, 'created_at': 300.5}]
        with self.assertRaises(self.lifecycle.NativeLifecycleError):
            self.start()
        self.assert_unchanged()

    def test_concurrent_metadata_edit_is_preserved(self):
        def changed(_port):
            self.metadata['note'] = 'concurrent edit'
            self.write_metadata()
            return {'ok': True}
        self.runtime.health.side_effect = changed
        with self.assertRaises(self.lifecycle.NativeLifecycleError):
            self.start()
        self.assert_unchanged()

    def test_absolute_script_is_reused_with_matching_existing_ownership(self):
        self.metadata['process'] = self.current
        self.metadata['native_pid'] = 200
        self.write_metadata()
        self.assertTrue(self.start()['already_running'])
        self.assert_unchanged()

    def test_pinned_node_cannot_fall_back_to_path_or_missing_executable(self):
        with mock.patch.object(self.lifecycle.shutil, 'which', return_value=str(self.node.parent / 'bun')):
            self.assertEqual(self.runtime.node_command(8799, self.runtime.native_data_root)[0], str(self.node))
        with mock.patch.dict(os.environ, {'TAVERN_NODE_EXECUTABLE': str(self.node.parent / 'missing-node')}):
            with self.assertRaises(self.lifecycle.NativeLifecycleError):
                self.runtime.node_command(8799, self.runtime.native_data_root)

    def test_real_node_child_is_reused_and_remains_running(self):
        node = Path(os.environ.get('NORA_TEST_NODE') or shutil.which('node') or '')
        if not node.is_file() or not self.processes.psutil:
            self.skipTest('requires Node and psutil')
        version = subprocess.run([str(node), '--version'], capture_output=True, text=True, timeout=5)
        if not version.stdout.strip().startswith('v'):
            self.skipTest('requires real Node, not a Bun shim')
        r = self.runtime
        server = r.engine_root / 'server.js'
        server.write_text("const http=require('http'); const args=process.argv; "
                          "http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');"
                          "res.end(JSON.stringify({token:'fixture-token'}));})"
                          ".listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');")
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        args = [str(node), str(server), '--configPath', str(r.config_path), '--port', str(port),
                '--dataRoot', str(r.native_data_root), '--listen', 'false', '--whitelist', 'false']
        child = subprocess.Popen(args, cwd=r.engine_root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def cleanup():
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=5)
        self.addCleanup(cleanup)
        self.metadata['port'] = port
        self.metadata['process']['argv'] = [str(self.node.parent / 'bun'), *args[1:]]
        self.write_metadata()
        r.process_module = mock.Mock(return_value=self.processes)
        r.health = types.MethodType(self.lifecycle.NativeRuntime.health, r)
        with mock.patch.dict(os.environ, {'TAVERN_NODE_EXECUTABLE': str(node)}):
            deadline = time.monotonic() + 5
            while not r.health(port)['ok'] and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(r.health(port)['ok'])
            result = r.start('production', port)
            self.assertTrue(result['ownership_recovered'])
            self.assertEqual(result['native_pid'], child.pid)
            self.assertIsNone(child.poll())
            self.assertTrue(r.status()['health']['ok'])
            self.assertTrue(r.start('production', port)['already_running'])
        r.spawn.assert_not_called()

    def test_os_proof_rejects_foreign_owner_executable_listener_and_pid_reuse(self):
        psutil = self.processes.psutil
        if not psutil:
            self.skipTest('requires psutil')
        for failure in ['owner', 'executable', 'listener', 'pid_reuse', 'access_denied', 'prior_instance']:
            with self.subTest(failure=failure):
                candidate = mock.Mock(pid=200)
                candidate.username.return_value = 'fixture-user'
                candidate.uids.return_value = types.SimpleNamespace(real=1000 + (failure == 'owner'))
                candidate.exe.return_value = str(self.node.parent / 'bun' if failure == 'executable' else self.node)
                candidate.create_time.side_effect = [200.5, 300.5] if failure == 'pid_reuse' else None
                candidate.create_time.return_value = 200.5
                candidate.status.return_value = psutil.STATUS_RUNNING
                candidate.net_connections.return_value = [types.SimpleNamespace(
                    status=psutil.CONN_LISTEN, laddr=types.SimpleNamespace(
                        ip='127.0.0.1', port=8800 if failure == 'listener' else 8799))]
                if failure == 'access_denied':
                    candidate.exe.side_effect = psutil.AccessDenied(200)
                process = {**self.current, 'created_at': 100.5} if failure == 'prior_instance' else self.current
                with mock.patch.object(psutil, 'Process', return_value=candidate), \
                     mock.patch.object(self.processes, 'os', types.SimpleNamespace(getuid=lambda: 1000)), \
                     mock.patch.object(self.processes, 'process_record', return_value=self.current):
                    with self.assertRaises(RuntimeError):
                        self.processes.verify_owned_listener(process, self.runtime.engine_root / 'server.js', 8799)

    def test_windows_owner_comparison_uses_the_current_account(self):
        psutil = self.processes.psutil
        if not psutil:
            self.skipTest('requires psutil')
        candidate = mock.Mock(pid=200)
        candidate.exe.return_value = str(self.node)
        candidate.create_time.return_value = 200.5
        candidate.status.return_value = psutil.STATUS_RUNNING
        candidate.net_connections.return_value = [types.SimpleNamespace(
            status=psutil.CONN_LISTEN, laddr=types.SimpleNamespace(ip='127.0.0.1', port=8799))]
        current_account = mock.Mock()
        current_account.username.return_value = 'MACHINE\\User'
        for owner in ['machine\\user', 'MACHINE\\OtherUser']:
            candidate.username.return_value = owner
            with mock.patch.object(psutil, 'Process', side_effect=lambda pid: candidate if pid == 200 else current_account), \
                 mock.patch.object(self.processes, 'os', types.SimpleNamespace(getpid=lambda: 300)), \
                 mock.patch.object(self.processes, 'process_record', return_value=self.current):
                if owner == 'machine\\user':
                    self.assertEqual(self.processes.verify_owned_listener(
                        self.current, self.runtime.engine_root / 'server.js', 8799)['owner'], owner)
                else:
                    with self.assertRaises(RuntimeError):
                        self.processes.verify_owned_listener(self.current, self.runtime.engine_root / 'server.js', 8799)


if __name__ == '__main__':
    unittest.main()
