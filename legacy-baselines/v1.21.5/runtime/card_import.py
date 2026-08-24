"""card_import — 把一张酒馆角色卡(V2/V3 PNG)解析成 tavern 内部 card JSON。

纯 stdlib：读 PNG 的 tEXt chunk，V2 关键字 `chara`、V3 关键字 `ccv3`，chunk 数据是
`keyword\\0base64(json)`，base64 解出来是角色卡 JSON。优先 V3(ccv3)，回落 V2(chara)。

铁律：**不丢未知键**(V2 spec「Character editors MUST NOT destroy unknown key-value pairs」)，
整份 data + 顶层 extensions 原样带走。
"""
import base64
import json
import struct
import hashlib
import re

PNG_SIG = b"\x89PNG\r\n\x1a\n"
MAX_PNG_BYTES = 5 * 1024 * 1024
MAX_METADATA_BYTES = 2 * 1024 * 1024


def _iter_png_chunks(raw: bytes):
    if len(raw) > MAX_PNG_BYTES:
        raise ValueError("角色卡 PNG 不能超过 5 MB")
    if raw[:8] != PNG_SIG:
        raise ValueError("不是 PNG（角色卡必须是 PNG，像素是装饰、元数据才是载荷）")
    i = 8
    n = len(raw)
    while i + 8 <= n:
        (length,) = struct.unpack(">I", raw[i : i + 4])
        if length > MAX_METADATA_BYTES or i + 12 + length > n:
            raise ValueError("PNG chunk 过大或不完整")
        ctype = raw[i + 4 : i + 8]
        data = raw[i + 8 : i + 8 + length]
        yield ctype, data
        i += 8 + length + 4  # length + type + data + crc
        if ctype == b"IEND":
            break


def _read_text_chunks(raw: bytes) -> dict:
    """返回 {keyword: text}，覆盖 tEXt(未压缩) 与 iTXt(可能压缩)。"""
    out = {}
    for ctype, data in _iter_png_chunks(raw):
        if ctype == b"tEXt":
            kw, _, txt = data.partition(b"\x00")
            out[kw.decode("latin-1")] = txt.decode("latin-1")
        elif ctype == b"iTXt":
            # keyword\0 compflag\0 compmethod\0 langtag\0 transkw\0 text
            try:
                kw, rest = data.split(b"\x00", 1)
                comp_flag = rest[0]
                rest = rest[1:]
                # comp_method(1) + langtag\0 + transkw\0
                rest = rest[1:]
                _lang, rest = rest.split(b"\x00", 1)
                _trans, rest = rest.split(b"\x00", 1)
                if comp_flag == 1:
                    import zlib

                    decompressor = zlib.decompressobj()
                    decoded = decompressor.decompress(rest, MAX_METADATA_BYTES + 1)
                    if len(decoded) > MAX_METADATA_BYTES or decompressor.unconsumed_tail:
                        raise ValueError("角色卡元数据解压后过大")
                    if not decompressor.eof:
                        raise ValueError("角色卡压缩元数据不完整")
                    text = decoded.decode("utf-8", "replace")
                else:
                    if len(rest) > MAX_METADATA_BYTES:
                        raise ValueError("角色卡元数据过大")
                    text = rest.decode("utf-8", "replace")
                out.setdefault(kw.decode("latin-1"), text)
            except Exception:
                continue
    return out


def _decode_card_payload(text_chunks: dict) -> dict:
    for key in ("ccv3", "chara"):  # V3 优先
        if key in text_chunks:
            blob = text_chunks[key].strip()
            # tEXt 按 latin-1 读进来（字节安全的 1:1 映射）、iTXt 已是 utf-8 unicode。
            # 先还原成原始字节，再判断 base64 还是明文 JSON——否则明文 UTF-8 卡会被
            # Treating UTF-8 metadata as latin-1 before json.loads causes CJK mojibake.
            try:
                raw = blob.encode("latin-1")   # tEXt 路径：还原原始字节
            except UnicodeEncodeError:
                raw = blob.encode("utf-8")     # iTXt 路径：已是 unicode
            try:
                raw = base64.b64decode(raw, validate=True)  # 绝大多数卡 base64(json)
            except Exception:
                pass  # 个别卡直接塞明文 JSON（raw 已是原始 UTF-8 字节）
            if len(raw) > MAX_METADATA_BYTES:
                raise ValueError("角色卡 JSON 过大")
            return json.loads(raw.decode("utf-8"))
    raise ValueError("PNG 里没有 chara/ccv3 角色卡数据")


