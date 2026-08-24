"""Semantic preparation for externally sourced character cards.

Parsing remains deterministic in ``card_import``.  This module performs the
one-time semantic job required before an external card is stored: shape the
main character profile, separate supporting characters from shared lore, and
produce a validated, reviewable import plan.
"""

from __future__ import annotations

import copy
import difflib
import hashlib
import json
import re
import time

import card_import
import model_retry


SCHEMA_VERSION = "tavern-card-preparation/v1"
CHUNK_TARGET_CHARS = 2500
MAX_SOURCES_PER_CHUNK = 8
MAX_SOURCE_ITEM_CHARS = 30000
MAX_WORLD_ENTRIES = 512
MAX_SUPPORTING_CHARACTERS = 64
SEMANTIC_SOURCE_FIELDS = ("description", "personality")


def _text(value, limit=4000):
    return str(value or "").strip()[:limit]


def _source_text(value, label):
    text = str(value or "").strip()
    if len(text) > MAX_SOURCE_ITEM_CHARS:
        raise ValueError(f"{label} 超过 {MAX_SOURCE_ITEM_CHARS} 字符，请先拆成完整语义条目")
    return text


def _list(value, limit=12, item_limit=240):
    values = value if isinstance(value, list) else ([value] if value else [])
    result = []
    for item in values:
        text = _text(item, item_limit)
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _json_from_text(value):
    text = str(value or "").strip()
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except (TypeError, ValueError):
        pass
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.I | re.S)
    if fenced:
        try:
            parsed = json.loads(fenced.group(1))
            return parsed if isinstance(parsed, dict) else None
        except ValueError:
            pass
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(text[start:end + 1])
            return parsed if isinstance(parsed, dict) else None
        except ValueError:
            return None
    return None


def _book_entries(card):
    book = card.get("character_book") if isinstance(card.get("character_book"), dict) else {}
    entries = book.get("entries") if isinstance(book.get("entries"), list) else []
    result = []
    for index, item in enumerate(entries):
        if not isinstance(item, dict):
            continue
        content = _source_text(
            item.get("content") or item.get("text"), f"内嵌世界书第 {index + 1} 条")
        if not content:
            continue
        result.append({
            "source_id": f"entry-{index}",
            "name": _text(item.get("name") or item.get("comment"), 180),
            "keys": _list(item.get("keys") or item.get("key"), 12, 100),
            "content": content,
            "constant": bool(item.get("constant")),
            "enabled": item.get("enabled", True) is not False,
            "priority": item.get("priority", item.get("order", 5)),
            "source": copy.deepcopy(item),
        })
        if len(result) > MAX_WORLD_ENTRIES:
            raise ValueError(
                f"内嵌世界书超过 {MAX_WORLD_ENTRIES} 条，当前版本不会截断导入；请先拆分世界书")
    return result


def _source_records(card, entries):
    records = {}
    for field in SEMANTIC_SOURCE_FIELDS:
        content = _source_text(card.get(field), field)
        if content:
            source_ref = "field-" + field.replace("_", "-")
            records[source_ref] = {
                "source_id": source_ref,
                "name": field,
                "keys": [],
                "content": content,
                "constant": False,
                "enabled": True,
                "priority": 5,
                "source": {"field": field},
            }
    extensions = card.get("extensions") if isinstance(card.get("extensions"), dict) else {}
    tavern = extensions.get("tavern") if isinstance(extensions.get("tavern"), dict) else {}
    extension_profile = tavern.get("profile") if isinstance(tavern.get("profile"), dict) else {}
    unknown = card.get("source_unknown") if isinstance(card.get("source_unknown"), dict) else {}
    unknown_data = unknown.get("data") if isinstance(unknown.get("data"), dict) else {}
    explicit_profile = unknown_data.get("profile") if isinstance(unknown_data.get("profile"), dict) else {}
    profile = explicit_profile or extension_profile
    if _profile_has_details(profile):
        source_ref = "field-profile"
        records[source_ref] = {
            "source_id": source_ref,
            "name": "profile",
            "keys": [],
            "content": json.dumps(profile, ensure_ascii=False),
            "constant": False,
            "enabled": True,
            "priority": 5,
            "source": {"field": "profile"},
        }
    records.update({entry["source_id"]: entry for entry in entries})
    return records


