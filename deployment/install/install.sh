#!/bin/sh
set -eu
echo '[nora-tavern-install] 开始首次安装。' >&2

arg_value() {
  wanted=$1
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      "$wanted")
        [ "$#" -gt 1 ] && printf '%s\n' "$2"
        return 0
        ;;
      "$wanted="*)
        printf '%s\n' "${1#*=}"
        return 0
        ;;
    esac
    shift
  done
  return 1
}

REQUESTED_NORA_HOME=$(arg_value "--nora-home" "$@" || true)
REQUESTED_HERMES_HOME=$(arg_value "--hermes-home" "$@" || arg_value "--data-root" "$@" || true)
REQUESTED_INSTALL_ROOT=$(arg_value "--install-root" "$@" || true)

if [ -n "$REQUESTED_NORA_HOME" ]; then
  NORA_TAVERN_HOME="$REQUESTED_NORA_HOME"
elif [ -z "${NORA_TAVERN_HOME:-}" ]; then
  case "$(uname -s)" in
    Darwin) NORA_TAVERN_HOME="$HOME/Library/NoraTavern" ;;
    *) NORA_TAVERN_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/nora-tavern" ;;
  esac
fi
HERMES_HOME="${REQUESTED_HERMES_HOME:-${HERMES_HOME:-$NORA_TAVERN_HOME/hermes}}"
HERMES_INSTALL_DIR="${HERMES_INSTALL_DIR:-$HERMES_HOME/hermes-agent}"
TAVERN_DATA_ROOT="${REQUESTED_INSTALL_ROOT:-${TAVERN_DATA_ROOT:-$NORA_TAVERN_HOME/tavern}}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$NORA_TAVERN_HOME/cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$NORA_TAVERN_HOME/data}"
export NORA_TAVERN_HOME HERMES_HOME HERMES_INSTALL_DIR TAVERN_DATA_ROOT XDG_CACHE_HOME XDG_DATA_HOME

if [ -n "${TAVERN_PYTHON:-}" ]; then
  PY="$TAVERN_PYTHON"
elif [ -x "$HERMES_INSTALL_DIR/venv/bin/python3" ]; then
  PY="$HERMES_INSTALL_DIR/venv/bin/python3"
elif [ -x "$HERMES_INSTALL_DIR/venv/bin/python" ]; then
  PY="$HERMES_INSTALL_DIR/venv/bin/python"
elif [ -x /opt/hermes/.venv/bin/python3 ]; then
  PY=/opt/hermes/.venv/bin/python3
elif [ -x /opt/hermes/.venv/bin/python ]; then
  PY=/opt/hermes/.venv/bin/python
else
  PY=$(command -v python3 || command -v python)
