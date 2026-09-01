"""Existing-app integration. Queries fail closed; updating never creates Apps.

Liveware's installed CLI exposes backend mode, but not a tunnel's local URL.
Consequently an acknowledged bind is NOT independently observed routing and we
cannot automatically restore an unknown prior binding. This limitation remains
explicit in receipts instead of inventing a tunnel-status endpoint.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urlsplit

ROLES = {'console': ('Tavern', ''), 'actor': ('Story Profile', '/_liveware/story-profile')}
CLAWNEST_LIVEWARE = Path('/opt/clawnest/bin/liveware')
MAX_HTML = 2 * 1024 * 1024
MAX_GATEWAY_ERROR = 64 * 1024


def rows(value, key=None):
    if key:
        value = value.get(key) if isinstance(value, dict) else None
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise ValueError('Platform query failed or returned an unsupported schema')
    return value


def launcher_record(value):
    return {key: value[key] for key in ('app_id', 'name', 'url')} if value is not None else None


class PlatformError(ValueError):
    def __init__(self, code, message):
        self.code = 'LIVEWARE_' + code
        super().__init__(self.code + ': ' + message)


def command_error(output, operation):
    # Classify internally; never expose CLI responses, tokens or argv values.
    if re.search(r'\b(unauthorized|unauthenticated|forbidden|invalid token|token expired|not logged in|please log in|please login)\b|\bHTTP\s*(401|403)\b', output, re.I):
        return PlatformError('AUTH', operation + ' 鉴权失败；需要目标机器的 Liveware 登录。')
    if re.search(r'time[ -]?out|timed out|deadline exceeded', output, re.I):
        return PlatformError('TIMEOUT', operation + ' 请求超时；没有自动重试。')
    return PlatformError('COMMAND', operation + ' 执行失败；请检查目标机器的 Liveware 连接。')


def resolve_binary(home):
    """Support PATH installs, ClawNest's bundled CLI and the plugin download.

    Hermes' login shell may remove ClawNest from PATH. An explicit override is
    authoritative; an invalid override must not silently select another install.
    """
    configured = os.environ.get('LIVEWARE_BIN')
    candidates = [shutil.which(configured) or configured] if configured else [
        shutil.which('liveware'), CLAWNEST_LIVEWARE, Path(home) / 'clawchat/liveware/liveware']
    checked = []
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate).absolute()
        checked.append(str(path))
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
        if configured and path.is_file():
            raise PlatformError('PERMISSION', 'Liveware 文件没有执行权限：' + str(path))
    raise PlatformError('UNAVAILABLE', '未找到可执行的 Liveware；已检查：' + ', '.join(checked))


class Platform:
    def __init__(self, home):
        self.home = Path(home)
        self._binary = None
        self.plugin = Path(os.environ.get('CLAWCHAT_PLUGIN_DIR') or self.home / 'plugins/clawchat')

    @property
    def binary(self):
        # Offline/isolated updates and unconfigured installations need no CLI.
        if self._binary is None:
            self._binary = resolve_binary(self.home)
        return self._binary

    def environment(self, *, login=False):
        """Resolve credentials for this installation, not the agent's shell HOME.

        Re-read after login. Credentials stay in child environments only and are
        never serialized into a plan, receipt, command line or release artifact.
        """
        from update import safe
        env = {**os.environ, 'HOME': str(self.home), 'HERMES_HOME': str(self.home)}
        # The official plugin resolves its own bare `liveware` command. Both
        # callers must see the selected installation even after a login shell
        # reset PATH. Only child environments change; no shell profiles are edited.
        directory = str(Path(self.binary).parent)
        entries = [p for p in env.get('PATH', '').split(os.pathsep) if p and p != directory]
        env['PATH'] = os.pathsep.join([directory, *entries])
        env['LIVEWARE_BIN'] = self.binary
        path = safe(self.home / '.clawling/liveware.json')
        if path.exists():
            try:
                with path.open('rb') as stream:
                    raw = stream.read(65537)
                if len(raw) > 65536:
                    raise ValueError('size')
                saved = json.loads(raw)
                if not isinstance(saved, dict) or not saved.get('token'):
                    raise ValueError('token')
                for key in ('token', 'apiUrl', 'instanceId'):
                    if key in saved and (not isinstance(saved[key], str) or any(ord(c) < 32 for c in saved[key])):
                        raise ValueError('field')
            except (OSError, ValueError):
                raise PlatformError('CREDENTIALS', '目标机器 Liveware 凭证文件不可用；未覆盖该文件。') from None
            for key in ('LIVEWARE_TOKEN', 'LIVEWARE_API_URL', 'LIVEWARE_CONTROL_URL', 'LIVEWARE_INSTANCE_ID'):
                env.pop(key, None)
            for key, field in (('LIVEWARE_TOKEN', 'token'), ('LIVEWARE_API_URL', 'apiUrl'), ('LIVEWARE_INSTANCE_ID', 'instanceId')):
                if saved.get(field):
                    env[key] = saved[field]
        if login:
            # The official plugin supplies ClawChat's access token itself.
            env.pop('LIVEWARE_TOKEN', None)
        return env

    def run(self, command, operation, *, login=False, **kwargs):
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=45,
                                    env=self.environment(login=login), **kwargs)
        except subprocess.TimeoutExpired:
            raise PlatformError('TIMEOUT', operation + ' 请求超时；没有自动重试。') from None
        except OSError as error:
            code = 'PERMISSION' if isinstance(error, PermissionError) else 'UNAVAILABLE'
            # Preserve OS diagnostics, not subprocess output or secret arguments.
            raise PlatformError(code, operation + ' 无法启动 ' + str(command[0])
                                + '; errno=' + str(error.errno) + ' (' + str(error.strerror) + ')') from None
        if result.returncode:
            raise command_error(result.stderr + '\n' + result.stdout, operation)
        return result.stdout

    def query(self, output, operation):
        try:
            return json.loads(output)
        except ValueError:
            error = command_error(output, operation)
            if error.code == 'LIVEWARE_COMMAND':
                error = PlatformError('PROTOCOL', operation + ' 返回了不支持的数据；未按空列表处理。')
            raise error from None

    def cli(self, *args):
        return self.run([self.binary, *args], ' '.join(args[:2]))

    def apps(self):
        return rows(self.query(self.cli('app', 'list', '--json'), 'app list'))

    def backends(self, app_id):
        return rows(self.query(self.cli('backend', 'list', app_id, '--json'), 'backend list'))

    def launcher(self, operation, **parameters):
        if operation not in ('list_apps', 'register_app', 'unregister_app', 'liveware_login'):
            raise ValueError('Unsupported launcher operation')
        code = ('import asyncio,json,sys; sys.path.insert(0,sys.argv[1]); '
                'from clawchat_gateway import tools; '
                'print(json.dumps(asyncio.run(getattr(tools,sys.argv[2])(**json.load(sys.stdin)))))')
        output = self.run([sys.executable, '-B', '-c', code, str(self.plugin), operation], operation,
                          input=json.dumps(parameters), login=operation == 'liveware_login')
        value = self.query(output, operation)
        if not isinstance(value, dict) or value.get('error') or value.get('ok') is False or value.get('success') is False:
            raise command_error(json.dumps(value), operation)
        if operation == 'liveware_login' and value.get('ok') is not True:
            raise PlatformError('PROTOCOL', 'Liveware 登录未返回成功确认。')
        return value

    def registrations(self):
        return rows(self.launcher('list_apps'), 'apps')

    def bind(self, app_id, target):
        self.cli('tunnel', 'bind', app_id, target)


class Metadata(HTMLParser):
    icon = None
    application = None
    title = ''
    in_title = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'title':
            self.in_title = True
        if tag == 'meta' and values.get('name') == 'application-name':
            self.application = values.get('content')
        if tag == 'link' and 'icon' in values.get('rel', '').split():
            self.icon = values.get('href')

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False

    def handle_data(self, value):
        if self.in_title:
            self.title += value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_a, **_kw):
        return None


def direct_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def prepare_update(home, *, allow_login=False, isolated=False):
    """Restore legacy login preparation BEFORE review/maintenance, at most once.

    Review is read-only. Only an explicitly confirmed update may refresh login;
    no binding, registration, creation or failed update is automatically replayed.
    """
    if isolated:
        from clean_update import require_isolation
        require_isolation(Path(home))
        return
    from update import safe
    if not safe(Path(home) / 'tavern-state/apps.json').exists():
        return
    platform = Platform(home)
    try:
        platform.apps()
    except PlatformError as error:
        if error.code != 'LIVEWARE_AUTH' or not allow_login:
            raise
        from feedback import phase
        with phase('liveware-login', '通过目标机器 ClawChat 插件准备 Liveware 登录'):
            platform.launcher('liveware_login')
            platform.apps()


def identities(home, platform):
    from update import safe
    document = json.loads(safe(Path(home) / 'tavern-state/apps.json').read_text())
    available = platform.apps()  # Failure must never become an empty list.
    result = {}
    for role in ROLES:
        saved = document.get(role, {})
        app_id, domain = saved.get('app_id'), saved.get('domain')
        if not isinstance(app_id, str) or not re.fullmatch(r'app-[A-Za-z0-9-]+', app_id):
            raise ValueError('Missing or invalid existing App identity: ' + role)
        matches = [a for a in available if a.get('appId') == app_id and a.get('status') == 'active']
        if len(matches) != 1 or matches[0].get('domain') != domain:
            raise ValueError('Existing App is missing, inactive, ambiguous or changed: ' + role)
        if not isinstance(domain, str) or not re.fullmatch(r'[A-Za-z0-9.-]+\.apps\.clawling\.io', domain):
            raise ValueError('Unsupported App domain: ' + role)
        result[role] = {'app_id': app_id, 'domain': domain}
    if result['console']['app_id'] == result['actor']['app_id']:
        raise ValueError('Tavern and Story Profile must use distinct App IDs')
    return result


def registrations(platform, ids):
    listed = platform.registrations()
    result = {}
    for role, app in ids.items():
        matching = [r for r in listed if r.get('app_id') == app['app_id']]
        if len(matching) > 1:
            raise ValueError('Duplicate launcher registrations: ' + role)
        result[role] = launcher_record(matching[0]) if matching else None
    return result


class Integration:
    def __init__(self, home, *, port=8799, platform=None, isolated=False):
        self.home, self.port = Path(home), port
        self.platform = platform or Platform(home)
        self.isolated = isolated

    def review(self, *, allow_unbound=False):
        if self.isolated:
            return {'status': 'isolated-not-connected'}
        if not (self.home / 'tavern-state/apps.json').exists():
            return {'status': 'not-configured'}
        ids = identities(self.home, self.platform)
        registered = registrations(self.platform, ids)
        backends = {}
        for role, app in ids.items():
            value = self.platform.backends(app['app_id'])
            if allow_unbound and not value:
                backends[role] = None
                continue
            if len(value) != 1 or value[0].get('mode') != 'tunnel' or value[0].get('route') != '/*':
                raise ValueError('Only a single existing root tunnel is supported: ' + role)
            backends[role] = {key: value[0].get(key) for key in ('mode', 'route', 'targetUrl', 'upstreamId')}
        return {'status': 'reviewed', 'apps': ids, 'registrations': registered, 'backends': backends,
                'priorTunnelTarget': 'not-exposed-by-cli', 'allowUnbound': allow_unbound}

    def check(self, reviewed):
        if self.review(allow_unbound=reviewed.get('allowUnbound', False)) != reviewed:
            raise ValueError('Liveware identities, backend or registrations changed since review')

    def apply(self, reviewed, journal, save, *, refresh=False):
        if reviewed['status'] != 'reviewed':
            return {'status': reviewed['status'], 'externalEntryVerified': False}
        self.check(reviewed)
        journal.update(status='applying', before=reviewed, actions=[])
        save()
        pending = []
        for role in ROLES:
            app = reviewed['apps'][role]
            title, prefix = ROLES[role]
            target = f'http://127.0.0.1:{self.port}' + prefix
            # Check role-specific local metadata and the actual icon BEFORE any
            # remote mutation. App ownership was already checked for both roles.
            local_entry(target + '/', title)
        for role in ROLES:
            app = reviewed['apps'][role]
            title, prefix = ROLES[role]
            action = {'role': role, 'kind': 'bind', 'status': 'intent'}
            journal['actions'].append(action)
            save()
            self.platform.bind(app['app_id'], f'http://127.0.0.1:{self.port}' + prefix)
            backend = self.platform.backends(app['app_id'])
            if len(backend) != 1 or backend[0].get('mode') != 'tunnel' or backend[0].get('route') != '/*':
                raise ValueError('Tunnel mode not confirmed after binding: ' + role)
            action['status'] = 'acknowledged'
            save()
            desired = {'app_id': app['app_id'], 'name': title, 'url': 'https://' + app['domain'] + '/'}
            current = registrations(self.platform, reviewed['apps'])[role]
            if current != reviewed['registrations'][role]:
                raise ValueError('Launcher changed during update: ' + role)
            if current != desired or refresh:
                action = {'role': role, 'kind': 'registration', 'before': current, 'after': desired, 'status': 'intent'}
                journal['actions'].append(action)
                save()
                if current:
                    self.platform.launcher('unregister_app', app_id=app['app_id'])
                # If a write times out, stop. Recovery queries the actual state;
                # it never blindly repeats an uncertain registration request.
                self.platform.launcher('register_app', **desired)
                if registrations(self.platform, reviewed['apps'])[role] != desired:
                    raise ValueError('Launcher metadata did not converge: ' + role)
                action['status'] = 'verified'
                save()
            action = {'role': role, 'kind': 'external-entry', 'url': desired['url'], 'status': 'intent'}
            journal['actions'].append(action)
            save()
            try:
                action['evidence'] = public_entry(desired['url'], title)
                action['status'] = 'verified'
            except (ValueError, OSError):
                # Public transport/authentication is an independent observation,
                # not grounds to undo healthy binaries and verified App IDs.
                action['status'] = 'unverified'
                pending.append({'role': role, 'reason': 'Public entry could not be verified; check ClawChat access and network'})
            save()
        journal['status'] = 'external-entry-unverified' if pending else 'external-entry-verified'
        save()
        return {'status': journal['status'], 'localEntriesVerified': True, 'launcherMetadataVerified': True,
                'externalEntryVerified': not pending, 'pending': pending}

    def recover(self, journal, save):
        if not journal.get('actions'):
            return True
        before = journal['before']
        if identities(self.home, self.platform) != before['apps']:
            raise ValueError('App identities changed; external recovery refused')
        pending = False
        for action in reversed(journal['actions']):
            if action.get('status') == 'restored':
                continue
            if action['kind'] == 'bind':
                # No public getter for original upstream: do not guess one or
                # overwrite a possible concurrent operator binding.
                pending = True
                continue
            if action['kind'] == 'external-entry':
                action['status'] = 'restored'
                save()
                continue
            role = action['role']
            actual = registrations(self.platform, before['apps'])[role]
            if actual not in (None, action['before'], action['after']):
                raise ValueError('Concurrent launcher edit; external recovery refused: ' + role)
            if actual != action['before']:
                app_id = before['apps'][role]['app_id']
                if actual:
                    self.platform.launcher('unregister_app', app_id=app_id)
                if action['before']:
                    self.platform.launcher('register_app', **action['before'])
                if registrations(self.platform, before['apps'])[role] != action['before']:
                    raise ValueError('Launcher restoration could not be verified: ' + role)
            action['status'] = 'restored'
            save()
        journal['status'] = 'integration-pending' if pending else 'restored'
        save()
        return not pending


def local_entry(url, title):
    """Only loopback HTTP, no proxy/redirect, capped HTML and image reads."""
    opener = direct_opener()
    def read(address, maximum):
        with opener.open(address, timeout=10) as response:
            value = response.read(maximum + 1)
            if response.status != 200 or len(value) > maximum:
                raise ValueError('Local entry response is invalid')
            return value
    metadata = Metadata()
    metadata.feed(read(url, 2 * 1024 * 1024).decode('utf-8'))
    if metadata.title.strip() != title or (metadata.application and metadata.application != title) or not metadata.icon or not re.fullmatch(r'/[A-Za-z0-9_./-]+\.png', metadata.icon):
        raise ValueError('Local entry metadata differs from release: ' + title)
    from urllib.parse import urlsplit
    origin = urlsplit(url)
    icon = read(origin.scheme + '://' + origin.netloc + metadata.icon, 8 * 1024 * 1024)
    if not icon.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('Local entry icon is not a PNG: ' + title)


def public_entry(url, title):
    """Verify the public Liveware route reaches either the app or ClawChat gate."""
    origin = urlsplit(url)
    if origin.scheme != 'https' or origin.path not in ('', '/') or origin.query or origin.fragment:
        raise ValueError('Unsupported public Liveware entry URL: ' + title)
    if not re.fullmatch(r'[A-Za-z0-9.-]+\.apps\.clawling\.io', origin.netloc):
        raise ValueError('Unsupported public Liveware entry domain: ' + title)
    request = urllib.request.Request(url, headers={
        'Accept': 'text/html,application/json',
        'User-Agent': 'tavern-updater/2 liveware-public-entry-check',
    })
    try:
        with direct_opener().open(request, timeout=15) as response:
            status = response.status
            content_type = response.headers.get_content_type()
            body = response.read(MAX_HTML + 1)
    except urllib.error.HTTPError as response:
        status = response.code
        content_type = response.headers.get_content_type()
        body = response.read(MAX_GATEWAY_ERROR + 1)
    except OSError as error:
        raise ValueError('Public Liveware entry is unreachable: ' + title) from error
    if status == 401:
        text = body[:MAX_GATEWAY_ERROR].decode('utf-8', 'replace').casefold()
        if 'open in clawchat' in text:
            return {'status': 401, 'gate': 'open-in-clawchat'}
        raise ValueError('Public Liveware entry rejected without ClawChat gate: ' + title)
    if status != 200 or len(body) > MAX_HTML or content_type not in ('text/html', 'application/xhtml+xml'):
        raise ValueError('Public Liveware entry is unhealthy: ' + title)
    metadata = Metadata()
    metadata.feed(body.decode('utf-8', 'replace'))
    if metadata.title.strip() != title and metadata.application != title:
        raise ValueError('Public Liveware entry metadata differs from release: ' + title)
    return {'status': 200, 'title': metadata.title.strip() or metadata.application}


def initialize(home, platform):
    """Explicit first-install command only. Never retry uncertain App creation."""
    from update import safe, json_write
    home = Path(home)
    path = safe(home / 'tavern-state/apps.json')
    document = json.loads(path.read_text()) if path.exists() else {}
    intent_path = safe(home / 'tavern-updates-v2/liveware-initialization.json')
    journal = json.loads(intent_path.read_text()) if intent_path.exists() else {}
    available = platform.apps()
    platform.registrations()  # Check authentication/schema before creating anything.
    selected = {}
    for role, (title, _) in ROLES.items():
        saved = document.get(role, {}).get('app_id')
        candidates = [a for a in available if a.get('status') == 'active' and
                      (a.get('appId') == saved if saved else a.get('name', '').casefold() == title.casefold())]
        if len(candidates) > 1 or (saved and len(candidates) != 1):
            raise ValueError('Ambiguous or missing existing App; initialization stopped: ' + role)
        if not candidates and journal.get(role):
            raise ValueError('Previous App creation is uncertain; do not repeat creation: ' + role)
        selected[role] = candidates[0] if candidates else None
    chosen = [a['appId'] for a in selected.values() if a]
    if len(chosen) != len(set(chosen)):
        raise ValueError('Tavern and Story Profile must use distinct App IDs')
    for role, (title, _) in ROLES.items():
        app = selected[role]
        if app is None:
            journal[role] = {'status': 'create-intent', 'name': title}
            json_write(intent_path, journal)
            platform.cli('app', 'create', title, '--agent-type', 'hermes')
            matches = [a for a in platform.apps() if a.get('status') == 'active' and a.get('name') == title]
            if len(matches) != 1:
                raise ValueError('Creation not uniquely confirmed; no automatic retry: ' + role)
            app = matches[0]
        document[role] = {'app_id': app['appId'], 'domain': app['domain'], 'name': title, 'liveware_name': title}
        json_write(path, document)  # Persist each confirmed identity independently.
        journal[role] = {'status': 'resolved', 'app_id': app['appId']}
        json_write(intent_path, journal)
    return identities(home, platform)


def require_idle(home):
    from update import safe
    from update_status import TERMINAL_RECEIPT_STATUSES, has_unrecovered_effects
    for path in (Path(home) / 'tavern-updates-v2').glob('review-*/receipt.json'):
        value = json.loads(safe(path).read_text())
        if (value.get('status') not in TERMINAL_RECEIPT_STATUSES
                and has_unrecovered_effects(value)):
            raise ValueError('Unfinished update requires recovery; startup will not change runtime or Liveware')


def main():
    import argparse
    from update import module_at, json_write, safe
    from runtime_lock import installation_lock
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', required=True, type=Path)
    parser.add_argument('operation', choices=('initialize', 'recover-existing', 'inspect'))
    args = parser.parse_args()
    home = safe(args.home.absolute())
    integration = Integration(home)
    if args.operation == 'inspect':
        print(json.dumps(integration.review(), ensure_ascii=False))
        return
    with installation_lock(home):
        require_idle(home)
        journal_path = safe(home / 'tavern-updates-v2/liveware-recovery.json')
        if journal_path.exists() and json.loads(journal_path.read_text()).get('status') not in ('binding-acknowledged', 'external-entry-verified'):
            raise ValueError('Previous Liveware operation is unfinished; automatic startup retry refused')
        if args.operation == 'initialize':
            initialize(home, integration.platform)
        reviewed = integration.review(allow_unbound=args.operation == 'initialize')
        if reviewed['status'] != 'reviewed':
            raise ValueError('Existing App IDs are required; run explicit initialization first')
        # Recovery starts only the existing local runtime. It never provisions,
        # initializes profiles, synchronizes models, or restarts Hermes.
        app = safe(home / 'apps/tavern-runtime')
        module = module_at('liveware_native_runtime', app / 'native_lifecycle.py')
        contract = module.RuntimeContract.from_dict(json.loads((app / 'native-runtime.json').read_text()))
        module.NativeRuntime(home, app, home / 'tavern-state', contract).start()
        journal = {}
        result = integration.apply(reviewed, journal, lambda: json_write(journal_path, journal))
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        from feedback import public_reason
        print(json.dumps({'ok': False, 'error': public_reason(error), 'noAutomaticRetry': True}), file=sys.stderr)
        raise SystemExit(1)