_STR_FIELDS = (
    "name", "description", "personality", "scenario",
    "first_mes", "mes_example", "system_prompt", "post_history_instructions",
    "creator", "character_version", "nickname",
)


def _text(value, limit=4000):
    return str(value or "").strip()[:limit]


def _list(value, limit=12, item_limit=240):
    values = value if isinstance(value, list) else ([value] if value else [])
    out = []
    for item in values:
        text = _text(item, item_limit)
        if text and text not in out:
            out.append(text)
        if len(out) >= limit:
            break
    return out


_SECTION_NAMES = {
    "identity": {"身份", "基本信息", "角色身份", "identity", "profile"},
    "appearance": {"外貌", "外观", "形象", "appearance", "looks"},
    "personality": {"性格", "人格", "personality", "traits"},
    "expression": {"表达", "表达方式", "说话方式", "语言风格", "speech", "expression"},
    "capabilities": {"能力", "技能", "能力与限制", "capabilities", "abilities", "skills", "powers"},
    "background": {"背景", "经历", "过往", "background", "history"},
    "relationships": {"关系", "人物关系", "relationships", "relations"},
}


def _section_key(name):
    normalized = re.sub(r"[\s_-]+", "", str(name or "").strip().lower())
    for key, aliases in _SECTION_NAMES.items():
        if normalized in {re.sub(r"[\s_-]+", "", alias.lower()) for alias in aliases}:
            return key
    return ""


def _section_lines(value, limit=24, item_limit=500):
    out = []
    for raw in str(value or "").splitlines():
        line = re.sub(r"^\s*(?:[-*•·]|\d+[.)、])\s*", "", raw).strip()
        if not line or re.match(r"^(?:【当前(?:任务|状态|位置)】|\[current\s+(?:task|status|location)\])", line, re.I):
            continue
        line = _text(line, item_limit)
        if line and line not in out:
            out.append(line)
        if len(out) >= limit:
            break
    return out


def _description_sections(value):
    """Read common XML-like sections without treating the outer role tag as content."""
    source = str(value or "").strip()
    wrapped = bool(re.match(r"^\s*<(?:角色|character)\b[^>]*>", source, re.I))
    body = re.sub(r"^\s*<(?:角色|character)\b[^>]*>\s*", "", source, flags=re.I)
    body = re.sub(r"\s*</(?:角色|character)>\s*$", "", body, flags=re.I)
    pattern = re.compile(
        r"<\s*([A-Za-z\u4e00-\u9fff _-]+)(?:\s+[^>]*)?>(.*?)</\s*\1\s*>",
        re.I | re.S,
    )
    sections = {}
    spans = []
    for match in pattern.finditer(body):
        key = _section_key(match.group(1))
        if not key:
            continue
        spans.append(match.span())
        sections.setdefault(key, []).extend(_section_lines(match.group(2)))
    remainder = body
    for start, end in reversed(spans):
        remainder = remainder[:start] + "\n" + remainder[end:]
    sections["remainder"] = _section_lines(remainder)
    sections["_wrapped"] = wrapped
    return sections


def canonical_relationship_hints(data: dict) -> list:
    data = data if isinstance(data, dict) else {}
    return (_description_sections(data.get("description")).get("relationships") or [])[:24]


