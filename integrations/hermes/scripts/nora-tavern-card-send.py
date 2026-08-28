#!/usr/bin/env python3
"""Send the Nora Tavern update notice as one Markdown chat bubble."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))
PLUGIN_ROOT = HERMES_HOME / "plugins" / "clawchat"
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))


def _load_extra_config() -> dict[str, Any]:
    import yaml

    path = HERMES_HOME / "config.yaml"
    if not path.is_file():
        return {}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return (((raw.get("platforms") or {}).get("clawchat") or {}).get("extra") or {})


def _owner_conversation_id(account_id: str) -> str:
    db_path = HERMES_HOME / "clawchat" / "clawchat.sqlite"
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as connection:
        row = connection.execute(
            """
            SELECT conversation_id
              FROM activations
             WHERE account_id = ?
               AND conversation_id IS NOT NULL
               AND conversation_id <> ''
             LIMIT 1
            """,
            (account_id,),
        ).fetchone()
    if row is None:
        raise RuntimeError("ClawChat owner conversation is not available")
    return str(row[0])


def _markdown(installed: str, latest: str) -> str:
    return "\n".join(
        (
            "## 酒馆发现新版本",
            "",
            f"**当前版本：** {installed}",
            f"**最新版本：** {latest}",
            "",
            "> 数据尚未变化",
            "",
            "**如需更新请回复：帮我查看更新**",
        )
    )


async def _send(installed: str, latest: str, account_id: str) -> None:
    from clawchat_gateway.standalone_send import standalone_send

    result = await standalone_send(
        SimpleNamespace(extra=_load_extra_config()),
        _owner_conversation_id(account_id),
        _markdown(installed, latest),
    )
    if not result.get("success"):
        raise RuntimeError(str(result.get("error") or "ClawChat delivery failed"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--installed", required=True)
    parser.add_argument("--latest", required=True)
    parser.add_argument("--account-id", default="default")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.dry_run:
        print(
            json.dumps(
                {"kind": "text", "text": _markdown(args.installed, args.latest)},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    asyncio.run(_send(args.installed, args.latest, args.account_id))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # cron records stderr locally; keep stdout empty
        print(f"ClawChat update notice delivery failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
