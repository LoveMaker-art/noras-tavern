#!/usr/bin/env python3
"""tavern_cli — 主理人酒馆的世界、角色与设定工具。

给 agent 一条干净路径，替代「在浏览器手搓 PNG + 跑 JS 怼 /api/event」那套硬凑
（会撞作用域错、btoa(UTF-8) 把中文搞乱码、世界设定 Promise 不 resolve）。

卡来源 = Chub.ai（角色卡事实标准库，6 万+ 卡，公开 API、免鉴权）。**Chub 不可达时
（墙内无代理 / 网络受限）自动降级到随仓打包的 starter 真卡**——离线也能开启世界，绝不回退
到手搓 PNG。导入直打本地控制台同源事件 API（默认 http://127.0.0.1:8799，env TAVERN_CONSOLE 覆盖）。

命令：
  search <query> [--n N]                   搜 Chub → 候选列表（名 · fullPath · ⭐ · 标签）；Chub 连不上→列 starter
  inspect-card <文件|直链|Chub路径>          识别并审查 V1/V2/V3 JSON/PNG/CHARX，不写入
  prepare-card <文件|直链|Chub路径>          整理并预览外部卡，不写入
  apply-card-plan <计划.json> --confirm      确认后原子写入主卡、配角卡和世界书
  import-card <文件|直链|Chub路径>           兼容入口；默认预览，--confirm 后写入
  add <fullPath|Chub链接> [--new-world]      兼容旧命令：下载 Chub 真卡 → 导入角色库
  starter [<序号|名字>] [--new-world]        列出/导入随仓内置 starter 真卡
  add-original <jsonfile|-> [--new-world]   原创卡 JSON → 导入角色库；显式要求时才开启世界
  add-worldbook <jsonfile|-> [--production PID]   世界设定 JSON → 导入（可挂到现有世界）
  build-world <manifest.json|->             预览或原子创建完整世界
  app-link [--app console|actor] [--json]   读取当前实例的 Liveware 入口
  note <world> "<提示>"                     设/清世界导演提示（场景方向，空串清除）
  list                                     列出当前世界 / 角色 / 设定

纯 stdlib（urllib），不依赖控制台代码——它只发 HTTP。
"""
import argparse
import base64
import json
import os
import ipaddress
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import re


def _default_hermes_home():
    configured = os.environ.get("HERMES_HOME")
    if configured:
        return os.path.abspath(os.path.expanduser(configured))
    # Preserve existing managed ClawChat instances whose shell predates the
    # documented HERMES_HOME export. New installations use Hermes' default.
    if sys.platform.startswith("linux") and os.path.isdir("/opt/data/skills"):
        return "/opt/data"
    return os.path.join(os.path.expanduser("~"), ".hermes")


HERMES_HOME = _default_hermes_home()
TAVERN_DATA_ROOT = os.path.abspath(os.path.expanduser(
    os.environ.get("TAVERN_DATA_ROOT", HERMES_HOME)
))
TAVERN_APP_DIR = os.path.abspath(os.path.expanduser(
    os.environ.get("TAVERN_APP_DIR", os.path.join(TAVERN_DATA_ROOT, "apps", "tavern-runtime"))
))
CONSOLE = os.environ.get("TAVERN_CONSOLE", "http://127.0.0.1:8799").rstrip("/")
CHUB_SEARCH = "https://api.chub.ai/search"
CHUB_CARD = "https://avatars.charhub.io/avatars/{full_path}/chara_card_v2.png"
UA = "tavern-cli/1.0"
CHUB_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
CHUB_HEADERS = {
    "User-Agent": CHUB_UA,
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Referer": "https://chub.ai/",
    "Origin": "https://chub.ai",
}
CHUB_IMAGE_HEADERS = {
    **CHUB_HEADERS,
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
}
# 随仓打包的 starter 真卡（tavern/assets/fixtures/starter/）——Chub 不可达时的离线兜底。
STARTER_DIR = os.environ.get(
    "TAVERN_STARTER_DIR", os.path.join(TAVERN_APP_DIR, "assets", "fixtures", "starter")
)
TAVERN_STATE_DIR = os.environ.get(
    "TAVERN_STATE_DIR", os.path.join(TAVERN_DATA_ROOT, "tavern-state")
)
CUSTOM_STARTER_DIR = os.path.join(TAVERN_STATE_DIR, "starter")
TAVERN_APPS_FILE = os.environ.get(
    "TAVERN_APPS_FILE",
    os.path.join(TAVERN_STATE_DIR, "apps.json"),
)
TAVERN_SKILL_ROOT = os.environ.get(
    "TAVERN_SKILL_ROOT", os.path.join(HERMES_HOME, "skills")
)
TAVERN_AGENTS_FILE = os.environ.get(
    "TAVERN_AGENTS_FILE", os.path.join(HERMES_HOME, "AGENTS.md")
)
MAX_EXTERNAL_CARD_BYTES = 20 * 1024 * 1024


class ChubUnreachable(Exception):
    """Chub 网络不可达（DNS/超时/连接失败）——触发 starter 兜底。区别于 HTTP 4xx（可达但请求错）。"""


def _die(msg):
    print("错误：" + msg, file=sys.stderr)
    sys.exit(1)


def _print_json(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _json_result(operation, result=None, **extra):
    payload = {"ok": True, "operation": operation}
    if result is not None:
        payload["result"] = result
    payload.update(extra)
    _print_json(payload)


def _http(url, data=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        _die(f"HTTP {e.code} {url}\n{body}")
    except Exception as e:  # noqa: BLE001
        _die(f"请求失败 {url}: {e}")


def _validate_external_url(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        _die("外部角色卡只接受公开 HTTPS 直链")
    host = parsed.hostname.lower().rstrip(".")
    if host in {"localhost", "localhost.localdomain"}:
        _die("外部角色卡地址不能指向本机")
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
        }
    except OSError as exc:
        _die(f"无法解析角色卡地址：{exc}")
    for value in addresses:
        ip = ipaddress.ip_address(value)
        if not ip.is_global:
            _die("外部角色卡地址不能指向内网、回环或保留地址")
    return parsed


class _SafeCardRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_external_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch_external_card(url):
    _validate_external_url(url)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": CHUB_UA,
            "Accept": "application/json,image/png,image/apng,*/*;q=0.5",
        },
    )
    try:
        opener = urllib.request.build_opener(_SafeCardRedirectHandler())
        with opener.open(req, timeout=60) as response:
            final_url = response.geturl()
            _validate_external_url(final_url)
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > MAX_EXTERNAL_CARD_BYTES:
                _die("角色卡文件不能超过 20 MB")
            body = response.read(MAX_EXTERNAL_CARD_BYTES + 1)
    except urllib.error.HTTPError as exc:
        _die(f"角色卡下载失败：HTTP {exc.code}")
    except Exception as exc:  # noqa: BLE001
        _die(f"角色卡下载失败：{exc}")
    if len(body) > MAX_EXTERNAL_CARD_BYTES:
        _die("角色卡文件不能超过 20 MB")
    return body, final_url


def _decode_card_document(raw, label):
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "png", raw
    if raw[:4] == b"PK\x03\x04":
        return "charx", raw
    try:
        text = raw.decode("utf-8-sig")
        value = json.loads(text)
    except Exception:
        _die(f"{label} 不是有效的角色卡 PNG、JSON 或 CHARX")
    if not isinstance(value, dict):
        _die(f"{label} 的 JSON 根节点必须是对象")
    return "json", value


def _load_external_card(source):
    value = source.strip()
    if value == "-":
        return "json", _read_json_arg("-"), "stdin", ""
    if os.path.isfile(value):
        with open(value, "rb") as file:
            raw = file.read(MAX_EXTERNAL_CARD_BYTES + 1)
        if len(raw) > MAX_EXTERNAL_CARD_BYTES:
            _die("角色卡文件不能超过 20 MB")
        kind, payload = _decode_card_document(raw, value)
        return kind, payload, "file", ""
    if value.startswith(("https://", "http://")):
        parsed = urllib.parse.urlparse(value)
        is_chub_page = (
            parsed.hostname in {"chub.ai", "www.chub.ai", "characterhub.org", "www.characterhub.org"}
            and any(marker in parsed.path for marker in ("/characters/", "/character/"))
            and not parsed.path.lower().endswith((".png", ".json"))
        )
        if is_chub_page:
            value = _parse_full_path(value)
        else:
            raw, final_url = _fetch_external_card(value)
            kind, payload = _decode_card_document(raw, value)
            return kind, payload, "external", final_url
    fp = _parse_full_path(value)
    url = CHUB_CARD.format(full_path=urllib.parse.quote(fp))
    try:
        raw = _chub_get(url, timeout=60, image=True)
    except ChubUnreachable as exc:
        _die(f"Chub 角色卡下载失败：{exc}")
    except urllib.error.HTTPError as exc:
        _die(f"Chub 角色卡下载失败：HTTP {exc.code}")
    kind, payload = _decode_card_document(raw, value)
    return kind, payload, "chub", url


def _inspect_external_card(kind, payload):
    event = {"type": "inspect_card"}
    if kind == "png":
        event["png_base64"] = base64.b64encode(payload).decode("ascii")
    elif kind == "charx":
        event["charx_base64"] = base64.b64encode(payload).decode("ascii")
    else:
        event["card"] = payload
    return _event(event)["inspection"]


def _external_card_event(kind, payload, source, source_url):
    event = {"source": source, "source_url": source_url}
    if kind == "png":
        event["png_base64"] = base64.b64encode(payload).decode("ascii")
    elif kind == "charx":
        event["charx_base64"] = base64.b64encode(payload).decode("ascii")
    else:
        event["card"] = payload
    return event


def _prepare_external_card(kind, payload, source, source_url):
    event = _external_card_event(kind, payload, source, source_url)
    event["type"] = "prepare_card"
    return _event(event)["preparation"]


def _print_card_preparation(plan):
    summary = plan.get("summary") or {}
    print("\n=== 角色卡整理预览 ===")
    print("主角色：" + str(summary.get("main_character") or "未识别"))
    print("人物资料：" + ("已形成可用档案" if summary.get("profile_ready") else "不完整"))
    supporting = summary.get("supporting_characters") or []
    print("独立配角：" + ("、".join(supporting) if supporting else "无"))
    print(f"世界设定：{int(summary.get('worldbook_entries') or 0)} 条")
    print(f"归入主角色的内嵌条目：{int(summary.get('main_character_entries') or 0)} 条")
    print(f"待判断条目：{int(summary.get('unresolved_entries') or 0)} 条")
    for warning in summary.get("warnings") or []:
        print("注意：" + str(warning))


def _write_preparation(path, plan):
    with open(path, "w", encoding="utf-8") as file:
        json.dump(plan, file, ensure_ascii=False, indent=2)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _print_card_inspection(report):
    print(
        f"格式：{str(report.get('format') or '?').upper()} · "
        f"{report.get('spec') or '未声明 spec'} {report.get('spec_version') or ''} · "
        f"{str(report.get('container') or 'json').upper()}"
    )
    print(f"角色：{report.get('name') or '?'}" + (
        f" · 作者 {report['creator']}" if report.get("creator") else ""
    ))
    print(
        f"内容：备用开场 {report.get('alternate_greetings', 0)} · "
        f"群组开场 {report.get('group_only_greetings', 0)} · "
        f"内嵌设定 {report.get('embedded_worldbook_entries', 0)} · "
        f"资源 {report.get('assets', 0)}"
    )
    unknown = list(report.get("unknown_root_fields") or []) + list(
        report.get("unknown_data_fields") or []
    )
    if unknown:
        print("兼容扩展：已保留 " + "、".join(unknown[:12]))
    for warning in report.get("warnings") or []:
        print("注意：" + warning)


