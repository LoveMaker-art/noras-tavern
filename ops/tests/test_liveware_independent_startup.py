"""Registration and entry delivery must not depend on a model greeting."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/updater"))
import liveware_integration as integration
import liveware_notice as notice


class IndependentStartupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "hermes"
        self.tavern = self.root / "tavern"
        database = self.home / "clawchat/clawchat.sqlite"
        database.parent.mkdir(parents=True)
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("CREATE TABLE activations(platform, account_id, user_id, conversation_id, bootstrap_sent)")
            db.execute("INSERT INTO activations VALUES('hermes','default','owner','chat',0)")
        self.owner = {"user_id": "owner", "instance_id": "instance"}
        self.entry = {"status": "ready", "owner": self.owner,
                      "url": "https://app-example.apps.clawling.io/?release=0123456789abcdef"}

    def test_reconcile_registers_with_unsent_greeting(self):
        with patch.object(integration, "runtime_asset_release", return_value="a" * 16), \
             patch.object(integration, "authenticate", return_value=self.owner), \
             patch.object(integration, "_reconcile", return_value={"status": "updated", "assetRelease": "a" * 16}) as register:
            result = integration.initialize(self.tavern, hermes_home=self.home)
        self.assertEqual(result["status"], "updated")
        register.assert_called_once()

    def test_owner_conversation_exists_before_greeting(self):
        self.assertEqual(notice.owner_conversation(self.home, "owner"), "chat")
        self.assertIsNone(notice.owner_conversation(self.home, "foreign"))

    def test_startup_registers_and_sends_before_greeting_without_changing_marker(self):
        modules = {
            "clawchat_gateway.profile": SimpleNamespace(load_profile_config=lambda: SimpleNamespace(user_id="owner"), ProfileConfigError=ValueError),
            "clawchat_gateway.protocol": SimpleNamespace(new_message_id=lambda: "entry-id"),
        }
        order = []
        async def send(*args):
            order.append("entry")
        with patch.dict(sys.modules, modules), patch.dict("os.environ"), \
             patch.object(sys, "path", list(sys.path)), \
             patch.object(integration, "start_runtime", side_effect=lambda *a, **k: order.append("runtime")), \
             patch.object(integration, "ensure", side_effect=lambda *a, **k: order.append("register") or {"status": "updated"}), \
             patch.object(integration, "verified_entry", return_value=self.entry), \
             patch.object(notice, "send_notice", side_effect=send), \
             patch.object(integration.time, "sleep", side_effect=AssertionError("Must not wait for greeting")):
            result = integration.startup(self.tavern, hermes_home=self.home)
        self.assertEqual(order, ["runtime", "register", "entry"])
        self.assertEqual(result["notice"]["status"], "sent")
        with closing(sqlite3.connect(self.home / "clawchat/clawchat.sqlite")) as db, db:
            self.assertEqual(db.execute("SELECT bootstrap_sent FROM activations").fetchone()[0], 0)
        saved = json.loads((self.tavern / "tavern-state/liveware-entry-notice.json").read_text())
        self.assertTrue(saved["sent"])

    def test_missing_conversation_does_not_send_to_another_user(self):
        modules = {"clawchat_gateway.profile": SimpleNamespace(load_profile_config=lambda: SimpleNamespace(user_id="owner")),
                   "clawchat_gateway.protocol": SimpleNamespace(new_message_id=lambda: "entry-id")}
        with closing(sqlite3.connect(self.home / "clawchat/clawchat.sqlite")) as db, db:
            db.execute("UPDATE activations SET conversation_id=NULL")
        with patch.dict(sys.modules, modules), patch.dict("os.environ"), \
             patch.object(sys, "path", list(sys.path)), \
             patch.object(notice, "send_notice", new_callable=AsyncMock) as send:
            self.assertEqual(notice.notify_ready(self.tavern, self.entry, hermes_home=self.home),
                             {"status": "waiting-for-conversation"})
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
