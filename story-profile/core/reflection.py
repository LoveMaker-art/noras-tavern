"""Shared Story Profile reflection pipeline for Nora HTTP and CLI adapters."""

from __future__ import annotations

import json
from pathlib import Path
import urllib.error
import urllib.request


class StoryProfileReflectionError(RuntimeError):
    pass


def _content(response):
    try:
        value = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise StoryProfileReflectionError(
            "Story Profile model returned no message content") from error
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            str(item.get("text") or "")
            for item in value if isinstance(item, dict)
        )
    return str(value or "")


class OpenAICompatibleModelClient:
    """Call the model configuration injected by the active Tavern adapter."""

    def __init__(self, config, timeout=90):
        config = dict(config or {})
        missing = [key for key in ("base_url", "model")
                   if not str(config.get(key) or "").strip()]
        if missing:
            raise StoryProfileReflectionError(
                "Story Profile model configuration is missing: "
                + ", ".join(missing))
        self.config = config
        self.timeout = timeout

    def complete(self, messages):
        endpoint = self.config["base_url"].rstrip("/") + "/chat/completions"
        payload = json.dumps({
            "model": self.config["model"],
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": min(1600, int(self.config.get("max_tokens") or 1600)),
            "stream": False,
        }, ensure_ascii=False).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        api_key = str(self.config.get("api_key") or "").strip()
        if api_key:
            headers["Authorization"] = "Bearer " + api_key
        request = urllib.request.Request(
            endpoint, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                document = json.loads(
                    response.read(4 * 1024 * 1024).decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read(1000).decode("utf-8", "replace")
            raise StoryProfileReflectionError(
                f"Story Profile model request failed: HTTP {error.code}: {detail}") from error
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise StoryProfileReflectionError(
                f"Story Profile model request failed: {error}") from error
        return _content(document).strip()


def actor_self_text(state_dir, seed_actor) -> str:
    current = Path(state_dir) / "actor_self.md"
    source = current if current.is_file() else Path(seed_actor)
    return source.read_text(encoding="utf-8") if source.is_file() else ""


def build_reflection_messages(card, story, actor_self):
    character_name = str((card or {}).get("name") or "角色")
    lines = []
    user_turns = []
    for message in story or []:
        content = str((message or {}).get("text") or "").strip()
        if not content:
            continue
        clipped = content[:500]
        who = "用户" if message.get("role") == "user" else character_name
        lines.append(f"{who}：{clipped}")
        if message.get("role") == "user":
            user_turns.append(clipped)
    if len(user_turns) < 2:
        return None
    known_index = actor_self.find("我对你的了解")
    known = actor_self[known_index:] if known_index >= 0 else ""
    system = (
        "你是角色扮演系统的『用户偏好复盘』模块。你的任务不是总结剧情，而是从一场戏里提炼"
        "可长期复用的用户偏好。\n"
        "严格规则：\n"
        "- 只记录关于用户的偏好、节奏、雷区、互动方式、喜欢的叙事角度。\n"
        "- 优先依据【用户发言】；只有用户明确回应、选择、纠正、夸赞、追问时，才能把剧情现象推成偏好。\n"
        "- 不要把角色做了什么、世界发生了什么、剧情事实写成用户偏好。\n"
        "- 不要记录一次性的剧情信息、角色关系状态、世界观设定、任务进度。\n"
        "- 不要写关于角色卡质量、模型格式、工具操作的话。\n"
        "- 每条必须能指导下次怎么陪这个用户走故事。\n"
        "输出：1-3 条；每条以「- 」开头；一句话；具体可执行；不要标题或解释。\n"
        "如果用户发言不足以判断偏好，只输出 NONE。\n\n"
        f"# 已知偏好（不要重复，除非能更具体）\n{known or '（还没记过什么）'}"
    )
    user_only = "\n".join(f"- {value}" for value in user_turns[-12:])
    conversation = "\n".join(lines[-36:])
    user = (
        f"# 用户发言摘录\n{user_only}\n\n"
        f"# 全场上下文（辅助判断，不能直接当偏好）\n角色 = {character_name}\n{conversation}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def normalize_reflection(output):
    value = str(output or "").strip()
    if not value or value.upper().startswith("NONE"):
        return ""
    items = [
        line.strip() for line in value.splitlines()
        if line.strip().startswith("- ")
    ]
    return "\n".join(items[:3]) if items else value


def _json_from_model_text(output):
    value = str(output or "").strip()
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        start, end = value.find("{"), value.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(value[start:end + 1])
            except (TypeError, ValueError):
                pass
    return {}


def build_taste_profile_messages(profile_module, preferences):
    schema = {key: ["string"] for key in profile_module.TASTE_PROFILE_FIELDS}
    prompt = (
        "你负责把已经确认的故事复盘整理成稳定、可执行的用户故事档案。\n"
        "只归纳输入中有证据支持的内容，不补写剧情，不推测现实人格，不把临时剧情状态当成偏好。\n"
        "相近内容合并；每个字段最多四项；所有字段都允许为空，证据不足时输出空数组。\n"
        "character_styles=偏爱的角色类型或特质；relationship_dynamics=偏爱的人物关系与互动张力；"
        "story_themes=偏爱的世界、题材与主题；pacing=节奏与推进偏好；"
        "narrative_style=叙事视角、描写与文风；interaction_preferences=用户在故事中的参与和选择方式；"
        "response_adaptations=主理人在推荐、整理和讨论故事时应采用的具体回应方式，"
        "每项写成‘情境 + 回应动作’；重点写主理人怎么回应，不再次罗列用户喜欢的题材或剧情元素；"
        "boundaries=用户明确表达的不希望出现的故事模式。\n"
        "只输出严格 JSON，键必须完整且只能使用以下结构：\n"
        + json.dumps(schema, ensure_ascii=False)
    )
    source = "\n".join(f"- {item}" for item in preferences)
    return [{"role": "system", "content": prompt}, {"role": "user", "content": source}]


def refresh_taste_profile(profile_module, model, state_dir, seed_actor):
    profile = profile_module.ensure_profile(state_dir, seed_actor)
    preferences = profile_module.preference_texts(profile)
    if not preferences:
        empty = {key: [] for key in profile_module.TASTE_PROFILE_FIELDS}
        return profile_module.set_taste_profile(state_dir, seed_actor, empty)
    parsed = _json_from_model_text(model.complete(
        build_taste_profile_messages(profile_module, preferences)))
    if not isinstance(parsed, dict) or any(
            key not in parsed or not isinstance(parsed.get(key), list)
            for key in profile_module.TASTE_PROFILE_FIELDS):
        raise StoryProfileReflectionError(
            "taste profile model output does not match the required schema")
    return profile_module.set_taste_profile(state_dir, seed_actor, parsed)


def reflect_context(
    profile_module,
    model,
    state_dir,
    seed_actor,
    context,
    *,
    write,
):
    world_id = str((context or {}).get("world_id") or "").strip()
    world_name = str((context or {}).get("world_name") or world_id or "未命名世界").strip()
    messages = build_reflection_messages(
        (context or {}).get("card") or {},
        (context or {}).get("story") or [],
        actor_self_text(state_dir, seed_actor),
    )
    if messages is None:
        return {
            "world_id": world_id,
            "world_name": world_name,
            "learned": "",
            "reason": "用户发言少于 2 轮",
            "written": False,
        }
    learned = normalize_reflection(model.complete(messages))
    result = {
        "world_id": world_id,
        "world_name": world_name,
        "learned": learned,
        "reason": "" if learned else "没有足够明确、可长期复用的新偏好",
        "written": False,
    }
    if not write:
        return result
    preferences = profile_module.preference_texts(
        profile_module.ensure_profile(state_dir, seed_actor))
    event = None
    if learned:
        preferences, event = profile_module.record_learning(
            state_dir,
            seed_actor,
            learned,
            f"复盘「{world_name}」",
            source_type="reflection",
        )
    taste_profile = None
    current = profile_module.load_profile(state_dir, seed_actor)
    if current.get("taste_profile_stale"):
        taste_profile = refresh_taste_profile(
            profile_module, model, state_dir, seed_actor)
    return {
        **result,
        "written": bool(event),
        "event": event,
        "preferences": preferences,
        "taste_profile": taste_profile,
    }


def learn_explicit(profile_module, model, state_dir, seed_actor, change, reason=""):
    preferences, event = profile_module.record_learning(
        state_dir, seed_actor, change, reason, source_type="explicit")
    taste_profile = None
    if event:
        taste_profile = refresh_taste_profile(
            profile_module, model, state_dir, seed_actor)
    return {
        "written": bool(event),
        "event": event,
        "preferences": preferences,
        "taste_profile": taste_profile,
    }
