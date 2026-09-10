"""Contracts between the desktop adapter and the shared Tavern business code."""
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/updater"))
import liveware_integration as integration
import liveware_notice as notice
import clawchat_greeting_patch as greeting
from ops.installer import launcher_bridge as bridge, first_install
from ops.installer import launcher_services as services
from ops.updater import update


class SharedLogicTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home, self.tavern = self.root / "hermes", self.root / "tavern"
        self.home.mkdir()

    def test_proof_is_written_to_tavern_without_greeting_dependency(self):
        database = self.home / "clawchat/clawchat.sqlite"
        database.parent.mkdir()
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("CREATE TABLE activations(platform, account_id, user_id, conversation_id, bootstrap_sent)")
            db.execute("INSERT INTO activations VALUES('hermes','default','owner','chat',0)")
        owner = {"user_id": "owner", "instance_id": "instance"}
        with patch.object(integration, "runtime_asset_release", return_value="a" * 16), \
             patch.object(integration, "authenticate", return_value=owner) as auth, \
             patch.object(integration, "_reconcile", return_value={"status": "updated", "assetRelease": "a" * 16}) as reconcile:
            result = integration.initialize(self.tavern, 18899, hermes_home=self.home)
        self.assertEqual(result["status"], "updated")
        auth.assert_called_once_with(self.tavern, hermes_home=self.home)
        self.assertEqual(reconcile.call_args.kwargs["hermes_home"], self.home)
        proof = json.loads((self.tavern / "tavern-state/liveware-ready.json").read_text())
        self.assertEqual(proof["port"], 18899)
        self.assertEqual(proof["owner"], owner)
        self.assertFalse((self.home / "tavern-state").exists())

    def test_stopped_tavern_never_logs_in_or_restarts_liveware(self):
        with patch.object(integration, "runtime_asset_release", side_effect=OSError("stopped")), \
             patch.object(integration, "authenticate") as login:
            result = integration.initialize(self.tavern, 18899, hermes_home=self.home)
        self.assertEqual(result["status"], "local-installed-liveware-pending")
        login.assert_not_called()

    def test_managed_worker_does_not_start_a_stopped_tavern(self):
        with patch.object(integration, "runtime_running", return_value=False), \
             patch.object(integration, "start_runtime") as start, \
             patch.object(integration, "ensure") as register:
            self.assertEqual(integration.startup(self.tavern, 18899, hermes_home=self.home,
                                               start_local=False)["status"], "tavern-stopped")
        start.assert_not_called()
        register.assert_not_called()

    def test_managed_worker_cancels_when_tavern_stops_before_registration(self):
        with patch.object(integration, "runtime_running", side_effect=[True, False]), \
             patch.object(integration, "start_runtime") as start, \
             patch.object(integration, "repair") as register:
            result = integration.startup(self.tavern, 18899, hermes_home=self.home, start_local=False)
        self.assertEqual(result["status"], "tavern-stopped")
        start.assert_not_called()
        register.assert_not_called()

    def test_managed_registration_retry_does_not_restart_tavern(self):
        with patch.object(integration, "RETRY_DELAYS", (0, 0)), \
             patch.object(integration, "runtime_running", side_effect=[True, False]), \
             patch.object(integration, "repair", return_value={"status": "pending"}) as repair, \
             patch.object(integration, "start_runtime") as start:
            result = integration.ensure(self.tavern, 18899, hermes_home=self.home, start_local=False)
        self.assertEqual(result["status"], "tavern-stopped")
        start.assert_not_called()
        repair.assert_called_once_with(self.tavern, 18899, hermes_home=self.home)

    def test_desktop_starts_gateway_before_scheduling_shared_hook(self):
        args = SimpleNamespace(nora_home=self.root, hermes_home=self.home,
                               install_root=self.tavern, port=18899, service="all")
        order = []
        def run(command, **kwargs):
            order.append("hook" if command[-1].endswith("handler.py") else "tavern")
        with patch.object(bridge, "installed", return_value=True), \
             patch.object(bridge.nora_system, "inspect", return_value={"ready": True}), \
             patch.object(bridge, "read_verified_model", return_value={"model": "test"}), \
             patch.object(bridge, "clawchat_paired", return_value=True), \
             patch.object(bridge, "sync_nora_profile"), \
             patch.object(bridge, "python_command", return_value=sys.executable), \
             patch.object(bridge, "run_stream", side_effect=run), \
             patch.object(bridge, "start_gateway", side_effect=lambda *a: order.append("gateway")), \
             patch.object(bridge, "require_bundled_clawchat"), \
             patch.object(bridge, "status_payload", return_value={"running": True, "clawchatConnected": True}), \
             patch.object(bridge.nora_system, "verify_runtime"), \
             patch.object(bridge.nora_system, "mark_setup_complete"), \
             patch.object(bridge, "run_json") as login, patch.object(bridge, "emit"):
            bridge.command_start(args)
        self.assertEqual(order, ["tavern", "gateway", "hook"])
        login.assert_not_called()

    def test_prepatched_bundle_is_verified_without_git(self):
        shutil.copytree(ROOT / "ops/tests/fixtures/clawchat-greeting-before", self.home / "plugins/clawchat")
        swaps, report = greeting.prepare(self.home, self.root / "stage")
        self.assertEqual(report["status"], "already-patched")
        for _, source, target in swaps:
            shutil.copy2(source, target)
        files = {"plugins/clawchat/" + name: hashlib.sha256(
            (self.home / "plugins/clawchat" / name).read_bytes()).hexdigest() for name in greeting.FILES}
        metadata = {"files": files, "clawchat": {"greetingPatchSha256": hashlib.sha256(
            (ROOT / "ops/updater/clawchat-greeting-order.patch").read_bytes()).hexdigest()}}
        (self.home / "nora-components.json").write_text(json.dumps(metadata))
        with patch.object(greeting.subprocess, "run", side_effect=AssertionError("Git must not run")):
            self.assertEqual(greeting.prepare(self.home, self.root / "second"), ([], {"status": "already-patched"}))
        (self.home / "plugins/clawchat" / greeting.FILES[0]).write_text("tampered")
        self.assertFalse(greeting.bundled_patch_ready(self.home))

    def test_mcp_first_install_delegates_to_shared_writer(self):
        config = self.home / "config.yaml"
        config.write_text("user_setting: keep\nmcp_servers:\n  unrelated:\n    command: keep\n")
        expected = update.render_mcp(self.home, self.tavern, 18899)
        self.assertEqual(first_install.render_mcp(self.home, self.tavern, 18899), expected)
        self.assertIn(b"http://127.0.0.1:18899", expected)
        self.assertIn(b"user_setting: keep", expected)

    def test_shared_defaults_do_not_assume_a_desktop_install(self):
        with patch.dict(os.environ, {"HERMES_HOME": str(self.home)}, clear=True):
            self.assertEqual(update.default_hermes_home(), self.home)
            self.assertEqual(update.default_install_root(), self.home)

    def test_shared_hermes_instructions_remain_merged(self):
        (self.home / "AGENTS.md").write_text("My unrelated instructions\n")
        merged = update.merged_agents(self.home, b"# Nora\n")
        self.assertIn(b"My unrelated instructions", merged)
        self.assertEqual(merged.count(b"# Nora"), 1)

    def test_shared_hook_uses_common_startup_without_desktop_runner(self):
        with patch.dict(os.environ, {"HERMES_HOME": str(self.home), "TAVERN_DATA_ROOT": str(self.tavern)}):
            spec = importlib.util.spec_from_file_location("shared_hook_test", ROOT / "ops/hooks/tavern-liveware-register/handler.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with patch.object(module.subprocess, "Popen") as spawn:
                module.handle("gateway:startup", {})
        command = spawn.call_args.args[0]
        self.assertEqual(command[-1], "startup")
        self.assertIn(str(self.tavern / "apps/tavern-ops/updater/liveware_integration.py"), command)
        self.assertNotIn("recover-existing", command)

    def test_stopping_nora_does_not_kill_its_liveware_descendant(self):
        import psutil
        gateway, worker, daemon = Mock(), Mock(), Mock()
        gateway.pid = 12345
        worker.exe.return_value = sys.executable
        daemon.exe.return_value = str(self.home / "clawchat/liveware" /
                                      ("liveware.exe" if os.name == "nt" else "liveware"))
        daemon.cmdline.return_value = [daemon.exe.return_value, "agent", "run"]
        gateway.children.return_value = [worker, daemon]
        with patch.object(services, "owned_gateway", side_effect=[gateway, None]), \
             patch.object(psutil, "wait_procs", return_value=([], [])):
            services.stop_gateway(self.root, preserve_liveware_home=self.home)
        gateway.terminate.assert_called_once()
        worker.terminate.assert_called_once()
        daemon.terminate.assert_not_called()
        daemon.kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
