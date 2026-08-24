"""server — 酒馆演员运行时的同源 server（stdlib http.server，仿 digest）。

serve 控制台静态页(web/) + /api/*（同源，浏览器同源策略天然满足，模型 creds 留 server 端）。
状态全落 /opt/data/tavern-state 下 JSON 文件，永不写能力服务器/member-backend。

跑：TAVERN_MODEL_KEY=... python3 server.py [--port 8799]
"""
import html
import json
import hashlib
import os
import secrets
import re
import sys
import threading
import time
import yaml
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import actor  # noqa: E402
import card_import  # noqa: E402
import story_profile  # noqa: E402
from background_jobs import tavern_job_runner  # noqa: E402
from continuity_model import (  # noqa: E402
    canonical_profile_snapshot as _canonical_profile_snapshot,
    ensure_runtime_cast as _continuity_ensure_runtime_cast,
    hydrate_runtime_cards as _continuity_hydrate_runtime_cards,
    hydrate_user_persona as _continuity_hydrate_user_persona,
    migrate_legacy_story_context as _migrate_legacy_story_context,
    normalize_fact_entry as _normalize_fact_entry,
    normalize_known_by as _normalize_known_by,
    normalize_ledger_scene as _normalize_ledger_scene,
    normalize_object_entry as _normalize_object_entry,
    normalize_persona as _normalize_persona,
    normalize_persistent_status as _normalize_persistent_status,
    normalize_relationships as _normalize_relationships,
    normalize_scene_participant as _normalize_scene_participant,
    profile_has_content as _profile_has_content,
    relationships_from_cards as _relationships_from_cards,
    runtime_character as _runtime_character,
    stable_memory_id as _stable_memory_id,
    state_list as _state_list,
)
from model_registry import ModelRegistry  # noqa: E402
from production_views import production_summary  # noqa: E402
from request_security import RequestAuthorizer  # noqa: E402
from runtime_http import (  # noqa: E402
    BoundedThreadingHTTPServer,
    RequestBodyTooLarge,
    read_request_body,
    safe_static_path,
    validate_outbound_http_base,
)
from state_store import JsonStateStore  # noqa: E402
from story_ledger import (  # noqa: E402
    story_messages_through_turn as _story_messages_through_turn,
    story_prefix_signature as _story_prefix_signature,
    story_state_has_memory as _story_state_has_memory,
    validated_story_state,
)
from tts_service import TTSService  # noqa: E402

STATE = os.environ.get("TAVERN_STATE_DIR", "/opt/data/tavern-state")
READER = os.path.join(HERE, "web")
WORLD_ASSETS = os.path.join(STATE, "world-assets")
SEED_ACTOR = os.path.join(HERE, "actor_self.md")
for sub in ("cards", "worldbooks", "productions"):
    os.makedirs(os.path.join(STATE, sub), exist_ok=True)
STATE_STORE = JsonStateStore(STATE)
BACKGROUND_JOBS = tavern_job_runner()
REQUEST_AUTHORIZER = RequestAuthorizer()

MAX_EVENT_BODY_BYTES = max(
    1024,
    int(os.environ.get("TAVERN_MAX_EVENT_BODY_BYTES", str(2 * 1024 * 1024))),
)
MAX_CLONE_BODY_BYTES = max(
    MAX_EVENT_BODY_BYTES,
    int(os.environ.get("TAVERN_MAX_CLONE_BODY_BYTES", str(14 * 1024 * 1024))),
)

WORLD_UI_VERSION = 1
WORLD_UI_COLOR_FIELDS = {
    "accent", "background", "surface", "text", "secondary_text", "muted",
    "border", "user_message", "overlay",
}
WORLD_UI_FONT_PRESETS = {"default", "literary", "modern", "classic", "typewriter"}
WORLD_UI_BACKGROUND_POSITIONS = {
    "center", "top", "bottom", "left", "right",
    "left top", "left bottom", "right top", "right bottom",
}
WORLD_UI_BACKGROUND_FITS = {"cover", "contain"}
WORLD_UI_READING_SURFACES = {"plain", "glass", "solid"}
WORLD_UI_COLOR_RE = re.compile(
    r"^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$"
)
WORLD_ASSET_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
                 ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".webp": "image/webp", ".svg": "image/svg+xml"}

DESTRUCTIVE_CONFIRM_TTL = 600
_destructive_confirmations = {}
_destructive_confirmation_lock = threading.Lock()


def _prepare_destructive_confirmation(action, resource_id):
    now = time.time()
    token = secrets.token_urlsafe(8)
    with _destructive_confirmation_lock:
        expired = [
            key for key, item in _destructive_confirmations.items()
            if item["expires_at"] <= now
        ]
        for key in expired:
            _destructive_confirmations.pop(key, None)
        _destructive_confirmations[token] = {
            "action": action,
            "resource_id": resource_id,
            "expires_at": now + DESTRUCTIVE_CONFIRM_TTL,
        }
    return token


def _consume_destructive_confirmation(token, action, resource_id):
    if not token:
        raise ValueError("confirmation token is required; prepare this operation first")
    with _destructive_confirmation_lock:
        item = _destructive_confirmations.pop(str(token), None)
    if not item or item["expires_at"] <= time.time():
        raise ValueError("confirmation token is invalid or expired")
    if item["action"] != action or item["resource_id"] != resource_id:
        raise ValueError("confirmation token does not match this operation")


DEFAULT_IDENTITY = {
    "persona_name": "主理人",
    "tavern_name": "酒馆",
    "actor_name": "故事档案",
    "persona_name_en": "Curator",
    "tavern_name_en": "Tarven",
    "actor_name_en": "Story Profile",
}


def _read(path, default=None):
    """Read a root-level runtime document outside the namespaced state store."""
    try:
        with open(path, encoding="utf-8") as file:
            return json.load(file)
    except FileNotFoundError:
        return default


def _write(path, value):
    """Atomically replace a root-level runtime document."""
    temporary = path + ".tmp." + secrets.token_hex(4)
    try:
        with open(temporary, "w", encoding="utf-8") as file:
            json.dump(value, file, ensure_ascii=False, indent=2)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass


def _clawchat_agent_profile():
    """Best-effort local ClawChat profile metadata for name/avatar sync."""
    path = "/opt/data/memories/owner.md"
    profile = {}
    try:
        with open(path, encoding="utf-8") as file:
            in_metadata = False
            for line in file:
                line = line.rstrip("\n")
                if line.strip() == "<!-- clawchat:metadata:start -->":
                    in_metadata = True
                    continue
                if line.strip() == "<!-- clawchat:metadata:end -->":
                    break
                if in_metadata and ":" in line:
                    key, value = line.split(":", 1)
                    profile[key.strip()] = value.strip()
    except OSError:
        pass
    return profile


def app_identity():
    identity = dict(DEFAULT_IDENTITY)
    saved = _read(os.path.join(STATE, "app_identity.json"), {})
    if isinstance(saved, dict):
        for key in identity:
            value = saved.get(key)
            if isinstance(value, str) and value.strip():
                identity[key] = value.strip()
    nickname = (_clawchat_agent_profile().get("agent_nickname") or "").strip()
    if nickname:
        identity["persona_name"] = nickname
        identity["persona_name_en"] = nickname
    identity["tavern_name_en"] = "Tarven"
    identity["actor_name_en"] = "Story Profile"
    return identity


def _tts_key():
    """Use the Tavern/Clawling credential without exposing it to the reader."""
    return (os.environ.get("TAVERN_TTS_KEY")
            or os.environ.get("CLAWLING_API_KEY")
            or actor.MODEL_KEY
            or "").strip()


TTS_SERVICE = TTSService(
    STATE,
    base=os.environ.get("TAVERN_TTS_BASE") or actor.MODEL_BASE,
    key_provider=_tts_key,
)

def _state_path():
    return os.path.join(STATE, "state.json")


def _get_state():
    return _read(_state_path(), {"active_production_id": None})


def _set_active(pid):
    s = _get_state()
    s["active_production_id"] = pid
    _write(_state_path(), s)


def actor_self_text():
    profile = story_profile.ensure_profile(STATE, SEED_ACTOR)
    return story_profile.render_markdown(profile, story_profile.eras(STATE))


def liveware_version():
    release_marker = os.path.join(HERE, ".tavern-release-version")
    try:
        with open(release_marker, encoding="utf-8") as f:
            version = f.read().strip()
        if version:
            return version
    except OSError:
        pass

    # 旧安装没有 release marker 时，回落到技能 frontmatter。
    skill_md = "/opt/data/skills/creative/tavern/SKILL.md"
    for path in (skill_md, os.path.join(HERE, "SKILL.md")):
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    if line.startswith("version:"):
                        return line.split(":", 1)[1].strip()
        except OSError:
            continue
    return ""


