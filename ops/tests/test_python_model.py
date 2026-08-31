import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'updater'))
from python_model import load_python_model


class PythonModelTests(unittest.TestCase):
    def test_original_provider_is_not_hermes_primary_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / 'config.yaml').write_text(json.dumps({'providers': {'clawling': {'api': 'https://old.invalid/v1', 'api_key': 'test-old'},
                'other': {'api': 'https://other.invalid/v1', 'api_key': 'test-other'}}, 'model': {'provider': 'other', 'default': 'other-model'}}))
            config = load_python_model(home, {})
            self.assertEqual(config['api_key'], 'test-old')
            self.assertEqual(config['model'], 'deepseek-v4-flash')
            self.assertEqual(load_python_model(home, {'TAVERN_MODEL': 'selected'})['model'], 'selected')

    def test_no_credentials_does_not_search_other_user_homes(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(load_python_model(directory, {}))
