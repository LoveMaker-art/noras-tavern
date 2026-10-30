#!/usr/bin/env python3
"""Search, download, install and enable skills. Never executes skill tasks."""
import argparse
import subprocess
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib

MAX_CATALOGUE = 512 * 1024
MAX_PACKAGE = 10 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
VERSION = re.compile(r"\d+\.\d+\.\d+\Z")


class Failure(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def fail(code, message):
    raise Failure(code, message)


class Client:
    def __init__(self, local_test=None):
        config = Path(__file__).resolve().parent.parent / 'references' / 'sources.json'
        self.config = json.loads(config.read_text(encoding='utf-8'))
        self.local = None
        if local_test:
            u = urllib.parse.urlsplit(local_test)
            if u.scheme != 'http' or u.hostname not in ('127.0.0.1', 'localhost', '::1') or u.username or u.password or u.query or u.fragment:
                fail('INVALID_TEST_SOURCE', '本地测试源必须是无凭据的 loopback HTTP 地址')
            self.local = local_test.rstrip('/') + '/'
        self.catalogues = [self.local + 'catalogue.local.json'] if self.local else self.config['catalogueUrls']

    def allowed(self, url):
        u = urllib.parse.urlsplit(url)
        if u.username or u.password or u.query or u.fragment:
            return False
        if self.local:
            return url.startswith(self.local) and u.scheme == 'http' and u.hostname in ('localhost', '127.0.0.1', '::1') and not any(p in ('.', '..') for p in urllib.parse.unquote(u.path).split('/'))
        return u.scheme == 'https' and (url in self.config['catalogueUrls'] or any(url.startswith(base) for base in self.config['packageBases']))

    def read(self, url, limit):
        if not self.allowed(url):
            fail('UNTRUSTED_URL', '资源地址不属于已配置的官方源')
        client = self
        class Redirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                if not client.allowed(newurl):
                    fail('UNTRUSTED_REDIRECT', '资源重定向超出官方源范围')
                return super().redirect_request(req, fp, code, msg, headers, newurl)
        opener = urllib.request.build_opener(Redirect())
        request = urllib.request.Request(url, headers={'User-Agent': 'Nora-Skill-Library/0.3.0', 'Accept-Encoding': 'identity'})
        try:
            with opener.open(request, timeout=15) as response:
                data = response.read(limit + 1)
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            code = getattr(error, 'code', None)
            fail('SOURCE_UNAVAILABLE', 'HTTP ' + str(code) if code else '源连接失败或超时')
        if len(data) > limit:
            fail('RESOURCE_TOO_LARGE', '资源超过允许大小')
        return data

    def catalogue(self):
        attempts = []
        for url in self.catalogues:
            try:
                data = json.loads(self.read(url, MAX_CATALOGUE).decode('utf-8'))
                validate_catalogue(data, self)
                return data, url
            except (Failure, ValueError, UnicodeError) as error:
                attempts.append({'source': url, 'code': getattr(error, 'code', 'INVALID_CATALOGUE')})
        fail('CATALOGUE_UNAVAILABLE', '技能目录不可用：' + json.dumps(attempts, ensure_ascii=False))

    def package(self, skill):
        package, attempts = skill['package'], []
        for url in package['urls']:
            try:
                data = self.read(url, MAX_PACKAGE)
                if len(data) != package['bytes'] or hashlib.sha256(data).hexdigest() != package['sha256']:
                    fail('PACKAGE_CHECKSUM', '包大小或 SHA256 不匹配')
                inspect_zip(data, skill['id'])
                return data, url, attempts
            except Failure as error:
                attempts.append({'source': url, 'code': error.code})
        fail('PACKAGE_UNAVAILABLE', '同版本技能包不可用：' + json.dumps(attempts, ensure_ascii=False))


def validate_catalogue(data, client):
    if not isinstance(data, dict) or data.get('schema_version') != 1 or data.get('library') != 'nora-skills' or not isinstance(data.get('skills'), list):
        fail('INVALID_CATALOGUE', '不支持的技能目录格式')
    ids = set()
    for item in data['skills']:
        if not isinstance(item, dict):
            fail('INVALID_CATALOGUE', '技能条目无效')
        name = item.get('id', '')
        if not isinstance(name, str) or not ID.fullmatch(name) or len(name) > 64 or name in ids:
            fail('INVALID_CATALOGUE', '技能标识重复或无效')
        ids.add(name)
        if item.get('delivery') not in ('download', 'bundled'):
            fail('INVALID_CATALOGUE', '未知的交付方式')
        if item['delivery'] != 'download':
            continue
        version, package = item.get('version'), item.get('package')
        if not isinstance(version, str) or not VERSION.fullmatch(version) or not isinstance(package, dict):
            fail('INVALID_CATALOGUE', '版本或包信息无效')
        filename = name + '-' + version + '.zip'
        if package.get('filename') != filename or package.get('root_directory') != name:
            fail('INVALID_CATALOGUE', '包身份不匹配')
        size = package.get('bytes')
        if type(size) is not int or not 0 < size <= MAX_PACKAGE or not re.fullmatch('[a-f0-9]{64}', str(package.get('sha256', ''))):
            fail('INVALID_CATALOGUE', '包长度或校验信息无效')
        urls = package.get('urls')
        if not isinstance(urls, list) or not urls or len(urls) > 4 or not all(isinstance(u, str) and client.allowed(u) and urllib.parse.unquote(urllib.parse.urlsplit(u).path).endswith('/' + filename) for u in urls):
            fail('INVALID_CATALOGUE', '包下载地址无效')
        if not client.local:
            expected = [client.config['packageBases'][0] + name + '-' + version + '/' + filename, client.config['packageBases'][1] + filename]
            if urls != expected:
                fail('INVALID_CATALOGUE', '包源或顺序不匹配：应为极狐主源、官网同版本后备')


def inspect_zip(data, skill_id):
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        files, seen, total = {}, set(), 0
        if not 1 <= len(z.infolist()) <= 512:
            fail('INVALID_ARCHIVE', 'ZIP 文件数量异常')
        for info in z.infolist():
            name = info.filename
            parts = PurePosixPath(name).parts
            mode = info.external_attr >> 16
            if name != info.orig_filename or '\x00' in name or any(not part for part in name.rstrip('/').split('/')) or '\\' in name or ':' in name or name.startswith('/') or not parts or parts[0] != skill_id or any(p in ('.', '..') for p in name.rstrip('/').split('/')) or any(p.rstrip(' .') != p for p in parts) or info.flag_bits & 1:
                fail('INVALID_ARCHIVE', 'ZIP 包含不安全或不匹配的路径')
            key = name.rstrip('/').casefold()
            if key in seen or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                fail('INVALID_ARCHIVE', 'ZIP 存在重复路径、符号链接或特殊文件')
            seen.add(key)
            total += info.file_size
            if total > MAX_EXPANDED:
                fail('INVALID_ARCHIVE', 'ZIP 解压大小超过限制')
            if not info.is_dir():
                if len(parts) < 2:
                    fail('INVALID_ARCHIVE', '技能根目录结构无效')
                files['/'.join(parts[1:])] = z.read(info)
        entry = files.get('SKILL.md', b'').decode('utf-8')
        front = re.match(r'\A---\s*\n(.*?)\n---(?:\s*\n|$)', entry, re.S)
        name = re.search(r'^name:\s*[\'"]?([a-z0-9-]+)[\'"]?\s*$', front.group(1), re.M) if front else None
        if not name or name.group(1) != skill_id:
            fail('INVALID_ARCHIVE', 'SKILL.md 身份与目录不一致')
        return files
    except (zipfile.BadZipFile, RuntimeError, UnicodeError, KeyError, EOFError, OSError, NotImplementedError, ValueError, zlib.error):
        fail('INVALID_ARCHIVE', 'ZIP 内容不可读取或损坏')


def home_path(explicit):
    env = os.environ.get('HERMES_HOME')
    if not explicit and not env:
        fail('HOME_REQUIRED', '请从当前实例确认 HERMES_HOME，或显式指定 --hermes-home')
    home = Path(explicit or env).expanduser().resolve()
    if explicit and env and home != Path(env).expanduser().resolve():
        fail('HOME_MISMATCH', '显式目录与当前 HERMES_HOME 不一致')
    if not home.is_dir():
        fail('HOME_REQUIRED', '当前实例目录不存在')
    return home


def install(home, skill, data):
    files = inspect_zip(data, skill['id'])
    skills = home / 'skills'
    creative = skills / 'creative'
    # Existing symlinked skill locations may belong to a different instance.
    if skills.is_symlink() or creative.is_symlink():
        fail('UNSAFE_TARGET', '技能目录是符号链接，请先核对实例归属')
    creative.mkdir(parents=True, exist_ok=True)
    target = creative / skill['id']
    lock = skills / '.nora-skill-library-install.lock'
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        fail('INSTALL_BUSY', '安装锁已存在，请确认原任务状态后再试')
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(str(os.getpid()))
        if target.exists() or target.is_symlink():
            if target.is_symlink() or not target.is_dir() or any(p.is_symlink() for p in target.rglob('*')):
                fail('ALREADY_EXISTS', '同名路径已存在，保留原内容')
            existing = {p.relative_to(target).as_posix(): p.read_bytes() for p in target.rglob('*') if p.is_file()}
            if existing == files:
                return 'already-installed', str(target)
            fail('ALREADY_EXISTS', '同名技能已有不同或自定义内容，未覆盖；本工具不执行更新')
        with tempfile.TemporaryDirectory(prefix='.nora-skill-stage-', dir=str(creative)) as temp:
            stage = Path(temp) / skill['id']
            stage.mkdir()
            for rel, content in files.items():
                path = stage / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                path.chmod(0o600)
            if target.exists() or target.is_symlink():
                fail('ALREADY_EXISTS', '目标路径已出现，保留原内容')
            stage.rename(target)
        actual = {p.relative_to(target).as_posix(): p.read_bytes() for p in target.rglob('*') if p.is_file()}
        if actual != files:
            fail('INSTALL_READBACK', '文件安装后读回不一致，尚未确认成功，请保留现场')
        return 'installed', str(target)
    finally:
        lock.unlink()


def activate(home,skill_id,args):
    if not ID.fullmatch(skill_id):fail('INVALID_SKILL_ID','技能标识无效')
    script=Path(__file__).with_name('activate.py')
    command=[sys.executable,'-B',str(script),skill_id]
    if args.hermes_root:command+=['--hermes-root',args.hermes_root]
    if args.platform:command+=['--platform',args.platform]
    environment=dict(os.environ,HERMES_HOME=str(home),PYTHONDONTWRITEBYTECODE='1')
    run=subprocess.run(command,env=environment,capture_output=True,text=True)
    try:return json.loads(run.stdout.strip().splitlines()[-1])
    except Exception:return {'ok':False,'code':'ACTIVATION_FAILED','message':'无法确认当前 Hermes 启用结果'}


def main(argv=None):
    parser = argparse.ArgumentParser(description='查询、下载、安装启用诺拉技能；不执行技能任务、不覆盖已有自定义')
    parser.add_argument('--local-test', metavar='LOOPBACK_BASE', help='显式本地测试源，例如 http://127.0.0.1:8776/skills/')
    subs = parser.add_subparsers(dest='action', required=True)
    subs.add_parser('list')
    search = subs.add_parser('search'); search.add_argument('query')
    info = subs.add_parser('info'); info.add_argument('id')
    download = subs.add_parser('download'); download.add_argument('id'); download.add_argument('--output-dir', required=True)
    put = subs.add_parser('install'); put.add_argument('id'); put.add_argument('--confirm', action='store_true'); put.add_argument('--hermes-home'); put.add_argument('--files-only',action='store_true'); put.add_argument('--hermes-root'); put.add_argument('--platform')
    enable=subs.add_parser('enable'); enable.add_argument('id'); enable.add_argument('--confirm',action='store_true'); enable.add_argument('--hermes-home'); enable.add_argument('--hermes-root'); enable.add_argument('--platform')
    args = parser.parse_args(argv)
    try:
        if args.action in ('install','enable') and not args.confirm:
            fail('AUTHORIZATION_REQUIRED', '仅在用户明确要求安装或启用时使用 --confirm')
        home = home_path(args.hermes_home) if args.action in ('install','enable') else None
        client = Client(args.local_test)
        if args.action=='enable':return activate(home,args.id,args)
        catalogue, source = client.catalogue()
        if args.action in ('list','search'):
            if args.action=='search':
                query=args.query.strip().casefold()
                catalogue['skills']=[s for s in catalogue['skills'] if query in ' '.join(str(s.get(k,'')) for k in ('id','title','description','requirement')).casefold()]
            return {'ok': True, 'mode': 'local-test' if client.local else 'official', 'catalogue_source': source, 'skills': [{k: s.get(k) for k in ('id', 'title', 'version', 'delivery', 'description')} for s in catalogue['skills']]}
        skill = next((s for s in catalogue['skills'] if s['id'] == args.id), None)
        if not skill:
            fail('NOT_FOUND', '目录中没有该技能')
        if args.action == 'info':
            return {'ok': True, 'catalogue_source': source, 'skill': skill}
        if skill['delivery'] != 'download':
            fail('BUNDLED_SKILL', '此项目技能没有独立下载包，请核对当前安装')
        data, url, attempts = client.package(skill)
        common = {'ok': True, 'id': skill['id'], 'version': skill['version'], 'catalogue_source': source, 'package_source': url, 'sha256': skill['package']['sha256'], 'source_attempts': attempts, 'mode': 'local-test' if client.local else 'official', 'requirement': skill.get('requirement', '')}
        if args.action == 'download':
            directory = Path(args.output_dir).expanduser().resolve(); directory.mkdir(parents=True, exist_ok=True)
            target = directory / skill['package']['filename']
            if target.exists() or target.is_symlink():
                if not target.is_symlink() and target.is_file() and target.read_bytes() == data:
                    return dict(common, status='already-downloaded', path=str(target))
                fail('OUTPUT_EXISTS', '下载目标已存在不同内容，未覆盖')
            with target.open('xb') as handle:
                handle.write(data)
            return dict(common, status='downloaded', path=str(target))
        status, target = install(home, skill, data)
        if args.files_only:return dict(common,status=status,path=target,enabled=False,loaded=False,note='仅安装文件，未启用')
        activation=activate(home,skill['id'],args)
        if not activation.get('ok'):return dict(common,ok=False,status='installed_not_enabled',path=target,activation=activation)
        return dict(common,status=status,path=target,enabled=True,activation=activation,loaded=False,note='已核对 Hermes 可见与可读取；诺拉会话仍需 skill_view 加载，未执行技能任务')
    except Failure as error:
        return {'ok': False, 'code': error.code, 'message': error.message}
    except (ValueError,KeyError) as error:
        return {'ok':False,'code':'INVALID_DATA','message':'输入数据无效'}
    except OSError as error:
        return {'ok': False, 'code': 'FILESYSTEM_ERROR', 'message': '文件操作失败：' + (error.strerror or type(error).__name__)}


if __name__ == '__main__':
    result = main()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result['ok'] else 1)
