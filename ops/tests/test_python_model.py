import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'updater'))
from python_model import load_python_model


class PythonModelTests(unittest.TestCase):
    def test_explicit_old_provider_reads_only_target_provider_and_selected_name(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / 'config.yaml').write_text(json.dumps({'providers': {'clawling': {'api': 'https://old.invalid/v1', 'api_key': 'test-old'},
                'other': {'api': 'https://other.invalid/v1', 'api_key': 'test-other'}}, 'model': {'provider': 'other', 'default': 'other-model'}}))
            (home / 'tavern-state').mkdir()
            (home / 'tavern-state/model_configs.json').write_text(json.dumps({'active': 'clawling:user-selected', 'configs': []}))
            config = load_python_model(home)
            self.assertEqual(config['api_key'], 'test-old')
            self.assertEqual(config['model'], 'user-selected')

    def test_builtin_does_not_create_a_second_model_from_old_code_or_operator_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / 'config.yaml').write_text(json.dumps({'providers': {'clawling': {'api': 'https://target.invalid/v1', 'api_key': 'target-key'}},
                'model': {'provider': 'clawling', 'default': 'target-model'}}))
            with patch.dict('os.environ', {'TAVERN_MODEL': 'developer-model', 'TAVERN_MODEL_KEY': 'developer-key', 'TAVERN_MODEL_BASE': 'https://developer.invalid/v1'}):
                self.assertIsNone(load_python_model(home))

    def test_missing_target_provider_cannot_borrow_operator_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / 'tavern-state').mkdir()
            (home / 'tavern-state/model_configs.json').write_text(json.dumps({'active': 'clawling:user-selected'}))
            with patch.dict('os.environ', {'DEEPSEEK_API_KEY': 'developer-key', 'TAVERN_MODEL_BASE': 'https://developer.invalid/v1'}):
                self.assertIsNone(load_python_model(home))

    def test_no_credentials_does_not_search_other_user_homes(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(load_python_model(directory))
