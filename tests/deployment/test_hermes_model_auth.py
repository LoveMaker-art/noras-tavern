"""Native authentication adapter: isolated native-flow doubles, no accounts/network."""
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
from ops.installer import hermes_model_auth as helper


ROOT = Path(__file__).resolve().parents[2]


class NativeAuthenticationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="nora-auth-offline-")
        self.addCleanup(temporary.cleanup)
        self.config = Path(temporary.name) / "config.yaml"
        self.original = b"model:\n  provider: original\n  default: old-model\nmcp_servers: {keep: true}\n"
        self.config.write_bytes(self.original)
        self.store = {"active_provider": "original", "credential_pool": {"original": ["keep"]}}
        self.events = []
        self.status = {"provider": "openai-codex", "logged_in": True}
        self.definition = SimpleNamespace(id="openai-codex", auth_type="oauth_external")
        self.auth = ModuleType("hermes_cli.auth")
        self.auth._auth_store_lock = nullcontext
        self.auth._load_auth_store = lambda: deepcopy(self.store)
        self.auth._save_auth_store = self.save_store
        self.auth._write_private_file_atomic = lambda path, value: Path(path).write_text(value)
        self.auth.get_auth_status = lambda provider: deepcopy(self.status)
        self.auth._print_device_code_instructions = lambda *_args, **_kwargs: None
        self.auth._store_provider_state = self.store_provider_state
        self.auth.mark_provider_active_if_unset = lambda provider: self.store.setdefault("active_provider", provider)
        self.commands = ModuleType("hermes_cli.auth_commands")
        self.commands._OAUTH_CAPABLE_PROVIDERS = {"openai-codex", "anthropic", "nous", "qwen-oauth", "minimax-oauth", "xai-oauth"}
        self.commands.line_input = input
        self.commands.auth_add_command = self.native_login
        providers = ModuleType("hermes_cli.providers")
        providers.get_provider = lambda name, allow_network=False: self.definition
        config = ModuleType("hermes_cli.config")
        config.get_config_path = lambda: self.config
        package = ModuleType("hermes_cli")
        package.auth, package.auth_commands = self.auth, self.commands
        modules = {"hermes_cli": package, "hermes_cli.auth": self.auth,
                   "hermes_cli.auth_commands": self.commands, "hermes_cli.providers": providers,
                   "hermes_cli.config": config}
        patcher = patch.dict(sys.modules, modules)
        patcher.start()
        self.addCleanup(patcher.stop)

    def save_store(self, value):
        self.store.clear()
        self.store.update(deepcopy(value))

    def store_provider_state(self, store, provider, state, *, set_active=True):
        store.setdefault("providers", {})[provider] = state
        if set_active:
            store["active_provider"] = provider

    def native_login(self, args):
        self.assertEqual(args.provider, self.definition.id)
        self.assertEqual(args.auth_type, "oauth")
        self.assertTrue(args.no_browser)
        self.store["credential_pool"][args.provider] = ["native-token-not-for-output"]
        self.store["active_provider"] = args.provider
        self.config.write_text("model: {provider: changed-by-native-login}\n")
        print("native-token-not-for-output")
        print("To continue, open this URL:")
        print("https://auth.example/codex/device")
        print("Enter this code:")
        print("ABCD-EFGH")
        print("Login successful!")

    def assert_selection_preserved(self):
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertEqual(self.store["active_provider"], "original")
        self.assertEqual(self.store["credential_pool"]["original"], ["keep"])

    def test_native_flow_success_uses_status_preserves_selection_and_hides_secrets(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = helper.authenticate("openai-codex", self.events.append)
        self.assertTrue(result["authenticated"])
        self.assertEqual(result["provider"], "openai-codex")
        self.assert_selection_preserved()
        self.assertIn("openai-codex", self.store["credential_pool"])
        self.assertTrue(any(event.get("url") == "https://auth.example/codex/device" for event in self.events))
        self.assertTrue(any(event.get("userCode") == "ABCD-EFGH" for event in self.events))
        self.assertNotIn("native-token-not-for-output", str(result) + str(self.events) + stdout.getvalue() + stderr.getvalue())

    def test_native_challenge_hook_outputs_only_url_and_user_code(self):
        self.commands.auth_add_command = lambda args: self.auth._print_device_code_instructions(
            "https://auth.example/verify?user_code=AA-BB", "AA-BB", open_browser=False)
        helper.authenticate("openai-codex", self.events.append)
        challenge = self.events[-1]
        self.assertEqual(challenge["userCode"], "AA-BB")
        self.assertEqual(challenge["url"], "https://auth.example/verify?user_code=AA-BB")

    def test_native_prompt_round_trip_does_not_echo_authorization_code(self):
        returned = []
        def native(args):
            returned.append(input("Authorization code: "))
        self.commands.auth_add_command = native
        seen = []
        def respond(event):
            seen.append(event)
            return "private-authorization-code"
        result = helper.authenticate("openai-codex", self.events.append, respond=respond)
        self.assertTrue(result["ok"])
        self.assertEqual(returned, ["private-authorization-code"])
        self.assertTrue(seen[0]["requiresInput"])
        self.assertEqual(seen[0]["promptId"], "1")
        self.assertNotIn("private-authorization-code", str(self.events) + str(result))

    def test_unavailable_prompt_fails_instead_of_supplying_a_blind_answer(self):
        self.commands.auth_add_command = lambda args: input("Authorization code: ")
        with self.assertRaises(helper.AuthenticationError) as caught:
            helper.authenticate("openai-codex", self.events.append)
        self.assertEqual(caught.exception.code, "MODEL_AUTH_INPUT_REQUIRED")
        self.assert_selection_preserved()

    def test_success_text_without_native_status_is_not_success(self):
        self.status["logged_in"] = False
        with self.assertRaises(helper.AuthenticationError) as caught:
            helper.authenticate("openai-codex", self.events.append)
        self.assertEqual(caught.exception.code, "MODEL_AUTH_UNCONFIRMED")
        self.assert_selection_preserved()

    def test_native_failure_preserves_selection_and_does_not_expose_exception_tokens(self):
        def failed(args):
            self.native_login(args)
            raise SystemExit("upstream response: access_token=must-not-escape")
        self.commands.auth_add_command = failed
        with self.assertRaises(helper.AuthenticationError) as caught:
            helper.authenticate("openai-codex", self.events.append)
        self.assertEqual(caught.exception.code, "MODEL_AUTH_FAILED")
        self.assertNotIn("must-not-escape", str(caught.exception) + str(self.events))
        self.assert_selection_preserved()

    def test_sigterm_cancellation_restores_selection_and_signal_handler(self):
        original_signal = signal.getsignal(signal.SIGTERM)
        def cancelled(args):
            self.native_login(args)
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        self.commands.auth_add_command = cancelled
        with self.assertRaises(helper.AuthenticationError) as caught:
            helper.authenticate("openai-codex", self.events.append)
        self.assertEqual(caught.exception.code, "MODEL_AUTH_CANCELLED")
        self.assertEqual(signal.getsignal(signal.SIGTERM), original_signal)
        self.assert_selection_preserved()

    def test_native_status_must_match_selected_provider(self):
        self.status["provider"] = "other-account"
        with self.assertRaises(helper.AuthenticationError) as caught:
            helper.authenticate("openai-codex", self.events.append)
        self.assertEqual(caught.exception.code, "MODEL_AUTH_PROVIDER_MISMATCH")
        self.assert_selection_preserved()

    def test_external_cli_presence_does_not_claim_verified_authentication(self):
        self.definition = SimpleNamespace(id="copilot-acp", auth_type="external_process")
        self.status = {"provider": "copilot-acp", "logged_in": True, "auth_verified": False}
        self.commands.auth_add_command = lambda args: self.fail("must not install or log in external CLI")
        result = helper.authenticate("copilot-acp", self.events.append)
        self.assertTrue(result["configured"])
        self.assertFalse(result["authenticated"])
        self.assertEqual(result["authVerification"], "not-verified")
        self.assert_selection_preserved()

    def test_missing_sdk_or_external_credentials_report_prerequisites(self):
        self.definition = SimpleNamespace(id="bedrock", auth_type="aws_sdk")
        self.status = {"provider": "bedrock", "logged_in": False, "error": "sdk missing"}
        result = helper.authenticate("bedrock", self.events.append)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "MODEL_AUTH_PREREQUISITE_REQUIRED")
        self.assert_selection_preserved()

    def test_restore_failure_is_reported_even_if_login_succeeded(self):
        self.auth._write_private_file_atomic = lambda *_args: (_ for _ in ()).throw(OSError("disk full"))
        with self.assertRaises(helper.AuthenticationError) as caught:
            helper.authenticate("openai-codex", self.events.append)
        self.assertEqual(caught.exception.code, "MODEL_AUTH_SELECTION_RESTORE_FAILED")
        self.assertEqual(self.store["active_provider"], "original")

    def test_new_auth_store_does_not_gain_implicit_active_selection(self):
        self.store.pop("active_provider")
        helper.authenticate("openai-codex", self.events.append)
        self.assertNotIn("active_provider", self.store)
        self.assertIn("openai-codex", self.store["credential_pool"])

    def test_native_activation_is_prevented_before_persistence_not_only_rolled_back(self):
        snapshots = []
        def native(args):
            self.auth._store_provider_state(self.store, args.provider, {"access_token": "private"}, set_active=True)
            self.auth.mark_provider_active_if_unset(args.provider)
            snapshots.append(deepcopy(self.store))
        self.commands.auth_add_command = native
        result = helper.authenticate("openai-codex", self.events.append)
        self.assertTrue(result["ok"])
        self.assertEqual(snapshots[0]["active_provider"], "original")
        self.assertEqual(snapshots[0]["providers"]["openai-codex"], {"access_token": "private"})
        self.assert_selection_preserved()

    def test_challenge_filter_rejects_token_urls_and_ignores_raw_logs(self):
        progress = helper._Progress("openai-codex", self.events.append)
        progress.write("https://auth.example/oauth?access_token=must-not-escape\n")
        progress.write("credential label: private-account-name\n")
        self.assertEqual(self.events, [])
        with self.assertRaises(helper.AuthenticationError):
            progress.challenge("https://auth.example/oauth?token=must-not-escape")
        self.assertEqual(self.events, [])


