param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = "Stop"

Write-Host "[nora-tavern-install] 开始首次安装。"

function Get-InstallerArg {
    param([string]$Name)
    for ($i = 0; $i -lt $Rest.Count; $i++) {
        if ($Rest[$i] -eq $Name -and ($i + 1) -lt $Rest.Count) {
            return $Rest[$i + 1]
        }
        if ($Rest[$i].StartsWith("$Name=")) {
            return $Rest[$i].Substring($Name.Length + 1)
        }
    }
    return ""
}

$RequestedNoraHome = Get-InstallerArg "--nora-home"
$RequestedHermesHome = Get-InstallerArg "--hermes-home"
if (-not $RequestedHermesHome) { $RequestedHermesHome = Get-InstallerArg "--data-root" }
$RequestedInstallRoot = Get-InstallerArg "--install-root"

if ($RequestedNoraHome) {
    $env:NORA_TAVERN_HOME = $RequestedNoraHome
} elseif (-not $env:NORA_TAVERN_HOME) {
    if ($env:LOCALAPPDATA) {
        $env:NORA_TAVERN_HOME = Join-Path $env:LOCALAPPDATA "NoraTavern"
    } else {
        $env:NORA_TAVERN_HOME = Join-Path $HOME "AppData\Local\NoraTavern"
    }
}
if ($RequestedHermesHome) {
    $env:HERMES_HOME = $RequestedHermesHome
} elseif (-not $env:HERMES_HOME) {
    $env:HERMES_HOME = Join-Path $env:NORA_TAVERN_HOME "hermes"
}
if (-not $env:HERMES_INSTALL_DIR) {
    $env:HERMES_INSTALL_DIR = Join-Path $env:HERMES_HOME "hermes-agent"
}
if ($RequestedInstallRoot) {
    $env:TAVERN_DATA_ROOT = $RequestedInstallRoot
} elseif (-not $env:TAVERN_DATA_ROOT) {
    $env:TAVERN_DATA_ROOT = Join-Path $env:NORA_TAVERN_HOME "tavern"
}
$env:HOME = $env:HERMES_HOME
$env:USERPROFILE = $env:HERMES_HOME
$env:APPDATA = Join-Path $env:NORA_TAVERN_HOME "appdata\roaming"
$env:LOCALAPPDATA = Join-Path $env:NORA_TAVERN_HOME "appdata\local"

function Invoke-Python {
    param([string]$Script)
function Select-InstallerPython {
    $script:PythonPrefix = @()
    if ($env:TAVERN_PYTHON) {
        $script:PythonExecutable = $env:TAVERN_PYTHON
    } elseif (Test-Path (Join-Path $env:HERMES_INSTALL_DIR "venv\Scripts\python.exe")) {
        $script:PythonExecutable = Join-Path $env:HERMES_INSTALL_DIR "venv\Scripts\python.exe"
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        $script:PythonExecutable = (Get-Command python).Source
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        $script:PythonExecutable = (Get-Command py).Source
        $script:PythonPrefix = @("-3")
    } else {
        throw "未找到 Python 3.9+。请先确认 Hermes 安装完成，并重新打开 PowerShell。"
    }
    & $PythonExecutable @PythonPrefix -B -c "import sys; assert sys.version_info >= (3, 9)"
    if ($LASTEXITCODE -ne 0) { throw "首次安装需要 Python 3.9+。" }
}

function Invoke-Python {
    param([string]$Script)
    $InstallerArgs = @("--tag", $FrozenTag, "--nora-home", $env:NORA_TAVERN_HOME, "--hermes-home", $env:HERMES_HOME, "--install-root", $env:TAVERN_DATA_ROOT) + $Rest
    & $PythonExecutable @PythonPrefix -u -B $Script @InstallerArgs
    exit $LASTEXITCODE
}

Select-InstallerPython
$Loader = @'
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
        elif value.path == api and value.query == 'per_page=100&page=1' and channel == 'beta':
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
'@
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("nora-tavern-install." + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Work | Out-Null

try {
    $BootstrapPath = Join-Path $Work "nora-tavern-first-install-bootstrap.py"
    $LoaderPath = Join-Path $Work "verified-release-loader.py"
    [System.IO.File]::WriteAllText($LoaderPath, $Loader, (New-Object System.Text.UTF8Encoding($false)))
    $Target = & $PythonExecutable @PythonPrefix -B $LoaderPath $Work @Rest
    if ($LASTEXITCODE -ne 0) { throw "首次安装引导校验失败。" }
    $FrozenTag = ($Target.Trim() -split ' ')[0]

    Invoke-Python $BootstrapPath
}
finally {
    Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
