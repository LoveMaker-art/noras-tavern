#!/usr/bin/env python3
"""Download one release and run the Hermes-only Nora Tavern first installer."""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import os
import platform
from pathlib import Path
from pathlib import PurePosixPath
import sys
import tarfile
import tempfile
import urllib.request


REPO = "LoveMaker-art/noras-tavern"
ASSETS = (
    "release-manifest.json",
    "SHA256SUMS",
    "nora-tavern-app.tar.gz",
    "nora-tavern-ops.tar.gz",
    "nora-tavern-nora-mcp.tar.gz",
)


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


SOURCEFORGE = 'https://downloads.sourceforge.net/project/nora-tavern/'
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

TAG_PATTERN = r'v\d+\.\d+\.\d+(?:-beta\.\d+)?'
ASSET_PATTERN = r'[A-Za-z0-9][A-Za-z0-9._-]*'
ASSET_INDEX_NAME = 'release-assets.json'
CURRENT_ASSET_PATTERN = (r'(?:release-assets\.json|release-manifest\.json|[A-Za-z0-9][A-Za-z0-9._-]*-(?:release-manifest[A-Za-z0-9._-]*\.json|SHA256SUMS|first-install-manifest\.json|nora-tavern-first-install-bootstrap\.py|tavern-updater-bootstrap\.py)|SHA256SUMS|LAUNCHER-SHA256SUMS|bootstrap-manifest\.json|'
                         r'tavern-updater-bootstrap\.py|nora-(?:system|launcher)-[A-Za-z0-9._-]*\.json|Nora-Tavern-Launcher-[A-Za-z0-9._-]*|'
                         r'first-install-manifest\.json|nora-tavern-first-install-bootstrap\.py|install-nora-tavern\.(?:sh|ps1)|install-tavern-updater\.sh)')


def release_version_key(value):
    match = re.fullmatch(r'v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?', value or '')
    if not match:
        raise RuntimeError('共享资产版本格式无效。')
    major, minor, patch, beta = match.groups()
    return (int(major), int(minor), int(patch), 1 if beta is None else 0, int(beta or 0))


def validate_asset_index(index, tag):
    if (not isinstance(index, dict) or index.get('schema') != 'nora-release-assets/1'
            or index.get('repository') != REPO or index.get('tag') != tag
            or not re.fullmatch(TAG_PATTERN, tag or '') or not re.fullmatch(r'[a-f0-9]{40}', index.get('commit') or '')
            or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', index.get('minimumLauncherVersion') or '')
            or release_version_key(index['minimumLauncherVersion']) <= release_version_key('2.1.1')
            or not isinstance(index.get('assets'), list) or len(index['assets']) > 256):
        raise RuntimeError('共享资产索引身份或兼容门槛无效。')
    names = set()
    for item in index['assets']:
        if (not isinstance(item, dict) or not re.fullmatch(ASSET_PATTERN, item.get('name') or '')
                or item['name'] in names or re.fullmatch(CURRENT_ASSET_PATTERN, item['name'])
                or not re.fullmatch(r'v\d+\.\d+\.\d+', item.get('asset_release_tag') or '')
                or release_version_key(item['asset_release_tag']) >= release_version_key(tag)
                or not re.fullmatch(r'[a-f0-9]{64}', item.get('sha256') or '')
                or not isinstance(item.get('size'), int) or isinstance(item['size'], bool) or not 0 < item['size'] <= 2*1024**3
                or set(item) != {'name', 'asset_release_tag', 'size', 'sha256'}):
            raise RuntimeError('共享资产引用缺失、冲突或超出可信范围。')
        names.add(item['name'])
    return index


