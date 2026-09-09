import asyncio
import ast
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock, AsyncMock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/updater"))
import liveware_integration as integration
import liveware_notice as notice
import clawchat_greeting_patch as gateway_patch


class StopWaiting(Exception):
    pass


class GreetingOrderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def test_runtime_starts_before_unbound_greeting_wait(self):
        calls = []
        with patch.object(integration, "start_runtime", side_effect=lambda *_, **__: calls.append("runtime")), \
             patch.object(integration, "wait_for_greeting", side_effect=StopWaiting), \
             patch.object(integration, "ensure") as register:
            with self.assertRaises(StopWaiting):
                integration.startup(self.home)
            register.assert_not_called()
        self.assertEqual(calls, ["runtime"])

    def test_runtime_retry_does_not_register_or_consume_greeting_wait(self):
        with patch.object(integration, "start_runtime", side_effect=[OSError("temporary"), 0]) as start, \
             patch.object(integration.time, "sleep"), \
             patch.object(integration, "wait_for_greeting", side_effect=StopWaiting), \
             patch.object(integration, "ensure") as register:
            with self.assertRaises(StopWaiting):
                integration.startup(self.home)
            self.assertEqual(start.call_count, 2)
            register.assert_not_called()

    def test_runtime_failure_never_registers(self):
        with patch.object(integration, "RETRY_DELAYS", (0, 0)), \
             patch.object(integration, "start_runtime", side_effect=OSError("offline")), \
             patch.object(integration, "wait_for_greeting") as greeting, \
             patch.object(integration, "ensure") as register:
            self.assertEqual(integration.startup(self.home)["status"], "runtime-start-failed")
            greeting.assert_not_called()
            register.assert_not_called()

    def test_success_order_runtime_greeting_apps_verified_notice(self):
        calls = []
        with patch.object(integration, "start_runtime", side_effect=lambda *_, **__: calls.append("runtime")), \
             patch.object(integration, "wait_for_greeting", side_effect=lambda _: calls.append("greeting")), \
             patch.object(integration, "ensure", side_effect=lambda *_, **__: calls.append("apps") or {"status": "updated"}), \
             patch.object(integration, "verified_entry", side_effect=lambda *_, **__: calls.append("verify") or {"status": "ready"}), \
             patch.object(notice, "notify_ready", side_effect=lambda *_, **__: calls.append("notice") or {"status": "sent"}):
            self.assertEqual(integration.startup(self.home)["notice"]["status"], "sent")
        self.assertEqual(calls, ["runtime", "greeting", "apps", "verify", "notice"])

    def test_worker_lock_prevents_second_worker(self):
        with integration.registration_lock(self.home, worker=True), \
             patch.object(integration, "start_runtime") as start:
            self.assertEqual(integration.startup(self.home)["status"], "already-running")
            start.assert_not_called()

    def test_failed_registration_never_sends_url(self):
        with patch.object(integration, "start_runtime"), patch.object(integration, "wait_for_greeting"), \
             patch.object(integration, "ensure", return_value={"status": "pending"}), \
             patch.object(notice, "notify_ready") as send:
            self.assertEqual(integration.startup(self.home)["status"], "pending")
            send.assert_not_called()

    def test_reconcile_cannot_bypass_greeting_gate(self):
        with patch.object(integration, "runtime_asset_release", return_value="a" * 16), \
             patch.object(integration, "authenticate", return_value={"user_id": "owner", "instance_id": "instance"}), \
             patch.object(notice, "owner_conversation", return_value=None), \
             patch.object(integration, "_reconcile") as register:
            self.assertEqual(integration.reconcile(self.home, create_missing=True)["status"], "waiting-for-greeting")
            register.assert_not_called()

    def test_owner_query_does_not_accept_foreign_or_unsent_greeting(self):
        path = self.home / "clawchat/clawchat.sqlite"
        path.parent.mkdir()
        with closing(sqlite3.connect(path)) as db:
            db.execute("CREATE TABLE activations(platform, account_id, user_id, conversation_id, bootstrap_sent)")
            db.executemany("INSERT INTO activations VALUES(?,?,?,?,?)", [
                ("hermes", "default", "foreign", "foreign-chat", 1),
                ("hermes", "default", "owner", "owner-chat", 0),
            ])
            db.commit()
            self.assertIsNone(notice.owner_conversation(self.home, "owner"))
            db.execute("UPDATE activations SET bootstrap_sent=1 WHERE user_id='owner'")
            db.commit()
            self.assertEqual(notice.owner_conversation(self.home, "owner"), "owner-chat")

    def test_waiting_does_not_use_registration_retry_budget(self):
        profile = SimpleNamespace(load_profile_config=lambda: SimpleNamespace(user_id="owner"), ProfileConfigError=ValueError)
        with patch.dict(sys.modules, {"clawchat_gateway.profile": profile}), \
             patch.dict("os.environ"), patch.object(sys, "path", list(sys.path)), \
             patch.object(notice, "owner_conversation", side_effect=[None] * 25 + ["chat"]), \
             patch.object(integration.time, "sleep") as sleep:
            integration.wait_for_greeting(self.home)
            self.assertEqual(sleep.call_count, 25)

    def test_missing_plugin_and_unknown_source_are_non_destructive(self):
        self.assertEqual(gateway_patch.prepare(self.home, self.home / "stage")[1]["status"], "not-installed")
        plugin = self.home / "plugins/clawchat"
        for relative in gateway_patch.FILES:
            target = plugin / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("# unrelated gateway version\n")
        swaps, report = gateway_patch.prepare(self.home, self.home / "stage")
        self.assertEqual(swaps, [])
        self.assertEqual(report["status"], "pending")
        for relative in gateway_patch.FILES:
            self.assertEqual((plugin / relative).read_text(), "# unrelated gateway version\n")


class GatewayPatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.plugin = self.home / "plugins/clawchat"
        shutil.copytree(ROOT / "ops/tests/fixtures/clawchat-greeting-before", self.plugin)

    def prepare(self):
        swaps, report = gateway_patch.prepare(self.home, self.home / "stage")
        self.assertEqual(report["status"], "prepared")
        self.assertEqual(len(swaps), 2)
        return swaps

    def test_real_hunks_stage_together_without_mutating_originals(self):
        original = {p: p.read_bytes() for p in self.plugin.rglob("*.py")}
        swaps = self.prepare()
        self.assertEqual(original, {p: p.read_bytes() for p in original})
        for _, source, target in swaps:
            shutil.copy2(source, target)
        again, report = gateway_patch.prepare(self.home, self.home / "second-stage")
        self.assertEqual(again, [])
        self.assertEqual(report["status"], "already-patched")

    def test_partial_patch_is_not_silently_accepted(self):
        swaps = self.prepare()
        _, prepared, target = swaps[0]
        shutil.copy2(prepared, target)
        before = {p: p.read_bytes() for p in self.plugin.rglob("*.py")}
        swaps, report = gateway_patch.prepare(self.home, self.home / "partial-stage")
        self.assertEqual(swaps, [])
        self.assertEqual(report["status"], "pending")
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_staging_inside_git_checkout_cannot_silently_skip_patch(self):
        subprocess.run(["git", "init", "-q", str(self.home)], check=True)
        self.prepare()

    def test_gateway_symlink_is_not_replaced(self):
        source = self.plugin / gateway_patch.FILES[0]
        outside = self.home / "shared-adapter.py"
        source.rename(outside)
        source.symlink_to(outside)
        swaps, report = gateway_patch.prepare(self.home, self.home / "stage")
        self.assertEqual(swaps, [])
        self.assertEqual(report["status"], "pending")
        self.assertTrue(source.is_symlink())

    def test_gateway_swaps_use_existing_updater_backup_and_rollback(self):
        import update
        swaps = self.prepare()
        before = {target: target.read_bytes() for _, _, target in swaps}
        for name, prepared, target in swaps:
            update.swap_tree(prepared, target, self.home / "backup" / name)
        for name, _, target in reversed(swaps):
            update.restore_tree(target, self.home / "backup" / name, self.home / "failed" / name)
        self.assertEqual(before, {target: target.read_bytes() for target in before})

    def adapter(self):
        swaps = self.prepare()
        source = next(p for _, p, _ in swaps if p.name == "adapter.py")
        tree = ast.parse(source.read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef))
        namespace = {
            "asyncio": asyncio, "Any": object, "InboundMessage": lambda **kw: SimpleNamespace(**kw),
            "load_activation_bootstrap_prompt": lambda: "welcome", "logger": Mock(),
            "is_default_profile": lambda: True,
        }
        exec(compile(ast.Module(body=cls.body, type_ignores=[]), str(source), "exec"), namespace)
        adapter_type = type("AdapterHarness", (), {key: value for key, value in namespace.items() if key.startswith("_") and callable(value)})
        adapter = adapter_type()
        adapter._store = Mock()
        adapter._store.claim_pending_activation_bootstrap.return_value = SimpleNamespace(conversation_id="chat", owner_user_id="owner", claimed_at=123)
        adapter._store.mark_activation_bootstrap_sent.return_value = True
        adapter._await_owner_metadata_refreshed = AsyncMock()
        adapter._handle_inbound = AsyncMock()
        adapter._visible_send_count = Mock(return_value=0)
        adapter._clawchat_config = SimpleNamespace(user_id="owner")
        adapter._liveware_sample_supervisor = SimpleNamespace(start_if_idle=lambda: "sample")
        adapter._spawn_liveware_sample_task = Mock()
        return adapter

    def test_no_visible_message_does_not_mark_greeting_or_start_sample(self):
        adapter = self.adapter()
        asyncio.run(adapter._dispatch_activation_bootstrap())
        adapter._store.mark_activation_bootstrap_sent.assert_not_called()
        adapter._store.release_activation_bootstrap_claim.assert_called_once()
        adapter._spawn_liveware_sample_task.assert_not_called()

    def test_acknowledged_message_marks_then_resumes_sample(self):
        adapter = self.adapter()
        calls = []
        adapter._visible_send_count.side_effect = [0, 1]
        adapter._store.mark_activation_bootstrap_sent.side_effect = lambda **_: calls.append("mark") or True
        adapter._store.has_sent_activation_bootstrap.side_effect = lambda **_: calls.append("check") or True
        adapter._spawn_liveware_sample_task.side_effect = lambda *_a, **_k: calls.append("sample")
        asyncio.run(adapter._dispatch_activation_bootstrap())
        self.assertEqual(calls, ["mark", "check", "sample"])

    def test_sample_does_not_start_before_current_owner_greeting(self):
        adapter = self.adapter()
        adapter._store.has_sent_activation_bootstrap.return_value = False
        adapter._schedule_liveware_sample()
        adapter._spawn_liveware_sample_task.assert_not_called()
        adapter._store.has_sent_activation_bootstrap.assert_called_once_with(platform="hermes", account_id="default", user_id="owner")

    def test_failed_send_releases_claim_but_does_not_register(self):
        adapter = self.adapter()
        adapter._handle_inbound.side_effect = OSError("send failed")
        with self.assertRaises(OSError):
            asyncio.run(adapter._dispatch_activation_bootstrap())
        adapter._store.mark_activation_bootstrap_sent.assert_not_called()
        adapter._store.release_activation_bootstrap_claim.assert_called_once()
        adapter._spawn_liveware_sample_task.assert_not_called()

    def test_failure_after_ack_does_not_release_and_repeat_greeting(self):
        adapter = self.adapter()
        adapter._handle_inbound.side_effect = OSError("post-send failure")
        adapter._visible_send_count.side_effect = [0, 1]
        with self.assertRaises(OSError):
            asyncio.run(adapter._dispatch_activation_bootstrap())
        adapter._store.mark_activation_bootstrap_sent.assert_called_once()
        adapter._store.release_activation_bootstrap_claim.assert_not_called()

    def test_reconnect_without_pending_claim_does_not_send_again(self):
        adapter = self.adapter()
        adapter._store.claim_pending_activation_bootstrap.return_value = None
        asyncio.run(adapter._dispatch_activation_bootstrap())
        adapter._handle_inbound.assert_not_called()
        adapter._store.mark_activation_bootstrap_sent.assert_not_called()

    def test_gateway_store_requires_current_user_and_exact_sent_flag(self):
        swaps = self.prepare()
        source = next(p for _, p, _ in swaps if p.name == "storage.py")
        cls = next(n for n in ast.parse(source.read_text()).body if isinstance(n, ast.ClassDef))
        method = next(n for n in cls.body if getattr(n, "name", None) == "has_sent_activation_bootstrap")
        namespace = {"sqlite3": sqlite3}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), "exec"), namespace)
        store = SimpleNamespace(initialize=lambda: None, _disabled=False, db_path=self.home / "store.sqlite")
        with closing(sqlite3.connect(store.db_path)) as db:
            db.execute("CREATE TABLE activations(platform,account_id,user_id,conversation_id,bootstrap_sent)")
            db.execute("INSERT INTO activations VALUES('hermes','default','owner','chat',0)")
            db.commit()
            check = lambda user: namespace["has_sent_activation_bootstrap"](store, platform="hermes", account_id="default", user_id=user)
            self.assertFalse(check("owner"))
            db.execute("UPDATE activations SET bootstrap_sent=1")
            db.commit()
            self.assertTrue(check("owner"))
            self.assertFalse(check("foreign"))


class EntryNoticeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.entry = {"status": "ready", "owner": {"user_id": "owner", "instance_id": "instance"}, "url": "https://app-example.apps.clawling.io/?release=0123456789abcdef"}
        modules = {
            "clawchat_gateway.profile": SimpleNamespace(load_profile_config=lambda: SimpleNamespace(user_id="owner")),
            "clawchat_gateway.protocol": SimpleNamespace(new_message_id=lambda: "notice-id"),
        }
        for patcher in [patch.dict(sys.modules, modules), patch.dict("os.environ"), patch.object(sys, "path", list(sys.path)), patch.object(notice, "owner_conversation", return_value="chat")]:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_unverified_entry_is_never_sent(self):
        with patch.object(notice, "send_notice", new_callable=AsyncMock) as send:
            self.assertEqual(notice.notify_ready(self.home, {"status": "pending"}), {"status": "pending"})
            send.assert_not_called()

    def test_sent_entry_is_not_repeated_after_restart(self):
        with patch.object(notice, "send_notice", new_callable=AsyncMock) as send:
            self.assertEqual(notice.notify_ready(self.home, self.entry)["status"], "sent")
            self.assertEqual(notice.notify_ready(self.home, self.entry)["status"], "already-sent")
            send.assert_awaited_once()

    def test_failed_ack_keeps_same_message_id_for_retry(self):
        with patch.object(notice, "send_notice", new_callable=AsyncMock, side_effect=[OSError("no ACK"), None]) as send:
            with self.assertRaises(OSError):
                notice.notify_ready(self.home, self.entry)
            saved = json.loads((self.home / "tavern-state/liveware-entry-notice.json").read_text())
            self.assertFalse(saved["sent"])
            self.assertEqual(notice.notify_ready(self.home, self.entry)["status"], "sent")
            self.assertEqual([call.args[3] for call in send.await_args_list], ["notice-id", "notice-id"])

    def test_foreign_owner_cannot_receive_entry(self):
        with patch.object(notice, "send_notice", new_callable=AsyncMock) as send:
            self.entry["owner"]["user_id"] = "foreign"
            with self.assertRaises(RuntimeError):
                notice.notify_ready(self.home, self.entry)
            send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