def canonical_scene_notes(data: dict) -> list:
    """Extract explicitly marked mutable scene notes so callers can move them to the ledger."""
    source = str((data or {}).get("description") or "")
    notes = []
    pattern = re.compile(
        r"(?:【当前(?:任务|状态|位置)】|\[current\s+(?:task|status|location)\])\s*([^\n<]+)", re.I)
    for match in pattern.finditer(source):
        note = _text(match.group(1), 300)
        if note and note not in notes:
            notes.append(note)
    return notes[:8]


def canonical_profile(data: dict) -> dict:
    """Map arbitrary V1/V2/V3 card fields into Tavern's stable character schema.

    The original fields remain available for round-tripping, but generation and
    UI can rely on one predictable shape regardless of import source.
    """
    data = data if isinstance(data, dict) else {}
    supplied = data.get("profile") if isinstance(data.get("profile"), dict) else {}
    extensions = data.get("extensions") if isinstance(data.get("extensions"), dict) else {}
    tavern = extensions.get("tavern") if isinstance(extensions.get("tavern"), dict) else {}
    extension_profile = tavern.get("profile") if isinstance(tavern.get("profile"), dict) else {}

    def section(name):
        merged = {}
        if isinstance(extension_profile.get(name), dict):
            merged.update(extension_profile[name])
        if isinstance(supplied.get(name), dict):
            merged.update(supplied[name])
        return merged

    identity = section("identity")
    appearance = section("appearance")
    personality = section("personality")
    expression = section("expression")
    capabilities = section("capabilities")
    background = section("background")
    nickname = data.get("nickname")
    aliases = identity.get("aliases") or ([nickname] if nickname else [])
    parsed = _description_sections(data.get("description"))
    raw_description = _text(data.get("description"))
    generated_profile = (
        not supplied
        or _text(identity.get("description")) == raw_description
        or _text(identity.get("description")).lstrip().lower().startswith(("<角色", "<character"))
    )
    parsed_identity = parsed.get("identity") or parsed.get("remainder") or []
    parsed_personality = parsed.get("personality") or []
    parsed_appearance = parsed.get("appearance") or []
    parsed_capabilities = parsed.get("capabilities") or []
    parsed_background = parsed.get("background") or []
    parsed_expression = parsed.get("expression") or []
    has_structured_sections = bool(parsed.get("_wrapped")) or any(parsed.get(key) for key in _SECTION_NAMES)

    if generated_profile and has_structured_sections:
        identity["description"] = "\n".join(parsed_identity or parsed_background[:2])
    if generated_profile and parsed_appearance:
        appearance["summary"] = "\n".join(parsed_appearance)
    if generated_profile and parsed_personality:
        personality["summary"] = ""
        personality["traits"] = parsed_personality
    if generated_profile and parsed_expression:
        expression["speech_style"] = "\n".join(parsed_expression)
    if generated_profile and parsed_capabilities:
        capabilities["skills"] = parsed_capabilities
    if generated_profile and parsed_background:
        background["summary"] = "\n".join(parsed_background)

    return {
        "identity": {
            "name": _text(identity.get("name") or data.get("name"), 160),
            "aliases": _list(aliases, 8, 120),
            "description": _text(identity.get("description") or (
                "" if has_structured_sections else data.get("description"))),
            "gender": _text(identity.get("gender"), 80),
            "age": _text(identity.get("age"), 80),
            "species": _text(identity.get("species"), 100),
            "occupation": _text(identity.get("occupation"), 180),
            "affiliations": _list(identity.get("affiliations"), 10, 160),
            "story_role": _text(identity.get("story_role"), 180),
        },
        "appearance": {
            "summary": _text(appearance.get("summary"), 2500),
            "features": _list(appearance.get("features"), 12, 180),
            "attire": _list(appearance.get("attire"), 10, 180),
        },
        "personality": {
            # An explicit empty summary means the normalized traits replaced the
            # legacy all-in-one personality prose. Do not resurrect that prose.
            "summary": _text(personality.get("summary") if "summary" in personality else data.get("personality")),
            "traits": _list(personality.get("traits"), 12, 120),
            "values": _list(personality.get("values"), 10, 160),
            "motivation": _text(personality.get("motivation"), 500),
            "fears": _list(personality.get("fears"), 8, 180),
            "boundaries": _list(personality.get("boundaries"), 10, 180),
        },
        "expression": {
            "speech_style": _text(expression.get("speech_style"), 500),
            "habits": _list(expression.get("habits"), 10, 180),
            "mannerisms": _list(expression.get("mannerisms"), 10, 180),
        },
        "capabilities": {
            "skills": _list(capabilities.get("skills"), 12, 180),
            "powers": _list(capabilities.get("powers"), 12, 180),
            "limitations": _list(capabilities.get("limitations"), 12, 180),
        },
        "background": {
            "summary": _text(background.get("summary"), 2500),
            "key_history": _list(background.get("key_history"), 12, 240),
        },
    }


