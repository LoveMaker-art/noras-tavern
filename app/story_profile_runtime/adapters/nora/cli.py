#!/usr/bin/env python3
"""Nora process adapter for the Story Profile workspace."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ROOT = WORKSPACE_ROOT.parent
CORE_ROOT = WORKSPACE_ROOT / "core"


def _app_root() -> Path:
    configured = os.environ.get("TAVERN_APP_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    candidates = (
        PROJECT_ROOT,
        PROJECT_ROOT / "app",
    )
    for candidate in candidates:
        if (candidate / "actor_self.md").is_file():
            return candidate.resolve()
    return (PROJECT_ROOT / "app").resolve()


APP_ROOT = _app_root()
sys.path.insert(0, str(CORE_ROOT))
sys.path.insert(0, str(APP_ROOT))

import personality_service  # noqa: E402
import story_profile  # noqa: E402
import reflection  # noqa: E402


def _state_directory() -> Path:
    configured = os.environ.get("TAVERN_STATE_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    data_root = Path(os.environ.get(
        "TAVERN_DATA_ROOT", story_profile.HERMES_HOME)).expanduser().resolve()
    return data_root / "tavern-state"


STATE_DIR = _state_directory()
SEED_ACTOR = APP_ROOT / "actor_self.md"


def _emit(value: dict, status: int = 0) -> int:
    print(json.dumps(value, ensure_ascii=False))
    return status


def _request() -> dict:
    value = json.load(sys.stdin)
    if not isinstance(value, dict):
        raise ValueError("Story Profile request must be an object")
    return value


def _model(payload: dict):
    return reflection.OpenAICompatibleModelClient(payload.get("model"))


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if command == "personality-read":
            return _emit(personality_service.read_document())
        if command == "personality-write":
            payload = _request()
            saved = personality_service.write_document(
                payload.get("content"), payload.get("revision"))
            return _emit({"ok": True, **saved})
        if command == "sync-story-states":
            payload = _request()
            productions = payload.get("productions")
            if not isinstance(productions, list):
                raise ValueError("productions must be an array of activated ledgers")
            worlds = story_profile.sync_story_states(STATE_DIR, SEED_ACTOR, productions)
            return _emit({"ok": True, "shared_story_worlds": len(worlds)})
        if command in {"reflect-preview", "reflect"}:
            payload = _request()
            result = reflection.reflect_context(
                story_profile,
                _model(payload),
                STATE_DIR,
                APP_ROOT / "actor_self.md",
                payload.get("context"),
                write=command == "reflect",
            )
            return _emit({"ok": True, **result})
        if command == "learn":
            payload = _request()
            result = reflection.learn_explicit(
                story_profile,
                _model(payload),
                STATE_DIR,
                APP_ROOT / "actor_self.md",
                payload.get("change", ""),
                payload.get("reason", ""),
            )
            return _emit({"ok": True, **result})
        if command == "refresh-taste":
            payload = _request()
            value = reflection.refresh_taste_profile(
                story_profile,
                _model(payload),
                STATE_DIR,
                APP_ROOT / "actor_self.md",
            )
            return _emit({
                "ok": True,
                "taste_profile": value,
                "taste_fields": sum(1 for item in value.values() if item),
                "profile": story_profile.audit(
                    STATE_DIR, APP_ROOT / "actor_self.md"),
            })
        return _emit({"error": "unknown_story_profile_adapter_command"}, 64)
    except personality_service.PersonalityConflict as error:
        return _emit({
            "ok": False,
            "code": "revision_conflict",
            "error": str(error),
        }, 3)
    except Exception as error:
        return _emit({"ok": False, "error": str(error)}, 2)


if __name__ == "__main__":
    raise SystemExit(main())
