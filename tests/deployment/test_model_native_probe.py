"""Native Hermes probe boundaries; disposable homes and synthetic credentials only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]
PROBE = ROOT / "ops/installer/hermes_model_probe.py"
KEY = "probe-fixture-key-not-an-account"
GUARD = '''
import os, socket, traceback
from pathlib import Path
def deny(*args, **kwargs):
    with Path(os.environ['NORA_NETWORK_ATTEMPTS']).open('a') as stream:
        stream.write('network denied\\n')
        for frame in traceback.extract_stack(limit=12)[:-1]:
            stream.write(frame.filename + ':' + str(frame.lineno) + ' ' + frame.name + '\\n')
    raise AssertionError('Native probe offline test attempted network')
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


@unittest.skipUnless(os.environ.get("NORA_TEST_HERMES"), "Read-only installed Hermes source required")
class NativeProbeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="nora-native-probe-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "candidate"
        self.home.mkdir()
        self.source = Path(os.environ["NORA_TEST_HERMES"]).resolve()
        self.config = {
            "model": {"provider": "custom:probe", "default": "probe-model", "context_length": 128000},
            "providers": {"probe": {"name": "probe", "base_url": "http://127.0.0.1:19999/v1",
                "api_key": KEY, "api_mode": "chat_completions", "extra_headers": {"X-Probe": "native-header"},
                "extra_body": {"repetition_penalty": 1.1}}},
            "fallback_providers": [{"provider": "openrouter", "model": "forbidden-fallback"}],
            "compression": {"enabled": False},
        }
        (self.home / "config.yaml").write_text(yaml.safe_dump(self.config), encoding="utf-8")
        for name in ("SOUL.md", "USER.md", "MEMORY.md"):
            (self.home / name).write_text("PRIVATE-CONTEXT-MUST-NOT-BE-SENT", encoding="utf-8")
        guard = self.root / "guard"
        guard.mkdir()
        (guard / "sitecustomize.py").write_text(GUARD, encoding="utf-8")
        self.attempts = self.root / "network-attempts"
        self.env = {"PATH": os.environ.get("PATH", ""), "HOME": str(self.home), "USERPROFILE": str(self.home),
            "HERMES_HOME": str(self.home), "HERMES_SAFE_MODE": "1", "HERMES_ENABLE_PROJECT_PLUGINS": "0",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1", "PYTHONIOENCODING": "utf-8",
            "XDG_CACHE_HOME": str(self.root / "cache"), "NO_PROXY": "*", "no_proxy": "*",
            "NORA_NETWORK_ATTEMPTS": str(self.attempts),
            "PYTHONPATH": os.pathsep.join((str(guard), str(self.source), str(PROBE.parent)))}

    def run_case(self, body):
        script = '''
import importlib.util, io, json, os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('probe_under_test', PROBE_PATH)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
from run_agent import AIAgent
# This loopback fixture represents an OpenAI-compatible server, not Ollama.
# Replace only native local-server metadata discovery; no HTTP is allowed.
from agent import model_metadata
model_metadata.detect_local_server_type = lambda *args, **kwargs: None
def answer(content='OK'):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=None),
        finish_reason='stop')], usage=None)
'''.replace("PROBE_PATH", repr(str(PROBE))) + textwrap.dedent(body)
        result = subprocess.run([sys.executable, "-B", "-c", script], env=self.env, cwd=self.home,
                                text=True, capture_output=True, timeout=45)
        self.assertNotIn(KEY, result.stdout + result.stderr)
        self.assertNotIn("synthetic-access-token", result.stdout + result.stderr)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.attempts.exists(), self.attempts.read_text() if self.attempts.exists() else "")
        return json.loads(result.stdout.splitlines()[-1])

    def test_native_builder_preserves_custom_parameters_and_only_sends_fixed_input(self):
        reply = self.run_case('''
        observed = {}
        def dispatch(agent, kwargs):
            observed.update(calls=observed.get('calls', 0)+1,
                fixed=[item['content'] for item in kwargs['messages']], tools=kwargs.get('tools'),
                fallback=agent._fallback_chain, header=agent._client_kwargs['default_headers'].get('X-Probe'),
                body=kwargs.get('extra_body', {}).get('repetition_penalty'),
                context_disabled=agent.skip_context_files and not agent.load_soul_identity,
                review_disabled=agent.skip_background_review)
            return answer()
        with patch.object(AIAgent, '_interruptible_api_call', dispatch):
            result = probe.verify('custom:probe', 'probe-model')
        print(json.dumps({'result':result, 'observed':observed}))
        ''')
        self.assertTrue(reply["result"]["verified"])
        self.assertEqual(reply["result"]["validation"], "api-response")
        facts = reply["observed"]
        self.assertEqual(facts["calls"], 1)
        self.assertEqual(facts["header"], "native-header")
        self.assertEqual(facts["body"], 1.1)
        self.assertFalse(facts["tools"])
        self.assertFalse(facts["fallback"])
        self.assertTrue(facts["context_disabled"] and facts["review_disabled"])
        self.assertEqual(facts["fixed"], ["This is a model connectivity check. Reply briefly.", "Reply with OK."])
        self.assertNotIn("PRIVATE-CONTEXT", json.dumps(reply))

    def test_empty_response_and_secret_bearing_sdk_error_are_not_success_or_fallback(self):
        reply = self.run_case('''
        with patch.object(AIAgent, '_interruptible_api_call', return_value=answer(' ')) as empty_call:
            empty = probe.verify('custom:probe', 'probe-model')
        with patch.object(AIAgent, '_interruptible_api_call',
                side_effect=RuntimeError('probe-fixture-key-not-an-account Bearer synthetic-access-token')) as failed_call:
            failed = probe.verify('custom:probe', 'probe-model')
        print(json.dumps({'empty':empty, 'failed':failed, 'calls':[empty_call.call_count, failed_call.call_count]}))
        ''')
        self.assertEqual(reply["empty"]["code"], "MODEL_PROBE_EMPTY_RESPONSE")
        self.assertFalse(reply["failed"]["ok"])
        self.assertEqual(reply["failed"]["failureType"], "RuntimeError")
        self.assertEqual(reply["calls"], [1, 1])

    def test_wrong_candidate_and_runtime_model_change_are_rejected(self):
        reply = self.run_case('''
        def changed(agent, kwargs):
            agent.model = 'forbidden-fallback'
            return answer()
        with patch.object(AIAgent, '_interruptible_api_call', changed):
            changed_result = probe.verify('custom:probe', 'probe-model')
        with patch.object(AIAgent, '_interruptible_api_call') as not_called:
            wrong = probe.verify('custom:probe', 'another-model')
        print(json.dumps({'changed':changed_result, 'wrong':wrong, 'calls':not_called.call_count}))
        ''')
        self.assertEqual(reply["changed"]["code"], "MODEL_PROBE_TARGET_CHANGED")
        self.assertEqual(reply["wrong"]["code"], "MODEL_PROBE_TARGET_CHANGED")
        self.assertEqual(reply["calls"], 0)

    def test_app_server_transport_is_reported_without_trying_a_different_transport(self):
        reply = self.run_case('''
        from hermes_cli import runtime_provider
        with patch.object(runtime_provider, 'resolve_runtime_provider', return_value={
                'provider': 'custom:probe', 'api_mode': 'codex_app_server'}), \\
                patch.object(AIAgent, '_interruptible_api_call') as dispatch:
            result = probe.verify('custom:probe', 'probe-model')
        print(json.dumps({'result': result, 'calls': dispatch.call_count}))
        ''')
        self.assertEqual(reply["result"]["code"], "MODEL_PROBE_UNSUPPORTED_TRANSPORT")
        self.assertFalse(reply["result"]["verified"])
        self.assertEqual(reply["calls"], 0)

    def test_custom_overrides_cannot_replace_probe_messages(self):
        self.config["providers"]["probe"]["extra_body"] = {"messages": ["PRIVATE-CONTEXT-MUST-NOT-BE-SENT"]}
        (self.home / "config.yaml").write_text(yaml.safe_dump(self.config), encoding="utf-8")
        reply = self.run_case('''
        with patch.object(AIAgent, '_interruptible_api_call') as dispatch:
            result = probe.verify('custom:probe', 'probe-model')
        print(json.dumps({'result':result, 'calls':dispatch.call_count}))
        ''')
        self.assertEqual(reply["result"]["code"], "MODEL_PROBE_UNSAFE_OVERRIDE")
        self.assertEqual(reply["calls"], 0)

    def test_acp_default_model_is_rejected_before_prompt_and_scope_is_restored(self):
        reply = self.run_case('''
        from agent import copilot_acp_client as acp
        old_capabilities, old_handlers, old_cwd = acp._INITIALIZE_PARAMS, acp._FS_HANDLERS, os.getcwd()
        wire = [{'jsonrpc':'2.0','id':1,'result':{}}, {'jsonrpc':'2.0','id':2,
            'result':{'sessionId':'fixture','models':{'availableModels':[{'modelId':'other-model'}]}}}]
        process = SimpleNamespace(stdin=io.StringIO(), stdout=[json.dumps(item)+'\\n' for item in wire],
            stderr=[], poll=lambda:None)
        observed = {}
        with probe._acp_probe_scope({'base_url':'acp://copilot'}, 'selected-model'):
            observed.update(no_fs=not acp._FS_HANDLERS and not acp._INITIALIZE_PARAMS['clientCapabilities'],
                empty_cwd=os.getcwd()!=old_cwd and not list(Path.cwd().iterdir()))
            client = acp.CopilotACPClient()
            with patch.object(client, '_spawn', return_value=process), patch.object(client, 'close'):
                try:
                    client._run_prompt('Reply with OK.', timeout_seconds=2, model='selected-model')
                except probe._ProbeError as error:
                    observed['code'] = error.code
            observed['prompt_sent'] = any(json.loads(line)['method']=='session/prompt'
                for line in process.stdin.getvalue().splitlines())
        observed['restored'] = acp._INITIALIZE_PARAMS is old_capabilities and acp._FS_HANDLERS is old_handlers and os.getcwd()==old_cwd
        print(json.dumps(observed))
        ''')
        self.assertEqual(reply, {"no_fs": True, "empty_cwd": True, "code": "MODEL_PROBE_TARGET_CHANGED",
                                 "prompt_sent": False, "restored": True})


if __name__ == "__main__":
    unittest.main()
