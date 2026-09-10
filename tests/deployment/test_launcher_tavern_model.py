import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("native_model_config", ROOT / "app/native_model_config.py")
MODULE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MODULE)


class Client(MODULE.NativeSettingsClient):
    def __init__(self, settings, fail_save=False):
        self.current = copy.deepcopy(settings)
        self.secrets = {}
        self.calls = []
        self.fail_save = fail_save

    def settings(self):
        return copy.deepcopy(self.current)

    def _request(self, path, payload):
        self.calls.append(path)
        if path == "/api/secrets/read":
            return copy.deepcopy(self.secrets)
        if path == "/api/secrets/write":
            self.secrets[payload["key"]] = [{"id": "test-secret", "active": True}]
            return {"id": "test-secret"}
        if path == "/api/secrets/delete":
            self.secrets.pop(payload["key"], None)
            return {}
        if path == "/api/settings/save":
            if self.fail_save:
                self.fail_save = False
                raise OSError("fixture failure")
            self.current = copy.deepcopy(payload)
            return {"result": "ok"}
        raise AssertionError(path)


class LauncherTavernModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.marker = Path(self.temp.name) / "launcher-model.json"
        self.settings = json.loads((ROOT / "app/engine/sillytavern/default/content/settings.json").read_text())

    def test_every_launcher_provider_selects_correct_source_and_secret(self):
        for provider, (_, source, key, _) in MODULE.LAUNCHER_PROVIDERS.items():
            with self.subTest(provider=provider):
                self.marker.unlink(missing_ok=True)
                config = MODULE.launcher_config(provider, "fixture-model", "fixture-secret", "https://relay.invalid/v1")
                client = Client(self.settings)
                with patch.object(MODULE, "NativeSettingsClient", return_value=client):
                    result = MODULE.initialize_launcher_model(config, self.marker, "http://127.0.0.1:18999")
                self.assertTrue(result["changed"])
                oai = client.current["oai_settings"]
                self.assertEqual(oai["chat_completion_source"], source)
                self.assertEqual(oai[{"custom": "custom_model", "claude": "claude_model", "makersuite": "google_model"}[source]], "fixture-model")
                ui = client.current["extension_settings"]["nora_ui"]
                self.assertEqual(ui["activeModel"], "")
                self.assertEqual(ui["hermesModel"]["secretKey"], key)
                self.assertNotIn("fixture-secret", json.dumps(client.current))
                self.assertNotIn("fixture-secret", self.marker.read_text())
                self.assertEqual(client.secrets[key][0]["id"], ui["hermesModel"]["secretId"])

    def test_existing_model_is_never_overwritten(self):
        client = Client(self.settings)
        client.current["extension_settings"]["nora_ui"]["activeModel"] = "user-choice"
        before = copy.deepcopy(client.current)
        with patch.object(MODULE, "NativeSettingsClient", return_value=client):
            result = MODULE.initialize_launcher_model(MODULE.launcher_config("deepseek", "new", "secret"), self.marker, "http://127.0.0.1:18999")
        self.assertFalse(result["changed"])
        self.assertEqual(before, client.current)
        self.assertNotIn("/api/secrets/write", client.calls)

    def test_later_hermes_changes_do_not_replace_tavern_default(self):
        self.marker.write_text('{"schema":1}')
        with patch.object(MODULE, "NativeSettingsClient") as factory:
            result = MODULE.initialize_launcher_model(MODULE.launcher_config("deepseek", "different", "secret"), self.marker, "http://127.0.0.1:18999")
            factory.assert_not_called()
        self.assertEqual(result["reason"], "already-initialized")

    def test_failed_write_restores_settings_and_removes_only_new_secret(self):
        client = Client(self.settings, fail_save=True)
        with patch.object(MODULE, "NativeSettingsClient", return_value=client):
            with self.assertRaisesRegex(MODULE.NativeModelConfigError, "同步未完成"):
                MODULE.initialize_launcher_model(MODULE.launcher_config("deepseek", "fixture", "secret"), self.marker, "http://127.0.0.1:18999")
        self.assertEqual(client.current, self.settings)
        self.assertFalse(client.secrets)
        self.assertFalse(self.marker.exists())

    def test_sync_runs_before_marking_initial_model_complete(self):
        main = (ROOT / "ops/installer/desktop/main.js").read_text()
        handler = main[main.index("handle('nora:model-save-test'"):main.index("handle('nora:open-clawchat'")]
        self.assertLess(handler.index("action: 'sync-tavern'"), handler.index("writeVerifiedModel(noraHome(), saved)"))
        self.assertIn("if (!readInstallerState().setupCompleted)", handler)

    def test_real_http_client_performs_csrf_secret_save_and_settings_readback(self):
        storage = Client(self.settings)

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, value):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Set-Cookie", "fixture-session=1; Path=/")
                self.end_headers()
                self.wfile.write(json.dumps(value).encode())

            def do_GET(self):
                self.respond({"token": "fixture-csrf"})

            def do_POST(self):
                if self.headers.get("X-CSRF-Token") != "fixture-csrf" or "fixture-session=1" not in self.headers.get("Cookie", ""):
                    self.send_error(403)
                    return
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                value = {"settings": json.dumps(storage.current)} if self.path == "/api/settings/get" else storage._request(self.path, payload)
                self.respond(value)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            config = MODULE.launcher_config("deepseek", "deepseek-v4-flash", "fixture-secret")
            result = MODULE.initialize_launcher_model(config, self.marker, f"http://127.0.0.1:{server.server_port}")
            self.assertTrue(result["changed"])
            self.assertEqual(storage.current["oai_settings"]["custom_model"], "deepseek-v4-flash")
            self.assertEqual(storage.current["oai_settings"]["custom_url"], "https://api.deepseek.com/v1")
            self.assertEqual(storage.calls.count("/api/secrets/write"), 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
