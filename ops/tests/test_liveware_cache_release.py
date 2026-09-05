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
            liveware_apps = [
                {"appId": "app-tavern", "name": "Tavern", "domain": "app-tavern.apps.clawling.io", "status": "active"},
                {"appId": "app-profile", "name": "Story Profile", "domain": "app-profile.apps.clawling.io", "status": "active"},
            ]
            list_calls = 0

            def fake_launcher(_home, operation, **parameters):
                nonlocal list_calls
                if operation == "list_apps":
                    list_calls += 1
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
                mock.patch.object(
                    integration,
                    "cli",
                    side_effect=lambda _home, *args: json.dumps(liveware_apps) if args == ("app", "list", "--json") else "",
                ),
            ):
                result = integration.refresh(home)
                repeated = integration.refresh(home)

            self.assertEqual(result, {"status": "updated", "warnings": [], "assetRelease": release})
            self.assertEqual(repeated, result)
            self.assertEqual(list_calls, 4)
            self.assertEqual(len(registrations), 2)
            self.assertEqual({item["app_id"] for item in registrations}, {"app-tavern", "app-profile"})
            self.assertEqual(
                {item["url"] for item in registrations},
                {
                    "https://app-tavern.apps.clawling.io/?release=0123456789abcdef",
                    "https://app-profile.apps.clawling.io/?release=0123456789abcdef",
                },
            )

    def test_refresh_does_not_rewrite_unchanged_app_identities(self):
        integration = load_integration()
        release = "0123456789abcdef"
        identities = {
            "console": {
                "app_id": "app-tavern",
                "domain": "app-tavern.apps.clawling.io",
                "name": "Tavern",
                "liveware_name": "Tavern",
            },
            "actor": {
                "app_id": "app-profile",
                "domain": "app-profile.apps.clawling.io",
                "name": "Story Profile",
                "liveware_name": "Story Profile",
            },
        }
        liveware_apps = [
            {"appId": value["app_id"], "name": value["name"], "domain": value["domain"], "status": "active"}
            for value in identities.values()
        ]
        launchers = [
            {
                "app_id": value["app_id"],
                "name": value["name"],
                "url": integration.release_launcher_url(value["domain"], release),
            }
            for value in identities.values()
        ]
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = home / "tavern-state/apps.json"
            path.parent.mkdir()
            path.write_text(json.dumps(identities), encoding="utf-8")
            with (
                mock.patch.object(integration, "runtime_asset_release", return_value=release),
                mock.patch.object(
                    integration,
                    "cli",
                    side_effect=lambda _home, *args: json.dumps(liveware_apps)
                    if args == ("app", "list", "--json") else "",
                ),
                mock.patch.object(integration, "launcher", return_value={"apps": launchers}),
                mock.patch.object(integration, "atomic_json") as write,
            ):
                result = integration.refresh(home)

            self.assertEqual(result["status"], "updated")
            write.assert_not_called()

    def test_repair_adopts_existing_story_profile_and_removes_stale_launcher(self):
        integration = load_integration()
        release = "0123456789abcdef"
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            state = home / "tavern-state"
            state.mkdir()
            path = state / "apps.json"
            path.write_text(json.dumps({
                "console": {
                    "app_id": "app-tavern",
                    "domain": "app-tavern.apps.clawling.io",
                },
            }), encoding="utf-8")
            liveware_apps = [
                {"appId": "app-tavern", "name": "Tavern", "domain": "app-tavern.apps.clawling.io", "status": "active"},
                {"appId": "app-profile", "name": "Story Profile", "domain": "app-profile.apps.clawling.io", "status": "active"},
            ]
            registrations = [
                {"app_id": "app-old", "name": "Tavern", "url": "https://app-old.apps.clawling.io/"},
                {"app_id": "app-tavern", "name": "Tavern", "url": "https://app-tavern.apps.clawling.io/"},
            ]

            def fake_cli(_home, *args):
                if args == ("app", "list", "--json"):
                    return json.dumps(liveware_apps)
                if args[:2] == ("tunnel", "bind"):
                    return ""
                raise AssertionError(args)

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
                mock.patch.object(integration, "cli", side_effect=fake_cli),
                mock.patch.object(integration, "launcher", side_effect=fake_launcher),
            ):
                result = integration.repair(home)

            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "updated")
            self.assertEqual(saved["actor"]["app_id"], "app-profile")
            self.assertEqual([item["name"] for item in registrations], ["Tavern", "Story Profile"])
            self.assertEqual({item["app_id"] for item in registrations}, {"app-tavern", "app-profile"})

    def test_initialize_reuses_unique_same_name_app_when_saved_id_is_stale(self):
        integration = load_integration()
        release = "0123456789abcdef"
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            state = home / "tavern-state"
            state.mkdir()
            path = state / "apps.json"
            path.write_text(json.dumps({
                "console": {
                    "app_id": "app-stale",
                    "domain": "app-stale.apps.clawling.io",
                },
            }), encoding="utf-8")
            liveware_apps = [
                {"appId": "app-tavern", "name": "Tavern", "domain": "app-tavern.apps.clawling.io", "status": "active"},
                {"appId": "app-profile", "name": "Story Profile", "domain": "app-profile.apps.clawling.io", "status": "active"},
            ]
            registrations = []
            create_calls = []

            def fake_cli(_home, *args):
                if args == ("app", "list", "--json"):
                    return json.dumps(liveware_apps)
                if args[:2] == ("app", "create"):
                    create_calls.append(args)
                    return ""
                if args[:2] == ("tunnel", "bind"):
                    return ""
                raise AssertionError(args)

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
                mock.patch.object(integration, "cli", side_effect=fake_cli),
                mock.patch.object(integration, "launcher", side_effect=fake_launcher),
            ):
                result = integration.initialize(home)

            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "updated")
            self.assertEqual(create_calls, [])
            self.assertEqual(saved["console"]["app_id"], "app-tavern")
            self.assertEqual(saved["actor"]["app_id"], "app-profile")

    def test_refresh_never_creates_a_missing_story_profile(self):
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
            }), encoding="utf-8")
            liveware_apps = [
                {"appId": "app-tavern", "name": "Tavern", "domain": "app-tavern.apps.clawling.io", "status": "active"},
            ]
            create_calls = []

            def fake_cli(_home, *args):
                if args == ("app", "list", "--json"):
                    return json.dumps(liveware_apps)
                if args[:2] == ("app", "create"):
                    create_calls.append(args)
                    return ""
                if args[:2] == ("tunnel", "bind"):
                    return ""
                raise AssertionError(args)

            with (
                mock.patch.object(integration, "runtime_asset_release", return_value=release),
                mock.patch.object(integration, "cli", side_effect=fake_cli),
                mock.patch.object(integration, "launcher", return_value={"apps": []}),
            ):
                result = integration.refresh(home)

            self.assertEqual(result["status"], "local-installed-liveware-pending")
            self.assertEqual(create_calls, [])

    def test_ensure_initializes_when_the_first_run_has_no_complete_identity(self):
        integration = load_integration()
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with (
                mock.patch.object(integration, "start_runtime") as start,
                mock.patch.object(integration, "repair", return_value={"status": "updated"}) as repair,
                mock.patch.object(integration, "refresh") as refresh,
            ):
                result = integration.ensure(home)

            self.assertEqual(result, {"status": "updated"})
            start.assert_called_once_with(home)
            repair.assert_called_once_with(home, 8799)
            refresh.assert_not_called()

    def test_ensure_only_recovers_when_both_app_identities_are_saved(self):
        integration = load_integration()
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            state = home / "tavern-state"
            state.mkdir()
            (state / "apps.json").write_text(json.dumps({
                "console": {"app_id": "app-tavern", "domain": "app-tavern.apps.clawling.io"},
                "actor": {"app_id": "app-profile", "domain": "app-profile.apps.clawling.io"},
            }), encoding="utf-8")
            with (
                mock.patch.object(integration, "start_runtime") as start,
                mock.patch.object(integration, "repair") as repair,
                mock.patch.object(integration, "refresh", return_value={"status": "updated"}) as refresh,
            ):
                result = integration.ensure(home)

            self.assertEqual(result, {"status": "updated"})
            start.assert_called_once_with(home)
            refresh.assert_called_once_with(home, 8799)
            repair.assert_not_called()

    def test_repair_persists_tavern_before_story_profile_creation_failure(self):
        integration = load_integration()
        release = "0123456789abcdef"
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            registrations = []

            def fake_cli(_home, *args):
                if args == ("app", "list", "--json"):
                    return "[]"
                if args == ("app", "create", "Tavern", "--agent-type", "hermes"):
                    return "appId         app-tavern\ndomain        app-tavern.apps.clawling.io\n"
                if args == ("app", "create", "Story Profile", "--agent-type", "hermes"):
                    raise RuntimeError("quota reached")
                if args[:2] == ("tunnel", "bind"):
                    return ""
                raise AssertionError(args)

            def fake_launcher(_home, operation, **parameters):
                if operation == "list_apps":
                    return {"apps": [item.copy() for item in registrations]}
                if operation == "register_app":
                    registrations.append(parameters.copy())
                    return {"ok": True}
                if operation == "unregister_app":
                    registrations[:] = [item for item in registrations if item["app_id"] != parameters["app_id"]]
                    return {"ok": True}
                raise AssertionError(operation)

            with (
                mock.patch.object(integration, "runtime_asset_release", return_value=release),
                mock.patch.object(integration, "cli", side_effect=fake_cli),
                mock.patch.object(integration, "launcher", side_effect=fake_launcher),
            ):
                result = integration.repair(home)

            saved = json.loads((home / "tavern-state/apps.json").read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "local-installed-liveware-pending")
            self.assertEqual(saved["console"]["app_id"], "app-tavern")
            self.assertNotIn("actor", saved)
            self.assertEqual(registrations[0]["app_id"], "app-tavern")

    def test_repair_retries_tunnel_binding_while_a_created_app_settles(self):
        integration = load_integration()
        release = "0123456789abcdef"
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            state = home / "tavern-state"
            state.mkdir()
            (state / "apps.json").write_text(json.dumps({
                "console": {"app_id": "app-tavern", "domain": "app-tavern.apps.clawling.io"},
                "actor": {"app_id": "app-profile", "domain": "app-profile.apps.clawling.io"},
            }), encoding="utf-8")
            liveware_apps = [
                {"appId": "app-tavern", "name": "Tavern", "domain": "app-tavern.apps.clawling.io", "status": "active"},
                {"appId": "app-profile", "name": "Story Profile", "domain": "app-profile.apps.clawling.io", "status": "active"},
            ]
            registrations = []
            attempts = {"app-tavern": 0, "app-profile": 0}

            def fake_cli(_home, *args):
                if args == ("app", "list", "--json"):
                    return json.dumps(liveware_apps)
                if args[:2] == ("tunnel", "bind"):
                    app_id = args[2]
                    attempts[app_id] += 1
                    if app_id == "app-tavern" and attempts[app_id] < 3:
                        raise RuntimeError("app not found")
                    return ""
                raise AssertionError(args)

            def fake_launcher(_home, operation, **parameters):
                if operation == "list_apps":
                    return {"apps": [item.copy() for item in registrations]}
                if operation == "register_app":
                    registrations.append(parameters.copy())
                    return {"ok": True}
                if operation == "unregister_app":
                    registrations[:] = [item for item in registrations if item["app_id"] != parameters["app_id"]]
                    return {"ok": True}
                raise AssertionError(operation)

            with (
                mock.patch.object(integration, "runtime_asset_release", return_value=release),
                mock.patch.object(integration, "cli", side_effect=fake_cli),
                mock.patch.object(integration, "launcher", side_effect=fake_launcher),
                mock.patch.object(integration.time, "sleep"),
            ):
                result = integration.repair(home)

            self.assertEqual(result["status"], "updated")
            self.assertEqual(attempts["app-tavern"], 3)
            self.assertEqual(attempts["app-profile"], 1)


if __name__ == "__main__":
    unittest.main()