fi
"$PY" -B -c 'import sys; assert sys.version_info >= (3, 9)' >/dev/null
WORK=$(mktemp -d "${TMPDIR:-/tmp}/nora-tavern-install.XXXXXX")
trap 'rm -f "$WORK/first-install-manifest.json" "$WORK/nora-tavern-first-install-bootstrap.py"; rmdir "$WORK" 2>/dev/null || true' EXIT HUP INT TERM
TARGET=$("$PY" -B - "$WORK" "$@" <<'PY'
# The initial loader cannot execute downloaded code until its digest is checked.
import argparse, hashlib, http.client, json, pathlib, re, ssl, sys, time, urllib.error, urllib.parse, urllib.request
root = pathlib.Path(sys.argv[1])
p = argparse.ArgumentParser(add_help=False)
p.add_argument('--tag')
a, _ = p.parse_known_args(sys.argv[2:])
REPO = 'LoveMaker-art/noras-tavern'
TAG_PATTERN = r'v\d+\.\d+\.\d+(?:-beta\.\d+)?'
ASSET_PATTERN = r'[A-Za-z0-9][A-Za-z0-9._-]*'
if a.tag and not re.fullmatch(TAG_PATTERN, a.tag):
    raise SystemExit('发布版本格式无效。')
MANIFEST_NAME = 'first-install-manifest.json'
BOOTSTRAP_NAME = 'nora-tavern-first-install-bootstrap.py'
BOOTSTRAP_SCOPE = 'nora-tavern-first-install-bootstrap'
REQUIRE_DIGEST = False
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

class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        validate_source(url, request.full_url)
        return super().redirect_request(request, response, code, message, headers, url)

def fetch(urls, limit, *, expected=None):
    for index, url in enumerate(urls):
        try:
            validate_source(url, url)
            request = urllib.request.Request(url, headers={'User-Agent': 'nora-tavern-loader/1', 'Accept-Encoding': 'identity'})
            with urllib.request.build_opener(Redirect()).open(request, timeout=30) as response:
                validate_source(response.geturl(), url)
                data = response.read(limit+1)
            if len(data) > limit:
                raise RuntimeError('发布文件超过读取上限。')
            if expected and len(data) != expected['size']:
                raise ConnectionError('文件传输中断。')
            if expected and expected.get('digest') and hashlib.sha256(data).hexdigest() != expected['digest'][7:]:
                raise RuntimeError('发布文件哈希校验失败。')
            return data
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError) as error:
            recoverable = (error.code in (403,404,408,410,429,500,502,503,504) if isinstance(error, urllib.error.HTTPError)
                           else not isinstance(getattr(error, 'reason', None), (ssl.SSLCertVerificationError, ssl.CertificateError)))
            if index == len(urls)-1 or not recoverable:
                raise
            print('[WARN] 当前来源请求失败，正在使用下一受信来源。', file=sys.stderr)
    raise RuntimeError('所有引导来源均不可用。')

release = json.loads(fetch(source_candidates(f'https://api.github.com/repos/{REPO}/releases/'+('tags/'+a.tag if a.tag else 'latest')), 1024*1024))
tag = release.get('tag_name', '')
if (not re.fullmatch(TAG_PATTERN, tag) or release.get('draft') is not False
        or (a.tag and tag != a.tag) or (not a.tag and release.get('prerelease') is not False)
        or not isinstance(release.get('assets'), list)):
    raise SystemExit('发布目录身份无效。')
assets = {}
for asset in release['assets']:
    name = asset.get('name', '')
    if not re.fullmatch(ASSET_PATTERN, name) or name in assets:
        raise SystemExit('发布文件身份无效或重复。')
    assets[name] = asset
for name in [MANIFEST_NAME, BOOTSTRAP_NAME]:
    asset = assets.get(name, {})
    url = f'https://github.com/{REPO}/releases/download/{tag}/{name}'
    if (asset.get('browser_download_url') != url or asset.get('state') != 'uploaded'
            or 'asset_release_tag' in asset
            or (REQUIRE_DIGEST or asset.get('digest') is not None) and not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest') or '')
            or not isinstance(asset.get('size'), int) or isinstance(asset['size'], bool) or not 0 < asset['size'] <= 16*1024*1024):
        raise SystemExit('引导文件校验信息无效。')
    (root/name).write_bytes(fetch(source_candidates(url), 16*1024*1024, expected=asset))
manifest = json.loads((root / MANIFEST_NAME).read_text(encoding='utf-8'))
actual = hashlib.sha256((root / BOOTSTRAP_NAME).read_bytes()).hexdigest()
if (manifest.get('scope') != BOOTSTRAP_SCOPE or actual != manifest.get('sha256')
        or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('commit') or '')):
    raise SystemExit('Bootstrap checksum mismatch')
print(tag+' '+manifest['commit'])
PY
)
TAG=${TARGET%% *}
exec "$PY" -u -B "$WORK/nora-tavern-first-install-bootstrap.py" \
  --tag "$TAG" \
  --nora-home "$NORA_TAVERN_HOME" \
  --hermes-home "$HERMES_HOME" \
  --install-root "$TAVERN_DATA_ROOT" \
  "$@"
