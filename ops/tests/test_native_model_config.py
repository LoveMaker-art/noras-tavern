"""Only the selected target's configuration can initialize the managed model."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_model_config', Path(__file__).resolve().parents[2] / 'app/native_model_config.py')
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)


class TargetModelTests(unittest.TestCase):
    def test_unconfigured_startup_neither_invents_a_model_nor_touches_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config, settings, marker = root / 'config.yaml', root / 'settings.json', root / 'marker.json'
            config.write_text('{}')
            settings.write_text('{"existing_user_model":"keep"}')
            with patch.object(model, 'NativeSettingsClient') as client:
                result = model.configure(config, settings, marker, 'http://127.0.0.1:1', allow_unconfigured=True)
                client.assert_not_called()
            self.assertEqual(result, {'ok': True, 'changed': False, 'configured': False, 'reason': 'target-model-unconfigured'})
            self.assertEqual(settings.read_text(), '{"existing_user_model":"keep"}')
            self.assertFalse(marker.exists())
            with self.assertRaises(model.NativeModelConfigError):
                model.configure(config, settings, marker, 'http://127.0.0.1:1')

    def test_model_provider_endpoint_and_key_all_come_from_target_file(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.yaml'
            config.write_text(json.dumps({'model': {'provider': 'target', 'default': 'target-model'},
                'providers': {'target': {'api': 'https://target.invalid/v1', 'api_key': 'target-key'},
                              'clawling': {'api': 'https://other.invalid/v1', 'api_key': 'other-key'}}}))
            with patch.dict('os.environ', {'TAVERN_MODEL': 'developer-model', 'DEEPSEEK_API_KEY': 'developer-key'}):
                result = model.load_model_config(config)
            self.assertEqual(result['provider'], 'target')
            self.assertEqual(result['model'], 'target-model')
            self.assertEqual(result['base_url'], 'https://target.invalid/v1')
            self.assertEqual(result['api_key'], 'target-key')