def expand_asset_index(release, assets):
    descriptor = assets.get(ASSET_INDEX_NAME)
    if descriptor is None:
        return None
    if descriptor['size'] > 64*1024:
        raise RuntimeError('共享资产索引超过读取上限。')
    tag = release['tag_name']
    urls = source_candidates(descriptor['browser_download_url'])
    for position, url in enumerate(urls):
        try:
            with open_source(url, timeout=30) as response:
                validate_source(response.geturl(), url)
                raw = response.read(64*1024+1)
            if len(raw) != descriptor['size'] or hashlib.sha256(raw).hexdigest() != descriptor['digest'][7:]:
                raise RuntimeError('共享资产索引与当前发布校验信息不一致。')
            index = validate_asset_index(json.loads(raw), tag)
            break
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError) as error:
            if position == len(urls)-1 or not can_switch_source(error):
                raise
            print('[WARN] 当前来源的共享资产索引请求失败，正在使用下一受信来源。', file=sys.stderr)
    for item in index['assets']:
        if item['name'] in assets:
            raise RuntimeError('共享引用与当前发布资产同名。')
        assets[item['name']] = {'name': item['name'], 'state': 'uploaded', 'size': item['size'],
                               'digest': 'sha256:'+item['sha256'], 'asset_release_tag': item['asset_release_tag'],
                               'browser_download_url': f"https://github.com/{REPO}/releases/download/{item['asset_release_tag']}/{item['name']}"}
    return index


def publication_tag(manifest):
    core = manifest.get('versions', {}).get('tavern')
    if not isinstance(core, str) or not re.fullmatch(TAG_PATTERN, 'v' + core):
        raise RuntimeError('发布清单缺少有效核心版本。')
    if 'publication' not in manifest:
        return 'v' + core
    value = manifest['publication']
    if (not isinstance(value, dict) or set(value) != {'schema', 'tag'}
            or value.get('schema') != 'nora-component-publication/1'
            or not isinstance(value.get('tag'), str) or not re.fullmatch(TAG_PATTERN, value['tag'])):
        raise RuntimeError('组件发布批次身份无效。')
    return value['tag']


def validate_shared_manifest(release, manifest):
    if publication_tag(manifest) != release['tag_name']:
        raise RuntimeError('发布清单与固定发布批次不一致。')
    index = release.get('shared_assets')
    if index is None:
        return
    minimum = manifest.get('bootstrap', {}).get('minimumLauncherVersion')
    if (manifest.get('commit') != index['commit'] or publication_tag(manifest) != index['tag']
            or release_version_key(minimum) < release_version_key(index['minimumLauncherVersion'])):
        raise RuntimeError('共享资产与目标发布提交或客户端兼容门槛不一致。')
    for descriptor in [*manifest.get('archives', {}).values(), *manifest.get('modules', {}).values()]:
        asset = release['asset_index'].get(descriptor.get('name'))
        if asset and asset.get('asset_release_tag') and (asset['digest'] != 'sha256:'+str(descriptor.get('sha256'))
                or not isinstance(descriptor.get('size'), int) or isinstance(descriptor['size'], bool)
                or descriptor['size'] != asset['size']):
            raise RuntimeError('共享资产引用与组件校验信息不一致。')


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        validate_source(newurl, request.full_url)
        return super().redirect_request(request, response, code, message, headers, newurl)


def open_source(url, *, timeout=120):
    validate_source(url, url)
    request = urllib.request.Request(url, headers={'User-Agent': 'nora-tavern-first-install/2', 'Accept-Encoding': 'identity'})
    return urllib.request.build_opener(ReleaseRedirect()).open(request, timeout=timeout)


def can_switch_source(error):
    if isinstance(error, urllib.error.HTTPError):
        return error.code in (403, 404, 408, 410, 429, 500, 502, 503, 504)
    if isinstance(error, urllib.error.URLError):
        return not isinstance(error.reason, (ssl.SSLCertVerificationError, ssl.CertificateError))
    return isinstance(error, (TimeoutError, ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError))