def _source_payload(card):
    entries = _book_entries(card)
    source_by_ref = _source_records(card, entries)
    payload = {
        "main_character_name": _text(card.get("name"), 160),
        "source_format": card.get("source_format") or "unknown",
        "sources": [
            {
                "source_ref": source_ref,
                "kind": "embedded_entry" if source_ref.startswith("entry-") else "card_field",
                "name": source["name"],
                "keys": source["keys"],
                "content": source["content"],
                "constant": source["constant"],
                "enabled": source["enabled"],
                "priority": source["priority"],
            }
            for source_ref, source in source_by_ref.items()
        ],
    }
    return payload, entries, source_by_ref


def _payload_chunks(payload):
    """Split by complete source records; never cut a lore entry or field."""
    chunks = []
    current = []
    current_size = 0
    for source in payload.get("sources") or []:
        size = len(json.dumps(source, ensure_ascii=False))
        if current and (
            current_size + size > CHUNK_TARGET_CHARS
            or len(current) >= MAX_SOURCES_PER_CHUNK
        ):
            chunks.append(current)
            current = []
            current_size = 0
        current.append(source)
        current_size += size
    if current:
        chunks.append(current)
    if not chunks:
        chunks.append([])
    return [{
        "main_character_name": payload.get("main_character_name") or "",
        "source_format": payload.get("source_format") or "unknown",
        "batch": {"index": index + 1, "total": len(chunks)},
        "sources": sources,
    } for index, sources in enumerate(chunks)]


def _profile_has_details(profile):
    if not isinstance(profile, dict):
        return False
    for section_name, section in profile.items():
        if not isinstance(section, dict):
            continue
        for key, value in section.items():
            if section_name == "identity" and key == "name":
                continue
            if isinstance(value, list) and any(str(item or "").strip() for item in value):
                return True
            if not isinstance(value, (dict, list)) and str(value or "").strip():
                return True
    return False


def _canonical_profile(value, fallback_name):
    raw = value if isinstance(value, dict) else {}
    profile = card_import.canonical_profile({
        "name": fallback_name,
        "profile": raw,
    })
    profile["identity"]["name"] = _text(
        profile["identity"].get("name") or fallback_name, 160)
    return profile


def _render_description(profile):
    sections = []
    mapping = (
        ("身份", "identity", ("description", "gender", "age", "species", "occupation", "affiliations", "story_role")),
        ("外观", "appearance", ("summary", "features", "attire")),
        ("性格", "personality", ("summary", "traits", "values", "motivation", "fears", "boundaries")),
        ("表达", "expression", ("speech_style", "habits", "mannerisms")),
        ("能力", "capabilities", ("skills", "powers", "limitations")),
        ("背景", "background", ("summary", "key_history")),
    )
    for label, section_name, keys in mapping:
        source = profile.get(section_name) if isinstance(profile.get(section_name), dict) else {}
        lines = []
        for key in keys:
            value = source.get(key)
            values = value if isinstance(value, list) else ([value] if value else [])
            for item in values:
                text = _text(item, 700)
                if text and text not in lines:
                    lines.append(text)
        if lines:
            sections.append(f"<{label}>\n" + "\n".join(f"- {line}" for line in lines) + f"\n</{label}>")
    return "<角色>\n" + "\n".join(sections) + "\n</角色>"


def _entry(value, fallback):
    raw = value if isinstance(value, dict) else {}
    return card_import.canonical_entry({
        "entry": raw,
        "scenario": fallback.get("scenario"),
        "first_mes": fallback.get("first_mes"),
        "mes_example": fallback.get("mes_example"),
    })


