"""Structured story profile, timeline archive, and Hermes memory projections."""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import threading
import time
from contextlib import contextmanager
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX development environments
    fcntl = None


SCHEMA_VERSION = 1
RECENT_TIMELINE_LIMIT = 8
ERA_EVENT_LIMIT = 20
PROFILE_FILENAME = "story_profile.json"
EVENTS_FILENAME = "profile_events.jsonl"
ERAS_FILENAME = "profile_eras.json"

USER_START = "<!-- TAVERN_USER_PROFILE_START -->"
USER_END = "<!-- TAVERN_USER_PROFILE_END -->"
MEMORY_START = "<!-- TAVERN_SHARED_MEMORY_START -->"
MEMORY_END = "<!-- TAVERN_SHARED_MEMORY_END -->"

_LOCK = threading.RLock()

_SENSITIVE_STORY_TERMS = (
    "nsfw", "性爱", "性行为", "性描写", "性作为", "献身", "体液", "裸体", "娼",
    "强制", "暴力", "禁忌", "色情", "淫秽",
    "explicit", "sexual", "violence", "fetish",
)
TASTE_PROFILE_FIELDS = (
    "character_styles", "relationship_dynamics", "story_themes", "pacing",
    "narrative_style", "interaction_preferences", "boundaries",
)


def _now() -> int:
    return int(time.time())


def _stable_id(prefix: str, *parts: object) -> str:
    raw = "\x1f".join(str(part or "") for part in parts)
    return f"{prefix}_{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:14]}"