def _event(ev):
    """POST 一个控制台事件，返回解析后的 dict。
    server 对事件异常回 HTTP 500 + {ok:false,error:人话}——这里接住 body 只报人话
    （别走 _http 的 HTTPError 分支打「HTTP 500 + 原始 JSON」，主理人要把错误读给用户）。"""
    body = json.dumps(ev, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(CONSOLE + "/api/event", data=body,
                                 headers={"User-Agent": UA, "Content-Type": "application/json"})
    try:
        # A complex external card is prepared in several complete semantic
        # batches. Its total request may legitimately outlive one model call.
        timeout = 900 if ev.get("type") == "prepare_card" else 150
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
    except Exception as e:  # noqa: BLE001
        _die(f"请求失败 {CONSOLE}/api/event: {e}")
    try:
        res = json.loads(raw)
    except Exception:
        _die("控制台返回不是 JSON：" + raw.decode("utf-8", "replace")[:200])
    if isinstance(res, dict) and (res.get("error") or res.get("ok") is False):
        _die("控制台报错：" + str(res.get("error")))
    return res


def _read_json_arg(arg):
    """从文件或 stdin('-') 读 JSON。"""
    if arg == "-":
        text = sys.stdin.read()
    else:
        with open(arg, encoding="utf-8") as file:
            text = file.read()
    try:
        return json.loads(text)
    except Exception as e:  # noqa: BLE001
        _die(f"JSON 解析失败：{e}")


def _looks_like_cloudflare_block(body):
    text = body.decode("utf-8", "replace").lower()
    return "cloudflare" in text or "attention required" in text or "sorry, you have been blocked" in text


def _chub_get(url, timeout=30, image=False):
    """Fetch Chub with browser-like headers. Network/Cloudflare blocks degrade to starter."""
    headers = CHUB_IMAGE_HEADERS if image else CHUB_HEADERS
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        body = e.read()
        if e.code in (403, 429, 503) and _looks_like_cloudflare_block(body):
            raise ChubUnreachable("外部卡库门口临时加了验证") from e
        raise  # semantic HTTP errors like 404 should remain visible
    except Exception as e:  # DNS / timeout / refused / proxy failure
        raise ChubUnreachable(str(e)) from e


def _parse_full_path(arg):
    """接受裸 fullPath，或用户直贴的 Chub / CharacterHub 链接，抽出 `<owner>/<slug>`。"""
    s = arg.strip()
    for marker in ("/characters/", "/character/"):
        if marker in s:
            s = s.split(marker, 1)[1]
            break
    else:
        if "/avatars/" in s:  # 直贴下载 URL 也兜一下
            s = s.split("/avatars/", 1)[1].rsplit("/chara_card", 1)[0]
    return s.split("?", 1)[0].split("#", 1)[0].strip().strip("/")


def _starter_key(card):
    for field in ("file", "card_json", "source", "name"):
        value = str(card.get(field) or "").strip()
        if value:
            return f"{field}:{value}"
    return ""


def _starter_document(directory):
    path = os.path.join(directory, "index.json")
    if not os.path.exists(path):
        return {"cards": [], "disabled": []}
    try:
        with open(path, encoding="utf-8") as f:
            document = json.load(f)
        if not isinstance(document, dict) or not isinstance(document.get("cards"), list):
            return {"cards": [], "disabled": []}
        return document
    except Exception:  # noqa: BLE001
        return {"cards": [], "disabled": []}


def _load_starter_index():
    official = _starter_document(STARTER_DIR)
    custom = _starter_document(CUSTOM_STARTER_DIR)
    disabled = {str(value) for value in (custom.get("disabled") or [])}
    cards = {}
    order = []
    for directory, entries in (
            (STARTER_DIR, official.get("cards") or []),
            (CUSTOM_STARTER_DIR, custom.get("cards") or [])):
        for raw in entries:
            if not isinstance(raw, dict):
                continue
            key = _starter_key(raw)
            if not key or key in disabled:
                continue
            card = dict(raw)
            card["_starter_dir"] = directory
            if key not in cards:
                order.append(key)
            cards[key] = card
    return [cards[key] for key in order if key in cards]


def _print_starter_list(cards):
    print(f"内置 starter 真卡 {len(cards)} 张（随仓打包、离线可用、SFW/跨题材）：\n")
    for i, c in enumerate(cards, 1):
        wb = " · 世界设定" if c.get("worldbook") else ""
        print(f"[{i}] {c.get('name', '?')}  ·  {c.get('genre', '')}{wb}")
        if c.get("blurb"):
            print(f"    {c['blurb']}")
    print("\n→ 开启世界：tavern_cli.py starter <序号或名字>")


def _degrade_to_starter(reason):
    """Chub 不可达时的沉浸式降级出口。绝不回退到手搓 PNG。"""
    cards = _load_starter_index()
    if not cards:
        print("外面的卡库现在进不去，酒馆里也没有可用的内置卡。稍后再试，或先配置代理/出口。")
        return
    print("外面的卡库现在有点进不去，像是门口临时加了验证。")
    print("不耽误开场。酒馆里有几张能直接用的 starter 卡，我们可以先从这里挑一张入场。\n")
    _print_starter_list(cards)


# ---------- commands ----------
def cmd_search(a):
    q = urllib.parse.urlencode({
        "search": a.query, "first": a.n,
        "sort": "star_count", "asc": "false",
    })
    try:
        raw = _chub_get(f"{CHUB_SEARCH}?{q}", timeout=30)
    except ChubUnreachable as e:
        _degrade_to_starter(f"Chub 搜索连不上（{e}）")
        return
    except urllib.error.HTTPError as e:
        if e.code == 403:
            _degrade_to_starter("外部卡库门口临时加了验证")
            return
        _die(f"Chub 搜索 HTTP {e.code}。可先用 `starter` 内置卡。")
    nodes = (json.loads(raw).get("data") or {}).get("nodes") or []
    if not nodes:
        print("（没搜到，换个关键词试试——英文名通常命中率更高）")
        return
    print(f"Chub 命中 {len(nodes)} 张（按星数）：\n")
    for i, n in enumerate(nodes, 1):
        topics = ", ".join((n.get("topics") or [])[:6])
        desc = (n.get("description") or "").replace("\n", " ")[:90]
        print(f"[{i}] {n.get('name','?')}  ·  ⭐{n.get('starCount',0)}")
        print(f"    fullPath: {n.get('fullPath','?')}")
        if topics:
            print(f"    标签: {topics}")
        if desc:
            print(f"    简介: {desc}")
        print()
    print("→ 选定后：tavern_cli.py add <fullPath>")


def _create_production(card, name=None):
    p = _event({"type": "create_production", "card_id": card["id"],
                "name": name or card.get("name")})["production"]
    wb = " + 世界设定" if card.get("character_book") else ""
    print(f"✅ 已开启世界「{p['name']}」（{p['id']}）{wb}")
    print(f"   角色卡：{card.get('name')}（{card['id']}）")
    if card.get("first_mes"):
        print(f"   开场白：{card['first_mes'][:120]}")
    print(f"   控制台：{CONSOLE}/  （世界列表里点它即可开演）")
    return p


def cmd_add(a):
    fp = _parse_full_path(a.full_path)  # 裸 fullPath 或用户直贴的 Chub 链接都吃
    url = CHUB_CARD.format(full_path=urllib.parse.quote(fp))
    print(f"↓ 从 Chub 下载真卡：{fp}")
    try:
        png = _chub_get(url, timeout=60, image=True)
    except ChubUnreachable as e:
        _degrade_to_starter(f"Chub 下载连不上（{e}）")
        return
    except urllib.error.HTTPError as e:
        _die(f"HTTP {e.code}：这张卡在 Chub 取不到（fullPath 可能写错，或该卡没有公开的 "
             f"chara_card_v2.png）。\n先 `search` 确认 fullPath，或 `starter` 用内置卡。")
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        _die("下载的不是 PNG（fullPath 可能写错）。用 `search` 拿准确 fullPath，或 `starter` 用内置卡。")
    report = _inspect_external_card("png", png)
    plan = _prepare_external_card("png", png, "chub", url)
    _print_card_inspection(report)
    _print_card_preparation(plan)
    if not a.confirm:
        print("尚未写入角色库。核对预览后重新运行并添加 --confirm。")
        return
    _apply_preparation(plan, a.new_world, a.name)


def cmd_inspect_card(a):
    kind, payload, _source, _source_url = _load_external_card(a.source)
    report = _inspect_external_card(kind, payload)
    if a.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_card_inspection(report)


def cmd_prepare_card(a):
    kind, payload, source, source_url = _load_external_card(a.source)
    report = _inspect_external_card(kind, payload)
    plan = _prepare_external_card(kind, payload, source, source_url)
    if a.output:
        _write_preparation(a.output, plan)
    if a.json:
        print(json.dumps({"inspection": report, "preparation": plan}, ensure_ascii=False, indent=2))
        return
    _print_card_inspection(report)
    _print_card_preparation(plan)
    if a.output:
        print("整理计划：" + a.output)
    print("尚未写入角色库。确认内容后运行 apply-card-plan。")


def _apply_preparation(plan, new_world=False, world_name=None):
    result = _event({
        "type": "apply_card_preparation",
        "preparation": plan,
        "confirm": True,
    })
    card = result["card"]
    supporting = result.get("supporting_cards") or []
    print(f"✅ 已整理并导入主角色：{card.get('name')}（{card['id']}）")
    if supporting:
        print("✅ 已收入角色库的配角：" + "、".join(item.get("name") or "?" for item in supporting))
    if new_world:
        _create_production(card, world_name)
    return result


def cmd_apply_card_plan(a):
    if not a.confirm:
        _die("写入前必须显式添加 --confirm")
    plan = _read_json_arg(a.plan)
    _print_card_preparation(plan)
    _apply_preparation(plan, a.new_world, a.name)


def cmd_import_card(a):
    kind, payload, source, source_url = _load_external_card(a.source)
    report = _inspect_external_card(kind, payload)
    plan = _prepare_external_card(kind, payload, source, source_url)
    _print_card_inspection(report)
    _print_card_preparation(plan)
    if not a.confirm:
        print("尚未写入角色库。核对预览后重新运行并添加 --confirm。")
        return
    _apply_preparation(plan, a.new_world, a.name)


def cmd_starter(a):
    cards = _load_starter_index()
    if not cards:
        _die("没有内置 starter 卡（fixtures/starter/index.json 缺失或损坏）。")
    if not a.which:
        _print_starter_list(cards)
        return
    entry = _resolve_starter(cards, a.which)
    if not entry:
        _die(f"没找到 starter 卡「{a.which}」——`starter` 不带参数看列表（可用序号或名字片段）。")
    card_json = entry.get("card_json")
    card_file = entry.get("file")
    path = os.path.join(entry.get("_starter_dir") or STARTER_DIR, card_json or card_file or "")
    if not os.path.exists(path):
        _die(f"starter 卡文件缺失：{path}")
    print(f"↓ 导入内置 starter 卡：{entry['name']}（{entry.get('genre', '')}）")
    if card_json:
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
        card = _event({"type": "import_card_json", "card": payload,
                       "source": entry.get("source") or "builtin:starter"})["card"]
    else:
        with open(path, "rb") as f:
            png = f.read()
        card = _event({"type": "import_card",
                       "png_base64": base64.b64encode(png).decode("ascii"),
                       "source": entry.get("source") or "builtin:starter"})["card"]
    print(f"✅ 已导入角色库：{card.get('name')}（{card['id']}）")
    if a.new_world:
        _create_production(card, a.name)


def _resolve_starter(cards, which):
    w = which.strip()
    if w.isdigit():
        i = int(w) - 1
        return cards[i] if 0 <= i < len(cards) else None
    wl = w.lower()
    for c in cards:
        if wl in c.get("name", "").lower() or wl in c.get("file", "").lower():
            return c
    return None


def cmd_add_original(a):
    card_obj = _read_json_arg(a.json)
    card = _event({"type": "import_card_json", "card": card_obj})["card"]
    print(f"✅ 已导入原创角色卡：{card.get('name')}（{card['id']}）")
    if a.new_world:
        _create_production(card, a.name)


def cmd_add_worldbook(a):
    wb_obj = _read_json_arg(a.json)
    wb = _event({"type": "import_worldbook", "worldbook": wb_obj})["worldbook"]
    print(f"✅ 已导入世界设定「{wb.get('name','?')}」（{wb['id']}，{len(wb.get('entries',[]))} 条）")
    if a.production:
        _event({"type": "attach_worldbook", "production_id": a.production,
                "worldbook_id": wb["id"]})
        print(f"   已挂到世界 {a.production}")


def cmd_recall(a):
    # 读某个世界在控制台里实际演了什么（主理人在 ClawChat 里看不到 production.story，
    # 这是它唯一的「读酒馆对话」入口——别再说「我看不到酒馆里聊了什么」）。
    prods = _get_productions()
    q = a.production
    matches = [p for p in prods if p.get("id") == q or q in (p.get("name") or "")]
    if not matches:
        _die(f"没找到世界「{q}」——先 `list` 看有哪些。")
    p = matches[0]
    story = p.get("story", [])
    cards = {c["id"]: c for c in json.loads(_http(CONSOLE + "/api/cards", timeout=15)).get("cards", [])}
    cname = (cards.get(p.get("card_id")) or {}).get("name") or "角色"
    shown = story[-a.last:] if a.last and len(story) > a.last else story
    if a.json:
        messages = []
        for message in shown:
            character_id = message.get("character_id") or message.get("card_id")
            speaker = "用户" if message.get("role") == "user" else (
                (cards.get(character_id) or {}).get("name") or cname
            )
            messages.append({
                "id": message.get("id"),
                "role": message.get("role"),
                "character_id": character_id,
                "speaker": speaker,
                "text": message.get("text", ""),
            })
        _json_result(
            "recall",
            {
                "world_id": p.get("id"),
                "world_name": p.get("name"),
                "total_messages": len(story),
                "returned_messages": len(messages),
                "truncated": len(shown) < len(story),
                "messages": messages,
            },
        )
        return
    print(f"=== 世界「{p.get('name')}」（{p['id']}）· 角色 {cname} · 共 {len(story)} 条 ===")
    if len(shown) < len(story):
        print(f"（只显示最后 {len(shown)} 条，共 {len(story)}）\n")
    for m in shown:
        who = "你" if m.get("role") == "user" else cname
        print(f"{who}：{m.get('text', '')}\n")


def cmd_learn(a):
    # 把用户明确表达的长期故事偏好写入唯一生效的结构化故事档案。
    # 后端会据此刷新受控的 USER.md / MEMORY.md 投射；actor_self.md 不是数据源。
    res = _event({"type": "actor_grow", "change": a.change, "reason": a.reason or ""})
    if a.json:
        _json_result("learn", res)
        return
    print("✅ 已记进故事档案:", res.get("appended", "(已写)"))


def _resolve_production_for_cli(q):
    prods = _get_productions()
    matches = [p for p in prods if p.get("id") == q or q in (p.get("name") or "")]
    if not matches:
        _die(f"没找到世界「{q}」——先 `list` 看有哪些。")
    return matches[0]


def cmd_reflect(a):
    # 复盘一场戏，由服务端模型提炼可复用偏好并写入结构化故事档案。
    p = _resolve_production_for_cli(a.production)
    res = _event({"type": "reflect", "production_id": p["id"]})
    if res.get("learned"):
        print(f"✅ 从「{p['name']}」复盘学到，已写进故事档案：\n{res['learned']}")
    else:
        print(f"（这场没学到：{res.get('reason', '')}）")


def cmd_reflect_preview(a):
    # 只预览复盘结果，不写入结构化故事档案。
    p = _resolve_production_for_cli(a.production)
    res = _event({"type": "reflect_preview", "production_id": p["id"]})
    print(f"=== 复盘预览：{p['name']} ===")
    if res.get("learned"):
        print(res["learned"])
        print("\n未写入故事档案。确认有价值后再运行：")
        print(f"python3 {os.path.abspath(__file__)!r} reflect {p['name']!r}")
    else:
        print(f"（这场暂时不建议写入：{res.get('reason', '')}）")

def cmd_note(a):
    # 设/清本世界的「导演提示」(作者注释):场景方向,注入贴近生成点。
    # 用户说「回复短点 / 别用现代词 / 多点环境描写」→ 你 set 一句,长期生效(不靠模型记着)。
    # 空 note 清除。这是结构化的「跟搭子说一句就长期生效」,不暴露 UI 旋钮。
    prods = _get_productions()
    q = a.production
    matches = [p for p in prods if p.get("id") == q or q in (p.get("name") or "")]
    if not matches:
        _die(f"没找到世界「{q}」——先 `list` 看有哪些。")
    p = matches[0]
    res = _event({"type": "set_note", "production_id": p["id"], "note": a.note})
    if a.json:
        _json_result("note", {
            "world_id": p.get("id"),
            "world_name": p.get("name"),
            "author_note": res.get("author_note") or "",
            "cleared": not bool(res.get("author_note")),
        })
        return
    if res.get("author_note"):
        print(f"✅ 「{p['name']}」导演提示已设：{res['author_note']}")
    else:
        print(f"（「{p['name']}」导演提示已清空）")


# ---------- 大模型配置（帮助用户配置自定义 API） ----------
def _models():
    d = json.loads(_http(CONSOLE + "/api/models", timeout=15))
    return d.get("configs", []), d.get("active", "builtin")


def _active_name():
    configs, active = _models()
    return next((c["name"] for c in configs if c["id"] == active), "内置模型")


def cmd_model_list(a):
    configs, active = _models()
    if a.json:
        public = []
        for config in configs:
            public.append({
                "id": config.get("id"),
                "name": config.get("name"),
                "model": config.get("model"),
                "base": config.get("base"),
                "builtin": bool(config.get("builtin")),
                "key_set": bool(config.get("key_set")),
                "key_masked": config.get("key_masked"),
                "active": config.get("id") == active,
            })
        _json_result("model.list", {"active_id": active, "configs": public})
        return
    print("大模型配置（✓ = 当前在用）：")
    for c in configs:
        mark = "✓" if c["id"] == active else "·"
        if c.get("builtin"):
            key = "agent 环境自带" if c.get("key_set") else "⚠️ 容器里没配到 key"
            print(f"  {mark} 内置模型 — {c.get('model', '')}（{key}）")
        else:
            print(f"  {mark} {c['name']} — {c['model']}（key {c.get('key_masked', '')} · {c.get('base', '')}）")
    print("（加新配置：`model add <名> --base <url> --model <id> --key <key>`，会先实测、通了才落盘）")


def cmd_model_add(a):
    res = _event({"type": "model_add", "name": a.name, "base": a.base,
                  "model": a.model, "key": a.key})
    c = res.get("config", {})
    if a.json:
        _json_result("model.add", {
            "id": c.get("id"),
            "name": c.get("name"),
            "model": c.get("model"),
            "base": c.get("base"),
            "key_masked": c.get("key_masked"),
            "latency_ms": res.get("latency_ms"),
        })
        return
    print(f"✅ 已配好并切换：{c.get('name')} — {c.get('model')}"
          f"（实测通，{res.get('latency_ms')}ms · key {c.get('key_masked')}）")
    print("（跟用户确认时只报名字和 key 尾 4 位，永远不要复述完整 key）")


def cmd_model_use(a):
    res = _event({"type": "model_use", "id": a.which})
    if a.json:
        _json_result("model.use", {"id": res.get("id"), "name": res.get("name")})
        return
    print(f"✅ 已切换到：{res.get('name')}（下一回合就用它）")


def cmd_model_rm(a):
    res = _event({"type": "model_delete", "id": a.which})
    if a.json:
        _json_result("model.remove", {"name": res.get("name"), "active_name": _active_name()})
        return
    print(f"✅ 已删除：{res.get('name')}（当前在用：{_active_name()}）")


def cmd_model_test(a):
    res = _event({"type": "model_test", "id": a.which or "builtin"})
    if a.json:
        _json_result("model.test", {
            "model": res.get("model"),
            "base": res.get("base"),
            "latency_ms": res.get("latency_ms"),
        })
        return
    print(f"✅ 通：{res.get('model')} @ {res.get('base')} · {res.get('latency_ms')}ms")


def cmd_card(a):
    # 只读取故事档案材料：了解程度、偏好、最近记录、玩过的角色/题材。
    # 分析与推荐由主理人在聊天中完成，不放在工具层。
    d = json.loads(_http(CONSOLE + "/api/actor_card", timeout=15))
    if a.json:
        _json_result("story-profile.read", d)
        return
    c, it = d.get("career", {}), d.get("intimacy", {})
    print("=== 故事档案材料 ===")
    print(f"了解程度：{it.get('level','初见')} · {it.get('blurb','')}")
    print(f"互动记录：{c.get('productions',0)} 个世界 · {c.get('turns',0)} 轮 · "
          f"{c.get('words',0)} 字 · {it.get('log',0)} 笔成长记录")
    knows = d.get("knows", [])
    print("我对用户的了解：")
    if knows:
        for k in knows:
            print("  -", k)
    else:
        print("  - 暂无明确偏好记录")
    specs = d.get("specialties", [])
    if specs:
        print("出现过的题材/标签：")
        for x in specs[:8]:
            print("  -", x)
    roles = d.get("roles_played", [])
    if roles:
        print("走过的角色：")
        for r in roles[:8]:
            print(f"  - {r.get('name','角色')} · {r.get('turns',0)} 轮")
    tl = d.get("timeline", [])
    if tl:
        print("最近故事记录：")
        for e in tl[:5]:
            reason = e.get("reason") or ""
            suffix = f"（{reason}）" if reason else ""
            print(f"  - {e.get('date','')} {e.get('change','')}{suffix}")
    url = d.get("actor_url") or (CONSOLE + "/actor")
    print(f"故事档案活件：{url}")



def _actor_profile():
    return json.loads(_http(CONSOLE + "/api/actor_card", timeout=15))


def _clean_items(items, limit=8):
    out = []
    for x in items or []:
        if isinstance(x, dict):
            text = x.get("change") or x.get("name") or x.get("reason") or json.dumps(x, ensure_ascii=False)
        else:
            text = str(x)
        text = re.sub(r"\s+", " ", text).strip()
        if text and text not in out:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def _infer_profile_signals(d):
    knows = _clean_items(d.get("knows", []), 12)
    specs = _clean_items(d.get("specialties", []), 10)
    roles = []
    for r in d.get("roles_played", []) or []:
        name = r.get("name") if isinstance(r, dict) else str(r)
        if name and name not in roles:
            roles.append(name)
        if len(roles) >= 8:
            break
    timeline = _clean_items(d.get("timeline", []), 8)
    text = " ".join(knows + specs + roles + timeline)
    signals = []
    rules = [
        ("慢热关系", ["慢热", "克制", "暧昧", "拉扯", "日常", "细腻"]),
        ("强设定/暗线", ["阴谋", "组织", "秘密", "世界观", "势力", "主线", "悬疑"]),
        ("多角色互动", ["多角色", "群像", "剧组", "队伍", "阵营"]),
        ("角色陪伴感", ["温柔", "陪伴", "治愈", "安静"]),
        ("动作冲突", ["战斗", "危机", "追杀", "冒险", "能力"]),
    ]
    for label, keys in rules:
        hits = [k for k in keys if k in text]
        if hits:
            signals.append((label, "、".join(hits[:4])))
    return knows, specs, roles, timeline, signals


def cmd_profile_audit(a):
    """Read the story curator's story profile and turn it into recommendation signals."""
    d = _actor_profile()
    c, it = d.get("career", {}), d.get("intimacy", {})
    knows, specs, roles, timeline, signals = _infer_profile_signals(d)
    if a.json:
        _json_result("story-profile.audit", {
            "intimacy": {
                "level": it.get("level", "初见"),
                "log_count": it.get("log", 0),
            },
            "career": {
                "world_count": c.get("productions", 0),
                "turn_count": c.get("turns", 0),
            },
            "preferences": knows,
            "topics": specs,
            "roles": roles,
            "signals": [
                {"label": label, "evidence": evidence}
                for label, evidence in signals
            ],
            "recent_timeline": timeline[:5],
            "has_recommendation_evidence": bool(knows or specs or roles or signals),
        })
        return
    print("=== 推荐信号：故事档案只读分析 ===")
    print(f"了解程度：{it.get('level','初见')} · 世界 {c.get('productions',0)} 个 · 对话 {c.get('turns',0)} 轮 · 成长记录 {it.get('log',0)} 笔")
    print("\n可用偏好：")
    for x in knows or ["暂无明确偏好，推荐时应给一个低门槛方向，并在对话里轻轻校准。"]:
        print("  - " + x)
    if specs:
        print("\n出现过的题材/标签：")
        for x in specs:
            print("  - " + x)
    if roles:
        print("\n走过的角色：")
        for x in roles:
            print("  - " + x)
    print("\n推荐判断：")
    if signals:
        for label, why in signals:
            print(f"  - {label}：由 {why} 推出")
    else:
        print("  - 当前档案信号偏少：优先推荐入口清晰、角色关系强、设定负担低的世界。")
    if timeline:
        print("\n最近线索：")
        for x in timeline[:5]:
            print("  - " + x)
    print("\n使用方式：若用户要推荐世界/角色，先读这里，再用自然语言给 1 个主方案 + 1 个备选，不要让用户填复杂表单。")


def _topic_terms(text):
    text = text or ""
    known = [
        "暗线", "学院", "多角色", "群像", "身份", "特殊身份", "组织", "势力", "王国", "都市",
        "奇幻", "现代", "悬疑", "冒险", "战斗", "日常", "恋爱", "慢热", "克制", "误会", "秘密",
        "教团",
    ]
    out = []
    for k in known:
        if k in text and k not in out:
            out.append(k)
    # Keep short Latin/fandom tokens too, but avoid swallowing the whole Chinese sentence.
    for w in re.findall(r"[A-Za-z0-9_\-]{2,}", text):
        if w not in out:
            out.append(w)
    if not out:
        chunks = re.split(r"[，。；、,.;\s]+", text)
        for c in chunks:
            c = c.strip("想要一个的世界角色剧情故事设定")
            if 1 < len(c) <= 8 and c not in out:
                out.append(c)
    return out[:10]


def _style_hint(text, profile_signals):
    joined = text + " " + " ".join(x[0] for x in profile_signals)
    if any(k in joined for k in ["悬疑", "阴谋", "暗线", "秘密"]):
        return "暗线清晰、信息分层、每轮给一点可追查的线索"
    if any(k in joined for k in ["日常", "治愈", "温柔", "陪伴"]):
        return "慢热、细节密、冲突低但关系推进明确"
    if any(k in joined for k in ["战斗", "冒险", "追杀", "能力"]):
        return "目标明确、场面有压力、角色行动差异要明显"
    return "入口简单、关系先行、设定逐步揭开"


def cmd_plan_world(a):
    """Plan a world from a loose idea. Read-only: no app/state mutation."""
    idea = a.idea.strip()
    if not idea:
        _die("想法不能为空。")
    profile = _actor_profile() if not a.no_profile else {}
    knows, specs, roles, timeline, signals = _infer_profile_signals(profile) if profile else ([], [], [], [], [])
    terms = _topic_terms(idea)
    style = a.style or _style_hint(idea, signals)
    world_name = a.name or (" · ".join(terms[:2]) if terms else "未命名世界")
    protagonist = "用户的角色：放在「我的角色」里，写身份、能力边界、已知关系；不要塞进世界书当 {{user}}。"
    cast = [
        "核心对手/牵引者：推动第一场冲突，和用户角色有明确关系张力。",
        "同盟/观察者：负责解释局势、补足情绪回声，但不抢用户行动。",
        "变量角色：带来误会、任务或危险，让多角色调度有理由发生。",
    ]
    lore_keys = terms[:5] or ["地点", "组织", "规则"]
    print("=== 世界规划（只读，不创建）===")
    print(f"世界名建议：{world_name}")
    print(f"用户想法：{idea}")
    print(f"叙事手感：{style}")
    if signals:
        print("\n结合档案：")
        for label, why in signals[:4]:
            print(f"  - {label}：{why}")
    elif not a.no_profile:
        print("\n结合档案：信号较少，按低门槛开场处理。")
    print("\n结构拆分：")
    print("  - World：世界容器，承载角色、设定、历史和当前方向。")
    print("  - Persona：" + protagonist)
    print("  - Cast：导入或创建多个角色卡，角色卡只写角色本人声音、欲望、边界。")
    print("  - Lore：地点、势力、规则、秘密、物件、历史事件放进世界设定。")
    print("  - Story state：已发生剧情、关系变化、未解决伏笔由运行时压缩维护。")
    print("\n推荐登场配置：")
    for x in cast:
        print("  - " + x)
    print("\n首批设定条目：")
    for k in lore_keys:
        print(f"  - {k}：写成一条可被关键词触发的设定，避免用过宽词单独触发。")
    print("\n开场钩子：")
    print("  - 让用户角色已经在场，第一轮直接遇到可回应的人、可选择的事、可追查的异常。")
    print("\n落地顺序：")
    print(f"  1. new-world --name \"{world_name}\"")
    print("  2. search/add 或 add-original 导入核心角色卡，再 attach-card 加入世界")
    print("  3. add-lore 逐条加入地点、势力、规则、秘密，不要一次塞成长篇百科")
    print("  4. 在右栏完善「我的角色」，再开第一场")


def _card_name(c):
    return c.get("name") or c.get("data", {}).get("name") or c.get("id") or "角色"


def _card_tags(c):
    tags = c.get("tags") or []
    if not tags and isinstance(c.get("data"), dict):
        tags = c["data"].get("tags") or []
    return [str(t) for t in tags if str(t).strip()]


def _score_item(text, query_terms, profile_terms):
    hay = text.lower()
    score = 0
    for t in query_terms:
        if t and t.lower() in hay:
            score += 4
    for t in profile_terms:
        if t and t.lower() in hay:
            score += 1
    return score


def cmd_recommend(a):
    """Recommend a world/cast direction from actor profile + local library. Read-only."""
    want = (a.want or "").strip()
    d = _actor_profile()
    c, it = d.get("career", {}), d.get("intimacy", {})
    knows, specs, roles, timeline, signals = _infer_profile_signals(d)
    terms = _topic_terms(want)
    profile_terms = terms + specs + roles + [x[0] for x in signals]
    cards = _get_cards()
    prods = _get_productions()
    scored_cards = []
    for card in cards:
        name = _card_name(card)
        tags = _card_tags(card)
        text = " ".join([name, card.get("description") or "", card.get("personality") or ""] + tags)
        score = _score_item(text, terms, profile_terms)
        if score or not terms:
            scored_cards.append((score, name, tags, card.get("id")))
    scored_cards.sort(key=lambda x: (-x[0], x[1]))
    scored_worlds = []
    cards_by_id = {card.get("id"): card for card in cards}
    for prod in prods:
        ids = prod.get("card_ids") or ([prod.get("card_id")] if prod.get("card_id") else [])
        cast_names = [_card_name(cards_by_id.get(cid, {})) for cid in ids if cid]
        text = " ".join([prod.get("name") or ""] + cast_names)
        score = _score_item(text, terms, profile_terms)
        if score or not terms:
            scored_worlds.append((score, prod.get("name") or "未命名世界", cast_names, prod.get("id"), len(prod.get("story") or [])))
    scored_worlds.sort(key=lambda x: (-x[0], x[1]))

    style = _style_hint(want, signals)
    world_name = " · ".join(terms[:2]) if terms else "低门槛新世界"
    print("=== 主理人推荐底稿（只读）===")
    print(f"用户想法：{want or '未指定，按故事档案推荐'}")
    print(f"档案：{it.get('level','初见')} · 世界 {c.get('productions',0)} 个 · 对话 {c.get('turns',0)} 轮")
    print(f"推荐手感：{style}")
    if signals:
        print("\n来自故事档案的依据：")
        for label, why in signals[:4]:
            print(f"  - {label}：{why}")
    elif knows:
        print("\n来自故事档案的依据：")
        for x in knows[:4]:
            print("  - " + x)
    else:
        print("\n来自故事档案的依据：档案还浅，先给入口清晰、关系明确的方案。")

    print("\n主推荐：")
    if scored_worlds:
        _, wname, cast_names, wid, nstory = scored_worlds[0]
        cast = "、".join(cast_names[:4]) or "暂无角色"
        print(f"  - 继续/整理现有世界：{wname}（{wid}，{nstory} 条记录，角色：{cast}）")
        print("  - 适合先做：补齐我的角色、清理世界设定触发词，再开下一场。")
    else:
        print(f"  - 开新世界：{world_name}")
        print("  - 适合先做：确定用户身份，再放 2-3 个有明确戏剧功能的角色。")

    print("\n可用角色库：")
    if scored_cards:
        for _, name, tags, cid in scored_cards[:5]:
            tag = "、".join(tags[:4]) if tags else "无标签"
            print(f"  - {name}（{cid}）· {tag}")
    else:
        print("  - 本地角色库没有明显匹配；需要 search/add 导入新卡，或 add-original 创建原创卡。")

    print("\n建议开场：")
    if "暗线" in terms or any(label == "强设定/暗线" for label, _ in signals):
        print("  - 从一个已经发生的小异常开始，让用户角色在场，同时让一名角色主动抛出线索。")
    elif "多角色" in terms or any(label == "多角色互动" for label, _ in signals):
        print("  - 第一场只让 2-3 人入场：一个牵引、一个解释、一个制造变量，避免全员同时说话。")
    else:
        print("  - 从一个可回应的人和一个可选择的事件开始，不先堆百科。")

    if getattr(a, "external", False):
        qtext = want or " ".join(specs[:3]) or "roleplay"
        print("\n外部卡库候选：")
        q = urllib.parse.urlencode({"search": qtext, "first": min(max(a.n, 1), 8),
                                    "sort": "star_count", "asc": "false"})
        try:
            raw = _chub_get(f"{CHUB_SEARCH}?{q}", timeout=20)
            nodes = (json.loads(raw).get("data") or {}).get("nodes") or []
            if nodes:
                for i, n in enumerate(nodes[:a.n], 1):
                    topics = ", ".join((n.get("topics") or [])[:4])
                    print(f"  [{i}] {n.get('name','?')} · {n.get('fullPath','?')}" + (f" · {topics}" if topics else ""))
                print("  选定后：add <fullPath>，再放入完整世界清单。")
            else:
                print("  - 外部卡库没有命中；换英文名/作品名再搜。")
        except Exception as e:
            print(f"  - 外部卡库暂时不可用：{e}")
            print("  - 可先用 starter 或本地角色库继续。")

    print("\n落地命令顺序：")
    print("  1. 若用现有世界：diagnose <世界>，必要时 lore-audit <世界>")
    print(f"  2. 若开新世界：plan-world \"{want or world_name}\"，再整理 build-world 清单")
    print("  3. 若需要外部角色：recommend --external <想法>，再 add <fullPath>")
    print("  4. 用 add-lore 逐条接住设定；用户身份写入右栏「我的角色」")

def _get_productions():
    raw = _http(CONSOLE + "/api/productions", timeout=15)
    d = json.loads(raw)
    return d if isinstance(d, list) else d.get("productions", [])


def _get_cards():
    raw = _http(CONSOLE + "/api/cards", timeout=15)
    d = json.loads(raw)
    return d if isinstance(d, list) else d.get("cards", [])


def _get_worldbooks():
    raw = _http(CONSOLE + "/api/worldbooks", timeout=15)
    d = json.loads(raw)
    return d if isinstance(d, list) else d.get("worldbooks", [])


def _production_card_ids(p):
    ids = p.get("card_ids") or ([] if not p.get("card_id") else [p.get("card_id")])
    out = []
    for cid in ids:
        if cid and cid not in out:
            out.append(cid)
    return out



def _card_field(card, *names):
    for name in names:
        v = card.get(name)
        if v:
            return str(v)
    data = card.get("data") if isinstance(card.get("data"), dict) else {}
    for name in names:
        v = data.get(name)
        if v:
            return str(v)
    return ""


def _card_book_entries(card):
    books = []
    for key in ("character_book", "worldbook", "book"):
        b = card.get(key)
        if b:
            books.append(b)
    data = card.get("data") if isinstance(card.get("data"), dict) else {}
    for key in ("character_book", "worldbook", "book"):
        b = data.get(key)
        if b:
            books.append(b)
    entries = []
    for b in books:
        if isinstance(b, dict):
            entries.extend(b.get("entries") or [])
    return entries


def _short(text, n=160):
    text = " ".join(str(text or "").split())
    return text[:n] + ("..." if len(text) > n else "")


def cmd_card_audit(a):
    """Read-only quality audit for a local character card."""
    card = _resolve_card(a.card)
    name = _card_name(card)
    desc = _card_field(card, "description", "desc")
    personality = _card_field(card, "personality")
    scenario = _card_field(card, "scenario")
    first_mes = _card_field(card, "first_mes", "first_message", "mes_example")
    mes_example = _card_field(card, "mes_example", "example_dialogue")
    tags = _card_tags(card)
    entries = _card_book_entries(card)
    blob = json.dumps(card, ensure_ascii=False)
    findings = []

    if not desc or len(desc) < 80:
        findings.append(("高", "角色描述过短或缺失，模型很难稳定把握身份。"))
    if not personality or len(personality) < 40:
        findings.append(("中", "personality 偏短或缺失，角色声音可能不稳。"))
    if not first_mes or len(first_mes) < 30:
        findings.append(("高", "开场白缺失或过短，第一场很难自然入场。"))
    if "{{user}}" in blob:
        findings.append(("中", "存在 {{user}} 占位符；若用户有独立 persona，需确认不会混淆身份。"))
    if entries:
        findings.append(("低", f"角色卡内含 {len(entries)} 条 character_book/worldbook；需要确认是角色私有设定，不是整部世界百科。"))
    long_fields = []
    for label, text in (("description", desc), ("personality", personality), ("scenario", scenario), ("first_mes", first_mes), ("mes_example", mes_example)):
        if len(text) > 3000:
            long_fields.append(label)
    if long_fields:
        findings.append(("中", "字段过长，可能挤占上下文：" + "、".join(long_fields)))
    world_words = ["世界观", "王国", "帝国", "组织", "势力", "历史", "规则", "魔法体系", "教团", "商会"]
    role_words = ["性格", "说话", "口癖", "目标", "欲望", "害怕", "关系", "边界", "行动"]
    world_hits = [w for w in world_words if w in desc + scenario]
    role_hits = [w for w in role_words if w in desc + personality]
    if len(world_hits) >= 4 and len(role_hits) < 3:
        findings.append(("中", "角色卡像在写世界设定多于写角色本人；建议把地点/势力/历史移入世界书。"))
    if any(x in blob for x in ["你将扮演", "用户扮演", "User is", "{{char}} and {{user}}"]):
        findings.append(("低", "卡内可能写了用户身份或扮演关系；多角色世界中建议把用户身份放到「我的角色」。"))

    print(f"=== 角色卡审计：{name}（{card.get('id')}）===")
    print("标签：" + ("、".join(tags[:12]) if tags else "无"))
    print(f"字段长度：description {len(desc)} · personality {len(personality)} · scenario {len(scenario)} · first_mes {len(first_mes)} · examples {len(mes_example)}")
    print("\n摘要：")
    print("  - 身份/描述：" + (_short(desc) or "缺失"))
    print("  - 性格/声音：" + (_short(personality) or "缺失"))
    print("  - 开场：" + (_short(first_mes) or "缺失"))
    if entries:
        print("  - 内置设定：" + "；".join(_short(_entry_content(e) or e.get('name') or e.get('comment'), 80) for e in entries[:3]))

    if findings:
        print("\n发现：")
        for sev, msg in findings:
            print(f"- [{sev}] {msg}")
    else:
        print("\n未发现明显结构问题。")

    print("\n使用建议：")
    high = [x for x in findings if x[0] == "高"]
    if high:
        print("- 不建议直接作为核心角色开场；先补齐描述和开场白。")
    elif any(x[0] == "中" for x in findings):
        print("- 可以使用，但建议先清理用户身份、过长字段或世界设定混入。")
    else:
        print("- 可以直接加入世界；多角色场景中再用 worldbook 承接公共设定。")
    print("- 若要修卡：角色本人写进卡；地点、势力、规则、历史写进世界设定；用户身份写进「我的角色」。")



def cmd_setup_world(a):
    """Legacy read-only planner kept for command compatibility."""
    idea = a.idea.strip()
    if not idea:
        _die("想法不能为空。")
    terms = _topic_terms(idea)
    name = a.name or (" · ".join(terms[:2]) if terms else idea[:18])
    lore_items = list(a.lore or []) or [idea]
    card_refs = list(a.card or [])
    print(f"=== 建世界方案：{name} ===")
    print(f"想法：{idea}")
    print("\n建议结构：")
    print("- 世界：承载公共设定、角色、故事历史。")
    print("- 我的角色：用户身份写在右栏 persona，不写成 {{user}} 世界书。")
    print("- 登场角色：先放 1-3 个核心角色，避免开场就群聊化。")
    print("- 世界设定：地点、势力、规则、秘密逐条 add-lore。")
    if card_refs:
        print("\n计划加入角色：" + "、".join(card_refs))
    else:
        print("\n计划加入角色：暂无；先用 recommend/card-audit 选核心角色。")
    print("\n计划写入设定：")
    for x in lore_items:
        print("- " + x)
    if a.apply:
        _die("setup-world 已改为只读兼容命令。请生成完整清单后使用 build-world --apply --confirm。")
    print("\n未创建数据。下一步：把角色、设定、我的角色和开场整理成一份清单，再运行 build-world 预览。")


def cmd_card_fix(a):
    """Read-only repair plan for a character card."""
    card = _resolve_card(a.card)
    name = _card_name(card)
    desc = _card_field(card, "description", "desc")
    personality = _card_field(card, "personality")
    scenario = _card_field(card, "scenario")
    first_mes = _card_field(card, "first_mes", "first_message")
    blob = json.dumps(card, ensure_ascii=False)
    print(f"=== 角色卡修复方案：{name}（{card.get('id')}）===")
    fixes = []
    if not desc or len(desc) < 80:
        fixes.append(("高", "补 description：写清身份、外貌/能力边界、目标、关系网，避免只写世界观。"))
    if not personality or len(personality) < 40:
        fixes.append(("中", "补 personality：写说话风格、情绪反应、行动倾向、亲密/冲突边界。"))
    if not first_mes or len(first_mes) < 30:
        fixes.append(("高", "补 first_mes：给一个可直接回应的开场，含场景、动作、对白和可选择事件。"))
    if "{{user}}" in blob:
        fixes.append(("中", "清理 {{user}}：用户身份迁移到右栏「我的角色」；角色卡只保留对用户的关系称呼/态度。"))
    entries = _card_book_entries(card)
    if entries:
        fixes.append(("低", f"检查内置 worldbook {len(entries)} 条：公共势力/历史/规则迁到世界设定，角色私有记忆可保留。"))
    world_words = ["世界观", "王国", "帝国", "组织", "势力", "历史", "规则", "魔法体系", "教团", "商会"]
    if sum(1 for w in world_words if w in desc + scenario) >= 4:
        fixes.append(("中", "拆分世界设定：角色卡保留本人视角，公共地点/组织/历史转成 add-lore/worldbook。"))
    if not fixes:
        print("未发现必须修复的问题；可直接使用。")
    else:
        for sev, msg in fixes:
            print(f"- [{sev}] {msg}")
    print("\n建议修复稿结构：")
    print("- description：身份 + 目标 + 关系 + 能力边界")
    print("- personality：说话风格 + 反应模式 + 禁忌/弱点")
    print("- scenario：当前可玩场景，不写百科")
    print("- first_mes：一段动作/环境 + 一句对白 + 一个可回应钩子")
    print("\n当前只生成方案，不重写卡文件。")
def _world_context(q):
    p = _resolve_production(q)
    cards_by_id = {c.get("id"): c for c in _get_cards()}
    wbs_by_id = {w.get("id"): w for w in _get_worldbooks()}
    cards = [cards_by_id.get(cid) for cid in _production_card_ids(p)]
    cards = [c for c in cards if c]
    wbs = [wbs_by_id.get(wid) for wid in p.get("worldbook_ids", [])]
    wbs = [w for w in wbs if w]
    return p, cards, wbs


def _entry_keys(e):
    vals = e.get("keys") or e.get("key") or []
    if isinstance(vals, str):
        vals = [vals]
    return [str(x).strip() for x in vals if str(x).strip()]


def _entry_content(e):
    return str(e.get("content") or e.get("comment") or "").strip()


def _has_user_token(obj):
    return "{{user}}" in json.dumps(obj, ensure_ascii=False)


def _is_broad_key(key):
    k = str(key or "").strip()
    if not k:
        return False
    if len(k) <= 1:
        return True
    broad = {"我", "你", "他", "她", "它", "人", "事", "教团", "学校", "商会", "王国", "城市", "任务", "秘密", "学园"}
    return k in broad


def _latest_char_messages(story, limit=8):
    out = []
    for m in reversed(story or []):
        if m.get("role") == "char":
            out.append(m)
            if len(out) >= limit:
                break
    return list(reversed(out))


def cmd_diagnose(a):
    """Read-only health check for a world: cast/lore/persona/story/model surface."""
    p, cards, wbs = _world_context(a.world)
    story = p.get("story") or []
    persona = p.get("persona") or {}
    if not a.json:
        print(f"=== 诊断：{p.get('name')}（{p.get('id')}）===")
        print(f"记录：{len(story)} 条 · 用户轮次 {sum(1 for m in story if m.get('role') == 'user')} · 角色 {len(cards)} 位 · 世界书 {len(wbs)} 组")
        print(f"我的角色：{persona.get('name') or '未设置'}" + ("（有描述）" if persona.get("description") else "（无描述）"))

    findings = []
    if not cards:
        findings.append(("高", "当前世界没有登场角色，生成会缺少角色声音。"))
    if len(cards) != len(set(c.get("id") for c in cards)):
        findings.append(("中", "登场角色存在重复 card_id。"))
    empty_chars = [m.get("id") for m in story if m.get("role") == "char" and not (m.get("text") or "").strip()]
    if empty_chars:
        findings.append(("高", f"存在空角色回复 {len(empty_chars)} 条，会污染后续上下文：{', '.join(empty_chars[:5])}"))
    if _has_user_token(p) or any(_has_user_token(c) for c in cards) or any(_has_user_token(w) for w in wbs):
        findings.append(("中", "仍有 {{user}} 残留，可能导致用户身份混乱。"))
    if not persona.get("description"):
        findings.append(("中", "我的角色描述为空，多角色世界里用户身份可能不稳定。"))
    if not wbs:
        findings.append(("中", "当前世界没有世界书，长期世界观只能依赖角色卡和历史。"))

    lore_entries = []
    for wb in wbs:
        for e in wb.get("entries", []) or []:
            lore_entries.append((wb, e))
    broad = []
    dup = {}
    for wb, e in lore_entries:
        for k in _entry_keys(e):
            if _is_broad_key(k):
                broad.append((k, e.get("name") or e.get("uid") or wb.get("name")))
            dup.setdefault(k, 0)
            dup[k] += 1
    repeated = [k for k, n in dup.items() if k and n > 1]
    if broad:
        findings.append(("中", "世界书存在过宽触发词：" + "、".join(f"{k}({name})" for k, name in broad[:8])))
    if repeated:
        findings.append(("低", "世界书触发词重复：" + "、".join(repeated[:10])))

    malformed = [m for m in _latest_char_messages(story) if (m.get("text") or "") and "*" not in (m.get("text") or "")]
    if malformed:
        findings.append(("低", f"最近 {len(malformed)} 条角色回复没有旁白星号，可能削弱前端格式显示。"))

    if a.json:
        _json_result("world.diagnose", {
            "world": {"id": p.get("id"), "name": p.get("name")},
            "counts": {
                "messages": len(story),
                "user_turns": sum(1 for m in story if m.get("role") == "user"),
                "cast": len(cards),
                "worldbooks": len(wbs),
            },
            "persona": {
                "name": persona.get("name"),
                "has_description": bool(persona.get("description")),
            },
            "findings": [
                {"severity": severity, "message": message}
                for severity, message in findings
            ],
            "healthy": not any(severity == "高" for severity, _message in findings),
        })
        return

    if not findings:
        print("\n未发现明显结构问题。")
    else:
        print("\n发现：")
        for sev, msg in findings:
            print(f"- [{sev}] {msg}")

    print("\n建议下一步：")
    print("- 世界书问题：运行 `lore-audit <世界>` 查看条目级详情。")
    print("- 输出或剧情问题：先 `recall <世界> --last 12` 看最近上下文。")
    print("- 用户身份问题：在酒馆右栏完善「我的角色」。")


def cmd_lore_audit(a):
    """Read-only audit of worldbook entries and trigger hygiene."""
    p, cards, wbs = _world_context(a.world)
    if a.json:
        books = []
        for wb in wbs:
            entries = []
            for i, entry in enumerate(wb.get("entries", []) or [], 1):
                keys = _entry_keys(entry)
                content = _entry_content(entry)
                flags = []
                if entry.get("constant"):
                    flags.append("constant")
                if entry.get("selective"):
                    flags.append("selective")
                if entry.get("recursive"):
                    flags.append("recursive")
                if not entry.get("enabled", True):
                    flags.append("disabled")
                if any(_is_broad_key(key) for key in keys):
                    flags.append("broad_key")
                if _has_user_token(entry):
                    flags.append("user_token")
                if not content:
                    flags.append("empty_content")
                if len(content) > 1200:
                    flags.append("long_content")
                item = {
                    "index": i,
                    "id": entry.get("uid") or entry.get("id"),
                    "name": entry.get("name") or entry.get("uid") or entry.get("id") or f"entry-{i}",
                    "position": entry.get("position") or "after_char",
                    "keys": keys,
                    "flags": flags,
                    "content_length": len(content),
                }
                if a.verbose:
                    item["content_preview"] = content[:300]
                entries.append(item)
            books.append({
                "id": wb.get("id"),
                "name": wb.get("name", "未命名世界书"),
                "recursive": bool(wb.get("recursive")),
                "entries": entries,
            })
        _json_result("world.lore-audit", {
            "world": {"id": p.get("id"), "name": p.get("name")},
            "cast": [
                {"id": card.get("id"), "name": card.get("name", "角色")}
                for card in cards
            ],
            "worldbooks": books,
        })
        return
    print(f"=== 世界书审计：{p.get('name')}（{p.get('id')}）===")
    if not wbs:
        print("当前世界没有挂载世界书。")
        return
    print(f"登场角色：" + ("、".join(c.get("name", "角色") for c in cards) or "无"))
    for wb in wbs:
        entries = wb.get("entries", []) or []
        print(f"\n## {wb.get('name','未命名世界书')}（{wb.get('id')}） · {len(entries)} 条 · recursive={bool(wb.get('recursive'))}")
        for i, e in enumerate(entries, 1):
            keys = _entry_keys(e)
            flags = []
            if e.get("constant"):
                flags.append("常驻")
            if e.get("selective"):
                flags.append("二级触发")
            if e.get("recursive"):
                flags.append("递归")
            if not e.get("enabled", True):
                flags.append("禁用")
            broad = [k for k in keys if _is_broad_key(k)]
            if broad:
                flags.append("过宽:" + "、".join(broad[:4]))
            if _has_user_token(e):
                flags.append("含{{user}}")
            content = _entry_content(e)
            if not content:
                flags.append("空内容")
            if len(content) > 1200:
                flags.append("内容偏长")
            pos = e.get("position") or "after_char"
            name = e.get("name") or e.get("uid") or e.get("id") or f"entry-{i}"
            print(f"[{i}] {name} · pos={pos} · keys={keys or ['常驻/无触发词']}" + (" · " + " / ".join(flags) if flags else ""))
            if a.verbose:
                print("    " + content[:300].replace("\n", " / "))
    print("\n审计只读完成；需要修改时再明确执行 add-lore / 手动调整 worldbook。")



def _entry_name(e, fallback="entry"):
    return str(e.get("name") or e.get("uid") or e.get("id") or fallback)


def _suggest_narrow_keys(keys, content, cast_names):
    suggestions = []
    text = content or ""
    for k in keys:
        if k and not _is_broad_key(k) and k not in suggestions:
            suggestions.append(k)
    for name in cast_names:
        if name and name in text and name not in suggestions:
            suggestions.append(name)
    for term in re.findall(r"[《「“]([^》」”]{2,20})[》」”]", text):
        term = term.strip()
        if term and not _is_broad_key(term) and term not in suggestions:
            suggestions.append(term)
        if len(suggestions) >= 5:
            break
    suffixes = ("学院", "学园", "商会", "教团", "组织", "协会", "车站", "钟楼", "档案馆", "研究所")
    for segment in re.split(r"[，。；、,.;：:\s]+", text):
        segment = segment.strip()
        if 2 <= len(segment) <= 16 and segment.endswith(suffixes) and not _is_broad_key(segment):
            if segment not in suggestions:
                suggestions.append(segment)
        if len(suggestions) >= 5:
            break
    for token in re.findall(r"[A-Za-z][A-Za-z0-9_\-]{1,30}", text):
        if token not in suggestions:
            suggestions.append(token)
        if len(suggestions) >= 5:
            break
    return suggestions[:5] or [k for k in keys if not _is_broad_key(k)][:5]


def cmd_lore_fix(a):
    """Generate/apply a conservative repair plan for worldbook/lore structure."""
    if a.apply and not a.confirm:
        _die("--apply 会修改 worldbook 文件；请加 --confirm。")
    p, cards, wbs = _world_context(a.world)
    cast_names = [_card_name(c) for c in cards]
    actions = []
    print(f"=== 世界书修复方案：{p.get('name')}（{p.get('id')}）===")
    if not wbs:
        print("当前世界没有世界书。建议先用 add-lore 逐条添加地点、势力、规则、秘密。")
        return
    for wb in wbs:
        entries = wb.get("entries", []) or []
        if wb.get("recursive"):
            actions.append(("中", wb.get("name", "世界书"), "关闭世界书级 recursive，避免条目内容互相触发造成设定污染。"))
        key_count = {}
        for e in entries:
            for k in _entry_keys(e):
                key_count[k] = key_count.get(k, 0) + 1
        for i, e in enumerate(entries, 1):
            name = _entry_name(e, f"entry-{i}")
            keys = _entry_keys(e)
            content = _entry_content(e)
            broad = [k for k in keys if _is_broad_key(k)]
            repeated = [k for k in keys if key_count.get(k, 0) > 1]
            if not content:
                actions.append(("高", name, "删除或补写空内容条目；空条目只会制造无效触发。"))
                continue
            if _has_user_token(e):
                actions.append(("中", name, "把 {{user}} 相关身份改写为明确角色名，或迁移到右栏「我的角色」。"))
            if broad:
                repl = _suggest_narrow_keys(keys, content, cast_names)
                actions.append(("中", name, f"收窄过宽触发词 {broad}；建议改为 {repl}，并避免单独用泛词触发。"))
            if repeated:
                actions.append(("低", name, f"触发词重复 {sorted(set(repeated))}；保留最核心条目，其他条目加二级触发或改名。"))
            if e.get("constant") and len(content) > 500:
                actions.append(("中", name, "常驻内容偏长；拆成按关键词触发的条目，常驻只保留一句全局规则。"))
            if e.get("recursive"):
                actions.append(("中", name, "关闭条目 recursive，除非明确需要条目内容继续触发其他条目。"))
            if len(content) > 1200:
                actions.append(("低", name, "内容偏长；拆成地点/势力/规则/秘密等多条，降低单次注入噪音。"))
            if not keys and not e.get("constant"):
                actions.append(("高", name, "没有触发词且非常驻；补 keys 或改为 constant，否则基本不会进入上下文。"))
    if not actions:
        print("未发现需要修复的明显世界书结构问题。")
        return
    order = {"高": 0, "中": 1, "低": 2}
    actions.sort(key=lambda x: (order.get(x[0], 9), x[1]))
    print("\n修复动作：")
    for sev, name, msg in actions:
        print(f"- [{sev}] {name}：{msg}")
    print("\n推荐执行顺序：")
    print("1. 先处理 [高]：空内容、无触发词、无法进入上下文的问题。")
    print("2. 再处理 [中]：过宽词、{{user}}、常驻过长、recursive 污染。")
    print("3. 最后处理 [低]：重复词和长内容拆分。")
    if not a.apply:
        print("\n说明：本命令只读，不修改数据。确认具体修复后，可运行 lore-fix <世界> --apply --confirm 做保守机械修复。")
        return
    state_dir = TAVERN_STATE_DIR
    changed = 0
    for wb in wbs:
        path = os.path.join(state_dir, "worldbooks", wb.get("id", "") + ".json")
        if not os.path.exists(path):
            print(f"跳过：找不到文件 {path}")
            continue
        obj = json.load(open(path, encoding="utf-8"))
        if obj.get("recursive"):
            obj["recursive"] = False
            changed += 1
        entries = obj.get("entries", []) or []
        cast_names = [_card_name(c) for c in cards]
        for e in entries:
            keys = _entry_keys(e)
            broad = [k for k in keys if _is_broad_key(k)]
            if broad:
                repl = _suggest_narrow_keys(keys, _entry_content(e), cast_names)
                new_keys = [k for k in keys if not _is_broad_key(k)]
                for k in repl:
                    if k and k not in new_keys:
                        new_keys.append(k)
                if new_keys != keys:
                    e["keys"] = new_keys[:8]
                    changed += 1
            if e.get("recursive"):
                e["recursive"] = False
                changed += 1
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        print(f"✅ 已保守修复：{path}")
    print(f"完成：修改 {changed} 处。建议再运行 lore-audit <世界> 验证。")

def _resolve_production(q):
    prods = _get_productions()
    matches = [p for p in prods if p.get("id") == q or q in (p.get("name") or "")]
    if not matches:
        _die(f"没找到世界「{q}」——先 `list` 看有哪些。")
    return matches[0]


def _resolve_card(q):
    cards = _get_cards()
    matches = [c for c in cards if c.get("id") == q or q.lower() in (c.get("name") or "").lower()]
    if not matches:
        _die(f"角色库里没找到「{q}」——先 `search/add` 导入，或在酒馆里导入角色卡。")
    return matches[0]


def cmd_new_world(a):
    name = a.name or "未命名世界"
    p = _event({"type": "create_blank_production", "name": name})["production"]
    if a.json:
        _json_result("world.create-blank", {
            "world_id": p.get("id"),
            "world_name": p.get("name"),
        })
        return
    print(f"✅ 已开启世界「{p['name']}」（{p['id']}）")
    print("   下一步可以 `attach-card <世界> <角色>` 加入角色，或 `add-lore <世界> <设定>` 接住设定。")
    print("   Liveware 入口可用 `app-link` 读取。")


def _liveware_entry(app_key):
    try:
        with open(TAVERN_APPS_FILE, encoding="utf-8") as f:
            apps = json.load(f)
    except FileNotFoundError:
        _die("还没有 Liveware 注册信息，请先用 tavern-ops 完成 Tavern 注册。")
    except (OSError, json.JSONDecodeError) as e:
        _die(f"Liveware 注册信息不可读：{e}")

    entry = apps.get(app_key) if isinstance(apps, dict) else None
    if not isinstance(entry, dict):
        _die(f"Liveware 注册信息缺少 {app_key} 入口。")
    domain = str(entry.get("domain") or "").strip().strip("/")
    if not domain or not re.fullmatch(r"[A-Za-z0-9.-]+(?::[0-9]+)?", domain):
        _die(f"Liveware {app_key} 域名无效。")
    name = str(entry.get("liveware_name") or entry.get("name") or "").strip()
    return {
        "app": app_key,
        "name": name or ("Tavern" if app_key == "console" else "Story Profile"),
        "app_id": str(entry.get("app_id") or "").strip(),
        "url": f"https://{domain}/",
    }


def _maybe_liveware_entry(app_key):
    try:
        with open(TAVERN_APPS_FILE, encoding="utf-8") as f:
            apps = json.load(f)
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    entry = apps.get(app_key) if isinstance(apps, dict) else None
    if not isinstance(entry, dict):
        return None
    domain = str(entry.get("domain") or "").strip().strip("/")
    if not domain or not re.fullmatch(r"[A-Za-z0-9.-]+(?::[0-9]+)?", domain):
        return None
    name = str(entry.get("liveware_name") or entry.get("name") or "").strip()
    return {
        "app": app_key,
        "name": name or ("Tavern" if app_key == "console" else "Story Profile"),
        "app_id": str(entry.get("app_id") or "").strip(),
        "url": f"https://{domain}/",
    }


def cmd_app_link(a):
    entry = _liveware_entry(a.app)
    print(json.dumps(entry, ensure_ascii=False) if a.json else entry["url"])


def _manifest_file(path, base):
    candidate = path if os.path.isabs(path) else os.path.join(base, path)
    try:
        with open(candidate, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        _die(f"角色卡 JSON 不可读 {candidate}: {e}")


def _expand_world_manifest(raw, source_path):
    manifest = json.loads(json.dumps(raw, ensure_ascii=False))
    if not isinstance(manifest, dict):
        _die("世界清单必须是 JSON 对象。")
    base = os.getcwd() if source_path == "-" else os.path.dirname(os.path.abspath(source_path))
    characters = manifest.get("characters")
    if not isinstance(characters, list):
        _die("世界清单必须包含 characters 数组。")
    expanded = []
    for index, spec in enumerate(characters, 1):
        if not isinstance(spec, dict):
            _die(f"第 {index} 个角色必须是对象。")
        item = dict(spec)
        library_ref = str(item.pop("library", "") or "").strip()
        if library_ref and not item.get("card_id"):
            item["card_id"] = _resolve_card(library_ref)["id"]
        json_file = str(item.pop("json_file", "") or "").strip()
        if json_file:
            item["card"] = _manifest_file(json_file, base)
            item.setdefault("source", "agent")
        png_file = str(item.pop("png_file", "") or "").strip()
        if png_file:
            candidate = png_file if os.path.isabs(png_file) else os.path.join(base, png_file)
            try:
                with open(candidate, "rb") as f:
                    item["png_base64"] = base64.b64encode(f.read()).decode("ascii")
            except OSError as e:
                _die(f"角色卡 PNG 不可读 {candidate}: {e}")
            item.setdefault("source", "upload")
        full_path = str(item.pop("full_path", "") or "").strip()
        if full_path:
            url = CHUB_CARD.format(full_path=urllib.parse.quote(_parse_full_path(full_path)))
            try:
                png = _chub_get(url, timeout=60, image=True)
            except (ChubUnreachable, urllib.error.HTTPError) as e:
                _die(f"外部角色卡下载失败：{e}")
            item["png_base64"] = base64.b64encode(png).decode("ascii")
            item["source"] = "chub"
        expanded.append(item)
    manifest["characters"] = expanded
    return manifest


def _world_manifest_summary(manifest):
    world = manifest.get("world") if isinstance(manifest.get("world"), dict) else {}
    characters = manifest.get("characters") if isinstance(manifest.get("characters"), list) else []
    lore = manifest.get("worldbook_entries")
    if lore is None:
        lore = manifest.get("lore")
    lore = lore if isinstance(lore, list) else []
    names = []
    for spec in characters:
        if not isinstance(spec, dict):
            continue
        card = spec.get("card") if isinstance(spec.get("card"), dict) else {}
        names.append(
            str(card.get("name") or spec.get("library") or spec.get("card_id")
                or spec.get("full_path") or spec.get("json_file") or "未命名角色")
        )
    persona = manifest.get("persona") if isinstance(manifest.get("persona"), dict) else {}
    persona_profile = persona.get("profile") if isinstance(persona.get("profile"), dict) else {}
    identity = persona_profile.get("identity") if isinstance(persona_profile.get("identity"), dict) else {}
    return {
        "name": str(world.get("name") or "").strip(),
        "characters": names,
        "lore_count": len(lore),
        "persona": str(identity.get("name") or persona.get("name") or "").strip(),
        "opening": str(world.get("opening") or manifest.get("opening") or "").strip(),
    }


def cmd_build_world(a):
    manifest = _read_json_arg(a.manifest)
    summary = _world_manifest_summary(manifest)
    if not summary["name"]:
        _die("manifest.world.name 不能为空。")
    if not a.apply:
        print(f"=== 完整世界方案：{summary['name']} ===")
        print("登场角色：" + ("、".join(summary["characters"]) or "未设置"))
        print(f"世界设定：{summary['lore_count']} 条")
        print("我的角色：" + (summary["persona"] or "未设置"))
        print("开场：" + ((summary["opening"][:120] + "…") if len(summary["opening"]) > 120
                         else (summary["opening"] or "使用首张角色卡开场")))
        print("\n未写入数据。确认后使用同一清单加 --apply --confirm。")
        return
    if not a.confirm:
        _die("--apply 会创建完整世界；请同时加 --confirm。")
    manifest = _expand_world_manifest(manifest, a.manifest)
    if a.request_id:
        manifest["request_id"] = a.request_id
    result = _event({"type": "build_world", "manifest": manifest})
    production = result.get("production") or {}
    payload = {
        "world_id": production.get("id"),
        "name": production.get("name"),
        "request_id": result.get("request_id"),
        "reused": bool(result.get("reused")),
        "verification": result.get("verification") or {},
    }
    liveware = _maybe_liveware_entry("console")
    if liveware:
        payload["liveware"] = liveware
    if a.json:
        print(json.dumps(payload, ensure_ascii=False))
        return
    print(f"\n✅ 世界已就绪：{payload['name']}（{payload['world_id']}）")
    print("验证：" + ("通过" if payload["verification"].get("ok") else "失败"))
    if payload.get("liveware"):
        print(payload["liveware"]["url"])


def cmd_verify_world(a):
    raw = json.loads(_http(CONSOLE + "/api/productions", timeout=15))
    productions = raw.get("productions") or []
    matches = [
        production for production in productions
        if production.get("id") == a.world or a.world in (production.get("name") or "")
    ]
    if len(matches) != 1:
        _die("世界不存在或名称不唯一。")
    production = matches[0]
    card_ids = _production_card_ids(production)
    lore_count = sum(
        len((worldbook or {}).get("entries") or [])
        for worldbook in production.get("worldbooks") or []
    )
    persona = production.get("persona") or {}
    profile = persona.get("profile") if isinstance(persona.get("profile"), dict) else {}
    result = {
        "world_id": production.get("id"),
        "name": production.get("name"),
        "active": raw.get("active") == production.get("id"),
        "cast_count": len(card_ids),
        "lore_count": lore_count,
        "persona": bool(profile or persona.get("name") or persona.get("description")),
        "opening": bool(
            (production.get("story") or [])
            and str((production.get("story") or [])[0].get("text") or "").strip()
        ),
    }
    result["ok"] = all((
        result["active"], result["cast_count"] > 0, result["lore_count"] > 0,
        result["persona"], result["opening"],
    ))
    if a.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"{result['name']}：{'验证通过' if result['ok'] else '验证失败'}")
        print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_attach_card(a):
    p = _resolve_production(a.world)
    c = _resolve_card(a.card)
    res = _event({"type": "attach_card", "production_id": p["id"], "card_id": c["id"]})
    p2 = res.get("production", p)
    count = len(p2.get("card_ids") or ([p2.get("card_id")] if p2.get("card_id") else []))
    if a.json:
        _json_result("world.attach-card", {
            "world_id": p2.get("id"),
            "world_name": p2.get("name"),
            "card_id": c.get("id"),
            "card_name": c.get("name"),
            "cast_count": count,
        })
        return
    print(f"✅ 已把「{c.get('name','?')}」加入世界「{p2.get('name','?')}」")
    print(f"   当前登场角色：{count} 位")


def cmd_add_lore(a):
    p = _resolve_production(a.world)
    text = a.text.strip()
    if not text:
        _die("设定不能为空。")
    res = _event({"type": "add_lore", "production_id": p["id"], "text": text})
    e = res.get("entry", {})
    keys = "、".join(e.get("keys") or []) or "常驻"
    if a.json:
        production = res.get("production", p)
        _json_result("world.add-lore", {
            "world_id": production.get("id"),
            "world_name": production.get("name"),
            "entry_id": e.get("uid") or e.get("id"),
            "entry_name": e.get("name"),
            "keys": e.get("keys") or [],
            "constant": bool(e.get("constant")),
        })
        return
    print(f"✅ 已把设定加入世界「{res.get('production', p).get('name','?')}」")
    print(f"   触发词：{keys}")


def cmd_list(a):
    prods = _get_productions()
    cards = {c.get("id"): c for c in _get_cards()}
    if a.json:
        worlds = []
        for production in prods:
            card_ids = production.get("card_ids") or (
                [production.get("card_id")] if production.get("card_id") else []
            )
            worlds.append({
                "id": production.get("id"),
                "name": production.get("name"),
                "message_count": len(production.get("story", [])),
                "cast": [
                    {"id": card_id, "name": cards.get(card_id, {}).get("name") or card_id}
                    for card_id in card_ids if card_id
                ],
                "worldbook_ids": production.get("worldbook_ids") or [],
                "active": bool(production.get("active")),
            })
        _json_result("world.list", {"count": len(worlds), "worlds": worlds})
        return
    if not prods:
        print("还没有世界。用 `new-world --name <名字>` 开空白世界，或 `add <fullPath>` 从角色卡开始。")
        return
    print(f"当前 {len(prods)} 个世界：")
    for p in prods:
        cids = p.get("card_ids") or ([p.get("card_id")] if p.get("card_id") else [])
        names = [cards.get(cid, {}).get("name") or cid for cid in cids if cid]
        cast = "，角色 " + "、".join(names[:3]) + ("等" if len(names) > 3 else "") if names else "，暂无角色"
        lore = f"，{len(p.get('worldbook_ids',[]))} 组设定" if p.get("worldbook_ids") else ""
        print(f"  · {p.get('name','?')}（{p.get('id')}，{len(p.get('story',[]))} 条记录{cast}{lore}）")


def _probe_endpoint(path):
    url = CONSOLE + path
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=8) as response:
            body = json.loads(response.read().decode("utf-8"))
        return {"ok": True, "status": response.status, "body": body}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def _read_skill_version(relative_path):
    path = os.path.join(TAVERN_SKILL_ROOT, relative_path, "SKILL.md")
    try:
        with open(path, encoding="utf-8") as handle:
            head = handle.read(1000)
    except OSError:
        return None
    match = re.search(r"^version:\s*['\"]?([^'\"\s]+)", head, re.MULTILINE)
    return match.group(1) if match else None