def _performance(value, fallback):
    raw = value if isinstance(value, dict) else {}
    return card_import.canonical_performance({
        "performance": raw,
        "system_prompt": fallback.get("system_prompt"),
        "post_history_instructions": fallback.get("post_history_instructions"),
    })


def _source_ids(value, known):
    values = value if isinstance(value, list) else []
    result = []
    for item in values:
        source_id = str(item or "").strip()
        if source_id in known and source_id not in result:
            result.append(source_id)
    return result


def _world_entry(value, source_by_id):
    if not isinstance(value, dict):
        return None
    source_ids = _source_ids(
        value.get("source_refs") or value.get("source_entry_ids"), source_by_id)
    if not source_ids:
        return None
    originals = [source_by_id[source_id] for source_id in source_ids]
    content = _source_text(value.get("content"), "整理后的世界书条目")
    if not content:
        content = "\n".join(entry["content"] for entry in originals)
    keys = _list(value.get("keys"), 12, 100)
    if not keys:
        for original in originals:
            for key in original["keys"]:
                if key not in keys:
                    keys.append(key)
    constant = bool(value.get("constant", all(entry["constant"] for entry in originals)))
    try:
        priority = int(value.get("priority", 5) or 5)
    except (TypeError, ValueError):
        priority = 5
    return {
        "id": "lore_" + hashlib.sha1(
            ("|".join(source_ids) + "|" + content).encode("utf-8")
        ).hexdigest()[:12],
        "name": _text(value.get("name") or originals[0]["name"], 180),
        "keys": keys,
        "content": content,
        "enabled": value.get("enabled", all(entry["enabled"] for entry in originals)) is not False,
        "constant": constant,
        "selective": bool(value.get("selective", False)),
        "secondary_keys": _list(value.get("secondary_keys"), 8, 100),
        "exclusion_keys": _list(value.get("exclusion_keys"), 8, 100),
        "priority": max(1, min(10, priority)),
        "position": value.get("position") if value.get("position") in ("before_char", "after_char") else "before_char",
        "category": _text(value.get("category") or "setting", 80),
        "source_refs": source_ids,
    }


def _supporting_card(value, original_card, source_by_id):
    if not isinstance(value, dict):
        return None
    name = _text(value.get("name"), 160)
    source_ids = _source_ids(
        value.get("source_refs") or value.get("source_entry_ids"), source_by_id)
    if not name or not source_ids:
        return None
    profile = _canonical_profile(value.get("profile"), name)
    if not _profile_has_details(profile):
        return None
    description = _render_description(profile)
    card = {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "source_format": original_card.get("source_format") or "unknown",
        "name": name,
        "description": description,
        "personality": profile["personality"].get("summary") or "、".join(profile["personality"].get("traits") or []),
        "scenario": "",
        "first_mes": "",
        "mes_example": "",
        "system_prompt": "",
        "post_history_instructions": "",
        "alternate_greetings": [],
        "group_only_greetings": [],
        "tags": _list(original_card.get("tags"), 12, 120),
        "creator": original_card.get("creator") or "",
        "source": original_card.get("source") or "",
        "source_urls": copy.deepcopy(original_card.get("source_urls") or []),
        "profile": profile,
        "entry": card_import.canonical_entry({}),
        "performance": card_import.canonical_performance({}),
        "extensions": {"tavern": {"prepared_from": original_card.get("id"), "source_refs": source_ids}},
        "source_unknown": {},
    }
    card["id"] = "card_" + hashlib.sha1(
        (name + "|" + description[:500]).encode("utf-8")
    ).hexdigest()[:12]
    return card


