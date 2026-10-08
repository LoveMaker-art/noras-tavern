#!/bin/sh
set -eu
echo '[tavern-updater] 开始更新。' >&2
if [ -n "${TAVERN_PYTHON:-}" ]; then
  PY="$TAVERN_PYTHON"
elif [ -x /opt/hermes/.venv/bin/python3 ]; then
  PY=/opt/hermes/.venv/bin/python3
elif [ -x /opt/hermes/.venv/bin/python ]; then
  PY=/opt/hermes/.venv/bin/python
else
  PY=$(command -v python3 || command -v python)
fi
"$PY" -B -c 'import sys; assert sys.version_info >= (3, 9)' >/dev/null
WORK=$(mktemp -d "${TMPDIR:-/tmp}/tavern-bootstrap.XXXXXX")
trap 'rm -f "$WORK/bootstrap-manifest.json" "$WORK/tavern-updater-bootstrap.py"; rmdir "$WORK" 2>/dev/null || true' EXIT HUP INT TERM
TARGET=$("$PY" -B - "$WORK" "$@" <<'PY'
# The initial loader cannot execute downloaded code until its digest is checked.
import argparse, hashlib, http.client, json, pathlib, re, ssl, sys, urllib.error, urllib.parse, urllib.request
root = pathlib.Path(sys.argv[1])
p = argparse.ArgumentParser(add_help=False)
p.add_argument('--tag')
a, _ = p.parse_known_args(sys.argv[2:])
repo = 'LoveMaker-art/noras-tavern'
sf = 'https://downloads.sourceforge.net/project/nora-tavern/'
pattern = r'v\d+\.\d+\.\d+(?:-beta\.\d+)?'
if a.tag and not re.fullmatch(pattern, a.tag):
    raise SystemExit('发布版本格式无效。')
def validate(url, original):
    value, previous = urllib.parse.urlsplit(url), urllib.parse.urlsplit(original)
    mirror = lambda host: host == 'downloads.sourceforge.net' or bool(re.fullmatch(r'[a-z0-9-]+\.dl\.sourceforge\.net', host or ''))
    if (value.scheme != 'https' or value.username or value.password or value.fragment
            or (mirror(previous.hostname) and (not mirror(value.hostname) or value.port is not None or value.path != previous.path))):
        raise RuntimeError('资源响应偏离受信任来源。')
class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        validate(url, request.full_url)
        return super().redirect_request(request, response, code, message, headers, url)
def fetch(urls, limit, *, expected=None):
    for index, url in enumerate(urls):
        try:
            request = urllib.request.Request(url, headers={'User-Agent':'tavern-updater/4', 'Accept-Encoding':'identity'})
            with urllib.request.build_opener(Redirect()).open(request, timeout=30) as response:
                validate(response.geturl(), url)
                data = response.read(limit+1)
            if len(data)>limit:
                raise RuntimeError('发布文件超过读取上限。')
            if expected and len(data)!=expected['size']:
                raise ConnectionError('文件传输中断。')
            if expected and hashlib.sha256(data).hexdigest()!=expected['digest'][7:]:
                raise RuntimeError('发布文件哈希校验失败。')
            return data
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError) as error:
            recoverable = (error.code in (403,404,408,410,429,500,502,503,504) if isinstance(error,urllib.error.HTTPError)
                           else not isinstance(getattr(error,'reason',None),(ssl.SSLCertVerificationError,ssl.CertificateError)))
            if index or not recoverable:
                raise
            print('[WARN] GitHub请求失败，正在使用SourceForge备用源。',file=sys.stderr)
release = json.loads(fetch([f'https://api.github.com/repos/{repo}/releases/'+('tags/'+a.tag if a.tag else 'latest'),
                           sf+(a.tag+'/release.json' if a.tag else 'channels/stable.json')],1024*1024))
tag = release.get('tag_name','')
if (not re.fullmatch(pattern,tag) or release.get('draft') is not False
        or (a.tag and tag!=a.tag) or (not a.tag and release.get('prerelease') is not False)):
    raise SystemExit('发布目录身份无效。')
assets = {}
for asset in release.get('assets',[]):
    name = asset.get('name','')
    if name in assets:
        raise SystemExit('发布文件重复。')
    assets[name] = asset
for name in ['bootstrap-manifest.json','tavern-updater-bootstrap.py']:
    asset = assets.get(name,{})
    url = f'https://github.com/{repo}/releases/download/{tag}/{name}'
    if (asset.get('browser_download_url')!=url or asset.get('state')!='uploaded'
            or not re.fullmatch(r'sha256:[a-f0-9]{64}',asset.get('digest') or '')
            or not isinstance(asset.get('size'),int) or isinstance(asset['size'],bool) or not 0<asset['size']<=16*1024*1024):
        raise SystemExit('引导文件校验信息无效。')
    (root/name).write_bytes(fetch([url,sf+tag+'/'+name],16*1024*1024,expected=asset))
manifest = json.loads((root / 'bootstrap-manifest.json').read_text())
actual = hashlib.sha256((root / 'tavern-updater-bootstrap.py').read_bytes()).hexdigest()
if (manifest.get('scope') != 'tavern-updater-bootstrap' or actual != manifest.get('sha256')
        or not re.fullmatch(r'[a-f0-9]{40}',manifest.get('commit') or '')):
    raise SystemExit('Bootstrap checksum mismatch')
print(tag+' '+manifest['commit'])
PY
)
TAG=${TARGET%% *}
TARGET_COMMIT=${TARGET#* }
"$PY" -u -B "$WORK/tavern-updater-bootstrap.py" --tag "$TAG" --target-commit "$TARGET_COMMIT" "$@"
