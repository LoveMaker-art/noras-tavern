import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from ops.installer.hermes_model_state import public_model_state, read_verified_model


class HermesModelStateTests(unittest.TestCase):
    def test_legacy_inline_custom_current_is_not_mistaken_for_a_changed_connection(self):
        for provider in ('custom', 'custom:legacy'):
            with self.subTest(provider=provider), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                key = 'legacy-synthetic-key'
                home = self.fixture(root, {'provider': provider, 'default': 'legacy-model',
                    'base_url': 'https://legacy.invalid/v1', 'api_key': key},
                    {'provider': provider, 'model': 'legacy-model', 'baseUrl': 'https://legacy.invalid/v1',
                     'authMode': 'key', 'validation': 'api-response',
                     'credentialSha256': hashlib.sha256(key.encode()).hexdigest()})
                before = {file: file.read_bytes() for file in root.rglob('*') if file.is_file()}
                state = public_model_state(root, home)
                self.assertTrue(read_verified_model(root, home))
                self.assertTrue(state['models'][0]['available'], state['models'][0])
                self.assertTrue(state['models'][0]['selected'])
                self.assertNotIn(key, json.dumps(state))
                self.assertEqual({file: file.read_bytes() for file in before}, before)

    def fixture(self, root, model, marker=None, env=""):
        home = root / "hermes"
        home.mkdir()
        (home / "config.yaml").write_text(json.dumps({"model": model}), encoding="utf-8")
        (home / ".env").write_text(env, encoding="utf-8")
        if marker is not None:
            (root / "installer").mkdir()
            (root / "installer/model.json").write_text(json.dumps({"schema": 1, **marker}), encoding="utf-8")
        return home

    def test_current_selection_is_not_limited_to_launcher_catalog_or_a_marker(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.fixture(root, {"provider": "opencode-go", "default": "glm-5"},
                                {"provider": "deepseek", "model": "old-model", "validation": "api-response"})
            state = public_model_state(root, home)
            self.assertTrue(state["configured"])
            self.assertEqual((state["provider"], state["model"]), ("opencode-go", "glm-5"))
            self.assertEqual(state["validation"], "unverified")
            self.assertEqual(state["validationStatus"], "stale")
            self.assertFalse(read_verified_model(root, home))

    def test_native_oauth_cloud_and_external_checkpoints_do_not_require_an_api_key(self):
        for provider, auth_mode in (("openai-codex", "oauth_external"), ("bedrock", "aws_sdk"),
                                    ("copilot-acp", "external_process"), ("new-native-provider", "native")):
            with self.subTest(provider=provider), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                home = self.fixture(root, {"provider": provider, "default": "native-model"},
                    {"provider": provider, "model": "native-model", "authMode": auth_mode,
                     "validation": "api-response"})
                self.assertEqual(read_verified_model(root, home)["provider"], provider)
                state = public_model_state(root, home)
                self.assertTrue(state["configured"])
                self.assertEqual(state["credentialStatus"], "unknown")
                self.assertEqual(state["authMode"], "unknown")
                self.assertEqual(state["validationAuthMode"], auth_mode)
                self.assertEqual(state["validation"], "api-response")
                self.assertEqual(state["activation"], "next-session")

    def test_native_requires_real_validation_not_just_a_saved_record(self):
        for validation in (None, "configuration-only"):
            with self.subTest(validation=validation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                record = {"provider": "openai-codex", "model": "native-model", "authMode": "native"}
                if validation:
                    record["validation"] = validation
                home = self.fixture(root, {"provider": "openai-codex", "default": "native-model"}, record)
                self.assertTrue(public_model_state(root, home)["configured"])
                self.assertFalse(read_verified_model(root, home))
                self.assertNotEqual(public_model_state(root, home)["validation"], "api-response")

    def test_native_key_reference_rechecks_the_actual_credential(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.fixture(root, {"provider": "custom:relay", "default": "native-model",
                    "api_key": "${env:RELAY_KEY}", "base_url": "https://relay.example/v1"},
                {"provider": "custom:relay", "model": "native-model", "authMode": "native",
                 "validation": "api-response", "baseUrl": "https://relay.example/v1",
                 "credentialSha256": hashlib.sha256(b"fixture-secret").hexdigest()},
                "RELAY_KEY=fixture-secret\n")
            self.assertTrue(read_verified_model(root, home))
            (home / ".env").write_text("RELAY_KEY=changed-secret\n", encoding="utf-8")
            problems = []
            self.assertFalse(read_verified_model(root, home, problems))
            self.assertIn("密钥已更改", str(problems))
            self.assertNotIn("changed-secret", str(problems))

    def test_legacy_key_marker_still_requires_its_env_credential(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.fixture(root, {"provider": "deepseek", "default": "deepseek-chat",
                                      "api_key": "other-inline-secret"},
                {"provider": "deepseek", "model": "deepseek-chat", "keyEnv": "DEEPSEEK_API_KEY"})
            self.assertFalse(read_verified_model(root, home))

    def test_public_endpoint_and_status_do_not_expose_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.fixture(root, {"provider": "custom:relay", "default": "relay-model",
                "base_url": "https://user:password@relay.example/v1?token=query-secret#fragment-secret",
                "api_key": "key-secret"})
            state = public_model_state(root, home)
            self.assertEqual(state["baseUrl"], "https://relay.example/v1")
            encoded = json.dumps(state)
            for secret in ("user", "password", "query-secret", "fragment-secret", "key-secret"):
                self.assertNotIn(secret, encoded)

    def test_named_route_replaces_stale_snapshot_in_overview_list_and_checkpoint(self):
        for field in ("api", "url", "base_url"):
            for legacy in (False, True):
                with self.subTest(field=field, legacy=legacy), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    old = "https://old.example/v1"
                    current = "https://current.example/v1"
                    home = self.fixture(root, {"provider": "custom:relay", "default": "model",
                        "base_url": old, "api_key": "old-secret"},
                        {"provider": "custom:relay", "model": "model", "baseUrl": old,
                         "authMode": "key", "validation": "api-response",
                         "credentialSha256": hashlib.sha256(b"old-secret").hexdigest()})
                    config = json.loads((home / "config.yaml").read_text())
                    route = {"name": "Relay", field: current, "api_key": "current-secret"}
                    config.update({"custom_providers": [route]} if legacy else {"providers": {"custom:relay": route}})
                    (home / "config.yaml").write_text(json.dumps(config))
                    before = {p.name: p.read_bytes() for p in home.iterdir()}
                    result = public_model_state(root, home)
                    self.assertEqual(result["baseUrl"], current)
                    self.assertEqual([row["baseUrl"] for row in result["models"]], [current])
                    self.assertEqual(result["validationStatus"], "stale")
                    self.assertFalse(read_verified_model(root, home))
                    self.assertEqual({p.name: p.read_bytes() for p in home.iterdir()}, before)
                    self.assertNotIn("current-secret", json.dumps(result))

    def test_named_route_credential_reference_wins_over_stale_inline_key(self):
        for inline in (True, False):
            with self.subTest(inline=inline), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                endpoint = "https://relay.example/v1"
                home = self.fixture(root, {"provider": "custom:relay", "default": "model",
                    "base_url": endpoint, "api_key": "old-secret"},
                    {"provider": "custom:relay", "model": "model", "baseUrl": endpoint,
                     "authMode": "key", "validation": "api-response",
                     "credentialSha256": hashlib.sha256(b"old-secret").hexdigest()},
                    "RELAY_KEY=current-secret\n")
                config = json.loads((home / "config.yaml").read_text())
                route = {"base_url": endpoint, **({"api_key": "current-secret"} if inline else {"key_env": "RELAY_KEY"})}
                config["providers"] = {"custom:relay": route}
                (home / "config.yaml").write_text(json.dumps(config))
                self.assertFalse(read_verified_model(root, home))
                marker = root / "installer/model.json"
                proof = json.loads(marker.read_text())
                proof["credentialSha256"] = hashlib.sha256(b"current-secret").hexdigest()
                marker.write_text(json.dumps(proof))
                self.assertTrue(read_verified_model(root, home))
                self.assertNotIn("current-secret", json.dumps(public_model_state(root, home)))

    def test_named_route_can_validate_without_a_legacy_model_inline_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            endpoint = "https://relay.example/v1"
            home = self.fixture(root, {"provider": "custom:relay", "default": "model"},
                {"provider": "custom:relay", "model": "model", "baseUrl": endpoint,
                 "authMode": "key", "validation": "api-response",
                 "credentialSha256": hashlib.sha256(b"route-secret").hexdigest()})
            config = json.loads((home / "config.yaml").read_text())
            config["providers"] = {"custom:relay": {"base_url": endpoint, "api_key": "route-secret"}}
            (home / "config.yaml").write_text(json.dumps(config))
            self.assertTrue(read_verified_model(root, home))

    def test_saved_connection_proof_expires_when_native_headers_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            endpoint = "https://relay.example/v1"
            home = self.fixture(root, {"provider": "custom:relay", "default": "model"},
                {"provider": "custom:relay", "model": "model", "baseUrl": endpoint,
                 "authMode": "key", "validation": "api-response"})
            config = json.loads((home / "config.yaml").read_text())
            config["providers"] = {"custom:relay": {"base_url": endpoint, "api_key": "route-secret",
                                                    "extra_headers": {"X-Route": "old-route"}}}
            file = home / "config.yaml"
            file.write_text(json.dumps(config))
            marker = root / "installer/model.json"
            proof = json.loads(marker.read_text())
            proof["selectedId"] = public_model_state(root, home)["selectedId"]
            marker.write_text(json.dumps(proof))
            self.assertTrue(read_verified_model(root, home))
            config["providers"]["custom:relay"]["extra_headers"]["X-Route"] = "new-route"
            file.write_text(json.dumps(config))
            self.assertEqual(public_model_state(root, home)["validationStatus"], "stale")
            self.assertFalse(read_verified_model(root, home))

    def test_ignored_named_route_snapshot_fields_do_not_duplicate_the_actual_connection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.fixture(root, {"provider": "custom:relay", "default": "model",
                "base_url": "https://old.example/v1", "api_key": "old-secret", "key_env": "REMOVED_KEY",
                "api_mode": "anthropic_messages", "extra_headers": {"X-Stale": "stale-header"}})
            config = json.loads((home / "config.yaml").read_text())
            config["providers"] = {"custom:relay": {"default_model": "model", "base_url": "https://current.example/v1",
                "api_key": "current-secret", "api_mode": "chat_completions"}}
            file = home / "config.yaml"
            file.write_text(json.dumps(config))
            result = public_model_state(root, home)
            self.assertEqual(len(result["models"]), 1)
            self.assertTrue(result["models"][0]["selected"])
            self.assertTrue(result["models"][0]["available"])
            config["model"] = {"provider": "custom:relay", "default": "model"}
            file.write_text(json.dumps(config))
            self.assertEqual(public_model_state(root, home)["selectedId"], result["selectedId"])

    def test_polling_does_not_initialize_hermes_or_refresh_expired_oauth(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.fixture(root, {"provider": "openai-codex", "default": "native-model"},
                {"provider": "openai-codex", "model": "native-model", "authMode": "native",
                 "validation": "api-response"})
            (home / "auth.json").write_text(json.dumps({"access_token": "expired-secret", "expires_at": 1}))
            core = home / "hermes-agent/hermes_cli"
            core.mkdir(parents=True)
            (core / "__init__.py").write_text("raise AssertionError('read must not import Hermes')")

            def files():
                return {str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns, path.stat().st_mode)
                        for path in root.rglob("*") if path.is_file()}

            before = files()
            for _ in range(3):
                state = public_model_state(root, home)
                self.assertTrue(state["configured"])
                self.assertEqual(state["credentialStatus"], "unknown")
                self.assertTrue(read_verified_model(root, home))
                self.assertNotIn("expired-secret", json.dumps(state))
            self.assertEqual(files(), before)

    def test_malformed_config_is_unknown_and_is_not_repaired(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = self.fixture(root, {"provider": "bedrock", "default": "model"})
            file = home / "config.yaml"
            file.write_text("model: [broken", encoding="utf-8")
            before = file.read_bytes()
            state = public_model_state(root, home)
            self.assertEqual(state["configurationStatus"], "unknown")
            self.assertFalse(state["configured"])
            self.assertEqual(file.read_bytes(), before)
            self.assertEqual(sorted(path.name for path in home.iterdir()), [".env", "config.yaml"])


if __name__ == "__main__":
    unittest.main()
