"""Native Hermes service coverage and configuration boundaries, entirely offline.

Only the provider picker and the terminal/account-dependent leaf are replaced
in wizard tests. Hermes' real select_provider_and_model dispatcher still runs.
Run via tooling/run.mjs with the read-only pinned NORA_TEST_HERMES checkout.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "ops/skills/system/model-provider-config"
SYNTHETIC_KEY = "native-flow-fixture-key-not-a-credential"
NETWORK_GUARD = r'''
import os, socket, traceback
from pathlib import Path
def deny(*args, **kwargs):
    Path(os.environ['NORA_NETWORK_ATTEMPTS']).write_text(
        'blocked network attempt\n' + '\n'.join(frame.filename + ':' + str(frame.lineno) + ' ' + frame.name
                                               for frame in traceback.extract_stack(limit=12)[:-1]),
        encoding='utf-8')
    raise AssertionError('Native configuration test may not access a network')
socket.create_connection = deny
socket.getaddrinfo = deny
socket.socket.connect = deny
socket.socket.connect_ex = deny
import httpx
httpx.Client.send = deny
httpx.AsyncClient.send = deny
import requests
requests.sessions.Session.send = deny
'''


@unittest.skipUnless(os.environ.get("NORA_TEST_HERMES"), "Read-only pinned Hermes source required")
class NativeHermesFlowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="nora-native-flows-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "candidate"
        self.home.mkdir()
        self.source = Path(os.environ["NORA_TEST_HERMES"]).resolve()
        self.core = self.root / "tavern/apps/tavern-ops/installer"
        self.core.mkdir(parents=True)
        for name in ("hermes_model_config.py", "hermes_model_probe.py", "hermes_model_state.py"):
            shutil.copy2(ROOT / "ops/installer" / name, self.core / name)
        self.config = self.home / "config.yaml"
        self.original = {
            "model": {"provider": "custom", "default": "old-fixture-model",
                      "base_url": "https://fixture.invalid/v1", "api_key": SYNTHETIC_KEY},
            "mcp_servers": {"nora": {"command": "user-mcp", "args": ["preserve"]}},
            "fallback_providers": [{"provider": "deepseek", "model": "user-fallback"}],
            "platforms": {"clawchat": {"enabled": True}},
            "memory": {"user_char_limit": 2345},
        }
        self.config.write_text(yaml.safe_dump(self.original), encoding="utf-8")
        (self.home / ".env").write_text("PRESERVE_FIXTURE_SETTING=keep\n", encoding="utf-8")
        self.sentinels = {}
        for relative in ("worlds/world.json", "chats/story.jsonl", "characters/card.json", "SOUL.md"):
            file = self.home / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("user-content-preserved", encoding="utf-8")
            self.sentinels[file] = file.read_bytes()
        guard = self.root / "guard"
        guard.mkdir()
        (guard / "sitecustomize.py").write_text(NETWORK_GUARD, encoding="utf-8")
        self.attempts = self.root / "network-attempts.txt"
        self.env = {
            "PATH": os.pathsep.join((str(Path(sys.executable).parent), "/usr/bin", "/bin")),
            "HOME": str(self.home), "USERPROFILE": str(self.home), "HERMES_HOME": str(self.home),
            "PYTHONPATH": os.pathsep.join((str(guard), str(self.source), str(self.core))),
            "NO_PROXY": "*", "no_proxy": "*", "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8",
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "NORA_NETWORK_ATTEMPTS": str(self.attempts),
        }

    def run_code(self, code, body=None):
        result = subprocess.run(
            [sys.executable, "-B", "-c", textwrap.dedent(code)], input=json.dumps(body or {}),
            env=self.env, cwd=self.source, capture_output=True, text=True, timeout=30,
        )
        self.assertNotIn(SYNTHETIC_KEY, result.stdout + result.stderr)
        self.assertFalse(self.attempts.exists(), "A native-only configuration step attempted a network request")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for path, contents in self.sentinels.items():
            self.assertEqual(path.read_bytes(), contents, str(path))
        return json.loads(result.stdout.strip().splitlines()[-1])

    def test_catalog_covers_the_native_directory_without_api_key_filtering(self):
        result = self.run_code("""
            import json, os
            from pathlib import Path
            from hermes_cli.models import normalize_provider
            from hermes_cli.models_catalog_static import CANONICAL_PROVIDERS
            from hermes_cli.auth import PROVIDER_REGISTRY
            import hermes_model_config as native_config
            # list_available_providers additionally probes authentication. Its
            # directory is the same native CANONICAL_PROVIDERS + custom list;
            # compare that source without triggering account or SDK discovery.
            expected = {normalize_provider(item.slug) for item in CANONICAL_PROVIDERS}
            expected.update(normalize_provider(provider) for provider in PROVIDER_REGISTRY)
            expected.add('custom')
            actual = native_config.catalog(Path(os.environ['HERMES_HOME']))
            actual_ids = {normalize_provider(item['id']) for item in actual['providers']}
            assert expected <= actual_ids, sorted(expected - actual_ids)
            assert actual['scope'] == 'native-hermes', actual['scope']
            print(json.dumps({'count': len(actual_ids), 'missing': sorted(expected - actual_ids)}))
        """)
        self.assertEqual(result["missing"], [])
        self.assertGreater(result["count"], 20)

    def test_catalog_keeps_oauth_cloud_keyless_external_and_virtual_routes(self):
        result = self.run_code("""
            import json, os
            from pathlib import Path
            from hermes_cli.models import normalize_provider
            import hermes_model_config as native_config
            rows = native_config.catalog(Path(os.environ['HERMES_HOME']))['providers']
            ids = {normalize_provider(item['id']) for item in rows}
            required = {'nous', 'openai-codex', 'xai-oauth', 'qwen-oauth', 'minimax-oauth',
                        'bedrock', 'vertex', 'azure-foundry', 'opencode-free', 'lmstudio',
                        'copilot-acp', 'moa', 'custom'}
            assert required <= ids, sorted(required - ids)
            print(json.dumps({'covered': sorted(required)}))
        """)
        self.assertIn("moa", result["covered"])

    def test_catalog_includes_existing_native_named_provider_entries(self):
        config = dict(self.original)
        config["providers"] = {
            "user-private-service": {"name": "User private service", "base_url": "https://private.invalid/v1",
                                     "key_env": "USER_PRIVATE_SERVICE_KEY"},
        }
        config["custom_providers"] = [{"name": "old-relay", "base_url": "https://relay.invalid/v1",
                                        "api_key": SYNTHETIC_KEY, "model": "old-model"}]
        self.config.write_text(yaml.safe_dump(config), encoding="utf-8")
        result = self.run_code("""
            import json, os
            from pathlib import Path
            import hermes_model_config as native_config
            rows = native_config.catalog(Path(os.environ['HERMES_HOME']))['providers']
            ids = {item['id'] for item in rows}
            assert 'user-private-service' in ids, sorted(ids)
            assert 'custom:old-relay' in ids, sorted(ids)
            print(json.dumps({'named': True}))
        """)
        self.assertTrue(result["named"])

    def test_native_profile_alias_can_be_configured_without_a_second_service_list(self):
        result = self.run_code("""
            import json, os
            from pathlib import Path
            from providers import get_provider_profile
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            profile = get_provider_profile('kimi-for-coding')
            assert profile and profile.name == 'kimi-coding'
            directory = native_config.catalog(home)['providers']
            entry = next(row for row in directory if row['id'] == profile.name)
            assert 'kimi-for-coding' in entry.get('aliases', []), 'Native alias missing from the chat-facing directory'
            selected = native_config.apply_selection(home, {
                'provider': 'kimi-for-coding', 'model': 'kimi-for-coding',
                'api_key': 'native-flow-fixture-key-not-a-credential', 'auth_mode': 'key'})
            assert get_provider_profile(selected['provider']).name == profile.name
            from hermes_cli.config import get_env_value
            assert get_env_value(profile.env_vars[0]) == 'native-flow-fixture-key-not-a-credential'
            print(json.dumps({'alias_resolved': True}))
        """)
        self.assertTrue(result["alias_resolved"])

    def test_inspect_does_not_expose_credentials_in_an_existing_endpoint(self):
        value = dict(self.original)
        value["model"] = {**value["model"], "base_url": "https://fixture-user:private-fixture-token@fixture.invalid/v1?token=private-query-token"}
        self.config.write_text(yaml.safe_dump(value), encoding="utf-8")
        before = self.config.read_bytes()
        result = self.run_code("""
            import json, os
            from pathlib import Path
            import hermes_model_config as native_config
            value = native_config.inspect(Path(os.environ['HERMES_HOME']))
            assert value['baseUrl'] == 'https://fixture.invalid/v1'
            assert 'private-fixture-token' not in json.dumps(value)
            assert 'private-query-token' not in json.dumps(value)
            print(json.dumps(value))
        """)
        self.assertEqual(result["baseUrl"], "https://fixture.invalid/v1")
        self.assertEqual(self.config.read_bytes(), before)

    def test_no_explicit_address_keeps_native_credential_based_endpoint_selection(self):
        result = self.run_code("""
            import json, os
            from pathlib import Path
            from unittest.mock import patch
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            selected = native_config.apply_selection(home, {
                'provider': 'kimi-coding', 'model': 'kimi-for-coding',
                'api_key': 'sk-' + 'kimi-fixture-only-' + '0' * 40,
                'auth_mode': 'key'})
            assert not selected.get('base_url'), 'Skill forced the static catalog URL over native account routing'
            from hermes_cli.auth import get_api_key_provider_status
            status = get_api_key_provider_status('kimi-coding')
            assert 'api.kimi.com/coding' in status['base_url'], status['base_url']
            print(json.dumps({'native_endpoint_selected': True}))
        """)
        self.assertTrue(result['native_endpoint_selected'])

    def test_candidate_cannot_call_a_model_without_validation_authorization(self):
        result = self.run_code("""
            import json, os
            from pathlib import Path
            from unittest.mock import patch
            import hermes_model_config as native_config
            import hermes_model_probe as native_probe
            home = Path(os.environ['HERMES_HOME'])
            (home / '.nora-model-candidate').write_text('1')
            before = (home / 'config.yaml').read_bytes()
            with patch.object(native_probe, 'verify') as verify:
                try:
                    native_config.candidate_main(home, {'provider': 'deepseek', 'model': 'deepseek-v4-flash'})
                except ValueError:
                    pass
                else:
                    raise AssertionError('Candidate accepted unauthorized validation')
                assert verify.call_count == 0
            assert (home / 'config.yaml').read_bytes() == before
            print(json.dumps({'authorized_guard': True}))
        """)
        self.assertTrue(result["authorized_guard"])

    def test_wizard_runs_real_native_dispatch_and_keeps_region_arguments(self):
        result = self.run_code("""
            import json, os
            from pathlib import Path
            from unittest.mock import patch
            from hermes_cli import main
            import hermes_model_config as native_config
            seen = []
            for provider in ('nous', 'minimax-oauth', 'qwen-oauth', 'bedrock', 'vertex',
                             'azure-foundry', 'opencode-free', 'copilot-acp', 'moa', 'custom'):
                def leaf(config, current_model, args):
                    seen.append({'provider': provider, 'region': args.region,
                                 'no_browser': args.no_browser, 'original_model': current_model})
                # Real dispatcher, synthetic picker and terminal/account leaf:
                # this verifies we do not route special services through a
                # generic Key/custom branch or replace the complete CLI flow.
                with patch.object(main, '_pick_provider', return_value=provider), \
                     patch.dict(main._PROVIDER_MODEL_FLOWS, {provider: leaf}), \
                     patch.object(main, '_resolve_active_provider', return_value='custom'), \
                     patch.object(main, '_clear_stale_openai_base_url'):
                    native_config.run_wizard(Path(os.environ['HERMES_HOME']), region='cn')
            assert len(seen) == 10, seen
            assert all(item['region'] == 'cn' for item in seen), seen
            assert all(item['no_browser'] is True for item in seen), seen
            assert all(item['original_model'] == 'old-fixture-model' for item in seen), seen
            print(json.dumps({'seen': seen}))
        """)
        self.assertEqual(len(result["seen"]), 10)

    def test_native_non_key_and_external_configuration_keeps_its_service_identity(self):
        result = self.run_code("""
            import json, os
            from pathlib import Path
            import yaml
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            selections = (
                ('nous', 'hermes-fixture', ''),
                ('openai-codex', 'gpt-fixture', ''),
                ('qwen-oauth', 'qwen-fixture', ''),
                ('minimax-oauth', 'minimax-fixture', ''),
                ('bedrock', 'anthropic.fixture-model', ''),
                ('vertex', 'gemini-fixture', ''),
                ('azure-foundry', 'azure-fixture', 'https://azure.invalid'),
                ('opencode-free', 'big-pickle', 'https://opencode.ai/zen/v1'),
                ('copilot-acp', 'copilot-fixture', 'acp://copilot'),
                ('moa', 'moa-fixture', 'moa://local'),
            )
            before = yaml.safe_load((home / 'config.yaml').read_text())
            for provider, model, base in selections:
                fields = {'provider': provider, 'default': model,
                          'native_future_model_option': {'retain': provider}}
                if base:
                    fields['base_url'] = base
                native_config.apply_selection(home, {'native_config': {'model': fields}})
                actual = yaml.safe_load((home / 'config.yaml').read_text())
                assert actual['model']['provider'] == provider, provider
                assert actual['model']['default'] == model, provider
                assert actual['model']['native_future_model_option'] == {'retain': provider}, provider
                if base:
                    assert actual['model']['base_url'] == base, provider
                for section in ('mcp_servers', 'fallback_providers', 'platforms', 'memory'):
                    assert actual[section] == before[section], (provider, section)
            print(json.dumps({'native_identities_preserved': len(selections)}))
        """)
        self.assertEqual(result["native_identities_preserved"], 10)

    def test_registered_qwen_environment_is_allowed_but_instance_home_is_not(self):
        result = self.run_code("""
            import json, os
            from pathlib import Path
            from hermes_cli.config import load_env
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            native_config.apply_selection(home, {
                'native_config': {'model': {'provider': 'qwen-oauth', 'default': 'qwen-fixture'}},
                'environment': {'HERMES_QWEN_BASE_URL': 'https://qwen.fixture.invalid/v1'},
            })
            assert load_env()['HERMES_QWEN_BASE_URL'] == 'https://qwen.fixture.invalid/v1'
            before = (home / '.env').read_bytes()
            try:
                native_config.apply_selection(home, {
                    'native_config': {'model': {'provider': 'qwen-oauth', 'default': 'qwen-fixture'}},
                    'environment': {'HERMES_HOME': '/forbidden-fixture-home'},
                })
            except ValueError:
                pass
            else:
                raise AssertionError('Instance home override accepted')
            assert (home / '.env').read_bytes() == before
            assert Path(os.environ['HERMES_HOME']).resolve() == home.resolve()
            print(json.dumps({'native_provider_env_allowed': True}))
        """)
        self.assertTrue(result["native_provider_env_allowed"])

    def test_cancelled_or_unfinished_native_wizard_cannot_validate_the_old_model(self):
        (self.home / ".nora-model-candidate").write_text("fixture-candidate", encoding="utf-8")
        result = self.run_code("""
            import io, json, os, sys
            from pathlib import Path
            from types import SimpleNamespace
            from unittest.mock import Mock, patch
            from hermes_cli import main
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            before = (home / 'config.yaml').read_bytes()
            probe = Mock(side_effect=AssertionError('Unfinished wizard reached model validation'))
            class Terminal(io.StringIO):
                def isatty(self):
                    return True
            selections = [None, 'cancel', 'aux-config', 'remove-custom', 'deepseek']
            rejected = []
            for selected in selections:
                with patch.object(main, '_pick_provider', return_value=selected), \
                     patch.object(main, '_resolve_active_provider', return_value='custom'), \
                     patch.object(main, '_clear_stale_openai_base_url'), \
                     patch.dict(main._PROVIDER_MODEL_FLOWS, {'deepseek': lambda *_: None}), \
                     patch.object(main, '_aux_config_menu') as auxiliary, \
                     patch.object(main, '_remove_custom_provider') as remove, \
                     patch.dict(sys.modules, {'hermes_model_probe': SimpleNamespace(verify=probe)}), \
                     patch.object(sys, 'stdin', Terminal()):
                    try:
                        native_config.candidate_main(home, {'verify_authorized': True}, wizard=True)
                    except ValueError:
                        rejected.append(selected)
                    else:
                        raise AssertionError('Cancelled/unfinished wizard accepted')
                    auxiliary.assert_not_called()
                    remove.assert_not_called()
                assert (home / 'config.yaml').read_bytes() == before
            probe.assert_not_called()
            print(json.dumps({'rejected': len(rejected)}))
        """)
        self.assertEqual(result["rejected"], 5)

    def test_candidate_discovers_existing_user_provider_code_without_copying_it(self):
        original_home = self.root / "original-home"
        plugin = original_home / "plugins/model-providers/fixture-user-provider"
        plugin.mkdir(parents=True)
        init = plugin / "__init__.py"
        init.write_text(
            "from providers import register_provider\n"
            "from providers.base import ProviderProfile\n"
            "register_provider(ProviderProfile(name='fixture-user-provider', display_name='Fixture Provider', "
            "base_url='https://provider.fixture.invalid/v1', env_vars=('FIXTURE_USER_PROVIDER_KEY',)))\n",
            encoding="utf-8",
        )
        (plugin / "plugin.yaml").write_text("name: fixture-user-provider\nkind: model-provider\nversion: 1.0.0\n",
                                             encoding="utf-8")
        before = init.read_bytes()
        result = self.run_code("""
            import json, os, sys
            from pathlib import Path
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            original_home = Path(json.load(sys.stdin)['original_home'])
            native_config.provider_context(original_home)
            rows = native_config.catalog(home)['providers']
            assert 'fixture-user-provider' in {row['id'] for row in rows}
            assert not (home / 'plugins').exists(), 'User provider code was copied into the candidate'
            from providers import get_provider_profile
            profile = get_provider_profile('fixture-user-provider')
            assert profile.base_url == 'https://provider.fixture.invalid/v1'
            assert profile.env_vars == ('FIXTURE_USER_PROVIDER_KEY',)
            print(json.dumps({'original_provider_discovered': True}))
        """, {"original_home": str(original_home)})
        self.assertTrue(result["original_provider_discovered"])
        self.assertEqual(init.read_bytes(), before)

    @unittest.skipIf(os.name == "nt", "The real PTY acceptance uses the macOS/POSIX terminal API")
    def test_real_pty_wizard_commits_live_files_only_after_candidate_validation(self):
        import pty
        import select
        import signal
        import time

        # This is the real shipped parent entry, lock, candidate subprocess and
        # native dispatcher. Only account interaction and the paid model reply
        # are synthetic; both remain inside the actual PTY candidate child.
        (self.home / "hermes-agent").symlink_to(self.source, target_is_directory=True)
        skill = self.home / "skills/system/model-provider-config"
        shutil.copytree(SKILL, skill)
        (self.home / "scripts").mkdir()
        shutil.copy2(ROOT / "ops/scripts/nora-instance.py", self.home / "scripts/nora-instance.py")
        entry = skill / "scripts/configure_provider.py"
        tavern = self.root / "tavern"
        lock_dir = tavern / "apps/tavern-ops/updater"
        lock_dir.mkdir(parents=True)
        shutil.copy2(ROOT / "ops/updater/runtime_lock.py", lock_dir / "runtime_lock.py")
        (self.home / "nora-instance.json").write_text(json.dumps({
            "schema": 1, "noraHome": str(self.root), "hermesHome": str(self.home),
            "installRoot": str(tavern), "port": 18999,
        }), encoding="utf-8")
        marker = self.root / "installer/model.json"
        marker.parent.mkdir()
        marker.write_text('{"schema":1,"provider":"custom","model":"old-fixture-model"}', encoding="utf-8")
        paths = (self.config, self.home / ".env", self.home / "auth.json", marker)

        def snapshot():
            return {path: path.read_bytes() if path.exists() else None for path in paths}

        pipe_before = snapshot()
        pipe = subprocess.run([sys.executable, "-B", str(entry), "--wizard", "--verify-authorized"],
                              input="", env=self.env, cwd=self.source, text=True,
                              capture_output=True, timeout=15)
        self.assertEqual(pipe.returncode, 1)
        self.assertIn("PTY", pipe.stdout)
        self.assertEqual(snapshot(), pipe_before)

        guard_file = self.root / "guard/sitecustomize.py"
        guard_file.write_text(NETWORK_GUARD + r'''
if os.environ.get('NORA_MODEL_CANDIDATE'):
    import json, sys
    from types import SimpleNamespace
    from hermes_cli import main, config
    import hermes_cli.providers as provider_directory
    import agent.models_dev as model_directory
    from hermes_cli.credential_lifecycle import save_provider_env_credential
    from hermes_cli.model_setup_flows_common import _persist_model
    import hermes_cli.secret_prompt
    # The native wizard may refresh models.dev while identifying the current
    # provider. This test exercises dispatch/commit, so use its supported
    # offline directory mode rather than a remote metadata fixture.
    original_get_provider = provider_directory.get_provider
    def offline_provider(*args, **kwargs):
        kwargs['allow_network'] = False
        return original_get_provider(*args, **kwargs)
    provider_directory.get_provider = offline_provider
    original_fetch_metadata = model_directory.fetch_models_dev
    def offline_metadata(*args, **kwargs):
        kwargs['allow_network'] = False
        return original_fetch_metadata(*args, **kwargs)
    model_directory.fetch_models_dev = offline_metadata
    def selected_flow(original, current_model, args):
        assert args.region == 'cn' and args.no_browser is True
        save_provider_env_credential('DEEPSEEK_API_KEY', 'native-flow-fixture-key-not-a-credential')
        _persist_model('deepseek-pty-fixture', 'deepseek', base_url='https://api.deepseek.com/v1')
    main._pick_provider = lambda *args, **kwargs: 'deepseek'
    main._PROVIDER_MODEL_FLOWS['deepseek'] = selected_flow
    hermes_cli.secret_prompt.masked_secret_prompt = lambda *args, **kwargs: ''
    def verify(provider, model):
        assert provider == 'deepseek' and model == 'deepseek-pty-fixture'
        print('FIXTURE_VALIDATION_WAIT', flush=True)
        assert input().strip() == 'continue-fixture'
        if os.environ['NORA_FIXTURE_PROBE_OUTCOME'] == 'fail':
            raise ValueError('synthetic model reply rejected')
        return {'ok': True, 'verified': True, 'validation': 'api-response',
                'provider': provider, 'model': model, 'baseUrl': 'https://api.deepseek.com/v1'}
    sys.modules['hermes_model_probe'] = SimpleNamespace(verify=verify)
''', encoding="utf-8")
        for outcome in ("fail", "ok"):
            with self.subTest(outcome=outcome):
                before = snapshot()
                master, slave = pty.openpty()
                process = subprocess.Popen(
                    [sys.executable, "-B", str(entry), "--wizard", "--region", "cn", "--verify-authorized"],
                    stdin=slave, stdout=slave, stderr=slave,
                    env={**self.env, "NORA_FIXTURE_PROBE_OUTCOME": outcome}, cwd=self.source,
                    start_new_session=True,
                )
                os.close(slave)
                output = bytearray()
                try:
                    deadline = time.monotonic() + 20
                    while b"FIXTURE_VALIDATION_WAIT" not in output:
                        remaining = deadline - time.monotonic()
                        self.assertGreater(remaining, 0, "Wizard did not reach the candidate model verifier")
                        if select.select([master], [], [], min(remaining, 0.5))[0]:
                            try:
                                chunk = os.read(master, 65536)
                            except OSError:
                                chunk = b""
                            self.assertTrue(chunk, output.decode("utf-8", errors="replace"))
                            output.extend(chunk)
                        if process.poll() is not None:
                            self.fail(output.decode("utf-8", errors="replace"))
                    self.assertEqual(snapshot(), before, "Native wizard changed live files before validation")
                    os.write(master, b"continue-fixture\n")
                    while True:
                        remaining = deadline - time.monotonic()
                        self.assertGreater(remaining, 0, "Wizard parent did not close after validation")
                        if select.select([master], [], [], min(remaining, 0.5))[0]:
                            try:
                                chunk = os.read(master, 65536)
                            except OSError:
                                chunk = b""
                            if not chunk:
                                break
                            output.extend(chunk)
                        elif process.poll() is not None:
                            break
                    process.wait(timeout=3)
                    text = output.decode("utf-8", errors="replace")
                    self.assertNotIn(SYNTHETIC_KEY, text)
                    if outcome == "fail":
                        self.assertEqual(process.returncode, 1, text)
                        self.assertEqual(snapshot(), before)
                    else:
                        self.assertEqual(process.returncode, 0, text)
                        self.assertNotEqual(snapshot(), before)
                        actual = yaml.safe_load(self.config.read_text(encoding="utf-8"))
                        self.assertEqual(actual["model"]["provider"], "deepseek")
                        self.assertEqual(actual["model"]["default"], "deepseek-pty-fixture")
                        self.assertEqual(json.loads(marker.read_text())["validation"], "api-response")
                    self.assertFalse(self.attempts.exists(), self.attempts.read_text() if self.attempts.exists() else "")
                    self.assertFalse(list((self.root / "installer/operations").glob(".model-candidate-*")))
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGTERM)
                        try:
                            process.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait(timeout=3)
                    os.close(master)

    def test_advanced_model_and_provider_options_retain_native_fields(self):
        body = {"native_config": {
            "model": {"provider": "custom", "default": "native-relay-model",
                      "base_url": "https://fixture.invalid/v1", "api_key": SYNTHETIC_KEY,
                      "api_mode": "anthropic_messages", "native_future_model_option": {"enabled": True}},
            "providers": {"user-relay": {"name": "User relay", "base_url": "https://relay.invalid/v1",
                                          "key_env": "USER_RELAY_KEY", "extra_headers": {"X-Fixture": "keep"}}},
            "custom_providers": [{"name": "legacy", "base_url": "https://legacy.invalid/v1", "model": "keep"}],
            "moa": {"fixture_native_option": "retain-unmodified"},
        }, "environment": {"USER_RELAY_KEY": "synthetic-user-relay-key", "AWS_DEFAULT_REGION": "us-west-2"}}
        result = self.run_code("""
            import json, os, sys
            from pathlib import Path
            import yaml
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            body = json.load(sys.stdin)
            native_config.apply_selection(home, body)
            actual = yaml.safe_load((home / 'config.yaml').read_text())
            def contains(actual, expected):
                if isinstance(expected, dict):
                    return isinstance(actual, dict) and all(key in actual and contains(actual[key], value)
                                                            for key, value in expected.items())
                return actual == expected
            for section, expected in body['native_config'].items():
                assert contains(actual[section], expected), section
            from hermes_cli.config import load_env
            env = load_env()
            assert all(env.get(key) == value for key, value in body['environment'].items())
            print(json.dumps({'sections': sorted(body['native_config'])}))
        """, body)
        self.assertEqual(result["sections"], ["custom_providers", "moa", "model", "providers"])
        actual = yaml.safe_load(self.config.read_text(encoding="utf-8"))
        for key in ("mcp_servers", "fallback_providers", "platforms", "memory"):
            self.assertEqual(actual[key], self.original[key], key)

    def test_advanced_patch_preserves_unselected_native_services_and_model_options(self):
        config = dict(self.original)
        config["model"] = {**config["model"], "request_overrides": {"extra_body": {"keep": True}}}
        config["providers"] = {
            "untouched-relay": {"name": "Untouched", "base_url": "https://untouched.invalid/v1"},
            "selected-relay": {"name": "Selected", "base_url": "https://selected.invalid/v1",
                               "extra_headers": {"X-Keep": "user-choice"}},
        }
        config["custom_providers"] = [
            {"name": "untouched-legacy", "model": "keep", "base_url": "https://legacy.invalid/v1"},
            {"name": "selected-legacy", "model": "old", "base_url": "https://selected-legacy.invalid/v1",
             "extra_headers": {"X-Keep": "legacy-user-choice"}},
        ]
        config["moa"] = {"nested": {"keep": "user-option", "change": "old"}}
        self.config.write_text(yaml.safe_dump(config), encoding="utf-8")
        result = self.run_code("""
            import json, os
            from pathlib import Path
            import yaml
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            before = yaml.safe_load((home / 'config.yaml').read_text())
            native_config.apply_selection(home, {'native_config': {
                'model': {'default': 'new-fixture-model'},
                'providers': {'selected-relay': {'default_model': 'new-model'}},
                'custom_providers': [{'name': 'selected-legacy', 'model': 'new-model'}],
                'moa': {'nested': {'change': 'new'}},
            }})
            actual = yaml.safe_load((home / 'config.yaml').read_text())
            assert actual['model']['request_overrides'] == before['model']['request_overrides']
            assert actual['model']['provider'] == before['model']['provider']
            assert actual['model']['default'] == 'new-fixture-model'
            assert actual['providers']['untouched-relay'] == before['providers']['untouched-relay']
            assert actual['providers']['selected-relay']['extra_headers'] == {'X-Keep': 'user-choice'}
            assert actual['providers']['selected-relay']['default_model'] == 'new-model'
            entries = {entry['name']: entry for entry in actual['custom_providers']}
            assert entries['untouched-legacy'] == before['custom_providers'][0]
            assert entries['selected-legacy']['extra_headers'] == {'X-Keep': 'legacy-user-choice'}
            assert entries['selected-legacy']['model'] == 'new-model'
            assert actual['moa']['nested'] == {'keep': 'user-option', 'change': 'new'}
            print(json.dumps({'unselected_preserved': True}))
        """)
        self.assertTrue(result["unselected_preserved"])

    def test_unknown_provider_is_rejected_instead_of_saved_as_custom(self):
        result = self.run_code("""
            import json, os
            from pathlib import Path
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            before = (home / 'config.yaml').read_bytes()
            before_env = (home / '.env').read_bytes()
            try:
                native_config.apply_selection(home, {'provider': 'not-a-hermes-provider-fixture',
                    'model': 'model-fixture', 'api_key': 'synthetic-unrecognized-provider-key'})
            except ValueError as error:
                assert str(error).strip(), 'Missing specific rejection reason'
            else:
                raise AssertionError('Unknown provider accepted or silently changed into custom')
            assert (home / 'config.yaml').read_bytes() == before
            assert (home / '.env').read_bytes() == before_env
            print(json.dumps({'unknown_provider_rejected': True}))
        """)
        self.assertTrue(result["unknown_provider_rejected"])

    def test_advanced_config_rejects_unrelated_top_level_changes_before_writing(self):
        before = self.config.read_bytes()
        result = self.run_code("""
            import json, os
            from pathlib import Path
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            before = (home / 'config.yaml').read_bytes()
            before_env = (home / '.env').read_bytes()
            rejected = []
            for name in ('mcp_servers', 'fallback_providers', 'platforms', 'memory', 'worlds', 'unknown_future_section'):
                try:
                    native_config.apply_selection(home, {
                        'provider': 'deepseek', 'model': 'deepseek-v4-flash',
                        'native_config': {name: {'replace': 'forbidden'}},
                        'environment': {'USER_FIXTURE_KEY': 'must-not-be-partially-written'},
                    })
                except (ValueError, TypeError):
                    rejected.append(name)
                else:
                    raise AssertionError('Accepted unrelated native section: ' + name)
                assert (home / 'config.yaml').read_bytes() == before, name
                assert (home / '.env').read_bytes() == before_env, name
            print(json.dumps({'rejected': rejected}))
        """)
        self.assertEqual(len(result["rejected"]), 6)
        self.assertEqual(self.config.read_bytes(), before)

    def test_environment_rejects_process_control_variables_without_partial_writes(self):
        result = self.run_code("""
            import json, os
            from pathlib import Path
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            before = {name: (home / name).read_bytes() if (home / name).exists() else None
                      for name in ('config.yaml', '.env', 'auth.json')}
            rejected = []
            for name in ('HERMES_HOME', 'HOME', 'PATH', 'PYTHONPATH', 'LD_PRELOAD', 'INVALID=NAME'):
                try:
                    native_config.apply_selection(home, {
                        'provider': 'deepseek', 'model': 'deepseek-v4-flash',
                        'environment': {name: 'forbidden-control-value'},
                    })
                except (ValueError, TypeError):
                    rejected.append(name)
                else:
                    raise AssertionError('Accepted process control variable: ' + name)
                after = {path: (home / path).read_bytes() if (home / path).exists() else None for path in before}
                assert after == before, name
            print(json.dumps({'rejected': rejected}))
        """)
        self.assertEqual(len(result["rejected"]), 6)


if __name__ == "__main__":
    unittest.main()
