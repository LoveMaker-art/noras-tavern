"""Candidate configuration transaction boundaries; no real model/account calls.

The child/native validation boundary is replaced deliberately. These tests prove
parent isolation and commit/recovery behavior, not a provider's availability.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml

from ops.installer.launcher_bridge import read_verified_model


ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "ops/installer"
KEY = "candidate-fixture-only-never-a-real-key"


class ModelCandidateCommitTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="nora-model-candidate-parent-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "hermes"
        self.home.mkdir()
        self.tavern = self.root / "tavern"
        library = self.tavern / "apps/tavern-ops/updater"
        library.mkdir(parents=True)
        shutil.copy2(ROOT / "ops/updater/runtime_lock.py", library / "runtime_lock.py")
        self.core = self.tavern / "apps/tavern-ops/installer"
        self.core.mkdir()
        for name in ("hermes_model_config.py", "hermes_model_probe.py", "hermes_model_state.py"):
            shutil.copy2(CORE / name, self.core / name)
        imports = patch.object(sys, "path", [str(self.core), *sys.path])
        imports.start()
        self.addCleanup(imports.stop)
        self.instance = {"schema": 1, "noraHome": str(self.root), "hermesHome": str(self.home),
                         "installRoot": str(self.tavern), "port": 18999}
        (self.home / "nora-instance.json").write_text(json.dumps(self.instance), encoding="utf-8")
        self.config = self.home / "config.yaml"
        self.initial = {
            "model": {"provider": "custom", "default": "old-model", "api_key": "old-fixture-key",
                      "base_url": "https://old.example.invalid/v1"},
            "providers": {"unrelated": {"name": "Keep Provider", "base_url": "https://keep.example.invalid/v1"}},
            "mcp_servers": {"nora": {"command": "keep-mcp"}},
            "fallback_providers": [{"provider": "openrouter", "model": "keep-fallback"}],
            "platforms": {"clawchat": {"enabled": True}},
            "compression": {"enabled": False},
        }
        self.config.write_text(yaml.safe_dump(self.initial), encoding="utf-8")
        (self.home / ".env").write_text("UNRELATED_CREDENTIAL=keep-env\n", encoding="utf-8")
        (self.home / "auth.json").write_text(json.dumps({"version": 1, "providers": {},
            "fixture_unrelated": {"preserve": "old-auth"}}), encoding="utf-8")
        self.marker = self.root / "installer/model.json"
        self.marker.parent.mkdir()
        self.marker.write_text('{"schema":1,"provider":"custom","model":"old-model"}', encoding="utf-8")
        self.files = [self.config, self.home / ".env", self.home / "auth.json", self.marker]
        self.before = self.snapshot()
        self.sentinels = {}
        for file, value in ((self.home / "SOUL.md", "keep personality"),
                            (self.home / "USER.md", "keep user preferences"),
                            (self.home / "MEMORY.md", "keep memory"),
                            (self.tavern / "tavern-state/native/config.yaml", "keep tavern model"),
                            (self.tavern / "tavern-state/native/chats/story.jsonl", "keep chat"),
                            (self.tavern / "tavern-state/native/characters/card.json", "keep character"),
                            (self.tavern / "tavern-state/native/worlds/world.json", "keep world")):
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(value, encoding="utf-8")
            self.sentinels[file] = file.read_bytes()
        self.body = {"provider": "opencode-go", "model": "glm-5", "api_key": KEY,
                     "verify_authorized": True}
        self.candidates = []
        self.captured_output = io.StringIO()
        self.captured_errors = io.StringIO()
        environment = patch.dict(os.environ, {"PATH": os.environ.get("PATH", ""),
            "HERMES_HOME": str(self.home), "HOME": str(self.home), "USERPROFILE": str(self.home),
            "NO_PROXY": "*", "no_proxy": "*", "PYTHONDONTWRITEBYTECODE": "1"}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.network_attempts = []
        def no_network(*_args, **_kwargs):
            self.network_attempts.append(True)
            raise AssertionError("Parent transaction unit test must not make network requests")
        network = contextlib.ExitStack()
        network.enter_context(patch.object(socket.socket, "connect", side_effect=no_network))
        network.enter_context(patch.object(socket, "create_connection", side_effect=no_network))
        self.addCleanup(network.close)
        spec = importlib.util.spec_from_file_location("nora_candidate_subject_" + str(id(self)),
                                                    self.core / "hermes_model_config.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def snapshot(self):
        return {file: file.read_bytes() if file.exists() else None for file in self.files}

    def assert_old_configuration(self):
        self.assertEqual(self.snapshot(), self.before)

    def assert_data_preserved(self):
        for file, contents in self.sentinels.items():
            self.assertEqual(file.read_bytes(), contents, str(file))
        config = yaml.safe_load(self.config.read_text(encoding="utf-8"))
        for key in ("mcp_servers", "fallback_providers", "platforms", "compression"):
            self.assertEqual(config[key], self.initial[key], key)

    def assert_candidates_cleaned(self):
        for candidate in self.candidates:
            self.assertFalse(candidate.exists(), "Temporary credential candidate was not removed")
        self.assertNotIn(KEY, self.captured_output.getvalue() + self.captured_errors.getvalue())
        self.assertFalse(self.network_attempts)

    def make_candidate(self, home, body, wizard=False, region=""):
        """Fake only the subprocess boundary; actual parent commit remains real."""
        candidate = Path(home)
        self.candidates.append(candidate)
        self.assertNotEqual(candidate.resolve(), self.home)
        self.assertEqual(self.snapshot(), self.before, "Live configuration changed before validation")
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(candidate.stat().st_mode), 0o700)
        self.assertTrue(body["verify_authorized"])
        for live, contents in self.before.items():
            if live == self.marker:
                continue
            copied = candidate / live.name
            self.assertTrue(copied.is_file())
            self.assertEqual(copied.read_bytes(), contents)
        self.assertFalse((candidate / "SOUL.md").exists())
        self.assertFalse((candidate / "USER.md").exists())
        config = yaml.safe_load((candidate / "config.yaml").read_text(encoding="utf-8"))
        config["model"] = {"provider": "opencode-go", "default": "glm-5",
                           "base_url": "https://opencode.ai/go/v1", "api_mode": "chat_completions"}
        (candidate / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
        env = (candidate / ".env").read_text(encoding="utf-8")
        (candidate / ".env").write_text(env + "OPENCODE_GO_API_KEY=" + KEY + "\n", encoding="utf-8")
        auth = json.loads((candidate / "auth.json").read_text(encoding="utf-8"))
        auth["candidate_fixture"] = "validated-account-state"
        (candidate / "auth.json").write_text(json.dumps(auth), encoding="utf-8")
        return {"ok": True, "verified": True, "validation": "api-response", "provider": "opencode-go",
                "model": "glm-5", "baseUrl": "https://opencode.ai/go/v1", "apiMode": "chat_completions",
                "keyEnv": "OPENCODE_GO_API_KEY", "authMode": "key"}

    def configure(self, callback=None, body=None):
        callback = callback or self.make_candidate
        request = self.body if body is None else body
        # Match the real configure_provider.py handoff before exercising the
        # parent transaction directly; that entry owns input redaction setup.
        self.module.remember(request.get("api_key"))
        with patch.object(self.module, "_run_candidate", side_effect=callback) as runner, \
             contextlib.redirect_stdout(self.captured_output), contextlib.redirect_stderr(self.captured_errors):
            result = self.module.configure(self.home, self.instance, request)
        return result, runner

    def rejected(self, callback=None, body=None):
        try:
            result, runner = self.configure(callback, body)
        except AssertionError:
            # A failed fixture assertion is evidence of a regression, not an
            # expected refusal from the product.
            raise
        except (Exception, KeyboardInterrupt) as error:
            # Public entrypoint uses this exact redaction boundary. A private
            # native exception is not itself an output transcript.
            self.assertNotIn(KEY, self.module.redact(error))
            return None
        self.assertIsInstance(result, dict)
        self.assertFalse(result.get("ok"), "Rejected candidate was reported as successful")
        return result

    def test_success_commits_only_verified_candidate_and_old_launcher_record(self):
        reply, runner = self.configure()
        runner.assert_called_once()
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["validation"], "api-response")
        self.assertNotIn(KEY, json.dumps(reply))
        self.assertNotIn(KEY, self.marker.read_text(encoding="utf-8"))
        current = yaml.safe_load(self.config.read_text(encoding="utf-8"))
        self.assertEqual(current["model"]["provider"], "opencode-go")
        self.assertEqual(current["model"]["default"], "glm-5")
        self.assertEqual(current["providers"]["unrelated"], self.initial["providers"]["unrelated"])
        self.assertIn("OPENCODE_GO_API_KEY=" + KEY, (self.home / ".env").read_text(encoding="utf-8"))
        self.assertEqual(json.loads((self.home / "auth.json").read_text())["candidate_fixture"], "validated-account-state")
        self.assertEqual(read_verified_model(self.root, self.home).get("provider"), "opencode-go")
        self.assertEqual(json.loads(self.marker.read_text())["schema"], 1)
        self.assert_data_preserved()
        self.assert_candidates_cleaned()

    def test_validation_exception_leaves_live_four_files_untouched(self):
        def failure(*args, **kwargs):
            self.make_candidate(*args, **kwargs)
            raise RuntimeError("Synthetic model refusal: " + KEY)
        self.rejected(failure)
        self.assert_old_configuration()
        self.assert_data_preserved()
        self.assert_candidates_cleaned()

    def test_exit_success_without_real_verification_is_not_commit_authority(self):
        for update in ({"verified": False}, {"validation": "configuration-only"}, {"ok": False}):
            with self.subTest(update=update):
                def not_verified(*args, **kwargs):
                    return {**self.make_candidate(*args, **kwargs), **update}
                self.rejected(not_verified)
                self.assert_old_configuration()
                self.assert_candidates_cleaned()

    def test_missing_explicit_model_call_authorization_rejects_before_candidate_work(self):
        for authorization in (None, False, "true", 1):
            body = {**self.body}
            if authorization is None:
                body.pop("verify_authorized")
            else:
                body["verify_authorized"] = authorization
            with self.subTest(authorization=authorization), \
                 patch.object(self.module, "_run_candidate") as runner:
                try:
                    reply = self.module.configure(self.home, self.instance, body)
                except Exception:
                    pass
                else:
                    self.assertFalse(reply.get("ok"))
                runner.assert_not_called()
                self.assert_old_configuration()
        self.assert_data_preserved()

    def test_cancelled_candidate_is_removed_without_changing_live_configuration(self):
        def cancelled(*args, **kwargs):
            self.make_candidate(*args, **kwargs)
            return {"ok": False, "cancelled": True, "error": "cancelled by fixture"}
        self.rejected(cancelled)
        self.assert_old_configuration()
        self.assert_data_preserved()
        self.assert_candidates_cleaned()

    def test_keyboard_interrupt_cleans_candidate_and_preserves_old_configuration(self):
        def interrupted(*args, **kwargs):
            self.make_candidate(*args, **kwargs)
            raise KeyboardInterrupt()
        self.rejected(interrupted)
        self.assert_old_configuration()
        self.assert_data_preserved()
        self.assert_candidates_cleaned()

    def test_final_marker_failure_rolls_back_committed_files_then_allows_retry(self):
        with patch.object(self.module, "_write_marker", side_effect=OSError("fixture marker write failed")):
            self.rejected()
        self.assert_old_configuration()
        self.assert_data_preserved()
        self.assert_candidates_cleaned()
        reply, _runner = self.configure()
        self.assertTrue(reply["ok"])
        self.assertEqual(read_verified_model(self.root, self.home).get("provider"), "opencode-go")
        self.assert_data_preserved()
        self.assert_candidates_cleaned()

    def test_exact_task_checkpoint_confirms_commit_but_never_a_changed_file_or_other_task(self):
        operation_id = '927df264-bfd4-4eb1-ad32-e776a6e34570'
        with patch.dict(os.environ, {'NORA_OPERATION_ID': operation_id}):
            self.configure()
        before = self.snapshot()
        result = self.module.inspect_outcome(self.home, self.root, operation_id)
        self.assertTrue(result['confirmed'], result)
        self.assertEqual(result['action'], 'configure')
        self.assertEqual(result['profileId'], result['current']['selectedId'])
        self.assertNotIn(KEY, json.dumps(result))
        self.assertEqual(self.snapshot(), before, 'Outcome inspection must be read-only')
        self.assertFalse(self.module.inspect_outcome(self.home, self.root, 'another-task')['confirmed'])
        for file in (self.config, self.home / '.env', self.home / 'auth.json'):
            file.write_bytes(before[file] + b'\n')
            self.assertFalse(self.module.inspect_outcome(self.home, self.root, operation_id)['confirmed'], file.name)
            file.write_bytes(before[file])
        self.assertTrue(self.module.inspect_outcome(self.home, self.root, operation_id)['confirmed'])
        self.assert_data_preserved()

    def test_failed_restoration_never_produces_candidate_or_committed_proof(self):
        operation_id = 'e43aa72b-9008-4319-aee4-667a66fd4633'
        atomic = self.module._atomic
        def refuse_original(file, contents):
            if file == self.config and contents == self.before[file]:
                raise OSError('fixture original restore refused')
            return atomic(file, contents)
        with patch.dict(os.environ, {'NORA_OPERATION_ID': operation_id}), \
             patch.object(self.module, '_atomic', side_effect=refuse_original), \
             patch.object(self.module, '_write_marker', side_effect=OSError('fixture marker refused')):
            with self.assertRaises(RuntimeError) as raised:
                self.configure()
        self.assertNotIn(getattr(raised.exception, 'failure_phase', None), ('candidate', 'restored'))
        self.assertFalse(self.module.inspect_outcome(self.home, self.root, operation_id)['confirmed'])
        self.assertNotEqual(self.config.read_bytes(), self.before[self.config])
        self.assert_data_preserved()

    def test_concurrent_live_edit_is_rejected_without_rolling_back_the_new_edit(self):
        edited = None
        def concurrent(*args, **kwargs):
            nonlocal edited
            reply = self.make_candidate(*args, **kwargs)
            config = yaml.safe_load(self.config.read_text(encoding="utf-8"))
            config["concurrent_user_edit"] = "must remain"
            self.config.write_text(yaml.safe_dump(config), encoding="utf-8")
            edited = self.config.read_bytes()
            return reply
        self.rejected(concurrent)
        self.assertEqual(self.config.read_bytes(), edited)
        for file in self.files[1:]:
            self.assertEqual(file.read_bytes(), self.before[file])
        self.assert_data_preserved()
        self.assert_candidates_cleaned()

    def test_same_bytes_replaced_live_file_identity_is_also_a_conflict(self):
        def replaced(*args, **kwargs):
            reply = self.make_candidate(*args, **kwargs)
            replacement = self.config.with_name("replacement.yaml")
            replacement.write_bytes(self.config.read_bytes())
            os.replace(replacement, self.config)
            return reply
        self.rejected(replaced)
        self.assert_old_configuration()
        self.assert_candidates_cleaned()

    def test_verified_result_must_match_the_candidate_provider_and_model(self):
        for update in ({"provider": "deepseek"}, {"model": "different-model"}):
            with self.subTest(update=update):
                def mismatched(*args, **kwargs):
                    return {**self.make_candidate(*args, **kwargs), **update}
                self.rejected(mismatched)
                self.assert_old_configuration()
                self.assert_candidates_cleaned()

    def test_native_wizard_must_not_overwrite_unrelated_config_sections(self):
        def unrelated_change(*args, **kwargs):
            reply = self.make_candidate(*args, **kwargs)
            candidate = self.candidates[-1]
            config = yaml.safe_load((candidate / "config.yaml").read_text(encoding="utf-8"))
            config["mcp_servers"] = {"unexpected": {"command": "must not commit"}}
            (candidate / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
            return reply
        self.rejected(unrelated_change)
        self.assert_old_configuration()
        self.assert_data_preserved()
        self.assert_candidates_cleaned()

    def test_native_candidate_cannot_drop_an_existing_unselected_provider(self):
        def drop_provider(*args, **kwargs):
            result = self.make_candidate(*args, **kwargs)
            candidate = self.candidates[-1] / 'config.yaml'
            config = yaml.safe_load(candidate.read_text(encoding='utf-8'))
            del config['providers']['unrelated']
            candidate.write_text(yaml.safe_dump(config), encoding='utf-8')
            return result
        self.rejected(drop_provider)
        self.assert_old_configuration()
        self.assert_data_preserved()
        self.assert_candidates_cleaned()

    def test_candidate_symlink_cannot_supply_credentials_from_another_file(self):
        outside = self.root / "unrelated-secret.env"
        outside.write_text("OPENCODE_GO_API_KEY=outside-fixture-key\n", encoding="utf-8")
        contents = outside.read_bytes()
        def redirected(*args, **kwargs):
            reply = self.make_candidate(*args, **kwargs)
            env = self.candidates[-1] / ".env"
            env.unlink()
            env.symlink_to(outside)
            return reply
        self.rejected(redirected)
        self.assert_old_configuration()
        self.assertEqual(outside.read_bytes(), contents)
        self.assert_candidates_cleaned()

    def test_absent_original_auth_and_marker_are_not_left_half_created_on_failure(self):
        (self.home / "auth.json").unlink()
        self.marker.unlink()
        self.before = self.snapshot()
        def candidate(home, body, **_kwargs):
            path = Path(home)
            self.candidates.append(path)
            self.assertEqual(self.snapshot(), self.before)
            config = yaml.safe_load((path / "config.yaml").read_text(encoding="utf-8"))
            config["model"] = {"provider": "opencode-go", "default": "glm-5",
                               "base_url": "https://opencode.ai/go/v1", "api_mode": "chat_completions"}
            (path / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
            (path / ".env").write_text("OPENCODE_GO_API_KEY=" + KEY + "\n", encoding="utf-8")
            (path / "auth.json").write_text('{"version":1,"providers":{}}', encoding="utf-8")
            return {"ok": True, "verified": True, "validation": "api-response", "provider": "opencode-go",
                    "model": "glm-5", "baseUrl": "https://opencode.ai/go/v1", "apiMode": "chat_completions",
                    "keyEnv": "OPENCODE_GO_API_KEY", "authMode": "key"}
        with patch.object(self.module, "_write_marker", side_effect=OSError("fixture final failure")):
            self.rejected(candidate)
        self.assert_old_configuration()
        self.assert_candidates_cleaned()


if __name__ == "__main__":
    unittest.main()