def select_release(tag=None):
    if tag and not re.fullmatch(TAG_PATTERN, tag):
        raise RuntimeError('发布版本格式无效。')
    urls = source_candidates(f'https://api.github.com/repos/{REPO}/releases/' + ('tags/'+tag if tag else 'latest'))
    deadline = time.monotonic()+30
    for index, url in enumerate(urls):
        try:
            with open_source(url, timeout=min(15, max(1, deadline-time.monotonic()))) as response:
                validate_source(response.geturl(), url)
                raw = response.read(1024*1024+1)
            if len(raw) > 1024*1024:
                raise RuntimeError('发布目录超过读取上限。')
            release = json.loads(raw)
            selected = release.get('tag_name', '')
            if (not re.fullmatch(TAG_PATTERN, selected) or release.get('draft') is not False
                    or (tag and selected != tag) or (not tag and release.get('prerelease') is not False)
                    or not isinstance(release.get('assets'), list)):
                raise RuntimeError('发布目录身份无效，未开始更新。')
            assets = {}
            shared = any(asset.get('name') == ASSET_INDEX_NAME for asset in release['assets'])
            for asset in release['assets']:
                name = asset.get('name', '')
                if (not re.fullmatch(ASSET_PATTERN, name) or name in assets or asset.get('state') != 'uploaded'
                        or 'asset_release_tag' in asset
                        or not isinstance(asset.get('size'), int) or isinstance(asset['size'], bool) or asset['size'] <= 0
                        or ((shared or asset.get('digest') is not None) and not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest') or ''))
                        or asset.get('browser_download_url') != f'https://github.com/{REPO}/releases/download/{selected}/{name}'):
                    raise RuntimeError('发布文件身份或校验信息无效。')
                assets[name] = asset
            index = expand_asset_index(release, assets)
            return {**release, 'asset_index': assets, **({'shared_assets': index} if index is not None else {})}
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError) as error:
            if index == len(urls)-1 or not can_switch_source(error):
                raise
            print('[WARN] 当前来源的版本查询失败，正在使用下一受信来源。', file=sys.stderr)
    raise RuntimeError('无法确认发布版本。')


def download(url, target, *, expected_sha256=None, expected_size=None):
    prefix = f'https://github.com/{REPO}/releases/download/'
    relative = url[len(prefix):] if url.startswith(prefix) else ''
    if not re.fullmatch(TAG_PATTERN+'/'+ASSET_PATTERN, relative):
        raise RuntimeError('发布文件地址无效，未下载。')
    urls = source_candidates(url)
    target = Path(target)
    temporary = target.with_name(target.name+'.part')
    deadline = time.monotonic()+1800
    try:
        for index, source in enumerate(urls):
            source_deadline = deadline-300*(len(urls)-index-1)
            digest, size = hashlib.sha256(), 0
            try:
                with open_source(source, timeout=min(120, max(1, source_deadline-time.monotonic()))) as response, temporary.open('wb') as output:
                    validate_source(response.geturl(), source)
                    while chunk := response.read(1024*1024):
                        if time.monotonic() >= source_deadline:
                            raise TimeoutError('下载超过等待期限。')
                        size += len(chunk)
                        if expected_size is not None and size > expected_size:
                            raise RuntimeError('下载文件大小校验失败。')
                        digest.update(chunk)
                        output.write(chunk)
                if expected_size is not None and size != expected_size:
                    raise ConnectionError('资源传输中断，文件未下载完整。')
                if expected_sha256 is not None and digest.hexdigest() != expected_sha256:
                    raise RuntimeError('下载文件哈希校验失败。')
                os.replace(temporary, target)
                return
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError) as error:
                if index == len(urls)-1 or not can_switch_source(error):
                    raise
                print('[WARN] 当前来源的资源传输失败，正在从下一受信来源重新下载同一文件。', file=sys.stderr)
    finally:
        temporary.unlink(missing_ok=True)


def download_asset(release, name, target, *, expected_sha256=None):
    asset = release['asset_index'].get(name)
    if not asset or (expected_sha256 and asset.get('digest') and asset['digest'] != 'sha256:'+expected_sha256):
        raise RuntimeError('发布文件缺失或校验信息不一致：'+name)
    download(asset['browser_download_url'], target, expected_sha256=asset['digest'][7:] if asset.get('digest') else expected_sha256, expected_size=asset['size'])