def _normalize_result(card, raw, entries, source_by_ref=None):
    if not isinstance(raw, dict):
        raise ValueError("角色卡整理模型没有返回 JSON 对象")
    source_by_id = source_by_ref or _source_records(card, entries)
    main = raw.get("main_character") if isinstance(raw.get("main_character"), dict) else {}
    profile = _canonical_profile(main.get("profile"), card.get("name"))
    profile["identity"]["name"] = _text(card.get("name"), 160)
    if not _profile_has_details(profile):
        raise ValueError("整理后仍没有可用的主角色资料，已拒绝写入空白角色卡")

    # Opening text and generation instructions are source artifacts, not
    # semantic classification output. Preserve them exactly and keep the model
    # focused on profiles and lore routing.
    entry = _entry(card.get("entry"), card)
    performance = _performance(card.get("performance"), card)
    prepared = copy.deepcopy(card)
    original_book = copy.deepcopy(prepared.get("character_book"))
    original_fields = {
        key: copy.deepcopy(prepared.get(key))
        for key in ("description", "personality", "scenario", "first_mes", "mes_example")
    }
    prepared["profile"] = profile
    prepared["entry"] = entry
    prepared["performance"] = performance
    prepared["name"] = profile["identity"]["name"] or card.get("name")
    prepared["description"] = _render_description(profile)
    prepared["personality"] = profile["personality"].get("summary") or "、".join(profile["personality"].get("traits") or [])
    prepared["scenario"] = entry["initial_scenario"]
    prepared["first_mes"] = entry["first_message"]
    prepared["mes_example"] = entry["example_dialogue"]

    world_entries = []
    covered = set()
    for value in raw.get("worldbook_entries") or []:
        normalized = _world_entry(value, source_by_id)
        if normalized:
            covered.update(normalized["source_refs"])
            world_entries.append(normalized)

    supporting = []
    raw_supporting = raw.get("supporting_characters") or []
    if len(raw_supporting) > MAX_SUPPORTING_CHARACTERS:
        raise ValueError(
            f"整理结果包含超过 {MAX_SUPPORTING_CHARACTERS} 个配角，当前版本不会截断")
    for value in raw_supporting:
        normalized = _supporting_card(value, card, source_by_id)
        if normalized:
            covered.update(((normalized.get("extensions") or {}).get("tavern") or {}).get("source_refs") or [])
            supporting.append(normalized)

    main_sources = _source_ids(
        main.get("source_refs") or main.get("source_entry_ids"), source_by_id)
    covered.update(main_sources)
    unresolved = _source_ids(
        raw.get("unresolved_source_refs") or raw.get("unresolved_entry_ids"),
        source_by_id,
    )
    covered.update(unresolved)
    missing = sorted(set(source_by_id) - covered)
    if missing:
        raise ValueError("整理结果遗漏原始内容：" + "、".join(missing[:12]))

    if world_entries:
        prepared["character_book"] = {
            "name": _text((original_book or {}).get("name") or prepared["name"], 180),
            "entries": world_entries,
        }
    else:
        prepared.pop("character_book", None)

    unknown = prepared.get("source_unknown") if isinstance(prepared.get("source_unknown"), dict) else {}
    unknown["semantic_import"] = {
        "original_fields": original_fields,
        "original_character_book": original_book,
        "main_source_refs": main_sources,
        "unresolved_source_refs": unresolved,
    }
    prepared["source_unknown"] = unknown
    extension = prepared.get("extensions") if isinstance(prepared.get("extensions"), dict) else {}
    tavern = extension.get("tavern") if isinstance(extension.get("tavern"), dict) else {}
    tavern["preparation_schema"] = SCHEMA_VERSION
    extension["tavern"] = tavern
    prepared["extensions"] = extension

    return {
        "schema": SCHEMA_VERSION,
        "card": prepared,
        "supporting_cards": supporting,
        "summary": {
            "main_character": prepared["name"],
            "profile_ready": True,
            "supporting_characters": [item["name"] for item in supporting],
            "worldbook_entries": len(world_entries),
            "main_character_entries": len([
                source_ref for source_ref in main_sources if source_ref.startswith("entry-")
            ]),
            "unresolved_entries": len([
                source_ref for source_ref in unresolved if source_ref.startswith("entry-")
            ]),
            "warnings": _list(raw.get("warnings"), 12, 300),
        },
    }


