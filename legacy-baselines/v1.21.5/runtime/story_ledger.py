"""Shared invariants for replacing raw story history with a compact ledger."""

from __future__ import annotations

import hashlib
import json
import os


MEMORY_KEYS = (
    "timeline",
    "facts",
    "open_threads",
    "objects",
    "secrets",
    "style_notes",
)


def story_messages_through_turn(story, end_turn):
    selected = []
    seen_turns = 0
    for message in story or []:
        if message.get("role") == "user":
            seen_turns += 1
            if seen_turns > end_turn:
                break
        selected.append(message)
    return selected


def story_token_prefixes(story, estimate_text_tokens):
    """Return cumulative token estimates per user turn in one history scan."""
    totals = {}
    turn = 0
    total = 0
    for message in story or []:
        if message.get("role") == "user":
            if turn:
                totals[turn] = total
            turn += 1
        total += estimate_text_tokens(message.get("text") or "")
    if turn:
        totals[turn] = total
    return totals


def story_state_has_memory(state):
    return isinstance(state, dict) and any(state.get(key) for key in MEMORY_KEYS)


def story_prefix_signature(story, end_turn):
    selected = story_messages_through_turn(story, end_turn)
    payload = [(item.get("id"), item.get("role"), item.get("text") or "") for item in selected]
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validated_story_state(state, story, batch_turns=None):
    """Return a ledger only when it safely replaces confirmed raw history."""
    if not story_state_has_memory(state) or state.get("stale"):
        return {}
    try:
        covered_turns = int(state.get("turns") or 0)
        batch_turns = int(
            batch_turns
            or os.environ.get("TAVERN_STORY_STATE_BATCH_TURNS", "15")
        )
    except (TypeError, ValueError):
        return {}
    batch_turns = max(1, batch_turns)
    total_turns = sum(1 for message in story or [] if message.get("role") == "user")
    compressible_turns = max(0, total_turns - 1)
    if (
        covered_turns <= 0
        or covered_turns % batch_turns
        or covered_turns > compressible_turns
    ):
        return {}
    expected = str(state.get("covered_signature") or "").strip()
    if expected and story_prefix_signature(story, covered_turns) != expected:
        return {}
    return state
