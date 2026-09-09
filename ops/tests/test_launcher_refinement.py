import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch, Mock

from ops.installer import launcher_bridge as bridge, nora_system as system


class RefinementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.args = SimpleNamespace(nora_home=self.root, hermes_home=self.root / 'hermes',
                                    install_root=self.root / 'tavern', port=18997, service='nora')
        self.args.hermes_home.mkdir()

    def test_stopping_nora_keeps_tavern_and_liveware(self):
        with patch.object(bridge, 'stop_gateway') as gateway, patch.object(bridge, 'stop_liveware') as liveware, \
                patch.object(bridge, 'installed', return_value=False), \
                patch.object(bridge, 'status_payload', return_value={'running': True, 'gatewayRunning': False}), \
                patch.object(bridge, 'emit'):
            bridge.command_stop(self.args)
        gateway.assert_called_once()
        liveware.assert_not_called()

    def test_stopping_tavern_keeps_nora(self):
        self.args.service = 'tavern'
        with patch.object(bridge, 'stop_gateway') as gateway, patch.object(bridge, 'stop_liveware'), \
                patch.object(bridge, 'installed', return_value=False), \
                patch.object(bridge, 'status_payload', return_value={'running': False, 'gatewayRunning': True}), \
                patch.object(bridge, 'emit'):
            bridge.command_stop(self.args)
        gateway.assert_not_called()

    def test_default_greeting_upgrades_and_custom_greeting_survives(self):
        source = Path(__file__).resolve().parents[2]
        greeting = self.args.hermes_home / 'clawchat/greeting.md'
        greeting.parent.mkdir()
        greeting.write_text(system.LEGACY_GREETING, encoding='utf-8')
        system.install_greeting(self.args.hermes_home, source)
        self.assertIn('陈屿的苏州雨巷', greeting.read_text())
        self.assertNotIn('English Greeting', greeting.read_text())
        greeting.write_text('我自己写的开场', encoding='utf-8')
        system.install_greeting(self.args.hermes_home, source)
        self.assertEqual(greeting.read_text(), '我自己写的开场')

    def test_story_staging_is_explicit_and_idempotent(self):
        source = Path(__file__).resolve().parents[1] / 'skills/creative/nora-cardforge'
        spec = importlib.util.spec_from_file_location('starter_story', source / 'scripts/starter-story.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        system.save_json(self.args.hermes_home / 'nora-instance.json', {
            'schema': 1, 'noraHome': str(self.root), 'hermesHome': str(self.args.hermes_home),
            'installRoot': str(self.args.install_root)})
        self.assertFalse(self.args.install_root.exists())
        for story in ('suzhou-rain', 'xiamen-breeze'):
            result = module.stage(self.args.hermes_home, source / 'resources/starter-stories', story, 'request-1')
            self.assertFalse(result['imported'])
            self.assertEqual(result, module.stage(self.args.hermes_home, source / 'resources/starter-stories', story, 'request-1'))
            self.assertTrue(json.loads(Path(result['filePath']).read_text())['data']['scenario'])
        self.assertFalse((self.args.install_root / 'tavern-state/world-core').exists())

    def test_gateway_hook_delegates_no_start_policy_to_shared_worker(self):
        source = Path(__file__).resolve().parents[1] / 'scripts/nora-instance.py'
        spec = importlib.util.spec_from_file_location('refinement_instance', source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        config = {'schema': 1, 'installRoot': str(self.args.install_root), 'port': 18997}
        with patch.object(module, 'configuration', return_value=config), \
             patch.object(module.sys, 'argv', ['nora-instance.py', 'recover-existing']), \
             patch.object(module.subprocess, 'run', return_value=Mock(returncode=0, stdout='{"health":{"ok":false}}')) as run:
            self.assertEqual(module.main(), 0)
        self.assertEqual(run.call_count, 1)
        self.assertIn('--no-start-runtime', run.call_args.args[0])
        self.assertEqual(run.call_args.args[0][-1], 'startup')

    def test_install_does_not_skip_a_newer_pinned_payload(self):
        self.args.release_dir = str(self.root / 'payload')
        system.save_json(Path(self.args.release_dir) / 'release-manifest.json',
                         {'versions': {'tavern': '2.2.10-beta.3'}, 'commit': 'new'})
        with patch.object(bridge.nora_system, 'inspect', return_value={'ready': True}), \
             patch.object(bridge, 'installed', return_value=True), \
             patch.object(bridge, 'read_version', return_value={'version': '2.2.10-beta.2', 'commit': 'old'}), \
             patch.object(bridge, 'gateway_status', return_value={'gatewayRunning': False}), \
             patch.object(bridge, 'status_payload', return_value={'running': False}), \
             patch.object(bridge, 'command_status') as status, \
             patch.object(bridge, 'emit'):
            # Getting as far as the missing bootstrap proves the ready shortcut was not taken.
            with self.assertRaises(SystemExit):
                bridge.command_install(self.args)
        status.assert_not_called()


if __name__ == '__main__':
    unittest.main()
