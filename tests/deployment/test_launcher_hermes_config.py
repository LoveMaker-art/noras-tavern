"""Opt-in contract check against an installed Hermes, with a throwaway home."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

if __package__:
    from .launcher_test_environment import resolve_node
    from .test_launcher_update_recovery import owned_fixture_directory, require_fixture_closure
else:
    from launcher_test_environment import resolve_node
    from test_launcher_update_recovery import owned_fixture_directory, require_fixture_closure


@unittest.skipUnless(os.environ.get('NORA_TEST_HERMES'), 'Set NORA_TEST_HERMES to read-only Hermes source')
class HermesConfigContractTests(unittest.TestCase):
    def test_custom_configuration_uses_real_hermes_api(self):
        with owned_fixture_directory(prefix='nora-config-contract-') as fixture:
            root = fixture.root
            home = root / 'hermes'
            home.mkdir()
            (root / 'installer').mkdir()
            (home / 'hermes-agent').symlink_to(Path(os.environ['NORA_TEST_HERMES']), target_is_directory=True)
            env = {**os.environ, 'HERMES_HOME': str(home), 'HOME': str(home), 'USERPROFILE': str(home),
                   'NORA_TAVERN_HOME': str(root), 'TAVERN_DATA_ROOT': str(root / 'tavern'),
                   'NORA_TEST_MANAGED_PYTHON_ROOT': sys.base_prefix, 'NORA_TEST_VENV_HOME': sys.prefix,
                   'PYTHONNOUSERSITE': '1', 'XDG_CACHE_HOME': str(root / 'cache')}
            helper = Path(__file__).resolve().parents[1] / 'installer/model_config.py'
            fixture.closed = False
            result = subprocess.run([resolve_node(required=True), str(Path(__file__).with_name('launcher_owned_test_actor.cjs')),
                                    str(helper.parent / 'desktop/operation-lock.js'), str(root), sys.executable, str(helper)],
                                    env=env, capture_output=True, text=True, timeout=60,
                                    input=json.dumps({'action': 'save', 'provider': 'custom', 'keyEnv': '',
                                                      'key': 'test-only-not-valid', 'model': 'contract-model',
                                                      'baseUrl': 'https://relay.example/v1'}))
            require_fixture_closure(fixture, result.stderr)
            self.assertEqual(result.returncode, 0, (result.stdout + result.stderr).replace('test-only-not-valid', '<redacted>'))
            self.assertTrue(json.loads(result.stdout.splitlines()[-1])['ok'])
            import yaml
            config = yaml.safe_load((home / 'config.yaml').read_text())
            self.assertEqual(config['model']['provider'], 'custom:nora-launcher')
            self.assertEqual(config['model']['default'], 'contract-model')
            self.assertEqual(config['model']['base_url'], 'https://relay.example/v1')
            self.assertEqual(config['model']['api_key'], 'test-only-not-valid')


if __name__ == '__main__':
    unittest.main()
