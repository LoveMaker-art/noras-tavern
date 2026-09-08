#!/usr/bin/env python3
"""Inspect and maintain Nora Tavern's structured Story Profile projections."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def default_nora_home() -> Path:
    if os.environ.get("NORA_TAVERN_HOME"):
        return Path(os.environ["NORA_TAVERN_HOME"]).expanduser().resolve()
    if sys.platform == "darwin":
        return (Path.home() / "Library/Application Support/Nora Tavern").resolve()
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
        return (base / "Nora Tavern").resolve()
    base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    return (base / "nora-tavern").resolve()


NORA_HOME = default_nora_home()
HERMES_HOME = Path(os.environ.get("HERMES_HOME") or NORA_HOME / "hermes").expanduser().resolve()
DATA_ROOT = Path(os.environ.get("TAVERN_DATA_ROOT") or NORA_HOME / "tavern").expanduser().resolve()
RUNTIME = Path(os.environ.get(
    "TAVERN_APP_DIR", DATA_ROOT / "apps/tavern-runtime")).expanduser().resolve()
STATE = Path(os.environ.get(
    "TAVERN_STATE_DIR", DATA_ROOT / "tavern-state")).expanduser().resolve()
SEED_ACTOR = RUNTIME / "actor_self.md"
CORE = RUNTIME / "story_profile_runtime" / "core"
sys.path.insert(0, str(CORE))

import story_profile  # noqa: E402


def _print(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("audit")
    sub.add_parser("memory-preview")
    sub.add_parser("memory-sync")

    context = sub.add_parser("context")
    context.add_argument("message", nargs="?", default="")

    for command in ("confirm", "reject"):
        item = sub.add_parser(command)
        item.add_argument("preference_id")

    edit = sub.add_parser("edit")
    edit.add_argument("preference_id")
    edit.add_argument("text")
    edit.add_argument(
        "--scope",
        choices=("tavern", "agent_chat", "both", "ruotang_chat"),
        help="Use agent_chat for the current Hermes agent; ruotang_chat is a legacy alias.",
    )

    lock = sub.add_parser("lock")
    lock.add_argument("preference_id")
    lock.add_argument("--off", action="store_true")

    args = parser.parse_args()
    profile = story_profile.ensure_profile(STATE, SEED_ACTOR)

    if args.command == "audit":
        return _print(story_profile.audit(STATE, SEED_ACTOR))
    if args.command == "memory-preview":
        return _print(story_profile.memory_preview(profile))
    if args.command == "memory-sync":
        return _print(story_profile.sync_profile_memories(STATE, SEED_ACTOR))
    if args.command == "context":
        return print(story_profile.context_for_message(profile, args.message))
    if args.command in {"confirm", "reject"}:
        status = "confirmed" if args.command == "confirm" else "rejected"
        return _print(story_profile.update_preference(
            STATE, SEED_ACTOR, args.preference_id, status=status))
    if args.command == "edit":
        scope = "ruotang_chat" if args.scope == "agent_chat" else args.scope
        return _print(story_profile.update_preference(
            STATE, SEED_ACTOR, args.preference_id, text=args.text, scope=scope))
    if args.command == "lock":
        return _print(story_profile.update_preference(
            STATE, SEED_ACTOR, args.preference_id, locked=not args.off))


if __name__ == "__main__":
    main()
