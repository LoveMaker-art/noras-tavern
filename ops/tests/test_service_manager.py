"""Manager ownership and restoration guards without changing host services."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import test_full_update
from update import module_at
from service_manager import ManagedService, digest


class ServiceManagerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='tavern-service-test-')
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name).resolve()
        self.app = self.home / 'apps/tavern-runtime'
        self.file = self.home / '.clawling/supervisord/tavern.conf'
        self.file.parent.mkdir(parents=True)
        self.file.write_text('[program:tavern-runtime]\ncommand=python3 server.py --port 8799\n'
                             + f'directory={self.app}\nautorestart=true\nenvironment=PRIVATE="retained"\n')
        self.main = self.home / 'supervisord.conf'
        self.main.write_text('[include]\nfiles=' + str(self.file) + '\n[unix_http_server]\nfile=/tmp/test.sock\n')
        self.rpc = Mock()
        self.rpc.getProcessInfo.return_value = {'name': 'tavern-runtime', 'pid': 123, 'statename': 'Running'}
        self.rpc.getAllProcessInfo.return_value = [
            {'name': 'tavern-runtime', 'pid': 123}, {'name': 'hermes', 'pid': 14}, {'name': 'liveware', 'pid': 15}]
        proxy = patch('service_manager.xmlrpc.client.ServerProxy', return_value=Mock(supervisor=self.rpc))
        proxy.start(); self.addCleanup(proxy.stop)
        version = patch('service_manager.subprocess.check_output', return_value='Version: v0.7.4-clawnest.1')
        version.start(); self.addCleanup(version.stop)

    def discover(self):
        return ManagedService.discover(self.home, self.app, manager_config=self.main, binary='/test/supervisord')

    def test_exact_program_ownership_and_private_configuration_roundtrip(self):
        service = self.discover()
        saved = service.snapshot()
        node = service.node_text(['/usr/local/bin/node', 'server.js'], self.app / 'engine/sillytavern')
        self.assertIn('PRIVATE="retained"', node)
        service.install_text(node, accepted_hash=saved['descriptor']['sha256'])
        self.assertIn('node server.js', self.file.read_text())
        service.install_text(saved['text'], accepted_hash=digest(node.encode()), mode=saved['mode'])
        self.assertEqual(self.file.read_text(), saved['text'])
        self.assertEqual(self.rpc.reloadConfig.call_count, 2)
        self.rpc.stopAllProcesses.assert_not_called()

    def test_wrong_script_is_not_owned(self):
        self.file.write_text(self.file.read_text().replace('server.py', 'another.py'))
        self.assertIsNone(self.discover())

    def test_script_name_in_inline_python_arguments_is_not_owned(self):
        self.file.write_text(self.file.read_text().replace('python3 server.py --port 8799',
            'python3 -c "import time; time.sleep(60)" server.py'))
        self.assertIsNone(self.discover())

    def test_other_configuration_change_blocks_reload(self):
        service = self.discover()
        saved = service.snapshot()
        self.main.write_text(self.main.read_text() + '\n# another operator changed this\n')
        with self.assertRaisesRegex(ValueError, 'Another manager'):
            service.install_text(saved['text'], accepted_hash=saved['descriptor']['sha256'])
        self.rpc.reloadConfig.assert_not_called()

    def test_concurrent_service_edit_is_not_overwritten(self):
        service = self.discover()
        saved = service.snapshot()
        self.file.write_text(self.file.read_text() + '\n# custom edit\n')
        with self.assertRaisesRegex(ValueError, 'outside this update'):
            service.install_text(saved['text'], accepted_hash=saved['descriptor']['sha256'])

    def test_stop_uses_named_manager_api(self):
        service = self.discover()
        self.rpc.getProcessInfo.side_effect = [
            {'name': service.name, 'pid': 123, 'statename': 'Running'},
            {'name': service.name, 'pid': 0, 'statename': 'Stopped'}]
        service.stop()
        self.rpc.stopProcess.assert_called_once_with('tavern-runtime', True)

    def test_start_waits_for_an_existing_start_instead_of_starting_twice(self):
        service = self.discover()
        self.rpc.getProcessInfo.side_effect = [
            {'name': service.name, 'pid': 0, 'statename': 'Starting'},
            {'name': service.name, 'pid': 123, 'statename': 'Running'}]
        self.assertEqual(service.start(), 123)
        self.rpc.startProcess.assert_not_called()

    def test_native_start_does_not_stop_a_managed_process_during_warmup(self):
        module = module_at('managed_native_test', test_full_update.OPS.parent / 'app/native_lifecycle.py')
        from types import SimpleNamespace
        runtime = module.NativeRuntime(self.home, self.app, self.home / 'state',
            SimpleNamespace(source_dir='engine/sillytavern', commit='a' * 40))
        service = Mock(name='service')
        service.name = 'tavern-runtime'
        service.pid.return_value = 123
        service.start.return_value = 123
        import shlex
        service.descriptor = {'command': shlex.join(runtime.node_command(54321, runtime.native_data_root))}
        with patch.object(runtime, 'managed_service', return_value=service), \
             patch.object(runtime, 'verify_install'), patch.object(runtime, 'health', return_value={'ok': False}), \
             patch.object(runtime, 'wait_for_health', return_value={'ok': True}), \
             patch.object(runtime.process_module(), 'process_record', return_value={'pid': 123}), \
             patch.object(runtime.process_module(), 'require_listener'), \
             patch.object(runtime, 'stop_run') as stop, patch.object(runtime, 'spawn') as spawn:
            self.assertTrue(runtime.start(port=54321, assets_prepared=True)['health']['ok'])
        stop.assert_not_called()
        spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