def _prompt(payload):
    available_refs = [
        source.get("source_ref")
        for source in payload.get("sources") or []
        if source.get("source_ref")
    ]
    example_refs = available_refs[:1]
    schema = {
        "main_character": {
            "source_refs": example_refs,
            "profile": {
                "identity": {"name": "", "aliases": [], "description": "", "gender": "", "age": "", "species": "", "occupation": "", "affiliations": [], "story_role": ""},
                "appearance": {"summary": "", "features": [], "attire": []},
                "personality": {"summary": "", "traits": [], "values": [], "motivation": "", "fears": [], "boundaries": []},
                "expression": {"speech_style": "", "habits": [], "mannerisms": []},
                "capabilities": {"skills": [], "powers": [], "limitations": []},
                "background": {"summary": "", "key_history": []},
            },
        },
        "supporting_characters": [{"name": "", "source_refs": example_refs, "profile": {}}],
        "worldbook_entries": [{"source_refs": example_refs, "name": "", "content": "", "keys": [], "constant": False, "priority": 5, "category": "setting"}],
        "unresolved_source_refs": [],
        "warnings": [],
    }
    system = (
        "You normalize imported roleplay character cards. Return one compact strict JSON object only, with no analysis or markdown. "
        "The named main character must remain the main character. Organize only facts explicitly present in the source; never infer or invent. "
        "Use source_ref values exactly as provided. A card field may contain several categories and may be cited by several destinations. "
        "Put stable identity, appearance, personality, voice, abilities, and personal history in character profiles. "
        "Put locations, organizations, shared history, rules, and public setting facts in worldbook_entries. "
        "Do not restate a character's affiliation, relationship, origin, or biography in worldbook_entries. "
        "Worldbook content must stand on its own as shared setting rather than use a character as its subject. "
        "When a source mixes categories, split its facts and cite the same source_ref in each destination. "
        "A different explicitly named person becomes a supporting character, not world lore. "
        "Temporary scene state and uncertain content go to unresolved_source_refs. "
        "Every entry-* source_ref must appear at least once in main_character.source_refs, a supporting character, a worldbook entry, or unresolved_source_refs. "
        "Do not copy or rewrite first messages, example dialogue, system prompts, or post-history instructions; the program preserves them. "
        "This may be one batch from a larger card. Classify every source_ref in this batch; do not assume omitted batches are absent. "
        "Keep output content in the source card's language. Use every top-level key shown in the schema; empty profile fields are allowed. "
        "Keep each fact once, avoid synonyms and repetition, and keep arrays concise."
    )
    user = "Required JSON shape:\n" + json.dumps(schema, ensure_ascii=False) + "\n\nSource card:\n" + json.dumps(payload, ensure_ascii=False)
    return system, user


def _merge_unique(left, right):
    result = list(left or [])
    seen = {
        str(item).strip().casefold()
        for item in result
        if str(item or "").strip()
    }
    for item in right or []:
        marker = str(item or "").strip().casefold()
        if marker and marker not in seen:
            result.append(item)
            seen.add(marker)
    return result


def _merge_prose(left, right):
    left = str(left or "").strip()
    right = str(right or "").strip()
    if not left:
        return right
    if not right or left == right:
        return left
    normalized_left = re.sub(r"\W+", "", left).casefold()
    normalized_right = re.sub(r"\W+", "", right).casefold()
    if normalized_left in normalized_right or normalized_right in normalized_left:
        return left if len(left) >= len(right) else right
    if difflib.SequenceMatcher(None, normalized_left, normalized_right).ratio() >= 0.68:
        return left if len(left) >= len(right) else right
    return left + "\n" + right


