"""Nora's native Hermes model writer, with disposable homes and scoped fixtures.

Run through tooling/run.mjs so the tests exercise the shipped skill layout.
The retained Hermes source is read-only; all credentials below are synthetic.
Configuration-layer cases substitute only the provider probe in sitecustomize.
SDK and end-to-end loopback cases never claim real provider/account acceptance.
"""
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

import yaml

from ops.installer.launcher_bridge import read_verified_model
from ops.installer import launcher_bridge

if __package__:
    from .launcher_test_environment import resolve_node
else:
    from launcher_test_environment import resolve_node


ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "ops/skills/system/model-provider-config"
SYNTHETIC_KEY = "nora-fixture-only-not-a-real-credential"

# Both transport-level and logical HTTP guards are necessary: a machine-wide
# proxy can otherwise turn an external logical destination into a local socket.
NETWORK_GUARD = r'''
import os, socket, traceback
from pathlib import Path
def deny_network(*_args, **_kwargs):
    with Path(os.environ['NORA_NETWORK_ATTEMPTS']).open('a', encoding='utf-8') as stream:
        stream.write('blocked network attempt\n')
        for frame in traceback.extract_stack(limit=16)[:-1]:
            stream.write(frame.filename + ':' + str(frame.lineno) + ' ' + frame.name + '\n')
    raise AssertionError('Configuration-only test attempted network access')
socket.create_connection = deny_network
socket.getaddrinfo = deny_network
socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
import httpx
httpx.Client.send = deny_network
httpx.AsyncClient.send = deny_network
import requests
requests.sessions.Session.send = deny_network
'''

# Only the SDK wire test uses this narrower allowance. Configuration-only tests
# retain NETWORK_GUARD above and never have a permitted socket destination.
LOOPBACK_NETWORK_GUARD = r'''
import os, socket, traceback
from pathlib import Path
from urllib.parse import urlsplit
port = int(os.environ['NORA_NETWORK_ALLOWED_PORT'])
def denied():
    with Path(os.environ['NORA_NETWORK_ATTEMPTS']).open('a', encoding='utf-8') as stream:
        stream.write('blocked non-fixture network attempt\n')
        for frame in traceback.extract_stack(limit=12)[:-1]:
            stream.write(frame.filename + ':' + str(frame.lineno) + ' ' + frame.name + '\n')
    raise AssertionError('Only the selected loopback fixture port is allowed')
def check_address(address):
    if not (isinstance(address, tuple) and address[0] == '127.0.0.1' and address[1] == port):
        denied()
def check_url(url):
    parsed = urlsplit(str(url))
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.port != port:
        denied()
original_connect = socket.socket.connect
def connect(sock, address):
    check_address(address)
    return original_connect(sock, address)
socket.socket.connect = connect
original_connect_ex = socket.socket.connect_ex
def connect_ex(sock, address):
    check_address(address)
    return original_connect_ex(sock, address)
socket.socket.connect_ex = connect_ex
original_getaddrinfo = socket.getaddrinfo
def getaddrinfo(host, number, *args, **kwargs):
    check_address((host, int(number)))
    return original_getaddrinfo(host, number, *args, **kwargs)
socket.getaddrinfo = getaddrinfo
original_create_connection = socket.create_connection
def create_connection(address, *args, **kwargs):
    check_address(address)
    return original_create_connection(address, *args, **kwargs)
socket.create_connection = create_connection
import httpx
original_send = httpx.Client.send
def send(client, request, *args, **kwargs):
    check_url(request.url)
    return original_send(client, request, *args, **kwargs)
httpx.Client.send = send
original_async_send = httpx.AsyncClient.send
async def async_send(client, request, *args, **kwargs):
    check_url(request.url)
    return await original_async_send(client, request, *args, **kwargs)
httpx.AsyncClient.send = async_send
import requests
original_requests_send = requests.sessions.Session.send
def requests_send(session, request, *args, **kwargs):
    check_url(request.url)
    return original_requests_send(session, request, *args, **kwargs)
requests.sessions.Session.send = requests_send
'''

CONFIGURATION_ONLY_PROBE = r'''
# Test-only process boundary. Product code has no skip-verification switch.
if os.environ.get('NORA_FIXTURE_MODEL_PROBE') == 'configuration-layer':
    import sys, types
    fixture_probe = types.ModuleType('hermes_model_probe')
    def configuration_probe(provider, model):
        if os.environ.get('NORA_FIXTURE_PROBE_REFUSE'):
            return {'ok': False, 'verified': False, 'code': 'FIXTURE_PROBE_REFUSAL'}
        from hermes_cli.runtime_provider import resolve_runtime_provider
        import hermes_cli.providers as native_providers
        lookup = native_providers.get_provider
        try:
            native_providers.get_provider = lambda name, **kwargs: lookup(name, allow_network=False)
            runtime = resolve_runtime_provider(requested=provider, target_model=model)
        finally:
            native_providers.get_provider = lookup
        return {'ok': True, 'verified': True, 'validation': 'api-response',
                'provider': provider, 'model': model,
                'baseUrl': runtime.get('base_url', ''), 'apiMode': runtime.get('api_mode', '')}
    fixture_probe.verify = configuration_probe
    sys.modules['hermes_model_probe'] = fixture_probe
'''
NETWORK_GUARD += CONFIGURATION_ONLY_PROBE
LOOPBACK_NETWORK_GUARD += CONFIGURATION_ONLY_PROBE


