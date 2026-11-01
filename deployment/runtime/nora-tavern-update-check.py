from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import ssl
import urllib.error
import urllib.parse
import urllib.request

REPO = 'LoveMaker-art/noras-tavern'
TAG_PATTERN = r'v\d+\.\d+\.\d+(?:-beta\.\d+)?'
ASSET_PATTERN = r'[A-Za-z0-9][A-Za-z0-9._-]*'
# BEGIN BUILD-OWNED RELEASE SOURCES
RELEASE_SOURCES = json.loads('{"schema":1,"primary":"jihulab","mirrors":[{"id":"jihulab","provider":"jihulab","baseUrl":"https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/","channelBaseUrl":"https://jihulab.com/LoveMaker-art/nora-tavern/-/raw/main/"},{"id":"sourceforge","provider":"sourceforge","baseUrl":"https://downloads.sourceforge.net/project/nora-tavern/"}]}')
# END BUILD-OWNED RELEASE SOURCES


def validate_sources(value):
    """Only the build-owned contract may name a download root."""
    invalid = RuntimeError('资源来源配置无效，未下载或修改安装。')
    if (not isinstance(value, dict) or type(value.get('schema')) is not int or value['schema'] != 1
            or set(value) - {'schema', 'primary', 'mirrors'}
            or not isinstance(value.get('mirrors'), list) or len(value['mirrors']) > 2):
        raise invalid
    ids, origins, mirrors = {'github'}, {'https://github.com', 'https://api.github.com'}, []
    for item in value['mirrors']:
        if (not isinstance(item, dict) or not isinstance(item.get('id'), str)
                or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', item['id']) or item['id'] in ids
                or not isinstance(item.get('baseUrl'), str)
                or set(item) - {'id', 'baseUrl', 'provider', 'channelBaseUrl'}
                or item.get('provider') not in (None, 'sourceforge', 'jihulab')
                or item.get('provider') != 'jihulab' and item.get('channelBaseUrl') is not None):
            raise invalid
        def root_url(raw):
            try:
                parsed = urllib.parse.urlsplit(raw)
                if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                        or parsed.query or parsed.fragment or parsed.port not in (None, 443)
                        or not parsed.path.endswith('/') or '\\' in raw
                        or re.search(r'[\x00-\x20\x7f]', raw)):
                    raise invalid
                return parsed
            except (ValueError, TypeError):
                raise invalid
        root = root_url(item['baseUrl'])
        origin = 'https://' + root.hostname
        if origin in origins:
            raise invalid
        if item.get('provider') == 'sourceforge' and (origin != 'https://downloads.sourceforge.net'
                or not re.fullmatch(r'/project/[a-z0-9][a-z0-9-]{2,29}/', root.path)):
            raise invalid
        if item.get('provider') == 'jihulab':
            identity = re.fullmatch(r'/api/v4/projects/([1-9][0-9]*)/packages/generic/([A-Za-z0-9][A-Za-z0-9._-]{0,254})/', root.path)
            if (origin != 'https://jihulab.com' or item['baseUrl'] != 'https://jihulab.com'+root.path
                    or not identity or int(identity[1]) > 9007199254740991):
                raise invalid
            if not isinstance(item.get('channelBaseUrl'), str):
                raise invalid
            channel = root_url(item['channelBaseUrl'])
            raw = re.fullmatch(r'/((?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}/){2,})-/raw/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/', channel.path)
            if (channel.hostname != 'jihulab.com' or item['channelBaseUrl'] != 'https://jihulab.com'+channel.path
                    or not raw or '..' in raw[2]
                    or re.search(r'(?:\.|\.lock)$', raw[2])):
                raise invalid
        ids.add(item['id'])
        origins.add(origin)
        mirrors.append(item)
    if value.get('primary') is not None and (not isinstance(value['primary'], str) or value['primary'] not in ids):
        raise invalid
    return mirrors


