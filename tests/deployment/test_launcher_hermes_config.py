"""Opt-in contract check against an installed Hermes, with a throwaway home."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(os.environ.get('NORA_TEST_HERMES'), 'Set NORA_TEST_HERMES to read-only Hermes source')
class HermesConfigContractTests(unittest.TestCase):
    def test_custom_configuration_uses_real_hermes_api(self):
        with tempfile.TemporaryDirectory(prefix='nora-config-contract-') as temporary:
            root = Path(temporary)
            home = root / 'hermes'
            home.mkdir()
            (home / 'hermes-agent').symlink_to(Path(os.environ['NORA_TEST_HERMES']), target_is_directory=True)
            env = {**os.environ, 'HERMES_HOME': str(home), 'HOME': str(home), 'USERPROFILE': str(home),
                   'PYTHONNOUSERSITE': '1', 'XDG_CACHE_HOME': str(root / 'cache')}
            helper = Path(__file__).resolve().parents[1] / 'installer/model_config.py'
            result = subprocess.run([sys.executable, '-B', str(helper)], env=env, capture_output=True, text=True, timeout=60,
                                    input=json.dumps({'action': 'save', 'provider': 'custom', 'keyEnv': '',
                                                      'key': 'test-only-not-valid', 'model': 'contract-model',
                                                      'baseUrl': 'https://relay.example/v1'}))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(json.loads(result.stdout.splitlines()[-1])['ok'])
            import yaml
            config = yaml.safe_load((home / 'config.yaml').read_text())
            self.assertEqual(config['model']['provider'], 'custom')
            self.assertEqual(config['model']['default'], 'contract-model')
            self.assertEqual(config['model']['base_url'], 'https://relay.example/v1')
            self.assertEqual(config['model']['api_key'], 'test-only-not-valid')


if __name__ == '__main__':
    unittest.main()
