"""actor — 演员运行时：把 loadout 拼成 prompt，调模型，生成入戏回复。

「角色 = 演员 × 剧本」落到拼装层：
  剧本   = 角色卡(card)            —— 导入的、静态
  世界   = 相关世界书条目          —— agent 选，不靠死关键词全量灌
  现场   = 本剧组故事线(story)     —— per 剧组隔离，绝不串别的剧组

actor_self.md 属于故事主理人的档案与推荐记忆，不注入故事正文生成。

LLM client 抄 clawchat-localagent/probe/probe_toolcall.py 的 chat()：纯 stdlib urllib
POST {base}/chat/completions。模型 creds 只在 server 进程的 env，页面永不见。
"""
import hashlib
import html
import json
import os
import re
import time
import urllib.request

import yaml

from story_ledger import (
    story_prefix_signature as _story_prefix_signature,
    story_state_has_memory as _story_state_has_memory,
    validated_story_state as _validated_story_state,
)

def _load_model_base():
    """Resolve the built-in provider endpoint without a service-specific default."""
    base = os.environ.get("TAVERN_MODEL_BASE")
    if base:
        return base.strip().rstrip("/")
    try:
        with open("/opt/data/config.yaml", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        provider = (cfg.get("providers") or {}).get("clawling") or {}
        model = cfg.get("model") or {}
        base = provider.get("api") or model.get("base_url") or ""
        return str(base).strip().rstrip("/")
    except (OSError, yaml.YAMLError, TypeError):
        return ""


# 「内置模型」路径:agent 容器环境里的 provider 配置。
# 用户自配的大模型走 override(state/model_configs.json,server 每回合解析),
# 地址与凭证均从环境或 Hermes 配置解析。
MODEL_BASE = _load_model_base()
MODEL_NAME = os.environ.get("TAVERN_MODEL", "deepseek-v4-flash")
MODEL_TEMP = float(os.environ.get("TAVERN_MODEL_TEMP", "0.85"))
ACTOR_MAX_TOKENS = int(os.environ.get('TAVERN_ACTOR_MAX_TOKENS', '2000'))
MODEL_TIMEOUT = min(300, max(10, int(os.environ.get("TAVERN_MODEL_TIMEOUT", "120"))))
MODEL_MAX_RESPONSE_BYTES = min(
    32 * 1024 * 1024,
    max(256 * 1024, int(os.environ.get("TAVERN_MODEL_MAX_RESPONSE_BYTES", str(8 * 1024 * 1024)))),
)
# 上下文预算(字符):长局只喂最新尾巴+开场,别每回合发整条 story 撞模型上限。
# 世界书扫描深度(往回看几条命中关键词)。
LORE_LOOKBACK = int(os.environ.get("TAVERN_LORE_LOOKBACK", "6"))
# 世界书注入预算(字符):防止大型 lorebook 把角色卡/剧情挤出上下文。
LORE_BUDGET_CHARS = int(os.environ.get("TAVERN_LORE_BUDGET_CHARS", "6000"))
# 递归扫描最多轮数:仅当 worldbook/entry 显式 recursive=true 时启用。
LORE_RECURSIVE_PASSES = int(os.environ.get("TAVERN_LORE_RECURSIVE_PASSES", "2"))

# 日志文件
_LOG_PATH = os.environ.get("TAVERN_LOG", "/tmp/tavern.log")


def _log(**kw):
    """追加一行 JSON 日志到日志文件。不抛异常。"""
    try:
        kw["ts"] = time.time()
        with open(_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(kw, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _load_key():
    """Resolve the built-in model key without depending on HOME inference."""
    k = os.environ.get("TAVERN_MODEL_KEY") or os.environ.get("DEEPSEEK_API_KEY")
    if k:
        return k
    try:
        with open("/opt/data/config.yaml", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        provider = (cfg.get("providers") or {}).get("clawling") or {}
        model = cfg.get("model") or {}
        k = provider.get("api_key") or model.get("api_key") or ""
        if k:
            return str(k).strip()
    except (OSError, yaml.YAMLError, TypeError):
        pass
    env_paths = ["/opt/data/.hermes-tavern/.env"]
    expanded = os.path.expanduser("~/.hermes-tavern/.env")
    if expanded not in env_paths:
        env_paths.append(expanded)
    for envp in env_paths:
        try:
            with open(envp, encoding="utf-8") as f:
                for line in f:
                    name, sep, value = line.strip().partition("=")
                    if sep and name in ("TAVERN_MODEL_KEY", "DEEPSEEK_API_KEY") and value:
                        return value.strip().strip('"').strip("'")
        except OSError:
            pass
    return ""


MODEL_KEY = _load_key()


def _entry_list(e: dict, *names) -> list:
    for name in names:
        vals = e.get(name)
        if vals:
            if isinstance(vals, str):
                return [vals]
            return [str(v) for v in vals if str(v).strip()]
    return []


def _entry_content(e: dict) -> str:
    return str(e.get("content") or e.get("comment") or "").strip()


def _match_any(keys: list, text: str, case_sensitive: bool = False) -> bool:
    if not keys:
        return False
    hay = text if case_sensitive else text.lower()
    for k in keys:
        key = str(k or "").strip()
        if not key:
            continue
        needle = key if case_sensitive else key.lower()
        if needle in hay:
            return True
    return False


def _entry_probability_allows(e: dict, seed_text: str) -> bool:
    raw = e.get("probability", e.get("probability_percent"))
    if raw in (None, ""):
        return True
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return True
    chance = val / 100.0 if val > 1 else val
    if chance >= 1:
        return True
    if chance <= 0:
        return False
    basis = (_entry_content(e)[:80] + "|" + seed_text[-500:]).encode("utf-8", "ignore")
    roll = int(hashlib.sha1(basis).hexdigest()[:8], 16) / 0xFFFFFFFF
    return roll <= chance


def _lore_extra_text(story_state=None, turn_plan=None) -> str:
    parts = []

    def add_obj(obj):
        if isinstance(obj, dict):
            for v in obj.values():
                add_obj(v)
        elif isinstance(obj, list):
            for v in obj:
                add_obj(v)
        elif obj is not None:
            x = str(obj).strip()
            if x:
                parts.append(x)

    if isinstance(story_state, dict):
        add_obj({key: story_state.get(key) for key in
                 ("timeline", "facts", "open_threads", "objects", "secrets", "scene", "style_notes")})
    add_obj(turn_plan)
    return " ".join(parts)


def select_lore(worldbooks: list, story: list, lookback: int = None, extra_text: str = "") -> list:
    """选相关世界书条目。

    支持经典酒馆常见字段的轻量子集：constant、keys、secondary_keys/selective、
    exclusion_keys、probability、priority、insertion_order、position、递归触发和注入预算。
    前端不暴露复杂开关，主理人在后台完成知识调度。
    """
    lookback = LORE_LOOKBACK if lookback is None else lookback
    base_recent = " ".join((m.get("text") or "") for m in story[-lookback:])
    scan_text = (base_recent + " " + (extra_text or "")).strip()
    picked, seen = [], set()
    passes = max(1, LORE_RECURSIVE_PASSES)
    budget = max(0, LORE_BUDGET_CHARS)
    used = 0

    def entry_key(wb, e):
        return (wb.get("id"), e.get("uid") or e.get("id") or _entry_content(e)[:80])

    for pass_idx in range(passes):
        changed = False
        candidates = []
        for wb in worldbooks:
            wb_recursive = bool(wb.get("recursive"))
            for e in wb.get("entries", []):
                if not e.get("enabled", True):
                    continue
                content = _entry_content(e)
                if not content:
                    continue
                key = entry_key(wb, e)
                if key in seen:
                    continue
                case_sensitive = bool(e.get("case_sensitive") or e.get("caseSensitive"))
                excludes = _entry_list(e, "exclusion_keys", "exclude_keys", "exclude", "exclusions")
                if _match_any(excludes, scan_text, case_sensitive):
                    continue
                primary_keys = _entry_list(e, "keys", "key")
                primary = bool(e.get("constant")) or _match_any(primary_keys, scan_text, case_sensitive)
                if not primary:
                    continue
                secondary = _entry_list(e, "secondary_keys", "secondaryKeys", "secondary")
                if e.get("selective") and secondary and not _match_any(secondary, scan_text, case_sensitive):
                    continue
                if pass_idx > 0 and not (wb_recursive or e.get("recursive")):
                    continue
                if not _entry_probability_allows(e, scan_text):
                    continue
                candidates.append((wb, e))

        candidates.sort(key=lambda pair: (
            -float(pair[1].get("priority", pair[1].get("order_priority", 0)) or 0),
            int(pair[1].get("insertion_order", pair[1].get("order", 100)) or 100),
        ))

        for wb, e in candidates:
            content = _entry_content(e)
            if budget and used + len(content) > budget and picked:
                continue
            picked.append(e)
            seen.add(entry_key(wb, e))
            used += len(content)
            if wb.get("recursive") or e.get("recursive"):
                scan_text += " " + content
                changed = True
        if not changed:
            break
    return picked


def _fit_history(story: list, covered_turns: int = 0) -> list:
    """Return raw story messages to inject into the model context.

    A valid story-state ledger replaces every raw message through its covered
    user turn. Every complete message after that turn remains verbatim. Without
    a valid ledger, retain the complete story until a 15-turn batch is committed.
    Context replacement is governed only by covered user turns, never by text
    length or estimated token offsets.
    """
    covered_turns = int(covered_turns or 0)
    if covered_turns <= 0:
        return list(story or [])

    kept = []
    seen_turns = 0
    for message in story or []:
        if message.get("role") == "user":
            seen_turns += 1
        if seen_turns > covered_turns:
            kept.append(message)
    return kept


def _language_code(value: str = "zh") -> str:
    return "zh" if str(value or "").lower().startswith("zh") else "en"


def _content_language(text: str):
    text = str(text or "")
    cjk = len(re.findall(r"[\u3400-\u9fff]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    total = cjk + latin
    if total < 12:
        return None
    ratio = cjk / total
    if cjk >= 8 and ratio >= 0.28:
        return "zh"
    if latin >= 24 and ratio <= 0.08:
        return "en"
    return None


def format_rules_en() -> str:
    return (
        "- Write the entire response in English. Preserve proper nouns and explicitly quoted foreign text, but do not switch the narration language.\n"
        "- Treat history as story facts only, never as a formatting or language example.\n"
        "- Wrap paragraphs containing only narration, action, expression, or environment in *...*. If a paragraph contains dialogue or quotation marks, do not wrap that paragraph in asterisks.\n"
        "- Write dialogue inside 「...」. For multiple speakers, use Character Name: 「Dialogue.」\n"
        "- Use complete English punctuation and normal sentence boundaries. Every sentence must be punctuated; never produce a long unpunctuated passage.\n"
        "- Correct example: *Evelyn raised the lamp. Its light reached the sealed door.*\n"
        "- Incorrect example: *Evelyn raised the lamp its light reached the sealed door*\n"
        "- An action and the dialogue that immediately follows it may share one paragraph. Start a new paragraph only after a complete unit of meaning; do not split every sentence onto a separate line.\n"
        "- Output only the current story text. Do not add explanations, summaries, headings, options, or system notes. Do not output Markdown bold markers (**).\n"
        "- Write exactly one story reply. Do not decide what the user says or does. Write at least one and at most four complete paragraphs, with concrete action, emotion, and environmental detail. Keep the pacing varied and leave room for the user to respond."
    )


def format_rules_zh() -> str:
    return (
        "- 全部回复使用简体中文。保留专有名词和明确引用的外语原文，但不要切换叙述语言。\n"
        "- 历史只作为剧情事实，不作为本轮格式或语言范例。\n"
        "- 纯旁白、动作、神态、环境段落用 *...*；只要段落里有对白或引号，整段不要加星号。\n"
        "- 对白使用「...」；多角色对白写成 角色名：「...」。\n"
        "- 使用完整中文标点：句末使用句号（。），停顿使用逗号（，），问句使用问号（？）。每个完整句子都必须正常断句，不得输出无标点长段。\n"
        "- 正确示例：*光线涌入瞳孔，整个世界都被镀上一层金色。父亲的脸逆着光，下巴的线条坚硬而清晰。*\n"
        "- 错误示例：*光线涌入瞳孔整个世界都被镀上一层金色父亲的脸逆着光下巴的线条坚硬而清晰*\n"
        "- 同一个动作与紧接的对白可以放在同一段；一个完整语义段结束后再换行，不要把每句话都拆成新行。\n"
        "- 只写当前故事正文，不写解释、总结、标题、选项或系统说明；不要输出 Markdown 粗体符号 **。\n"
        "- 只写当前故事的一条回复。不要决定用户说什么或做什么。至少写一段，最多四个完整段落。描写要具体、沉浸，提供登场角色的动作、情绪和环境细节，节奏有变化，并为用户留下回应空间。"
    )


def format_rules(response_language: str = "zh") -> str:
    """Route to one independent language prompt; unsupported locales use English."""
    return format_rules_zh() if _language_code(response_language) == "zh" else format_rules_en()


def user_input_format_rules_en() -> str:
    return (
        "- Write each suggestion entirely in English with complete English punctuation.\n"
        "- Wrap pure user action, expression, or narration paragraphs in *...*.\n"
        "- Write user dialogue inside 「...」 and do not wrap dialogue paragraphs in asterisks.\n"
        "- Each suggestion must be a complete message the user can send directly."
    )


def user_input_format_rules_zh() -> str:
    return (
        "- 每条建议全部使用简体中文，并使用完整中文标点。\n"
        "- 用户的纯动作、神态或旁白段落用 *...*。\n"
        "- 用户对白使用「...」，含对白的段落不要加星号。\n"
        "- 每条建议必须是用户可以直接发送的完整消息。"
    )


def user_input_format_rules(response_language: str = "zh") -> str:
    return (user_input_format_rules_zh() if _language_code(response_language) == "zh"
            else user_input_format_rules_en())



def _as_cards(card_or_cards) -> list:
    if isinstance(card_or_cards, list):
        return [c for c in card_or_cards if isinstance(c, dict)]
    return [card_or_cards] if isinstance(card_or_cards, dict) else []


def _role_blocks(cards: list, response_language: str = "zh") -> str:
    en = _language_code(response_language) == "en"
    blocks = []
    for i, c in enumerate(cards, 1):
        profile = c.get("profile") if isinstance(c.get("profile"), dict) else {}
        identity = profile.get("identity") if isinstance(profile.get("identity"), dict) else {}
        appearance = profile.get("appearance") if isinstance(profile.get("appearance"), dict) else {}
        personality = profile.get("personality") if isinstance(profile.get("personality"), dict) else {}
        expression = profile.get("expression") if isinstance(profile.get("expression"), dict) else {}
        capabilities = profile.get("capabilities") if isinstance(profile.get("capabilities"), dict) else {}
        background = profile.get("background") if isinstance(profile.get("background"), dict) else {}
        entry = c.get("entry") if isinstance(c.get("entry"), dict) else {}
        performance = c.get("performance") if isinstance(c.get("performance"), dict) else {}
        persistent = c.get("persistent_status") if isinstance(c.get("persistent_status"), dict) else {}

        def values(raw):
            vals = raw if isinstance(raw, list) else ([raw] if raw else [])
            return [str(value).strip() for value in vals if str(value).strip()]

        def line(label, raw):
            vals = values(raw)
            safe_values = [html.escape(value, quote=False) for value in vals]
            return (f"- {label}: " if en else f"- {label}：") + "; ".join(safe_values) if vals else ""

        def section(tag, rows):
            rows = [row for row in rows if row]
            return (f"\n<{tag}>\n" + "\n".join(rows) + f"\n</{tag}>") if rows else ""

        sysprompt_value = performance.get("system_prompt") or c.get("system_prompt", "")
        example_value = entry.get("example_dialogue") or c.get("mes_example", "")
        sysprompt = section("character_instructions", [html.escape(str(sysprompt_value), quote=False)]) if sysprompt_value else ""
        example = section("dialogue_examples", [html.escape(str(example_value), quote=False)]) if example_value else ""
        identity_txt = section("identity", [
            line("Name" if en else "姓名", identity.get("name") or c.get("name")),
            line("Aliases" if en else "别名", identity.get("aliases")),
            line("Description" if en else "人物简介", identity.get("description") or c.get("description")),
            line("Gender" if en else "性别", identity.get("gender")),
            line("Age" if en else "年龄", identity.get("age")),
            line("Species" if en else "种族", identity.get("species")),
            line("Occupation" if en else "职业身份", identity.get("occupation")),
            line("Affiliations" if en else "所属组织", identity.get("affiliations")),
            line("Story role" if en else "故事定位", identity.get("story_role")),
        ])
        traits = values(personality.get("traits"))
        personality_txt = section("personality", [
            line("Summary" if en else "概述", (personality.get("summary") or c.get("personality")) if not traits else ""),
            line("Traits" if en else "特质", personality.get("traits")),
            line("Values" if en else "价值观", personality.get("values")),
            line("Core goal" if en else "核心目标", personality.get("motivation")),
            line("Fears" if en else "恐惧", personality.get("fears")),
            line("Boundaries" if en else "底线", personality.get("boundaries")),
        ])
        appearance_txt = section("appearance", [
            line("Summary" if en else "概述", appearance.get("summary")),
            line("Features" if en else "特征", appearance.get("features")),
            line("Attire" if en else "着装", appearance.get("attire")),
        ])
        expression_txt = section("expression", [
            line("Speech style" if en else "说话方式", expression.get("speech_style")),
            line("Habits" if en else "习惯", expression.get("habits")),
            line("Mannerisms" if en else "动作特征", expression.get("mannerisms")),
        ])
        capability_txt = section("capabilities", [
            line("Skills" if en else "技能", capabilities.get("skills")),
            line("Powers" if en else "特殊能力", capabilities.get("powers")),
            line("Limitations" if en else "限制", capabilities.get("limitations")),
        ])
        background_txt = section("background", [
            line("Summary" if en else "经历概述", background.get("summary")),
            line("Key history" if en else "关键经历", background.get("key_history")),
        ])
        persistent_txt = section("current_status", [
            line("Life status" if en else "生命状态", persistent.get("life_status")),
            line("Physical condition" if en else "身体状况", persistent.get("physical_condition")),
        ])
        cid = html.escape(str(c.get("id") or ""), quote=True)
        cname = html.escape(str(c.get("name") or identity.get("name") or ""), quote=True)
        content = (identity_txt + appearance_txt + personality_txt + expression_txt +
                   capability_txt + background_txt + persistent_txt + sysprompt + example).strip()
        blocks.append(f'<character id="{cid}" name="{cname}">\n{content}\n</character>')
    return "\n\n".join(blocks)


def user_character_block(persona: dict, response_language: str = "zh") -> str:
    """Render the user character as structured context without performance cues."""
    if not isinstance(persona, dict) or not (persona.get("name") or persona.get("profile")):
        return ""
    en = _language_code(response_language) == "en"
    profile = persona.get("profile") if isinstance(persona.get("profile"), dict) else {}
    identity = profile.get("identity") if isinstance(profile.get("identity"), dict) else {}
    appearance = profile.get("appearance") if isinstance(profile.get("appearance"), dict) else {}
    personality = profile.get("personality") if isinstance(profile.get("personality"), dict) else {}
    capabilities = profile.get("capabilities") if isinstance(profile.get("capabilities"), dict) else {}
    background = profile.get("background") if isinstance(profile.get("background"), dict) else {}
    status = persona.get("persistent_status") if isinstance(persona.get("persistent_status"), dict) else {}

    def values(raw):
        vals = raw if isinstance(raw, list) else ([raw] if raw else [])
        return [str(value).strip() for value in vals if str(value).strip()]

    def line(label, raw):
        vals = values(raw)
        return (f"- {label}: " if en else f"- {label}：") + "; ".join(
            html.escape(value, quote=False) for value in vals) if vals else ""

    def section(tag, rows):
        rows = [row for row in rows if row]
        return (f"<{tag}>\n" + "\n".join(rows) + f"\n</{tag}>") if rows else ""

    traits = values(personality.get("traits"))
    sections = [
        section("identity", [
            line("Name" if en else "姓名", identity.get("name") or persona.get("name")),
            line("Aliases" if en else "别名", identity.get("aliases")),
            line("Description" if en else "人物简介", identity.get("description") or persona.get("description")),
            line("Gender" if en else "性别", identity.get("gender")),
            line("Age" if en else "年龄", identity.get("age")),
            line("Species" if en else "种族", identity.get("species")),
            line("Occupation" if en else "职业身份", identity.get("occupation")),
            line("Affiliations" if en else "所属组织", identity.get("affiliations")),
            line("Story role" if en else "故事定位", identity.get("story_role")),
        ]),
        section("appearance", [
            line("Summary" if en else "概述", appearance.get("summary")),
            line("Features" if en else "特征", appearance.get("features")),
            line("Attire" if en else "着装", appearance.get("attire")),
        ]),
        section("personality", [
            line("Summary" if en else "概述", personality.get("summary") if not traits else ""),
            line("Traits" if en else "特质", personality.get("traits")),
            line("Values" if en else "价值观", personality.get("values")),
            line("Core goal" if en else "核心目标", personality.get("motivation")),
            line("Fears" if en else "恐惧", personality.get("fears")),
            line("Boundaries" if en else "底线", personality.get("boundaries")),
        ]),
        section("capabilities", [
            line("Skills" if en else "技能", capabilities.get("skills")),
            line("Powers" if en else "特殊能力", capabilities.get("powers")),
            line("Limitations" if en else "限制", capabilities.get("limitations")),
        ]),
        section("background", [
            line("Summary" if en else "经历概述", background.get("summary")),
            line("Key history" if en else "关键经历", background.get("key_history")),
        ]),
        section("current_status", [
            line("Life status" if en else "生命状态", status.get("life_status")),
            line("Physical condition" if en else "身体状况", status.get("physical_condition")),
        ]),
    ]
    return "\n".join(section_text for section_text in sections if section_text)


def _relationships_block(cards: list, response_language: str = "zh") -> str:
    """Render each canonical relationship edge once for the whole request."""
    en = _language_code(response_language) == "en"
    seen = set()
    rows = []
    for card in cards:
        source_id = str(card.get("id") or "")
        source_name = html.escape(str(card.get("name") or ("Character" if en else "角色")), quote=False)
        details = card.get("relationship_details") if isinstance(card.get("relationship_details"), list) else []
        for relation in details:
            if not isinstance(relation, dict):
                continue
            target_id = str(relation.get("target_id") or "")
            relation_id = str(relation.get("id") or "")
            edge_key = relation_id or "|".join(sorted((source_id, target_id)))
            if not edge_key or edge_key in seen:
                continue
            seen.add(edge_key)
            target_name = html.escape(str(relation.get("target_name") or target_id or ("User" if en else "用户")), quote=False)
            description = str(relation.get("description") or relation.get("type") or "").strip()
            legacy_attitude = str(relation.get("attitude") or "").strip()
            if legacy_attitude and legacy_attitude not in description:
                description += (", " if en else "，") + legacy_attitude
            if description:
                rows.append(f"- {source_name} ↔ {target_name}：" + html.escape(description, quote=False))
    return "\n".join(rows)

def _story_state_block(story_state: dict, response_language: str = "zh") -> str:
    if not isinstance(story_state, dict):
        return ""
    en = _language_code(response_language) == "en"
    parts = []

    def simple(title, key):
        vals = [str(x).strip() for x in (story_state.get(key) or []) if str(x).strip()]
        if vals:
            parts.append(title + "：\n" + "\n".join("- " + v for v in vals))

    simple("Timeline" if en else "时间线", "timeline")
    facts = []
    for item in story_state.get("facts") or []:
        raw = item if isinstance(item, dict) else {"content": item}
        content = str(raw.get("content") or "").strip()
        known = [str(x).strip() for x in raw.get("known_by") or [] if str(x).strip()]
        if content:
            facts.append(content + ((" [known by: " if en else "〔知情者：") + "、".join(known) + (']' if en else '〕') if known else ""))
    if facts:
        parts.append(("Established facts" if en else "已发生事实") + "：\n" + "\n".join("- " + x for x in facts))
    simple("Open threads" if en else "未解决线索", "open_threads")
    objects = []
    for item in story_state.get("objects") or []:
        raw = item if isinstance(item, dict) else {"name": item}
        name = str(raw.get("name") or "").strip()
        details = [str(raw.get(key) or "").strip() for key in ("status", "holder", "location")]
        details = [x for x in details if x]
        if name:
            objects.append(name + ("（" + "；".join(details) + "）" if details else ""))
    if objects:
        parts.append(("Important objects" if en else "关键物品") + "：\n" + "\n".join("- " + x for x in objects))
    secrets = []
    for item in story_state.get("secrets") or []:
        raw = item if isinstance(item, dict) else {"content": item}
        content = str(raw.get("content") or "").strip()
        known = [str(x).strip() for x in raw.get("known_by") or [] if str(x).strip()]
        if content:
            secrets.append(content + ((" [known by: " if en else "〔知情者：") + "、".join(known) + (']' if en else '〕') if known else ""))
    if secrets:
        parts.append(("Secrets" if en else "秘密信息") + "：\n" + "\n".join("- " + x for x in secrets))
    scene = story_state.get("scene") if isinstance(story_state.get("scene"), dict) else {}
    scene_rows = []
    if scene.get("time"):
        scene_rows.append(("Time: " if en else "时间：") + str(scene["time"]))
    if scene.get("place"):
        scene_rows.append(("Place: " if en else "地点：") + str(scene["place"]))
    for participant in scene.get("participants") or []:
        if not isinstance(participant, dict):
            continue
        details = [str(participant.get(key) or "").strip() for key in ("location", "activity", "condition")]
        details = [x for x in details if x]
        if participant.get("character_id"):
            scene_rows.append(str(participant["character_id"]) + ("：" + "；".join(details) if details else ""))
    if scene_rows:
        parts.append(("Checkpoint scene" if en else "阶段场景") + "：\n" + "\n".join("- " + x for x in scene_rows))
    simple("Style continuity" if en else "风格延续", "style_notes")

    if not parts:
        return ""
    turns = story_state.get("turns")
    suffix = (f" (through turn {turns})" if en else f"（整理到第 {turns} 轮）") if turns else ""
    return ("## Story state" if en else "## 故事状态") + suffix + "\n" + "\n\n".join(parts)


def _turn_plan_block(turn_plan: dict, response_language: str = "zh") -> str:
    if not isinstance(turn_plan, dict) or not turn_plan:
        return ""
    en = _language_code(response_language) == "en"

    def val(key):
        v = turn_plan.get(key)
        if isinstance(v, list):
            return "、".join(str(x).strip() for x in v if str(x).strip())
        return str(v or "").strip()

    rows = []
    labels = (("Primary speaker", "primary_speaker"), ("Supporting characters", "supporting_characters"), ("Silent / offstage", "silent_characters"), ("Narration goal", "narration_goal"), ("Avoid", "do_not")) if en else (("本轮主要回应", "primary_speaker"), ("辅助出场", "supporting_characters"), ("保持沉默/不出场", "silent_characters"), ("旁白目标", "narration_goal"), ("不要做", "do_not"))
    for title, key in labels:
        v = val(key)
        if v:
            rows.append(f"- {title}：{v}")
    return ("## Turn plan\n" if en else "## 本轮调度\n") + "\n".join(rows) if rows else ""


def _multi_character_rules_en(names: str) -> str:
    return (
        f"\n- This is a multi-character world with: {names}. Schedule characters according to the scene; not everyone must speak in every reply."
        "\n- Identify each speaker as Character Name: 「Dialogue.」 and make narrated actions belong to a clear character."
        "\n- Preserve each character's distinct voice, motives, and knowledge boundaries."
    )


def _multi_character_rules_zh(names: str) -> str:
    return (
        f"\n- 这是一个多角色世界，登场角色包括：{names}。你可以根据场景调度他们，不要求每轮所有人都说话。"
        "\n- 多角色发言时标明说话人，格式如：角色名：「对白」。叙述动作时也尽量让动作归属于明确角色。"
        "\n- 保持每个角色独立的语气、动机和信息边界，不要把所有角色写成同一种声音。"
    )


def _system_prompt_en(roles_txt: str, relationships_txt: str, lore_txt: str, persona_txt: str,
                      story_state_txt: str,
                      turn_plan_txt: str, multi_rule: str) -> str:
    return f"""# Task
Write the next response by the active character or characters to the user's latest action in this fictional story.

Use the character profiles, world lore, story state, turn plan, and conversation history below. Continue the story directly.
Character profiles own identity, personality, abilities, and current status. The user character is context only: never write the user's actions, speech, thoughts, feelings, or decisions. The relationship graph is the sole source of character relationships. Story state and the raw conversation that follows it own locations, activities, knowledge boundaries, and object custody; newer raw conversation takes precedence.

<characters>
{roles_txt}
</characters>

<relationship_graph>
{relationships_txt or '(None)'}
</relationship_graph>

<world_lore>
{html.escape(lore_txt or '(None)', quote=False)}
</world_lore>

<user_character>
{persona_txt or '(None)'}
</user_character>

<story_state>
{html.escape(story_state_txt or '(None)', quote=False)}
</story_state>

<turn_plan>
{html.escape(turn_plan_txt or '(None)', quote=False)}
</turn_plan>

## Output policy
{format_rules_en()}{multi_rule}
- Complete the response from the user's latest message and leave a natural opening for the next interaction.
- Give characters physical presence through gesture, breath, objects in hand, sound, and light.
- Express emotion through concrete detail rather than direct explanation.
"""


def _system_prompt_zh(roles_txt: str, relationships_txt: str, lore_txt: str, persona_txt: str,
                      story_state_txt: str,
                      turn_plan_txt: str, multi_rule: str) -> str:
    return f"""# 任务
写出当前登场角色在这场虚构故事中对用户最后行动的下一段回应。

你会收到：
- 登场角色资料
- 世界设定
- 故事状态
- 本轮调度
- 历史对话

输出当前故事的下一段内容。
角色档案只决定身份、性格、能力与当前状态；用户角色资料只作为上下文，不得替用户书写行动、对白、想法、感受或决定；人物关系图是角色关系的唯一来源；故事状态与其后的原始对话决定位置、行动、认知边界与物品归属，较新的原始对话优先。

<characters>
{roles_txt}
</characters>

<relationship_graph>
{relationships_txt or '（无）'}
</relationship_graph>

<world_lore>
{html.escape(lore_txt or '（无）', quote=False)}
</world_lore>

<user_character>
{persona_txt or '（无）'}
</user_character>

<story_state>
{html.escape(story_state_txt or '（无）', quote=False)}
</story_state>

<turn_plan>
{html.escape(turn_plan_txt or '（无）', quote=False)}
</turn_plan>

## 输出规范
{format_rules_zh()}{multi_rule}
- 段落应完整，承接用户最后一句，并自然留下可继续回应的空间。
- 给角色一个身体：手里在做什么、呼吸、环境的声音光线。
- 情绪藏细节，不直接喊。
"""


def build_messages(card: dict, lore: list, persona: dict, story: list,
                   note: str = "", story_state: dict = None,
                   turn_plan: dict = None, response_language: str = "zh") -> list:
    """组成 chat-completion 消息序列。card 可为单角色 dict，也可为多角色 list。"""
    lang = _language_code(response_language)
    en = lang == "en"
    cards = _as_cards(card)
    primary = cards[0] if cards else {}
    lore_top = [e for e in lore if (e.get("position") or "") == "before_char"]
    lore_near = [e for e in lore if (e.get("position") or "") != "before_char"]
    lore_top_txt = "\n".join("- " + (e.get("content") or "") for e in lore_top)
    persona_txt = user_character_block(persona, lang)

    roles_txt = _role_blocks(cards, lang) or ("(No active characters configured)" if en else "（未设置登场角色）")
    relationships_txt = _relationships_block(cards, lang)
    effective_story_state = _validated_story_state(story_state, story)
    story_state_txt = _story_state_block(effective_story_state or {}, lang)
    turn_plan_txt = _turn_plan_block(turn_plan or {}, lang)
    multi_rule = ""
    if len(cards) > 1:
        names = (", " if en else "、").join(c.get("name", "Character" if en else "角色") for c in cards)
        multi_rule = (_multi_character_rules_en(names) if en
                      else _multi_character_rules_zh(names))

    sys = (_system_prompt_en(roles_txt, relationships_txt, lore_top_txt, persona_txt,
                             story_state_txt, turn_plan_txt, multi_rule) if en else
           _system_prompt_zh(roles_txt, relationships_txt, lore_top_txt, persona_txt,
                             story_state_txt, turn_plan_txt, multi_rule))
    msgs = [{"role": "system", "content": sys}]
    covered_turns = int((effective_story_state or {}).get("turns") or 0)
    for m in _fit_history(story, covered_turns=covered_turns):
        role = m.get("role")
        text = m.get("text") or ""
        if role == "user":
            msgs.append({"role": "user", "content": text})
        else:
            # A wrong-language model reply must not become the style example for
            # every later turn. Scene state / story state preserve its facts.
            historical_language = _content_language(text)
            if historical_language and historical_language != lang:
                continue
            msgs.append({"role": "assistant", "content": text})
    if lore_near:
        near_txt = "\n".join("- " + (e.get("content") or "") for e in lore_near)
        msgs.append({"role": "system",
                     "content": (("### Relevant world lore for this moment (integrate naturally; do not list it)\n" if en else "### 此刻相关的世界设定（自然融入，别罗列）\n") + near_txt)})
    if note:
        msgs.append({"role": "system", "content": ("[Director note for this turn] " if en else "〔导演提示，本回合照此调整〕") + note})
    primary_performance = primary.get("performance") if isinstance(primary.get("performance"), dict) else {}
    post = primary_performance.get("post_history_instructions") or primary.get("post_history_instructions")
    final_parts = []
    if post:
        final_parts.append(post)
    no_repeat = "- Do not repeat this contract." if en else "- 不复述本契约。"
    final_parts.append(f"""<output_contract priority="highest" response_language="{lang}">
{format_rules(lang)}
{no_repeat}
</output_contract>""")
    final_contract = ("### Generation contract for this turn\n" if en else "### 本轮生成契约\n") + "\n\n".join(final_parts)
    # Some OpenAI-compatible models do not treat a trailing system message as higher
    # priority. Attach the per-turn contract to the latest user message so it is the
    # last instruction the model sees, without saving it back into story history.
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i].get("role") == "user":
            msgs[i]["content"] = msgs[i].get("content", "") + "\n\n" + final_contract
            break
    else:
        msgs.append({"role": "system", "content": final_contract})
    return msgs

def _payload(messages: list, temperature: float, stream: bool,
             model_name: str = None, max_tokens: int = None) -> dict:
    p = {
        "model": model_name or MODEL_NAME,
        "messages": messages,
        "stream": stream,
        "temperature": MODEL_TEMP if temperature is None else temperature,
    }
    if max_tokens:
        p["max_tokens"] = max_tokens
    return p


def _request(payload: dict, base: str = None, key: str = None) -> urllib.request.Request:
    key = MODEL_KEY if key is None else key
    if not key:
        raise RuntimeError("缺模型 key：设 TAVERN_MODEL_KEY 或 DEEPSEEK_API_KEY")
    endpoint = str(base or MODEL_BASE or "").strip().rstrip("/")
    if not endpoint:
        raise RuntimeError("缺模型服务地址：配置 TAVERN_MODEL_BASE 或 Hermes provider base_url")
    return urllib.request.Request(
        endpoint + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
        },
        method="POST",
    )


def _read_json_response(response, limit=MODEL_MAX_RESPONSE_BYTES):
    raw = response.read(limit + 1)
    if len(raw) > limit:
        raise RuntimeError(f"模型响应超过大小限制（{limit} bytes）。")
    return json.loads(raw)


def _chat_once(messages: list, temperature: float = None, model: dict = None,
               max_tokens: int = None) -> str:
    ov = model or {}
    model_name = ov.get("model") or MODEL_NAME
    prompt_chars = sum(len((m.get("content") or "")) for m in messages)
    t0 = time.time()
    _log(event="chat_start", model=model_name, msgs=len(messages), prompt_chars=prompt_chars, temp=temperature)
    try:
        req = _request(_payload(messages, temperature, False, model_name, max_tokens=max_tokens),
                       ov.get("base"), ov.get("key"))
        with urllib.request.urlopen(req, timeout=MODEL_TIMEOUT) as r:
            data = _read_json_response(r)
        elapsed = round(time.time() - t0, 2)
    except Exception as e:
        elapsed = round(time.time() - t0, 2)
        _log(event="chat_error", model=model_name, elapsed=elapsed, error=repr(e))
        raise
    choice = (data.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content = (msg.get("content") or "").strip()
    reasoning = msg.get("reasoning_content") or ""
    finish = choice.get("finish_reason") or choice.get("finishReason")
    usage = data.get("usage") or {}
    _log(event="chat_done", model=model_name, elapsed=elapsed, msgs=len(messages),
         prompt_chars=prompt_chars, finish=finish, out_chars=len(content),
         reasoning_chars=len(reasoning), usage=usage)
    print("actor response",
          "model=%s" % model_name,
          "finish=%s" % finish,
          "chars=%s" % len(content),
          "usage=%s" % usage,
          flush=True)
    if finish in ("length", "max_tokens"):
        raise RuntimeError("模型输出达到长度上限，已拒绝保存不完整回复。请重试或切换更稳定的模型。")
    return content


def chat(messages: list, temperature: float = None, model: dict = None, max_tokens: int = None) -> str:
    """调模型，返回回复文本（非流式）。model = 用户自配 override；None = 内置模型。"""
    return _chat_once(messages, temperature, model, max_tokens=max_tokens)



def perform(card: dict, worldbooks: list, persona: dict, story: list,
            note: str = "", model: dict = None, story_state: dict = None,
            turn_plan: dict = None,
            response_language: str = "zh") -> str:
    """一回合演出：选世界书 → 拼 prompt → 生成。model = 用户自配 override（None=内置模型）。"""
    lore = select_lore(worldbooks, story, extra_text=_lore_extra_text(story_state, turn_plan))
    msgs = build_messages(card, lore, persona, story, note, story_state=story_state,
                          turn_plan=turn_plan,
                          response_language=response_language)
    return chat(msgs, model=model, max_tokens=ACTOR_MAX_TOKENS)


def ping(model: dict = None) -> int:
    """极小请求实测一份配置通不通（add 落盘前的验证）。返回耗时 ms，失败抛异常。"""
    t0 = time.time()
    ov = model or {}
    payload = _payload([{"role": "user", "content": "hi"}], 1.0, False,
                       ov.get("model"), max_tokens=8)
    with urllib.request.urlopen(_request(payload, ov.get("base"), ov.get("key")), timeout=20) as r:
        _read_json_response(r, min(MODEL_MAX_RESPONSE_BYTES, 512 * 1024))
    return int((time.time() - t0) * 1000)


def reflect_on_play(card: dict, story: list, actor_self: str, model: dict = None) -> str:
    """复盘一场戏，蒸馏出「关于用户（对手戏的人类玩家）的 RP 偏好」，供写进技艺层。

    只学用户的长期口味/节奏/雷区/互动方式；不复述剧情、不记世界状态。
    返回 1-3 条一句话偏好；看不出明显偏好则返回 ""。
    """
    cname = card.get("name", "角色")
    lines = []
    user_turns = []
    for m in story:
        text = (m.get("text") or "").strip()
        if not text:
            continue
        who = "用户" if m.get("role") == "user" else cname
        clipped = text[:500]
        lines.append(f"{who}：{clipped}")
        if m.get("role") == "user":
            user_turns.append(clipped)
    convo = "\n".join(lines[-36:])
    user_only = "\n".join(f"- {x}" for x in user_turns[-12:]) or "（用户发言太少）"
    idx = actor_self.find("我对你的了解")
    known = actor_self[idx:] if idx != -1 else ""
    sys = (
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
    user = f"# 用户发言摘录\n{user_only}\n\n# 全场上下文（辅助判断，不能直接当偏好）\n角色 = {cname}\n{convo}"
    out = chat(
        [{"role": "system", "content": sys}, {"role": "user", "content": user}],
        temperature=0.2, model=model,
    ).strip()
    if out.upper().startswith("NONE") or len(out) < 4:
        return ""
    items = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("- ")]
    return "\n".join(items[:3]) if items else out

def merge_knows(existing: list, addition: str) -> list:
    """把新学到的（addition）并进「对用户的了解」现有清单，产出合并、去重、有界的新清单。

    「越演越懂你」的 consolidation 引擎（Q_B）：不是尾部堆流水账，而是维护一份**活的、精炼**
    的偏好档——新信息更具体就替换旧的笼统条、矛盾以新为准、控制在 ~12 条。
    这份档供故事主理人推荐与复盘，也展示在故事档案中，不注入故事正文生成。
    返回 list[str]；addition 空则原样返回。
    """
    if not (addition or "").strip():
        return list(existing)
    cur = "\n".join("- " + e for e in existing) if existing else "（还没记过什么）"
    sys = (
        "你在维护故事主理人的『对用户的了解』档——一份简短、精炼、不重复的偏好清单，"
        "用于推荐世界、角色与复盘。给你【现有清单】和【新学到的】，产出【合并后的清单】：\n"
        "- 合并同类、去重；新信息更具体就替换旧的笼统条；矛盾以新的为准。\n"
        "- **一条只讲一个维度**（节奏 / 浓淡 / 雷区 / 幽默 / 题材 / 演法…）；"
        "两个不同维度**分成两条**，别为了省行数塞进一行。\n"
        "- 每条一句话、具体可执行。\n"
        "- 控制在 12 条以内，越精越好；别注水、别加标题或解释。\n"
        "- 只输出清单，每条以「- 」开头。"
    )
    out = chat(
        [{"role": "system", "content": sys},
         {"role": "user", "content": f"【现有清单】\n{cur}\n\n【新学到的】\n{addition}"}],
        temperature=0.3,
    )
    items = [ln.strip()[2:].strip() for ln in out.splitlines() if ln.strip().startswith("- ")]
    items = [i for i in items if i]
    return items[:12] if items else list(existing)


def model_info(model: dict = None) -> dict:
    if model:
        return {"model": model.get("model"), "base": model.get("base"), "key_set": bool(model.get("key"))}
    return {"model": MODEL_NAME, "base": MODEL_BASE, "key_set": bool(MODEL_KEY)}
