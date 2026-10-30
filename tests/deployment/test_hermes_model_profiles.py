"""Saved Nora model selections; real Hermes configuration, no public network.

The candidate model response is the existing configuration-layer fixture.
These cases prove persistence and switching, not provider account availability.
"""
import json
import os
from pathlib import Path
import tempfile
import unittest

import yaml

from ops.installer.hermes_model_state import public_model_state

from . import test_nora_native_model as native_fixture

SYNTHETIC_KEY = native_fixture.SYNTHETIC_KEY


@unittest.skipUnless(os.environ.get("NORA_TEST_HERMES"), "Read-only installed Hermes source required")
class SavedModelProfileTests(unittest.TestCase):
    setUp = native_fixture.NativeModelIntegrationTests.setUp
    snapshot = native_fixture.NativeModelIntegrationTests.snapshot
    assert_snapshot = native_fixture.NativeModelIntegrationTests.assert_snapshot
    assert_preserved = native_fixture.NativeModelIntegrationTests.assert_preserved
    run_python = native_fixture.NativeModelIntegrationTests.run_python
    invoke = native_fixture.NativeModelIntegrationTests.invoke

    def state(self):
        return public_model_state(self.root, self.home)

    def save(self, provider, model, base_url="", *, key=SYNTHETIC_KEY):
        body = {"provider": provider, "model": model, "api_key": key,
                "verify_authorized": True}
        if base_url:
            body["base_url"] = base_url
        result, reply = self.invoke(body)
        self.assertEqual(result.returncode, 0, reply)
        return reply

    def switch(self, profile_id, *, authorized=True):
        result = self.run_python("""
            import json, os, sys
            from pathlib import Path
            import hermes_model_config as subject
            home = Path(os.environ['HERMES_HOME'])
            instance = json.loads((home / 'nora-instance.json').read_text())
            request = json.load(sys.stdin)
            try:
                reply = subject.switch(home, instance, request['id'], verify_authorized=request['authorized'])
            except Exception as error:
                print(json.dumps({'ok': False, 'code': getattr(error, 'code', ''),
                    'phase': getattr(error, 'failure_phase', ''), 'error': subject.redact(error)}))
            else:
                print(json.dumps(reply))
        """, {"id": profile_id, "authorized": authorized})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout.splitlines()[-1])

    def test_two_builtin_services_with_same_model_name_switch_without_key_reentry(self):
        first = self.save("deepseek", "same-model")
        second = self.save("openrouter", "same-model")
        self.assertNotEqual(first["selectedId"], second["selectedId"])
        self.assertEqual(second["previousSelectedId"], first["selectedId"])
        self.assertEqual(json.loads(self.marker.read_text())["selectedId"], second["selectedId"])
        self.assertEqual(self.state()["previousSelectedId"], first["selectedId"])
        selected = [row for row in self.state()["models"] if row["selected"]]
        self.assertEqual([row["provider"] for row in selected], ["openrouter"])
        before_env = (self.home / ".env").read_bytes()
        switched = self.switch(first["selectedId"])
        self.assertTrue(switched["ok"], switched)
        self.assertEqual(switched["selectedId"], first["selectedId"])
        self.assertEqual(self.state()["provider"], "deepseek")
        self.assertEqual((self.home / ".env").read_bytes(), before_env)
        metadata = yaml.safe_load(self.config.read_text())["nora_model_profiles"]
        self.assertNotIn(SYNTHETIC_KEY, json.dumps(metadata))
        self.assertNotIn(SYNTHETIC_KEY, json.dumps(self.state()))
        self.assert_preserved()

    def test_stale_checkpoint_cannot_offer_an_unrelated_previous_selection(self):
        first = self.save("deepseek", "first-model")
        second = self.save("openrouter", "second-model")
        self.assertEqual(self.state()["previousSelectedId"], first["selectedId"])
        config = yaml.safe_load(self.config.read_text())
        config["model"]["default"] = "manually-changed-model"
        self.config.write_text(yaml.safe_dump(config))
        self.assertNotEqual(self.state()["selectedId"], second["selectedId"])
        self.assertEqual(self.state()["previousSelectedId"], "")

    def test_skill_inspect_and_switch_use_the_same_saved_ids_without_credentials(self):
        first = self.save("deepseek", "skill-model-A")
        second = self.save("openrouter", "skill-model-B")
        before = self.snapshot()
        result, inspected = self.invoke({"action": "inspect"})
        self.assertEqual(result.returncode, 0, inspected)
        self.assertEqual(inspected["selectedId"], second["selectedId"])
        self.assertEqual({row["id"] for row in inspected["models"]},
                         {row["id"] for row in self.state()["models"]})
        self.assert_snapshot(before)
        denied, _ = self.invoke({"action": "switch", "id": first["selectedId"],
                                "verify_authorized": False})
        self.assertNotEqual(denied.returncode, 0)
        self.assert_snapshot(before)
        result, selected = self.invoke({"action": "switch", "id": first["selectedId"],
                                        "verify_authorized": True})
        self.assertEqual(result.returncode, 0, selected)
        self.assertEqual(selected["selectedId"], first["selectedId"])
        self.assertEqual(self.state()["selectedId"], first["selectedId"])
        self.assertNotIn(SYNTHETIC_KEY, json.dumps(inspected))
        self.assert_preserved()

    def test_two_custom_endpoints_retain_their_native_connection_and_stable_id(self):
        first = self.save("custom", "same-model", "https://first.invalid/v1")
        second_key = "second-native-route-fixture-key"
        second = self.save("custom", "same-model", "https://second.invalid/v1", key=second_key)
        rows = {row["id"]: row for row in self.state()["models"]}
        self.assertNotEqual(first["selectedId"], second["selectedId"])
        self.assertEqual(rows[first["selectedId"]]["baseUrl"], "https://first.invalid/v1")
        self.assertTrue(rows[first["selectedId"]]["available"])
        self.assertEqual(rows[second["selectedId"]]["baseUrl"], "https://second.invalid/v1")
        switched = self.switch(first["selectedId"])
        self.assertTrue(switched["ok"], switched)
        self.assertEqual(self.state()["selectedId"], first["selectedId"])
        self.assertEqual(self.state()["baseUrl"], "https://first.invalid/v1")
        config = yaml.safe_load(self.config.read_text())
        self.assertEqual(config["model"]["api_key"], SYNTHETIC_KEY)
        self.assertTrue(self.switch(second["selectedId"])["ok"])
        self.assertEqual(self.state()["baseUrl"], "https://second.invalid/v1")
        self.assertEqual(yaml.safe_load(self.config.read_text())["model"]["api_key"], second_key)
        self.assertEqual(len([row for row in self.state()["models"] if row["model"] == "same-model"]), 2)
        self.assertNotIn(SYNTHETIC_KEY, json.dumps(yaml.safe_load(self.config.read_text())["nora_model_profiles"]))
        self.assertNotIn(second_key, json.dumps(yaml.safe_load(self.config.read_text())["nora_model_profiles"]))
        self.assert_preserved()
        third = self.save("custom", "same-model", "https://first.invalid/v1", key="third-native-fixture-key")
        related = [row for row in self.state()["models"] if row["baseUrl"] == "https://first.invalid/v1"]
        self.assertEqual({row["id"] for row in related}, {first["selectedId"], third["selectedId"]})
        self.assertEqual(len({row["connectionLabel"] for row in related}), 2)
        labels = {row["id"]: row["connectionLabel"] for row in related}
        self.assertEqual(labels, {row["id"]: row["connectionLabel"] for row in self.state()["models"]
                                  if row["id"] in labels})

    def test_failed_new_save_or_switch_preserves_all_bytes_and_saved_history(self):
        first = self.save("deepseek", "first-model")
        self.save("openrouter", "second-model")
        before = self.snapshot()
        self.env["NORA_FIXTURE_PROBE_REFUSE"] = "1"
        result, reply = self.invoke({"provider": "custom", "model": "rejected-model",
                                    "base_url": "https://rejected.invalid/v1", "api_key": SYNTHETIC_KEY,
                                    "verify_authorized": True})
        self.assertNotEqual(result.returncode, 0, reply)
        self.assert_snapshot(before)
        refused = self.switch(first["selectedId"])
        self.assertFalse(refused["ok"])
        self.assertEqual(refused["code"], "FIXTURE_PROBE_REFUSAL")
        self.assertEqual(refused["phase"], "candidate")
        self.assert_snapshot(before)
        self.assert_preserved()

    def test_unknown_id_or_missing_authorization_cannot_change_saved_configuration(self):
        self.save("deepseek", "first-model")
        before = self.snapshot()
        self.assertFalse(self.switch("model-" + "0" * 32)["ok"])
        self.assert_snapshot(before)
        self.assertFalse(self.switch(self.state()["selectedId"], authorized=False)["ok"])
        self.assert_snapshot(before)

    def test_structured_custom_keeps_header_secrets_in_native_route_and_model_options(self):
        secret_header = "private-header-fixture-secret"
        result, reply = self.invoke({"native_config": {"model": {
            "provider": "custom", "default": "advanced-model", "base_url": "https://advanced.invalid/v1",
            "api_key": SYNTHETIC_KEY, "extra_headers": {"X-Private": secret_header}, "max_tokens": 77,
            "context_length": 128000}},
            "verify_authorized": True})
        self.assertEqual(result.returncode, 0, reply)
        saved_id = reply["selectedId"]
        self.save("deepseek", "other-model")
        switched = self.switch(saved_id)
        self.assertTrue(switched["ok"], switched)
        config = yaml.safe_load(self.config.read_text())
        self.assertEqual(config["model"]["max_tokens"], 77)
        metadata = config["nora_model_profiles"]
        self.assertNotIn(SYNTHETIC_KEY, json.dumps(metadata))
        self.assertNotIn(secret_header, json.dumps(metadata))
        self.assertNotIn(secret_header, json.dumps(self.state()))
        route = config["providers"][config["model"]["provider"]]
        self.assertEqual(route["extra_headers"]["X-Private"], secret_header)
        checked = self.run_python("""
            import importlib.util, json, os
            from pathlib import Path
            from types import SimpleNamespace
            from unittest.mock import patch
            import hermes_model_config as subject
            from hermes_cli.runtime_provider import resolve_runtime_provider
            from run_agent import AIAgent
            from agent import model_metadata
            model_metadata.detect_local_server_type = lambda *args, **kwargs: None
            home = Path(os.environ['HERMES_HOME'])
            import yaml
            selected = yaml.safe_load((home / 'config.yaml').read_text())['model']
            runtime = resolve_runtime_provider(requested=selected['provider'], target_model=selected['default'])
            assert runtime['extra_headers']['X-Private'] == 'private-header-fixture-secret'
            spec = importlib.util.spec_from_file_location('actual_profile_probe',
                Path(subject.__file__).with_name('hermes_model_probe.py'))
            probe = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(probe)
            observed = {}
            def dispatch(agent, kwargs):
                observed['headerInClient'] = agent._client_kwargs['default_headers'].get('X-Private') == 'private-header-fixture-secret'
                return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='OK', tool_calls=None),
                    finish_reason='stop')], usage=None)
            with patch.object(AIAgent, '_interruptible_api_call', dispatch):
                reply = probe.verify(selected['provider'], selected['default'])
            print(json.dumps({'verified': reply.get('verified'), **observed}))
        """)
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        self.assertEqual(json.loads(checked.stdout.splitlines()[-1]), {"verified": True, "headerInClient": True})
        self.assert_preserved()

    def test_builtin_ignored_inline_key_is_not_listed_as_a_usable_native_account(self):
        config = yaml.safe_load(self.config.read_text())
        config["model"] = {"provider": "deepseek", "default": "inline-only-model", "api_key": SYNTHETIC_KEY}
        self.config.write_text(yaml.safe_dump(config))
        row = next(row for row in self.state()["models"] if row["selected"])
        self.assertFalse(row["available"])
        checked = self.run_python("""
            import json
            from unittest.mock import patch
            import hermes_cli.providers as directory
            from hermes_cli.runtime_provider import resolve_runtime_provider
            lookup = directory.get_provider
            def offline(*args, **kwargs):
                kwargs['allow_network'] = False
                return lookup(*args, **kwargs)
            with patch.object(directory, 'get_provider', offline):
                try:
                    resolve_runtime_provider(requested='deepseek', target_model='inline-only-model')
                except Exception as error:
                    print(json.dumps({'rejected': True, 'code': getattr(error, 'code', '')}))
                else:
                    raise AssertionError('Ignored inline key became a native account')
        """)
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        self.assertTrue(json.loads(checked.stdout.splitlines()[-1])["rejected"])
        saved = self.save("openrouter", "new-model")
        self.assertEqual(saved["previousSelectedId"], "")
        old = next(row for row in self.state()["models"] if row["model"] == "inline-only-model")
        self.assertFalse(old["available"])
        self.assertNotIn(SYNTHETIC_KEY, json.dumps(yaml.safe_load(self.config.read_text())["nora_model_profiles"]))

    def test_supported_azure_anthropic_inline_key_moves_to_native_env_reference(self):
        secret = "azure-inline-fixture-key"
        config = yaml.safe_load(self.config.read_text())
        config["model"] = {"provider": "anthropic", "default": "azure-claude-model",
                           "api_key": secret, "base_url": "https://fixture.services.ai.azure.com/anthropic"}
        self.config.write_text(yaml.safe_dump(config))
        saved = self.save("deepseek", "new-model")
        prior = saved["previousSelectedId"]
        self.assertTrue(prior)
        reply = self.switch(prior)
        self.assertTrue(reply["ok"], reply)
        current = yaml.safe_load(self.config.read_text())
        self.assertNotIn("api_key", current["model"])
        self.assertTrue(current["model"]["key_env"].startswith("NORA_MODEL_"))
        self.assertNotIn(secret, json.dumps(current["nora_model_profiles"]))
        self.assertNotIn(secret, json.dumps(self.state()))
        checked = self.run_python("""
            import json
            from agent.secret_scope import set_secret_scope, reset_secret_scope
            from hermes_cli.config import load_env
            from hermes_cli.runtime_provider import resolve_runtime_provider
            scope = set_secret_scope(load_env())
            try:
                runtime = resolve_runtime_provider(requested='anthropic', target_model='azure-claude-model')
                print(json.dumps({'keyMatches': runtime['api_key'] == 'azure-inline-fixture-key',
                                  'protocol': runtime['api_mode']}))
            finally:
                reset_secret_scope(scope)
        """)
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        self.assertEqual(json.loads(checked.stdout.splitlines()[-1]),
                         {"keyMatches": True, "protocol": "anthropic_messages"})
        self.assert_preserved()

    def test_existing_history_rolls_back_with_other_files_on_final_marker_failure(self):
        self.save("deepseek", "first-model")
        before = self.snapshot()
        result = self.run_python("""
            import json, os
            from pathlib import Path
            from unittest.mock import patch
            import hermes_model_config as subject
            home = Path(os.environ['HERMES_HOME'])
            instance = json.loads((home / 'nora-instance.json').read_text())
            with patch.object(subject, '_write_marker', side_effect=OSError('fixture-marker-failure')):
                try:
                    subject.configure(home, instance, {'provider': 'openrouter', 'model': 'second-model',
                        'api_key': 'nora-fixture-only-not-a-real-credential', 'verify_authorized': True})
                except subject.ModelConfigurationFailure as error:
                    assert error.code == 'MODEL_CONFIG_RESTORED'
                    assert error.failure_phase == 'restored'
                    assert isinstance(error.__cause__, OSError)
                    assert str(error.__cause__) == 'fixture-marker-failure'
                else:
                    raise AssertionError('Marker failure was reported as success')
            print('rollback observed')
        """)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_snapshot(before)
        self.assert_preserved()

    def test_malformed_or_future_profile_schema_blocks_writes_without_repair(self):
        for metadata in ({"schema": 2, "models": []}, {"schema": 1, "models": "broken"},
                         {"schema": 1, "models": [{"id": "broken"}]}):
            with self.subTest(metadata=metadata):
                config = yaml.safe_load(self.config.read_text())
                config["nora_model_profiles"] = metadata
                self.config.write_text(yaml.safe_dump(config))
                before = self.snapshot()
                self.assertIn("modelsProblem", self.state())
                result, reply = self.invoke({"provider": "deepseek", "model": "blocked",
                                            "api_key": SYNTHETIC_KEY, "verify_authorized": True})
                self.assertNotEqual(result.returncode, 0, reply)
                self.assert_snapshot(before)

    def test_missing_native_connection_is_listed_unavailable_and_does_not_switch(self):
        first = self.save("custom", "first-model", "https://first.invalid/v1")
        self.save("custom", "second-model", "https://second.invalid/v1")
        config = yaml.safe_load(self.config.read_text())
        row = next(row for row in config["nora_model_profiles"]["models"] if row["id"] == first["selectedId"])
        del config["providers"][row["provider"]]
        self.config.write_text(yaml.safe_dump(config))
        state = self.state()
        unavailable = next(row for row in state["models"] if row["id"] == first["selectedId"])
        self.assertFalse(unavailable["available"])
        before = self.snapshot()
        reply = self.switch(first["selectedId"])
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["code"], "MODEL_PROFILE_UNAVAILABLE")
        self.assert_snapshot(before)


class LegacyModelProfileReadTests(unittest.TestCase):
    def test_only_explicit_legacy_models_and_current_selection_are_listed_readonly(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "hermes"
            home.mkdir()
            config = {"model": {"provider": "deepseek", "default": "current-only"},
                      "providers": {"custom:relay": {"default_model": "declared-only",
                          "base_url": "https://relay.invalid/v1", "api_key": "private-native-key"},
                          "credential-only": {"api_key": "no-model-must-not-be-invented"}},
                      "custom_providers": [{"name": "Legacy Relay", "model": "legacy-only",
                          "base_url": "https://legacy.invalid/v1", "key_env": "MISSING_KEY"}]}
            file = home / "config.yaml"
            file.write_text(yaml.safe_dump(config))
            before = file.read_bytes()
            state = public_model_state(root, home)
            self.assertEqual({row["model"] for row in state["models"]},
                             {"current-only", "declared-only", "legacy-only"})
            self.assertEqual(len({row["id"] for row in state["models"]}), 3)
            self.assertFalse(next(row for row in state["models"] if row["model"] == "legacy-only")["available"])
            self.assertNotIn("private-native-key", json.dumps(state))
            self.assertEqual(file.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