def source_candidates(url, *, channel='stable', sources=None):
    configuration = RELEASE_SOURCES if sources is None else sources
    mirrors = validate_sources(configuration)
    value = urllib.parse.urlsplit(url)
    relative = None
    api = f'/repos/{REPO}/releases'
    if value.scheme == 'https' and value.hostname == 'api.github.com' and not value.fragment:
        if value.path == api+'/latest' and not value.query and channel == 'stable':
            relative = 'channels/stable.json'
        elif value.path == api and value.query in ('per_page=10&page=1', 'per_page=100&page=1') and channel == 'beta':
            relative = 'channels/beta.json'
        elif value.path.startswith(api+'/tags/') and not value.query:
            tag = value.path[len(api+'/tags/'):]
            if re.fullmatch(TAG_PATTERN, tag):
                relative = f'releases/{tag}/release.json'
    elif value.scheme == 'https' and value.hostname == 'github.com' and not value.query and not value.fragment:
        prefix = f'/{REPO}/releases/download/'
        candidate = value.path[len(prefix):] if value.path.startswith(prefix) else ''
        if re.fullmatch(TAG_PATTERN+'/'+ASSET_PATTERN, candidate):
            relative = 'releases/'+candidate
    candidates = []
    if relative:
        for item in mirrors:
            path = relative.removeprefix('releases/') if item.get('provider') in ('sourceforge', 'jihulab') else relative
            root = item['channelBaseUrl'] if item.get('provider') == 'jihulab' and relative.startswith('channels/') else item['baseUrl']
            candidates.append((item['id'], root+path))
    candidates.append(('github', url))
    primary = configuration.get('primary')
    return [candidate for _, candidate in sorted(candidates, key=lambda item: (item[0] != primary, item[0] != 'github'))] if primary else [candidate for _, candidate in candidates]


def sourceforge_url(url):
    value = urllib.parse.urlsplit(url)
    return (value.hostname == 'downloads.sourceforge.net'
            or bool(re.fullmatch(r'[a-z0-9-]+\.dl\.sourceforge\.net', value.hostname or '')))


def validate_source(url, original):
    value, initial = urllib.parse.urlsplit(url), urllib.parse.urlsplit(original)
    github_assets = {'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'}
    trusted = False
    api = f'/repos/{REPO}/releases'
    if initial.hostname == 'api.github.com' and (initial.path in (api, api+'/latest')
            or initial.path.startswith(api+'/tags/') and re.fullmatch(TAG_PATTERN, initial.path[len(api+'/tags/'):])):
        trusted = value.hostname == initial.hostname and value.path == initial.path and value.query == initial.query
    elif initial.hostname in github_assets:
        prefix = f'/{REPO}/releases/download/'
        valid_initial = initial.hostname != 'github.com' or (initial.path.startswith(prefix)
            and re.fullmatch(TAG_PATTERN+'/'+ASSET_PATTERN, initial.path[len(prefix):]) and not initial.query)
        trusted = valid_initial and value.hostname in github_assets and (value.hostname != 'github.com' or value.path == initial.path)
    else:
        for item in validate_sources(RELEASE_SOURCES):
            roots = [item['baseUrl']] + ([item['channelBaseUrl']] if item.get('provider') == 'jihulab' else [])
            for root in roots:
                parsed = urllib.parse.urlsplit(root)
                match = initial.hostname == parsed.hostname or item.get('provider') == 'sourceforge' and sourceforge_url(original)
                if match and initial.path.startswith(parsed.path):
                    permitted = (sourceforge_url(url) and value.port is None) if item.get('provider') == 'sourceforge' else value.hostname == parsed.hostname
                    trusted = permitted and value.path == initial.path
                    if item.get('provider') != 'sourceforge':
                        trusted = trusted and value.query == initial.query and not initial.query
    if (not trusted or initial.scheme != 'https' or initial.username or initial.password or initial.fragment
            or value.scheme != 'https' or value.username or value.password or value.fragment
            or initial.port not in (None, 443) or value.port not in (None, 443)):
        raise RuntimeError('资源响应偏离受信任来源，未使用下载内容。')

HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path(__file__).resolve().parents[1])).expanduser().resolve()
INSTANCE = HERMES_HOME / "nora-instance.json"