def _merge_profile(left, right, fallback_name):
    base = _canonical_profile(left, fallback_name)
    incoming = _canonical_profile(right, fallback_name)
    for section_name, section in incoming.items():
        if not isinstance(section, dict):
            continue
        target = base.setdefault(section_name, {})
        for key, value in section.items():
            if isinstance(value, list):
                target[key] = _merge_unique(target.get(key), value)
            elif value and not target.get(key):
                target[key] = value
            elif (value and target.get(key) and value != target.get(key)
                  and key in {"description", "summary", "speech_style", "motivation"}):
                target[key] = _merge_prose(target[key], value)
    base["identity"]["name"] = _text(fallback_name, 160)
    return base


def _result_source_refs(raw):
    refs = []
    main = raw.get("main_character") if isinstance(raw.get("main_character"), dict) else {}
    refs.extend(main.get("source_refs") or main.get("source_entry_ids") or [])
    for key in ("supporting_characters", "worldbook_entries"):
        for item in raw.get(key) or []:
            if isinstance(item, dict):
                refs.extend(item.get("source_refs") or item.get("source_entry_ids") or [])
    refs.extend(raw.get("unresolved_source_refs") or raw.get("unresolved_entry_ids") or [])
    return [str(value or "").strip() for value in refs if str(value or "").strip()]


def _validate_batch_result(raw, expected_refs, fallback_main_name=""):
    if not isinstance(raw, dict):
        raise ValueError("模型没有返回 JSON 对象")
    known = set(expected_refs)
    actual = set(_result_source_refs(raw))
    unknown = sorted(actual - known)
    if unknown:
        raise ValueError("模型引用了本批不存在的来源：" + "、".join(unknown[:12]))
    missing = sorted(known - actual)
    if missing:
        raise ValueError("模型遗漏了本批原始内容：" + "、".join(missing[:12]))
    for item in raw.get("supporting_characters") or []:
        name = str((item or {}).get("name") or "").strip() if isinstance(item, dict) else ""
        if not name or not _profile_has_details((item or {}).get("profile")):
            raise ValueError("模型返回了没有完整资料的配角")
    character_names_by_ref = {}
    main = raw.get("main_character") if isinstance(raw.get("main_character"), dict) else {}
    main_name = str(
        ((main.get("profile") or {}).get("identity") or {}).get("name")
        or fallback_main_name
        or ""
    ).strip()
    for source_ref in main.get("source_refs") or main.get("source_entry_ids") or []:
        if main_name:
            character_names_by_ref.setdefault(source_ref, set()).add(main_name)
    for item in raw.get("supporting_characters") or []:
        name = str(item.get("name") or "").strip()
        for source_ref in item.get("source_refs") or item.get("source_entry_ids") or []:
            if name:
                character_names_by_ref.setdefault(source_ref, set()).add(name)
    for item in raw.get("worldbook_entries") or []:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "")
        refs = item.get("source_refs") or item.get("source_entry_ids") or []
        repeated_names = {
            name
            for source_ref in refs
            for name in character_names_by_ref.get(source_ref, set())
            if name.casefold() in content.casefold()
        }
        if repeated_names:
            raise ValueError(
                "人物资料不得重复写入世界书：" + "、".join(sorted(repeated_names)))
    return raw


def _merge_batch_results(results, main_name):
    merged = {
        "main_character": {"source_refs": [], "profile": {}},
        "supporting_characters": [],
        "worldbook_entries": [],
        "unresolved_source_refs": [],
        "warnings": [],
    }
    supporting_by_name = {}
    for raw in results:
        main = raw.get("main_character") if isinstance(raw.get("main_character"), dict) else {}
        merged_main = merged["main_character"]
        merged_main["source_refs"] = _merge_unique(
            merged_main["source_refs"], main.get("source_refs") or main.get("source_entry_ids"))
        merged_main["profile"] = _merge_profile(
            merged_main.get("profile"), main.get("profile"), main_name)

        for item in raw.get("supporting_characters") or []:
            name = str(item.get("name") or "").strip()
            key = name.casefold()
            if key not in supporting_by_name:
                supporting_by_name[key] = {
                    "name": name,
                    "source_refs": [],
                    "profile": {},
                }
            target = supporting_by_name[key]
            target["source_refs"] = _merge_unique(
                target["source_refs"], item.get("source_refs") or item.get("source_entry_ids"))
            target["profile"] = _merge_profile(target.get("profile"), item.get("profile"), name)

        merged["worldbook_entries"].extend(
            copy.deepcopy(raw.get("worldbook_entries") or []))
        merged["unresolved_source_refs"] = _merge_unique(
            merged["unresolved_source_refs"],
            raw.get("unresolved_source_refs") or raw.get("unresolved_entry_ids"),
        )
        merged["warnings"] = _merge_unique(merged["warnings"], raw.get("warnings"))
    merged["supporting_characters"] = list(supporting_by_name.values())
    return merged


