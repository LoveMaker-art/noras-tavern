import json
from pathlib import Path
import tempfile
import unittest

from ops.installer.launcher_bridge import read_verified_model


class VerifiedModelStatusTests(unittest.TestCase):
    def test_requires_matching_marker_key_and_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            hermes = root / "hermes"
            installer = root / "installer"
            hermes.mkdir()
            installer.mkdir()
            (hermes / ".env").write_text("DEEPSEEK_API_KEY=secret\n", encoding="utf-8")
            (hermes / "config.yaml").write_text(
                "model:\n  provider: deepseek\n  default: deepseek-chat\n",
                encoding="utf-8",
            )

            self.assertEqual(read_verified_model(root, hermes), {})
            (installer / "model.json").write_text(json.dumps({
                "schema": 1,
                "provider": "deepseek",
                "model": "deepseek-chat",
                "keyEnv": "DEEPSEEK_API_KEY",
            }), encoding="utf-8")
            self.assertEqual(read_verified_model(root, hermes)["model"], "deepseek-chat")

            (hermes / "config.yaml").write_text(
                "model:\n  provider: deepseek\n  default: another-model\n",
                encoding="utf-8",
            )
            self.assertEqual(read_verified_model(root, hermes), {})

    def test_accepts_matching_custom_endpoint_without_env_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            hermes = root / "hermes"
            installer = root / "installer"
            hermes.mkdir()
            installer.mkdir()
            (hermes / "config.yaml").write_text(
                "model:\n"
                "  provider: custom\n"
                "  default: relay-model\n"
                "  base_url: https://relay.example/v1\n"
                "  api_key: local-secret\n",
                encoding="utf-8",
            )
            (installer / "model.json").write_text(json.dumps({
                "schema": 1,
                "provider": "custom",
                "model": "relay-model",
                "keyEnv": "",
                "baseUrl": "https://relay.example/v1",
            }), encoding="utf-8")

            verified = read_verified_model(root, hermes)
            self.assertEqual(verified["model"], "relay-model")
            self.assertEqual(verified["baseUrl"], "https://relay.example/v1")

            (hermes / "config.yaml").write_text(
                "model:\n"
                "  provider: custom\n"
                "  default: relay-model\n"
                "  base_url: https://another.example/v1\n"
                "  api_key: local-secret\n",
                encoding="utf-8",
            )
            self.assertEqual(read_verified_model(root, hermes), {})


if __name__ == "__main__":
    unittest.main()
