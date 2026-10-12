"""Admission checks only; these fixtures never execute MCP or stage sample cards."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml

ENTRY = Path(__file__).with_name('verify_starter_stories.py')
SPEC = importlib.util.spec_from_file_location('manual_sample_acceptance', ENTRY)
MANUAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MANUAL)


class ManualSampleAdmissionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='nora-manual-admission-')
        self.addCleanup(temporary.cleanup)
        self.reserved = Path(temporary.name).resolve() / 'NoraTavern-Tests'
        self.root = self.reserved / 'products-smoke-Ab1234'
        self.home, self.tavern = self.root / 'hermes', self.root / 'tavern'
        self.home.mkdir(parents=True)
        (self.tavern / 'tavern-state').mkdir(parents=True)
        self.command = self.home / 'node/bin/node'
        self.command.parent.mkdir(parents=True)
        self.command.write_text('admission-only executable fixture')
        self.server = self.tavern / 'apps/nora-mcp/dist/server.js'
        self.server.parent.mkdir(parents=True)
        self.server.write_text('admission-only MCP fixture')
        self.instance = {'schema': 1, 'noraHome': str(self.root), 'hermesHome': str(self.home),
                         'installRoot': str(self.tavern), 'port': 18899}
        self.report = {'schema': 'nora-launcher-products-smoke/1', 'outcome': 'passed',
                       'root': str(self.root), 'port': 18899, 'retained': True}
        self.config = {'command': str(self.command), 'args': [str(self.server)], 'env': {
            'NORA_MCP_BASE_URL': 'http://127.0.0.1:18899',
            'NORA_MCP_STATE_ROOT': str(self.tavern / 'tavern-state')}}
        self.environ = {'HERMES_HOME': str(self.home), 'NORA_TAVERN_HOME': str(self.root),
                        'TAVERN_DATA_ROOT': str(self.tavern)}
        self.save()
        reserved = patch.object(MANUAL, 'reserved_directory', return_value=self.reserved)
        reserved.start()
        self.addCleanup(reserved.stop)

    def save(self):
        (self.home / 'nora-instance.json').write_text(json.dumps(self.instance))
        (self.root / 'harness-result.json').write_text(json.dumps(self.report))
        (self.home / 'config.yaml').write_text(yaml.safe_dump({'mcp_servers': {'nora': self.config}}))

    def assert_refused_before_work(self, root=None):
        before = {str(file.relative_to(self.root)): file.read_bytes()
                  for file in self.root.rglob('*') if file.is_file() and not file.is_symlink()}
        with patch.object(MANUAL.subprocess, 'run') as run:
            with self.assertRaises((ValueError, FileNotFoundError)):
                MANUAL.main(['--fixture-root', str(root or self.root)], self.environ)
            run.assert_not_called()
        after = {str(file.relative_to(self.root)): file.read_bytes()
                 for file in self.root.rglob('*') if file.is_file() and not file.is_symlink()}
        self.assertEqual(after, before)

    def test_matching_retained_product_fixture_is_admitted_without_executing_mcp(self):
        with patch.object(MANUAL.subprocess, 'run') as run:
            home, tavern, config = MANUAL.verify_fixture(self.root, self.environ)
            self.assertEqual((home, tavern), (self.home, self.tavern))
            self.assertEqual(config, self.config)
            run.assert_not_called()

    def test_unreserved_product_name_does_not_authorize_a_user_directory(self):
        outside = self.reserved.parent / 'products-smoke-Ab1234'
        outside.mkdir()
        (outside / 'hermes').mkdir()
        (outside / 'tavern').mkdir()
        self.assert_refused_before_work(outside)

    def test_environment_and_instance_roots_cannot_select_another_installation(self):
        for key in self.environ:
            with self.subTest(environment=key):
                original = self.environ[key]
                self.environ[key] = str(self.reserved.parent / 'user-installation')
                self.assert_refused_before_work()
                self.environ[key] = original
        for key in ('noraHome', 'hermesHome', 'installRoot'):
            with self.subTest(instance=key):
                original = self.instance[key]
                self.instance[key] = str(self.reserved.parent / 'user-installation')
                self.save()
                self.assert_refused_before_work()
                self.instance[key] = original

    def test_failed_wrong_root_or_mismatched_port_report_cannot_authorize_import(self):
        for change in ({'outcome': 'failed'}, {'root': str(self.reserved.parent)},
                       {'port': 18999}, {'retained': False}, {'schema': 'old-smoke'}):
            with self.subTest(change=change):
                original = dict(self.report)
                self.report.update(change)
                self.save()
                self.assert_refused_before_work()
                self.report = original

    def test_mcp_remote_port_and_write_root_redirects_are_refused(self):
        for key, value in (('NORA_MCP_BASE_URL', 'https://remote.invalid:18899'),
                           ('NORA_MCP_BASE_URL', 'http://127.0.0.1:18999'),
                           ('NORA_MCP_STATE_ROOT', str(self.reserved.parent / 'user-state')),
                           ('NORA_MCP_UPLOAD_ROOT', str(self.reserved.parent / 'user-imports'))):
            with self.subTest(key=key, value=value):
                original = dict(self.config['env'])
                self.config['env'][key] = value
                self.save()
                self.assert_refused_before_work()
                self.config['env'] = original

    def test_linked_report_and_linked_state_are_refused_without_writes(self):
        for file in (self.root / 'harness-result.json', self.tavern / 'tavern-state'):
            with self.subTest(path=file.name):
                target = file.with_name(file.name + '-original')
                file.rename(target)
                try:
                    file.symlink_to(target, target_is_directory=target.is_dir())
                    self.assert_refused_before_work()
                finally:
                    if file.is_symlink():
                        file.unlink()
                    target.rename(file)

    def test_foreign_executable_and_different_server_are_refused_before_staging(self):
        foreign = self.reserved.parent / 'node'
        foreign.write_text('unrelated fixture')
        for change in ({'command': str(foreign)}, {'args': ['--eval', 'unsafe']}):
            with self.subTest(change=change):
                original = dict(self.config)
                self.config.update(change)
                self.save()
                self.assert_refused_before_work()
                self.config = original


if __name__ == '__main__':
    unittest.main()