@unittest.skipUnless(os.environ.get("NORA_TEST_HERMES"), "Read-only installed Hermes source required")
class InstalledHermesAuthenticationTests(unittest.TestCase):
    def test_native_pool_and_status_with_offline_login_preserve_model_selection(self):
        source = Path(os.environ["NORA_TEST_HERMES"]).resolve()
        # Only the authorization network step is replaced. Credential persistence,
        # auth_add dispatch and final status remain the installed Hermes code.
        code = r'''
import base64, dataclasses, json, socket, time
from pathlib import Path
from unittest.mock import patch
from hermes_cli import auth, auth_commands
import hermes_model_auth
home = Path(__import__('os').environ['HERMES_HOME'])
original = 'model: {provider: openrouter, default: original}\nmcp_servers: {keep: true}\n'
(home / 'config.yaml').write_text(original)
encode = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip('=')
token = encode({'alg': 'none'}) + '.' + encode({'exp': int(time.time()) + 86400, 'sub': 'isolated-test'}) + '.fixture'
spec = auth_commands._OAUTH_ADD_SPECS['openai-codex']
auth_commands._OAUTH_ADD_SPECS['openai-codex'] = dataclasses.replace(spec, login=lambda args: {
    'tokens': {'access_token': token, 'refresh_token': 'isolated-fixture-refresh'}})
events = []
with patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden')):
    result = hermes_model_auth.authenticate('openai-codex', events.append)
    store = auth._load_auth_store()
    assert result['ok'] and result['authenticated']
    assert (home / 'config.yaml').read_text() == original
    assert not store.get('active_provider')
    assert store['credential_pool']['openai-codex']
    assert token not in str(events) + str(result)
print('native auth pool/status passed; network blocked; model selection preserved')
'''
        with tempfile.TemporaryDirectory(prefix="nora-native-auth-offline-") as temporary:
            env = {"PATH": os.environ.get("PATH", ""), "HOME": temporary, "HERMES_HOME": temporary,
                   "USERPROFILE": temporary, "XDG_CACHE_HOME": str(Path(temporary) / "cache"),
                   "PYTHONPATH": os.pathsep.join((str(source), str(ROOT / "ops/installer"))),
                   "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}
            result = subprocess.run([sys.executable, "-B", "-c", code], cwd=source, env=env,
                                    capture_output=True, text=True, timeout=40)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("native auth pool/status passed", result.stdout)
        self.assertNotIn("isolated-fixture-refresh", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
