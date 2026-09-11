import json
import io
import os
import subprocess
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch, Mock
from ops.installer import launcher_services as services
from ops.installer import launcher_bridge as bridge


class LauncherServicesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.hermes = self.root / 'hermes'
        self.hermes.mkdir()

    def state(self, value):
        (self.hermes / 'gateway_state.json').write_text(json.dumps(value))

    def test_paired_is_not_online(self):
        self.state({'pid': 42, 'platforms': {'clawchat': {'state': 'connected'}}})
        self.assertFalse(services.gateway_status(self.root, self.hermes)['clawchatConnected'])

    def test_connection_requires_current_platform_writer(self):
        process = Mock(pid=42)
        process.create_time.return_value = 1
        value = {'pid': 42, 'start_time': 100, 'platforms': {'clawchat': {
            'state': 'connected', 'writer_pid': 42, 'writer_start_time': 100}}}
        with patch.object(services, 'owned_gateway', return_value=process):
            self.state(value)
            self.assertTrue(services.gateway_status(self.root, self.hermes)['clawchatConnected'])
            value['platforms']['clawchat']['writer_start_time'] = 99
            self.state(value)
            self.assertFalse(services.gateway_status(self.root, self.hermes)['clawchatConnected'])
            value['platforms'] = []
            self.state(value)
            self.assertFalse(services.gateway_status(self.root, self.hermes)['clawchatConnected'])

    def test_pid_reuse_is_not_owned(self):
        import psutil
        directory = self.root / 'installer'
        directory.mkdir()
        actual = psutil.Process(os.getpid())
        record = {'pid': actual.pid, 'created': actual.create_time() - 10, 'command': actual.cmdline()}
        (directory / 'gateway.json').write_text(json.dumps(record))
        self.assertIsNone(services.owned_gateway(self.root))

    def test_connection_does_not_adopt_an_unrelated_writer(self):
        process = Mock(pid=42)
        process.children.return_value = []
        process.cmdline.return_value = ['python', '-m', 'hermes_cli.main', 'gateway', 'run']
        self.state({'pid': 43, 'start_time': 1, 'platforms': {'clawchat': {
            'state': 'connected', 'writer_pid': 43, 'writer_start_time': 1}}})
        with patch.object(services, 'owned_gateway', return_value=process):
            self.assertFalse(services.gateway_status(self.root, self.hermes)['clawchatConnected'])

    def test_framework_python_reexec_keeps_the_same_owned_process(self):
        process = Mock(pid=42)
        process.create_time.return_value = 123
        process.status.return_value = 'sleeping'
        process.cmdline.return_value = ['/Library/Frameworks/Python/Python', '-m', 'hermes_cli.main', 'gateway', 'run']
        record = {'pid': 42, 'created': 123,
                  'command': ['/isolated/venv/bin/python', '-m', 'hermes_cli.main', 'gateway', 'run']}
        with patch.object(services, 'read_json', return_value=record), patch('psutil.Process', return_value=process):
            self.assertIs(services.owned_gateway(self.root), process)
            process.cmdline.return_value = ['/other/python', '-m', 'unrelated']
            self.assertIsNone(services.owned_gateway(self.root))

    def test_python_wrapper_child_can_report_connection_and_is_stopped(self):
        code = '''
import os, sys, subprocess, time, json
from pathlib import Path
if not os.environ.get('NORA_FIXTURE_CHILD'):
    child = subprocess.Popen([sys.executable, '-B', '-c', os.environ['NORA_FIXTURE_CODE'], 'gateway', 'run'],
                             env={**os.environ, 'NORA_FIXTURE_CHILD': '1'})
    child.wait()
else:
    pid = os.getpid()
    Path('gateway_state.json').write_text(json.dumps({'pid': pid, 'start_time': 1,
        'platforms': {'clawchat': {'state': 'connected', 'writer_pid': pid, 'writer_start_time': 1}}}))
    time.sleep(60)
'''
        try:
            status = services.start_gateway(self.root, self.hermes,
                [sys.executable, '-B', '-c', code, 'gateway', 'run'],
                {**os.environ, 'NORA_FIXTURE_CODE': code}, timeout=3)
            self.assertTrue(status['clawchatConnected'])
            self.assertNotEqual(services.read_json(self.hermes / 'gateway_state.json')['pid'],
                                services.read_json(self.root / 'installer/gateway.json')['pid'])
        finally:
            services.stop_gateway(self.root)
        self.assertFalse(services.gateway_status(self.root, self.hermes)['gatewayRunning'])

    def test_stop_never_terminates_foreign_gateway(self):
        self.state({'pid': os.getpid()})
        with patch('psutil.Process.terminate') as terminate:
            services.stop_gateway(self.root)
            terminate.assert_not_called()

    def test_pairing_requires_complete_local_configuration(self):
        (self.hermes / 'config.yaml').write_text('platforms:\n  clawchat:\n    enabled: true\n')
        (self.hermes / '.env').write_text('CLAWCHAT_TOKEN=test\n')
        self.assertFalse(services.clawchat_paired(self.hermes))
        (self.hermes / '.env').write_text('CLAWCHAT_TOKEN=test\nCLAWCHAT_HOME_CHANNEL=home\n')
        self.assertTrue(services.clawchat_paired(self.hermes))
        (self.hermes / 'config.yaml').write_text('platforms: [broken')
        self.assertFalse(services.clawchat_paired(self.hermes))

    def test_rejects_paths_outside_isolated_root(self):
        bridge.require_descendant(self.root, self.hermes, 'Hermes')
        for target in [self.root, self.root.parent / 'other']:
            with self.assertRaises(RuntimeError):
                bridge.require_descendant(self.root, target, 'Hermes')

    def test_pairing_syncs_nora_profile_before_completion(self):
        args = Mock(nora_home=self.root, hermes_home=self.hermes,
                    install_root=self.root / 'tavern', port=18999)
        with patch.object(bridge.sys, 'stdin', io.StringIO('{"code":"test-only"}')), \
             patch.object(bridge, 'hermes_command', return_value='hermes'), \
             patch.object(bridge, 'require_bundled_clawchat'), \
             patch.object(bridge, 'run_stream'), \
             patch.object(bridge.subprocess, 'run', return_value=Mock(returncode=0)), \
             patch.object(bridge, 'clawchat_paired', return_value=True), \
             patch.object(bridge, 'stop_gateway'), \
             patch.object(bridge, 'command_status'), \
             patch.object(bridge, 'sync_nora_profile', create=True) as sync, \
             patch.object(bridge, 'emit') as emit:
            def on_emit(event, **payload):
                if event == 'milestone' and payload.get('state') == 'done':
                    sync.assert_called_once_with(args)
            emit.side_effect = on_emit
            bridge.command_pair(args)
            sync.assert_called_once_with(args)

    def test_launcher_pairing_type_is_scoped_to_activation_process(self):
        plugin = self.hermes / 'plugins/clawchat'
        package = plugin / 'clawchat_gateway'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('')
        client = package / 'api_client.py'
        original = 'AGENTS_CONNECT_PLATFORM = "hermes"\nAGENTS_CONNECT_TYPE = "clawbot"\n'
        client.write_text(original)
        cli = plugin / 'clawchat_cli.py'
        cli.write_text(
            'import json, sys\nfrom pathlib import Path\n'
            'sys.path.insert(0, str(Path(__file__).parent))\n'
            'from clawchat_gateway import api_client\n'
            'print(json.dumps({"platform": api_client.AGENTS_CONNECT_PLATFORM, '
            '"type": api_client.AGENTS_CONNECT_TYPE, "args": sys.argv[1:]}))\n'
        )
        args = Mock(nora_home=self.root, hermes_home=self.hermes,
                    install_root=self.root / 'tavern', port=18999)
        run_child = subprocess.run
        for paired in (False, True):
            with self.subTest(paired=paired):
                def activate(command, **kwargs):
                    self.assertNotIn('test-only-code', ' '.join(command))
                    result = run_child(command, **kwargs)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    payload = json.loads(result.stdout)
                    self.assertEqual(payload['platform'], 'hermes')
                    self.assertEqual(payload['type'], 'nora-tavern')
                    self.assertEqual(payload['args'], ['activate', 'test-only-code', '--no-restart']
                                     + (['--repair'] if paired else []))
                    return result

                with patch.object(bridge.sys, 'stdin', io.StringIO('{"code":"test-only-code"}')), \
                     patch.object(bridge, 'hermes_command', return_value='hermes'), \
                     patch.object(bridge, 'python_command', return_value=sys.executable), \
                     patch.object(bridge, 'require_bundled_clawchat'), \
                     patch.object(bridge, 'run_stream'), \
                     patch.object(bridge.subprocess, 'run', side_effect=activate), \
                     patch.object(bridge, 'clawchat_paired', side_effect=[paired, True]), \
                     patch.object(bridge, 'stop_gateway'), \
                     patch.object(bridge, 'command_status'), \
                     patch.object(bridge, 'sync_nora_profile'), patch.object(bridge, 'emit'):
                    bridge.command_pair(args)
                self.assertEqual(client.read_text(), original)

        ordinary = run_child([sys.executable, '-B', str(cli), 'activate', 'test-only-code'],
                             capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(ordinary.stdout)['platform'], 'hermes')
        self.assertEqual(json.loads(ordinary.stdout)['type'], 'clawbot')

    def test_failed_start_never_emits_completion(self):
        args = Mock(nora_home=self.root, hermes_home=self.hermes, install_root=self.root / 'tavern', port=8799, service='nora')
        with patch.object(bridge, 'installed', return_value=True), \
             patch.object(bridge.nora_system, 'inspect', return_value={'ready': True}), \
             patch.object(bridge, 'read_verified_model', return_value={'model': 'test'}), \
             patch.object(bridge, 'clawchat_paired', return_value=True), \
             patch.object(bridge, 'sync_nora_profile'), \
             patch.object(bridge, 'require_bundled_clawchat'), \
             patch.object(bridge, 'run_json', return_value={'ok': True}), \
             patch.object(bridge, 'start_gateway', side_effect=RuntimeError('offline')), \
             patch.object(bridge, 'emit') as emit:
            with self.assertRaisesRegex(RuntimeError, 'offline'):
                bridge.command_start(args)
            self.assertFalse(any(call.kwargs.get('state') == 'done' for call in emit.call_args_list))

    def test_profile_failure_prevents_gateway_start_and_completion(self):
        args = Mock(nora_home=self.root, hermes_home=self.hermes, install_root=self.root / 'tavern', port=18999)
        with patch.object(bridge, 'installed', return_value=True), \
             patch.object(bridge.nora_system, 'inspect', return_value={'ready': True}), \
             patch.object(bridge, 'read_verified_model', return_value={'model': 'test'}), \
             patch.object(bridge, 'clawchat_paired', return_value=True), \
             patch.object(bridge, 'sync_nora_profile', side_effect=RuntimeError('profile not saved')) as sync, \
             patch.object(bridge, 'start_gateway') as start, \
             patch.object(bridge, 'emit') as emit:
            with self.assertRaisesRegex(RuntimeError, 'profile not saved'):
                bridge.command_start(args)
            sync.assert_called_once_with(args)
            start.assert_not_called()
            self.assertFalse(any(call.kwargs.get('state') == 'done' for call in emit.call_args_list))

    def test_owned_process_starts_reports_online_and_stops(self):
        code = (
            'import os,json,time;from pathlib import Path;p=os.getpid();'
            'Path("gateway_state.json").write_text(json.dumps({"pid":p,"start_time":1,'
            '"platforms":{"clawchat":{"state":"connected","writer_pid":p,"writer_start_time":1}}}));'
            'time.sleep(60)'
        )
        try:
            status = services.start_gateway(self.root, self.hermes,
                [sys.executable, '-B', '-c', code, 'gateway', 'run'], os.environ.copy(), timeout=5)
            self.assertTrue(status['gatewayRunning'])
            self.assertTrue(status['clawchatConnected'])
        except Exception:
            # This fixture never uses credentials; retain the evidence before cleanup.
            import psutil
            record = services.read_json(self.root / 'installer/gateway.json')
            print('Fixture gateway record:', record)
            if record and psutil.pid_exists(record['pid']):
                process = psutil.Process(record['pid'])
                print('Fixture process:', process.as_dict(attrs=['pid', 'create_time', 'status', 'cmdline']))
            print('Fixture state:', services.read_json(self.hermes / 'gateway_state.json'))
            log = self.root / 'installer/gateway.log'
            print('Fixture output:', log.read_text() if log.exists() else 'no log')
            raise
        finally:
            services.stop_gateway(self.root)
        self.assertFalse(services.gateway_status(self.root, self.hermes)['gatewayRunning'])


if __name__ == '__main__':
    unittest.main()
