"""Structured story profile, timeline archive, and Hermes memory projections."""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
import time
from contextlib import closing, contextmanager
from datetime import datetime
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX development environments
    fcntl = None
try:
    import msvcrt
except ImportError:  # pragma: no cover - POSIX platforms
    msvcrt = None


SCHEMA_VERSION = 1
RECENT_TIMELINE_LIMIT = 8
ERA_EVENT_LIMIT = 20
HERMES_DEFAULT_USER_CHAR_LIMIT = 1375
HERMES_DEFAULT_MEMORY_CHAR_LIMIT = 2200
# Keep capacity for one 100-character memory entry and Hermes' 3-character delimiter.
USER_MEMORY_RESERVE_CHARS = 103
MEMORY_PROJECTION_MAX_CHARS = 1300
SHARED_STORY_WORLD_LIMIT = 3
SHARED_STORY_EVENT_LIMIT = 4
SHARED_STORY_THREAD_LIMIT = 2
PROFILE_FILENAME = "story_profile.json"
EVENTS_FILENAME = "profile_events.jsonl"
ERAS_FILENAME = "profile_eras.json"
COMMIT_FILENAME = "profile_commit.json"
PROJECTION_STATUS_FILENAME = "story_profile_projection_status.json"
TASTE_PROFILE_V2_LIMITS = {"story_tastes": 4, "narrative_habits": 3, "co_creation": 3, "boundaries": 4}
TASTE_PROFILE_V2_FIELDS = tuple(TASTE_PROFILE_V2_LIMITS)
TASTE_PROFILE_V2_VALUE_LIMIT = 100
TASTE_PROFILE_V2_BODY_LIMIT = 1400


class StoryProfileStorageError(RuntimeError):
    def __init__(self, message, *, code="STORY_PROFILE_STORAGE_FAILED", path=None, committed=False, receipt=None):
        super().__init__(message)
        self.code = code
        self.path = str(path) if path is not None else None
        self.committed = committed
        self.receipt = receipt

USER_START = "<!-- TAVERN_USER_PROFILE_START -->"
USER_END = "<!-- TAVERN_USER_PROFILE_END -->"
MEMORY_START = "<!-- TAVERN_SHARED_MEMORY_START -->"
MEMORY_END = "<!-- TAVERN_SHARED_MEMORY_END -->"
PROJECTION_REVISION_PREFIX = "<!-- TAVERN_PROJECTION_REVISION:"