def canonical_entry(data: dict) -> dict:
    data = data if isinstance(data, dict) else {}
    supplied = data.get("entry") if isinstance(data.get("entry"), dict) else {}
    return {
        "initial_scenario": _text(supplied.get("initial_scenario") or data.get("scenario")),
        "first_message": _text(supplied.get("first_message") or data.get("first_mes")),
        "example_dialogue": _text(supplied.get("example_dialogue") or data.get("mes_example")),
    }


def canonical_performance(data: dict) -> dict:
    data = data if isinstance(data, dict) else {}
    supplied = data.get("performance") if isinstance(data.get("performance"), dict) else {}
    return {
        "system_prompt": _text(supplied.get("system_prompt") or data.get("system_prompt")),
        "post_history_instructions": _text(
            supplied.get("post_history_instructions") or data.get("post_history_instructions")),
    }


def normalize_card(card_obj: dict) -> dict:
    """V1/V2/V3 → tavern 内部统一形态。保留 extensions + 原始 data。"""
    data = card_obj.get("data") if isinstance(card_obj.get("data"), dict) else card_obj
    out = {"spec": card_obj.get("spec", "chara_card_v2")}
    for f in _STR_FIELDS:
        out[f] = data.get(f, "") or ""
    out["alternate_greetings"] = data.get("alternate_greetings") or []
    out["tags"] = data.get("tags") or []
    # 出处标记:import_card(PNG/Chub)→「chub」、import_card_json(原创/粘贴)→「agent」,
    # 由 server 的事件入口按导入渠道打(normalize_card 路径无关、分不清渠道)。卡 JSON 自带
    # 的 source 先保留(不丢未知键),server 再按渠道覆盖。显示优先 creator,无 creator 才看 source。
    out["source"] = data.get("source") or ""
    # 世界书可能内嵌在卡里(character_book)——带走，建剧组时可转成独立 worldbook
    if isinstance(data.get("character_book"), dict):
        out["character_book"] = data["character_book"]
    out["extensions"] = data.get("extensions") or {}  # 铁律：不丢未知键
    out["profile"] = canonical_profile(data)
    out["entry"] = canonical_entry(data)
    out["performance"] = canonical_performance(data)
    cid = "card_" + hashlib.sha1(
        (out["name"] + "|" + out["description"][:200]).encode("utf-8")
    ).hexdigest()[:12]
    out["id"] = cid
    return out


def import_card_bytes(png_bytes: bytes) -> dict:
    if len(png_bytes) > MAX_PNG_BYTES:
        raise ValueError("角色卡 PNG 不能超过 5 MB")
    return normalize_card(_decode_card_payload(_read_text_chunks(png_bytes)))


def import_card_b64(png_b64: str) -> dict:
    if len(str(png_b64 or "")) > (MAX_PNG_BYTES * 4 // 3) + 16:
        raise ValueError("角色卡 PNG 不能超过 5 MB")
    return import_card_bytes(base64.b64decode(png_b64, validate=True))


if __name__ == "__main__":
    import sys

    with open(sys.argv[1], "rb") as f:
        c = import_card_bytes(f.read())
    print(json.dumps(c, ensure_ascii=False, indent=2))