def prepare_card(card, chat, model=None):
    """Return a validated, side-effect-free semantic import plan."""
    normalized = card_import.normalize_card(card) if "source_format" not in card else copy.deepcopy(card)
    payload, entries, source_by_ref = _source_payload(normalized)
    chunks = _payload_chunks(payload)
    batch_results = []
    for chunk in chunks:
        expected_refs = [source["source_ref"] for source in chunk["sources"]]
        system, user = _prompt(chunk)
        base_messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        last_error = ""
        completed = False
        model_base = str((model or {}).get("base") or "").lower()
        request_options = (
            {"thinking_mode": False}
            if not model or "clawling" in model_base
            else None
        )
        validation_error = ""
        for attempt in range(model_retry.MAX_MODEL_ATTEMPTS):
            messages = base_messages
            if validation_error:
                messages = base_messages + [{
                    "role": "user",
                    "content": (
                        "The previous answer failed validation: " + validation_error +
                        ". Start over from this same batch and return one complete compact JSON object only."
                    ),
                }]
            try:
                output = chat(
                    messages,
                    temperature=0.1,
                    model=model,
                    max_tokens=6000,
                    request_options=request_options,
                )
            except Exception as error:  # network, timeout, empty/safety response
                last_error = str(error)
                validation_error = ""
                if (attempt + 1 >= model_retry.MAX_MODEL_ATTEMPTS
                        or not model_retry.is_retryable_model_error(error)):
                    break
                time.sleep(model_retry.retry_delay_seconds(attempt + 1))
                continue
            try:
                parsed = _json_from_text(output)
                batch_results.append(_validate_batch_result(
                    parsed, expected_refs, normalized.get("name") or ""))
                completed = True
                break
            except ValueError as error:
                last_error = str(error)
                validation_error = last_error
        if not completed:
            batch = chunk.get("batch") or {}
            raise ValueError(
                f"角色卡第 {batch.get('index', '?')}/{batch.get('total', '?')} 批整理失败：" +
                (last_error or "模型未返回有效 JSON"))

    merged = _merge_batch_results(batch_results, normalized.get("name") or "")
    plan = _normalize_result(normalized, merged, entries, source_by_ref)
    plan["summary"]["batches"] = len(chunks)
    plan["summary"]["source_items"] = len(source_by_ref)
    plan["source_hash"] = hashlib.sha256(
        json.dumps(normalized, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    plan["plan_id"] = "prep_" + hashlib.sha256(
        json.dumps(plan, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:20]
    return plan


def validate_plan(plan):
    if not isinstance(plan, dict) or plan.get("schema") != SCHEMA_VERSION:
        raise ValueError("不是受支持的角色卡整理计划")
    card = plan.get("card")
    if not isinstance(card, dict) or not str(card.get("name") or "").strip():
        raise ValueError("整理计划缺少主角色")
    profile = card_import.canonical_profile(card)
    if not _profile_has_details(profile):
        raise ValueError("整理计划中的主角色资料为空")
    plan_id = str(plan.get("plan_id") or "")
    unsigned = copy.deepcopy(plan)
    unsigned.pop("plan_id", None)
    expected = "prep_" + hashlib.sha256(
        json.dumps(unsigned, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:20]
    if plan_id != expected:
        raise ValueError("角色卡整理计划已被修改，请重新生成预览")
    return plan
