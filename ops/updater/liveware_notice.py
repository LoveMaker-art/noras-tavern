"""Deliver a verified first-run entry without asking the model to invent URLs."""
import asyncio
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys
from types import SimpleNamespace

from liveware_integration import atomic_json, registration_lock


def owner_conversation(home, user_id):
    path = Path(home) / "clawchat/clawchat.sqlite"
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as db:
        rows = db.execute(
            "SELECT conversation_id, bootstrap_sent FROM activations "
            "WHERE platform = 'hermes' AND account_id = 'default' AND user_id = ?",
            (user_id,),
        ).fetchall()
    if len(rows) != 1 or not rows[0][0] or rows[0][1] != 1:
        return None
    return rows[0][0]


async def send_notice(home, owner, conversation, message_id, url):
    import yaml
    from clawchat_gateway.config import ClawChatConfig
    from clawchat_gateway.connection import ClawChatConnection
    from clawchat_gateway.protocol import build_message_send_event
    from clawchat_gateway.standalone_send import _drop_inbound, READY_TIMEOUT_SECONDS
    from clawchat_gateway.profile import load_profile_config

    raw = yaml.safe_load((Path(home) / "config.yaml").read_text()) or {}
    extra = raw.get("platforms", {}).get("clawchat", {}).get("extra", {})
    config = ClawChatConfig.from_platform_config(SimpleNamespace(extra=extra))
    connection = ClawChatConnection(config, on_message=_drop_inbound)
    connection.use_sibling_connect_device_id("-tavern-entry")
    try:
        await connection.start()
        if not await connection.wait_until_ready(timeout=READY_TIMEOUT_SECONDS):
            raise RuntimeError("ClawChat entry delivery is waiting for connection readiness")
        if connection.config.user_id != owner["user_id"] or load_profile_config().user_id != owner["user_id"]:
            raise RuntimeError("ClawChat identity changed before entry delivery")
        if owner_conversation(home, owner["user_id"]) != conversation:
            raise RuntimeError("Owner conversation changed before entry delivery")
        frame = build_message_send_event(
            chat_id=conversation, chat_type="direct", message_id=message_id,
            fragments=[{"kind": "text", "text": url}], include_message_id=True,
        )
        if not await connection.send_frame(frame, wait_for_ack=True, queue_when_unready=False):
            raise RuntimeError("ClawChat entry delivery was not acknowledged")
    finally:
        await connection.stop()


def notify_ready(home, entry):
    if entry.get("status") != "ready":
        return {"status": "pending"}
    home = Path(home)
    os.environ["HOME"] = os.environ["HERMES_HOME"] = str(home)
    sys.path.insert(0, str(home / "plugins/clawchat"))
    from clawchat_gateway.profile import load_profile_config
    from clawchat_gateway.protocol import new_message_id

    owner = entry["owner"]
    if load_profile_config().user_id != owner["user_id"]:
        raise RuntimeError("Verified entry belongs to another ClawChat identity")
    conversation = owner_conversation(home, owner["user_id"])
    if not conversation:
        return {"status": "waiting-for-greeting"}
    path = home / "tavern-state/liveware-entry-notice.json"
    with registration_lock(home):
        saved = json.loads(path.read_text()) if path.exists() else {}
        same_target = saved.get("owner") == owner and saved.get("conversation") == conversation
        if same_target and saved.get("sent"):
            return {"status": "already-sent", "message_id": saved["message_id"]}
        if not same_target:
            saved = {
                "owner": owner, "conversation": conversation, "message_id": new_message_id(),
                "url": entry["url"], "sent": False,
            }
            atomic_json(path, saved)
        if saved["url"] != entry["url"]:
            raise RuntimeError("Pending entry URL changed; delivery needs review")
        # Persist the message ID before sending. Retries reuse it for server-side deduplication.
        asyncio.run(send_notice(home, owner, conversation, saved["message_id"], saved["url"]))
        saved["sent"] = True
        atomic_json(path, saved)
        return {"status": "sent", "message_id": saved["message_id"]}