def _default_hermes_home() -> Path:
    configured = os.environ.get("HERMES_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    if sys.platform.startswith("linux") and Path("/opt/data/skills").is_dir():
        return Path("/opt/data")
    return (Path.home() / ".hermes").resolve()


HERMES_HOME = _default_hermes_home()

_LOCK = threading.RLock()
_LOCKED_PROFILES: set[Path] = set()

_SENSITIVE_STORY_TERMS = (
    "nsfw", "性爱", "性行为", "性描写", "性作为", "献身", "体液", "裸体", "娼",
    "强制", "暴力", "禁忌", "色情", "淫秽",
    "explicit", "sexual", "violence", "fetish",
)
TASTE_PROFILE_FIELDS = (
    "character_styles", "relationship_dynamics", "story_themes", "pacing",
    "narrative_style", "interaction_preferences", "response_adaptations", "boundaries",
)


def _now() -> int:
    return int(time.time())


def _stable_id(prefix: str, *parts: object) -> str:
    raw = "\x1f".join(str(part or "") for part in parts)
    return f"{prefix}_{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:14]}"


def _replace_atomic_file(source: Path, destination: Path) -> None:
    """Allow short Windows reader sharing conflicts without deleting the target."""
    deadline = time.monotonic() + 1.0
    while True:
        try:
            os.replace(source, destination)
            return
        except OSError as error:
            if getattr(error, "winerror", None) not in {5, 32, 33} or time.monotonic() >= deadline:
                raise
            time.sleep(0.025)


def _atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp.{os.getpid()}.{threading.get_ident()}")
    try:
        with tmp.open("w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        _replace_atomic_file(tmp, path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def _atomic_json(path: Path, value: object) -> None:
    _atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


@contextmanager
def _file_lock(path: Path):
    lock_path = path.with_name(path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        if fcntl is not None:
            fcntl.flock(handle, fcntl.LOCK_EX)
        elif msvcrt is not None:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            deadline = time.monotonic() + 15
            while True:
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as error:
                    if time.monotonic() >= deadline:
                        raise StoryProfileStorageError(
                            "Story Profile is busy; retry the existing operation after its writer finishes.",
                            code="STORY_PROFILE_BUSY", path=path) from error
                    time.sleep(0.025)
        else:  # A platform without a real interprocess lock must not write unprotected.
            raise StoryProfileStorageError("Interprocess profile locking is unavailable.", code="STORY_PROFILE_LOCK_UNAVAILABLE", path=path)
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(handle, fcntl.LOCK_UN)
            elif msvcrt is not None:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def _read_json(path: Path, default):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value
    except FileNotFoundError:
        return default
    except (OSError, ValueError, TypeError) as error:
        raise StoryProfileStorageError(
            f"Cannot read Story Profile file {path.name}; existing data was preserved.",
            code="STORY_PROFILE_READ_FAILED", path=path) from error


@contextmanager
def _profile_lock(state_dir: str | Path):
    """Serialize short profile commits across threads AND adapter processes.

    ensure_profile is nested in mutators; re-use its outer flock rather than
    deadlocking on a second file descriptor. Never hold this across model I/O.
    """
    key = Path(state_dir).resolve() / PROFILE_FILENAME
    with _LOCK:
        if key in _LOCKED_PROFILES:
            yield
            return
        with _file_lock(key):
            _LOCKED_PROFILES.add(key)
            try:
                _recover_profile_commit(Path(state_dir))
                yield
            finally:
                _LOCKED_PROFILES.remove(key)


def _file_hash(path: Path):
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def _recover_profile_commit(root: Path) -> None:
    """Roll forward an interrupted, fully prepared canonical commit under its lock.

    Before/after hashes prevent a stale journal from overwriting an unrelated edit.
    Derived Markdown and Hermes projections are rebuilt by the caller afterwards.
    """
    journal_path = root / COMMIT_FILENAME
    journal = _read_json(journal_path, None)
    if journal is None:
        return
    allowed = {PROFILE_FILENAME, EVENTS_FILENAME, ERAS_FILENAME}
    documents = journal.get("documents") if isinstance(journal, dict) else None
    if not isinstance(journal, dict) or journal.get("schema") != "story-profile-commit/1" or not isinstance(documents, dict) or not documents or not set(documents).issubset(allowed):
        raise StoryProfileStorageError("Invalid Story Profile commit journal; preserve it for recovery.", code="STORY_PROFILE_COMMIT_INVALID", path=journal_path)
    for name, document in documents.items():
        if not isinstance(document, dict) or not isinstance(document.get("text"), str):
            raise StoryProfileStorageError("Invalid Story Profile commit document.", code="STORY_PROFILE_COMMIT_INVALID", path=journal_path)
        actual = hashlib.sha256(document["text"].encode("utf-8")).hexdigest()
        if actual != document.get("after") or _file_hash(root / name) not in (document.get("before"), actual):
            raise StoryProfileStorageError(f"Story Profile recovery conflicts with {name}; no file was replaced.", code="STORY_PROFILE_COMMIT_CONFLICT", path=root / name)
    for name, document in documents.items():
        if _file_hash(root / name) != document["after"]:
            _atomic_text(root / name, document["text"])
    journal_path.unlink()


def _commit_profile(state_dir, profile, *, events=None, era_items=None) -> None:
    root = Path(state_dir)
    documents = {}
    if events is not None:
        documents[EVENTS_FILENAME] = "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events)
    if era_items is not None:
        documents[ERAS_FILENAME] = json.dumps(era_items, ensure_ascii=False, indent=2) + "\n"
    documents[PROFILE_FILENAME] = json.dumps(profile, ensure_ascii=False, indent=2) + "\n"
    prepared = {
        name: {"before": _file_hash(root / name), "after": hashlib.sha256(text.encode("utf-8")).hexdigest(), "text": text}
        for name, text in documents.items()
    }
    _atomic_json(root / COMMIT_FILENAME, {"schema": "story-profile-commit/1", "documents": prepared})
    _recover_profile_commit(root)


def _refresh_derived(state_dir, profile, era_items, *, receipt=None):
    actor = {"status": "complete", "code": ""}
    try:
        _atomic_text(Path(state_dir) / "actor_self.md", render_markdown(profile, era_items))
    except Exception as error:
        actor = {"status": "pending", "code": "STORY_PROFILE_DISPLAY_PENDING"}
    try:
        result = sync_hermes_memories(profile, state_dir=state_dir)
    except Exception:
        # Canonical preference/summary commits remain successful even if a
        # derived writer itself is unavailable. The final caller reports this.
        pending = {"status": "pending", "code": "STORY_PROFILE_PROJECTION_PENDING"}
        result = {"schema": "story-profile-projection-status/v1", "status": "pending", "revision": profile.get("revision"), "user": dict(pending), "memory": dict(pending),
                  "targets": {"USER.md": dict(pending), "MEMORY.md": dict(pending)}, "changed": [], "prompt_cache": {"checked": False, "invalidated": 0}}
    result["actor"] = actor
    if actor["status"] != "complete" and result["status"] == "complete":
        result["status"] = "partial"
    _save_projection_status(state_dir, result)
    return result


def _section_ranges(markdown: str) -> list[tuple[str, int, int]]:
    lines = markdown.splitlines()
    heads = [(i, line[2:].strip()) for i, line in enumerate(lines) if line.startswith("# ")]
    result = []
    for pos, (start, title) in enumerate(heads):
        end = heads[pos + 1][0] if pos + 1 < len(heads) else len(lines)
        result.append((title, start, end))
    return result


def _section(markdown: str, contains: str) -> tuple[str, list[str], int, int]:
    lines = markdown.splitlines()
    for title, start, end in _section_ranges(markdown):
        if contains in title:
            return title, lines[start + 1:end], start, end
    return "", [], -1, -1


def _bullets(lines: list[str]) -> list[str]:
    return [line.strip()[2:].strip() for line in lines if line.strip().startswith("- ")]


def _parse_timeline_item(text: str) -> dict:
    has_date = len(text) >= 10 and text[4:5] == "-" and text[7:8] == "-"
    date = text[:10] if has_date else ""
    rest = (text[10:] if has_date else text).strip()
    reason, change = (rest.split("→", 1) + [""])[:2] if "→" in rest else ("", rest)
    return {
        "id": _stable_id("event", date, reason.strip(), change.strip()),
        "date": date,
        "reason": reason.strip(),
        "change": change.strip(),
        "created_at": _now(),
        "source_type": "legacy_migration",
    }


def _normalize_text(text: str) -> str:
    return re.sub(r"[\s，。！？；：、,.!?;:'\"“”‘’「」『』（）()\[\]{}]+", "", text).lower()


def _category(text: str) -> str:
    lowered = text.lower()
    groups = (
        ("pacing", ("节奏", "推进", "慢一点", "快一点", "pacing")),
        ("narrative_style", ("叙事", "文风", "描写", "对白", "视角", "写法", "narrative")),
        ("relationship_dynamics", ("关系", "互动", "拉扯", "信任", "亲密", "relationship")),
        ("boundaries", ("雷区", "避免", "不要", "禁止", "边界", "boundary")),
        ("themes", ("题材", "主题", "世界", "背景", "theme", "genre")),
    )
    for name, terms in groups:
        if any(term in lowered for term in terms):
            return name
    return "story_preference"


def _scope(text: str) -> str:
    return "tavern"


def _preference(text: str, source_type: str, created_at: int | None = None) -> dict:
    clean = text.strip().lstrip("-•").strip()
    ts = int(created_at or _now())
    return {
        "id": _stable_id("pref", clean),
        "category": _category(clean),
        "text": clean,
        "status": "confirmed",
        "scope": _scope(clean),
        "confidence": 1.0 if source_type in {"legacy_migration", "explicit"} else 0.78,
        "source_type": source_type,
        "evidence": [],
        "created_at": ts,
        "updated_at": ts,
        "last_seen_at": ts,
        "locked": False,
    }


def _split_addition(addition: str) -> list[str]:
    items = []
    for line in str(addition or "").splitlines():
        clean = line.strip().lstrip("-•").strip()
        if clean and clean not in items:
            items.append(clean)
    return items


def _active_preferences(profile: dict, scopes: set[str] | None = None) -> list[dict]:
    active = []
    for item in profile.get("preferences") or []:
        if item.get("status") != "confirmed" or not item.get("text"):
            continue
        if scopes and item.get("scope") not in scopes:
            continue
        active.append(item)
    return active


def _migrate(markdown: str) -> tuple[dict, list[dict], list[dict]]:
    _, knows_lines, knows_start, knows_end = _section(markdown, "我对你的了解")
    _, growth_lines, growth_start, growth_end = _section(markdown, "成长记")
    lines = markdown.splitlines()

    identity = "\n".join(lines[:knows_start]).strip() if knows_start >= 0 else markdown.strip()
    signature = ""
    if knows_end >= 0 and growth_start >= 0:
        signature = "\n".join(lines[knows_end:growth_start]).strip()
    # Legacy summaries/private headings after the recent timeline may not have
    # recoverable event identities. Preserve them verbatim rather than inventing
    # events or dropping the text while materializing structured storage.
    archive_tail = "\n".join(lines[growth_end:]).strip() if growth_end >= 0 else ""

    preference_texts = [
        item for item in _bullets(knows_lines)
        if item and not item.startswith("（") and not item.startswith("(")
    ]
    events = [
        _parse_timeline_item(item) for item in _bullets(growth_lines)
        if item and not item.startswith("（") and not item.startswith("(")
    ]
    preferences = [_preference(text, "legacy_migration") for text in preference_texts]

    recent = events[-RECENT_TIMELINE_LIMIT:]
    archived = events[:-RECENT_TIMELINE_LIMIT]
    eras = []
    if archived:
        eras.append(_era_from_events(archived))

    profile = {
        "schema_version": SCHEMA_VERSION,
        "revision": 1,
        "created_at": _now(),
        "updated_at": _now(),
        "display": {"identity_markdown": identity, "signature_markdown": signature,
                    "legacy_archive_markdown": archive_tail},
        "preferences": preferences,
        "recent_timeline": recent,
        "taste_profile": {},
        "taste_profile_stale": bool(preferences),
        "shared_story_memory": [],
        "stats": {"event_count": len(events), "era_count": len(eras)},
    }
    return profile, events, eras


def _era_from_events(events: list[dict]) -> dict:
    first = events[0] if events else {}
    last = events[-1] if events else {}
    changes = []
    for event in events:
        change = str(event.get("change") or "").strip()
        if change and change not in changes:
            changes.append(change)
    summary = "；".join(changes)
    if len(summary) > 600:
        summary = summary[:597].rstrip("；，。 ") + "…"
    return {
        "id": _stable_id("era", first.get("id"), last.get("id")),
        "start_date": first.get("date") or "",
        "end_date": last.get("date") or "",
        "event_count": len(events),
        "summary": summary,
        "event_ids": [event.get("id") for event in events if event.get("id")],
        "created_at": _now(),
    }


def _paths(state_dir: str | Path) -> tuple[Path, Path, Path, Path]:
    root = Path(state_dir)
    return (
        root / PROFILE_FILENAME,
        root / EVENTS_FILENAME,
        root / ERAS_FILENAME,
        root / "actor_self.md",
    )


def _read_events(path: Path) -> list[dict]:
    result = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict) or not value.get("id"):
                raise ValueError("event must be an object with an identity")
            result.append(value)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as error:
        raise StoryProfileStorageError(
            f"Cannot read Story Profile history {path.name}; existing data was preserved.",
            code="STORY_PROFILE_READ_FAILED", path=path) from error
    return result


def ensure_profile(state_dir: str | Path, seed_actor: str | Path) -> dict:
    profile_path, events_path, eras_path, actor_path = _paths(state_dir)
    with _profile_lock(state_dir):
        profile = _read_json(profile_path, {})
        if isinstance(profile, dict) and profile.get("schema_version") == SCHEMA_VERSION:
            if not isinstance(profile.get("preferences"), list) or not all(isinstance(item, dict) for item in profile["preferences"]):
                raise StoryProfileStorageError(f"Invalid preferences in {profile_path.name}.", code="STORY_PROFILE_READ_FAILED", path=profile_path)
            events = _read_events(events_path)
            if not events_path.is_file() or len(events) != int((profile.get("stats") or {}).get("event_count") or 0):
                raise StoryProfileStorageError(
                    f"Story Profile history {events_path.name} is missing or inconsistent; existing files were preserved.",
                    code="STORY_PROFILE_HISTORY_UNCONFIRMED", path=events_path)
            if not isinstance(_read_json(eras_path, []), list):
                raise StoryProfileStorageError(f"Invalid Story Profile archive {eras_path.name}.", code="STORY_PROFILE_READ_FAILED", path=eras_path)
            if not eras_path.is_file() and int((profile.get("stats") or {}).get("era_count") or 0) > 0:
                raise StoryProfileStorageError(f"Story Profile archive {eras_path.name} is missing; existing files were preserved.", code="STORY_PROFILE_HISTORY_UNCONFIRMED", path=eras_path)
            return profile

        if profile_path.exists() or events_path.exists() or eras_path.exists():
            raise StoryProfileStorageError(
                f"Story Profile file {profile_path.name} is missing or has an unsupported schema; existing history was preserved.",
                code="STORY_PROFILE_SCHEMA_UNCONFIRMED", path=profile_path)

        source_path = actor_path if actor_path.exists() else Path(seed_actor)
        markdown = source_path.read_text(encoding="utf-8")
        profile, events, eras = _migrate(markdown)
        _commit_profile(state_dir, profile, events=events, era_items=eras)
        _refresh_derived(state_dir, profile, eras)
        return profile


def load_profile(state_dir: str | Path, seed_actor: str | Path) -> dict:
    return ensure_profile(state_dir, seed_actor)


def recover_profile(state_dir: str | Path, seed_actor: str | Path, *, include_status=False) -> dict:
    """Complete a prepared local commit and repair derived files without a model."""
    with _profile_lock(state_dir):
        profile = ensure_profile(state_dir, seed_actor)
        result = _refresh_derived(state_dir, profile, eras(state_dir))
        return {"profile": profile, "projections": result} if include_status else profile


def preference_texts(profile: dict) -> list[str]:
    return [item["text"] for item in _active_preferences(profile)]


def preference_revision(profile: dict) -> str:
    """Fingerprint the actual summary source, independent of plot-only updates."""
    source = [{key: item.get(key) for key in ("id", "text", "status", "scope", "locked")}
              for item in _active_preferences(profile)]
    return hashlib.sha256(json.dumps(source, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def validate_taste_profile_v2(value: dict) -> dict:
    """Reject excess content; never shorten a condition or a negative sentence."""
    if not isinstance(value, dict) or set(value) != set(TASTE_PROFILE_V2_FIELDS):
        raise StoryProfileStorageError("口味总结必须包含四类完整数组。", code="STORY_PROFILE_INVALID_SUMMARY")
    normalized = {}
    for key, limit in TASTE_PROFILE_V2_LIMITS.items():
        items = value[key]
        if not isinstance(items, list) or len(items) > limit or any(
            not isinstance(item, str) or not item.strip() or len(item) > TASTE_PROFILE_V2_VALUE_LIMIT
            or "\n" in item or "\r" in item for item in items
        ):
            raise StoryProfileStorageError(f"口味总结{key}超出条数、单条100字符或单行格式限制；未截断原文。", code="STORY_PROFILE_INVALID_SUMMARY")
        normalized[key] = [item.strip() for item in items]
    if sum(len(item) for items in normalized.values() for item in items) > TASTE_PROFILE_V2_BODY_LIMIT:
        raise StoryProfileStorageError("口味总结纯值正文超出1400字符；未截断原文。", code="STORY_PROFILE_INVALID_SUMMARY")
    return normalized


def taste_summary_state(profile: dict) -> dict:
    fingerprint = preference_revision(profile)
    empty = {key: [] for key in TASTE_PROFILE_V2_FIELDS}
    base = {"status": "needs_refresh", "source": "none", "values": empty,
            "source_revision": None, "code": "STORY_PROFILE_SUMMARY_REFRESH_REQUIRED"}
    if "taste_profile_v2" in profile:
        try:
            values = validate_taste_profile_v2(profile["taste_profile_v2"])
        except StoryProfileStorageError:
            return {**base, "source": "v2"}
        source = profile.get("taste_profile_v2_source_revision")
        if profile.get("taste_profile_stale") or source != fingerprint:
            return {**base, "status": "stale", "source": "v2", "source_revision": source,
                    "code": "STORY_PROFILE_SUMMARY_STALE"}
        return {"status": "current", "source": "v2", "values": values, "source_revision": source, "code": ""}
    legacy = profile.get("taste_profile") or {}
    if not legacy and not preference_texts(profile):
        return {"status": "current", "source": "none", "values": empty, "source_revision": fingerprint, "code": ""}
    source = profile.get("taste_profile_source_revision")
    if profile.get("taste_profile_stale") or source != fingerprint:
        return {**base, "status": "stale", "source": "legacy", "source_revision": source,
                "code": "STORY_PROFILE_SUMMARY_STALE"}
    groups = {"story_tastes": ("character_styles", "relationship_dynamics", "story_themes"),
              "narrative_habits": ("pacing", "narrative_style"),
              "co_creation": ("interaction_preferences", "response_adaptations"), "boundaries": ("boundaries",)}
    values = {}
    try:
        if not isinstance(legacy, dict) or not set(legacy).issubset(TASTE_PROFILE_FIELDS):
            raise ValueError("invalid legacy fields")
        for key, fields in groups.items():
            items = []
            for field in fields:
                original = legacy.get(field, [])
                if not isinstance(original, list) or any(not isinstance(item, str) for item in original):
                    raise ValueError("invalid legacy array")
                for item in original:
                    if item not in items:
                        items.append(item)
            values[key] = items
        values = validate_taste_profile_v2(values)
    except (ValueError, StoryProfileStorageError):
        return {**base, "source": "legacy", "source_revision": source}
    return {"status": "current", "source": "legacy_compatible", "values": values, "source_revision": source, "code": ""}


def learning_receipt(state_dir: str | Path, source_id: str):
    if not str(source_id or "").strip():
        return None
    with _profile_lock(state_dir):
        profile_path, events_path, _, _ = _paths(state_dir)
        profile = _read_json(profile_path, {})
        if not isinstance(profile, dict):
            raise StoryProfileStorageError(f"Invalid Story Profile file {profile_path.name}.", code="STORY_PROFILE_READ_FAILED", path=profile_path)
        receipt = (profile.get("learning_receipts") or {}).get(str(source_id))
        if isinstance(receipt, dict) and receipt.get("event_id"):
            events = _read_events(events_path)
            if not any(event.get("id") == receipt["event_id"] for event in events):
                raise StoryProfileStorageError(
                    f"Saved learning receipt cannot be confirmed in {events_path.name}; preserve the existing files.",
                    code="STORY_PROFILE_HISTORY_UNCONFIRMED", path=events_path)
        return dict(receipt) if isinstance(receipt, dict) else None


def timeline(profile: dict) -> list[dict]:
    return [dict(item) for item in profile.get("recent_timeline") or []]


def eras(state_dir: str | Path) -> list[dict]:
    _, _, eras_path, _ = _paths(state_dir)
    value = _read_json(eras_path, [])
    return value if isinstance(value, list) else []


def render_markdown(profile: dict, era_items: list[dict] | None = None) -> str:
    display = profile.get("display") or {}
    parts = [str(display.get("identity_markdown") or "").rstrip()]
    parts += ["", "# 我对你的了解（个性化 · 会随相处更新）", ""]
    prefs = preference_texts(profile)
    parts.extend("- " + text for text in prefs)
    if not prefs:
        parts.append("- （还不了解你。等我们演几场，我会把你的口味记到这里。）")

    signature = str(display.get("signature_markdown") or "").strip()
    if signature:
        parts += ["", signature]

    parts += ["", "# 成长记（最近的共同经历）", ""]
    for item in profile.get("recent_timeline") or []:
        date = str(item.get("date") or "").strip()
        reason = str(item.get("reason") or "").strip()
        change = str(item.get("change") or "").strip()
        prefix = " ".join(value for value in (date, reason) if value)
        parts.append("- " + ((prefix + " → ") if prefix else "") + change)
    if not profile.get("recent_timeline"):
        parts.append("- （还没有共同经历。）")

    era_items = era_items or []
    if era_items:
        parts += ["", "# 共同经历（阶段摘要）", ""]
        for era in reversed(era_items):
            dates = " 至 ".join(value for value in (era.get("start_date"), era.get("end_date")) if value)
            meta = f"{dates} · {era.get('event_count', 0)} 笔" if dates else f"{era.get('event_count', 0)} 笔"
            parts.append(f"- {meta} → {era.get('summary', '')}")
    legacy_archive = str(display.get("legacy_archive_markdown") or "").strip()
    if legacy_archive:
        parts += ["", legacy_archive]
    return "\n".join(parts).rstrip() + "\n"


def _merge_preference(profile: dict, text: str, source_type: str, ts: int) -> tuple[dict, bool]:
    incoming = _preference(text, source_type, ts)
    incoming_norm = _normalize_text(text)
    active = _active_preferences(profile)
    possible_conflicts = []
    for current in active:
        current_norm = _normalize_text(current.get("text") or "")
        if current_norm == incoming_norm:
            current["last_seen_at"] = ts
            current["confidence"] = max(float(current.get("confidence") or 0), incoming["confidence"])
            return current, False
        ratio = difflib.SequenceMatcher(None, current_norm, incoming_norm).ratio()
        contained = bool(current_norm and incoming_norm and (current_norm in incoming_norm or incoming_norm in current_norm))
        if ratio >= 0.86 or contained:
            possible_conflicts.append(current["id"])

    # String similarity cannot establish semantic equivalence, a refinement, or
    # an intentional correction. Keep uncertain evidence without changing the
    # active preference (including an explicitly locked one).
    if possible_conflicts:
        existing = next((item for item in profile.get("preferences") or [] if item.get("id") == incoming["id"]), None)
        if existing:
            return existing, False
        incoming["status"] = "candidate"
        incoming["conflicts_with"] = possible_conflicts
        profile.setdefault("preferences", []).append(incoming)
        return incoming, False

    profile.setdefault("preferences", []).append(incoming)
    active = _active_preferences(profile)
    if len(active) > 12:
        removable = sorted(
            (item for item in active if not item.get("locked")),
            key=lambda item: int(item.get("last_seen_at") or item.get("created_at") or 0),
        )
        for item in removable[:len(active) - 12]:
            item["status"] = "superseded"
            item["updated_at"] = ts
    return incoming, True


def record_learning(
    state_dir: str | Path,
    seed_actor: str | Path,
    addition: str,
    reason: str,
    ts: int | None = None,
    source_type: str = "reflection",
    *,
    source_id: str | None = None,
    evidence: list | dict | None = None,
) -> tuple[list[str], dict | None]:
    profile_path, events_path, eras_path, actor_path = _paths(state_dir)
    stamp = int(ts or _now())
    with _profile_lock(state_dir):
        profile = ensure_profile(state_dir, seed_actor)
        events = _read_events(events_path)
        source_key = str(source_id or "").strip()
        existing_receipt = (profile.get("learning_receipts") or {}).get(source_key) if source_key else None
        if isinstance(existing_receipt, dict):
            event = next((item for item in events if item.get("id") == existing_receipt.get("event_id")), None)
            _refresh_derived(state_dir, profile, eras(state_dir), receipt=existing_receipt)
            return preference_texts(profile), event
        before_revision = preference_revision(profile)
        accepted = []
        candidate_ids = []
        preference_ids = []
        for text in _split_addition(addition):
            preference, is_new = _merge_preference(profile, text, source_type, stamp)
            preference_ids.append(preference["id"])
            if preference.get("status") == "candidate":
                candidate_ids.append(preference["id"])
            source_evidence = evidence.get(text, []) if isinstance(evidence, dict) else evidence
            if source_evidence:
                existing_evidence = preference.setdefault("evidence", [])
                for entry in source_evidence:
                    if isinstance(entry, dict) and entry not in existing_evidence:
                        existing_evidence.append(dict(entry))
            if is_new:
                accepted.append(text)

        event = None
        if accepted:
            event = {
                "id": _stable_id("event", stamp, reason, "\n".join(accepted)),
                "date": time.strftime("%Y-%m-%d", time.localtime(stamp)),
                "reason": " ".join(str(reason or "").split()),
                "change": "；".join(accepted),
                "created_at": stamp,
                "source_type": source_type,
                "source_id": source_key or None,
            }
            events.append(event)
            profile["stats"] = dict(profile.get("stats") or {})
            profile["stats"]["event_count"] = len(events)
            profile["recent_timeline"] = events[-RECENT_TIMELINE_LIMIT:]

            archived = events[:-RECENT_TIMELINE_LIMIT]
            era_items = []
            for start in range(0, len(archived), ERA_EVENT_LIMIT):
                chunk = archived[start:start + ERA_EVENT_LIMIT]
                if chunk:
                    era_items.append(_era_from_events(chunk))
            profile["stats"]["era_count"] = len(era_items)
        else:
            era_items = eras(state_dir)

        profile["revision"] = int(profile.get("revision") or 0) + 1
        profile["updated_at"] = stamp
        profile.setdefault("taste_profile", {})
        if preference_revision(profile) != before_revision:
            profile["taste_profile_stale"] = True
        profile.setdefault("shared_story_memory", [])
        profile.pop("relationship", None)
        receipt = {
            "source_id": source_key,
            "event_id": event["id"] if event else None,
            "preference_ids": list(dict.fromkeys(preference_ids)),
            "candidate_ids": list(dict.fromkeys(candidate_ids)),
            "review_required": bool(candidate_ids),
            "committed_at": stamp,
        }
        if source_key:
            profile.setdefault("learning_receipts", {})[source_key] = receipt
        _commit_profile(state_dir, profile, events=events if accepted else None, era_items=era_items if accepted else None)
        _refresh_derived(state_dir, profile, era_items, receipt=receipt)
        return preference_texts(profile), event


def _replace_block(text: str, start: str, end: str, body: str) -> str:
    block = f"{start}\n{body.strip()}\n{end}"
    pattern = re.compile(re.escape(start) + r"[\s\S]*?" + re.escape(end))
    if pattern.search(text):
        return pattern.sub(lambda _: block, text, count=1)
    return block + ("\n\n" + text if text else "\n")


def _projection_marker(profile: dict) -> str:
    revision = max(0, int(profile.get("revision") or 0))
    return f"{PROJECTION_REVISION_PREFIX}{revision} -->"


def _memories_root(memories_dir: str | Path | None = None) -> Path:
    return Path(memories_dir or os.environ.get(
        "TAVERN_HERMES_MEMORIES_DIR", HERMES_HOME / "memories"))


def _memory_limit(root: Path, key: str, fallback: int) -> int:
    config_path = root.parent / "config.yaml"
    limit = fallback
    if config_path.exists():
        invalid = False
        try:
            import yaml
            config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
            config = {} if config is None else config
            if not isinstance(config, dict) or not isinstance(config.get("memory", {}), dict):
                raise ValueError("invalid memory config")
            limit = config.get("memory", {}).get(key, limit)
            if type(limit) is not int or limit <= 0:
                raise ValueError("invalid memory limit")
        except Exception:
            invalid = True
        if invalid:
            # Raise outside the parser's exception context, which may contain secrets.
            raise StoryProfileStorageError(
                "Hermes记忆容量配置无法读取；原记忆未修改。",
                code="STORY_PROFILE_USER_BUDGET_UNREADABLE" if key == "user_char_limit" else "STORY_PROFILE_MEMORY_BUDGET_UNREADABLE", path=config_path)
    return limit


def _user_projection_budget(root: Path, current: str) -> int:
    return _memory_limit(root, "user_char_limit", HERMES_DEFAULT_USER_CHAR_LIMIT) - USER_MEMORY_RESERVE_CHARS - len(_replace_block(current, USER_START, USER_END, ""))


def _user_projection(profile: dict, max_chars: int | None = None) -> str:
    if max_chars is None:
        root = _memories_root()
        target = root / "USER.md"
        current = target.read_text(encoding="utf-8") if target.exists() else ""
        max_chars = _user_projection_budget(root, current)
    summary = taste_summary_state(profile)
    if summary["status"] != "current":
        raise StoryProfileStorageError("已有偏好保留；口味总结需要按当前四类限制刷新后再同步USER.md。", code=summary["code"])
    labels = (("story_tastes", "故事口味"), ("narrative_habits", "叙事习惯"),
              ("co_creation", "共创方式"), ("boundaries", "明确边界"))
    taste = summary["values"]
    lines = [_projection_marker(profile), "## 故事画像"]
    for key, label in labels:
        values = taste[key]
        if values:
            lines.append(f"### {label}")
            lines.extend("- " + item for item in values)
    if len(lines) == 2:
        lines.append("- 档案室尚未形成稳定的故事口味总结。")

    body = "\n".join(lines)
    if len(body) > max_chars:
        raise StoryProfileStorageError(
            "USER.md剩余容量不足以完整保存当前故事画像；原记忆已保留，未截断否定或条件。",
            code="STORY_PROFILE_USER_BUDGET_EXHAUSTED")
    return body


def _memory_projection(profile: dict, max_chars: int | None = None) -> str:
    """Compatibility entry: plot is read on demand, never a resident prompt."""
    return ""


def _atomic_bytes(path: Path, content: bytes) -> None:
    """Preserve original newline/encoding bytes when retiring an owned block."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".tmp.{os.getpid()}.{threading.get_ident()}")
    created = False
    try:
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        _replace_atomic_file(temporary, path)
    finally:
        if created:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def _retire_story_memory(path: Path, profile: dict) -> dict:
    """Back up the complete original before removing exactly one owned block."""
    base = {"status": "complete", "code": "", "changed": False, "mode": "on_demand",
            "revision": int(profile.get("revision") or 0), "managed_block_chars": 0}
    if not path.exists():
        return {**base, "action": "no_story_block", "file_present": False}
    original = path.read_bytes()
    start, end = MEMORY_START.encode("ascii"), MEMORY_END.encode("ascii")
    starts, ends = original.count(start), original.count(end)
    if not starts and not ends:
        return {**base, "action": "no_story_block", "file_present": True}
    if (starts != 1 or ends != 1 or original.index(end) < original.index(start)
            or not re.search(rb"(?m)^" + re.escape(start) + rb"\r?$", original)
            or not re.search(rb"(?m)^" + re.escape(end) + rb"\r?$", original)):
        raise StoryProfileStorageError("旧故事记忆边界无法核验，原文件已保留；USER偏好仍独立同步。",
                                       code="STORY_PROFILE_MEMORY_MARKERS_UNCONFIRMED")
    begin, finish = original.index(start), original.index(end) + len(end)
    block = original[begin:finish]
    revision_prefix = PROJECTION_REVISION_PREFIX.encode("ascii")
    revision = re.search(rb"(?m)^" + re.escape(revision_prefix) + rb"([0-9]+) -->\r?$", block)
    if block.count(revision_prefix) != 1 or revision is None:
        raise StoryProfileStorageError("旧故事记忆来源修订无法唯一核验，原文件已保留；USER偏好仍独立同步。",
                                       code="STORY_PROFILE_MEMORY_REVISION_UNCONFIRMED")
    if int(revision.group(1)) > base["revision"]:
        raise StoryProfileStorageError("旧快照不能修改更新修订的记忆块；原文件已保留。", code="STORY_PROFILE_PROJECTION_STALE")
    digest = hashlib.sha256(original).hexdigest()
    backup_root = path.parent / ".tavern-shared-memory-backups"
    backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = backup_root / ("MEMORY." + digest + ".md")
    if backup.exists():
        if backup.read_bytes() != original:
            raise StoryProfileStorageError("旧故事记忆备份无法核验，原文件未修改。", code="STORY_PROFILE_MEMORY_BACKUP_UNCONFIRMED")
    else:
        _atomic_bytes(backup, original)
    if backup.read_bytes() != original:
        raise StoryProfileStorageError("旧故事记忆备份校验失败，原文件未修改。", code="STORY_PROFILE_MEMORY_BACKUP_UNCONFIRMED")
    # Respect another writer rather than replacing its just-written memories.
    if path.read_bytes() != original:
        raise StoryProfileStorageError("记忆文件已由其他写者变更，未用旧快照覆盖。", code="STORY_PROFILE_MEMORY_CHANGED")
    _atomic_bytes(path, original[:begin] + original[finish:])
    return {**base, "changed": True, "action": "removed_legacy_story_block", "file_present": True, "backup": str(backup)}


def _invalidate_hermes_prompt_cache(
    profile: dict,
    state_db: str | Path | None = None,
) -> dict:
    """Expire active ClawChat prompts that predate this projection revision."""
    path = Path(state_db or os.environ.get(
        "TAVERN_HERMES_STATE_DB", HERMES_HOME / "state.db"))
    if not path.exists():
        return {"status": "not-needed", "code": "", "retryable": False,
                "checked": False, "invalidated": 0}

    marker = _projection_marker(profile)
    pending = {"status": "pending", "code": "STORY_PROFILE_PROMPT_CACHE_PENDING",
               "retryable": True, "checked": False, "invalidated": 0}
    try:
        with closing(sqlite3.connect(path, timeout=2.0)) as connection, connection:
            session_columns = {
                str(row[1]) for row in connection.execute("PRAGMA table_info(sessions)")
            }
            required = {"id", "source", "system_prompt", "ended_at"}
            if not required.issubset(session_columns):
                return {**pending, "reason": "unsupported sessions schema"}

            result = connection.execute(
                """
                UPDATE sessions
                   SET system_prompt = NULL
                 WHERE source = 'clawchat'
                   AND ended_at IS NULL
                   AND system_prompt IS NOT NULL
                   AND (instr(system_prompt, ?) = 0 OR instr(system_prompt, ?) > 0 OR instr(system_prompt, ?) > 0)
                """,
                (marker, MEMORY_START, MEMORY_END),
            )
            meta_table = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'state_meta'"
            ).fetchone()
            if meta_table:
                connection.execute(
                    """
                    INSERT INTO state_meta(key, value)
                    VALUES('tavern_projection_revision', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    """,
                    (str(max(0, int(profile.get("revision") or 0))),),
                )
            return {"status": "complete", "code": "", "retryable": False,
                    "checked": True, "invalidated": max(0, int(result.rowcount or 0))}
    except sqlite3.Error as error:
        return {
            **pending,
            "reason": f"{type(error).__name__}: {error}",
        }


def sync_hermes_memories(
    profile: dict,
    memories_dir: str | Path | None = None,
    *,
    state_db: str | Path | None = None,
    state_dir: str | Path | None = None,
) -> dict:
    if state_dir is not None:
        with _profile_lock(state_dir):
            current = _read_json(Path(state_dir) / PROFILE_FILENAME, None)
            if not isinstance(current, dict) or current.get("schema_version") != SCHEMA_VERSION:
                raise StoryProfileStorageError("当前档案修订无法核验，未覆盖记忆。", code="STORY_PROFILE_SCHEMA_UNCONFIRMED")
            result = _sync_hermes_targets(current, memories_dir, state_db=state_db)
            _save_projection_status(state_dir, result)
            return result
    return _sync_hermes_targets(profile, memories_dir, state_db=state_db)


def _sync_hermes_targets(profile, memories_dir=None, *, state_db=None):
    root = _memories_root(memories_dir)
    changed, targets = [], {}
    for name, start, end, fallback, config_key, reserve in (
        ("USER.md", USER_START, USER_END, HERMES_DEFAULT_USER_CHAR_LIMIT, "user_char_limit", USER_MEMORY_RESERVE_CHARS),
        ("MEMORY.md", MEMORY_START, MEMORY_END, HERMES_DEFAULT_MEMORY_CHAR_LIMIT, "memory_char_limit", 0),
    ):
        path = root / name
        try:
            with _file_lock(path):
                if name == "MEMORY.md":
                    targets[name] = _retire_story_memory(path, profile)
                    if targets[name]["changed"]:
                        changed.append(str(path))
                    continue
                old = path.read_text(encoding="utf-8") if path.exists() else ""
                if old.count(start) != old.count(end) or old.count(start) > 1 or (start in old and old.index(end) < old.index(start)):
                    raise StoryProfileStorageError("记忆托管标记无法核验，原文件已保留。", code="STORY_PROFILE_MEMORY_MARKERS_UNCONFIRMED")
                existing = old[old.index(start):old.index(end)] if start in old else ""
                found = re.search(re.escape(PROJECTION_REVISION_PREFIX) + r"(\d+)", existing)
                if found and int(found.group(1)) > int(profile.get("revision") or 0):
                    raise StoryProfileStorageError("记忆已包含更新修订，未用旧档案覆盖。", code="STORY_PROFILE_PROJECTION_STALE")
                limit = _memory_limit(root, config_key, fallback)
                overhead = len(_replace_block(old, start, end, ""))
                available = limit - reserve - overhead
                body = _user_projection(profile, available)
                new = _replace_block(old, start, end, body)
                if len(new) > limit - reserve:
                    raise StoryProfileStorageError("记忆整份文件容量不足，原记忆已保留。", code="STORY_PROFILE_USER_BUDGET_EXHAUSTED" if name == "USER.md" else "STORY_PROFILE_MEMORY_BUDGET_EXHAUSTED")
                if new != old:
                    _atomic_text(path, new)
                    changed.append(str(path))
                targets[name] = {"status": "complete", "code": "", "changed": new != old,
                                 "file_chars": len(new), "file_limit": limit, "reserved_chars": reserve,
                                 "managed_block_chars": len(start + "\n" + body.strip() + "\n" + end) + 1,
                                 "revision": int(profile.get("revision") or 0)}
        except Exception as error:
            targets[name] = {"status": "pending", "code": getattr(error, "code", "STORY_PROFILE_MEMORY_IO_PENDING"),
                             "error": str(error) if isinstance(error, StoryProfileStorageError) else "记忆文件读取或写入失败；原内容已保留，另一项同步仍会尝试。",
                             "changed": False, "revision": int(profile.get("revision") or 0)}
    prompt_cache = (
        _invalidate_hermes_prompt_cache(profile, state_db)
        if state_db is not None or memories_dir is None
        else {"status": "not-needed", "code": "", "retryable": False,
              "checked": False, "invalidated": 0, "reason": "explicit_memory_directory_without_state_db"}
    )
    complete = sum(target["status"] == "complete" for target in targets.values())
    return {
        "schema": "story-profile-projection-status/v1",
        "status": "complete" if complete == 2 and prompt_cache["status"] != "pending" else "partial" if complete else "pending",
        "revision": int(profile.get("revision") or 0),
        "user": targets["USER.md"], "memory": targets["MEMORY.md"], "targets": targets,
        "changed": changed,
        "prompt_cache": prompt_cache,
        "checked_at": _now(),
    }


def _save_projection_status(state_dir, result):
    try:
        _atomic_json(Path(state_dir) / PROJECTION_STATUS_FILENAME, result)
    except OSError:
        result["status"] = "partial" if any(target.get("status") == "complete" for target in result.get("targets", {}).values()) else "pending"
        result["report_code"] = "STORY_PROFILE_PROJECTION_STATUS_UNWRITABLE"


def projection_status(state_dir, profile=None):
    current = profile or _read_json(Path(state_dir) / PROFILE_FILENAME, {})
    value = _read_json(Path(state_dir) / PROJECTION_STATUS_FILENAME, {})
    if isinstance(value, dict) and value.get("schema") == "story-profile-projection-status/v1" and value.get("revision") == current.get("revision"):
        return value
    pending = {"status": "pending", "code": "STORY_PROFILE_PROJECTION_STALE", "changed": False}
    return {"schema": "story-profile-projection-status/v1", "status": "pending", "revision": current.get("revision"),
            "user": dict(pending), "memory": dict(pending), "targets": {"USER.md": dict(pending), "MEMORY.md": dict(pending)}, "changed": [],
            "prompt_cache": {"checked": False, "invalidated": 0}}


def memory_preview(profile: dict) -> dict:
    result = {"memory": "", "memory_mode": "on_demand"}
    try:
        result["user"] = _user_projection(profile)
    except StoryProfileStorageError:
        result["user"] = ""
    result["summary"] = taste_summary_state(profile)
    return result


def sync_profile_memories(state_dir: str | Path, seed_actor: str | Path) -> dict:
    """Manual refresh uses the latest profile under the same commit lock."""
    with _profile_lock(state_dir):
        profile = ensure_profile(state_dir, seed_actor)
        return _refresh_derived(state_dir, profile, eras(state_dir))


def update_preference(
    state_dir: str | Path,
    seed_actor: str | Path,
    preference_id: str,
    *,
    status: str | None = None,
    text: str | None = None,
    scope: str | None = None,
    locked: bool | None = None,
) -> dict:
    allowed_status = {"candidate", "confirmed", "rejected", "superseded"}
    allowed_scope = {"tavern", "ruotang_chat", "both"}
    profile_path, events_path, eras_path, actor_path = _paths(state_dir)
    with _profile_lock(state_dir):
        profile = ensure_profile(state_dir, seed_actor)
        before_revision = preference_revision(profile)
        target = next(
            (item for item in profile.get("preferences") or [] if item.get("id") == preference_id),
            None,
        )
        if target is None:
            raise KeyError(f"preference not found: {preference_id}")
        previous = {key: target.get(key) for key in ("text", "status", "scope", "locked")}
        if status is not None:
            if status not in allowed_status:
                raise ValueError(f"invalid status: {status}")
            target["status"] = status
        if text is not None:
            clean = str(text).strip()
            if not clean:
                raise ValueError("preference text cannot be empty")
            target["text"] = clean
            target["category"] = _category(clean)
            if scope is None:
                target["scope"] = _scope(clean)
        if scope is not None:
            if scope not in allowed_scope:
                raise ValueError(f"invalid scope: {scope}")
            target["scope"] = scope
        if locked is not None:
            target["locked"] = bool(locked)
        target["updated_at"] = _now()
        if any(target.get(key) != value for key, value in previous.items()):
            target.setdefault("revisions", []).append({**previous, "replaced_at": target["updated_at"], "source_type": "explicit_update"})

        if preference_revision(profile) != before_revision:
            profile["taste_profile_stale"] = True
        profile.pop("relationship", None)
        profile["revision"] = int(profile.get("revision") or 0) + 1
        profile["updated_at"] = _now()
        era_items = _read_json(eras_path, [])
        _commit_profile(state_dir, profile)
        _refresh_derived(state_dir, profile, era_items)
        return target


def set_taste_profile(
    state_dir: str | Path,
    seed_actor: str | Path,
    value: dict,
    *,
    expected_revision: str | int | None = None,
) -> dict:
    """Store a validated model-generated story-taste summary."""
    if not isinstance(value, dict):
        raise ValueError("taste profile must be an object")
    modern = bool(set(value) & (set(TASTE_PROFILE_V2_FIELDS) - {"boundaries"})) or set(value) == set(TASTE_PROFILE_V2_FIELDS)
    if modern:
        normalized = validate_taste_profile_v2(value)
    else:
        if not set(value).issubset(TASTE_PROFILE_FIELDS) or any(
                not isinstance(items, list) or any(not isinstance(item, str) for item in items) for items in value.values()):
            raise StoryProfileStorageError("旧口味总结格式无法核验；原档案已保留。", code="STORY_PROFILE_INVALID_SUMMARY")
        # Compatibility writes retain original values rather than applying the
        # retired 240-character and four-item truncation rules.
        normalized = {key: list(value.get(key, [])) for key in TASTE_PROFILE_FIELDS}

    profile_path, _, eras_path, actor_path = _paths(state_dir)
    with _profile_lock(state_dir):
        profile = ensure_profile(state_dir, seed_actor)
        if expected_revision is not None:
            actual = int(profile.get("revision") or 0) if isinstance(expected_revision, int) else preference_revision(profile)
            if actual != expected_revision:
                raise StoryProfileStorageError(
                    "Story preferences changed while the summary was generated; refresh the summary for the current preferences.",
                    code="STORY_PROFILE_SUMMARY_STALE", path=profile_path)
        if modern:
            profile["taste_profile_v2"] = normalized
            profile["taste_profile_v2_source_revision"] = preference_revision(profile)
        else:
            profile["taste_profile"] = normalized
            profile["taste_profile_source_revision"] = preference_revision(profile)
        profile["taste_profile_stale"] = False
        profile.setdefault("shared_story_memory", [])
        profile.pop("relationship", None)
        profile["revision"] = int(profile.get("revision") or 0) + 1
        profile["updated_at"] = _now()
        era_items = _read_json(eras_path, [])
        _commit_profile(state_dir, profile)
        _refresh_derived(state_dir, profile, era_items)
    return normalized


def sync_story_states(
    state_dir: str | Path,
    seed_actor: str | Path,
    productions: list[dict],
    *, include_status=False,
) -> list[dict] | dict:
    """Keep each validated session ledger; bound only its Nora projection."""
    def count(value):
        return value if type(value) is int and value >= 0 else None

    def timestamp(value):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return max(0, int(value))
        try:
            return max(0, int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000))
        except (TypeError, ValueError, OverflowError):
            return 0

    worlds = []
    for production in productions or []:
        if not isinstance(production, dict):
            continue
        state = production.get("story_state")
        state = state if isinstance(state, dict) else {}
        turns = count(state.get("covered_turns", state.get("turns")))
        status = state.get("status") or ("active" if turns is not None and turns > 0 else "missing")
        if status not in {"prepared", "active", "missing", "stale", "error", "unavailable", "disabled"}:
            status = "unavailable"
        valid = status in {"prepared", "active"}
        events = [
            " ".join(item.split()) for item in state.get("timeline") or [] if isinstance(item, str) and item.strip()
        ] if valid else []
        threads = [
            " ".join(item.split()) for item in state.get("open_threads") or [] if isinstance(item, str) and item.strip()
        ] if valid else []
        worlds.append({
            "production_id": str(production.get("id") or ""),
            "world_id": str(production.get("world_id") or production.get("id") or ""),
            "session_id": str(production.get("session_id") or ""),
            "session_name": str(production.get("session_name") or ""),
            "world": str(production.get("name") or "未命名世界").strip(),
            "covered_turns": turns,
            "total_turns": count(state.get("total_turns", production.get("total_turns"))),
            "message_count": count(state.get("message_count")),
            "covered_message_count": count(state.get("covered_message_count")),
            "status": status,
            "source_status": status,
            "enabled": state.get("enabled") if isinstance(state.get("enabled"), bool) else None,
            "code": str(state.get("code") or ""),
            "events": events[-12:],
            "open_threads": threads[:6],
            "updated_at": timestamp(state.get("updated_at") or production.get("updated_at")),
        })
    worlds.sort(key=lambda item: (item["updated_at"], item["covered_turns"] or 0), reverse=True)

    profile_path, _, eras_path, actor_path = _paths(state_dir)
    with _profile_lock(state_dir):
        profile = ensure_profile(state_dir, seed_actor)
        if profile.get("shared_story_memory") != worlds:
            profile["shared_story_memory"] = worlds
            profile.pop("relationship", None)
            profile["revision"] = int(profile.get("revision") or 0) + 1
            profile["updated_at"] = _now()
            _commit_profile(state_dir, profile)
        # Even an unchanged profile may have a previous partially failed file
        # projection. Retry the marked writes without creating a new revision.
        result = _refresh_derived(state_dir, profile, eras(state_dir))
    return {"worlds": worlds, "projections": result} if include_status else worlds


def context_for_message(profile: dict, user_message: str = "") -> str:
    preview = memory_preview(profile)
    body = preview["user"]
    instruction = (
        "以下内容来自酒馆中已经完成的模型偏好复盘。"
        "需要时自然利用，不要逐条复述，不要把故事口味推断成现实人格与现实经历。"
    )
    return "<tavern_story_memory>\n" + instruction + "\n" + body + "\n</tavern_story_memory>"


def audit(state_dir: str | Path, seed_actor: str | Path) -> dict:
    profile = ensure_profile(state_dir, seed_actor)
    summary = taste_summary_state(profile)
    return {
        "schema_version": profile.get("schema_version"),
        "revision": profile.get("revision"),
        "active_preferences": len(_active_preferences(profile)),
        "event_count": int(profile.get("stats", {}).get("event_count") or 0),
        "recent_timeline": len(profile.get("recent_timeline") or []),
        "era_count": len(eras(state_dir)),
        "taste_profile_fields": sum(
            1 for values in summary["values"].values() if values
        ),
        "taste_profile_stale": summary["status"] != "current",
        "taste_summary": {key: value for key, value in summary.items() if key != "values"},
        "projections": projection_status(state_dir, profile),
        "shared_story_worlds": len(profile.get("shared_story_memory") or []),
    }