class NativeModelDistributionTests(unittest.TestCase):
    def test_skill_uses_one_entry_and_shared_core_without_new_app_dependency(self):
        scripts = SKILL / "scripts"
        self.assertEqual({file.name for file in scripts.glob("*.py")}, {"configure_provider.py"})
        entry = (scripts / "configure_provider.py").read_text(encoding="utf-8")
        self.assertIn("apps/tavern-ops/installer", entry)
        self.assertIn("hermes_model_config", entry)
        for file in (scripts / "configure_provider.py", ROOT / "ops/installer/hermes_model_config.py",
                     ROOT / "ops/installer/hermes_model_probe.py", ROOT / "ops/installer/hermes_model_state.py"):
            self.assertTrue(file.is_file(), str(file))
            text = file.read_text(encoding="utf-8")
            with self.subTest(filename=file.name):
                self.assertNotIn("ensure_operation(", text)
                self.assertNotIn("operation_cli.py", text)
                self.assertNotIn("apps/tavern-ops/installer/model_config.py", text)
                self.assertNotIn("launcher-capability", text)


@unittest.skipUnless(os.environ.get("NORA_TEST_HERMES"), "Read-only installed Hermes source required")
class NativeModelIntegrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="nora-native-model-")
        self.addCleanup(temporary.cleanup)
        self.alias_root = Path(temporary.name)
        self.root = self.alias_root.resolve()
        self.home = self.root / "hermes"
        self.tavern = self.root / "tavern"
        self.home.mkdir()
        self.source = Path(os.environ["NORA_TEST_HERMES"]).resolve()
        (self.home / "hermes-agent").symlink_to(self.source, target_is_directory=True)
        self.entry = self.home / "skills/system/model-provider-config/scripts/configure_provider.py"
        shutil.copytree(SKILL, self.entry.parent.parent)
        # Core configuration components and the existing writer lock suffice.
        # No APP, receipt, operation_cli or launcher adapter is installed.
        self.core = self.tavern / "apps/tavern-ops/installer"
        self.core.mkdir(parents=True)
        for name in ("hermes_model_config.py", "hermes_model_probe.py", "hermes_model_state.py"):
            shutil.copy2(ROOT / "ops/installer" / name, self.core / name)
        lock_directory = self.tavern / "apps/tavern-ops/updater"
        lock_directory.mkdir(parents=True)
        shutil.copy2(ROOT / "ops/updater/runtime_lock.py", lock_directory / "runtime_lock.py")
        self.instance = {
            "schema": 1, "noraHome": str(self.root), "hermesHome": str(self.home),
            "installRoot": str(self.tavern), "port": 18999,
        }
        (self.home / "nora-instance.json").write_text(json.dumps(self.instance), encoding="utf-8")
        self.config = self.home / "config.yaml"
        self.initial_config = {
            "model": {"provider": "custom", "default": "old-model",
                      "base_url": "https://old.example.invalid/v1", "api_key": "old-fixture-key"},
            "fallback_providers": [{"provider": "openrouter", "model": "keep-fallback"}],
            "mcp_servers": {"nora": {"command": "keep-mcp", "args": ["unchanged"]}},
            "platforms": {"clawchat": {"enabled": True}},
            "compression": {"enabled": False},
        }
        self.config.write_text(yaml.safe_dump(self.initial_config), encoding="utf-8")
        (self.home / ".env").write_text("UNRELATED_FIXTURE_KEY=keep-env\n", encoding="utf-8")
        (self.home / "auth.json").write_text(json.dumps({
            "version": 1, "active_provider": None, "providers": {},
            "fixture_unrelated": {"preserve": "keep-auth"},
        }), encoding="utf-8")
        self.marker = self.root / "installer/model.json"
        self.marker.parent.mkdir()
        self.marker.write_text('{"schema":1,"provider":"custom","model":"old-model"}', encoding="utf-8")
        self.sentinels = {}
        for file, value in [
            (self.home / "SOUL.md", "user-personality"),
            (self.home / "USER.md", "user-profile"),
            (self.home / "MEMORY.md", "user-memory"),
            (self.tavern / "tavern-state/native/config.yaml", "tavern-model-keep"),
            (self.tavern / "tavern-state/native/chats/story.jsonl", "chat-keep"),
            (self.tavern / "tavern-state/native/characters/card.json", "character-keep"),
            (self.tavern / "tavern-state/native/worlds/world.json", "world-keep"),
        ]:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(value, encoding="utf-8")
            self.sentinels[file] = file.read_bytes()
        guard = self.root / "network-guard"
        guard.mkdir()
        self.guard_file = guard / "sitecustomize.py"
        self.guard_file.write_text(NETWORK_GUARD, encoding="utf-8")
        self.network_attempts = self.root / "network-attempts.txt"
        # Do not inherit provider credentials, proxies, Hermes config homes or
        # shell overrides from the developer's running Nora instance.
        self.env = {
            "PATH": os.environ.get("PATH", ""), "HOME": str(self.home),
            "USERPROFILE": str(self.home), "HERMES_HOME": str(self.home),
            "NORA_TAVERN_HOME": str(self.root), "TAVERN_DATA_ROOT": str(self.tavern),
            "NO_PROXY": "*", "no_proxy": "*", "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8",
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "NORA_NETWORK_ATTEMPTS": str(self.network_attempts),
            "NORA_FIXTURE_MODEL_PROBE": "configuration-layer",
            "PYTHONPATH": os.pathsep.join((str(guard), str(self.source), str(self.core))),
        }
        self.request = {"provider": "opencode-go", "model": "glm-5", "api_key": SYNTHETIC_KEY,
                        "verify_authorized": True}

    def snapshot(self):
        return {path: path.read_bytes() if path.exists() else None
                for path in (self.config, self.home / ".env", self.home / "auth.json", self.marker)}

    def assert_snapshot(self, before):
        self.assertEqual(self.snapshot(), before)

    def assert_preserved(self):
        for file, contents in self.sentinels.items():
            self.assertEqual(file.read_bytes(), contents, str(file))
        config = yaml.safe_load(self.config.read_text(encoding="utf-8"))
        for key in ("fallback_providers", "mcp_servers", "platforms", "compression"):
            self.assertEqual(config[key], self.initial_config[key], key)
        self.assertIn("UNRELATED_FIXTURE_KEY=keep-env", (self.home / ".env").read_text(encoding="utf-8"))
        self.assertEqual(json.loads((self.home / "auth.json").read_text())["fixture_unrelated"],
                         {"preserve": "keep-auth"})

    def run_python(self, code, body=None, *, timeout=25):
        result = subprocess.run([sys.executable, "-B", "-c", textwrap.dedent(code)],
                                cwd=self.source, env=self.env,
                                input=json.dumps(body or {}), text=True, capture_output=True, timeout=timeout)
        self.assertNotIn(SYNTHETIC_KEY, result.stdout + result.stderr)
        self.assertFalse(self.network_attempts.exists(), self.network_attempts.read_text()
                         if self.network_attempts.exists() else "")
        return result

    def invoke(self, body=None):
        body = dict(self.request if body is None else body)
        if body.get("action", "save") == "save":
            body.setdefault("verify_authorized", True)
        result = subprocess.run([sys.executable, "-B", str(self.entry)], cwd=self.source,
                                env=self.env, input=json.dumps(body) + "\n",
                                text=True, capture_output=True, timeout=25)
        self.assertNotIn(SYNTHETIC_KEY, result.stdout + result.stderr)
        self.assertFalse(self.network_attempts.exists(), self.network_attempts.read_text()
                         if self.network_attempts.exists() else "")
        lines = result.stdout.strip().splitlines()
        self.assertTrue(lines, result.stderr)
        return result, json.loads(lines[-1])

    def native_runtime(self):
        result = self.run_python("""
            import json
            from unittest.mock import patch
            from hermes_cli.config import load_config
            from hermes_cli.runtime_provider import resolve_runtime_provider
            import hermes_cli.providers as native_providers
            selected_model = load_config()['model']['default']
            # Observe the real resolver's persisted selection without asking
            # Hermes to refresh models.dev during this offline inspection.
            get_provider = native_providers.get_provider
            def cached_provider(*args, **kwargs):
                kwargs['allow_network'] = False
                return get_provider(*args, **kwargs)
            with patch.object(native_providers, 'get_provider', side_effect=cached_provider):
                runtime = resolve_runtime_provider(target_model=selected_model)
            from agent.opencode_affinity import opencode_session_headers
            headers = opencode_session_headers(runtime.get('provider'), runtime.get('base_url'), 'fixture-conversation')
            print(json.dumps({'provider': runtime.get('provider'), 'model': runtime.get('model') or selected_model,
                'apiMode': runtime.get('api_mode'), 'baseUrl': runtime.get('base_url'),
                'keyMatches': runtime.get('api_key') == 'nora-fixture-only-not-a-real-credential',
                'sessionPresent': bool(headers.get('x-opencode-session')),
                'sessionStable': headers == opencode_session_headers(runtime.get('provider'), runtime.get('base_url'), 'fixture-conversation')}))
        """)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout.strip().splitlines()[-1])

    def test_go_from_zero_uses_native_default_url_and_three_protocols(self):
        for model, protocol in (("glm-5", "chat_completions"),
                                ("minimax-m2.7", "anthropic_messages"),
                                ("gpt-5.4", "codex_responses")):
            with self.subTest(model=model):
                result, reply = self.invoke({**self.request, "model": model})
                self.assertEqual(result.returncode, 0, reply)
                self.assertTrue(reply["ok"])
                runtime = self.native_runtime()
                self.assertEqual(runtime["provider"], "opencode-go")
                self.assertEqual(runtime["model"], model)
                self.assertEqual(runtime["apiMode"], protocol)
                self.assertIn("opencode.ai", runtime["baseUrl"])
                self.assertTrue(runtime["keyMatches"])
                self.assertTrue(runtime["sessionPresent"])
                self.assertTrue(runtime["sessionStable"])
                self.assertEqual(read_verified_model(self.root, self.home).get("provider"), "opencode-go")
                self.assert_preserved()

    def test_go_marker_keeps_old_schema_and_contains_no_credentials(self):
        result, reply = self.invoke()
        self.assertEqual(result.returncode, 0, reply)
        marker = json.loads(self.marker.read_text(encoding="utf-8"))
        self.assertEqual(marker["schema"], 1)
        self.assertEqual(marker["provider"], "opencode-go")
        self.assertEqual(marker["model"], "glm-5")
        self.assertFalse(marker.get("tavernSyncPending"))
        self.assertFalse(marker.get("hermesNative"), "Old launcher must not require a new marker reader")
        self.assertNotIn("verifiedAt", marker)
        self.assertNotIn(SYNTHETIC_KEY, self.marker.read_text(encoding="utf-8"))
        self.assertTrue(read_verified_model(self.root, self.home))
        self.assertEqual({file.name for file in self.core.iterdir()}, {
            "hermes_model_config.py", "hermes_model_probe.py", "hermes_model_state.py"})
        self.assertFalse((self.core / "model_config.py").exists())
        self.assertFalse((self.core / "operation_cli.py").exists())

    def test_saved_go_configuration_drives_three_real_native_sdk_transports_on_loopback(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(handler):
                body = json.loads(handler.rfile.read(int(handler.headers.get("Content-Length", "0"))))
                received.append({"path": handler.path, "headers": dict(handler.headers), "body": body})
                model = body.get("model")
                if handler.path.endswith("/messages"):
                    events = [
                        ("message_start", {"type": "message_start", "message": {
                            "id": "msg-fixture", "type": "message", "role": "assistant", "model": model,
                            "content": [], "stop_reason": None, "stop_sequence": None,
                            "usage": {"input_tokens": 1, "output_tokens": 0}}}),
                        ("content_block_start", {"type": "content_block_start", "index": 0,
                                                 "content_block": {"type": "text", "text": ""}}),
                        ("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                 "delta": {"type": "text_delta", "text": "NORA_OK"}}),
                        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                        ("message_delta", {"type": "message_delta", "delta": {
                            "stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
                        ("message_stop", {"type": "message_stop"}),
                    ]
                elif handler.path.endswith("/responses"):
                    item = {"id": "msg-fixture", "type": "message", "role": "assistant", "status": "completed",
                            "content": [{"type": "output_text", "text": "NORA_OK", "annotations": []}]}
                    events = [
                        ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
                        ("response.completed", {"type": "response.completed", "response": {
                            "id": "resp-fixture", "object": "response", "status": "completed", "model": model,
                            "output": [item], "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}}),
                    ]
                else:
                    events = None
                if events is None:
                    payload = json.dumps({"id": "chat-fixture", "object": "chat.completion", "model": model,
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "NORA_OK"},
                                     "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
                    content_type = "application/json"
                else:
                    payload = "".join("event: " + kind + "\ndata: " + json.dumps(value) + "\n\n"
                                      for kind, value in events).encode()
                    content_type = "text/event-stream"
                handler.send_response(200)
                handler.send_header("Content-Type", content_type)
                handler.send_header("Content-Length", str(len(payload)))
                handler.end_headers()
                handler.wfile.write(payload)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_port}/v1"
        native_call = """
            import json
            from hermes_cli.config import load_config
            from hermes_cli.runtime_provider import resolve_runtime_provider
            from agent.auxiliary_client import resolve_provider_client, _build_call_kwargs
            from agent.portal_tags import set_conversation_context, reset_conversation_context
            selected = load_config()['model']
            runtime = resolve_runtime_provider(target_model=selected['default'])
            client, model = resolve_provider_client(selected['provider'], model=selected['default'],
                explicit_base_url=runtime['base_url'], explicit_api_key=runtime['api_key'],
                api_mode=runtime['api_mode'], main_runtime=runtime)
            assert client is not None and model == selected['default']
            context = set_conversation_context('fixture-same-conversation')
            try:
                for _ in range(2):
                    kwargs = _build_call_kwargs(selected['provider'], model,
                        [{'role': 'user', 'content': 'Return NORA_OK'}], max_tokens=24,
                        timeout=5, base_url=runtime['base_url'])
                    result = client.chat.completions.create(**kwargs)
                    assert result.choices[0].message.content == 'NORA_OK'
            finally:
                reset_conversation_context(context)
                client.close()
            print('native SDK fixture calls passed')
        """
        for model, expected_path in (("glm-5", "/v1/chat/completions"),
                                     ("minimax-m2.7", "/v1/messages"),
                                     ("gpt-5.4", "/v1/responses")):
            with self.subTest(model=model):
                # Saving still runs with the original zero-network guard.
                self.guard_file.write_text(NETWORK_GUARD, encoding="utf-8")
                result, reply = self.invoke({**self.request, "model": model, "base_url": base})
                self.assertEqual(result.returncode, 0, reply)
                self.guard_file.write_text(LOOPBACK_NETWORK_GUARD, encoding="utf-8")
                self.env["NORA_NETWORK_ALLOWED_PORT"] = str(server.server_port)
                first = len(received)
                called = self.run_python(native_call, timeout=30)
                self.assertEqual(called.returncode, 0, called.stdout + called.stderr)
                rows = received[first:]
                self.assertEqual(len(rows), 2)
                sessions = []
                for row in rows:
                    self.assertEqual(row["path"], expected_path)
                    self.assertEqual(row["body"]["model"], model)
                    headers = {key.lower(): value for key, value in row["headers"].items()}
                    self.assertTrue(headers.get("x-opencode-session"))
                    self.assertTrue(headers.get("user-agent"))
                    if model != "minimax-m2.7":
                        self.assertIn("hermes", headers["user-agent"].lower())
                    # Native Anthropic attribution is official-host gated. A
                    # localhost override intentionally gets generic SDK UA;
                    # the official-host constructor is checked separately.
                    sessions.append(headers["x-opencode-session"])
                self.assertEqual(sessions[0], sessions[1])
                self.assert_preserved()

    def test_official_go_host_constructs_native_hermes_user_agent_without_a_request(self):
        for model in ("glm-5", "minimax-m2.7", "gpt-5.4"):
            with self.subTest(model=model):
                result, reply = self.invoke({**self.request, "model": model})
                self.assertEqual(result.returncode, 0, reply)
                constructed = self.run_python("""
                    from hermes_cli.config import load_config
                    from hermes_cli.runtime_provider import resolve_runtime_provider
                    from agent.auxiliary_client import resolve_provider_client
                    selected = load_config()['model']
                    runtime = resolve_runtime_provider(target_model=selected['default'])
                    assert 'opencode.ai' in runtime['base_url']
                    client, model = resolve_provider_client(selected['provider'], model=selected['default'],
                        explicit_base_url=runtime['base_url'], explicit_api_key=runtime['api_key'],
                        api_mode=runtime['api_mode'], main_runtime=runtime)
                    assert client is not None and model == selected['default']
                    try:
                        leaf = getattr(client, '_real_client', client)
                        headers = {key.lower(): value for key, value in leaf.default_headers.items()}
                        assert 'hermes' in headers.get('user-agent', '').lower()
                    finally:
                        client.close()
                    print('official native client attribution constructed; no request')
                """)
                self.assertEqual(constructed.returncode, 0, constructed.stdout + constructed.stderr)
                self.assert_preserved()

    def test_real_entry_candidate_probe_commits_only_after_loopback_success_and_can_retry(self):
        # Unlike configuration-layer fixtures above, this exercises the actual
        # native_probe/AIAgent request path in the real candidate subprocess.
        received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(handler):
                body = json.loads(handler.rfile.read(int(handler.headers.get("Content-Length", "0"))))
                accepted = handler.headers.get("Authorization") == "Bearer " + SYNTHETIC_KEY
                received.append({"path": handler.path, "model": body.get("model") or body.get("name"), "accepted": accepted,
                                 "session": handler.headers.get("x-opencode-session"),
                                 "userAgent": handler.headers.get("User-Agent"), "fields": sorted(body)})
                if handler.path == "/api/show":
                    # Native Hermes checks localhost for Ollama capabilities;
                    # this metadata probe is not a model generation request.
                    payload = b'{"model_info":{},"capabilities":[]}'
                    status = 200
                elif not body.get("model"):
                    payload = b'{"error":{"type":"invalid_request_error","message":"fixture model required"}}'
                    status = 400
                elif not accepted:
                    # Deliberately hostile response text: the public failure
                    # must never include an echoed synthetic credential.
                    payload = json.dumps({"error": {"type": "authentication_error", "message":
                        "fixture refused " + str(handler.headers.get("Authorization"))}}).encode()
                    status = 401
                else:
                    payload = json.dumps({"id": "probe-fixture", "object": "chat.completion", "model": body["model"],
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"},
                                     "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
                    status = 200
                handler.send_response(status)
                handler.send_header("Content-Type", "application/json")
                handler.send_header("Content-Length", str(len(payload)))
                handler.end_headers()
                handler.wfile.write(payload)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.guard_file.write_text(LOOPBACK_NETWORK_GUARD, encoding="utf-8")
        self.env.pop("NORA_FIXTURE_MODEL_PROBE")
        self.env["NORA_NETWORK_ALLOWED_PORT"] = str(server.server_port)
        request = {**self.request, "base_url": f"http://127.0.0.1:{server.server_port}/v1"}
        result, reply = self.invoke(request)
        self.assertEqual(result.returncode, 0, reply)
        self.assertEqual(reply["validation"], "api-response")
        self.assertTrue(reply["verified"])
        good = self.snapshot()
        self.assertTrue(read_verified_model(self.root, self.home))
        calls = [row for row in received if row["path"] != "/api/show"]
        self.assertTrue(calls and all(row["accepted"] for row in calls))
        received.clear()
        bad_key = "wrong-loopback-fixture-credential"
        result, reply = self.invoke({**request, "api_key": bad_key})
        self.assertNotEqual(result.returncode, 0, reply)
        self.assertFalse(reply["ok"])
        self.assertNotIn(bad_key, result.stdout + result.stderr)
        self.assertEqual(self.snapshot(), good)
        calls = [row for row in received if row["path"] != "/api/show"]
        self.assertTrue(calls and all(not row["accepted"] for row in calls), repr(received))
        self.assertTrue(all(row["path"] == "/v1/chat/completions" and row["model"] == "glm-5"
                            for row in calls), "Failure invoked a different route/model: " + repr(received))
        self.assertTrue(all(row["path"] in {"/api/show", "/v1/chat/completions"} for row in received))
        received.clear()
        result, reply = self.invoke(request)
        self.assertEqual(result.returncode, 0, reply)
        self.assertTrue(reply["verified"])
        calls = [row for row in received if row["path"] != "/api/show"]
        self.assertTrue(calls and all(row["accepted"] for row in calls))
        for row in calls:
            self.assertEqual(row["path"], "/v1/chat/completions")
            self.assertEqual(row["model"], "glm-5")
            self.assertTrue(row["session"])
            self.assertIn("hermes", row["userAgent"].lower())
        self.assert_preserved()

    def test_old_bridge_dispatches_start_and_stop_after_skill_go_configuration(self):
        # This is an admission/dispatch regression, not a real gateway login or
        # native runtime acceptance. Service side effects are mocked explicitly.
        result, reply = self.invoke()
        self.assertEqual(result.returncode, 0, reply)
        args = SimpleNamespace(nora_home=self.root, hermes_home=self.home, install_root=self.tavern,
                               port=18999, service="nora", command="start")
        with patch.object(launcher_bridge, "installed", return_value=True), \
             patch.object(launcher_bridge.nora_system, "update_recovery", return_value=None), \
             patch.object(launcher_bridge.nora_system, "installation_state",
                          return_value={"ready": True, "setupCompleted": False}), \
             patch.object(launcher_bridge, "clawchat_paired", return_value=True), \
             patch.object(launcher_bridge, "sync_nora_profile"), \
             patch.object(launcher_bridge, "env_for", return_value={}), \
             patch.object(launcher_bridge, "python_command", return_value=sys.executable), \
             patch.object(launcher_bridge, "start_gateway") as start, \
             patch.object(launcher_bridge, "stop_gateway") as stop, \
             patch.object(launcher_bridge, "status_payload", return_value={
                 "running": False, "gatewayRunning": True, "clawchatConnected": True}) as status, \
             contextlib.redirect_stdout(io.StringIO()):
            # read_verified_model remains real: a Go record that the unchanged
            # old launcher rejects would fail before start_gateway dispatch.
            launcher_bridge.command_start(args)
            start.assert_called_once()
            status.return_value = {"running": False, "gatewayRunning": False, "clawchatConnected": False}
            launcher_bridge.command_stop(args)
            stop.assert_called_once_with(self.root, hermes_home=self.home, preserve_liveware_home=self.home)
        self.assert_preserved()

    def test_deepseek_previous_default_and_key_rotation_stay_compatible(self):
        initial, initial_reply = self.invoke({"provider": "deepseek", "api_key": "old-deepseek-fixture-key"})
        self.assertEqual(initial.returncode, 0, initial_reply)
        self.assertNotIn("old-deepseek-fixture-key", initial.stdout + initial.stderr)
        result, reply = self.invoke({"provider": "deepseek", "api_key": SYNTHETIC_KEY})
        self.assertEqual(result.returncode, 0, reply)
        verified = read_verified_model(self.root, self.home)
        self.assertEqual(verified["provider"], "deepseek")
        self.assertEqual(verified["model"], "deepseek-v4-flash")
        self.assertTrue(self.native_runtime()["keyMatches"])
        self.assert_preserved()

    def test_custom_replaces_old_named_runtime_without_altering_the_old_provider(self):
        config = yaml.safe_load(self.config.read_text())
        config["model"]["provider"] = "custom:old-relay"
        old_entry = {"name": "old-relay", "model": "old-model", "base_url": "https://old.example.invalid/v1",
                     "api_key": "old-fixture-key", "api_mode": "anthropic_messages"}
        config["custom_providers"] = [old_entry]
        self.config.write_text(yaml.safe_dump(config), encoding="utf-8")
        seeded = self.run_python("""
            from hermes_cli.runtime_provider import resolve_runtime_provider
            resolve_runtime_provider()
            print('old native credential pool seeded')
        """)
        self.assertEqual(seeded.returncode, 0, seeded.stdout + seeded.stderr)
        result, reply = self.invoke({"provider": "custom", "model": "new-model", "api_key": SYNTHETIC_KEY,
                                     "base_url": "https://new.example.invalid/v1"})
        self.assertEqual(result.returncode, 0, reply)
        current = yaml.safe_load(self.config.read_text())
        self.assertEqual(current["custom_providers"][0], old_entry)
        runtime = self.native_runtime()
        self.assertEqual(runtime["model"], "new-model")
        self.assertEqual(runtime["baseUrl"], "https://new.example.invalid/v1")
        self.assertTrue(runtime["keyMatches"])
        self.assertTrue(read_verified_model(self.root, self.home))
        self.assert_preserved()

    def test_custom_no_auth_is_accepted_by_the_unchanged_launcher_reader(self):
        result, reply = self.invoke({"provider": "custom", "model": "local-model", "auth_mode": "none",
                                     "base_url": "http://127.0.0.1:11434/v1"})
        self.assertEqual(result.returncode, 0, reply)
        verified = read_verified_model(self.root, self.home)
        self.assertEqual(verified["model"], "local-model")
        self.assertEqual(verified["authMode"], "none")
        self.assert_preserved()

    def test_catalog_and_inspect_do_not_modify_configuration(self):
        before = self.snapshot()
        for action in ("catalog", "inspect"):
            with self.subTest(action=action):
                result, reply = self.invoke({"action": action})
                self.assertEqual(result.returncode, 0, reply)
                self.assertTrue(reply["ok"])
                if action == "catalog":
                    self.assertIn("opencode-go", {item["id"] for item in reply["providers"]})
                    self.assertIn("custom", {item["id"] for item in reply["providers"]})
                self.assert_snapshot(before)
        self.assert_preserved()

    def test_failed_marker_write_restores_config_env_auth_and_marker(self):
        before = self.snapshot()
        result = self.run_python("""
            import json
            from pathlib import Path
            from unittest.mock import patch
            import hermes_model_config as native_config
            home = Path(__import__('os').environ['HERMES_HOME'])
            instance = json.loads((home / 'nora-instance.json').read_text())
            def marker_failure(marker, value):
                (home / 'config.yaml').write_text('changed config')
                (home / '.env').write_text('changed env')
                (home / 'auth.json').write_text('changed auth')
                marker.write_text('changed marker')
                raise OSError('fixture final write failure')
            with patch.object(native_config, '_write_marker', side_effect=marker_failure):
                try:
                    native_config.configure(home, instance, json.load(__import__('sys').stdin))
                except native_config.ModelConfigurationFailure as error:
                    assert error.code == 'MODEL_CONFIG_RESTORED'
                    assert error.failure_phase == 'restored'
                    assert isinstance(error.__cause__, OSError)
                    assert str(error.__cause__) == 'fixture final write failure'
                else:
                    raise AssertionError('Final write failure was reported as success')
            print('rollback observed')
        """, self.request)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_snapshot(before)
        self.assert_preserved()
        retried, reply = self.invoke()
        self.assertEqual(retried.returncode, 0, reply)
        self.assertEqual(read_verified_model(self.root, self.home).get("provider"), "opencode-go")
        self.assert_preserved()

    def test_failure_removes_new_config_artifacts_instead_of_leaving_half_written_secrets(self):
        for path in (self.home / ".env", self.home / "auth.json", self.marker):
            path.unlink()
        before = self.snapshot()
        result = self.run_python("""
            import json, os, sys
            from pathlib import Path
            from unittest.mock import patch
            import hermes_model_config as native_config
            home = Path(os.environ['HERMES_HOME'])
            instance = json.loads((home / 'nora-instance.json').read_text())
            with patch.object(native_config, '_write_marker', side_effect=OSError('fixture marker failure')):
                try:
                    native_config.configure(home, instance, json.load(sys.stdin))
                except native_config.ModelConfigurationFailure as error:
                    assert error.code == 'MODEL_CONFIG_RESTORED'
                    assert error.failure_phase == 'restored'
                    assert isinstance(error.__cause__, OSError)
                    assert str(error.__cause__) == 'fixture marker failure'
                else:
                    raise AssertionError('Failure was reported as success')
            print('absent artifacts restored')
        """, self.request)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_snapshot(before)
        for file, contents in self.sentinels.items():
            self.assertEqual(file.read_bytes(), contents)

    def test_candidate_probe_refusal_keeps_old_configuration(self):
        before = self.snapshot()
        # The verifier now runs in a child. Patching the parent's cached
        # resolver would not test it; inject a child verification refusal.
        self.env["NORA_FIXTURE_PROBE_REFUSE"] = "1"
        result, reply = self.invoke()
        self.assertNotEqual(result.returncode, 0, reply)
        self.assert_snapshot(before)
        self.assert_preserved()

    def test_same_writer_lock_prevents_competing_configuration_changes(self):
        spec = importlib.util.spec_from_file_location("nora_fixture_runtime_lock", ROOT / "ops/updater/runtime_lock.py")
        lock_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(lock_module)
        before = self.snapshot()
        with lock_module.installation_lock(self.root / "installer/operations", ".writer.lock", blocking=False) as acquired:
            self.assertTrue(acquired)
            result, reply = self.invoke()
        self.assertNotEqual(result.returncode, 0, reply)
        self.assertFalse(reply["ok"])
        self.assert_snapshot(before)
        # Exercise the unchanged launcher's actual native lock too: a second
        # Python flock alone would not establish Node/Python lock compatibility.
        node = resolve_node(required=True)
        script = """
            const lock = require(process.argv[1]).acquire({directory: process.argv[2]});
            process.stdout.write('held\\n');
            process.stdin.once('data', () => {lock.release(); process.exit(0);});
            setTimeout(() => {lock.release(); process.exit(2);}, 15000).unref();
        """
        actor = subprocess.Popen([node, "-e", textwrap.dedent(script),
            str(ROOT / "ops/installer/desktop/os-lock.js"), str(self.root / "installer")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        try:
            held = actor.stdout.readline()
            if held != "held\n":
                _stdout, error = actor.communicate(timeout=5)
                self.fail("Old launcher native lock did not acquire: " + error)
            result, reply = self.invoke()
            self.assertNotEqual(result.returncode, 0, reply)
            self.assertFalse(reply["ok"])
            self.assert_snapshot(before)
        finally:
            try:
                _stdout, error = actor.communicate(input="release\n" if actor.poll() is None else None, timeout=5)
            except subprocess.TimeoutExpired:
                actor.kill()
                actor.communicate(timeout=5)
                raise
        self.assertEqual(actor.returncode, 0, error)
        result, reply = self.invoke()
        self.assertEqual(result.returncode, 0, reply)
        self.assertTrue(read_verified_model(self.root, self.home))
        self.assert_preserved()

    def test_unsupported_auth_and_invalid_inputs_never_mutate_the_old_configuration(self):
        before = self.snapshot()
        requests = [
            {**self.request, "auth_mode": "oauth"},
            {"provider": "custom", "model": "fixture", "api_key": SYNTHETIC_KEY,
             "auth_mode": "oauth", "base_url": "https://example.invalid/v1"},
            {**self.request, "api_key": ""},
            {**self.request, "api_key": "invalid key with spaces"},
            {**self.request, "model": ""},
            {**self.request, "unknown_field": "unsupported"},
            {"provider": "custom", "model": "fixture", "api_key": SYNTHETIC_KEY,
             "base_url": "https://user:password@example.invalid/v1"},
            {"provider": "custom", "model": "fixture", "api_key": SYNTHETIC_KEY,
             "base_url": "https://example.invalid/v1?token=private"},
        ]
        for number, request in enumerate(requests):
            with self.subTest(request=number):
                # Each invalid attempt starts from the original instance, so
                # one regression cannot cascade into unrelated subtest noise.
                for file, contents in before.items():
                    if contents is None:
                        file.unlink(missing_ok=True)
                    else:
                        file.write_bytes(contents)
                result, reply = self.invoke(request)
                self.assertNotEqual(result.returncode, 0, reply)
                self.assertFalse(reply["ok"])
                self.assert_snapshot(before)
        self.assert_preserved()

    def test_invalid_config_does_not_trigger_hermes_automatic_repair_or_leak_its_source(self):
        secret = "synthetic-malformed-yaml-private-value"
        auth = self.home / "auth.json"
        original_config, original_auth = self.config.read_bytes(), auth.read_bytes()
        for file, invalid in ((self.config, 'model:\n  api_key: "' + secret + '\n'),
                              (auth, '{"providers":{"fixture":{"api_key":"' + secret)):
            self.config.write_bytes(original_config)
            auth.write_bytes(original_auth)
            file.write_text(invalid, encoding="utf-8")
            before = self.snapshot()
            for action in ("catalog", "inspect", "save"):
                with self.subTest(file=file.name, action=action):
                    result, reply = self.invoke({**self.request, "action": action})
                    if file == auth and action == "inspect":
                        # Reading the saved default must not load/repair unrelated
                        # native login credentials. It is not an auth validation.
                        self.assertEqual(result.returncode, 0, reply)
                        self.assertEqual(reply["model"], "old-model")
                    else:
                        self.assertNotEqual(result.returncode, 0, reply)
                    self.assertNotIn(secret, result.stdout + result.stderr)
                    self.assert_snapshot(before)
        self.assertFalse(list(self.home.glob("*.bak")))
        self.assertFalse((self.home / "auth.json.corrupt").exists())
        self.assertFalse((self.home / "backups").exists())

    def test_mismatched_instance_and_redirected_marker_cannot_modify_other_files(self):
        instance_file = self.home / "nora-instance.json"
        original = instance_file.read_bytes()
        before = self.snapshot()
        instance = dict(self.instance, noraHome=str(self.root.parent))
        instance_file.write_text(json.dumps(instance), encoding="utf-8")
        result, _reply = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assert_snapshot(before)
        instance_file.write_bytes(original)
        outside = self.root / "outside-marker.json"
        outside.write_text("outside must remain", encoding="utf-8")
        self.marker.unlink()
        self.marker.symlink_to(outside)
        result, _reply = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(outside.read_text(), "outside must remain")
        self.assertEqual(self.config.read_bytes(), before[self.config])
        self.assertEqual((self.home / ".env").read_bytes(), before[self.home / ".env"])

    def test_existing_instance_paths_accept_the_same_canonical_macos_directory(self):
        # Existing records may contain macOS' /var spelling while HERMES_HOME
        # resolves to /private/var. This is the same owned directory, unlike a
        # redirected config/marker file, and entry validation already accepts it.
        if self.alias_root == self.root:
            self.skipTest("This platform has no alternate spelling for its temp directory")
        record = dict(self.instance, noraHome=str(self.alias_root),
                      hermesHome=str(self.alias_root / "hermes"),
                      installRoot=str(self.alias_root / "tavern"))
        (self.home / "nora-instance.json").write_text(json.dumps(record), encoding="utf-8")
        result, reply = self.invoke()
        self.assertEqual(result.returncode, 0, reply)
        self.assertTrue(read_verified_model(self.root, self.home))
        self.assert_preserved()


if __name__ == "__main__":
    unittest.main()
