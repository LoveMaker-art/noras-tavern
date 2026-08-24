"""Foreground actor generation helpers for Tavern runtime.

This module owns how a reply is generated and retried. It does not own HTTP
events, persistence, cancellation, story-state scheduling, or background jobs.
Runtime dependencies are injected by server.py to avoid global coupling.
"""
import sys
import time

import model_retry


def loadout(production, *, ensure_production_session):
    """Return cards, worldbooks, persona, and director note for one generation."""
    ensure_production_session(production)
    cards = [c for c in (production.get("cards") or []) if isinstance(c, dict)]
    worldbooks = [w for w in (production.get("worldbooks") or []) if isinstance(w, dict)]
    persona = production.get("persona") or {}
    note = production.get("author_note", "")
    return cards, worldbooks, persona, note


def perform_loaded(cards, worldbooks, persona, story, note, *,
                   actor_module, model, story_state, response_language):
    last_error = RuntimeError("model call did not run")
    for attempt in range(model_retry.MAX_MODEL_ATTEMPTS):
        try:
            result = actor_module.perform(
                cards, worldbooks, persona, story, note,
                model=model,
                story_state=story_state,
                response_language=response_language,
            )
            if str(result or "").strip():
                return result
            raise RuntimeError("model returned empty story content")
        except Exception as error:  # noqa: BLE001
            last_error = error
            if attempt + 1 >= model_retry.MAX_MODEL_ATTEMPTS:
                raise
            print("actor generation retry with same model:", repr(error),
                  file=sys.stderr, flush=True)
            time.sleep(model_retry.retry_delay_seconds(attempt + 1))
    raise last_error


def perform_into(production, *, actor_module, active_model,
                 effective_story_state, ensure_world_language,
                 ensure_production_session):
    cards, worldbooks, persona, note = loadout(
        production,
        ensure_production_session=ensure_production_session,
    )
    language = ensure_world_language(production)
    return perform_loaded(
        cards, worldbooks, persona, production["story"], note,
        actor_module=actor_module,
        model=active_model(),
        story_state=effective_story_state(production),
        response_language=language,
    )


def ensure_actor_reply(production, cards, worldbooks, persona, note, text, *,
                       actor_module, active_model,
                       effective_story_state, ensure_world_language,
                       normalize_actor_reply):
    text = normalize_actor_reply(text)
    if text:
        return text
    language = ensure_world_language(production)
    if language == "en":
        retry_instruction = (
            "Continue from the user's latest message with one coherent story response in English. "
            "Keep action, environment, and character dialogue naturally connected."
        )
    elif language == "zh-Hant":
        retry_instruction = (
            "承接最後一條使用者輸入，使用繁體中文續寫當前故事的一段內容。"
            "動作、環境與角色對白要自然連貫。"
        )
    else:
        retry_instruction = (
            "承接最后一条用户输入，使用简体中文续写当前故事的一段内容。"
            "动作、环境与角色对白要自然连贯。"
        )
    retry_note = (note + "\n" if note else "") + retry_instruction
    try:
        text = normalize_actor_reply(perform_loaded(
            cards, worldbooks, persona, production["story"], retry_note,
            actor_module=actor_module,
            model=active_model(),
            story_state=effective_story_state(production),
            response_language=language,
        ))
    except Exception as e:  # noqa: BLE001
        print("actor retry failed:", repr(e), file=sys.stderr, flush=True)
        raise RuntimeError("模型暂时没有返回内容，请稍后重试。")
    if not text:
        print("actor retry returned empty", file=sys.stderr, flush=True)
        raise RuntimeError("模型暂时没有返回内容，请稍后重试。")
    return text
