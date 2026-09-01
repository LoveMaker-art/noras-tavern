from __future__ import annotations

import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
from threading import Thread
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
INTEGRATION = ROOT / "ops/updater/liveware_integration.py"


def load_integration():
    spec = importlib.util.spec_from_file_location("tavern_liveware_cache_test", INTEGRATION)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class LivewareCacheReleaseTests(unittest.TestCase):
    def test_runtime_release_is_read_from_the_started_tavern(self):
        integration = load_integration()
        release = "0123456789abcdef"

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                payload = json.dumps({"assetRelease": release}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            self.assertEqual(integration.runtime_asset_release(server.server_port), release)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_refresh_versions_existing_launchers_and_collapses_duplicates(self):
        integration = load_integration()
        release = "0123456789abcdef"
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            state = home / "tavern-state"
            state.mkdir()
            (state / "apps.json").write_text(json.dumps({
                "console": {
                    "app_id": "app-tavern",
                    "domain": "app-tavern.apps.clawling.io",
                },
                "actor": {
                    "app_id": "app-profile",
                    "domain": "app-profile.apps.clawling.io",
                },
            }), encoding="utf-8")
            registrations = [
                {"app_id": "app-tavern", "name": "Tavern", "url": "https://app-tavern.apps.clawling.io/"},
                {"app_id": "app-tavern", "name": "tavern", "url": "https://app-tavern.apps.clawling.io/"},
                {"app_id": "app-profile", "name": "Story Profile", "url": "https://app-profile.apps.clawling.io/"},
            ]

            def fake_launcher(_home, operation, **parameters):
                if operation == "list_apps":
                    return {"apps": [item.copy() for item in registrations]}
                if operation == "unregister_app":
                    registrations[:] = [item for item in registrations if item["app_id"] != parameters["app_id"]]
                    return {"ok": True}
                if operation == "register_app":
                    registrations.append(parameters.copy())
                    return {"ok": True}
                raise AssertionError(operation)

            with (
                mock.patch.object(integration, "runtime_asset_release", return_value=release),
                mock.patch.object(integration, "launcher", side_effect=fake_launcher),
                mock.patch.object(integration, "cli", return_value=""),
            ):
                result = integration.refresh(home)
                repeated = integration.refresh(home)

            self.assertEqual(result, {"status": "updated", "warnings": [], "assetRelease": release})
            self.assertEqual(repeated, result)
            self.assertEqual(len(registrations), 2)
            self.assertEqual({item["app_id"] for item in registrations}, {"app-tavern", "app-profile"})
            self.assertEqual(
                {item["url"] for item in registrations},
                {
                    "https://app-tavern.apps.clawling.io/?release=0123456789abcdef",
                    "https://app-profile.apps.clawling.io/?release=0123456789abcdef",
                },
            )


if __name__ == "__main__":
    unittest.main()
