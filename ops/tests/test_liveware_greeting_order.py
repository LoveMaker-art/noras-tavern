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


class GreetingOrderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def test_runtime_starts_before_registration(self):
        calls = []
        with patch.object(integration, "start_runtime", side_effect=lambda *_, **__: calls.append("runtime")), \
             patch.object(integration, "ensure", side_effect=lambda *_, **__: calls.append("apps") or {"status": "pending"}):
            self.assertEqual(integration.startup(self.home)["status"], "pending")
        self.assertEqual(calls, ["runtime", "apps"])

    def test_runtime_retries_before_registration(self):
        with patch.object(integration, "start_runtime", side_effect=[OSError("temporary"), 0]) as start, \
             patch.object(integration.time, "sleep"), \
             patch.object(integration, "ensure", return_value={"status": "pending"}) as register:
            integration.startup(self.home)
        self.assertEqual(start.call_count, 2)
        register.assert_called_once()

    def test_runtime_failure_never_registers(self):
        with patch.object(integration, "RETRY_DELAYS", (0, 0)), \
             patch.object(integration, "start_runtime", side_effect=OSError("offline")), \
             patch.object(integration, "ensure") as register:
            self.assertEqual(integration.startup(self.home)["status"], "runtime-start-failed")
        register.assert_not_called()

    def test_success_order_runtime_apps_verified_notice(self):
        calls = []
        with patch.object(integration, "start_runtime", side_effect=lambda *_, **__: calls.append("runtime")), \
             patch.object(integration, "ensure", side_effect=lambda *_, **__: calls.append("apps") or {"status": "updated"}), \
             patch.object(integration, "verified_entry", side_effect=lambda *_, **__: calls.append("verify") or {"status": "ready"}), \
             patch.object(notice, "notify_ready", side_effect=lambda *_, **__: calls.append("notice") or {"status": "sent"}):
            self.assertEqual(integration.startup(self.home)["notice"]["status"], "sent")
        self.assertEqual(calls, ["runtime", "apps", "verify", "notice"])

    def test_worker_lock_prevents_second_worker(self):
        with integration.registration_lock(self.home, worker=True), \
             patch.object(integration, "start_runtime") as start:
            self.assertEqual(integration.startup(self.home)["status"], "already-running")
        start.assert_not_called()

    def test_failed_registration_never_sends_url(self):
        with patch.object(integration, "start_runtime"), \
             patch.object(integration, "ensure", return_value={"status": "pending"}), \
             patch.object(notice, "notify_ready") as send:
            self.assertEqual(integration.startup(self.home)["status"], "pending")
        send.assert_not_called()

    def test_registration_stays_ready_if_owner_conversation_is_pending(self):
        with patch.object(integration, "start_runtime"), \
             patch.object(integration, "ensure", return_value={"status": "updated"}) as register, \
             patch.object(integration, "verified_entry", return_value={"status": "ready"}), \
             patch.object(notice, "notify_ready", side_effect=[{"status": "waiting-for-conversation"}, {"status": "sent"}]), \
             patch.object(integration, "RETRY_DELAYS", (0, 0)):
            result = integration.startup(self.home)
        register.assert_called_once()
        self.assertEqual(result["notice"]["status"], "sent")

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
        subprocess.run(["git", "apply", str(self.plugin / "legacy-order.patch")],
                       cwd=self.plugin, check=True, capture_output=True)

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

    def test_restores_exact_upstream_sources(self):
        for _, prepared, target in self.prepare():
            upstream = ROOT / "ops/tests/fixtures/clawchat-greeting-before" / target.relative_to(self.plugin)
            self.assertEqual(prepared.read_bytes(), upstream.read_bytes())

    def test_clean_upstream_is_unchanged(self):
        for relative in gateway_patch.FILES:
            shutil.copy2(ROOT / "ops/tests/fixtures/clawchat-greeting-before" / relative,
                         self.plugin / relative)
        swaps, report = gateway_patch.prepare(self.home, self.home / "clean-stage")
        self.assertEqual((swaps, report), ([], {"status": "already-patched"}))

    def test_sample_starts_while_greeting_is_still_running(self):
        adapter = self.adapter()
        adapter._store.has_sent_activation_bootstrap.return_value = False

        async def scenario():
            entered, release = asyncio.Event(), asyncio.Event()
            async def delayed(_):
                entered.set()
                await release.wait()
            adapter._handle_inbound.side_effect = delayed
            greeting = asyncio.create_task(adapter._dispatch_activation_bootstrap())
            try:
                await entered.wait()
                adapter._schedule_liveware_sample()
                adapter._spawn_liveware_sample_task.assert_called_once()
                self.assertFalse(greeting.done())
                adapter._store.has_sent_activation_bootstrap.assert_not_called()
            finally:
                release.set()
                await greeting

        asyncio.run(scenario())

    def test_async_dispatch_does_not_reintroduce_our_premature_failure_check(self):
        adapter = self.adapter()

        async def scenario():
            tasks = []
            async def delivered_later():
                await asyncio.sleep(0)
            async def queued(_):
                tasks.append(asyncio.create_task(delivered_later()))
            adapter._handle_inbound.side_effect = queued
            await adapter._dispatch_activation_bootstrap()
            await asyncio.gather(*tasks)

        asyncio.run(scenario())
        adapter._store.release_activation_bootstrap_claim.assert_not_called()
        # Preserve the plugin's own bootstrap bookkeeping; Nora no longer treats
        # this flag as an ACK or as permission to register/send an App.
        adapter._store.mark_activation_bootstrap_sent.assert_called_once()

    def test_failed_greeting_does_not_block_sample(self):
        adapter = self.adapter()
        adapter._handle_inbound.side_effect = OSError("send failed")
        with self.assertRaises(OSError):
            asyncio.run(adapter._dispatch_activation_bootstrap())
        adapter._schedule_liveware_sample()
        adapter._spawn_liveware_sample_task.assert_called_once()

    def test_reconnect_without_pending_claim_does_not_send_again(self):
        adapter = self.adapter()
        adapter._store.claim_pending_activation_bootstrap.return_value = None
        asyncio.run(adapter._dispatch_activation_bootstrap())
        adapter._handle_inbound.assert_not_called()



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
