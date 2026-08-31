"""Manager ownership and restoration guards without changing host services."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import test_full_update
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


if __name__ == '__main__':
    unittest.main()
