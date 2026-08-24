import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ServerRetryPolicyTests(unittest.TestCase):
    def _run(self, body):
        script = "import json\nimport server\nserver.time.sleep = lambda _seconds: None\n" + body
        with tempfile.TemporaryDirectory() as state:
            env = dict(os.environ)
            env["TAVERN_STATE_DIR"] = state
            env["TAVERN_MODEL_KEY"] = ""
            return subprocess.run(
                [sys.executable, "-c", script], cwd=ROOT, env=env, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)

    def test_transient_failure_retries_the_same_model(self):
        result = self._run(textwrap.dedent("""
            calls = []
            def chat(_messages, **kwargs):
                calls.append((kwargs.get('model') or {}).get('model'))
                if len(calls) < 3:
                    raise TimeoutError('temporary timeout')
                return '{"ok": true}'
            server.actor.chat = chat
            status, value, error = server._validated_model_call(
                [{'role': 'user', 'content': 'x'}], 0,
                {'model': 'configured-model'}, 100,
                lambda output: json.loads(output), 'en', 'test')
            print(json.dumps({'status': status, 'calls': calls, 'value': value}))
        """))
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["calls"], ["configured-model"] * 3)

    def test_validation_retry_is_bounded_on_the_same_model(self):
        result = self._run(textwrap.dedent("""
            calls = []
            def chat(messages, **kwargs):
                calls.append({
                    'model': (kwargs.get('model') or {}).get('model'),
                    'messages': len(messages),
                })
                return 'not-json'
            server.actor.chat = chat
            status, value, error = server._validated_model_call(
                [{'role': 'user', 'content': 'x'}], 0,
                {'model': 'configured-model'}, 100,
                lambda output: json.loads(output), 'en', 'test')
            print(json.dumps({'status': status, 'calls': calls}))
        """))
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["status"], "output_rejected")
        self.assertEqual([item["model"] for item in payload["calls"]],
                         ["configured-model"] * 6)
        self.assertEqual([item["messages"] for item in payload["calls"]],
                         [1, 3, 3, 3, 3, 3])


if __name__ == "__main__":
    unittest.main()