def _atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp.{os.getpid()}.{threading.get_ident()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _atomic_json(path: Path, value: object) -> None:
    _atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


@contextmanager
def _file_lock(path: Path):
    lock_path = path.with_name(path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as handle:
        if fcntl is not None:
            fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(handle, fcntl.LOCK_UN)


def _read_json(path: Path, default):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value
    except (OSError, ValueError, TypeError):
        return default


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
    _, growth_lines, growth_start, _ = _section(markdown, "成长记")
    lines = markdown.splitlines()

    identity = "\n".join(lines[:knows_start]).strip() if knows_start >= 0 else markdown.strip()
    signature = ""
    if knows_end >= 0 and growth_start >= 0:
        signature = "\n".join(lines[knows_end:growth_start]).strip()

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
        "display": {"identity_markdown": identity, "signature_markdown": signature},
        "preferences": preferences,
        "recent_timeline": recent,
        "taste_profile": {},
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
            if isinstance(value, dict):
                result.append(value)
    except (OSError, ValueError):
        return []
    return result


def _write_events(path: Path, events: list[dict]) -> None:
    body = "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events)
    _atomic_text(path, body)


def ensure_profile(state_dir: str | Path, seed_actor: str | Path) -> dict:
    profile_path, events_path, eras_path, actor_path = _paths(state_dir)
    with _LOCK:
        profile = _read_json(profile_path, {})
        if isinstance(profile, dict) and profile.get("schema_version") == SCHEMA_VERSION:
            return profile

        source_path = actor_path if actor_path.exists() else Path(seed_actor)
        markdown = source_path.read_text(encoding="utf-8")
        profile, events, eras = _migrate(markdown)
        _write_events(events_path, events)
        _atomic_json(eras_path, eras)
        _atomic_json(profile_path, profile)
        _atomic_text(actor_path, render_markdown(profile, eras))
        sync_hermes_memories(profile)
        return profile


def load_profile(state_dir: str | Path, seed_actor: str | Path) -> dict:
    return ensure_profile(state_dir, seed_actor)


def preference_texts(profile: dict) -> list[str]:
    return [item["text"] for item in _active_preferences(profile)]


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
    return "\n".join(parts).rstrip() + "\n"


def _merge_preference(profile: dict, text: str, source_type: str, ts: int) -> tuple[dict, bool]:
    incoming = _preference(text, source_type, ts)
    incoming_norm = _normalize_text(text)
    active = _active_preferences(profile)
    for current in active:
        current_norm = _normalize_text(current.get("text") or "")
        ratio = difflib.SequenceMatcher(None, current_norm, incoming_norm).ratio()
        contained = bool(current_norm and incoming_norm and (current_norm in incoming_norm or incoming_norm in current_norm))
        if ratio >= 0.86 or contained:
            if len(incoming_norm) > len(current_norm):
                current["text"] = incoming["text"]
                current["category"] = incoming["category"]
                current["scope"] = incoming["scope"]
                current["updated_at"] = ts
            current["last_seen_at"] = ts
            current["confidence"] = max(float(current.get("confidence") or 0), incoming["confidence"])
            return current, False

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
) -> tuple[list[str], dict | None]:
    profile_path, events_path, eras_path, actor_path = _paths(state_dir)
    stamp = int(ts or _now())
    with _LOCK:
        profile = ensure_profile(state_dir, seed_actor)
        events = _read_events(events_path)
        accepted = []
        for text in _split_addition(addition):
            _, is_new = _merge_preference(profile, text, source_type, stamp)
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
            _atomic_json(eras_path, era_items)
            _write_events(events_path, events)
        else:
            era_items = eras(state_dir)

        profile["revision"] = int(profile.get("revision") or 0) + 1
        profile["updated_at"] = stamp
        profile.setdefault("taste_profile", {})
        if accepted:
            profile["taste_profile_stale"] = True
        profile.setdefault("shared_story_memory", [])
        profile.pop("relationship", None)
        _atomic_json(profile_path, profile)
        _atomic_text(actor_path, render_markdown(profile, era_items))
        sync_hermes_memories(profile)
        return preference_texts(profile), event


def _replace_block(text: str, start: str, end: str, body: str) -> str:
    block = f"{start}\n{body.strip()}\n{end}"
    pattern = re.compile(re.escape(start) + r"[\s\S]*?" + re.escape(end))
    if pattern.search(text):
        result = pattern.sub(block, text, count=1)
    else:
        result = block + (("\n\n" + text.lstrip()) if text.strip() else "")
    return result.rstrip() + "\n"


def _user_projection(profile: dict) -> str:
    labels = (
        ("character_styles", "偏爱的角色风格"),
        ("relationship_dynamics", "偏爱的人物关系"),
        ("story_themes", "偏爱的世界与题材"),
        ("pacing", "剧情节奏"),
        ("narrative_style", "叙事方式"),
        ("interaction_preferences", "互动方式"),
        ("boundaries", "明确边界"),
    )
    taste = profile.get("taste_profile") or {}
    lines = ["## 用户的故事口味"]
    for key, label in labels:
        values = [str(item).strip() for item in taste.get(key, []) if str(item).strip()]
        if values:
            lines.append(f"- {label}：" + "；".join(values[:4]))
    if len(lines) == 1:
        lines.append("- 档案室尚未形成稳定的故事口味总结。")
    return "\n".join(lines)[:1400]


def _memory_projection(profile: dict) -> str:
    lines = ["## 与用户的故事记忆"]
    for world in profile.get("shared_story_memory") or []:
        name = str(world.get("world") or "未命名世界").strip()
        turns = int(world.get("covered_turns") or 0)
        lines += ["", f"### {name}" + (f"（账本整理至第 {turns} 轮）" if turns else "")]
        for event in (world.get("events") or [])[-8:]:
            clean = str(event).strip()
            if clean:
                lines.append("- " + clean)
        threads = [str(item).strip() for item in world.get("open_threads", []) if str(item).strip()]
        if threads:
            lines.append("- 尚未结束：" + "；".join(threads[:3]))
    if len(lines) == 1:
        lines.append("- 还没有完成账本整理的共同故事。")
    return "\n".join(lines)[:1900]


def sync_hermes_memories(profile: dict, memories_dir: str | Path | None = None) -> dict:
    root = Path(memories_dir or os.environ.get("TAVERN_HERMES_MEMORIES_DIR", "/opt/data/memories"))
    root.mkdir(parents=True, exist_ok=True)
    targets = (
        (root / "USER.md", USER_START, USER_END, _user_projection(profile)),
        (root / "MEMORY.md", MEMORY_START, MEMORY_END, _memory_projection(profile)),
    )
    changed = []
    for path, start, end, body in targets:
        with _file_lock(path):
            old = path.read_text(encoding="utf-8") if path.exists() else ""
            new = _replace_block(old, start, end, body)
            if new != old:
                _atomic_text(path, new)
                changed.append(str(path))
    return {"revision": int(profile.get("revision") or 0), "changed": changed}


def memory_preview(profile: dict) -> dict:
    return {"user": _user_projection(profile), "memory": _memory_projection(profile)}


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
    with _LOCK:
        profile = ensure_profile(state_dir, seed_actor)
        target = next(
            (item for item in profile.get("preferences") or [] if item.get("id") == preference_id),
            None,
        )
        if target is None:
            raise KeyError(f"preference not found: {preference_id}")
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

        profile["taste_profile_stale"] = True
        profile.pop("relationship", None)
        profile["revision"] = int(profile.get("revision") or 0) + 1
        profile["updated_at"] = _now()
        era_items = _read_json(eras_path, [])
        _atomic_json(profile_path, profile)
        _atomic_text(actor_path, render_markdown(profile, era_items if isinstance(era_items, list) else []))
        sync_hermes_memories(profile)
        return target


def set_taste_profile(
    state_dir: str | Path,
    seed_actor: str | Path,
    value: dict,
) -> dict:
    """Store a validated model-generated story-taste summary."""
    if not isinstance(value, dict):
        raise ValueError("taste profile must be an object")
    normalized = {}
    for key in TASTE_PROFILE_FIELDS:
        raw = value.get(key) or []
        if not isinstance(raw, list):
            raise ValueError(f"{key} must be an array")
        items = []
        for item in raw:
            clean = " ".join(str(item or "").split()).strip()
            if clean and clean not in items:
                items.append(clean[:240])
        normalized[key] = items[:4]

    profile_path, _, eras_path, actor_path = _paths(state_dir)
    with _LOCK:
        profile = ensure_profile(state_dir, seed_actor)
        profile["taste_profile"] = normalized
        profile["taste_profile_stale"] = False
        profile.setdefault("shared_story_memory", [])
        profile.pop("relationship", None)
        profile["revision"] = int(profile.get("revision") or 0) + 1
        profile["updated_at"] = _now()
        era_items = _read_json(eras_path, [])
        _atomic_json(profile_path, profile)
        _atomic_text(actor_path, render_markdown(profile, era_items if isinstance(era_items, list) else []))
        sync_hermes_memories(profile)
    return normalized


def sync_story_states(
    state_dir: str | Path,
    seed_actor: str | Path,
    productions: list[dict],
) -> list[dict]:
    """Project model-generated plot ledgers into bounded shared story memory."""
    worlds = []
    for production in productions or []:
        if not isinstance(production, dict):
            continue
        state = production.get("story_state") or {}
        turns = int(state.get("turns") or 0) if isinstance(state, dict) else 0
        if turns <= 0:
            continue
        events = [
            " ".join(str(item or "").split()).strip()[:420]
            for item in state.get("timeline") or [] if str(item or "").strip()
        ]
        threads = [
            " ".join(str(item or "").split()).strip()[:320]
            for item in state.get("open_threads") or [] if str(item or "").strip()
        ]
        worlds.append({
            "production_id": str(production.get("id") or ""),
            "world": str(production.get("name") or "未命名世界").strip(),
            "covered_turns": turns,
            "events": events[-12:],
            "open_threads": threads[:6],
            "updated_at": int(state.get("updated_at") or production.get("updated_at") or 0),
        })
    worlds.sort(key=lambda item: (item["updated_at"], item["covered_turns"]), reverse=True)
    worlds = worlds[:8]

    profile_path, _, eras_path, actor_path = _paths(state_dir)
    with _LOCK:
        profile = ensure_profile(state_dir, seed_actor)
        profile["shared_story_memory"] = worlds
        profile.pop("relationship", None)
        profile["revision"] = int(profile.get("revision") or 0) + 1
        profile["updated_at"] = _now()
        era_items = _read_json(eras_path, [])
        _atomic_json(profile_path, profile)
        _atomic_text(actor_path, render_markdown(profile, era_items if isinstance(era_items, list) else []))
        sync_hermes_memories(profile)
    return worlds


def context_for_message(profile: dict, user_message: str = "") -> str:
    body = _user_projection(profile) + "\n\n" + _memory_projection(profile)
    instruction = (
        "以下内容来自酒馆中已经完成的模型偏好复盘与剧情账本。"
        "需要时自然利用，不要逐条复述，不要把故事口味或虚构剧情推断成现实人格与现实经历。"
    )
    return "<tavern_story_memory>\n" + instruction + "\n" + body[:3000] + "\n</tavern_story_memory>"


def audit(state_dir: str | Path, seed_actor: str | Path) -> dict:
    profile = ensure_profile(state_dir, seed_actor)
    return {
        "schema_version": profile.get("schema_version"),
        "revision": profile.get("revision"),
        "active_preferences": len(_active_preferences(profile)),
        "event_count": int(profile.get("stats", {}).get("event_count") or 0),
        "recent_timeline": len(profile.get("recent_timeline") or []),
        "era_count": len(eras(state_dir)),
        "taste_profile_fields": sum(
            1 for key in TASTE_PROFILE_FIELDS if (profile.get("taste_profile") or {}).get(key)
        ),
        "taste_profile_stale": bool(profile.get("taste_profile_stale")),
        "shared_story_worlds": len(profile.get("shared_story_memory") or []),
    }