def download_release(directory: Path, tag=None) -> dict:
    release = select_release(tag)
    for name in ASSETS[:2]:
        download_asset(release, name, directory / name)
    manifest = json.loads((directory / "release-manifest.json").read_text(encoding="utf-8"))
    validate_shared_manifest(release, manifest)
    physical = {}
    if 'coreRelease' in manifest:
        # APP-only publications carry a new runner, not a new core. Resolve the
        # same platform payload as the desktop installer before installing it.
        ref = manifest['coreRelease']
        target = sys.platform + '-' + ('arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'x64')
        if (not isinstance(ref, dict) or set(ref) != {'schema', 'tag', 'commit', 'manifests'}
                or ref.get('schema') != 'nora-core-reference/1'
                or not re.fullmatch(r'v\d+\.\d+\.\d+', str(ref.get('tag', '')))
                or not re.fullmatch(r'[a-f0-9]{40}', str(ref.get('commit', '')))
                or not isinstance(ref.get('manifests'), dict)
                or release_version_key(ref['tag']) >= release_version_key(release['tag_name'])):
            raise RuntimeError('不变核心的来源证明无效，未开始安装。')
        bound = ref['manifests'].get(target)
        if target not in ('darwin-arm64', 'darwin-x64', 'win32-x64') or not isinstance(bound, dict):
            raise RuntimeError('此仅启动器发布未提供当前平台的核心安装资源，未修改现有安装。')
        if (set(bound) != {'asset', 'sha256', 'size'} or bound.get('asset') != target+'-release-manifest.json'
                or not re.fullmatch(r'[a-f0-9]{64}', str(bound.get('sha256', '')))
                or type(bound.get('size')) is not int or not 0 < bound['size'] <= 4*1024*1024):
            raise RuntimeError('原始核心清单的绑定无效。')
        system_file = directory / 'nora-system.json'
        download_asset(release, 'nora-system-'+target+'.json', system_file)
        system = json.loads(system_file.read_text(encoding='utf-8'))
        physical = system.get('files', {})
        if (system.get('schema') != 'nora-system/v1' or system.get('coreRelease') != ref
                or system.get('commit') != manifest.get('commit') or system.get('version') != manifest.get('versions', {}).get('tavern')
                or system.get('platform')+'-'+system.get('arch') != target or system.get('publication') != manifest.get('publication')
                or physical.get('release-manifest.json') != bound):
            raise RuntimeError('完整系统与不变核心证明不一致。')
        for name in ASSETS[:2]:
            entry = physical.get(name, {})
            download_asset(release, entry.get('asset'), directory / name, expected_sha256=entry.get('sha256'))
            if type(entry.get('size')) is not int or (directory / name).stat().st_size != entry['size']:
                raise RuntimeError('原始核心元数据大小不一致。')
        core = json.loads((directory / 'release-manifest.json').read_text(encoding='utf-8'))
        if (core.get('coreRelease') or core.get('commit') != ref['commit'] or publication_tag(core) != ref['tag']
                or core.get('versions', {}).get('tavern') != system['version']):
            raise RuntimeError('原始核心身份与发布证明不一致。')
        manifest = core
    for name in ASSETS[2:]:
        descriptor = next((item for item in manifest.get("archives", {}).values() if item.get("name") == name), None)
        if not descriptor or not re.fullmatch(r'[a-f0-9]{64}', descriptor.get('sha256') or ''):
            raise RuntimeError("首次安装组件缺少发布清单身份：" + name)
        entry = physical.get(name) if physical else None
        asset_name = entry.get('asset') if entry else name
        if entry and entry.get('sha256') != descriptor['sha256']:
            raise RuntimeError('原始核心档案与完整系统不一致。')
        asset = release["asset_index"].get(asset_name)
        if release.get("shared_assets") and (not asset or not isinstance(descriptor.get("size"), int)
                or isinstance(descriptor["size"], bool) or descriptor["size"] != asset["size"]):
            raise RuntimeError("首次安装组件大小与发布清单不一致：" + name)
        download_asset(release, asset_name, directory / name, expected_sha256=descriptor.get("sha256"))
    return release


def verify_release(directory: Path, *, allow_candidate: bool = False) -> str:
    checks = {}
    for line in (directory / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, name = line.split(None, 1)
        checks[name.strip()] = digest
    for name in ASSETS:
        if not (directory / name).is_file():
            raise RuntimeError("发布文件缺失：" + name)
        if name != "SHA256SUMS" and sha(directory / name) != checks.get(name):
            raise RuntimeError("发布文件校验失败：" + name)
    manifest = json.loads((directory / "release-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "tavern-release/v2" or (manifest.get("candidate") and not allow_candidate):
        raise RuntimeError("首次安装默认只允许正式 Nora Tavern v2 发布包")
    return checks["release-manifest.json"]


def safe_member(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise RuntimeError("发布包包含非法路径：" + name)
    return path


def extract_ops_runner(release_dir: Path, destination: Path) -> Path:
    manifest = json.loads((release_dir / "release-manifest.json").read_text(encoding="utf-8"))
    expected = {
        name: digest
        for name, digest in manifest.get("artifacts", {}).items()
        if name.startswith("ops/")
    }
    if not expected:
        raise RuntimeError("发布包缺少 ops 文件清单")
    archive = release_dir / "nora-tavern-ops.tar.gz"
    if sha(archive) != manifest["archives"]["ops"]["sha256"]:
        raise RuntimeError("ops 发布包校验失败")
    seen = set()
    with tarfile.open(archive, "r:gz") as package:
        for member in package:
            path = safe_member(member.name)
            if not member.isfile() or path.parts[0] != "ops" or member.name not in expected:
                raise RuntimeError("ops 发布包包含未声明文件：" + member.name)
            data = package.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != expected[member.name]:
                raise RuntimeError("ops 文件校验失败：" + member.name)
            target = destination.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            seen.add(member.name)
    required = {
        "ops/installer/first_install.py",
        "ops/installer/templates/SOUL.md",
        "ops/installer/templates/greeting.md",
        "ops/updater/managed_context.py",
        "ops/installer/nora_system.py",
        "ops/scripts/nora-instance.py",
        "ops/scripts/nora-tavern-update-check.py",
        "ops/hooks/tavern-liveware-register/handler.py",
        "ops/updater/bundle.py",
        "ops/installer/operation_control.py",
        "ops/installer/operation_cli.py",
        "ops/installer/operation_evidence.py",
        "ops/scripts/install-hermes-skills.py",
    }
    missing = sorted(required - seen)
    if missing:
        raise RuntimeError("ops 发布包缺少首次安装文件：" + ", ".join(missing))
    return destination / "ops/installer/first_install.py"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag")
    parser.add_argument("--release-dir", type=Path)
    parser.add_argument("--hermes-home", "--data-root", dest="hermes_home")
    parser.add_argument("--nora-home")
    parser.add_argument("--install-root")
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--replace-soul", action="store_true")
    parser.add_argument("--dedicated-nora", action="store_true")
    parser.add_argument("--skip-liveware", action="store_true")
    parser.add_argument("--force-first-install", action="store_true")
    parser.add_argument("--allow-candidate", action="store_true")
    parser.add_argument("--skip-hermes-install", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    if not (args.apply and args.confirm):
        raise RuntimeError("首次安装必须显式传入 --apply --confirm")

    with tempfile.TemporaryDirectory(prefix="nora-tavern-bootstrap.") as temporary:
        work = Path(temporary)
        release_dir = args.release_dir
        if release_dir is None:
            release_dir = work / "release"
            release_dir.mkdir()
            download_release(release_dir, args.tag)
        manifest_sha = verify_release(release_dir, allow_candidate=args.allow_candidate)
        installer = extract_ops_runner(release_dir, work / "runner")
        # A downloaded standalone entry has no adjacent operation modules.
        # Import the existing guard only from the verified temporary ops tree,
        # then require its authorization before executing any installer writer.
        import importlib.util
        cli_path = installer.with_name('operation_cli.py')
        spec = importlib.util.spec_from_file_location('nora_first_bootstrap_operation_cli', cli_path)
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        cli.ensure_operation('install', nora_home=args.nora_home or os.environ.get('NORA_TAVERN_HOME'))
        command = [
            sys.executable, "-u", "-B", str(installer),
            "--release-dir", str(Path(release_dir).resolve()),
            "--manifest-sha256", manifest_sha,
            "--port", str(args.port),
            "--apply", "--confirm",
        ]
        if args.hermes_home:
            command += ["--hermes-home", args.hermes_home]
        if args.nora_home:
            command += ["--nora-home", args.nora_home]
        if args.install_root:
            command += ["--install-root", args.install_root]
        if args.replace_soul:
            command.append("--replace-soul")
        if args.dedicated_nora:
            command.append("--dedicated-nora")
        if args.skip_liveware:
            command.append("--skip-liveware")
        if args.force_first_install:
            command.append("--force-first-install")
        if args.allow_candidate:
            command.append("--allow-candidate")
        result = cli._control().managed_run(command)
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("[nora-tavern-install] 安装失败：" + str(error), file=sys.stderr)
        raise SystemExit(1)