def cmd_doctor(a):
    """Read-only check for the local runtime, skill versions, and routing drift."""
    probes = {
        name: _probe_endpoint(path)
        for name, path in (
            ("health", "/api/health"),
            ("worlds", "/api/productions"),
            ("cards", "/api/cards"),
            ("models", "/api/models"),
        )
    }
    skill_versions = {
        name: _read_skill_version(path)
        for name, path in (
            ("tavern", "creative/tavern"),
            ("tavern-world", "creative/tavern-world"),
            ("tavern-continuity", "creative/tavern-continuity"),
            ("tavern-story-profile", "creative/tavern-story-profile"),
            ("tavern-ops", "creative/tavern-ops"),
            ("tavern-updater", "system/tavern-updater"),
        )
    }
    try:
        with open(TAVERN_AGENTS_FILE, encoding="utf-8") as handle:
            agents_text = handle.read()
    except OSError as exc:
        agents_text = ""
        agents_error = str(exc)
    else:
        agents_error = None
    forbidden_claims = [
        phrase
        for phrase in ("safe current variables", "MVU variable state")
        if phrase in agents_text
    ]
    health = probes["health"].get("body") or {}
    result = {
        "console": CONSOLE,
        "runtime": {
            "reachable": probes["health"]["ok"],
            "model": health.get("model"),
            "model_key_set": bool(health.get("key_set")),
            "background_jobs": health.get("background_jobs") or {},
        },
        "endpoints": {
            name: {key: value for key, value in probe.items() if key != "body"}
            for name, probe in probes.items()
        },
        "skill_versions": skill_versions,
        "routing": {
            "agents_file_readable": agents_error is None,
            "agents_file_error": agents_error,
            "unsupported_capability_claims": forbidden_claims,
        },
    }
    ok = all(probe["ok"] for probe in probes.values()) and not forbidden_claims and agents_error is None
    payload = {"ok": ok, "operation": "doctor", "result": result}
    if a.json:
        _print_json(payload)
        return
    print("Tavern 自检：" + ("通过" if ok else "发现问题"))
    print(f"运行时：{'可用' if result['runtime']['reachable'] else '不可用'} · 模型 {result['runtime']['model'] or '未知'}")
    print("技能版本：" + " · ".join(f"{name}={version or '未知'}" for name, version in skill_versions.items()))
    if forbidden_claims:
        print("路由文档仍声明未支持能力：" + "、".join(forbidden_claims))
    if agents_error:
        print("AGENTS.md 不可读：" + agents_error)