def agent_user_id():
    """主理人在 ClawChat 里的身份 id(usr_…)——用于复盘入口的最终兜底深链。
    env 优先(dev/测试);容器里从 hermes config.yaml 文本扫描 `user_id: usr_…`。"""
    envv = os.environ.get("TAVERN_AGENT_USER_ID", "").strip()
    if envv:
        return envv
    try:
        with open("/opt/data/config.yaml", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s.startswith("user_id:"):
                    v = s.split(":", 1)[1].strip().strip("'\"")
                    if v.startswith("usr_"):
                        return v
    except OSError:
        pass
    return ""


# ---------- 演员卡聚合（actor-card surface）----------
# 纯聚合读现有 state，零新后端。词汇 canon（liveware-frontend §术语表）：
# 戏路 = 演过的角色数（不是"搭档"）；搭档 = 你；亲密度由 轮数 + 权重×年表条数 驱动。
INTIMACY_W = int(os.environ.get("ACTOR_INTIMACY_W", "8"))
# 阶梯（名, 分阈值）。env 后续可覆盖；先常量。
INTIMACY_LADDER = [("初见", 0), ("相识", 15), ("搭档", 40), ("默契", 100), ("知己", 250)]
INTIMACY_BLURB = {"初见": "刚认识，还在摸你的脾气", "相识": "演过几场，记住了你几样",
                  "搭档": "有默契雏形，接得住你的球", "默契": "一个眼神就懂，越演越顺",
                  "知己": "最懂你怎么玩的那个演员"}
# 级名/blurb 的多语言表(locale contract:reader 带 ?lang= 来取——它们是 UI 标签,不是内容;
# 中文名是 canonical(技艺层/CLI 用),其他语言只在下发时映射)。
# 给二创主理人的「加语言」入口②:reader 的 STRINGS 加完,在这两张表加同 code 的项(全量 5 级),
# 缺表回落 en。①在 reader/i18n.js,教程见 SKILL.md「帮用户加界面语言」。
INTIMACY_LEVEL_I18N = {
    "en": {"初见": "First Meeting", "相识": "Acquainted", "搭档": "Partners",
           "默契": "In Sync", "知己": "Confidant"},
}
INTIMACY_BLURB_I18N = {
    "en": {"初见": "Just met — still learning your rhythms",
           "相识": "A few scenes in — noted a few of your tastes",
           "搭档": "Early chemistry — I can catch what you throw",
           "默契": "One glance is enough — smoother every scene",
           "知己": "The actor who knows exactly how you play"},
}
def _sections(md):
    """把 actor_self.md 按 '# ' 一级标题切成 {标题: [正文行]}。"""
    secs, cur = {}, None
    for line in md.splitlines():
        if line.startswith("# "):
            cur = line[2:].strip()
            secs[cur] = []
        elif cur is not None:
            secs[cur].append(line)
    return secs


def _bullets(lines):
    return [s[2:].strip() for s in (ln.strip() for ln in lines) if s.startswith("- ")]


def parse_actor_self(md):
    """从技艺层拆出：tagline（底色）、口味（我对你的了解，合并档）、年表（成长记，累计）。"""
    secs = _sections(md)

    def find(key):
        for k, v in secs.items():
            if key in k:
                return v
        return []

    tagline = ""
    for line in find("我是谁"):
        if "演员" in line and "——" in line:
            after = line.split("——", 1)[1]
            if "而是" in after:
                after = after.split("而是", 1)[1]
            tagline = after.strip().strip("。").lstrip("那个").strip()
            break
    if not tagline:
        for line in find("故事档案"):
            line = line.strip()
            if line and not line.startswith("-"):
                tagline = line.strip("。")
                break
    knows = [b for b in _bullets(find("我对你的了解")) if not b.startswith("（")]
    timeline = []
    for b in _bullets(find("成长记")):
        if b.startswith("（"):
            continue
        has_date = len(b) >= 10 and b[4] == "-" and b[7] == "-"
        date = b[:10] if has_date else ""
        rest = (b[10:] if has_date else b).strip()
        if "→" in rest:
            reason, change = rest.split("→", 1)
            timeline.append({"date": date, "reason": reason.strip(), "change": change.strip()})
        else:
            timeline.append({"date": date, "reason": "", "change": rest})
    return tagline, knows, timeline


def _intimacy(score, lang="zh"):
    cur, cur_thr = INTIMACY_LADDER[0]
    nxt, nxt_thr = None, None
    for i, (name, thr) in enumerate(INTIMACY_LADDER):
        if score >= thr:
            cur, cur_thr = name, thr
            if i + 1 < len(INTIMACY_LADDER):
                nxt, nxt_thr = INTIMACY_LADDER[i + 1]
            else:
                nxt, nxt_thr = None, None
    lvl_map = INTIMACY_LEVEL_I18N.get(lang) or INTIMACY_LEVEL_I18N["en"]
    blurb_map = INTIMACY_BLURB_I18N.get(lang) or INTIMACY_BLURB_I18N["en"]

    def loc(name):  # 级名本地化(zh 是 canonical,其他查表;缺表/缺项回落 en/原名)
        return name if lang == "zh" or name is None else lvl_map.get(name, name)
    blurb = (INTIMACY_BLURB if lang == "zh" else blurb_map).get(cur, "")
    if nxt_thr is None:  # 已到顶
        return {"level": loc(cur), "score": score, "next": None, "to_next": 0, "progress": 1.0,
                "blurb": blurb}
    span = nxt_thr - cur_thr
    prog = 0.0 if span <= 0 else max(0.0, min(1.0, (score - cur_thr) / span))
    return {"level": loc(cur), "score": score, "next": loc(nxt), "to_next": nxt_thr - score,
            "progress": round(prog, 3), "blurb": blurb}


def actor_card_data(lang="zh"):
    """演员卡聚合数据（/api/actor_card?lang=）。全部从现有 state 算，无写、无新事件。
    lang 只影响 server 下发的 UI 标签（级名/blurb/name 兜底）；内容层（口味/年表/tagline）
    是主理人写的东西，不翻。"""
    prods = _list("productions")
    total_turns, total_words, role_ids, debut = 0, 0, set(), None
    roles_played = {}  # card_id -> 轮数（v1.1 角色名录）
    for p in prods:
        story = p.get("story", [])
        ca = p.get("created_at")
        if ca and (debut is None or ca < debut):
            debut = ca
        cid = p.get("card_id")
        if cid:
            role_ids.add(cid)
        uturns = 0
        for i, m in enumerate(story):
            if m.get("role") == "user":
                uturns += 1
            elif i > 0:  # 排除 story[0] 开场白（first_mes 是卡作者写的，非主理人生成）
                total_words += len(m.get("text") or "")
        total_turns += uturns
        if cid:
            roles_played[cid] = roles_played.get(cid, 0) + uturns
    debut_days = 0 if debut is None else max(0, (int(time.time()) - int(debut)) // 86400)
    profile = story_profile.ensure_profile(STATE, SEED_ACTOR)
    tagline = parse_actor_self(actor_self_text())[0]
    knows = story_profile.preference_texts(profile)
    timeline = story_profile.timeline(profile)
    era_items = story_profile.eras(STATE)
    event_count = int(profile.get("stats", {}).get("event_count") or len(timeline))
    intim = _intimacy(total_turns + INTIMACY_W * event_count, lang)
    intim["turns"] = total_turns
    intim["log"] = event_count
    cards = {c["id"]: c for c in _list("cards")}
    roles = sorted(({"name": (cards.get(cid) or {}).get("name") or "角色", "turns": t}
                    for cid, t in roles_played.items()), key=lambda r: -r["turns"])
    specs = []
    for cid in role_ids:  # 擅长题材 = 各卡 tags 聚合（v1.1）
        for t in (cards.get(cid) or {}).get("tags", []) or []:
            if t not in specs:
                specs.append(t)
    return {
        # name/tagline 兜底走统一身份配置;tagline 仍来自 actor_self.md 优先。
        "name": app_identity()["persona_name"] if lang == "zh" else app_identity()["persona_name_en"],
        "tagline": tagline or ("你的故事主理人"
                               if lang == "zh" else "Your story lead"),
        "career": {"debut_days": debut_days, "productions": len(prods),
                   "turns": total_turns, "words": total_words, "roles": len(role_ids)},
        "intimacy": intim,
        "knows": knows,
        "timeline": list(reversed(timeline)),  # 最近在前
        "eras": list(reversed(era_items)),
        "profile_revision": int(profile.get("revision") or 0),
        "specialties": specs[:8],
        "roles_played": roles,
        "version": liveware_version(),
        "actor_url": (f"https://{_actor_host()}/" if _actor_host() else ""),  # 演员卡活件公网地址
    }


def _actor_host():
    """演员卡活件 app 的域名（第二个活件卡入口）。存 state/actor_host.txt，重启/bringup 不丢；
    env TAVERN_ACTOR_HOST 兜底。为空 = 没注册第二个 app（`/` 一律控制台）。"""
    try:
        with open(os.path.join(STATE, "actor_host.txt"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return os.environ.get("TAVERN_ACTOR_HOST", "").strip()


def load_card(cid):
    card = STATE_STORE.read("cards", cid)
    if isinstance(card, dict):
        card["profile"] = card_import.canonical_profile(card)
        card["entry"] = card_import.canonical_entry(card)
        card["performance"] = card_import.canonical_performance(card)
    return card


def load_worldbook(wid):
    return STATE_STORE.read("worldbooks", wid)


def load_production(pid):
    p = STATE_STORE.read("productions", pid)
    return _ensure_production_session(p)


_PRODUCTION_LOCKS = tuple(threading.RLock() for _ in range(64))


class ProductionRevisionConflict(Exception):
    def __init__(self, current_revision):
        super().__init__("character state changed")
        self.current_revision = int(current_revision or 0)


def _production_lock(pid):
    return _PRODUCTION_LOCKS[hash(str(pid)) % len(_PRODUCTION_LOCKS)]


def save_production(p):
    with _production_lock(p["id"]):
        record = _production_record(p)
        STATE_STORE.write("productions", p["id"], record)


def _production_record(p):
    """Strip hydrated projections before persisting a production."""
    record = dict(p)
    record.pop("worldbooks", None)
    if isinstance(record.get("persona"), dict):
        persona = dict(record["persona"])
        persona.pop("persistent_status", None)
        record["persona"] = persona
    if isinstance(record.get("runtime_cast"), dict):
        record.pop("cards", None)
    return record


def _world_ui_asset(value):
    value = str(value or "").strip()
    if not value or len(value) > 2048:
        return ""
    parsed = urlparse(value)
    if parsed.scheme == "https" and parsed.netloc:
        return value
    if not parsed.scheme and not value.startswith("//"):
        try:
            if parsed.path.startswith("/world-assets/"):
                local_path = safe_static_path(WORLD_ASSETS, parsed.path[len("/world-assets"):])
            elif parsed.path.startswith("/assets/"):
                local_path = safe_static_path(READER, parsed.path)
            else:
                return ""
        except ValueError:
            return ""
        if (
            os.path.isfile(local_path)
            and os.path.splitext(local_path)[1].lower() in WORLD_ASSET_EXTENSIONS
        ):
            return value
    return ""


def _normalize_world_ui(value):
    """Return the declarative visual theme fields accepted from a world."""
    if not isinstance(value, dict):
        return {}

    source_theme = value.get("theme") if isinstance(value.get("theme"), dict) else {}
    theme = {}
    for field in WORLD_UI_COLOR_FIELDS:
        color = str(source_theme.get(field) or "").strip()
        if color and WORLD_UI_COLOR_RE.fullmatch(color):
            theme[field] = color.lower()

    for field in ("font", "narration_font"):
        preset = str(source_theme.get(field) or "").strip().lower()
        if preset in WORLD_UI_FONT_PRESETS:
            theme[field] = preset

    try:
        width = int(source_theme.get("content_width"))
    except (TypeError, ValueError):
        width = 0
    if 360 <= width <= 760:
        theme["content_width"] = width

    for field in ("background_position", "background_position_mobile"):
        position = str(source_theme.get(field) or "").strip().lower()
        if position in WORLD_UI_BACKGROUND_POSITIONS:
            theme[field] = position

    for field in ("background_fit", "background_fit_mobile"):
        fit = str(source_theme.get(field) or "").strip().lower()
        if fit in WORLD_UI_BACKGROUND_FITS:
            theme[field] = fit

    reading_surface = str(source_theme.get("reading_surface") or "").strip().lower()
    if reading_surface in WORLD_UI_READING_SURFACES:
        theme["reading_surface"] = reading_surface

    source_assets = value.get("assets") if isinstance(value.get("assets"), dict) else {}
    assets = {}
    for field in ("background", "background_desktop", "background_mobile", "cover"):
        asset = _world_ui_asset(source_assets.get(field))
        if asset:
            assets[field] = asset

    result = {"version": WORLD_UI_VERSION}
    if theme:
        result["theme"] = theme
    if assets:
        result["assets"] = assets
    return result if len(result) > 1 else {}


def _story_content_signature(story):
    payload = [(m.get("id"), m.get("role"), m.get("text") or "") for m in story or []]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False).encode("utf-8")).hexdigest()


def _commit_foreground_story(p, expected_story_signature):
    """Commit generated story changes without overwriting newer background state."""
    pid = p["id"]
    with _production_lock(pid):
        current = load_production(pid)
        if not current:
            raise ValueError("production not found")
        if _story_content_signature(current.get("story") or []) != expected_story_signature:
            raise RuntimeError("故事已在另一项操作中更新，请重试。")

        incoming_story = p.get("story") or []
        current["story"] = incoming_story
        for key in ("response_language", "language_mode", "language_confidence", "language_source"):
            if key in p:
                current[key] = p[key]

        runtime = dict(current.get("runtime") or {})
        incoming_runtime = dict(p.get("runtime") or {})
        for key, value in incoming_runtime.items():
            if key != "story_state_error":
                runtime[key] = value
        if "last_prompt_debug" not in incoming_runtime:
            runtime.pop("last_prompt_debug", None)
        current["runtime"] = runtime

        current_state = current.get("story_state") or {}
        incoming_state = p.get("story_state") or {}
        if _validated_story_state(current_state, incoming_story):
            current["story_state"] = current_state
        elif _validated_story_state(incoming_state, incoming_story):
            current["story_state"] = incoming_state
        else:
            current["story_state"] = {}

        record = _production_record(current)
        STATE_STORE.write("productions", pid, record)
        p.clear()
        p.update(current)
        return current


def _story_revision(p):
    story = (p or {}).get("story") or []
    return len(story), (story[-1].get("id") if story else None)


def _merge_production_fields(pid, expected_story_revision=None, **fields):
    """Merge background results into the latest world without replacing its story."""
    with _production_lock(pid):
        current = load_production(pid)
        if not current:
            return None
        if expected_story_revision is not None and _story_revision(current) != expected_story_revision:
            return None
        current.update(fields)
        record = _production_record(current)
        STATE_STORE.write("productions", pid, record)
        return current


def _locale_code(value):
    return "zh" if str(value or "").lower().startswith("zh") else "en"


def _interface_language(locale):
    """Chinese UI uses Chinese prompts; every other declared UI locale uses English."""
    raw = str(locale or "").lower().strip()
    if not raw:
        return None
    return "zh" if raw.startswith("zh") else "en"


def _text_language(text):
    """Deterministic zh/en detection. Returns (language, confidence) or (None, 0)."""
    text = str(text or "")
    cjk = len(re.findall(r"[\u3400-\u9fff]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    total = cjk + latin
    if total < 12:
        return None, 0.0
    ratio = cjk / total
    if cjk >= 8 and ratio >= 0.28:
        return "zh", min(1.0, 0.55 + ratio)
    if latin >= 24 and ratio <= 0.08:
        return "en", min(1.0, 0.65 + (latin / max(80, latin)) * 0.25)
    return None, 0.0


def _localized_field(obj, field, locale):
    if not isinstance(obj, dict):
        return ""
    pack = (obj.get("i18n") or {}).get(locale) or {}
    return str(pack.get(field) or obj.get(field) or "")


def _world_language_evidence(p, locale):
    interface_language = _interface_language(locale)
    if interface_language:
        return interface_language, 1.0, "liveware_locale"

    card_parts = []
    for card in p.get("cards") or []:
        for field in ("name", "description", "personality", "scenario", "first_mes", "mes_example"):
            card_parts.append(_localized_field(card, field, locale))
    detected = _text_language("\n".join(card_parts))
    if detected[0]:
        return detected[0], detected[1], "character_cards"

    lore_parts = []
    for wb in p.get("worldbooks") or []:
        lore_parts.append(_localized_field(wb, "name", locale))
        for entry in wb.get("entries") or []:
            lore_parts.append(_localized_field(entry, "content", locale))
    detected = _text_language("\n".join(lore_parts))
    if detected[0]:
        return detected[0], detected[1], "worldbooks"

    opening = []
    for message in (p.get("story") or [])[:2]:
        opening.append(message.get("text") or "")
    detected = _text_language("\n".join(opening))
    if detected[0]:
        return detected[0], detected[1], "opening"
    return "zh", 0.45, "default"


def _ensure_world_language(p, locale=None):
    current = str(p.get("response_language") or "").lower()
    mode = str(p.get("language_mode") or "ui").lower()
    if mode == "auto":
        mode = "ui"
        p["language_mode"] = mode
    if mode == "manual" and current in ("zh", "en"):
        return current

    interface_language = _interface_language(locale)
    if interface_language:
        if current != interface_language or p.get("language_source") != "liveware_locale" or mode != "ui":
            p["language_mode"] = "ui"
            p["response_language"] = interface_language
            p["language_confidence"] = 1.0
            p["language_source"] = "liveware_locale"
            runtime = p.setdefault("runtime", {})
            runtime.pop("language_candidate", None)
            runtime.pop("language_candidate_streak", None)
        return interface_language

    if current in ("zh", "en"):
        p.setdefault("language_mode", "ui")
        return current
    language, confidence, source = _world_language_evidence(p, locale)
    p["language_mode"] = "ui"
    p["response_language"] = language
    p["language_confidence"] = round(float(confidence), 3)
    p["language_source"] = source
    return language


def _explicit_language_request(text):
    raw = str(text or "")
    low = raw.lower()
    if re.search(r"(?:用|改用|切换到?|请用).{0,6}(?:英文|英语)", raw) or re.search(r"\b(?:switch|reply|continue|write|speak|use)\b.{0,20}\benglish\b", low):
        return "en"
    if re.search(r"(?:用|改用|切换到?|请用).{0,6}(?:中文|汉语)", raw) or re.search(r"\b(?:switch|reply|continue|write|speak|use)\b.{0,20}\bchinese\b", low):
        return "zh"
    return None


def _set_world_language(p, language, confidence=1.0, source="explicit", mode=None):
    p["language_mode"] = mode or ("manual" if source == "explicit" else "ui")
    p["response_language"] = _locale_code(language)
    p["language_confidence"] = round(float(confidence), 3)
    p["language_source"] = source
    runtime = p.setdefault("runtime", {})
    runtime.pop("language_candidate", None)
    runtime.pop("language_candidate_streak", None)


def _observe_user_language(p, text, locale=None):
    current = _ensure_world_language(p, locale)
    explicit = _explicit_language_request(text)
    if explicit:
        _set_world_language(p, explicit, mode="manual")
        return p["response_language"]

    if p.get("language_mode") == "manual" or _interface_language(locale):
        runtime = p.setdefault("runtime", {})
        runtime.pop("language_candidate", None)
        runtime.pop("language_candidate_streak", None)
        return current

    detected, confidence = _text_language(text)
    runtime = p.setdefault("runtime", {})
    if not detected or detected == current or confidence < 0.75:
        runtime.pop("language_candidate", None)
        runtime.pop("language_candidate_streak", None)
        return current

    prior_user_turns = sum(1 for m in p.get("story") or [] if m.get("role") == "user")
    if prior_user_turns == 0 and p.get("language_source") == "default":
        _set_world_language(p, detected, confidence, "first_user_message", mode="ui")
        return detected

    streak = int(runtime.get("language_candidate_streak") or 0) + 1 if runtime.get("language_candidate") == detected else 1
    runtime["language_candidate"] = detected
    runtime["language_candidate_streak"] = streak
    if streak >= 2:
        _set_world_language(p, detected, confidence, "consecutive_user_messages", mode="ui")
        return detected
    return current


def _list(sub):
    return STATE_STORE.list(sub)


def _list_productions():
    """Return productions hydrated from their canonical worldbook files."""
    out = []
    for record in STATE_STORE.list("productions"):
        if isinstance(record, dict) and record.get("id"):
            p = _ensure_production_session(record)
            if p:
                out.append(p)
    return out


def _list_production_summaries():
    return [production_summary(record) for record in STATE_STORE.list("productions")]


def _is_runtime_worldbook(wb):
    return str((wb or {}).get("id") or "").startswith("wb_prod_")


def _runtime_worldbook_id(pid, source_id):
    digest = hashlib.sha1(str(source_id or "worldbook").encode("utf-8", "ignore")).hexdigest()[:10]
    return f"wb_prod_{pid}_{digest}"


def _clone_worldbook_for_production(pid, source_id, source=None):
    """Materialize a reusable template as one production-owned canonical file."""
    source = source or load_worldbook(source_id)
    if not source:
        return None
    if source.get("owner_production_id") == pid and _is_runtime_worldbook(source):
        return source["id"]
    original_id = source.get("source_worldbook_id") or source.get("id") or source_id
    runtime_id = _runtime_worldbook_id(pid, original_id)
    existing = load_worldbook(runtime_id)
    if existing and existing.get("owner_production_id") == pid:
        return runtime_id
    clone = json.loads(json.dumps(source, ensure_ascii=False))
    clone["id"] = runtime_id
    clone["source_worldbook_id"] = original_id
    clone["owner_production_id"] = pid
    STATE_STORE.write("worldbooks", runtime_id, clone)
    return runtime_id


def _materialize_worldbook_ids(pid, source_ids):
    out = []
    for source_id in source_ids or []:
        runtime_id = _clone_worldbook_for_production(pid, source_id)
        if runtime_id and runtime_id not in out:
            out.append(runtime_id)
    return out


def _library_cards():
    # 角色卡库：所有可复用角色模板。加入/移出某个世界不会删除这里的卡。
    cards = []
    for raw in _list("cards"):
        if not isinstance(raw, dict):
            continue
        raw["profile"] = card_import.canonical_profile(raw)
        raw["entry"] = card_import.canonical_entry(raw)
        raw["performance"] = card_import.canonical_performance(raw)
        cards.append(raw)
    return cards


def _library_worldbooks():
    # 世界书库：只放可复用世界模板；当前世界运行时设定本(wb_prod_*)不进入库。
    return [w for w in _list("worldbooks") if w and not _is_runtime_worldbook(w)]


def _production_worldbooks(pid):
    p = load_production(pid)
    if not p:
        return []
    _ensure_production_session(p)
    return [w for w in (p.get("worldbooks") or []) if isinstance(w, dict)]


def _msg(role, text):
    return {"id": secrets.token_hex(4), "role": role, "text": text,
            "ts": int(time.time()), "alts": [text], "active_alt": 0}


_CANCELLED_GENERATIONS = {}
_CANCELLED_GENERATIONS_LOCK = threading.Lock()


def ev_cancel_generation(ev):
    request_id = str(ev.get("request_id") or "").strip()
    if not request_id:
        raise ValueError("request_id is required")
    now = time.time()
    with _CANCELLED_GENERATIONS_LOCK:
        expired = [rid for rid, ts in _CANCELLED_GENERATIONS.items() if now - ts > 600]
        for rid in expired:
            _CANCELLED_GENERATIONS.pop(rid, None)
        _CANCELLED_GENERATIONS[request_id] = now
    return {"cancelled": True, "request_id": request_id}


def _raise_if_generation_cancelled(ev):
    request_id = str(ev.get("request_id") or "").strip()
    if not request_id:
        return
    with _CANCELLED_GENERATIONS_LOCK:
        cancelled = _CANCELLED_GENERATIONS.pop(request_id, None) is not None
    if cancelled:
        raise RuntimeError("generation cancelled")


# ---------- event handlers ----------
def _store_card(card, source=""):
    # source = 导入渠道(出处):chub=导入真卡 / agent=原创。creator(卡作者)仍透传,
    # 信息面板优先显 creator,无 creator 才回落 source(Task 2 角色卡出处)。
    if source:
        card["source"] = source
    card["profile"] = card_import.canonical_profile(card)
    card["entry"] = card_import.canonical_entry(card)
    card["performance"] = card_import.canonical_performance(card)
    if str(card.get("source") or "").startswith("builtin:"):
        lang = (((card.get("extensions") or {}).get("tavern") or {}).get("language") or "zh")
        identity = app_identity()
        card["creator"] = identity["tavern_name"] if lang == "zh" else identity["tavern_name_en"]
    STATE_STORE.write("cards", card["id"], card)
    # 卡内嵌世界书 → 落成独立 worldbook
    if card.get("character_book"):
        wb = {"id": "wb_" + card["id"], "name": card["character_book"].get("name") or card["name"],
              "recursive": False, "entries": card["character_book"].get("entries", [])}
        STATE_STORE.write("worldbooks", wb["id"], wb)
    return {"card": card}


def ev_import_card(ev):
    # PNG 路径：吃一张 V2/V3 角色卡 PNG（base64）。真实卡走这条，编码天然正确。出处=chub。
    return _store_card(card_import.import_card_b64(ev["png_base64"]), "chub")


def ev_import_card_json(ev):
    # JSON 路径：吃一份卡 JSON（V1/V2/V3 形态，带 data 包或裸 obj 都行）。
    # 给 agent「原创/自造」角色卡用——不手搓 PNG，绕开 btoa(UTF-8) 把中文搞乱码的坑。出处=agent。
    return _store_card(card_import.normalize_card(ev["card"]), ev.get("source") or "agent")


def ev_create_card(ev):
    name = (ev.get("name") or "未命名角色").strip() or "未命名角色"
    desc = (ev.get("description") or "").strip()
    personality = (ev.get("personality") or "").strip()
    scenario = (ev.get("scenario") or "").strip()
    first_mes = (ev.get("first_mes") or "").strip()
    card = {
        "id": "card_" + secrets.token_hex(4),
        "name": name,
        "description": desc,
        "personality": personality,
        "scenario": scenario,
        "first_mes": first_mes,
        "tags": ["手动创建"],
    }
    return _store_card(card, "agent")


def ev_import_worldbook(ev):
    wb = ev["worldbook"]
    wb.setdefault("id", "wb_" + secrets.token_hex(4))
    STATE_STORE.write("worldbooks", wb["id"], wb)
    return {"worldbook": wb}


def ev_attach_worldbook(ev):
    # Reusable books are cloned into a production-owned canonical file.
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    wid = ev["worldbook_id"]
    if not load_worldbook(wid):
        raise ValueError("worldbook not found: " + wid)
    runtime_id = _clone_worldbook_for_production(p["id"], wid)
    if runtime_id and runtime_id not in p["worldbook_ids"]:
        p["worldbook_ids"].append(runtime_id)
    _ensure_production_session(p)
    _mark_context_state_stale(p, "worldbook_changed")
    save_production(p)
    return {"production": p}


def _prod_worldbook_id(pid):
    return "wb_prod_" + pid


def _simple_keys(text, cards):
    keys = []
    for c in cards or []:
        name = str(c.get("name") or "").strip()
        if name and name in text:
            keys.append(name)
    for token in ("阁楼", "旧物", "铜扣", "失踪案", "二楼", "旅馆", "雨", "钥匙", "旧客", "秘密"):
        if token in text and token not in keys:
            keys.append(token)
    if not keys:
        keys = [x for x in text.replace("，", " ").replace("。", " ").replace("、", " ").split() if 1 < len(x) <= 8][:4]
    return keys[:8]


def _normalize_lore_entry(raw, text, cards):
    if not isinstance(raw, dict):
        raw = {}
    def arr(key, fallback=None, limit=8):
        vals = raw.get(key)
        if vals is None:
            vals = fallback or []
        if isinstance(vals, str):
            vals = [vals]
        out = []
        for v in vals or []:
            x = str(v).strip().lstrip("-•").strip()
            if x and x not in out:
                out.append(x[:40])
        return out[:limit]
    content = str(raw.get("content") or text or "").strip()
    keys = arr("keys", _simple_keys(content, cards))
    secondary = arr("secondary_keys", [], 6)
    category = str(raw.get("category") or "setting").strip()[:40]
    try:
        priority = int(raw.get("priority", 5))
    except Exception:
        priority = 5
    priority = max(1, min(10, priority))
    position = str(raw.get("position") or "before_char").strip()
    if position not in ("before_char", "after_char"):
        position = "before_char"
    selective = bool(raw.get("selective"))
    if not raw.get("selective") and secondary:
        selective = True
    entry = {
        "id": "lore_" + secrets.token_hex(4),
        "keys": keys,
        "content": content,
        "enabled": True,
        "constant": bool(raw.get("constant", False)),
        "selective": selective,
        "secondary_keys": secondary,
        "exclusion_keys": arr("exclusion_keys", [], 6),
        "priority": priority,
        "insertion_order": int(raw.get("insertion_order", priority * 10) or priority * 10),
        "position": position,
        "category": category,
        "source": "user_lore",
        "created_at": int(time.time()),
    }
    known_by = arr("known_by", [], 8)
    hidden_from = arr("hidden_from", [], 8)
    if known_by or hidden_from:
        entry["visibility"] = {"known_by": known_by, "hidden_from": hidden_from}
    return entry


def _classify_lore_entry(text, p, cards):
    names = [c.get("name", "") for c in cards or []]
    language = _ensure_world_language(p)
    sys = ((
        "Organize the user's natural-language story setting into a worldbook entry. Keep content and keyword values in English. "
        "Output strict JSON with optional category, content, keys, secondary_keys, selective, exclusion_keys, priority, position, constant, known_by, and hidden_from. "
        "Preserve the user's facts in content; keys are trigger terms; priority is 1-10; position is only before_char or after_char."
    ) if language == "en" else (
        "把用户的一条自然语言故事设定整理成世界书条目，content 与关键词值使用简体中文。"
        "输出严格 JSON，字段可包含 category、content、keys、secondary_keys、selective、"
        "exclusion_keys、priority、position、constant、known_by、hidden_from。"
        "content 保留用户设定的事实；keys 是触发词；priority 1-10；"
        "position 只能是 before_char 或 after_char。"
    ))
    user = json.dumps({
        "text": text,
        "characters": names,
        "response_language": language,
        "story_state": _effective_story_state(p),
        "recent_story": _scene_story_excerpt(p, response_language=language),
    }, ensure_ascii=False)
    try:
        out = actor.chat([{ "role": "system", "content": sys }, { "role": "user", "content": user }],
                         temperature=0.1, model=_active_model()).strip()
        raw = _json_from_model_text(out)
    except Exception:
        raw = {}
    return _normalize_lore_entry(raw, text, cards)


def ev_add_lore(ev):
    pid = ev["production_id"]
    p = load_production(pid)
    if not p:
        raise ValueError("production not found")
    text = (ev.get("content") or ev.get("text") or "").strip()
    if not text:
        raise ValueError("content is required")
    cards, _, _, _ = _loadout(p)
    if "content" in ev or "constant" in ev or "keys" in ev:
        constant = bool(ev.get("constant"))
        keys = ev.get("keys") or []
        if isinstance(keys, str):
            keys = [x.strip() for x in re.split(r"[,，、]", keys) if x.strip()]
        if not constant and not keys:
            raise ValueError("trigger keys are required")
        entry = _normalize_lore_entry({
            "content": text,
            "constant": constant,
            "keys": [] if constant else keys,
            "position": "before_char",
            "category": "setting",
        }, text, cards)
    else:
        entry = _classify_lore_entry(text, p, cards)

    with _production_lock(pid):
        p = load_production(pid)
        if not p:
            raise ValueError("production not found")
        wid = _prod_worldbook_id(pid)
        created = load_worldbook(wid) is None
        template = {
            "id": wid,
            "name": p.get("name", "当前世界") + " · 设定",
            "recursive": False,
            "entries": [],
            "owner_production_id": pid,
            "source_worldbook_id": wid,
        }

        def append_entry(worldbook):
            worldbook = dict(worldbook) if isinstance(worldbook, dict) else dict(template)
            worldbook["entries"] = [*(worldbook.get("entries") or []), entry]
            return worldbook

        wb = STATE_STORE.update("worldbooks", wid, append_entry, default=template)
        if wid not in p.get("worldbook_ids", []):
            p.setdefault("worldbook_ids", []).append(wid)
            try:
                save_production(p)
            except Exception:
                if created:
                    STATE_STORE.delete("worldbooks", wid)
                raise
        _replace_worldbook_projection(p, wb)
        return {"production": p, "worldbook": wb, "entry": entry}


def _find_world_lore(p, worldbook_id=None, entry_id=None, entry_index=None):
    for wb in p.get("worldbooks") or []:
        if worldbook_id and str(wb.get("id")) != str(worldbook_id):
            continue
        entries = wb.get("entries") or []
        if entry_id:
            for index, entry in enumerate(entries):
                if str(entry.get("id")) == str(entry_id):
                    return wb, entries, index, entry
        if entry_index is not None:
            try:
                index = int(entry_index)
            except (TypeError, ValueError):
                index = -1
            if 0 <= index < len(entries):
                return wb, entries, index, entries[index]
    return None, None, None, None


def _replace_worldbook_projection(production, worldbook):
    items = list(production.get("worldbooks") or [])
    for index, current in enumerate(items):
        if str((current or {}).get("id") or "") == str(worldbook.get("id") or ""):
            items[index] = worldbook
            break
    else:
        items.append(worldbook)
    production["worldbooks"] = items


def ev_update_lore(ev):
    content = (ev.get("content") or "").strip()
    if not content:
        raise ValueError("content is required")
    constant = bool(ev.get("constant"))
    keys = ev.get("keys") or []
    if isinstance(keys, str):
        keys = [x.strip() for x in re.split(r"[,，、]", keys) if x.strip()]
    if not constant and not keys:
        raise ValueError("trigger keys are required")
    pid = ev["production_id"]
    with _production_lock(pid):
        p = load_production(pid)
        if not p:
            raise ValueError("production not found")
        projected, _, _, _ = _find_world_lore(
            p, ev.get("worldbook_id"), ev.get("entry_id"), ev.get("entry_index"))
        if not projected or not _is_runtime_worldbook(projected):
            raise ValueError("lore entry not found")
        changed = {}

        def update_entry(worldbook):
            _, _, _, entry = _find_world_lore(
                {"worldbooks": [worldbook]}, worldbook.get("id"),
                ev.get("entry_id"), ev.get("entry_index"))
            if not entry:
                raise ValueError("lore entry not found")
            entry["content"] = content
            entry["constant"] = constant
            entry["keys"] = [] if constant else keys[:8]
            entry["updated_at"] = int(time.time())
            changed["entry"] = entry
            return worldbook

        wb = STATE_STORE.update("worldbooks", projected["id"], update_entry)
        _replace_worldbook_projection(p, wb)
        return {"production": p, "worldbook": wb, "entry": changed["entry"]}


def ev_delete_lore(ev):
    pid = ev["production_id"]
    with _production_lock(pid):
        p = load_production(pid)
        if not p:
            raise ValueError("production not found")
        projected, _, _, _ = _find_world_lore(
            p, ev.get("worldbook_id"), ev.get("entry_id"), ev.get("entry_index"))
        if not projected or not _is_runtime_worldbook(projected):
            raise ValueError("lore entry not found")
        removed = {}

        def delete_entry(worldbook):
            _, entries, index, _ = _find_world_lore(
                {"worldbooks": [worldbook]}, worldbook.get("id"),
                ev.get("entry_id"), ev.get("entry_index"))
            if entries is None:
                raise ValueError("lore entry not found")
            removed["entry"] = entries.pop(index)
            removed["index"] = index
            return worldbook

        wb = STATE_STORE.update("worldbooks", projected["id"], delete_entry)
        _replace_worldbook_projection(p, wb)
        deleted = removed["entry"]
        return {"production": p, "worldbook": wb,
                "deleted": deleted.get("id") or removed["index"]}


def ev_create_production(ev):
    requested = ev.get("card_ids") or [ev.get("card_id")]
    card_ids = []
    cards = []
    for cid in requested:
        if not cid or cid in card_ids:
            continue
        card = load_card(cid)
        if not card:
            raise ValueError("card not found: " + cid)
        card_ids.append(cid)
        cards.append(card)
    if not cards:
        raise ValueError("card_id is required")
    card = cards[0]
    pid = "prod_" + secrets.token_hex(4)
    wbs = ev.get("worldbook_ids")
    if wbs is None:
        wbs = []
        for c in cards:
            if c.get("character_book"):
                wid = "wb_" + c["id"]
                if wid not in wbs:
                    wbs.append(wid)
    greeting = ev.get("first_mes") or card.get("first_mes") or ""
    runtime_wbs = _materialize_worldbook_ids(pid, wbs or [])
    p = {"id": pid, "name": ev.get("name") or card.get("name"),
         "card_id": card["id"], "card_ids": card_ids, "worldbook_ids": runtime_wbs,
         "cards": cards,
         "persona_id": ev.get("persona_id"), "persona": ev.get("persona") or {},
         "created_at": int(time.time()), "status": "active", "runtime": {},
         "story": [_msg("char", greeting)] if greeting else []}
    _ensure_world_language(p, ev.get("locale"))
    _ensure_production_session(p)
    save_production(p)
    _set_active(pid)
    return {"production": p}


def ev_create_blank_production(ev):
    name = (ev.get("name") or "未命名世界").strip() or "未命名世界"
    pid = "prod_" + secrets.token_hex(4)
    wb_ids = ev.get("worldbook_ids") or []
    runtime_wbs = _materialize_worldbook_ids(pid, wb_ids)
    p = {"id": pid, "name": name,
         "card_id": None, "card_ids": [], "worldbook_ids": runtime_wbs,
         "cards": [],
         "persona_id": ev.get("persona_id"), "persona": ev.get("persona") or {},
         "created_at": int(time.time()), "status": "active", "runtime": {}, "story": []}
    _ensure_world_language(p, ev.get("locale"))
    _ensure_production_session(p)
    save_production(p)
    _set_active(pid)
    return {"production": p}


def ev_attach_card(ev):
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    cid = ev.get("card_id")
    card = load_card(cid)
    if not card:
        raise ValueError("card not found: " + str(cid))
    ids = _production_card_ids(p)
    if cid not in ids:
        ids.append(cid)
    p["card_ids"] = ids
    p.setdefault("card_id", ids[0])
    runtime_cast = _ensure_runtime_cast(p)
    characters = [c for c in runtime_cast.get("characters") or []
                  if isinstance(c, dict) and c.get("id") != cid]
    characters.append(_runtime_character(card))
    runtime_cast["characters"] = characters
    runtime_cast["revision"] = int(runtime_cast.get("revision") or 0) + 1
    runtime_cast["updated_at"] = int(time.time())
    _hydrate_runtime_cards(p)
    wid = "wb_" + cid
    if load_worldbook(wid) and wid not in p.get("worldbook_ids", []):
        runtime_id = _clone_worldbook_for_production(p["id"], wid)
        if runtime_id and runtime_id not in p.get("worldbook_ids", []):
            p.setdefault("worldbook_ids", []).append(runtime_id)
        _ensure_production_session(p)
    _mark_context_state_stale(p, "loadout_changed")
    save_production(p)
    return {"production": p}


def ev_update_cast(ev):
    pid = ev["production_id"]
    with _production_lock(pid):
        result = _ev_update_cast_locked(ev)
    # If a state job was already processing the old revision, make it retry
    # from the newly saved character state instead of leaving the batch due.
    _schedule_story_state(pid)
    return result


def _ev_update_cast_locked(ev):
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    cid = ev.get("card_id")
    runtime_cast = _ensure_runtime_cast(p)
    expected_revision = ev.get("expected_revision")
    current_revision = int(runtime_cast.get("revision") or 0)
    if expected_revision is not None:
        try:
            expected_revision = int(expected_revision)
        except (TypeError, ValueError):
            raise ValueError("invalid expected_revision")
        if expected_revision != current_revision:
            raise ProductionRevisionConflict(current_revision)
    card = next((c for c in (runtime_cast.get("characters") or []) if c.get("id") == cid), None)
    if not card:
        raise ValueError("character not found in current world")
    if "profile" in ev and isinstance(ev.get("profile"), dict):
        merged_profile = json.loads(json.dumps(card.get("profile") or {}, ensure_ascii=False))
        for section, values in ev["profile"].items():
            if isinstance(values, dict):
                merged_profile.setdefault(section, {}).update(values)
        card["profile"] = card_import.canonical_profile({**card, "profile": merged_profile})
    else:
        fields = ("name", "description", "personality")
        for field in fields:
            if field in ev:
                card[field] = str(ev.get(field) or "").strip()
        card["profile"] = card_import.canonical_profile(card)
    identity = card["profile"]["identity"]
    card["name"] = identity.get("name") or ""
    card["description"] = identity.get("description") or ""
    card["personality"] = card["profile"]["personality"].get("summary") or ""
    if "entry" in ev and isinstance(ev.get("entry"), dict):
        merged_entry = dict(card.get("entry") or {})
        merged_entry.update(ev["entry"])
        card["entry"] = card_import.canonical_entry({**card, "entry": merged_entry})
        card["scenario"] = card["entry"].get("initial_scenario") or ""
    elif "scenario" in ev:
        card["scenario"] = str(ev.get("scenario") or "").strip()
        card["entry"] = card_import.canonical_entry(card)
    if not card["name"]:
        raise ValueError("name is required")
    if "persistent_status" in ev:
        card["persistent_status"] = _normalize_persistent_status(ev.get("persistent_status") or {})
        card["status_updated_turn"] = _world_turns(p.get("story") or [])
    if "relationships" in ev and isinstance(ev.get("relationships"), list):
        valid_targets = {str(c.get("id")) for c in (runtime_cast.get("characters") or []) if c.get("id")}
        valid_targets.add("__user__")
        kept = []
        for relation in runtime_cast.get("relationships") or []:
            participants = [str(x) for x in (relation.get("participants") or [])]
            if cid not in participants:
                kept.append(relation)
                continue
        incoming = []
        current_turn = _world_turns(p.get("story") or [])
        for raw in ev.get("relationships") or []:
            if not isinstance(raw, dict):
                continue
            target = str(raw.get("target_id") or "")
            description = _clip_memory_text(raw.get("description"), 300)
            if not target or target == cid or target not in valid_targets or not description:
                continue
            incoming.append({
                "participants": [cid, target],
                "description": description,
                "updated_turn": current_turn,
            })
        runtime_cast["relationships"] = _normalize_relationships(
            kept + incoming, runtime_cast.get("characters") or [], p.get("persona") or {})
    card["updated_at"] = int(time.time())
    runtime_cast["revision"] = int(runtime_cast.get("revision") or 0) + 1
    runtime_cast["updated_at"] = int(time.time())
    _hydrate_runtime_cards(p)
    p["turn_plan"] = {}
    save_production(p)
    return {"production": p, "card": card}


def ev_detach_card(ev):
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    cid = ev.get("card_id")
    ids = [x for x in _production_card_ids(p) if x != cid]
    p["card_ids"] = ids
    p["card_id"] = ids[0] if ids else None
    runtime_cast = _ensure_runtime_cast(p)
    runtime_cast["characters"] = [c for c in (runtime_cast.get("characters") or [])
                                  if isinstance(c, dict) and c.get("id") != cid]
    runtime_cast["relationships"] = [r for r in (runtime_cast.get("relationships") or [])
                                     if cid not in (r.get("participants") or [])]
    runtime_cast["revision"] = int(runtime_cast.get("revision") or 0) + 1
    runtime_cast["updated_at"] = int(time.time())
    _hydrate_runtime_cards(p)
    source_wid = "wb_" + str(cid)
    kept_worldbook_ids = []
    for wid in p.get("worldbook_ids", []):
        wb = load_worldbook(wid)
        if wb and wb.get("owner_production_id") == p["id"] and wb.get("source_worldbook_id") == source_wid:
            try:
                STATE_STORE.delete("worldbooks", wid)
            except OSError:
                pass
            continue
        kept_worldbook_ids.append(wid)
    p["worldbook_ids"] = kept_worldbook_ids
    _ensure_production_session(p)
    _mark_context_state_stale(p, "loadout_changed")
    save_production(p)
    return {"production": p}


def ev_delete_card(ev):
    cid = ev.get("card_id")
    if not cid:
        raise ValueError("card_id is required")
    if not load_card(cid):
        raise ValueError("card not found: " + str(cid))
    STATE_STORE.delete("cards", cid)
    STATE_STORE.delete("worldbooks", "wb_" + cid)
    changed = []
    for prod in _list_productions():
        if not prod:
            continue
        ids = [x for x in _production_card_ids(prod) if x != cid]
        source_wid = "wb_" + cid
        wids = []
        for wid in prod.get("worldbook_ids", []):
            wb = load_worldbook(wid)
            if wb and wb.get("owner_production_id") == prod["id"] and wb.get("source_worldbook_id") == source_wid:
                try:
                    STATE_STORE.delete("worldbooks", wid)
                except OSError:
                    pass
                continue
            wids.append(wid)
        if ids != _production_card_ids(prod) or wids != prod.get("worldbook_ids", []):
            prod["card_ids"] = ids
            prod["card_id"] = ids[0] if ids else None
            prod["worldbook_ids"] = wids
            runtime_cast = _ensure_runtime_cast(prod)
            runtime_cast["characters"] = [c for c in (runtime_cast.get("characters") or [])
                                          if c.get("id") != cid]
            runtime_cast["relationships"] = [r for r in (runtime_cast.get("relationships") or [])
                                             if cid not in (r.get("participants") or [])]
            runtime_cast["revision"] = int(runtime_cast.get("revision") or 0) + 1
            _hydrate_runtime_cards(prod)
            save_production(prod)
            changed.append(prod["id"])
    return {"deleted": cid, "updated_productions": changed}


# Q_C：切走剧组时后台自动复盘（达阈值才做），不阻塞切换、不靠主理人自觉（结构性 > 软性）。
AUTO_REFLECT_MIN = int(os.environ.get("ACTOR_AUTO_REFLECT_MIN", "15"))
AUTO_REFLECT_EVERY = int(os.environ.get("ACTOR_AUTO_REFLECT_EVERY", "15"))


def _maybe_auto_reflect(pid):
    p = load_production(pid)
    if not p:
        return
    uturns = sum(1 for m in p.get("story", []) if m.get("role") == "user")
    done = p.get("reflected_at_turns", 0)
    if uturns < AUTO_REFLECT_MIN or uturns - done < AUTO_REFLECT_EVERY:
        return
    try:
        _reflect_production(p)
        _merge_production_fields(pid, reflected_at_turns=uturns)
    except Exception:
        pass  # 后台尽力而为，失败不影响任何前台操作


def _schedule_actor_reflect(pid):
    """Run one non-blocking preference reflection for each completed 15-turn batch."""
    p = load_production(pid)
    if not p:
        return False
    user_turns = sum(1 for message in p.get("story", []) if message.get("role") == "user")
    reflected = int(p.get("reflected_at_turns") or 0)
    if user_turns < AUTO_REFLECT_MIN or user_turns - reflected < AUTO_REFLECT_EVERY:
        return False
    key = ("auto_reflect", pid)
    was_active = BACKGROUND_JOBS.is_active(key)
    accepted = BACKGROUND_JOBS.submit(key, _maybe_auto_reflect, pid)
    return bool(accepted and not was_active)


def ev_switch_loadout(ev):
    prev = _get_state().get("active_production_id")
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    language_before = (p.get("language_mode"), p.get("response_language"), p.get("language_source"))
    _ensure_world_language(p, ev.get("locale"))
    language_after = (p.get("language_mode"), p.get("response_language"), p.get("language_source"))
    if language_after != language_before:
        save_production(p)
    _set_active(p["id"])
    if prev and prev != p["id"]:  # Q_C：离开一场戏 = 复盘它的自然时机（后台线程，不阻塞切换）
        BACKGROUND_JOBS.submit(("auto_reflect", prev), _maybe_auto_reflect, prev)
    return {"production": p}


def ev_delete_production(ev):
    # 删一个剧组(连同它的故事线 story)——不可逆,前端走二次确认(Task 4)。
    # 删的若是当前活跃剧组,active 切到剩下的第一个、没有则清空。
    pid = ev["production_id"]
    p = load_production(pid)
    if not p:
        raise ValueError("production not found")
    _consume_destructive_confirmation(
        ev.get("confirmation_token"), "delete_production", pid
    )
    STATE_STORE.delete("productions", pid)
    # Delete every production-owned canonical book; reusable templates remain.
    for wid in p.get("worldbook_ids", []):
        wb = load_worldbook(wid)
        if wb and wb.get("owner_production_id") == pid:
            try:
                STATE_STORE.delete("worldbooks", wid)
            except OSError:
                pass
    new_active = _get_state().get("active_production_id")
    if new_active == pid:
        remaining = [x for x in _list("productions") if x]
        new_active = remaining[0]["id"] if remaining else None
        _set_active(new_active)
    try:
        story_profile.sync_story_states(STATE, SEED_ACTOR, _list_productions())
    except Exception as error:
        print(f"[story-profile] story memory sync failed after delete: {error}", flush=True)
    return {"deleted": pid, "active": new_active}


def ev_prepare_delete_production(ev):
    pid = ev.get("production_id")
    p = load_production(pid) if pid else None
    if not p:
        raise ValueError("production not found")
    token = _prepare_destructive_confirmation("delete_production", pid)
    return {
        "confirmation_token": token,
        "expires_in": DESTRUCTIVE_CONFIRM_TTL,
        "production": {
            "id": p["id"],
            "name": p.get("name") or "未命名世界",
            "story_count": len(p.get("story") or []),
        },
    }


def _production_card_ids(p):
    ids = p.get("card_ids") or ([] if not p.get("card_id") else [p.get("card_id")])
    out = []
    for cid in ids:
        if cid and cid not in out:
            out.append(cid)
    return out


def _snapshot_worldbooks(ids):
    out = []
    for wid in ids or []:
        wb = load_worldbook(wid)
        if wb:
            out.append(wb)
    return out


def _migrate_worldbook_storage():
    """Move legacy embedded snapshots into production-owned canonical files."""
    migrated = 0
    for raw in _list("productions"):
        if not raw:
            continue
        pid = raw.get("id")
        if not pid:
            continue
        embedded = [w for w in (raw.get("worldbooks") or []) if isinstance(w, dict)]
        embedded_by_id = {str(w.get("id") or ""): w for w in embedded}
        ordered_ids = list(raw.get("worldbook_ids") or [])
        for wb in embedded:
            wid = wb.get("id")
            if wid and wid not in ordered_ids:
                ordered_ids.append(wid)
        canonical_ids = []
        for wid in ordered_ids:
            wb = embedded_by_id.get(str(wid)) or load_worldbook(wid)
            if not wb:
                continue
            owned = wb.get("owner_production_id") == pid and _is_runtime_worldbook(wb)
            legacy_local = wid == _prod_worldbook_id(pid)
            if owned or legacy_local:
                canonical_id = wid
                canonical = json.loads(json.dumps(wb, ensure_ascii=False))
                canonical["id"] = canonical_id
                canonical["owner_production_id"] = pid
                canonical.setdefault("source_worldbook_id", wid)
                STATE_STORE.write("worldbooks", canonical_id, canonical)
            else:
                source_id = wb.get("source_worldbook_id") or wid
                canonical_id = _runtime_worldbook_id(pid, source_id)
                canonical = json.loads(json.dumps(wb, ensure_ascii=False))
                canonical["id"] = canonical_id
                canonical["source_worldbook_id"] = source_id
                canonical["owner_production_id"] = pid
                STATE_STORE.write("worldbooks", canonical_id, canonical)
            if canonical_id not in canonical_ids:
                canonical_ids.append(canonical_id)
        changed = raw.get("worldbooks") is not None or canonical_ids != list(raw.get("worldbook_ids") or [])
        if changed:
            raw["worldbook_ids"] = canonical_ids
            raw.pop("worldbooks", None)
            STATE_STORE.write("productions", pid, raw)
            migrated += 1
    return migrated



def _ensure_runtime_cast(production):
    return _continuity_ensure_runtime_cast(production, load_card, _production_card_ids)


def _hydrate_runtime_cards(production):
    return _continuity_hydrate_runtime_cards(production, load_card, _production_card_ids)


def _hydrate_user_persona(production):
    return _continuity_hydrate_user_persona(production)

def _ensure_production_session(p):
    """Hydrate current-story projections; runtime_cast is the sole cast authority."""
    if p is None:
        return p
    p["persona"] = _normalize_persona(p.get("persona") or {})
    _hydrate_runtime_cards(p)
    _hydrate_user_persona(p)
    p["worldbooks"] = _snapshot_worldbooks(p.get("worldbook_ids") or [])
    p.setdefault("story", [])
    p.setdefault("runtime", {})
    return p


def _mark_context_state_stale(p, reason="context_changed"):
    p["turn_plan"] = {}
    p.setdefault("runtime", {})["state_stale_reason"] = reason
    p["runtime"].pop("last_prompt_debug", None)


def _mark_story_state_stale(p, reason="history_changed"):
    _mark_context_state_stale(p, reason)
    if isinstance(p.get("story_state"), dict):
        p["story_state"]["stale"] = True


def _loadout(p):
    """一回合演出要喂的料:当前故事角色快照 + 世界书快照 + 人设 + 作者注释。"""
    _ensure_production_session(p)
    cards = [c for c in (p.get("cards") or []) if isinstance(c, dict)]
    wbs = [w for w in (p.get("worldbooks") or []) if isinstance(w, dict)]
    persona = p.get("persona") or {}
    note = p.get("author_note", "")
    return cards, wbs, persona, note


def _perform_into(p):
    cards, wbs, persona, note = _loadout(p)
    turn_plan = _prepare_turn_plan(p, cards)
    language = _ensure_world_language(p)
    return actor.perform(cards, wbs, persona, p["story"], note,
                         model=_active_model(), story_state=_effective_story_state(p),
                         turn_plan=turn_plan,
                         response_language=language)  # 用户自配大模型;None=内置模型


def ev_send_message(ev):
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    expected_story_signature = _story_content_signature(p.get("story") or [])
    _observe_user_language(p, ev["text"], ev.get("locale"))
    user_msg = _msg("user", ev["text"])
    p["story"].append(user_msg)
    cards, wbs, persona, note = _loadout(p)
    reply = _ensure_actor_reply(p, cards, wbs, persona, note, _perform_into(p))
    _raise_if_generation_cancelled(ev)
    m = _msg("char", reply)
    p["story"].append(m)
    _commit_foreground_story(p, expected_story_signature)
    state_sync = _story_state_sync_trigger(p["id"])
    _schedule_story_state(p["id"])
    _schedule_actor_reflect(p["id"])
    return {"reply": reply, "message": m, "user_message": user_msg,
            "production_id": p["id"], "state_sync": state_sync}


def ev_regenerate(ev):
    p = load_production(ev["production_id"])
    if not p or not p["story"]:
        raise ValueError("nothing to regenerate")
    expected_story_signature = _story_content_signature(p.get("story") or [])
    _ensure_world_language(p, ev.get("locale"))
    # 砍掉最后一条 char，重演（保留为 alt）
    last = p["story"][-1]
    if last["role"] != "char":
        raise ValueError("last message is not the actor's")
    trimmed = p["story"][:-1]
    saved_story = p["story"]
    p["story"] = trimmed
    _mark_context_state_stale(p, "regenerate")
    cards, wbs, persona, note = _loadout(p)
    reply = _ensure_actor_reply(p, cards, wbs, persona, note, _perform_into(p))
    _raise_if_generation_cancelled(ev)
    last["alts"].append(reply)
    last["active_alt"] = len(last["alts"]) - 1
    last["text"] = reply
    p["story"] = saved_story
    _commit_foreground_story(p, expected_story_signature)
    state_sync = _story_state_sync_trigger(p["id"])
    _schedule_story_state(p["id"])
    return {"message": last, "production_id": p["id"], "state_sync": state_sync}


def _continue_note(note: str = "", response_language: str = "zh") -> str:
    if _locale_code(response_language) == "en":
        instruction = (
            "Continue from the current story in English and advance to the next natural narrative beat. "
            "Prefer the result of the next action, a new scene fragment, or a small passage of time so the situation changes perceptibly. "
            "Do not repeat the same emotion, action, or information. Keep action, environment, and dialogue coherent, and leave room for the user to respond."
        )
    else:
        instruction = (
            "结合目前的剧情进展，使用简体中文承接最后一条用户输入，推进到下一个自然剧情节点。"
            "优先选择下一个动作结果、下一个场景片段或轻微时间推进；让局面出现可感知的新变化。"
            "不要停留在原地反复解释同一种情绪、同一个动作或同一句信息；推进要克制，动作、环境与角色对白要自然连贯，并留下可继续回应的空间。"
        )
    return (note + "\n" if note else "") + instruction


def _format_actor_paragraph(para: str) -> str:
    para = (para or "").strip()
    if not para:
        return ""
    # If a paragraph contains dialogue, keep the whole paragraph unitalicized.
    # Pure narration paragraphs are the only paragraphs wrapped in *...*.
    if "「" in para or "」" in para or re.match(r"^[\w\u4e00-\u9fff·]{1,12}：「[\s\S]*」$", para):
        return para.replace("*", "").strip()
    # Already-wrapped pure narration stays wrapped.
    if para.startswith("*") and para.endswith("*"):
        return para
    clean = para.replace("*", "").strip()
    return "*" + clean + "*" if clean else ""


def _normalize_actor_reply(text: str) -> str:
    """Normalize generated actor text for tavern rendering without rewriting story content."""
    text = (text or "").strip()
    if not text:
        return ""
    text = (text.replace("**", "*")
                .replace("“", "「").replace("”", "」")
                .replace("『", "「").replace("』", "」"))
    out = []
    open_quote = True
    for ch in text:
        if ch == '"':
            out.append("「" if open_quote else "」")
            open_quote = not open_quote
        else:
            out.append(ch)
    text = "".join(out)
    text = re.sub(r"(^|\n)([\w\u4e00-\u9fff·]{1,12}):(?=「)", r"\1\2：", text)
    paras = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]
    formatted = [_format_actor_paragraph(p) for p in paras]
    return "\n\n".join(p for p in formatted if p)

def _ensure_actor_reply(p, cards, wbs, persona, note, text):
    text = _normalize_actor_reply(text)
    if text:
        return text
    language = _ensure_world_language(p)
    retry_instruction = ("Continue from the user's latest message with one coherent story response in English. Keep action, environment, and character dialogue naturally connected."
                         if language == "en" else
                         "承接最后一条用户输入，使用简体中文续写当前故事的一段内容。动作、环境与角色对白要自然连贯。")
    retry_note = (note + "\n" if note else "") + retry_instruction
    try:
        text = _normalize_actor_reply(actor.perform(cards, wbs, persona, p["story"], retry_note,
                                                    model=_active_model(), story_state=_effective_story_state(p),
                                                    turn_plan=_prepare_turn_plan(p, cards),
                                                    response_language=language))
    except Exception as e:
        print("actor retry failed:", repr(e), file=sys.stderr, flush=True)
        raise RuntimeError("模型暂时没有返回内容，请稍后重试。")
    if not text:
        print("actor retry returned empty", file=sys.stderr, flush=True)
        raise RuntimeError("模型暂时没有返回内容，请稍后重试。")
    return text

def ev_continue(ev):
    """场景继续：真实追加一条用户侧 *剧情继续*，再让角色接着演。"""
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    expected_story_signature = _story_content_signature(p.get("story") or [])
    language = _ensure_world_language(p, ev.get("locale"))
    user_msg = _msg("user", ev.get("text") or ("*Continue the story.*" if language == "en" else "*剧情继续*"))
    p["story"].append(user_msg)
    cards, wbs, persona, note = _loadout(p)
    continue_note = _continue_note(note, language)
    turn_plan = _prepare_turn_plan(p, cards)
    reply = actor.perform(cards, wbs, persona, p["story"], continue_note,
                          model=_active_model(), story_state=_effective_story_state(p),
                          turn_plan=turn_plan,
                          response_language=language)
    reply = _ensure_actor_reply(p, cards, wbs, persona, continue_note, reply)
    _raise_if_generation_cancelled(ev)
    m = _msg("char", reply)
    p["story"].append(m)
    _commit_foreground_story(p, expected_story_signature)
    state_sync = _story_state_sync_trigger(p["id"])
    _schedule_story_state(p["id"])
    _schedule_actor_reflect(p["id"])
    return {"reply": reply, "user_message": user_msg, "message": m,
            "production_id": p["id"], "state_sync": state_sync}


def _compact_story_context(card, story, max_turns=8, response_language="zh"):
    lines = []
    en = _locale_code(response_language) == "en"
    cname = card.get("name", "Character" if en else "角色")
    for m in (story or [])[-max_turns:]:
        who = ("User" if en else "用户") if m.get("role") == "user" else cname
        text = (m.get("text") or "").strip().replace("\r\n", "\n")
        lines.append(f"{who}: {text[:700]}")
    return "\n".join(lines)


def _parse_suggestions(raw):
    raw = (raw or "").strip()
    suggestions = []
    try:
        data = json.loads(raw)
    except Exception:
        start, end = raw.find("["), raw.rfind("]")
        if start != -1 and end != -1 and end > start:
            try:
                data = json.loads(raw[start:end + 1])
            except Exception:
                data = None
        else:
            data = None
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                item = item.get("text") or item.get("reply") or item.get("content")
            x = _normalize_actor_reply(str(item or ""))
            if x:
                suggestions.append(x)
        return suggestions

    # Fallback for older models: accept only explicit bullet/numbered items.
    # Never split plain prose by line, otherwise one incomplete answer becomes 3 fake suggestions.
    for ln in raw.splitlines():
        x = ln.strip()
        if not x:
            continue
        item = None
        if x.startswith("- "):
            item = x[2:].strip()
        elif len(x) >= 2 and x[0].isdigit() and x[1] in ".、)）":
            item = x[2:].strip()
        if item:
            item = _normalize_actor_reply(item)
            if item:
                suggestions.append(item)
    return suggestions if len(suggestions) >= 3 else []


def ev_suggest(ev):
    """根据当前上下文，生成 3 条用户可选回复，供用户点选填入输入框。不修改 story。"""
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    language = _ensure_world_language(p, ev.get("locale"))
    en = language == "en"
    cards, wbs, persona, note = _loadout(p)
    lore = actor.select_lore(wbs, p["story"])
    lore_txt = "\n".join("- " + (e.get("content") or "")[:500] for e in lore[:4])
    persona_txt = actor.user_character_block(persona, language)
    primary = cards[0] if cards else {}
    ctx = _compact_story_context(primary, p["story"], response_language=language)
    if en:
        prompt = f"""# Character
Name: {primary.get('name','')}
Personality: {(primary.get('personality') or '')[:700]}
Scenario: {(primary.get('scenario') or '')[:700]}

# User persona
{persona_txt or '(Not set)'}

# Relevant world lore
{lore_txt or '(None)'}

# Recent story
{ctx}

Write exactly three complete messages the user could send next. Every option must respond directly to the final character message above.
Use three distinct directions:
1. Emotional response: engage with the character's current feeling or attitude.
2. Character interaction: ask, test, approach, offer, or act in a way that develops the relationship.
3. Plot movement: take an action, change the scene, or trigger the next event.

Format rules:
{actor.user_input_format_rules(language)}
- Make every option specific to this story rather than a reusable template.
- Do not invent intimacy, shared history, physical contact, or facts that have not appeared.
- Output only a valid JSON array containing exactly three strings. No Markdown, numbering, or explanation.
- Example: ["*I stop beside the stone steps and lower my voice.*\n\n「What would you like me to call you?」", "Second complete reply", "Third complete reply"]
"""
        system = "You generate smart reply options for a roleplay scene. Write only the user's next sendable messages, grounded in the current story, in English."
        repair_system = "Output only a valid JSON array containing exactly three English strings. No Markdown or explanation."
        repair_user = "Rewrite the content below as three complete messages the user can send. Return only a valid JSON array; do not truncate any item.\n\n"
    else:
        prompt = f"""# 角色
名字：{primary.get('name','')}
性格：{(primary.get('personality') or '')[:700]}
场景：{(primary.get('scenario') or '')[:700]}

# 用户扮演者
{persona_txt or '（未设置）'}

# 相关世界设定
{lore_txt or '（无）'}

# 最近剧情
{ctx}

请给出 3 条用户接下来可直接发送的完整回复，必须紧扣【最近剧情】最后一条角色回复。
三条方向不同：
1. 情绪回应：接住角色此刻情绪或态度。
2. 人物互动：用靠近、追问、试探、递动作等方式推进两人关系。
3. 剧情推进：提出行动、改变场景或触发下一步事件。

规则：
{actor.user_input_format_rules(language)}
- 每条都必须是完整用户输入，不是短句提示；可以包含多段动作、心理和对白。
- 每条都必须能看出它来自当前剧情，不要泛泛模板。
- 不要假定未出现的亲密关系、共同过去、身体接触或剧情事实。
- 只输出 JSON 数组，数组内正好 3 个字符串；不要 Markdown，不要编号，不要解释。
- 示例：["*我在石阶旁停下，放轻声音。*\n\n「那你希望我怎么称呼你？」", "第二条完整回复", "第三条完整回复"]
"""
        system = "你是角色扮演场景的智能回复建议器。你只帮用户写下一句可发送输入。必须结合当前剧情，全部使用简体中文，不要泛泛模板。"
        repair_system = "只输出合法 JSON 数组，正好 3 个简体中文字符串。不要 Markdown，不要解释。"
        repair_user = "把下面内容改写为 3 条完整、可直接发送的简体中文用户回复。只输出合法 JSON 数组，每条必须完整，不能截断。\n\n"
    msgs = [
        {"role": "system", "content": system},
        {"role": "user", "content": prompt},
    ]
    raw = actor.chat(msgs, temperature=0.75, model=_active_model())
    suggestions = _parse_suggestions(raw)
    if not suggestions:
        repair = [
            {"role": "system", "content": repair_system},
            {"role": "user", "content": repair_user + raw},
        ]
        raw = actor.chat(repair, temperature=0.35, model=_active_model())
        suggestions = _parse_suggestions(raw)
    return {"suggestions": suggestions[:3]}


def ev_swipe(ev):
    # 在已有备选回复(alts)间切换 active_alt(非破坏性,dir ∈ -1/+1,边界夹住)。
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    expected_story_signature = _story_content_signature(p.get("story") or [])
    latest = p["story"][-1] if p.get("story") else None
    if not latest or latest.get("role") != "char" or latest.get("id") != ev.get("message_id"):
        raise ValueError("only the latest reply can switch alternatives")
    for m in (latest,):
        if m["id"] == ev["message_id"]:
            alts = m.get("alts") or [m.get("text", "")]
            cur = m.get("active_alt", 0)
            nxt = max(0, min(len(alts) - 1, cur + int(ev.get("dir", 0))))
            m["active_alt"] = nxt
            m["text"] = alts[nxt]
            _mark_context_state_stale(p, "swipe")
            _commit_foreground_story(p, expected_story_signature)
            return {"message": m}
    raise ValueError("message not found")


def ev_edit_message(ev):
    """Edit only the latest visible turn; confirmed compressed history is immutable."""
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    story = p.get("story") or []
    if not story:
        raise ValueError("message not found")
    expected_story_signature = _story_content_signature(story)
    editable_ids = {story[-1].get("id")}
    if story[-1].get("role") == "char" and len(story) >= 2 and story[-2].get("role") == "user":
        editable_ids.add(story[-2].get("id"))
    if ev.get("message_id") not in editable_ids:
        raise ValueError("only the latest turn can be edited")
    for i, m in enumerate(story):
        if m.get("id") == ev["message_id"]:
            text = ev.get("text", "")
            m["text"] = text
            alts = m.get("alts")
            if isinstance(alts, list) and alts:
                idx = max(0, min(len(alts) - 1, int(m.get("active_alt", 0))))
                m["active_alt"] = idx
                alts[idx] = text
            else:
                m["alts"] = [text]
                m["active_alt"] = 0
            removed = len(story) - i - 1
            p["story"] = story[:i + 1]
            if m.get("role") == "user" and text.strip():
                _observe_user_language(p, text, ev.get("locale"))
            _mark_context_state_stale(p, "edit_message")
            reply_msg = None
            if ev.get("continue_after") and m.get("role") == "user" and text.strip():
                cards, wbs, persona, note = _loadout(p)
                reply = _ensure_actor_reply(p, cards, wbs, persona, note, _perform_into(p))
                _raise_if_generation_cancelled(ev)
                reply_msg = _msg("char", reply)
                p["story"].append(reply_msg)
            _commit_foreground_story(p, expected_story_signature)
            state_sync = {"watch": False, "revision": 0}
            if reply_msg:
                state_sync = _story_state_sync_trigger(p["id"])
                _schedule_story_state(p["id"])
            return {"message": m, "reply": reply_msg, "story": p["story"],
                    "truncated": removed, "state_sync": state_sync}
    raise ValueError("message not found")


# ---------- 结构化故事档案 ----------
# story_profile.json 是唯一生效来源；actor_self.md 仅为兼容展示。
_ACTOR_SELF_LOCK = threading.RLock()


def _record_actor_learning(change, reason, ts=None, source_type="reflection"):
    with _ACTOR_SELF_LOCK:
        merged, event = story_profile.record_learning(
            STATE, SEED_ACTOR, change, reason, ts, source_type=source_type)
    if event:
        try:
            _refresh_taste_profile()
        except Exception as error:
            print(f"[story-profile] taste refresh failed: {error}", flush=True)
    return merged, event


def ev_actor_grow(ev):
    """Persist an explicit, durable story preference."""
    change = ev.get("change", "")
    merged, audit = _record_actor_learning(
        change, ev.get("reason", "") or "(无理由)", ev.get("ts"), source_type="explicit")
    return {"ok": True, "knows": merged, "appended": audit}


def _json_from_model_text(out):
    try:
        return json.loads(out)
    except Exception:
        start, end = out.find("{"), out.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(out[start:end + 1])
            except Exception:
                return {}
    return {}


def _refresh_taste_profile():
    """Aggregate model-derived preference notes into a bounded user taste profile."""
    profile = story_profile.ensure_profile(STATE, SEED_ACTOR)
    preferences = story_profile.preference_texts(profile)
    if not preferences:
        empty = {key: [] for key in story_profile.TASTE_PROFILE_FIELDS}
        return story_profile.set_taste_profile(STATE, SEED_ACTOR, empty)
    schema = {key: ["string"] for key in story_profile.TASTE_PROFILE_FIELDS}
    prompt = (
        "你是故事口味档案整理员。根据已有的模型复盘条目，归纳用户稳定的故事偏好。\n"
        "只归纳输入中有证据支持的内容，不补写剧情，不推测现实人格，不把临时剧情状态当成偏好。\n"
        "相近内容合并；每个字段最多四项；证据不足的字段输出空数组。\n"
        "character_styles=偏爱的角色类型或特质；relationship_dynamics=偏爱的人物关系与互动张力；"
        "story_themes=偏爱的世界、题材与主题；pacing=节奏与推进偏好；"
        "narrative_style=叙事视角、描写与文风；interaction_preferences=用户参与和选择方式；"
        "boundaries=明确不希望出现的模式。\n"
        "只输出严格 JSON，键必须完整且只能使用以下结构：\n"
        + json.dumps(schema, ensure_ascii=False)
    )
    source = "\n".join(f"- {item}" for item in preferences)
    out = actor.chat(
        [{"role": "system", "content": prompt},
         {"role": "user", "content": source}],
        temperature=0.2,
        model=_active_model(),
        max_tokens=1200,
    )
    parsed = _json_from_model_text(out)
    if not isinstance(parsed, dict) or any(
            key not in parsed or not isinstance(parsed.get(key), list)
            for key in story_profile.TASTE_PROFILE_FIELDS):
        raise ValueError("taste profile model output does not match the required schema")
    return story_profile.set_taste_profile(STATE, SEED_ACTOR, parsed)


def ev_refresh_story_profile(ev):
    worlds = story_profile.sync_story_states(
        STATE, SEED_ACTOR, _list_productions())
    taste = _refresh_taste_profile()
    return {
        "ok": True,
        "worlds": len(worlds),
        "taste_fields": sum(1 for value in taste.values() if value),
        "profile": story_profile.audit(STATE, SEED_ACTOR),
    }


def _card_names(cards):
    return [str(c.get("name") or "角色").strip() for c in cards if str(c.get("name") or "").strip()]




def _closest_card_name(value, names):
    s = str(value or "").strip()
    if not s:
        return ""
    if s in names:
        return s
    folded = s.casefold()
    for n in names:
        if n and str(n).casefold() == folded:
            return n
    for n in names:
        if n and (n in s or s in n):
            return n
    return ""

def _scene_story_excerpt(p, max_items=12, response_language=None):
    language = response_language or _ensure_world_language(p)
    en = language == "en"
    cname = "Story response" if en else "故事回复"
    lines = []
    for m in (p.get("story") or [])[-max_items:]:
        who = ("User" if en else "用户") if m.get("role") == "user" else cname
        text = (m.get("text") or "").strip().replace("\r\n", "\n")
        if text:
            lines.append(f"{who}: {text[:700]}")
    return "\n".join(lines)


def _build_turn_plan(p, cards):
    if len(cards) <= 1:
        return {}
    language = _ensure_world_language(p)
    en = language == "en"
    names = _card_names(cards)
    sys = ((
        "You schedule a multi-character interactive story. Based on the current scene, active characters, and the user's latest message, create a very short turn plan in English. "
        "Do not write story prose or explanations. Output strict JSON with only primary_speaker, supporting_characters, silent_characters, narration_goal, and do_not. "
        "primary_speaker is a string; the other fields are strings or string arrays. Not every character must speak. Prefer the addressed or most motivated character and preserve knowledge boundaries."
    ) if en else (
        "你是互动故事的场面调度。根据当前场景、登场角色和用户最新输入，为下一次角色扮演回复制定极短的简体中文调度。"
        "不要写正文，不要解释。输出严格 JSON，字段只有 primary_speaker、supporting_characters、silent_characters、"
        "narration_goal、do_not。primary_speaker 是字符串，其余是字符串数组或字符串。"
        "原则：不要求所有角色说话；优先回应被用户点名或最有动机的人；保护角色知识边界。"
    ))
    plot = _effective_story_state(p)
    user = json.dumps({
        "characters": [{"id": c.get("id"), "name": c.get("name"),
                        "profile": c.get("profile") or {},
                        "persistent_status": c.get("persistent_status") or {},
                        "relationships": c.get("relationships") or []} for c in cards],
        "story_state": {key: plot.get(key) for key in
                        ("timeline", "facts", "open_threads", "objects", "secrets", "scene", "style_notes")},
        "response_language": language,
        "recent_story": _scene_story_excerpt(p, response_language=language),
    }, ensure_ascii=False)
    out = actor.chat([{"role": "system", "content": sys}, {"role": "user", "content": user}],
                     temperature=0.15, model=_active_model()).strip()
    raw = _json_from_model_text(out)

    def clean_arr(v, limit=6):
        if isinstance(v, str):
            v = [v]
        out = []
        for x in v or []:
            s = str(x).strip().lstrip("-•").strip()
            fixed = _closest_card_name(s, names) or s[:120]
            if fixed and fixed not in out:
                out.append(fixed)
        return out[:limit]

    primary = _closest_card_name(raw.get("primary_speaker"), names)
    return {
        "primary_speaker": primary,
        "supporting_characters": clean_arr(raw.get("supporting_characters")),
        "silent_characters": clean_arr(raw.get("silent_characters")),
        "narration_goal": str(raw.get("narration_goal") or "").strip()[:180],
        "do_not": clean_arr(raw.get("do_not")),
    }


def _prepare_turn_plan(p, cards):
    try:
        return _build_turn_plan(p, cards)
    except Exception:
        return {}


def _world_turns(story):
    return sum(1 for m in story or [] if m.get("role") == "user")


def _compressible_story_turns(story):
    """Keep the latest user turn raw and compress only confirmed history."""
    return max(0, _world_turns(story) - 1)


STORY_STATE_BATCH_TURNS = int(os.environ.get("TAVERN_STORY_STATE_BATCH_TURNS", "15"))
STORY_STATE_MAX_CHARS = max(4000, int(os.environ.get("TAVERN_STORY_STATE_MAX_CHARS", "15000")))
STORY_STATE_BATCH_TOKEN_BUDGET = max(
    8000, int(os.environ.get("TAVERN_STORY_STATE_BATCH_TOKEN_BUDGET", "50000")))


def _story_lines_for_turns(p, start_turn, end_turn):
    """Render complete story messages for an inclusive user-turn batch."""
    en = _ensure_world_language(p) == "en"
    cname = "Story response" if en else "故事回复"
    lines = []
    seen_turns = 0
    for message in p.get("story") or []:
        if message.get("role") == "user":
            seen_turns += 1
        if seen_turns < start_turn:
            if start_turn == 1 and seen_turns == 0:
                pass
            else:
                continue
        if seen_turns > end_turn:
            break
        text = (message.get("text") or "").strip().replace("\r\n", "\n")
        if not text:
            continue
        who = ("User" if en else "用户") if message.get("role") == "user" else cname
        turn_label = max(0, seen_turns)
        prefix = f"[Turn {turn_label} · {who}]" if en else f"[第 {turn_label} 轮 · {who}]"
        lines.append(f"{prefix}\n{text}")
    return "\n".join(lines)


def _story_batch_segments(p, start_turn, end_turn):
    """Split an oversized batch only at complete user-turn boundaries."""
    segments = []
    segment_start = start_turn
    segment_end = start_turn - 1
    segment_parts = []
    segment_tokens = 0
    for turn in range(start_turn, end_turn + 1):
        part = _story_lines_for_turns(p, turn, turn)
        part_tokens = _estimate_text_tokens(part)
        if segment_parts and segment_tokens + part_tokens > STORY_STATE_BATCH_TOKEN_BUDGET:
            segments.append((segment_start, segment_end, "\n".join(segment_parts)))
            segment_start = turn
            segment_parts = []
            segment_tokens = 0
        segment_parts.append(part)
        segment_tokens += part_tokens
        segment_end = turn
    if segment_parts:
        segments.append((segment_start, segment_end, "\n".join(segment_parts)))
    return segments


def _estimate_text_tokens(text):
    """Cheap trigger-only token estimate: CJK ~= 1 token, other text ~= 4 chars/token."""
    cjk = 0
    other = 0
    for ch in text or "":
        if "一" <= ch <= "鿿" or "぀" <= ch <= "ヿ" or "가" <= ch <= "힯":
            cjk += 1
        elif not ch.isspace():
            other += 1
    return cjk + max(1, (other + 3) // 4) if (cjk or other) else 0


def _story_token_estimate(story):
    return sum(_estimate_text_tokens(m.get("text") or "") for m in story or [])


def _clip_memory_text(value, limit):
    text = str(value or "").strip().lstrip("-•").strip()
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    return text[:limit].rstrip()


def _normalize_story_state(raw, turns, source_tokens, valid_ids=None):
    if not isinstance(raw, dict):
        raw = {}

    limits = {
        "timeline": (12, 120),
        "open_threads": (12, 140),
        "style_notes": (6, 120),
    }

    def arr(key):
        max_items, max_len = limits[key]
        vals = raw.get(key) or []
        if isinstance(vals, str):
            vals = [vals]
        out = []
        for v in vals:
            x = _clip_memory_text(v, max_len)
            if x and x not in out:
                out.append(x)
            if len(out) >= max_items:
                break
        return out

    state = {
        "timeline": arr("timeline"),
        "facts": [],
        "open_threads": arr("open_threads"),
        "objects": [],
        "secrets": [],
        "scene": _normalize_ledger_scene(raw.get("scene"), valid_ids),
        "style_notes": arr("style_notes"),
        "turns": turns,
        "source_tokens": source_tokens,
        "updated_at": int(time.time()),
    }
    fact_values = raw.get("facts") or []
    if isinstance(fact_values, (str, dict)):
        fact_values = [fact_values]
    for value in fact_values:
        fact = _normalize_fact_entry(value, valid_ids)
        if fact and fact["id"] not in {item["id"] for item in state["facts"]}:
            state["facts"].append(fact)
        if len(state["facts"]) >= 24:
            break
    object_values = raw.get("objects") or []
    if isinstance(object_values, (str, dict)):
        object_values = [object_values]
    for value in object_values:
        obj = _normalize_object_entry(value, valid_ids)
        if obj and obj["id"] not in {item["id"] for item in state["objects"]}:
            state["objects"].append(obj)
        if len(state["objects"]) >= 16:
            break
    secret_values = raw.get("secrets") or []
    if isinstance(secret_values, (str, dict)):
        secret_values = [secret_values]
    for value in secret_values:
        secret = _normalize_fact_entry(value, valid_ids, secret=True)
        if secret and secret["id"] not in {item["id"] for item in state["secrets"]}:
            state["secrets"].append(secret)
        if len(state["secrets"]) >= 16:
            break
    return _trim_story_state_to_budget(state, STORY_STATE_MAX_CHARS)


def _story_state_chars(state):
    return len(json.dumps(state or {}, ensure_ascii=False, separators=(",", ":")))


def _trim_story_state_to_budget(state, max_chars):
    """Bound ledger size while removing transient details before protected memory."""
    state = dict(state or {})

    primary_order = (
        "style_notes", "timeline", "facts", "objects",
    )
    protected_order = ("open_threads", "secrets")
    while _story_state_chars(state) > max_chars:
        changed = False
        for key in primary_order:
            values = list(state.get(key) or [])
            if values:
                values.pop(0)
                state[key] = values
                changed = True
                break
        if not changed:
            for key in protected_order:
                values = list(state.get(key) or [])
                if values:
                    values.pop(0)
                    state[key] = values
                    changed = True
                    break
        if not changed:
            break
    return state


def _story_state_quality_ok(previous, current):
    """Reject catastrophic memory loss without adding another model call."""
    if not _story_state_has_memory(previous):
        return True

    def count(keys, state):
        return sum(len(state.get(key) or []) for key in keys)

    old_protected = count(("open_threads", "objects", "secrets"), previous)
    new_protected = count(("open_threads", "objects", "secrets"), current)
    if old_protected >= 6 and new_protected < 2:
        return False

    old_history = count(("timeline", "facts"), previous)
    new_history = count(("timeline", "facts"), current)
    if old_history >= 6 and new_history < 2:
        return False

    return True


def _validated_story_state(state, story):
    """Return a ledger only when it safely replaces confirmed raw turns."""
    return validated_story_state(state, story, STORY_STATE_BATCH_TURNS)


def _effective_story_state(p):
    return _validated_story_state(
        (p or {}).get("story_state") or {}, (p or {}).get("story") or [])


def _story_state_reference_error(raw, valid_ids):
    """Reject model output that uses names or unknown ids in ledger references."""
    raw = raw if isinstance(raw, dict) else {}
    allowed = {str(value) for value in (valid_ids or set()) if value}
    if not allowed:
        return ""
    invalid = []
    for key in ("facts", "secrets"):
        values = raw.get(key) or []
        values = values if isinstance(values, list) else [values]
        for entry in values:
            if isinstance(entry, dict):
                invalid.extend("%s.known_by=%s" % (key, value)
                               for value in (entry.get("known_by") or [])
                               if str(value) not in allowed)
    values = raw.get("objects") or []
    values = values if isinstance(values, list) else [values]
    for entry in values:
        if isinstance(entry, dict):
            holder = str(entry.get("holder") or "").strip()
            if holder and holder not in allowed:
                invalid.append("objects.holder=%s" % holder)
    scene = raw.get("scene") if isinstance(raw.get("scene"), dict) else {}
    for entry in scene.get("participants") or []:
        if isinstance(entry, dict):
            cid = str(entry.get("character_id") or entry.get("id") or "").strip()
            if not cid or cid not in allowed:
                invalid.append("scene.character_id=%s" % (cid or "<empty>"))
    return "invalid story ledger references: %s" % invalid[:8] if invalid else ""


def _story_state_shape_error(raw):
    """Keep the model contract and the normalized ledger schema in lockstep."""
    if not isinstance(raw, dict):
        return "story ledger must be an object"
    required = {
        "timeline", "facts", "open_threads", "objects", "secrets",
        "scene", "style_notes",
    }
    if set(raw) != required:
        return "story ledger has an invalid top-level field set"
    for key in ("timeline", "facts", "open_threads", "objects", "secrets", "style_notes"):
        if not isinstance(raw.get(key), list):
            return "%s must be an array" % key
    for key in ("timeline", "open_threads", "style_notes"):
        if any(not isinstance(item, str) or not item.strip() for item in raw.get(key)):
            return "%s items must be non-empty strings" % key
    for key in ("facts", "secrets"):
        for item in raw.get(key):
            if not isinstance(item, dict) or set(item) != {"id", "content", "known_by"}:
                return "%s items must contain exactly id, content, and known_by" % key
            if not str(item.get("id") or "").strip() or not str(item.get("content") or "").strip():
                return "%s items require non-empty id and content" % key
            if (not isinstance(item.get("known_by"), list)
                    or any(not isinstance(value, str) or not value.strip()
                           for value in item.get("known_by"))):
                return "%s.known_by must be an array" % key
    for item in raw.get("objects"):
        if not isinstance(item, dict) or set(item) != {
                "id", "name", "status", "holder", "location"}:
            return "objects items must contain exactly id, name, status, holder, and location"
        if not str(item.get("id") or "").strip() or not str(item.get("name") or "").strip():
            return "objects items require non-empty id and name"
        if any(not isinstance(item.get(key), str) for key in ("status", "holder", "location")):
            return "objects status, holder, and location must be strings"
    scene = raw.get("scene")
    if not isinstance(scene, dict) or set(scene) != {"time", "place", "participants"}:
        return "scene must contain exactly time, place, and participants"
    if not isinstance(scene.get("participants"), list):
        return "scene.participants must be an array"
    if any(not isinstance(scene.get(key), str) for key in ("time", "place")):
        return "scene time and place must be strings"
    for item in scene.get("participants"):
        if not isinstance(item, dict) or set(item) != {
                "character_id", "location", "activity", "condition"}:
            return "scene participants have an invalid field set"
        if any(not isinstance(item.get(key), str) for key in (
                "character_id", "location", "activity", "condition")):
            return "scene participant values must be strings"
    return ""


def _validated_model_call(messages, temperature, model, max_tokens,
                          validator, language, task_name):
    """Validate one model response and allow one same-model contract retry."""
    base_messages = list(messages)
    current_messages = base_messages
    for attempt in range(2):
        try:
            output = actor.chat(
                current_messages,
                temperature=temperature,
                model=model,
                max_tokens=max_tokens,
            ).strip()
        except Exception as error:
            return "upstream_error", None, error
        try:
            return "ok", validator(output), None
        except Exception as error:
            if attempt:
                return "output_rejected", None, error
            if language == "en":
                correction = (
                    "Your previous JSON was rejected by the deterministic validator: %s. "
                    "Using the original input, return one complete corrected replacement JSON "
                    "that follows the system schema exactly. Do not explain or wrap the JSON."
                ) % error
            else:
                correction = (
                    "你上一份 JSON 未通过程序校验：%s。请根据原始输入重新输出一份完整的替代 JSON，"
                    "严格遵守系统字段结构。不要解释，不要添加代码块。"
                ) % error
            current_messages = base_messages + [
                {"role": "assistant", "content": output},
                {"role": "user", "content": correction},
            ]
            print("%s output retry with same model %s:" % (
                task_name, model.get("model")), repr(error),
                file=sys.stderr, flush=True)
    return "output_rejected", None, RuntimeError("unreachable validation state")


def _merge_story_state_batch(prev, batch, start_turn, end_turn,
                             source_tokens, response_language="zh", roster=None):
    language = _locale_code(response_language)
    roster = [item for item in (roster or []) if isinstance(item, dict) and item.get("id")]
    valid_ids = {str(item.get("id")) for item in roster}
    valid_ids.add("__user__")
    plot_keys = ("timeline", "facts", "open_threads", "objects", "secrets", "style_notes", "scene")
    prev = {key: (prev or {}).get(key) or ({} if key == "scene" else []) for key in plot_keys}
    ledger_schema = r'''{
  "timeline": ["<major event in chronological order>"],
  "facts": [
    {"id": "<stable_fact_id>", "content": "<current canonical fact>", "known_by": ["<entity_id>"]}
  ],
  "open_threads": ["<specific unresolved question, promise, conflict, or goal>"],
  "objects": [
    {"id": "<stable_object_id>", "name": "<name>", "status": "<current status>", "holder": "<entity_id_or_empty>", "location": "<current location>"}
  ],
  "secrets": [
    {"id": "<stable_secret_id>", "content": "<hidden truth>", "known_by": ["<entity_id>"]}
  ],
  "scene": {
    "time": "<current time>",
    "place": "<current place>",
    "participants": [
      {"character_id": "<entity_id>", "location": "<position>", "activity": "<current activity>", "condition": "<current scene condition>"}
    ]
  },
  "style_notes": ["<established point-of-view, tense, or continuity convention>"]
}'''
    if language == "en":
        sys_prompt = (
            "# Task\n\n"
            "Merge previous_state and the complete new_story_batch into one high-fidelity story ledger. "
            "Treat the batch as one continuous semantic unit. Use the latest confirmed event when facts change inside the batch. "
            "Write all textual values in English while preserving proper names and established facts. Never continue, explain, critique, or invent the story.\n\n"
            "# Ownership\n\n"
            "This ledger is the sole source for plot events, current scene, knowledge boundaries, unresolved threads, and key-object custody. "
            "The cast registry is the sole source for a character's current durable identity, personality, abilities, physical condition, and relationship conclusion. "
            "An identity revelation may remain here only as an event and as a knowledge boundary; the character's current identity value belongs in the cast registry. "
            "A relationship change may remain in timeline as an event, but its current durable conclusion belongs in the cast registry.\n\n"
            "# Field semantics\n\n"
            "timeline: up to 12 major events in chronological order. Keep an event only when its consequence remains relevant at the end of the batch; omit a minor incident that is fully resolved in the same batch and has no later effect.\n"
            "facts: up to 24 current canonical causal facts. Do not duplicate timeline wording.\n"
            "open_threads: up to 12 unresolved questions, promises, conflicts, threats, or goals; remove an item when explicitly resolved.\n"
            "objects: up to 16 consequential objects with their latest status, holder, and location.\n"
            "secrets: up to 16 hidden or selectively known truths with precise known_by boundaries.\n"
            "scene: replace it with the single current scene at the end of this batch. Carry forward the latest explicitly established scene value until the story explicitly changes it. Never invent a new time, place, participant location, activity, or condition; use an empty string when no value has ever been established.\n"
            "style_notes: up to 6 already-established POV, tense, or continuity conventions; never use it for plot facts or new writing instructions.\n\n"
            "# Merge rules\n\n"
            "Reuse an existing id whenever an existing fact, object, or secret is updated. Create a new stable id only for a genuinely new item. "
            "Do not create a second id for a paraphrase of the same item. Keep unresolved threads, unrevealed secrets, consequential objects, major promises, conflicts, turning points, and user choices until the batch explicitly resolves or changes them. A resolved temporary injury or other minor incident belongs nowhere in the updated ledger unless it creates a continuing consequence. "
            "When space is limited, remove duplicates, expired scene detail, completed minor actions, and low-consequence history first. "
            "Keep timeline entries within 120 characters, facts and secrets content within 220 characters, open_threads within 140 characters, and the complete JSON within %d characters. "
            "Use only allowed_entities ids or __user__ in known_by, holder, and scene.character_id; use an empty string when no holder is established.\n\n"
            "# Output contract\n\n"
            "Return exactly one JSON object matching the schema below. Include every top-level field, use no additional fields, and return no prose or code fence. "
            "If new_story_batch is non-empty, the ledger must not be entirely empty.\n\n"
            "# Exact JSON schema\n\n" + ledger_schema
        ) % STORY_STATE_MAX_CHARS
    else:
        sys_prompt = (
            "# 任务\n\n"
            "将 previous_state 与完整的 new_story_batch 合并为一份高保真剧情账本。把这一批视为连续的语义整体；批次内事实发生变化时，以最后确认的事件为准。"
            "所有文本值使用简体中文，并保留专有姓名和既有事实。不得续写、解释、点评或编造剧情。\n\n"
            "# 数据职责\n\n"
            "剧情账本是剧情事件、当前场景、认知边界、未解决线索和关键物品归属的唯一来源。"
            "角色档案是人物当前长期身份、性格、能力、身体情况和关系结论的唯一来源。"
            "身份揭露可以在账本中保留为事件及知情边界，但人物当前身份值归角色档案；关系变化可以在 timeline 保留为事件，但当前长期关系结论归角色档案。\n\n"
            "# 字段语义\n\n"
            "timeline：按时间顺序保留最多 12 条重大事件。只有事件后果在本批结束时仍影响后续，才保留该事件；同一批内已经完整解决且没有后续影响的轻微插曲必须省略。\n"
            "facts：保留最多 24 条当前仍然成立的因果事实，不要重复 timeline 的表述。\n"
            "open_threads：保留最多 12 条尚未解决的问题、承诺、冲突、威胁或目标；明确解决后删除。\n"
            "objects：保留最多 16 件会影响后续的关键物品及其最新状态、持有人和地点。\n"
            "secrets：保留最多 16 条隐藏或仅部分角色知晓的事实，并准确维护 known_by。\n"
            "scene：完整替换为本批结束时唯一有效的当前场景。最近一次明确建立的场景值在剧情明确改变前继续沿用；不得自行补写新的时间、地点、角色位置、行动或状态，从未明确过的值使用空字符串。\n"
            "style_notes：最多 6 条已经形成的视角、时态或连续性约定，不得存放剧情事实，也不得新增写作指令。\n\n"
            "# 合并规则\n\n"
            "更新既有事实、物品或秘密时必须沿用原 id；只有真正新增的项目才创建新 id，不得为同一内容的改写创建第二个 id。"
            "未解决线索、未揭露秘密、关键物品、重大承诺、核心冲突、转折和用户关键选择，在本批明确解决或改变前不得删除。同一批内已经恢复且没有持续影响的轻微伤势或其他临时插曲，不得进入更新后的账本。"
            "容量不足时，依次优先删除重复表述、过期场景细节、已完成的小动作和不影响后续的低价值历史。"
            "timeline 每条不超过 120 个字符，facts 与 secrets 的 content 不超过 220 个字符，open_threads 每条不超过 140 个字符，完整 JSON 不超过 %d 字符。"
            "known_by、holder 和 scene.character_id 只能使用 allowed_entities 中的 id 或 __user__；持有人未明确时 holder 使用空字符串。\n\n"
            "# 输出契约\n\n"
            "只返回一个严格符合下方模板的 JSON 对象。必须包含全部顶层字段，不得增加字段，不得输出解释或代码块。"
            "new_story_batch 非空时，账本不得全部为空。\n\n"
            "# 唯一 JSON 结构\n\n" + ledger_schema
        ) % STORY_STATE_MAX_CHARS
    user = json.dumps({
        "previous_state": prev or {},
        "new_story_batch": batch,
        "allowed_entities": roster + [{"id": "__user__", "name": "user"}],
        "response_language": language,
        "range": {
            "start_turn": start_turn,
            "end_turn": end_turn,
        },
    }, ensure_ascii=False)
    last_error = None
    for mem_model in _memory_models():
        def validate_story_state(out):
            if not out:
                raise ValueError("empty story ledger output")
            raw = _json_from_model_text(out)
            shape_error = _story_state_shape_error(raw)
            if shape_error:
                raise ValueError(shape_error)
            reference_error = _story_state_reference_error(raw, valid_ids)
            if reference_error:
                raise ValueError(reference_error)
            state = _normalize_story_state(raw, end_turn, source_tokens, valid_ids)
            state["response_language"] = language
            if not _story_state_has_memory(state):
                raise ValueError("empty normalized story ledger")
            if not _story_state_quality_ok(prev or {}, state):
                raise ValueError("story ledger lost protected memory")
            return state

        status, state, error = _validated_model_call([
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user},
            ], 0.1, mem_model, 6000, validate_story_state, language, "story_state")
        if status == "ok":
            return state
        last_error = error
        if status == "upstream_error":
            print("story_state upstream failed with %s:" % mem_model.get("model"),
                  repr(error), file=sys.stderr, flush=True)
            continue
        print("story_state output rejected from %s after same-model retry:" %
              mem_model.get("model"), repr(error), file=sys.stderr, flush=True)
        return None
    print("story_state batch failed:", repr(last_error), file=sys.stderr, flush=True)
    return None


_PROFILE_CHANGE_FIELDS = {
    "identity": {
        "name", "aliases", "description", "gender", "age", "species",
        "occupation", "affiliations", "story_role",
    },
    "appearance": {"summary", "features"},
    "personality": {"summary", "traits", "values", "motivation", "fears", "boundaries"},
    "expression": {"speech_style", "habits", "mannerisms"},
    "capabilities": {"skills", "powers", "limitations"},
}
_PROFILE_LIST_FIELDS = {
    "aliases", "affiliations", "features", "traits", "values", "fears",
    "boundaries", "habits", "mannerisms", "skills", "powers", "limitations",
}


def _validated_change_evidence(value, start_turn, end_turn):
    values = value if isinstance(value, list) else ([value] if isinstance(value, dict) else [])
    out = []
    for raw in values:
        if not isinstance(raw, dict):
            continue
        try:
            turn = int(raw.get("turn"))
        except (TypeError, ValueError):
            continue
        fact = _clip_memory_text(raw.get("fact"), 300)
        reason = _clip_memory_text(raw.get("reason"), 300)
        if start_turn <= turn <= end_turn and fact:
            item = {"turn": turn, "fact": fact}
            fields = raw.get("fields") or []
            if isinstance(fields, str):
                fields = [fields]
            fields = [str(field).strip() for field in fields if str(field).strip()]
            if fields:
                item["fields"] = list(dict.fromkeys(fields))[:12]
            if reason:
                item["reason"] = reason
            out.append(item)
    return out[:6]


def _merge_profile_changes(current, changes):
    """Apply non-empty whitelisted fields to the current profile."""
    before = _canonical_profile_snapshot(current)
    merged = json.loads(json.dumps(before, ensure_ascii=False))
    incoming = changes if isinstance(changes, dict) else {}
    for section, allowed_fields in _PROFILE_CHANGE_FIELDS.items():
        section_changes = incoming.get(section)
        if not isinstance(section_changes, dict):
            section_changes = {}
        target = merged.setdefault(section, {})
        for field in allowed_fields:
            if field in section_changes:
                raw = section_changes.get(field)
            elif field != "summary":
                misplaced = [values.get(field) for values in incoming.values()
                             if isinstance(values, dict) and field in values]
                if not misplaced:
                    continue
                raw = misplaced[0]
            else:
                continue
            if field in _PROFILE_LIST_FIELDS:
                values = raw if isinstance(raw, list) else ([raw] if raw else [])
                cleaned = []
                for value in values:
                    text = _clip_memory_text(value, 240)
                    if text and text not in cleaned:
                        cleaned.append(text)
                if cleaned:
                    target[field] = cleaned[:12]
            else:
                limit = 2500 if field in ("description", "summary") else 600
                text = _clip_memory_text(raw, limit)
                if text:
                    target[field] = text
    old_name = str((before.get("identity") or {}).get("name") or "").strip()
    new_name = str((merged.get("identity") or {}).get("name") or "").strip()
    if old_name and new_name and old_name != new_name:
        aliases = list((merged.get("identity") or {}).get("aliases") or [])
        if old_name not in aliases:
            aliases.append(old_name)
        merged["identity"]["aliases"] = aliases[:8]
    result = _canonical_profile_snapshot(merged)
    return result, result != before


def _merge_persistent_status_changes(current, changes):
    before = _normalize_persistent_status(current or {})
    merged = dict(before)
    incoming = changes if isinstance(changes, dict) else {}
    for field, limit in (("life_status", 80), ("physical_condition", 600)):
        if field in incoming:
            text = _clip_memory_text(incoming.get(field), limit)
            if text:
                merged[field] = text
    result = _normalize_persistent_status(merged)
    return result, result != before


def _runtime_user_change(raw):
    """Accept the canonical user change object and the common __user__ wrapper."""
    raw = raw if isinstance(raw, dict) else {}
    candidate = raw.get("user_changes")
    if not isinstance(candidate, dict):
        return {}
    wrapped = candidate.get("__user__")
    return wrapped if isinstance(wrapped, dict) else candidate


def _model_evidence(value, start_turn, end_turn):
    """Normalize compact model evidence strings into canonical turn evidence."""
    if isinstance(value, list):
        return value
    text = _clip_memory_text(value, 500)
    if not text:
        return []
    turns = []
    for match in re.finditer(r"第\s*(\d+)(?:\s*[-—至]\s*(\d+))?\s*轮", text):
        for raw_turn in (match.group(1), match.group(2)):
            if raw_turn:
                turn = int(raw_turn)
                if start_turn <= turn <= end_turn and turn not in turns:
                    turns.append(turn)
    return [{"turn": turn, "fact": text} for turn in turns[:6]]


def _canonicalize_runtime_cast_output(raw, start_turn, end_turn):
    """Accept the prompt's compact field-diff form and convert it for storage."""
    raw = dict(raw) if isinstance(raw, dict) else {}

    def profile_path(field):
        if "." in field:
            return field.split(".", 1)
        matches = [section for section, fields in _PROFILE_CHANGE_FIELDS.items()
                   if field in fields]
        return (matches[0], field) if len(matches) == 1 else ("identity", field)

    def add_field(result, entity_id, field, value, evidence):
        if not entity_id or not field:
            return
        section, name = profile_path(field)
        candidate = result.setdefault(entity_id, {"profile": {}, "evidence": []})
        if section == "persistent_status":
            candidate.setdefault("persistent_status", {})[name] = value
        elif section in _PROFILE_CHANGE_FIELDS and name in _PROFILE_CHANGE_FIELDS[section]:
            candidate.setdefault("profile", {}).setdefault(section, {})[name] = value
        candidate["evidence"].extend(_model_evidence(evidence, start_turn, end_turn))

    def grouped(value, user=False):
        result = {}
        if isinstance(value, dict):
            if user:
                wrapped = value.get("__user__")
                return {"__user__": wrapped} if isinstance(wrapped, dict) else {"__user__": value}
            # The canonical contract uses character ids as object keys. Preserve it
            # exactly; list handling below exists only for older model responses.
            return value
        for item in value if isinstance(value, list) else []:
            if not isinstance(item, dict):
                continue
            entity_id = "__user__" if user else str(
                item.get("id") or item.get("character_id") or "").strip()
            if not entity_id:
                continue
            nested = item.get("changes")
            if isinstance(nested, dict):
                if set(nested).issubset(set(_PROFILE_CHANGE_FIELDS) | {"persistent_status"}):
                    candidate = result.setdefault(
                        entity_id, {"profile": {}, "evidence": []})
                    for section, fields in nested.items():
                        if not isinstance(fields, dict):
                            continue
                        if section == "persistent_status":
                            candidate.setdefault("persistent_status", {}).update(fields)
                        elif section in _PROFILE_CHANGE_FIELDS:
                            candidate.setdefault("profile", {}).setdefault(
                                section, {}).update(fields)
                    candidate["evidence"].extend(
                        _model_evidence(item.get("evidence"), start_turn, end_turn))
                    continue
                for field, detail in nested.items():
                    if isinstance(detail, dict):
                        add_field(result, entity_id, field, detail.get("new_value"),
                                  detail.get("evidence"))
                continue
            field = str(item.get("field") or "").strip()
            add_field(result, entity_id, field, item.get("new_value"), item.get("evidence"))
        for candidate in result.values():
            evidence = []
            for item in candidate.get("evidence") or []:
                if item not in evidence:
                    evidence.append(item)
            candidate["evidence"] = evidence[:6]
        return result

    characters = grouped(raw.get("character_changes"))
    users = grouped(raw.get("user_changes"), user=True)
    embedded_user = characters.pop("__user__", None)
    if embedded_user:
        target = users.setdefault("__user__", {"profile": {}, "evidence": []})
        for section, fields in (embedded_user.get("profile") or {}).items():
            target.setdefault("profile", {}).setdefault(section, {}).update(fields)
        target["evidence"] = (target.get("evidence") or []) + (
            embedded_user.get("evidence") or [])
    raw["character_changes"] = characters
    raw["user_changes"] = users.get("__user__", {})

    relationships = []
    for item in raw.get("relationship_changes") or []:
        if not isinstance(item, dict):
            continue
        normalized = dict(item)
        normalized["action"] = str(item.get("action") or "upsert")
        normalized["evidence"] = _model_evidence(
            item.get("evidence"), start_turn, end_turn)
        relationships.append(normalized)
    raw["relationship_changes"] = relationships
    return raw


def _runtime_cast_evidence_shape_error(value, expected_fields=None):
    if not isinstance(value, list) or not value:
        return "evidence must be a non-empty array"
    for item in value:
        if not isinstance(item, dict) or set(item) != {"turn", "fact", "fields"}:
            return "evidence items must contain exactly turn, fact, and fields"
        if not isinstance(item.get("turn"), int):
            return "evidence.turn must be an integer"
        if not isinstance(item.get("fact"), str) or not item.get("fact").strip():
            return "evidence.fact must be a non-empty string"
        fields = item.get("fields")
        if (not isinstance(fields, list) or not fields
                or any(not isinstance(field, str) or not field.strip() for field in fields)):
            return "evidence.fields must be a non-empty string array"
        if expected_fields is not None and set(fields) != set(expected_fields):
            return "evidence.fields does not match the required field set"
    return ""


_RUNTIME_CAST_AUDIT_FIELDS = {
    "name": "profile.identity.name",
    "description": "profile.identity.description",
    "age": "profile.identity.age",
    "occupation": "profile.identity.occupation",
    "affiliations": "profile.identity.affiliations",
    "story_role": "profile.identity.story_role",
    "life_status": "persistent_status.life_status",
    "physical_condition": "persistent_status.physical_condition",
}
_RUNTIME_CAST_AUDIT_DECISIONS = {"update", "keep", "unknown"}


def _runtime_cast_review_error(raw, roster, start_turn, end_turn):
    """Require one complete, conflict-free audit before accepting a cast change set."""
    raw = raw if isinstance(raw, dict) else {}
    expected = {str(item.get("id")) for item in roster if item.get("id")}
    reviewed_raw = raw.get("reviewed_character_ids")
    reviewed = ({str(value) for value in reviewed_raw}
                if isinstance(reviewed_raw, list) else set())
    if reviewed != expected or len(reviewed_raw or []) != len(expected):
        missing = sorted(expected - reviewed)
        extra = sorted(reviewed - expected)
        return "incomplete cast review; missing=%s extra=%s" % (missing, extra)
    if raw.get("user_reviewed") is not True:
        return "user profile was not reviewed"
    audit = raw.get("field_audit")
    expected_audit_ids = expected | {"__user__"}
    if not isinstance(audit, dict) or set(audit) != expected_audit_ids:
        return "field_audit must contain every roster id and __user__ exactly once"
    changes = raw.get("character_changes") if isinstance(
        raw.get("character_changes"), dict) else {}
    audited_paths = set(_RUNTIME_CAST_AUDIT_FIELDS.values())
    for entity_id in sorted(expected_audit_ids):
        decisions = audit.get(entity_id)
        if not isinstance(decisions, dict) or set(decisions) != set(
                _RUNTIME_CAST_AUDIT_FIELDS):
            return "field_audit has an invalid field set for %s" % entity_id
        if any(value not in _RUNTIME_CAST_AUDIT_DECISIONS
               for value in decisions.values()):
            return "field_audit has an invalid decision for %s" % entity_id
        candidate = (_runtime_user_change(raw) if entity_id == "__user__"
                     else changes.get(entity_id) or {})
        emitted = _runtime_cast_changed_field_paths(candidate) & audited_paths
        declared = {
            path for field, path in _RUNTIME_CAST_AUDIT_FIELDS.items()
            if decisions.get(field) == "update"
        }
        if emitted != declared:
            return "field_audit updates do not match emitted changes for %s" % entity_id
        identity_updates = {
            decisions.get(field) for field in (
                "name", "age", "occupation", "affiliations")
        }
        if "update" in identity_updates and decisions.get("description") != "update":
            return "identity changes require an updated description for %s" % entity_id
    conflicts = raw.get("unresolved_conflicts")
    if not isinstance(conflicts, list):
        return "unresolved_conflicts must be an array"
    valid_ids = expected | {"__user__"}
    for conflict in conflicts:
        if not isinstance(conflict, dict):
            return "every unresolved conflict must be an object"
        if set(conflict) != {"entity_id", "field", "description", "evidence"}:
            return "unresolved conflict has an invalid field set"
        if str(conflict.get("entity_id") or "") not in valid_ids:
            return "unresolved conflict has an unknown entity_id"
        if not str(conflict.get("field") or "").strip():
            return "unresolved conflict must name one field"
        if not str(conflict.get("description") or "").strip():
            return "unresolved conflict requires a description"
        evidence_shape_error = _runtime_cast_evidence_shape_error(
            conflict.get("evidence"), {str(conflict.get("field"))})
        if evidence_shape_error:
            return evidence_shape_error
        if not _validated_change_evidence(
                conflict.get("evidence"), start_turn, end_turn):
            return "unresolved conflict requires valid evidence"
    return ""


def _runtime_cast_changed_field_paths(candidate):
    """Return the canonical field paths emitted by one profile change object."""
    candidate = candidate if isinstance(candidate, dict) else {}
    paths = set()
    profile = candidate.get("profile") if isinstance(candidate.get("profile"), dict) else {}
    for section, values in profile.items():
        if isinstance(values, dict):
            paths.update("profile.%s.%s" % (section, field) for field in values)
    status = candidate.get("persistent_status")
    if isinstance(status, dict):
        paths.update("persistent_status.%s" % field for field in status)
    return paths


def _runtime_cast_shape_error(raw, roster, start_turn, end_turn):
    raw = raw if isinstance(raw, dict) else {}
    required_top_level = {
        "reviewed_character_ids", "user_reviewed", "field_audit",
        "unresolved_conflicts",
        "character_changes", "user_changes", "relationship_changes",
    }
    if set(raw) != required_top_level:
        return "runtime cast output has an invalid top-level field set"
    valid_ids = {str(item.get("id")) for item in roster if item.get("id")}
    changes = raw.get("character_changes")
    if not isinstance(changes, dict):
        return "character_changes must be an object"
    unknown_ids = sorted(set(changes) - valid_ids)
    if unknown_ids:
        return "unknown character ids: %s" % unknown_ids
    candidates = list(changes.values())
    raw_user_change = raw.get("user_changes")
    if not isinstance(raw_user_change, dict):
        return "user_changes must be an object"
    user_change = _runtime_user_change(raw)
    if user_change:
        candidates.append(user_change)
    for candidate in candidates:
        if not isinstance(candidate, dict):
            return "every change must be an object"
        if not candidate:
            continue
        if set(candidate) - {"profile", "persistent_status", "evidence"}:
            return "change object has unknown fields"
        profile = candidate.get("profile")
        if profile is not None:
            if not isinstance(profile, dict):
                return "profile must be an object"
            if set(profile) - set(_PROFILE_CHANGE_FIELDS):
                return "unknown profile section"
            for section, fields in profile.items():
                if not isinstance(fields, dict) or set(fields) - _PROFILE_CHANGE_FIELDS[section]:
                    return "invalid fields in profile.%s" % section
                for field, value in fields.items():
                    if field in _PROFILE_LIST_FIELDS:
                        if (not isinstance(value, list)
                                or any(not isinstance(item, str) or not item.strip()
                                       for item in value)):
                            return "profile.%s.%s must be a non-empty string array" % (
                                section, field)
                    elif not isinstance(value, str) or not value.strip():
                        return "profile.%s.%s must be a non-empty string" % (section, field)
        status = candidate.get("persistent_status")
        if status is not None and (
                not isinstance(status, dict)
                or set(status) - {"life_status", "physical_condition"}):
            return "invalid persistent_status"
        if isinstance(status, dict) and any(
                not isinstance(value, str) or not value.strip() for value in status.values()):
            return "persistent_status values must be non-empty strings"
        if not _validated_change_evidence(candidate.get("evidence"), start_turn, end_turn):
            return "every non-empty change needs valid evidence"
        emitted_fields = _runtime_cast_changed_field_paths(candidate)
        evidence_shape_error = _runtime_cast_evidence_shape_error(
            candidate.get("evidence"))
        if evidence_shape_error:
            return evidence_shape_error
        evidence_fields = {
            field
            for evidence in _validated_change_evidence(
                candidate.get("evidence"), start_turn, end_turn)
            for field in evidence.get("fields") or []
        }
        if emitted_fields != evidence_fields:
            return "change evidence fields must exactly match emitted fields"
    if not isinstance(raw.get("relationship_changes"), list):
        return "relationship_changes must be an array"
    for change in raw.get("relationship_changes") or []:
        if not isinstance(change, dict):
            return "every relationship change must be an object"
        if set(change) != {"participants", "action", "description", "evidence"}:
            return "relationship change has an invalid field set"
        participants = change.get("participants")
        normalized_participants = ([str(value) for value in participants]
                                   if isinstance(participants, list) else [])
        if (len(normalized_participants) != 2 or len(set(normalized_participants)) != 2
                or any(str(value) not in valid_ids | {"__user__"} for value in participants)):
            return "relationship changes require two valid participant ids"
        action = str(change.get("action") or "").strip().lower()
        if action not in {"upsert", "remove"}:
            return "relationship action must be upsert or remove"
        if action == "upsert" and not str(change.get("description") or "").strip():
            return "upsert relationship changes require description"
        evidence_shape_error = _runtime_cast_evidence_shape_error(
            change.get("evidence"), {"relationship"})
        if evidence_shape_error:
            return evidence_shape_error
        if not _validated_change_evidence(change.get("evidence"), start_turn, end_turn):
            return "relationship changes require valid evidence"
    return ""


def _runtime_cast_noop_error(raw, previous, persona=None):
    """Reject claimed updates that do not change the current authoritative cast."""
    raw = raw if isinstance(raw, dict) else {}
    previous = previous if isinstance(previous, dict) else {}
    persona = persona if isinstance(persona, dict) else {}
    changes = raw.get("character_changes") or {}
    current_by_id = {
        str(item.get("id")): item
        for item in previous.get("characters") or [] if isinstance(item, dict)
    }
    for entity_id, candidate in changes.items():
        current = current_by_id.get(str(entity_id)) or {}
        _, profile_changed = _merge_profile_changes(
            current.get("profile") or {}, candidate.get("profile") or {})
        _, status_changed = _merge_persistent_status_changes(
            current.get("persistent_status") or {}, candidate.get("persistent_status") or {})
        if not profile_changed and not status_changed:
            return "character change does not alter current_cast: %s" % entity_id

    user_change = _runtime_user_change(raw)
    if user_change:
        current_user_profile = previous.get("user_profile") or persona.get("profile") or {}
        _, profile_changed = _merge_profile_changes(
            current_user_profile, user_change.get("profile") or {})
        _, status_changed = _merge_persistent_status_changes(
            previous.get("user_status") or {}, user_change.get("persistent_status") or {})
        if not profile_changed and not status_changed:
            return "user change does not alter current_cast"

    relationships = {
        "|".join(sorted(str(value) for value in item.get("participants") or [])):
            str(item.get("description") or "").strip()
        for item in previous.get("relationships") or [] if isinstance(item, dict)
    }
    for change in raw.get("relationship_changes") or []:
        key = "|".join(sorted(str(value) for value in change.get("participants") or []))
        action = str(change.get("action") or "").strip().lower()
        if action == "remove" and key not in relationships:
            return "relationship removal does not alter current_cast: %s" % key
        if action == "upsert" and relationships.get(key) == str(
                change.get("description") or "").strip():
            return "relationship update does not alter current_cast: %s" % key
    return ""


def _normalize_runtime_cast_result(raw, previous, start_turn, end_turn, persona=None):
    """Validate an evidence-backed change set and apply it to one durable cast snapshot."""
    raw = raw if isinstance(raw, dict) else {}
    previous = previous if isinstance(previous, dict) else {}
    raw_changes = raw.get("character_changes") if isinstance(raw.get("character_changes"), dict) else {}
    characters = []
    for old in previous.get("characters") or []:
        if not isinstance(old, dict):
            continue
        item = _runtime_character(old, applied_turn=int(previous.get("applied_turn") or 0))
        candidate = raw_changes.get(str(item.get("id")))
        evidence = _validated_change_evidence(
            candidate.get("evidence") if isinstance(candidate, dict) else None,
            start_turn, end_turn)
        profile_changed = status_changed = False
        if evidence:
            item["profile"], profile_changed = _merge_profile_changes(
                item.get("profile") or {}, candidate.get("profile") or {})
            item["persistent_status"], status_changed = _merge_persistent_status_changes(
                item.get("persistent_status") or {}, candidate.get("persistent_status") or {})
        if profile_changed:
            item["profile_updated_turn"] = end_turn
            item["last_change_evidence"] = evidence
        if status_changed:
            item["status_updated_turn"] = end_turn
            item["last_change_evidence"] = evidence
        identity = item["profile"]["identity"]
        item["name"] = identity.get("name") or item.get("name") or ""
        item["description"] = identity.get("description") or ""
        item["personality"] = item["profile"]["personality"].get("summary") or ""
        characters.append(item)

    previous_user_profile = _canonical_profile_snapshot(
        previous.get("user_profile") or (persona or {}).get("profile") or persona or {})
    previous_user_status = _normalize_persistent_status(previous.get("user_status") or {})
    user_profile = previous_user_profile
    user_status = previous_user_status
    user_profile_changed = user_status_changed = False
    user_candidate = _runtime_user_change(raw)
    user_evidence = _validated_change_evidence(user_candidate.get("evidence"), start_turn, end_turn)
    if user_evidence:
        user_profile, user_profile_changed = _merge_profile_changes(
            previous_user_profile, user_candidate.get("profile") or {})
        user_status, user_status_changed = _merge_persistent_status_changes(
            previous_user_status, user_candidate.get("persistent_status") or {})

    previous_relationships = _normalize_relationships(
        previous.get("relationships") or [], characters, persona or {})
    relationships_by_key = {
        "|".join(item.get("participants") or []): dict(item)
        for item in previous_relationships
    }
    valid_ids = {str(item.get("id")) for item in characters if item.get("id")}
    valid_ids.add("__user__")
    relation_changes = raw.get("relationship_changes")
    if not isinstance(relation_changes, list):
        relation_changes = []
    for change in relation_changes:
        if not isinstance(change, dict):
            continue
        evidence = _validated_change_evidence(change.get("evidence"), start_turn, end_turn)
        participants = sorted({str(value) for value in (change.get("participants") or [])})
        if not evidence or len(participants) != 2 or any(value not in valid_ids for value in participants):
            continue
        key = "|".join(participants)
        action = str(change.get("action") or "upsert").strip().lower()
        if action == "remove":
            relationships_by_key.pop(key, None)
            continue
        description = _clip_memory_text(change.get("description"), 300)
        if action == "upsert" and description:
            relationships_by_key[key] = {
                "participants": participants,
                "description": description,
                "updated_turn": end_turn,
            }
    relationships = _normalize_relationships(
        list(relationships_by_key.values()), characters, persona or {})

    result = {
        "schema_version": 3,
        "applied_turn": end_turn,
        "revision": int(previous.get("revision") or 0) + 1,
        "characters": characters,
        "origin_user_profile": _canonical_profile_snapshot(
            previous.get("origin_user_profile") or previous_user_profile),
        "user_profile": user_profile,
        "user_profile_updated_turn": (
            end_turn if user_profile_changed
            else int(previous.get("user_profile_updated_turn") or 0)),
        "user_status": user_status,
        "user_status_updated_turn": (
            end_turn if user_status_changed
            else int(previous.get("user_status_updated_turn") or 0)),
        "relationships": relationships,
        "updated_at": int(time.time()),
    }
    if user_profile_changed or user_status_changed:
        result["user_last_change_evidence"] = user_evidence
    elif previous.get("user_last_change_evidence"):
        result["user_last_change_evidence"] = previous.get("user_last_change_evidence")
    return result


def _runtime_cast_system_prompt(language):
    """Return the single semantic and serialization contract for cast updates."""
    schema = r'''{
  "reviewed_character_ids": ["<character_id>"],
  "user_reviewed": true,
  "field_audit": {
    "<character_id>": {
      "name": "update|keep|unknown",
      "description": "update|keep|unknown",
      "age": "update|keep|unknown",
      "occupation": "update|keep|unknown",
      "affiliations": "update|keep|unknown",
      "story_role": "update|keep|unknown",
      "life_status": "update|keep|unknown",
      "physical_condition": "update|keep|unknown"
    },
    "__user__": {
      "name": "update|keep|unknown",
      "description": "update|keep|unknown",
      "age": "update|keep|unknown",
      "occupation": "update|keep|unknown",
      "affiliations": "update|keep|unknown",
      "story_role": "update|keep|unknown",
      "life_status": "update|keep|unknown",
      "physical_condition": "update|keep|unknown"
    }
  },
  "unresolved_conflicts": [
    {
      "entity_id": "<character_id>|__user__",
      "field": "<canonical_field_path>",
      "description": "<conflicting facts>",
      "evidence": [
        {"turn": 1, "fact": "<fact from this batch>", "fields": ["<canonical_field_path>"]}
      ]
    }
  ],
  "character_changes": {
    "<character_id>": {
      "profile": {
        "identity": {"occupation": "<new confirmed value>"}
      },
      "evidence": [
        {
          "turn": 1,
          "fact": "<fact from this batch>",
          "fields": ["profile.identity.occupation"]
        }
      ]
    }
  },
  "user_changes": {
    "profile": {
      "identity": {"affiliations": ["<new confirmed value>"]}
    },
    "evidence": [
      {
        "turn": 1,
        "fact": "<fact from this batch>",
        "fields": ["profile.identity.affiliations"]
      }
    ]
  },
  "relationship_changes": [
    {
      "participants": ["<character_id>|__user__", "<character_id>|__user__"],
      "action": "upsert|remove",
      "description": "<current durable relationship; required for upsert>",
      "evidence": [
        {"turn": 1, "fact": "<fact from this batch>", "fields": ["relationship"]}
      ]
    }
  ]
}'''
    if language == "en":
        return (
            "# Task\n\n"
            "Maintain the single effective long-term cast registry for an interactive story. "
            "Compare current_cast with the complete new_story_batch and output only confirmed durable changes. "
            "Never continue, summarize, explain, or judge the story.\n\n"
            "# Sources and authority\n\n"
            "current_cast is the sole current truth. origin_profile is read-only historical reference. "
            "new_story_batch is the only source that may establish a new change. story_ledger may cross-check continuity but cannot independently prove a change. "
            "Within the batch, a later explicit confirmation supersedes an earlier intermediate state. "
            "Every field is optional and may remain empty. Never infer, fabricate, or fill a field merely to complete a profile.\n\n"
            "# What belongs here\n\n"
            "Store only facts expected to remain true beyond the current scene. Temporary emotion, action, location, clothing, short-term goal, knowledge, inventory, and scene activity belong to the story ledger. "
            "A name, identity, affiliation, status, or ability may change only when the batch explicitly establishes the new durable fact. "
            "A personality or expression field may change only after an explicit lasting transformation or consistent evidence across multiple independent turns. "
            "For __user__, record only explicit user statements, choices, or objectively completed facts; never infer feelings, intent, personality, or decisions.\n\n"
            "# Field catalog\n\n"
            "profile.identity: name (current official name, string); aliases (confirmed durable alternate names, string[]); "
            "description (optional display summary consistent with structured fields, string); gender (explicit durable gender identity, string); "
            "age (confirmed age, string); species (confirmed species, string); occupation (confirmed profession or student stage, string); "
            "affiliations (school, class, employer, faction, or organization, string[]); story_role (narrative function such as protagonist or mentor, string).\n"
            "profile.appearance: summary (durable overall appearance, string); features (durable distinctive features, string[]).\n"
            "profile.personality: summary (durable personality summary, string); traits, values, fears, boundaries (durable string[]); motivation (durable long-term motivation, string).\n"
            "profile.expression: speech_style (stable speaking style, string); habits and mannerisms (stable string[]).\n"
            "profile.capabilities: skills, powers, limitations (durable string[]).\n"
            "persistent_status: life_status (durable living/dead/missing state, string); physical_condition (long-term or irreversible physical condition, string).\n\n"
            "# Review and change rules\n\n"
            "Review every roster id and __user__. reviewed_character_ids contains every roster id exactly once and never __user__; user_reviewed is true. "
            "field_audit contains every roster id and __user__ exactly once. For each audited field use update only when this batch proves a new durable value, keep when current_cast remains accurate, and unknown when evidence is insufficient. "
            "An update decision must emit that exact canonical field with evidence; keep and unknown must not emit it. Whenever name, age, occupation, or affiliations is updated, description must also be updated to a compact display summary consistent with all resulting structured identity fields. "
            "Output only values that differ from current_cast. Empty current fields are valid and do not require completion. "
            "identity.description is display text, not an authoritative substitute for structured fields. "
            "Put a genuine unresolved contradiction in unresolved_conflicts and omit only the disputed field. "
            "Update a relationship only when the batch explicitly establishes or ends a durable bond, commitment, alliance, kinship, social role, or power relationship. "
            "A single affectionate moment, argument, conversation, cooperation, suspicion, or temporary emotion is not a durable relationship change.\n\n"
            "# Serialization contract\n\n"
            "Return one JSON object matching the exact schema below. Do not rename keys, use arrays in place of objects, add wrapper objects, or add keys not shown. "
            "field_audit must use exactly the eight shown keys for every entity, with only update, keep, or unknown as values. "
            "character_changes is an object keyed by roster character id; do not place id or character_id inside an item. user_changes is one object, never an array. "
            "Omit unchanged profile sections and fields. Use {} and [] when there are no changes. Every non-empty entity change has evidence. "
            "Each evidence item uses a turn inside range, a verbatim factual paraphrase, and fields containing canonical paths for exactly the fields supported by that evidence. "
            "Across an entity, evidence.fields must cover every emitted changed field exactly; examples are profile.identity.age and persistent_status.life_status. "
            "A durable fact written in identity.description must also be present in its canonical structured field; description is never a substitute for name, aliases, age, occupation, or affiliations. "
            "All evidence objects use exactly turn, fact, and fields. Conflict evidence names the disputed field; relationship evidence uses fields=[\"relationship\"]. Relationships use exactly two valid ids and action upsert or remove. Output JSON only.\n\n"
            "# Exact JSON schema template\n\n" + schema
        )
    return (
        "# 任务\n\n"
        "你负责维护互动故事中唯一生效的长期角色档案。对照 current_cast 审查完整的 new_story_batch，只输出已经确认的长期变化。"
        "不得续写、总结、解释或评价剧情。\n\n"
        "# 数据来源与权威\n\n"
        "current_cast 是当前唯一事实，origin_profile 只是只读的初始参考。只有 new_story_batch 能建立新的变化；story_ledger 只能交叉核对连续性，不能单独证明角色变化。"
        "同一批内较晚明确确认的事实覆盖较早的中间状态。所有字段均为可选并允许为空，不得为了补全档案而推断、编造或填写。\n\n"
        "# 收录边界\n\n"
        "只保存预计在当前场景结束后仍然成立的事实。临时情绪、动作、地点、着装、短期目标、认知、持有物和场景活动归剧情账本。"
        "姓名、身份、所属、状态或能力只有在本批明确建立新的长期事实时才能改变。性格与表达方式只有在原文明示长期转变，或多个独立回合持续证明时才能改变。"
        "用户角色只记录用户明确陈述、明确选择或剧情中客观完成的事实；不得推断用户的感受、意图、性格或决定。\n\n"
        "# 字段目录\n\n"
        "profile.identity：name=当前正式姓名，字符串；aliases=已经确认且会持续使用的别名或代号，字符串数组；"
        "description=与结构字段一致的可选展示摘要，字符串；gender=原文明示的长期性别身份，字符串；"
        "age=已经确认的具体年龄，字符串；species=已经确认的种族，字符串；occupation=已经确认的职业或学业阶段，字符串；"
        "affiliations=学校、班级、单位、阵营或组织，字符串数组；story_role=主角、对手、导师等剧情职能，字符串。\n"
        "profile.appearance：summary=长期整体外貌，字符串；features=稳定且有辨识度的外貌特征，字符串数组。\n"
        "profile.personality：summary=长期性格概述，字符串；traits=性格特质，values=价值观，fears=长期恐惧，boundaries=稳定边界，均为字符串数组；motivation=长期动机，字符串。\n"
        "profile.expression：speech_style=稳定说话方式，字符串；habits=稳定习惯，mannerisms=稳定行为特征，均为字符串数组。\n"
        "profile.capabilities：skills=技能，powers=特殊能力，limitations=长期限制，均为字符串数组。\n"
        "persistent_status：life_status=存活、死亡、失踪等长期生命状态，字符串；physical_condition=长期或不可逆身体情况，字符串。\n\n"
        "# 审查与变化规则\n\n"
        "逐一审查 roster 中每个角色和 __user__。reviewed_character_ids 必须且只能包含全部 roster 角色 id，每个一次，不包含 __user__；user_reviewed 固定为 true。"
        "field_audit 必须且只能包含全部 roster 角色 id 和 __user__，每个一次。每个审查字段只能填写 update、keep 或 unknown：本批明确证明新的长期值时填 update；current_cast 仍准确时填 keep；证据不足时填 unknown。"
        "填 update 的字段必须在变更对象中输出对应规范字段并附证据；填 keep 或 unknown 的字段不得输出。name、age、occupation 或 affiliations 任一更新时，description 也必须更新为与最终结构身份一致的简洁展示摘要。"
        "character_changes 与 user_changes 只能输出相对 current_cast 已经确认的差异。当前字段为空也是合法状态，不要求补全。"
        "identity.description 只是展示文本，不是结构事实的替代品。"
        "真实且尚未解决的冲突写入 unresolved_conflicts，只停止更新有争议的字段。"
        "只有本批明确建立或结束长期亲属、承诺、结盟、社会身份、权力关系或其他持续关系时，才能更新 relationship_changes。"
        "单次亲密、争吵、对话、合作、怀疑或临时情绪都不构成长期关系变化。\n\n"
        "# 序列化契约\n\n"
        "只返回一个严格符合下方模板的 JSON 对象。不得改名字段，不得用数组代替对象，不得增加包装层，不得增加模板外字段。"
        "field_audit 必须为每个实体完整输出模板中的八个字段，值只能是 update、keep 或 unknown。"
        "character_changes 必须是以角色 id 为键的对象，条目内部不得再写 id 或 character_id；user_changes 必须是单个对象，不能是数组。"
        "未变化的档案分区和字段不要输出；没有内容时使用 {} 或 []。每个非空角色变更都必须包含 evidence。"
        "每条 evidence 必须包含 range 内的 turn、对该回合事实的准确转述 fact，以及该证据直接支持的规范字段路径 fields。"
        "同一角色全部 evidence.fields 必须恰好覆盖其输出的每个变更字段；字段路径示例：profile.identity.age、persistent_status.life_status。"
        "写入 identity.description 的长期身份事实必须同时写入对应结构字段；description 不能代替 name、aliases、age、occupation 或 affiliations。"
        "所有 evidence 对象必须且只能包含 turn、fact、fields。冲突证据的 fields 填被争议字段；关系证据固定填写 fields=[\"relationship\"]。关系变更必须填写两个有效 id，以及 upsert 或 remove。除 JSON 外不要输出任何内容。\n\n"
        "# 唯一 JSON 结构模板\n\n" + schema
    )


def _merge_runtime_cast_batch(previous, batch, start_turn, end_turn,
                              response_language="zh", persona=None,
                              story_ledger=None):
    """Build the next cast snapshot from evidence-backed durable changes."""
    previous = previous if isinstance(previous, dict) else {}
    language = _locale_code(response_language)
    roster = [{"id": c.get("id"), "name": c.get("name")}
              for c in (previous.get("characters") or []) if isinstance(c, dict)]
    if not roster:
        result = dict(previous)
        result["applied_turn"] = end_turn
        result["revision"] = int(previous.get("revision") or 0) + 1
        result["updated_at"] = int(time.time())
        return result
    system_prompt = _runtime_cast_system_prompt(language)
    payload = json.dumps({
        "roster": roster,
        "user_persona": persona or {},
        "current_cast": {
            "characters": {str(c.get("id")): {
                               "origin_profile": c.get("origin_profile") or c.get("profile") or {},
                               "current_profile": c.get("profile") or {},
                               "persistent_status": c.get("persistent_status") or {},
                           }
                           for c in previous.get("characters") or [] if isinstance(c, dict)},
            "origin_user_profile": previous.get("origin_user_profile") or {},
            "current_user_profile": previous.get("user_profile") or (persona or {}).get("profile") or {},
            "user_status": previous.get("user_status") or {},
            "relationships": previous.get("relationships") or [],
        },
        "new_story_batch": batch,
        "story_ledger": story_ledger or {},
        "range": {"start_turn": start_turn, "end_turn": end_turn},
    }, ensure_ascii=False)
    last_error = None
    for mem_model in _memory_models():
        def validate_runtime_cast(out):
            raw = _canonicalize_runtime_cast_output(
                _json_from_model_text(out), start_turn, end_turn)
            review_error = _runtime_cast_review_error(
                raw, roster, start_turn, end_turn)
            if review_error:
                raise ValueError(review_error)
            shape_error = _runtime_cast_shape_error(
                raw, roster, start_turn, end_turn)
            if shape_error:
                raise ValueError(shape_error)
            noop_error = _runtime_cast_noop_error(raw, previous, persona)
            if noop_error:
                raise ValueError(noop_error)
            result = _normalize_runtime_cast_result(
                raw, previous, start_turn, end_turn, persona)
            if len(result.get("characters") or []) != len(previous.get("characters") or []):
                raise ValueError("normalized cast changed roster size")
            return result

        status, result, error = _validated_model_call([
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": payload},
        ], 0.0, mem_model, 4500, validate_runtime_cast, language, "runtime_cast")
        if status == "ok":
            return result
        last_error = error
        if status == "upstream_error":
            print("runtime_cast upstream failed with %s:" % mem_model.get("model"),
                  repr(error), file=sys.stderr, flush=True)
            continue
        print("runtime_cast output rejected from %s after same-model retry:" %
              mem_model.get("model"), repr(error), file=sys.stderr, flush=True)
        return None
    print("runtime_cast batch failed:", repr(last_error), file=sys.stderr, flush=True)
    return None


_STORY_STATE_RUN_LOCKS = {}
_STORY_STATE_RUN_LOCKS_GUARD = threading.Lock()


def _story_state_progress(p):
    story = (p or {}).get("story") or []
    compressible_turns = _compressible_story_turns(story)
    previous = _validated_story_state((p or {}).get("story_state") or {}, story)
    covered_turns = int(previous.get("turns") or 0)
    return compressible_turns, covered_turns


def _story_state_sync_trigger(pid):
    """Describe the checkpoint a client should watch without delaying the reply."""
    p = load_production(pid)
    if not p:
        return {"watch": False, "revision": 0}
    compressible_turns, covered_turns = _story_state_progress(p)
    runtime_cast = _ensure_runtime_cast(p)
    due = compressible_turns - covered_turns >= STORY_STATE_BATCH_TURNS
    pending = BACKGROUND_JOBS.is_active(("story_state", pid))
    return {
        "watch": due or pending,
        "revision": int(runtime_cast.get("revision") or 0),
        "target_turn": covered_turns + STORY_STATE_BATCH_TURNS if due else covered_turns,
    }


def _story_state_sync_view(pid, since_revision=0):
    """Return a small polling response and projections only after a completed commit."""
    p = load_production(pid)
    if not p:
        return None
    compressible_turns, covered_turns = _story_state_progress(p)
    runtime_cast = _ensure_runtime_cast(p)
    revision = int(runtime_cast.get("revision") or 0)
    pending = BACKGROUND_JOBS.is_active(("story_state", pid))
    changed = revision != int(since_revision or 0)
    result = {
        "production_id": pid,
        "pending": pending,
        "due": compressible_turns - covered_turns >= STORY_STATE_BATCH_TURNS,
        "changed": changed,
        "ready": changed and not pending,
        "revision": revision,
        "applied_turn": int(runtime_cast.get("applied_turn") or 0),
        "story_state_turns": covered_turns,
        "error": str(((p.get("runtime") or {}).get("story_state_error") or ""))[:500],
    }
    if result["ready"]:
        result.update({
            "runtime_cast": runtime_cast,
            "cards": p.get("cards") or [],
            "persona": p.get("persona") or {},
        })
    return result


def _story_state_run_lock(pid):
    with _STORY_STATE_RUN_LOCKS_GUARD:
        return _STORY_STATE_RUN_LOCKS.setdefault(pid, threading.Lock())


def _commit_story_state_batch(pid, state, runtime_cast, end_turn, expected_signature,
                              expected_cast_revision):
    """Atomically publish one complete plot ledger and cast snapshot checkpoint."""
    with _production_lock(pid):
        current = load_production(pid)
        if not current:
            return None
        if _story_prefix_signature(current.get("story") or [], end_turn) != expected_signature:
            return None
        current_cast = _ensure_runtime_cast(current)
        if int(current_cast.get("revision") or 0) != int(expected_cast_revision or 0):
            return None
        published = dict(state)
        published["turns"] = end_turn
        published["covered_signature"] = expected_signature
        published.pop("stale", None)
        current["story_state"] = published
        current["runtime_cast"] = runtime_cast
        _hydrate_runtime_cards(current)
        _hydrate_user_persona(current)
        runtime = dict(current.get("runtime") or {})
        runtime.pop("state_stale_reason", None)
        runtime.pop("story_state_error", None)
        current["runtime"] = runtime
        record = _production_record(current)
        STATE_STORE.write("productions", pid, record)
    try:
        story_profile.sync_story_states(STATE, SEED_ACTOR, _list_productions())
    except Exception as error:
        print(f"[story-profile] story memory sync failed: {error}", flush=True)
    return current


def _record_story_state_error(pid, error):
    with _production_lock(pid):
        current = load_production(pid)
        if not current:
            return
        runtime = dict(current.get("runtime") or {})
        runtime["story_state_error"] = str(error)[:500]
        current["runtime"] = runtime
        record = _production_record(current)
        STATE_STORE.write("productions", pid, record)


def _summarize_story_state(p, force_full=False):
    """Compress confirmed 15-turn batches and publish each batch only on success."""
    pid = p["id"]
    with _story_state_run_lock(pid):
        snapshot = load_production(pid) or p
        story = snapshot.get("story") or []
        compressible_turns = _compressible_story_turns(story)
        stored_previous = snapshot.get("story_state") or {}
        previous = _validated_story_state(stored_previous, story)
        rebuild = force_full or (bool(stored_previous) and not previous)
        state = {} if rebuild else dict(previous)
        covered_turns = 0 if rebuild else int(previous.get("turns") or 0)
        cast_state = _ensure_runtime_cast(snapshot)
        ledger_roster = [
            {"id": item.get("id"), "name": item.get("name")}
            for item in (cast_state.get("characters") or [])
            if isinstance(item, dict) and item.get("id")
        ]
        if rebuild:
            # A plot-ledger rebuild must never replay or reset character evolution.
            # Rebuild the ledger in memory, then atomically move the preserved cast
            # checkpoint to the rebuilt ledger boundary without a cast model call.
            rebuilt_state = {}
            rebuilt_turns = 0
            language = _ensure_world_language(snapshot)
            while compressible_turns - rebuilt_turns >= STORY_STATE_BATCH_TURNS:
                start_turn = rebuilt_turns + 1
                end_turn = rebuilt_turns + STORY_STATE_BATCH_TURNS
                segments = _story_batch_segments(snapshot, start_turn, end_turn)
                if not segments or not any(batch.strip() for _, _, batch in segments):
                    _record_story_state_error(pid, "empty story batch during ledger rebuild")
                    return previous if previous else {}
                merged = rebuilt_state
                for segment_start, segment_end, batch in segments:
                    prefix = _story_messages_through_turn(story, segment_end)
                    source_tokens = _story_token_estimate(prefix)
                    merged = _merge_story_state_batch(
                        merged, batch, segment_start, segment_end, source_tokens,
                        language, ledger_roster)
                    if not merged:
                        break
                if not merged:
                    _record_story_state_error(
                        pid, f"ledger rebuild failed for turns {start_turn}-{end_turn}")
                    return previous if previous else {}
                rebuilt_state = merged
                rebuilt_turns = end_turn
            if not rebuilt_turns:
                return previous if previous else {}
            preserved_cast = json.loads(json.dumps(cast_state, ensure_ascii=False))
            expected_cast_revision = int(cast_state.get("revision") or 0)
            preserved_cast["applied_turn"] = rebuilt_turns
            preserved_cast["revision"] = expected_cast_revision + 1
            preserved_cast["updated_at"] = int(time.time())
            signature = _story_prefix_signature(story, rebuilt_turns)
            committed = _commit_story_state_batch(
                pid, rebuilt_state, preserved_cast, rebuilt_turns, signature,
                expected_cast_revision)
            if not committed:
                _record_story_state_error(pid, "story or cast changed during ledger rebuild")
                return previous if previous else {}
            return rebuilt_state
        if int(cast_state.get("applied_turn") or 0) != covered_turns:
            _record_story_state_error(pid, "cast snapshot and plot ledger checkpoints differ")
            return previous if previous else {}
        language = _ensure_world_language(snapshot)

        while compressible_turns - covered_turns >= STORY_STATE_BATCH_TURNS:
            start_turn = covered_turns + 1
            end_turn = covered_turns + STORY_STATE_BATCH_TURNS
            segments = _story_batch_segments(snapshot, start_turn, end_turn)
            if not segments or not any(batch.strip() for _, _, batch in segments):
                _record_story_state_error(pid, "empty story batch")
                break
            signature = _story_prefix_signature(story, end_turn)
            merged = state
            for segment_start, segment_end, batch in segments:
                prefix = _story_messages_through_turn(story, segment_end)
                source_tokens = _story_token_estimate(prefix)
                merged = _merge_story_state_batch(
                    merged, batch, segment_start, segment_end, source_tokens,
                    language, ledger_roster)
                if not merged:
                    break
            if not merged:
                _record_story_state_error(pid, f"compression failed for turns {start_turn}-{end_turn}")
                break
            complete_batch = _story_lines_for_turns(snapshot, start_turn, end_turn)
            expected_cast_revision = int(cast_state.get("revision") or 0)
            merged_cast = _merge_runtime_cast_batch(
                cast_state, complete_batch, start_turn, end_turn, language,
                snapshot.get("persona") or {}, merged)
            if not merged_cast:
                _record_story_state_error(pid, f"cast snapshot failed for turns {start_turn}-{end_turn}")
                break
            committed = _commit_story_state_batch(
                pid, merged, merged_cast, end_turn, signature, expected_cast_revision)
            if not committed:
                _record_story_state_error(pid, f"story or cast changed while processing turns {start_turn}-{end_turn}")
                break
            state = merged
            cast_state = merged_cast
            covered_turns = end_turn

        return state if _story_state_has_memory(state) else (previous if previous else {})

def ev_story_state(ev):
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    if ev.get("refresh"):
        return {"story_state": _summarize_story_state(p, force_full=True), "production_id": p["id"]}
    return {"story_state": p.get("story_state") or {}, "production_id": p["id"]}


def _maybe_auto_story_state(pid):
    while True:
        p = load_production(pid)
        if not p:
            return
        story = p.get("story") or []
        compressible_turns = _compressible_story_turns(story)
        prev = _validated_story_state(p.get("story_state") or {}, story)
        done_turns = int(prev.get("turns") or 0)
        if compressible_turns - done_turns < STORY_STATE_BATCH_TURNS:
            return
        try:
            _summarize_story_state(p)
        except Exception as error:
            _record_story_state_error(pid, error)
            return
        latest = load_production(pid) or {}
        latest_state = latest.get("story_state") or {}
        latest_done = int(latest_state.get("turns") or 0)
        if latest_done <= done_turns:
            return


def _schedule_story_state(pid):
    p = load_production(pid)
    if not p:
        return False
    compressible_turns, covered_turns = _story_state_progress(p)
    if compressible_turns - covered_turns < STORY_STATE_BATCH_TURNS:
        return False
    key = ("story_state", pid)
    was_active = BACKGROUND_JOBS.is_active(key)
    accepted = BACKGROUND_JOBS.submit(key, _maybe_auto_story_state, pid)
    return bool(accepted and not was_active)


def _schedule_story_state_backlog():
    for production in STATE_STORE.list("productions"):
        pid = production.get("id") if isinstance(production, dict) else None
        if pid and str(pid).startswith("prod_"):
            _schedule_story_state(pid)


def _reflect_production(p):
    """复盘一场戏 → 蒸馏偏好 → **合并进「我对你的了解」** + 记生涯年表。explicit + auto 共用。"""
    story = p.get("story", [])
    if sum(1 for m in story if m.get("role") == "user") < 2:
        return {"learned": None, "reason": "戏太短，没什么可学的"}
    cards, _, _, _ = _loadout(p)
    card = {"name": "、".join(c.get("name", "角色") for c in cards) or "角色"}
    learned = actor.reflect_on_play(card, story, actor_self_text(), model=_active_model())
    if not learned:
        return {"learned": None, "reason": "这场没看出明显偏好"}
    merged, _ = _record_actor_learning(
        learned, f"（复盘「{p.get('name', '')}」）")
    return {"learned": learned, "knows": merged, "production": p.get("name")}


def ev_reflect(ev):
    """复盘一场戏（显式触发）→ 蒸馏 + 合并进技艺层。「越演越懂你」的结构化触发（不靠 agent 临场）。"""
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    return _reflect_production(p)


def ev_reflect_preview(ev):
    """只预览复盘会学到什么，不写 actor_self.md。"""
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    story = p.get("story", [])
    if sum(1 for m in story if m.get("role") == "user") < 2:
        return {"learned": None, "reason": "戏太短，没什么可学的", "production": p.get("name")}
    cards, _, _, _ = _loadout(p)
    card = {"name": "、".join(c.get("name", "角色") for c in cards) or "角色"}
    learned = actor.reflect_on_play(card, story, actor_self_text(), model=_active_model())
    if not learned:
        return {"learned": None, "reason": "这场没看出足够明确的用户偏好", "production": p.get("name")}
    return {"learned": learned, "production": p.get("name"), "write": False}


def ev_set_persona(ev):
    pid = ev.get("production_id")
    if pid:
        p = load_production(pid)
        if not p:
            raise ValueError("production not found")
        source_card_id = str(ev.get("card_id") or "").strip()
        if source_card_id:
            source = load_card(source_card_id)
            if not source:
                raise ValueError("persona card not found")
            persona = _normalize_persona({**source, "source_card_id": source_card_id})
            status = _normalize_persistent_status({})
        else:
            current = _normalize_persona(p.get("persona") or {})
            merged_profile = json.loads(json.dumps(current.get("profile") or {}, ensure_ascii=False))
            incoming_profile = ev.get("profile") if isinstance(ev.get("profile"), dict) else {}
            for section, values in incoming_profile.items():
                if isinstance(values, dict):
                    merged_profile.setdefault(section, {}).update(values)
            if "name" in ev:
                merged_profile.setdefault("identity", {})["name"] = str(ev.get("name") or "").strip()
            if "description" in ev:
                merged_profile.setdefault("identity", {})["description"] = str(ev.get("description") or "").strip()
            persona = _normalize_persona({"profile": merged_profile})
            current_status = (p.get("runtime_cast") or {}).get("user_status") or {}
            status = _normalize_persistent_status(
                ev.get("persistent_status") if isinstance(ev.get("persistent_status"), dict)
                else current_status)
        p["persona"] = persona
        runtime_cast = _ensure_runtime_cast(p)
        current_profile = _canonical_profile_snapshot(persona.get("profile") or persona)
        runtime_cast["user_profile"] = current_profile
        runtime_cast["user_profile_updated_turn"] = _world_turns(p.get("story") or [])
        if (source_card_id or not _profile_has_content(runtime_cast.get("origin_user_profile") or {})
                or _world_turns(p.get("story") or []) == 0):
            runtime_cast["origin_user_profile"] = json.loads(json.dumps(
                current_profile, ensure_ascii=False))
        runtime_cast["user_status"] = status
        runtime_cast["revision"] = int(runtime_cast.get("revision") or 0) + 1
        runtime_cast["updated_at"] = int(time.time())
        p["turn_plan"] = {}
        _hydrate_user_persona(p)
        save_production(p)
        return {"persona": p["persona"], "production": p}
    persona = _normalize_persona({"name": ev.get("name", "我"), "description": ev.get("description", "")})
    _write(os.path.join(STATE, "persona.json"), persona)
    return {"persona": persona}


def ev_set_note(ev):
    """设/清本剧组的作者注释(导演提示)——当前场景方向,注入贴近生成点。
    结构化的「跟搭子说一句就长期生效」:agent 识别『回复短点/别用现代词』→ set_note。
    设计 canon:不暴露 UI 旋钮,由对话/agent 设。空串=清除。"""
    p = load_production(ev["production_id"])
    if not p:
        raise ValueError("production not found")
    p["author_note"] = (ev.get("note") or "").strip()
    save_production(p)
    return {"production_id": p["id"], "author_note": p["author_note"]}


# ---------- 大模型配置 ----------
# 用户自配的大模型使用 OpenAI-compatible 协议。官方目录固定为 Tavern 支持的模型；
# 自定义配置可由 reader 或 CLI 写入。key 只落 server 端 state 文件（0600），
# 任何读端点一律脱敏。
MODELS_PATH = os.path.join(STATE, "model_configs.json")
HERMES_CONFIG_PATH = os.environ.get("HERMES_CONFIG_PATH", "/opt/data/config.yaml")
OFFICIAL_MODELS = ("deepseek-v4-flash",)
MODEL_REGISTRY = ModelRegistry(
    MODELS_PATH,
    builtin_base=actor.MODEL_BASE,
    builtin_key=actor.MODEL_KEY,
    builtin_name=actor.MODEL_NAME,
    official_models=OFFICIAL_MODELS,
    ping=actor.ping,
    model_info=actor.model_info,
    validate_base=validate_outbound_http_base,
)


def _official_models():
    return MODEL_REGISTRY.official_models()


def _clawling_model_id(model_name):
    return MODEL_REGISTRY.model_id(model_name)


def _clawling_model_name(model_id):
    return MODEL_REGISTRY.model_name(model_id)


MEMORY_PRIMARY_MODEL = "deepseek-v4-flash"


def _memory_model():
    """剧情账本固定使用 DeepSeek V4 Flash，不跟随演绎模型切换。"""
    return {
        "base": actor.MODEL_BASE,
        "key": actor.MODEL_KEY,
        "model": MEMORY_PRIMARY_MODEL,
    }


def _clawling_memory_fallbacks(primary):
    """Read Clawling fallback candidates from Hermes config, never from code constants."""
    try:
        with open(HERMES_CONFIG_PATH, encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
    except (OSError, ValueError, TypeError, yaml.YAMLError) as e:
        print("memory fallback config unavailable:", repr(e), file=sys.stderr, flush=True)
        return []

    candidates = []
    seen = {str(primary.get("model") or "").strip()}

    def add(model, base=None):
        name = str(model or "").strip()
        if not name or name in seen:
            return
        seen.add(name)
        candidates.append({
            "base": str(base or actor.MODEL_BASE).strip() or actor.MODEL_BASE,
            "key": actor.MODEL_KEY,
            "model": name,
        })

    for item in config.get("fallback_providers") or []:
        if not isinstance(item, dict) or str(item.get("provider") or "").lower() != "clawling":
            continue
        add(item.get("model"), item.get("base_url"))

    # Configured Clawling catalog is the secondary source when no explicit
    # fallback order exists. Dict order is preserved by YAML/Python.
    if not candidates:
        clawling = ((config.get("providers") or {}).get("clawling") or {})
        for model in (clawling.get("models") or {}):
            add(model, clawling.get("api"))

    limit = max(1, int(os.environ.get("TAVERN_MEMORY_FALLBACK_LIMIT", "3")))
    return candidates[:limit]


def _memory_models():
    """Fixed primary plus config-driven Clawling fallbacks for story compression."""
    primary = _memory_model()
    return [primary, *_clawling_memory_fallbacks(primary)]


def _active_model():
    return MODEL_REGISTRY.active_override()


def _public_models():
    return MODEL_REGISTRY.public_view()


def ev_model_add(ev):
    return MODEL_REGISTRY.add(ev)


def ev_model_use(ev):
    return MODEL_REGISTRY.use(ev)


def ev_model_delete(ev):
    return MODEL_REGISTRY.delete(ev)


def ev_model_test(ev):
    return MODEL_REGISTRY.test(ev)

def ev_tts_voice_use(ev):
    voice = TTS_SERVICE.save_voice(ev.get("voice"))
    return {"voice": voice, "tts": TTS_SERVICE.settings()}


def ev_tts_preset_settings(ev):
    return {"tts": TTS_SERVICE.save_preset_settings(
        ev.get("voice"), ev.get("speed"), ev.get("instructions"))}


def ev_tts_clone_use(ev):
    return {"tts": TTS_SERVICE.use_clone(ev.get("clone_id"))}


def ev_tts_clone_delete(ev):
    return {"tts": TTS_SERVICE.delete_clone(ev.get("clone_id"))}


def ev_update_world_ui(ev):
    pid = str(ev.get("production_id") or "").strip()
    if not pid:
        raise ValueError("production_id is required")
    ui = _normalize_world_ui(ev.get("ui"))
    with _production_lock(pid):
        production = load_production(pid)
        if not production:
            raise ValueError("production not found")
        if ui:
            production["ui"] = ui
        else:
            production.pop("ui", None)
        STATE_STORE.write("productions", pid, _production_record(production))
    return {"production": production}


EVENTS = {
    "cancel_generation": ev_cancel_generation,
    "import_card": ev_import_card, "import_card_json": ev_import_card_json, "create_card": ev_create_card,
    "import_worldbook": ev_import_worldbook, "attach_worldbook": ev_attach_worldbook,
    "add_lore": ev_add_lore, "update_lore": ev_update_lore, "delete_lore": ev_delete_lore,
    "attach_card": ev_attach_card, "update_cast": ev_update_cast, "detach_card": ev_detach_card, "delete_card": ev_delete_card,
    "create_production": ev_create_production, "create_blank_production": ev_create_blank_production,
    "switch_loadout": ev_switch_loadout,
    "prepare_delete_production": ev_prepare_delete_production,
    "delete_production": ev_delete_production,
    "send_message": ev_send_message,
    "regenerate": ev_regenerate,
    "continue": ev_continue, "suggest": ev_suggest,
    "story_state": ev_story_state,
    "swipe": ev_swipe, "edit_message": ev_edit_message, "actor_grow": ev_actor_grow,
    "reflect": ev_reflect, "reflect_preview": ev_reflect_preview,
    "refresh_story_profile": ev_refresh_story_profile,
    "set_persona": ev_set_persona, "set_note": ev_set_note,
    "model_add": ev_model_add, "model_use": ev_model_use,
    "model_delete": ev_model_delete, "model_test": ev_model_test,
    "tts_voice_use": ev_tts_voice_use,
    "tts_preset_settings": ev_tts_preset_settings,
    "tts_clone_use": ev_tts_clone_use, "tts_clone_delete": ev_tts_clone_delete,
    "update_world_ui": ev_update_world_ui,
}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _csp_nonce(self):
        nonce = getattr(self, "_request_csp_nonce", "")
        if not nonce:
            nonce = secrets.token_urlsafe(18)
            self._request_csp_nonce = nonce
        return nonce

    def end_headers(self):
        nonce = self._csp_nonce()
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), geolocation=(), microphone=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; "
            f"style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-{nonce}'; "
            "connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'",
        )
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", CONTENT_TYPES[".json"])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _authorize_api(self, *, state_changing=False):
        reason = REQUEST_AUTHORIZER.rejection_reason(
            self.headers, state_changing=state_changing)
        if reason:
            self._json(403, {"ok": False, "error": reason})
            return False
        return True

    def _audio(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, max-age=3600")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _tts_reference(self, token):
        clone, path = TTS_SERVICE.reference(token)
        if not clone or not path:
            return self._json(404, {"error": "not found"})
        with open(path, "rb") as file:
            body = file.read()
        self.send_response(200)
        self.send_header("Content-Type", clone.get("mime") or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, max-age=300")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _file(self, path, cache_control="no-store, must-revalidate"):
        if not os.path.isfile(path):
            return self._json(404, {"error": "not found"})
        ext = os.path.splitext(path)[1]
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        # reader 是活件页面、随 agent 迭代频繁更新——禁缓存,否则 WKWebView/WebView2 可能
        # serve 旧 app.js,改动不生效(反馈 2026-06-30「还是不行」的头号嫌疑)。
        self.send_header("Cache-Control", cache_control)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_html(self, name, assets):
        # 注入版本化资源引用破 relay 缓存:clawling relay/CDN 把 .js/.css 强制缓存成
        # `public, max-age=2592000, immutable`(30天,覆盖源站 no-store)→ 改动不生效。
        # html 自身是 no-store(relay 透传)永远新,所以给资源 URL 挂 ?v=<token>。
        # 文件名 + 纳秒 mtime + size 做稳定指纹；不能 XOR 秒级 mtime，多文件同秒更新
        # 会彼此抵消，导致 relay 继续命中旧的 immutable 资源。
        try:
            with open(os.path.join(READER, name), encoding="utf-8") as f:
                html = f.read()
        except OSError:
            return self._json(404, {"error": "not found"})
        fingerprint = hashlib.sha256()
        for fn in (name,) + tuple(assets):
            try:
                stat = os.stat(os.path.join(READER, fn))
                fingerprint.update(f"{fn}\0{stat.st_mtime_ns}\0{stat.st_size}\n".encode("utf-8"))
            except OSError:
                fingerprint.update(f"{fn}\0missing\n".encode("utf-8"))
        v = fingerprint.hexdigest()[:12]
        for a in assets:
            # Replace both bare assets and assets that already carry an older
            # cache token, while limiting the match to quoted HTML attributes.
            pattern = r"([\"'])" + re.escape(a) + r"(?:\?v=[^\"']*)?\1"
            html = re.sub(pattern, lambda m: f"{m.group(1)}{a}?v={v}{m.group(1)}", html)
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES[".html"])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


    def _clawchat_redirect(self):
        q = parse_qs(urlparse(self.path).query)
        draft = (q.get("draft", [""])[0] or "").strip()
        uid = agent_user_id()
        if not uid:
            body = f"{app_identity().get('persona_name', '角色')}的 ClawChat 身份还没有就绪。".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return
        target = f"clawchat://u/{quote(uid)}?chat=1&draft={quote(draft)}"
        js_target = json.dumps(target, ensure_ascii=False)
        safe_target = html.escape(target, quote=True)
        persona_name = html.escape(app_identity().get("persona_name", "角色"), quote=True)
        nonce = self._csp_nonce()
        body = f"""<!doctype html>
<html lang=\"zh-CN\"><head><meta charset=\"utf-8\" />
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
<title>打开{persona_name}</title>
<style>body{{font:15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#181611;color:#eee;padding:24px;line-height:1.7}}a{{color:#ff8a3d}}</style>
<script nonce=\"{nonce}\">setTimeout(function(){{ location.href = {js_target}; }}, 30);</script>
</head><body>
<p>正在打开{persona_name}的聊天窗口…</p>
<p><a href=\"{safe_target}\">如果没有自动跳转，点这里继续</a></p>
</body></html>""".encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        return self.do_GET()

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/") and not self._authorize_api():
            return
        if path.startswith("/world-assets/"):
            try:
                asset_path = safe_static_path(WORLD_ASSETS, path[len("/world-assets"):])
            except ValueError:
                return self._json(404, {"error": "not found"})
            if os.path.splitext(asset_path)[1].lower() not in WORLD_ASSET_EXTENSIONS:
                return self._json(404, {"error": "not found"})
            return self._file(asset_path, "private, max-age=86400, immutable")
        if path == "/clawchat/agent":
            return self._clawchat_redirect()
        if path == "/api/health":
            # model_info 传 active override → health 反映当前实际生效的模型
            return self._json(200, {"ok": True, "dry_run": False, "tts_base": TTS_SERVICE.base,
                                    "background_jobs": BACKGROUND_JOBS.stats(),
                                    "http_workers": self.server.max_workers,
                                    "tts_cache": TTS_SERVICE.cache_stats(),
                                    **actor.model_info(_active_model())})
        if path == "/api/models":
            # 大模型配置列表(脱敏,key 永不出 server)——reader 管理面 + CLI model list 共用
            return self._json(200, _public_models())
        if path == "/api/tts/config":
            return self._json(200, TTS_SERVICE.settings())
        if path.startswith("/api/tts/reference/"):
            return self._tts_reference(path.rsplit("/", 1)[-1])
        if path == "/api/cards":
            return self._json(200, {"cards": _library_cards()})
        if path == "/api/worldbooks":
            return self._json(200, {"worldbooks": _list("worldbooks")})
        if path == "/api/library/cards":
            return self._json(200, {"cards": _library_cards()})
        if path == "/api/library/worldbooks":
            return self._json(200, {"worldbooks": _library_worldbooks()})
        if path == "/api/production/worldbooks":
            pid = parse_qs(urlparse(self.path).query).get("production_id", [""])[0]
            try:
                worldbooks = _production_worldbooks(pid)
            except ValueError as error:
                return self._json(400, {"error": str(error)})
            return self._json(200, {"worldbooks": worldbooks})
        if path == "/api/production/state-sync":
            q = parse_qs(urlparse(self.path).query)
            pid = q.get("production_id", [""])[0]
            try:
                since_revision = int(q.get("since", ["0"])[0] or 0)
            except (TypeError, ValueError):
                since_revision = 0
            try:
                result = _story_state_sync_view(pid, since_revision)
            except ValueError as error:
                return self._json(400, {"error": str(error)})
            if result is None:
                return self._json(404, {"error": "production not found"})
            return self._json(200, result)
        if path == "/api/productions":
            query = parse_qs(urlparse(self.path).query)
            summaries = (query.get("summary", [""])[0] or "").lower() in {"1", "true", "yes"}
            productions = _list_production_summaries() if summaries else _list_productions()
            return self._json(200, {"productions": productions,
                                    "active": _get_state().get("active_production_id")})
        if path == "/api/production":
            pid = parse_qs(urlparse(self.path).query).get("production_id", [""])[0]
            try:
                production = load_production(pid)
            except ValueError:
                production = None
            if not production:
                return self._json(404, {"error": "production not found"})
            return self._json(200, {"production": production})
        if path == "/api/identity":
            return self._json(200, {**app_identity(), "agent_user_id": agent_user_id()})
        if path == "/api/actor":
            # 兼容技能/旧前端的故事档案原文与应用元数据；当前控制台使用轻量 /api/identity。
            return self._json(200, {"actor_self": actor_self_text(), "version": liveware_version(),
                                    "agent_user_id": agent_user_id(),
                                    "actor_url": (f"https://{_actor_host()}/" if _actor_host() else "")})
        if path == "/api/persona":
            # Persona is now scoped to each world. Keep this endpoint for older frontends,
            # but never return the legacy global persona because that causes cross-world bleed.
            return self._json(200, {})
        if path == "/api/actor_card":
            # 演员卡聚合（生涯数值、亲密度、口味、年表），只读。
            # ?lang= 只换 UI 标签(级名/blurb);非 zh 一律走 en 表(回落链对齐 reader)。
            q = parse_qs(urlparse(self.path).query)
            lang = (q.get("lang", ["zh"])[0] or "zh")[:2].lower()
            return self._json(200, actor_card_data(lang))
        # static reader（*.html 走版本化注入,破 relay 的 immutable 缓存）
        rel = path.lstrip("/") or "index.html"
        if rel == "index.html":
            # 一台 server 服务两个活件 app（同 :8799，靠 tunnel 透传的 X-Forwarded-Host 分流）：
            # 控制台 app 的 / → index；演员卡 app（第二个活件卡入口）的 / → actor.html。
            fwd = self.headers.get("X-Forwarded-Host", "") or self.headers.get("X-Original-Host", "")
            ah = _actor_host()
            if ah and ah in fwd:
                return self._serve_html(
                    "actor.html", ("console.css", "i18n.js", "security.js", "actor.js"))
            return self._serve_html(
                "index.html", ("console.css", "i18n.js", "security.js", "bridge.js", "app.js"))
        if path == "/actor" or rel == "actor.html":  # 直达路径也保留（任一 app 域名 + /actor 都能开）
            return self._serve_html(
                "actor.html", ("console.css", "i18n.js", "security.js", "actor.js"))
        try:
            static_path = safe_static_path(READER, path)
        except ValueError:
            return self._json(404, {"error": "not found"})
        return self._file(static_path)

    def _read_body(self, limit=MAX_EVENT_BODY_BYTES):
        return read_request_body(self, limit)

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith("/api/") and not self._authorize_api(state_changing=True):
            return
        if path == "/api/stream":
            return self._json(410, {"ok": False, "error": "streaming disabled"})
        try:
            body_limit = MAX_CLONE_BODY_BYTES if path == "/api/tts/clone" else MAX_EVENT_BODY_BYTES
            request_body = self._read_body(body_limit)
        except RequestBodyTooLarge as error:
            return self._json(413, {"ok": False, "error": str(error)})
        except ValueError as error:
            return self._json(400, {"ok": False, "error": str(error)})
        if path == "/api/tts":
            try:
                ev = json.loads(request_body or b"{}")
                return self._audio(TTS_SERVICE.generate(ev.get("text")))
            except Exception as e:
                return self._json(502, {"ok": False, "error": str(e)})
        if path == "/api/tts/preview":
            try:
                ev = json.loads(request_body or b"{}")
                audio = TTS_SERVICE.generate(
                    TTS_SERVICE.preview_text, voice=ev.get("voice"), speed=ev.get("speed"),
                    instructions=ev.get("instructions"), force_preset=True)
                return self._audio(audio)
            except ValueError as e:
                return self._json(400, {"ok": False, "error": str(e)})
            except Exception as e:
                return self._json(502, {"ok": False, "error": str(e)})
        if path == "/api/tts/clone":
            try:
                ev = json.loads(request_body or b"{}")
                settings = TTS_SERVICE.save_clone(
                    ev.get("audio"), ev.get("ref_text"), ev.get("name"), ev.get("speed"))
                return self._json(200, {"ok": True, "tts": settings})
            except ValueError as e:
                return self._json(400, {"ok": False, "error": str(e)})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)})
        if path != "/api/event":
            return self._json(404, {"error": "unknown endpoint"})
        try:
            ev = json.loads(request_body or b"{}")
        except Exception:
            return self._json(400, {"error": "bad json"})
        fn = EVENTS.get(ev.get("type"))
        if not fn:
            return self._json(400, {"error": "unknown event type: %s" % ev.get("type")})
        try:
            return self._json(200, {"ok": True, **fn(ev)})
        except ProductionRevisionConflict as e:
            return self._json(409, {
                "ok": False,
                "code": "state_conflict",
                "error": "character state changed",
                "current_revision": e.current_revision,
            })
        except ValueError as e:
            return self._json(400, {"ok": False, "error": str(e)})
        except Exception as e:
            return self._json(500, {"ok": False, "error": str(e)})


def main():
    port = 8799
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    elif os.environ.get("TAVERN_PORT"):
        port = int(os.environ["TAVERN_PORT"])
    host = os.environ.get("TAVERN_HOST", "127.0.0.1")
    TTS_SERVICE.migrate()
    TTS_SERVICE.cleanup(force=True)
    migrated = _migrate_worldbook_storage()
    if migrated:
        print(f"worldbook storage migrated: {migrated} production(s)", flush=True)
    print("酒馆演员运行时 → http://%s:%d  (model=%s, key=%s)" % (
        host, port, actor.MODEL_NAME, "set" if actor.MODEL_KEY else "MISSING"))
    _schedule_story_state_backlog()
    BoundedThreadingHTTPServer((host, port), H).serve_forever()


if __name__ == "__main__":
    main()
