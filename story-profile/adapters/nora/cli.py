#!/usr/bin/env python3
"""Nora process adapter for the Story Profile workspace."""

from __future__ import annotations

import hashlib
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


def _automatic_preference_enabled(preference_file) -> bool:
    """Match the Node reader; explicit overrides bind unchanged legacy bytes."""
    def unreadable():
        return reflection.StoryProfileReflectionError(
            "自动复盘设置无法核验；已保留原设置，未发起新的模型请求。",
            code="STORY_PROFILE_SETTINGS_UNREADABLE")

    def reject_constant(_value):
        raise ValueError("Non-standard JSON constant")

    current_present = True
    try:
        current = json.loads((STATE_DIR / "story_profile_preference_settings.json").read_text(encoding="utf-8"), parse_constant=reject_constant)
    except FileNotFoundError:
        current = None
        current_present = False
    except (OSError, ValueError, UnicodeError) as error:
        raise unreadable() from error
    if current_present and (not isinstance(current, dict) or type(current.get("auto_enabled")) is not bool):
        raise unreadable()
    if not isinstance(preference_file, str) or not preference_file.strip():
        raise unreadable()
    source = {"path_sha256": hashlib.sha256(os.path.abspath(preference_file).encode("utf-8")).hexdigest(), "sha256": "missing"}
    legacy_bytes = None
    try:
        legacy_bytes = Path(preference_file).read_bytes()
    except FileNotFoundError:
        pass
    except OSError as error:
        raise unreadable() from error
    if legacy_bytes is not None:
        source["sha256"] = hashlib.sha256(legacy_bytes).hexdigest()
    recorded = current.get("legacy_source") if isinstance(current, dict) else None
    overridden = isinstance(recorded, dict) and all(recorded.get(key) == value for key, value in source.items())
    if overridden:
        return current["auto_enabled"]
    legacy_choice = None
    if legacy_bytes is not None:
        try:
            legacy = json.loads(legacy_bytes.decode("utf-8-sig"), parse_constant=reject_constant)
            if not isinstance(legacy, dict):
                raise ValueError("Invalid legacy document")
            if "automatic_reflection" in legacy:
                choice = legacy["automatic_reflection"]
                if not isinstance(choice, dict) or type(choice.get("enabled")) is not bool:
                    raise ValueError("Invalid legacy choice")
                legacy_choice = choice["enabled"]
        except (ValueError, UnicodeError) as error:
            raise unreadable() from error
    return (current is None or current["auto_enabled"]) and legacy_choice is not False


def _model(payload: dict):
    client = reflection.OpenAICompatibleModelClient(payload.get("model"))
    if "automatic_preference_file" not in payload:
        return client

    class AutomaticModel:
        def __getattr__(self, name):
            return getattr(client, name)

        def complete(self, messages):
            if not _automatic_preference_enabled(payload["automatic_preference_file"]):
                raise reflection.StoryProfileReflectionError(
                    "自动复盘已关闭；已发请求的结果保留，未发起新的模型请求。",
                    code="STORY_PROFILE_AUTO_REFLECTION_DISABLED")
            return client.complete(messages)

    return AutomaticModel()


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
        if command == "recover-profile":
            result = story_profile.recover_profile(STATE_DIR, SEED_ACTOR, include_status=True)
            current, report = result["profile"], result["projections"]
            complete = report["status"] == "complete"
            return _emit({"ok": complete, "status": "completed" if complete else "partial", "stage": "projection", "model_called": False,
                          "summary_saved": story_profile.taste_summary_state(current)["status"] == "current", "projections": report,
                          "profile": story_profile.audit(STATE_DIR, SEED_ACTOR)}, 0 if complete else 2)
        if command == "sync-story-states":
            payload = _request()
            productions = payload.get("productions")
            if not isinstance(productions, list):
                raise ValueError("productions must be an array of session ledger states")
            result = story_profile.sync_story_states(STATE_DIR, SEED_ACTOR, productions, include_status=True)
            worlds, report = result["worlds"], result["projections"]
            # Source status was saved even when a separately reported memory
            # target has no capacity. The JS source publication must keep it.
            return _emit({"ok": True, "saved": True, "status": report["status"], "shared_story_worlds": len(worlds), "projections": report})
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
            return _emit({"ok": True, **result}, 0 if result.get("ok", True) else 2)
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
            return _emit({"ok": True, **result}, 0 if result.get("ok", True) else 2)
        if command == "refresh-taste":
            payload = _request()
            reflection.refresh_taste_profile(
                story_profile,
                _model(payload),
                STATE_DIR,
                APP_ROOT / "actor_self.md",
            )
            result = reflection._saved_result(story_profile, STATE_DIR, SEED_ACTOR, {"extraction_complete": True})
            return _emit({
                **result,
                "taste_fields": sum(1 for item in (result.get("taste_profile") or {}).values() if item),
                "profile": story_profile.audit(
                    STATE_DIR, APP_ROOT / "actor_self.md"),
            }, 0 if result["ok"] else 2)
        return _emit({"error": "unknown_story_profile_adapter_command"}, 64)
    except personality_service.PersonalityConflict as error:
        return _emit({
            "ok": False,
            "code": "revision_conflict",
            "error": str(error),
        }, 3)
    except Exception as error:
        partial = command == "refresh-taste" or bool(getattr(error, "committed", False))
        return _emit({"ok": False, "status": "partial" if partial else "failed",
                      "stage": "summary" if command == "refresh-taste" else "save",
                      "extraction_complete": partial, "summary_status": "failed",
                      "code": getattr(error, "code", "STORY_PROFILE_REFLECTION_FAILED"),
                      "error": str(error)}, 2)


if __name__ == "__main__":
    raise SystemExit(main())