def installed_data_root():
    config_path = HERMES_HOME / "config.yaml"
    bound = INSTANCE.is_file()
    if config_path.is_file() and not bound:
        import yaml
        config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        bound = "nora" in config.get("mcp_servers", {})
    if bound:
        spec = importlib.util.spec_from_file_location("update_check_instance", Path(__file__).with_name("nora-instance.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        root = Path(module.configuration(HERMES_HOME)["installRoot"]).resolve()
        if not INSTANCE.is_file() and os.environ.get("TAVERN_DATA_ROOT") and Path(os.environ["TAVERN_DATA_ROOT"]).expanduser().resolve() != root:
            raise RuntimeError("安装目录与 MCP 绑定冲突，已停止版本检查")
        return root
    return Path(os.environ.get("TAVERN_DATA_ROOT") or HERMES_HOME).expanduser().resolve()


DATA_ROOT = installed_data_root()
CHANNEL = json.loads(INSTANCE.read_text(encoding="utf-8")).get("releaseChannel", "stable") if INSTANCE.is_file() else "stable"
API_URL = (f"https://api.github.com/repos/{REPO}/releases?per_page=10&page=1" if CHANNEL == 'beta'
    else f"https://api.github.com/repos/{REPO}/releases/latest")
SOURCEFORGE_ROOT = "https://downloads.sourceforge.net/project/nora-tavern/"
LOCAL_RELEASE_URL = os.environ.get("TAVERN_RELEASE_API_URL")
if LOCAL_RELEASE_URL:
    local = urllib.parse.urlsplit(LOCAL_RELEASE_URL)
    if (local.scheme != 'file' or local.netloc or not local.path.startswith('/')
            or local.query or local.fragment):
        raise RuntimeError('版本检查覆盖仅允许显式本地 file:// 文件；在线来源由构建配置封存。')
    API_URL = LOCAL_RELEASE_URL
RELEASE_URLS = (API_URL,) if LOCAL_RELEASE_URL else tuple(source_candidates(API_URL, channel=CHANNEL))
MARKER = DATA_ROOT / "apps/tavern-runtime/.tavern-release-version"
INSTALL_RECORD = DATA_ROOT / "tavern-updates/installed.json"
NOTICE_STATE = DATA_ROOT / "tavern-updates/notification-state.json"
LOG_FILE = HERMES_HOME / "logs/nora-tavern-update-check.log"
SENDER = Path(os.environ.get("TAVERN_UPDATE_SENDER", HERMES_HOME / "scripts/nora-tavern-card-send.py"))
SUMMARY_MAX_CHARS = 1200
SUMMARY_MAX_LINES = 10


def normalize_version(value: object) -> str:
    text = str(value or "").strip()
    return text[1:] if text.startswith("v") else text


def version_key(value: str):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?", value)
    if not match:
        raise RuntimeError(f"无法识别版本号：{value!r}")
    base = tuple(int(match.group(index)) for index in range(1, 4))
    prerelease = match.group(4)
    if prerelease is None:
        return base, 1, ()
    tokens = tuple(
        (0, int(token)) if token.isdigit() else (1, token.lower())
        for token in prerelease.split(".")
    )
    return base, 0, tokens


def installed_version() -> str:
    if MARKER.is_file():
        value = normalize_version(MARKER.read_text(encoding="utf-8"))
        version_key(value)
        return value
    if INSTALL_RECORD.is_file():
        value = normalize_version(json.loads(INSTALL_RECORD.read_text(encoding="utf-8")).get("version"))
        version_key(value)
        return value
    raise RuntimeError("未找到 Tavern 安装版本标记")


def release_summary(value: object) -> str:
    lines: list[str] = []
    in_code_block = False
    for raw_line in str(value or "").splitlines():
        line = raw_line.strip()
        if line.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block or not line or line.startswith("<!--"):
            continue
        heading = re.sub(r"^#{1,6}\s+", "", line).strip()
        if re.fullmatch(r"(?:更新命令|安装命令|update command|install command)[:：]?", heading, re.IGNORECASE):
            break
        if heading != line:
            continue
        if re.match(r"^(?:curl|wget)\s", line, re.IGNORECASE):
            continue
        plain = line.lstrip("> ").strip().casefold()
        if plain in {"用户数据尚未发生变化", "your data has not changed"}:
            continue
        lines.append(line)
        if len(lines) >= SUMMARY_MAX_LINES:
            break

    summary = "\n".join(lines)
    if len(summary) <= SUMMARY_MAX_CHARS:
        return summary
    return summary[: SUMMARY_MAX_CHARS - 1].rstrip() + "…"


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, source: str):
        self.source = source

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        validate_source(newurl, self.source)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def query_bytes(source: str, timeout: float, *, limit=1024 * 1024):
    local = bool(LOCAL_RELEASE_URL and source == LOCAL_RELEASE_URL)
    if not local:
        validate_source(source, source)
    request = urllib.request.Request(source, headers={
        "Accept": "application/json", "User-Agent": "nora-tavern-update-check/3",
    })
    # The explicit file override remains available for offline development.
    opener = urllib.request.build_opener(ReleaseRedirect(source))
    with opener.open(request, timeout=timeout) as response:
        if not local:
            validate_source(response.geturl(), source)
        raw = response.read(limit + 1)
    if len(raw) > limit:
        raise RuntimeError("版本信息超过大小限制")
    return raw


def query_release(source: str, timeout: float):
    value = urllib.parse.urlsplit(source)
    catalogue = CHANNEL == 'beta' and (source in RELEASE_URLS
        or value.hostname == 'api.github.com' and value.path == f'/repos/{REPO}/releases'
        and re.fullmatch(r'per_page=10&page=(?:[1-9]|10)', value.query))
    # Ten complete release descriptors share Node's existing 4 MiB bound.
    # Individual manifests retain their 1 MiB bound.
    return json.loads(query_bytes(source, timeout, limit=4*1024*1024 if catalogue else 1024*1024))


def core_release_version(payload, deadline):
    tag = payload.get('tag_name')
    if not isinstance(tag, str) or not re.fullmatch(TAG_PATTERN, tag):
        raise RuntimeError('发布批次版本无效')
    # Pre-component releases had no component manifest. Keep that historical
    # protocol; a present modern catalogue may never fall back after failure.
    if 'assets' not in payload:
        return normalize_version(tag)
    assets = payload['assets']
    if not isinstance(assets, list):
        raise RuntimeError('发布资源目录无效')
    matches = [item for item in assets if isinstance(item, dict) and item.get('name') == 'release-manifest.json']
    if len(matches) != 1:
        raise RuntimeError('发布缺少唯一的核心清单')
    asset = matches[0]
    url = f'https://github.com/{REPO}/releases/download/{tag}/release-manifest.json'
    if (asset.get('browser_download_url') != url or asset.get('state') != 'uploaded'
            or type(asset.get('size')) is not int or not 0 < asset['size'] <= 4 * 1024 * 1024
            or not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest') or '')
            or 'asset_release_tag' in asset):
        raise RuntimeError('核心清单来源或校验信息无效')
    sources = source_candidates(url, channel=CHANNEL)
    raw = None
    for index, source in enumerate(sources):
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('核心版本检查超时')
            raw = query_bytes(source, min(15, remaining), limit=4 * 1024 * 1024)
            break
        except urllib.error.HTTPError as error:
            if index == len(sources) - 1 or error.code not in {403, 404, 408, 410, 429, 500, 502, 503, 504}:
                raise
        except (urllib.error.URLError, OSError) as error:
            if isinstance(getattr(error, 'reason', error), (ssl.SSLCertVerificationError, ssl.CertificateError)) or index == len(sources) - 1:
                raise
    if raw is None or len(raw) != asset['size'] or hashlib.sha256(raw).hexdigest() != asset['digest'][7:]:
        raise RuntimeError('核心清单原文与发布校验不一致')
    manifest = json.loads(raw)
    core = manifest.get('versions', {}).get('tavern')
    if (manifest.get('schema') != 'tavern-release/v2' or not isinstance(core, str)
            or not re.fullmatch(TAG_PATTERN, 'v' + core) or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('commit') or '')
            or manifest.get('candidate')):
        raise RuntimeError('核心清单身份无效')
    publication = manifest.get('publication')
    if 'publication' in manifest:
        if (not isinstance(publication, dict) or set(publication) != {'schema', 'tag'}
                or publication.get('schema') != 'nora-component-publication/1' or publication.get('tag') != tag):
            raise RuntimeError('核心清单与固定发布批次不一致')
    elif 'v' + core != tag:
        raise RuntimeError('旧核心清单版本与发布批次不一致')
    return core


