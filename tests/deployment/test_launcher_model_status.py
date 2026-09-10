import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from ops.installer.launcher_bridge import read_verified_model


class VerifiedModelStatusTests(unittest.TestCase):
    def test_named_custom_mismatches_still_fail_without_exposing_values(self):
        import yaml
        for field, replacement in (("provider", "custom:other"), ("default", "wrong-model"),
                                   ("base_url", "http://127.0.0.1:9000/v1"), ("api_key", "")):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                hermes = root / "hermes"
                hermes.mkdir()
                (root / "installer").mkdir()
                config = {"provider": "custom:local", "default": "local-model", "base_url": "http://127.0.0.1:8080/v1", "api_key": "fixture-secret-only"}
                (root / "installer/model.json").write_text(json.dumps({"schema": 1,
                    "provider": config["provider"], "model": config["default"], "baseUrl": config["base_url"], "keyEnv": ""}), encoding="utf-8")
                config[field] = replacement
                (hermes / "config.yaml").write_text(yaml.safe_dump({"model": config}), encoding="utf-8")
                problems = []
                self.assertEqual(read_verified_model(root, hermes, problems), {})
                self.assertTrue(problems)
                self.assertNotIn("fixture-secret-only", str(problems))

    def test_arbitrary_custom_prefix_is_not_treated_as_custom_provider(self):
        for provider in ("custom-invalid", "customized", "custom:"):
            with self.subTest(provider=provider), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "hermes").mkdir()
                (root / "installer").mkdir()
                (root / "installer/model.json").write_text(json.dumps({"schema": 1, "provider": provider,
                    "model": "fixture", "baseUrl": "http://127.0.0.1/v1", "keyEnv": ""}), encoding="utf-8")
                (root / "hermes/config.yaml").write_text(json.dumps({"model": {"provider": provider,
                    "default": "fixture", "base_url": "http://127.0.0.1/v1", "api_key": "fixture"}}), encoding="utf-8")
                self.assertEqual(read_verified_model(root, root / "hermes"), {})

    @unittest.skipUnless(os.environ.get("NORA_TEST_HERMES"), "requires a clean Hermes runtime")
    def test_real_hermes_custom_save_passes_bridge_recheck(self):
        with tempfile.TemporaryDirectory(prefix="nora-custom-save-") as temporary:
            root = Path(temporary)
            hermes = root / "hermes"
            hermes.mkdir()
            (root / "installer").mkdir()
            (hermes / "hermes-agent").symlink_to(os.environ["NORA_TEST_HERMES"], target_is_directory=True)
            env = {**os.environ, "HERMES_HOME": str(hermes), "HOME": str(hermes), "USERPROFILE": str(hermes),
                   "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}
            script = Path(__file__).resolve().parents[1] / "installer/model_config.py"
            result = subprocess.run([sys.executable, "-B", str(script)], env=env, capture_output=True, text=True,
                input=json.dumps({"action": "save", "provider": "custom", "model": "local-fixture-model.gguf",
                                  "keyEnv": "", "key": "fixture-only", "baseUrl": "http://127.0.0.1:8080/v1"}), timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr.replace("fixture-only", "<redacted>"))
            saved = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertTrue(saved["provider"] == "custom" or saved["provider"].startswith("custom:"))
            (root / "installer/model.json").write_text(json.dumps({"schema": 1, **saved}), encoding="utf-8")
            self.assertEqual(read_verified_model(root, hermes)["provider"], saved["provider"])
            bridge = script.with_name("launcher_bridge.py")
            verification = subprocess.run([sys.executable, "-B", str(bridge), "--nora-home", str(root),
                "--hermes-home", str(hermes), "--install-root", str(root / "tavern"), "--port", "18999", "verify-model"],
                env=env, text=True, capture_output=True, timeout=60)
            self.assertEqual(verification.returncode, 0)
            self.assertTrue(json.loads(verification.stdout.strip().splitlines()[-1])["ok"])
            self.assertNotIn("fixture-only", verification.stdout)

    def test_named_custom_provider_is_verified_without_an_env_key(self):
        for provider in ("custom", "custom:local-(127.0.0.1:8080)", "custom:my-relay"):
            with self.subTest(provider=provider), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                hermes = root / "hermes"
                hermes.mkdir()
                (root / "installer").mkdir()
                marker = {"schema": 1, "provider": provider, "model": "local-model.gguf",
                          "keyEnv": "", "baseUrl": "http://127.0.0.1:8080/v1/"}
                (root / "installer/model.json").write_text(json.dumps(marker), encoding="utf-8")
                (hermes / "config.yaml").write_text(
                    f"model:\n  provider: {provider}\n  default: local-model.gguf\n"
                    "  base_url: http://127.0.0.1:8080/v1\n  api_key: fixture-only\n", encoding="utf-8")
                self.assertEqual(read_verified_model(root, hermes).get("provider"), provider)

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
