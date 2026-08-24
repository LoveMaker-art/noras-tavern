"""Read-only API projections for production data."""

from __future__ import annotations


def production_summary(production):
    """Return rail/library fields without sending the full story or runtime state."""
    production = production if isinstance(production, dict) else {}
    story = production.get("story") or []
    created_at = production.get("created_at") or 0
    last_ts = created_at
    turn_count = 0
    for message in story:
        if message.get("role") == "user":
            turn_count += 1
        timestamp = message.get("ts") or 0
        if timestamp > last_ts:
            last_ts = timestamp
    card_ids = production.get("card_ids") or (
        [] if not production.get("card_id") else [production.get("card_id")]
    )
    unique_card_ids = []
    for card_id in card_ids:
        if card_id and card_id not in unique_card_ids:
            unique_card_ids.append(card_id)
    return {
        "id": production.get("id"),
        "name": production.get("name") or "",
        "i18n": production.get("i18n") or {},
        "created_at": created_at,
        "last_ts": last_ts,
        "turn_count": turn_count,
        "story_count": len(story),
        "card_id": unique_card_ids[0] if unique_card_ids else None,
        "card_ids": unique_card_ids,
    }
