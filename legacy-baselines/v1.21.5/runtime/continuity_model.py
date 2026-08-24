"""Canonical per-world character and continuity data model."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import time

import card_import


def _clip_memory_text(value, limit):
    text = str(value or "").strip().lstrip("-•").strip()
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    # Drop obvious generated loops before they become permanent memory.
    for pat in ("痛苦煎熬", "天道好轮回", "源头治理", "越来越"):
        if text.count(pat) >= 4:
            i = text.find(pat)
            text = text[:i + len(pat)]
            break
    return text[:limit].rstrip()


def _state_list(value, limit=12, max_len=180):
    values = value if isinstance(value, list) else ([value] if value else [])
    out = []
    for item in values:
        text = _clip_memory_text(item, max_len)
        if text and text not in out:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def _stable_memory_id(prefix, value):
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return prefix + "_" + hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]


def _normalize_known_by(value, valid_ids=None):
    values = value if isinstance(value, list) else ([value] if value else [])
    out = []
    for item in values:
        cid = str(item or "").strip()
        if cid and (not valid_ids or cid in valid_ids) and cid not in out:
            out.append(cid)
    return out[:24]


def _normalize_fact_entry(value, valid_ids=None, secret=False):
    raw = value if isinstance(value, dict) else {"content": value}
    content = _clip_memory_text(raw.get("content") or raw.get("fact") or raw.get("summary"), 220)
    if not content:
        return None
    known_by = _normalize_known_by(raw.get("known_by"), valid_ids)
    return {
        "id": str(raw.get("id") or _stable_memory_id("secret" if secret else "fact", content)),
        "content": content,
        "known_by": known_by,
    }


def _normalize_object_entry(value, valid_ids=None):
    raw = value if isinstance(value, dict) else {"name": value}
    name = _clip_memory_text(raw.get("name") or raw.get("content") or raw.get("summary"), 160)
    if not name:
        return None
    holder = str(raw.get("holder") or "").strip()
    if holder and valid_ids and holder not in valid_ids:
        holder = ""
    return {
        "id": str(raw.get("id") or _stable_memory_id("object", name)),
        "name": name,
        "status": _clip_memory_text(raw.get("status"), 160),
        "holder": holder,
        "location": _clip_memory_text(raw.get("location"), 160),
    }


def _normalize_scene_participant(value, valid_ids=None):
    raw = value if isinstance(value, dict) else {}
    cid = str(raw.get("character_id") or raw.get("id") or "").strip()
    if not cid or (valid_ids and cid not in valid_ids):
        return None
    return {
        "character_id": cid,
        "location": _clip_memory_text(raw.get("location"), 160),
        "activity": _clip_memory_text(raw.get("activity") or raw.get("goal"), 180),
        "condition": _clip_memory_text(raw.get("condition"), 160),
    }


def _normalize_ledger_scene(value, valid_ids=None):
    raw = value if isinstance(value, dict) else {}
    participants = []
    seen = set()
    for item in raw.get("participants") or []:
        participant = _normalize_scene_participant(item, valid_ids)
        if participant and participant["character_id"] not in seen:
            seen.add(participant["character_id"])
            participants.append(participant)
    return {
        "time": _clip_memory_text(raw.get("time"), 160),
        "place": _clip_memory_text(raw.get("place") or raw.get("location"), 180),
        "participants": participants[:24],
    }


def _migrate_legacy_story_context(state, characters):
    """Move old per-card scene/knowledge state into the canonical story ledger."""
    ledger = dict(state or {})
    valid_ids = {str(c.get("id")) for c in characters if isinstance(c, dict) and c.get("id")}
    valid_ids.add("__user__")
    def entries(value):
        return [value] if isinstance(value, (str, dict)) else list(value or [])

    facts = []
    for item in entries(ledger.get("facts")):
        fact = _normalize_fact_entry(item, valid_ids)
        if fact and fact["id"] not in {x["id"] for x in facts}:
            facts.append(fact)
    scene = _normalize_ledger_scene(ledger.get("scene"), valid_ids)
    participants = {item["character_id"]: item for item in scene["participants"]}
    for character in characters:
        if not isinstance(character, dict):
            continue
        cid = str(character.get("id") or "")
        old = character.get("state") if isinstance(character.get("state"), dict) else {}
        if not cid:
            continue
        participant = participants.get(cid) or {
            "character_id": cid, "location": "", "activity": "", "condition": ""}
        participant["location"] = participant.get("location") or _clip_memory_text(old.get("location"), 160)
        participant["activity"] = participant.get("activity") or _clip_memory_text(old.get("goal"), 180)
        participant["condition"] = participant.get("condition") or _clip_memory_text(old.get("condition"), 160)
        scene_notes = card_import.canonical_scene_notes(character)
        if scene_notes and not participant["activity"]:
            participant["activity"] = _clip_memory_text("；".join(scene_notes), 180)
        if any(participant.get(key) for key in ("location", "activity", "condition")):
            participants[cid] = participant
        for memory in _state_list(old.get("knowledge"), 20, 220) + _state_list(old.get("notes"), 20, 220):
            fact = _normalize_fact_entry({"content": memory, "known_by": [cid]}, valid_ids)
            if fact and fact["id"] not in {x["id"] for x in facts}:
                facts.append(fact)
    scene["participants"] = list(participants.values())[:24]
    ledger["scene"] = scene
    ledger["facts"] = facts[:40]
    objects = []
    for item in entries(ledger.get("objects")):
        obj = _normalize_object_entry(item, valid_ids)
        if obj and obj["id"] not in {x["id"] for x in objects}:
            objects.append(obj)
    ledger["objects"] = objects[:24]
    secrets = []
    for item in entries(ledger.get("secrets")):
        fact = _normalize_fact_entry(item, valid_ids, secret=True)
        if fact and fact["id"] not in {x["id"] for x in secrets}:
            secrets.append(fact)
    ledger["secrets"] = secrets[:24]
    return ledger


def _normalize_persistent_status(value):
    raw = value if isinstance(value, dict) else {}
    identity_status = raw.get("identity_status")
    if identity_status is None:
        identity_status = "；".join(_state_list(raw.get("identity_changes"), 10, 180))
    physical_condition = raw.get("physical_condition")
    if physical_condition is None:
        physical_condition = "；".join(_state_list(raw.get("long_term_conditions"), 10, 180))
    return {
        "life_status": _clip_memory_text(raw.get("life_status"), 80),
        "identity_status": _clip_memory_text(identity_status, 600),
        "physical_condition": _clip_memory_text(physical_condition, 600),
    }


def _canonical_profile_snapshot(value):
    """Return one detached canonical profile suitable for per-world storage."""
    raw = value if isinstance(value, dict) else {}
    if any(key in raw for key in (
            "identity", "appearance", "personality", "expression",
            "capabilities", "background")):
        raw = {"profile": raw}
    return card_import.canonical_profile(raw)


def _profile_has_content(profile):
    return any(
        value
        for section in (profile or {}).values() if isinstance(section, dict)
        for value in section.values()
    )


def _normalize_persona(value):
    """Normalize the per-world user character without performance instructions."""
    raw = json.loads(json.dumps(value or {}, ensure_ascii=False)) if isinstance(value, dict) else {}
    profile = card_import.canonical_profile(raw)
    name = profile["identity"].get("name") or _clip_memory_text(raw.get("name"), 160)
    description = profile["identity"].get("description") or _clip_memory_text(raw.get("description"), 2500)
    profile["identity"]["name"] = name
    profile["identity"]["description"] = description
    persona = {"name": name, "description": description, "profile": profile}
    if raw.get("source_card_id"):
        persona["source_card_id"] = str(raw.get("source_card_id"))
    if isinstance(raw.get("persistent_status"), dict):
        persona["persistent_status"] = _normalize_persistent_status(raw.get("persistent_status"))
    return persona


def _runtime_character(card, legacy_notes=None, applied_turn=0):
    item = json.loads(json.dumps(card or {}, ensure_ascii=False))
    cid = str(item.get("id") or "card_" + secrets.token_hex(4))
    item["id"] = cid
    item.setdefault("source_card_id", cid)
    current_profile = _canonical_profile_snapshot(item.get("profile") or item)
    origin_profile = item.get("origin_profile")
    item["origin_profile"] = _canonical_profile_snapshot(
        origin_profile if isinstance(origin_profile, dict) else current_profile)
    item["profile"] = current_profile
    item["entry"] = card_import.canonical_entry(item)
    item["performance"] = card_import.canonical_performance(item)
    item["name"] = item["profile"]["identity"]["name"] or item.get("name") or ""
    item["persistent_status"] = _normalize_persistent_status(item.get("persistent_status") or {})
    item["profile_updated_turn"] = int(item.get("profile_updated_turn") or applied_turn or 0)
    item["status_updated_turn"] = int(
        item.get("status_updated_turn") or item.get("state_updated_turn") or applied_turn or 0)
    item.pop("state", None)
    item.pop("state_updated_turn", None)
    item.pop("relationships", None)
    item.pop("relationship_details", None)
    return item


def _normalize_relationships(value, characters, persona=None):
    valid_ids = {str(c.get("id")) for c in characters if c.get("id")}
    valid_ids.add("__user__")
    names_by_id = {str(c.get("id")): str(c.get("name") or "").strip()
                   for c in characters if c.get("id")}
    names = {str(c.get("name") or "").strip(): str(c.get("id")) for c in characters}
    names["用户"] = "__user__"
    names["User"] = "__user__"
    if (persona or {}).get("name"):
        names[str(persona.get("name")).strip()] = "__user__"
    out = []
    seen = set()
    values = value if isinstance(value, list) else []
    for raw in values:
        if isinstance(raw, str):
            participants = [cid for name, cid in names.items() if name and name in raw][:2]
            description = _clip_memory_text(raw, 300)
            updated_turn = 0
        elif isinstance(raw, dict):
            participants = [str(x) for x in (raw.get("participants") or []) if str(x) in valid_ids][:2]
            description = _clip_memory_text(
                raw.get("description") or raw.get("type") or raw.get("label") or raw.get("summary"), 300)
            legacy_attitude = _clip_memory_text(raw.get("attitude"), 120)
            if legacy_attitude and legacy_attitude not in description:
                description = _clip_memory_text(description + ("，" if description else "") + legacy_attitude, 300)
            updated_turn = int(raw.get("updated_turn") or 0)
        else:
            continue
        if len(participants) != 2 or participants[0] == participants[1] or not description:
            continue
        participants = sorted(participants)
        # Older snapshots often repeated both names inside the description,
        # producing UI such as "Delta: User and Delta: ...". The edge already
        # owns its participants, so retain only the human-readable predicate.
        subject, separator, predicate = description.partition("：")
        if not separator:
            subject, separator, predicate = description.partition(":")
        if separator and predicate.strip():
            subject_folded = subject.casefold()
            participant_aliases = []
            for participant in participants:
                if participant == "__user__":
                    aliases = ["用户", "user", str((persona or {}).get("name") or "").strip()]
                else:
                    aliases = [names_by_id.get(participant, "")]
                participant_aliases.append([alias.casefold() for alias in aliases if alias])
            if all(any(alias in subject_folded for alias in aliases)
                   for aliases in participant_aliases):
                description = predicate.strip()
        key = "|".join(participants)
        if key in seen:
            continue
        seen.add(key)
        out.append({"id": "rel_" + hashlib.sha1(key.encode()).hexdigest()[:12],
                    "participants": participants, "description": description,
                    "updated_turn": updated_turn})
    return out[:24]


def _relationships_from_cards(characters, persona=None):
    """Seed runtime relationships from card prose only when no live relationship state exists."""
    by_name = {str(c.get("name") or "").strip(): str(c.get("id")) for c in characters}
    user_names = {"你", "用户", "user"}
    if (persona or {}).get("name"):
        user_names.add(str(persona.get("name")).strip().lower())
    hints = []
    for character in characters:
        source_id = str(character.get("id") or "")
        for line in card_import.canonical_relationship_hints(character):
            parts = re.split(r"[：:]", line, maxsplit=1)
            label, detail = (parts[0], parts[1]) if len(parts) == 2 else (line, line)
            label = str(label).strip()
            target_id = ""
            if label.lower() in user_names or label.startswith("你"):
                target_id = "__user__"
            else:
                for name, cid in by_name.items():
                    if name and (label == name or label.startswith(name)):
                        target_id = cid
                        break
            if target_id and target_id != source_id:
                hints.append({"participants": [source_id, target_id],
                              "description": str(detail).strip(), "updated_turn": 0})
    return _normalize_relationships(hints, characters, persona)


def ensure_runtime_cast(p, load_card, production_card_ids):
    if p is None:
        return {}
    existing = p.get("runtime_cast") if isinstance(p.get("runtime_cast"), dict) else None
    if existing:
        applied_turn = int(existing.get("applied_turn") or 0)
        raw_characters = [c for c in (existing.get("characters") or []) if isinstance(c, dict)]
        migrated_characters = []
        for raw_character in raw_characters:
            character = json.loads(json.dumps(raw_character, ensure_ascii=False))
            if not isinstance(character.get("origin_profile"), dict):
                source_id = str(character.get("source_card_id") or character.get("id") or "")
                source_card = load_card(source_id) if source_id else None
                character["origin_profile"] = _canonical_profile_snapshot(
                    (source_card or {}).get("profile") or source_card or
                    character.get("profile") or character)
            migrated_characters.append(character)
        raw_characters = migrated_characters
        p["story_state"] = _migrate_legacy_story_context(p.get("story_state") or {}, raw_characters)
        characters = [_runtime_character(c, applied_turn=applied_turn) for c in raw_characters]
        runtime_cast = dict(existing)
    else:
        source_cards = p.get("cards") if isinstance(p.get("cards"), list) else None
        if source_cards is None:
            source_cards = [load_card(cid) for cid in production_card_ids(p)]
        source_cards = [c for c in source_cards if isinstance(c, dict)]
        ledger = p.get("story_state") if isinstance(p.get("story_state"), dict) else {}
        applied_turn = int(ledger.get("turns") or 0)
        legacy_states = ledger.get("character_state") if isinstance(ledger.get("character_state"), dict) else {}
        characters = [_runtime_character(c, legacy_states.get(str(c.get("name") or "")), applied_turn)
                      for c in source_cards]
        runtime_cast = {
            "schema_version": 2,
            "applied_turn": applied_turn,
            "revision": 1,
            "characters": characters,
            "relationships": _normalize_relationships(ledger.get("relationships") or [], characters,
                                                        p.get("persona") or {}),
            "updated_at": int(time.time()),
        }
    runtime_cast["schema_version"] = 3
    runtime_cast["applied_turn"] = applied_turn
    runtime_cast["revision"] = max(1, int(runtime_cast.get("revision") or 1))
    runtime_cast["characters"] = characters
    persona_profile = _canonical_profile_snapshot((p.get("persona") or {}).get("profile") or
                                                   (p.get("persona") or {}))
    current_user_profile = runtime_cast.get("user_profile")
    runtime_cast["user_profile"] = _canonical_profile_snapshot(
        current_user_profile if isinstance(current_user_profile, dict) else persona_profile)
    origin_user_profile = runtime_cast.get("origin_user_profile")
    runtime_cast["origin_user_profile"] = _canonical_profile_snapshot(
        origin_user_profile if isinstance(origin_user_profile, dict)
        else runtime_cast["user_profile"])
    runtime_cast["user_profile_updated_turn"] = int(
        runtime_cast.get("user_profile_updated_turn") or 0)
    persona_status = ((p.get("persona") or {}).get("persistent_status")
                      if isinstance(p.get("persona"), dict) else {})
    runtime_cast["user_status"] = _normalize_persistent_status(
        runtime_cast.get("user_status") if "user_status" in runtime_cast else persona_status)
    runtime_cast["user_status_updated_turn"] = int(runtime_cast.get("user_status_updated_turn") or 0)
    runtime_cast["relationships"] = _normalize_relationships(
        runtime_cast.get("relationships") or [], characters, p.get("persona") or {})
    if not runtime_cast["relationships"]:
        runtime_cast["relationships"] = _relationships_from_cards(characters, p.get("persona") or {})
    p["runtime_cast"] = runtime_cast
    return runtime_cast


def hydrate_runtime_cards(p, load_card, production_card_ids):
    runtime_cast = ensure_runtime_cast(p, load_card, production_card_ids)
    characters = json.loads(json.dumps(runtime_cast.get("characters") or [], ensure_ascii=False))
    by_id = {str(c.get("id")): c for c in characters}
    persona_name = str((p.get("persona") or {}).get("name") or "用户")
    for relation in runtime_cast.get("relationships") or []:
        participants = relation.get("participants") or []
        if len(participants) != 2:
            continue
        for cid in participants:
            card = by_id.get(str(cid))
            if not card:
                continue
            other = participants[1] if participants[0] == cid else participants[0]
            other_name = persona_name if other == "__user__" else str((by_id.get(str(other)) or {}).get("name") or other)
            detail = {
                "id": relation.get("id"),
                "target_id": other,
                "target_name": other_name,
                "description": relation.get("description") or "",
            }
            card.setdefault("relationship_details", []).append(detail)
            card.setdefault("relationships", []).append(f"{other_name}：{detail['description']}")
    p["cards"] = characters
    return characters


def hydrate_user_persona(p):
    runtime_cast = p.get("runtime_cast") if isinstance(p.get("runtime_cast"), dict) else {}
    stored = p.get("persona") if isinstance(p.get("persona"), dict) else {}
    current_profile = runtime_cast.get("user_profile")
    if isinstance(current_profile, dict):
        persona = _normalize_persona({"profile": current_profile})
        if stored.get("source_card_id"):
            persona["source_card_id"] = str(stored.get("source_card_id"))
    else:
        persona = _normalize_persona(stored)
    persona["persistent_status"] = _normalize_persistent_status(runtime_cast.get("user_status") or {})
    p["persona"] = persona
    return persona



state_list = _state_list
stable_memory_id = _stable_memory_id
normalize_known_by = _normalize_known_by
normalize_fact_entry = _normalize_fact_entry
normalize_object_entry = _normalize_object_entry
normalize_scene_participant = _normalize_scene_participant
normalize_ledger_scene = _normalize_ledger_scene
migrate_legacy_story_context = _migrate_legacy_story_context
normalize_persistent_status = _normalize_persistent_status
canonical_profile_snapshot = _canonical_profile_snapshot
profile_has_content = _profile_has_content
normalize_persona = _normalize_persona
runtime_character = _runtime_character
normalize_relationships = _normalize_relationships
relationships_from_cards = _relationships_from_cards
clip_memory_text = _clip_memory_text