def main():
    ap = argparse.ArgumentParser(prog="tavern_cli", description="主理人酒馆工具")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="搜 Chub 角色卡")
    s.add_argument("query")
    s.add_argument("--n", type=int, default=8)
    s.set_defaults(fn=cmd_search)

    s = sub.add_parser("inspect-card", help="识别并审查外部 V1/V2/V3 JSON/PNG/CHARX，不写入")
    s.add_argument("source", help="本地文件、HTTPS 直链、Chub 页面/fullPath，或 '-' 读 JSON")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_inspect_card)

    s = sub.add_parser("prepare-card", help="整理并预览外部 V1/V2/V3 卡，不写入")
    s.add_argument("source", help="本地文件、HTTPS 直链、Chub 页面/fullPath，或 '-' 读 JSON")
    s.add_argument("--output", help="把可确认的完整整理计划写入 JSON 文件")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_prepare_card)

    s = sub.add_parser("apply-card-plan", help="确认并原子应用 prepare-card 产生的整理计划")
    s.add_argument("plan", help="整理计划 JSON 文件路径，或 '-' 读 stdin")
    s.add_argument("--confirm", action="store_true", help="确认写入角色库")
    s.add_argument("--new-world", action="store_true", help="导入后以主角色单独开启世界")
    s.add_argument("--name", help="配合 --new-world 指定世界名")
    s.set_defaults(fn=cmd_apply_card_plan)

    s = sub.add_parser("import-card", help="整理外部 V1/V2/V3 卡；默认预览，确认后写入")
    s.add_argument("source", help="本地文件、HTTPS 直链、Chub 页面/fullPath，或 '-' 读 JSON")
    s.add_argument("--confirm", action="store_true", help="确认预览结果并写入")
    s.add_argument("--new-world", action="store_true", help="导入后以此卡单独开启世界")
    s.add_argument("--name", help="配合 --new-world 指定世界名")
    s.set_defaults(fn=cmd_import_card)

    s = sub.add_parser("add", help="下载 Chub 真卡并导入角色库")
    s.add_argument("full_path", help="Chub fullPath（如 Anon/some-character）或直贴的 chub.ai 链接")
    s.add_argument("--confirm", action="store_true", help="确认整理预览并写入")
    s.add_argument("--new-world", action="store_true", help="导入后以此卡单独开启世界")
    s.add_argument("--name", help="配合 --new-world 指定世界名")
    s.set_defaults(fn=cmd_add)

    s = sub.add_parser("starter", help="列出/导入内置 starter 真卡（离线兜底 + 写原创卡的样板）")
    s.add_argument("which", nargs="?", help="序号或名字片段；不给=看列表")
    s.add_argument("--new-world", action="store_true", help="导入后以此卡单独开启世界")
    s.add_argument("--name", help="配合 --new-world 指定世界名")
    s.set_defaults(fn=cmd_starter)

    s = sub.add_parser("add-original", help="导入原创角色卡 JSON 到角色库")
    s.add_argument("json", help="卡 JSON 文件路径，或 '-' 读 stdin")
    s.add_argument("--new-world", action="store_true", help="导入后以此卡单独开启世界")
    s.add_argument("--name", help="配合 --new-world 指定世界名")
    s.set_defaults(fn=cmd_add_original)

    s = sub.add_parser("add-worldbook", help="世界设定 JSON → 导入（可挂世界）")
    s.add_argument("json", help="世界设定 JSON 文件路径，或 '-' 读 stdin")
    s.add_argument("--production", help="挂到该世界 id")
    s.set_defaults(fn=cmd_add_worldbook)

    s = sub.add_parser("new-world", help="开启空白世界")
    s.add_argument("--name", help="世界名")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_new_world)

    s = sub.add_parser("build-world", help="从一份清单原子创建完整世界；默认只预览")
    s.add_argument("manifest", help="世界清单 JSON 文件路径，或 '-' 读 stdin")
    s.add_argument("--apply", action="store_true", help="实际创建完整世界")
    s.add_argument("--confirm", action="store_true", help="确认执行写入")
    s.add_argument("--request-id", help="幂等请求 ID；重试时复用同一个值")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_build_world)

    s = sub.add_parser("verify-world", help="验证世界的角色、设定、我的角色和开场是否完整")
    s.add_argument("world", help="世界 id 或唯一名字片段")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_verify_world)

    s = sub.add_parser("app-link", help="读取可生成 ClawChat Liveware 卡片的裸链接")
    s.add_argument("--app", choices=("console", "actor"), default="console")
    s.add_argument("--json", action="store_true", help="同时输出名称、app_id 和链接")
    s.set_defaults(fn=cmd_app_link)

    s = sub.add_parser("attach-card", help="把角色库里的角色加入一个世界")
    s.add_argument("world", help="世界 id 或名字片段")
    s.add_argument("card", help="角色卡 id 或名字片段")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_attach_card)

    s = sub.add_parser("add-lore", help="把自然语言设定整理进一个世界")
    s.add_argument("world", help="世界 id 或名字片段")
    s.add_argument("text", help="自然语言设定")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_add_lore)

    s = sub.add_parser("list", help="列出世界")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_list)

    s = sub.add_parser("card", help="读主理人的故事档案（生涯/亲密度/对用户的了解/成长）——自我觉察")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_card)

    s = sub.add_parser("profile-audit", help="把故事档案整理成推荐世界/角色时可用的偏好信号（只读）")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_profile_audit)

    s = sub.add_parser("recommend", help="结合故事档案、当前世界和角色库给一个可落地推荐（只读）")
    s.add_argument("want", nargs="?", default="", help="用户想玩的方向；可为空，按故事档案推荐")
    s.add_argument("--external", action="store_true", help="同时搜索外部 Chub 候选；不可用时提示 starter")
    s.add_argument("--n", type=int, default=5, help="外部候选数量")
    s.set_defaults(fn=cmd_recommend)

    s = sub.add_parser("plan-world", help="从一句想法拆出世界、角色、设定、开场与落地命令（只规划，不创建）")
    s.add_argument("idea", help="用户想玩的方向/题材/关系/一句话想法")
    s.add_argument("--name", help="指定世界名建议")
    s.add_argument("--style", help="指定叙事手感；不填则结合想法和档案推断")
    s.add_argument("--no-profile", action="store_true", help="不读取故事档案，只按输入想法规划")
    s.set_defaults(fn=cmd_plan_world)

    s = sub.add_parser("setup-world", help="旧版兼容：只读生成建世界方案，不再写入")
    s.add_argument("idea", help="用户想玩的方向/题材/关系/一句话想法")
    s.add_argument("--name", help="世界名")
    s.add_argument("--card", action="append", help="要加入的本地角色卡 id 或名字片段，可重复")
    s.add_argument("--lore", action="append", help="要写入的自然语言设定，可重复；不填则写入 idea")
    s.add_argument("--apply", action="store_true", help="已停用；完整创建请使用 build-world")
    s.add_argument("--confirm", action="store_true", help="旧版兼容参数")
    s.set_defaults(fn=cmd_setup_world)

    s = sub.add_parser("card-audit", help="审计角色卡身份、开场、世界书混入和可玩性（只读）")
    s.add_argument("card", help="角色卡 id 或名字片段")
    s.set_defaults(fn=cmd_card_audit)

    s = sub.add_parser("card-fix", help="根据角色卡审计生成修复方案（只读 --plan）")
    s.add_argument("card", help="角色卡 id 或名字片段")
    s.add_argument("--plan", action="store_true", default=True)
    s.set_defaults(fn=cmd_card_fix)

    s = sub.add_parser("recall", help="读某世界在酒馆里走过什么（主理人读酒馆对话的唯一入口）")
    s.add_argument("production", help="世界 id 或名字片段")
    s.add_argument("--last", type=int, default=40, help="只看最后 N 条（默认 40）")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_recall)

    s = sub.add_parser("learn", help="把用户明确表达的长期故事偏好记进结构化故事档案")
    s.add_argument("change", help="学到/调整了什么，如「用户爱慢热的戏、回复别太长」")
    s.add_argument("--reason", help="人话理由")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_learn)

    s = sub.add_parser("reflect", help="复盘某世界的故事 → 模型提炼可复用偏好 → 写进结构化故事档案")
    s.add_argument("production", help="世界 id 或名字片段")
    s.set_defaults(fn=cmd_reflect)

    s = sub.add_parser("reflect-preview", help="预览某世界复盘会学到什么，不写入故事档案")
    s.add_argument("production", help="世界 id 或名字片段")
    s.set_defaults(fn=cmd_reflect_preview)

    s = sub.add_parser("note", help="设/清世界的导演提示(作者注释:场景方向,贴近生成点注入)")
    s.add_argument("production", help="世界 id 或名字片段")
    s.add_argument("note", help="导演提示,如当前场景焦点、关系张力或推进意图；空串清除")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_note)

    s = sub.add_parser("diagnose", help="诊断一个世界的角色/世界书/persona/剧情结构问题（只读）")
    s.add_argument("world", help="世界 id 或名字片段")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_diagnose)

    s = sub.add_parser("lore-audit", help="审计世界书触发词、常驻、递归和污染风险（只读）")
    s.add_argument("world", help="世界 id 或名字片段")
    s.add_argument("--verbose", action="store_true", help="显示每条设定内容前 300 字")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_lore_audit)

    s = sub.add_parser("lore-fix", help="根据世界书审计生成修复方案；--apply --confirm 做保守机械修复")
    s.add_argument("world", help="世界 id 或名字片段")
    s.add_argument("--plan", action="store_true", default=True, help="只生成修复方案，不修改数据")
    s.add_argument("--apply", action="store_true", help="执行保守机械修复：收窄宽触发词、关闭 recursive")
    s.add_argument("--confirm", action="store_true", help="确认写入 worldbook 文件")
    s.set_defaults(fn=cmd_lore_fix)

    s = sub.add_parser("model", help="大模型配置:帮用户配/切/删自定义 API(add 先实测再落盘)")
    ms = s.add_subparsers(dest="mcmd", required=True)
    m = ms.add_parser("list", help="列全部配置(✓=当前在用)")
    m.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    m.set_defaults(fn=cmd_model_list)
    m = ms.add_parser("add", help="加一份配置:实测通过才落盘,并自动切换过去(同名=更新)")
    m.add_argument("name", help="给配置起个名(如 DeepSeek / Kimi / 本地Ollama)")
    m.add_argument("--base", required=True, help="OpenAI-compatible base_url(到 /v1 为止)")
    m.add_argument("--model", required=True, help="model id(如 deepseek-chat / kimi-k2)")
    m.add_argument("--key", required=True, help="API key(只落酒馆 state 文件,不外传)")
    m.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    m.set_defaults(fn=cmd_model_add)
    m = ms.add_parser("use", help="切换在用配置(名字或 id;「内置模型」= 切回默认)")
    m.add_argument("which", help="配置名 / id / 内置模型")
    m.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    m.set_defaults(fn=cmd_model_use)
    m = ms.add_parser("rm", help="删一份配置(删的是在用的会自动回落内置模型)")
    m.add_argument("which", help="配置名 / id")
    m.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    m.set_defaults(fn=cmd_model_rm)
    m = ms.add_parser("test", help="实测某配置通不通(不给参数=测内置模型)")
    m.add_argument("which", nargs="?", help="配置名 / id;缺省=内置模型")
    m.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    m.set_defaults(fn=cmd_model_test)

    s = sub.add_parser("doctor", help="只读检查运行时、技能版本和路由能力声明")
    s.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    s.set_defaults(fn=cmd_doctor)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