def latest_release() -> tuple[str, str]:
    deadline = time.monotonic() + 30
    def read(urls):
        for index, source in enumerate(urls):
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("版本检查超时")
                return query_release(source, min(15, remaining)), source
            except urllib.error.HTTPError as error:
                if index == len(urls) - 1 or error.code not in {403, 404, 408, 410, 429, 500, 502, 503, 504}:
                    raise
            except (urllib.error.URLError, OSError) as error:
                reason = getattr(error, "reason", error)
                if isinstance(reason, (ssl.SSLCertVerificationError, ssl.CertificateError)) or index == len(urls) - 1:
                    raise
        raise RuntimeError("所有版本来源均不可用")
    payload, selected = read(RELEASE_URLS)
    if CHANNEL == 'beta':
        candidates = []
        for page in range(1, 11):  # Preserve the watcher's 100-release bound.
            if not isinstance(payload, list):
                raise RuntimeError('Beta 版本信息格式无效')
            canonical = f'https://api.github.com/repos/{REPO}/releases?per_page=10&page={page}'
            complete = bool(LOCAL_RELEASE_URL) or selected != canonical
            if len(payload) > 10 and not complete:
                raise RuntimeError('Beta 发布分页超出约定范围')
            candidates.extend(payload)
            if len(payload) < 10 or complete or page == 10:
                break
            payload, selected = read((f'https://api.github.com/repos/{REPO}/releases?per_page=10&page={page+1}',))
        releases = [item for item in candidates if isinstance(item, dict) and not item.get('draft')
                    and item.get('prerelease') and re.fullmatch(r'v?\d+\.\d+\.\d+-beta\.\d+', item.get('tag_name', ''))]
        if not releases:
            raise RuntimeError('尚未发布 Beta 测试版本')
        payload = max(releases, key=lambda item: version_key(normalize_version(item['tag_name'])))
    if not isinstance(payload, dict) or payload.get('draft') or bool(payload.get('prerelease')) != (CHANNEL == 'beta'):
        raise RuntimeError('版本信息与更新渠道不符')
    value = core_release_version(payload, deadline)
    version_key(value)
    return value, release_summary(payload.get("body"))


def load_notice_state() -> dict:
    try:
        value = json.loads(NOTICE_STATE.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def record_error(error: Exception) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    message = f"{dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} update check failed: {error}"
    with LOG_FILE.open("a", encoding="utf-8") as stream:
        stream.write(message + "\n")
    print(message, file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    installed = installed_version()
    latest, summary = latest_release()
    update_available = version_key(latest) > version_key(installed)
    result = {
        "installed": installed,
        "latest": latest,
        "updateAvailable": update_available,
    }
    if args.check_only:
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if not update_available:
        return 0

    previous = load_notice_state()
    if normalize_version(previous.get("last_notified_latest")) == latest:
        return 0
    if not SENDER.is_file():
        raise RuntimeError(f"更新提醒发送器不存在：{SENDER}")
    subprocess.run(
        [
            sys.executable,
            str(SENDER),
            "--installed",
            installed,
            "--latest",
            latest,
            "--summary",
            summary,
        ],
        check=True,
        timeout=30,
    )
    atomic_json(
        NOTICE_STATE,
        {
            "last_notified_latest": latest,
            "last_notified_installed": installed,
            "last_notified_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        record_error(error)
        raise SystemExit(1)
