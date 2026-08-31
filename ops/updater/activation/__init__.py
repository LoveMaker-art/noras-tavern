"""Durable, transaction-bound consent. No gateway control is exposed to the CLI."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import tempfile
import time

PROTOCOL = 1
PLUGIN = 'tavern-update-activation'
MODULES = ('__init__.py', 'gateway.py')
TERMINAL = {'active', 'cancelled', 'expired', 'superseded', 'failed'}
PROMPT = ('Tavern 和 Story Profile 的文件已安装。回复“确定”将重载 Hermes 的 MCP 连接、刷新技能，'
          '并为当前聊天开启新会话以读取新的 AGENTS；旧聊天记录保留。'
          '这会使相关会话的模型提示缓存失效，但不会重启网关。回复“取消”则稍后激活。'
          '此确认仅本次更新有效，10 分钟后过期；其他回复会取消本次确认。')


def safe(path):
    path = Path(os.path.abspath(path))
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Activation path must not contain symlinks')
    return path


def read(path):
    return json.loads(safe(path).read_text())


def write(path, value):
    path = safe(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix='.activation-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def digest(path):
    return hashlib.sha256(safe(path).read_bytes()).hexdigest()


def implementation(root):
    return {name: digest(root / name) for name in MODULES}


def source_from_env(env):
    keys = ('PLATFORM', 'CHAT_ID', 'USER_ID', 'KEY', 'ID', 'MESSAGE_ID')
    values = {key.lower(): env.get('HERMES_SESSION_' + key, '') for key in keys}
    if not all(values.values()) or values['platform'] != 'clawchat':
        raise ValueError('Request activation in the owner ClawChat conversation, with Hermes session context')
    values['thread_id'] = env.get('HERMES_SESSION_THREAD_ID', '')
    return values


class Activation:
    def __init__(self, home, clock=time.time):
        self.home = safe(home)
        self.root = safe(self.home / 'tavern-updates-v2')
        self.clock = clock

    @contextmanager
    def lock(self):
        # Same lock as apply/rollback: code cannot switch during activation.
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with safe(self.root / 'lock').open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def installed(self):
        value = read(self.root / 'installed.json')
        name = value.get('transaction', '')
        if not name.startswith('review-') or Path(name).name != name:
            raise ValueError('Invalid installed transaction')
        transaction = safe(self.root / name)
        receipt = read(transaction / 'receipt.json')
        plan = read(transaction / 'plan.json')
        expected = hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if (receipt.get('status') != 'installed-awaiting-hermes-reload'
                or value.get('planDigest') != expected or plan.get('testMode')
                or plan.get('home') != str(self.home)
                or value.get('manifestSha256') != plan.get('manifestSha256')):
            raise ValueError('Only the current successfully installed, non-rehearsal transaction can activate')
        return transaction, value, plan

    def current(self):
        transaction, installed, plan = self.installed()
        path = transaction / 'activation.json'
        record = read(path) if path.exists() else None
        if record and any(record.get(k) != installed.get(k) for k in ('transaction', 'manifestSha256', 'planDigest')):
            raise ValueError('Activation belongs to a different installation')
        return path, record, installed, plan

    def peek(self):
        # Cheap hook fast path. Full plan/hash checks occur only on activation actions.
        value = read(self.root / 'installed.json')
        name = value.get('transaction', '')
        if not name.startswith('review-') or Path(name).name != name:
            raise ValueError('Invalid installed transaction')
        path = safe(self.root / name / 'activation.json')
        return read(path) if path.exists() else None

    def verify_files(self, installed, plan):
        import yaml
        config = yaml.safe_load(safe(self.home / 'config.yaml').read_text()) or {}
        plugins = config.get('plugins', {})
        if PLUGIN not in plugins.get('enabled', []) or PLUGIN in plugins.get('disabled', []):
            raise ValueError('Gateway activation plugin is disabled; respect the owner configuration')
        if installed.get('files') != plan['files']:
            raise ValueError('Installed inventory differs from review')
        targets = {'app': self.home / 'apps/tavern-runtime', 'ops': self.home / 'apps/tavern-ops',
                   'nora-mcp': self.home / 'apps/nora-mcp', 'home': self.home}
        for name, expected in plan['files'].items():
            rel = Path(name)
            if rel.is_absolute() or '..' in rel.parts or len(rel.parts) < 2 or rel.parts[0] not in targets:
                raise ValueError('Unsafe activation inventory')
            if digest(targets[rel.parts[0]].joinpath(*rel.parts[1:])) != expected:
                raise ValueError('Installed files changed; review before activating: ' + name)

    def request(self, source):
        with self.lock():
            path, old, installed, plan = self.current()
            self.verify_files(installed, plan)
            try:
                ready = read(self.root / 'activation-gateway.json')
            except FileNotFoundError as error:
                raise ValueError('Gateway activation module is not loaded; owner gateway activation is required once') from error
            expected = implementation(self.home / 'apps/tavern-ops/updater/activation')
            if ready.get('protocol') != PROTOCOL or ready.get('implementation') != expected:
                raise ValueError('Gateway activation module is not loaded at the installed version; owner gateway activation is required once')
            pid = ready.get('pid', 0)
            if not isinstance(pid, int) or pid <= 1:
                raise ValueError('Gateway activation module has no live process')
            os.kill(pid, 0)
            if old and old.get('resetReviewRequired'):
                raise ValueError('Session reset was interrupted; inspect the gateway before any new activation')
            if old and old['status'] in ('queued', 'awaiting-confirmation') and (
                    self.clock() > old['expiresAt'] or old['gatewayInstance'] != ready['instance']):
                old['status'] = 'expired'
                write(path, old)
            if old and old['status'] not in TERMINAL:
                if old['source'] != source:
                    raise ValueError('Activation is already pending in another message/session')
                return old
            if old and old['status'] == 'active':
                return old
            record = {'schema': PROTOCOL, 'requestId': secrets.token_hex(16), 'status': 'queued',
                      'transaction': installed['transaction'], 'manifestSha256': installed['manifestSha256'],
                      'planDigest': installed['planDigest'], 'source': source, 'createdAt': self.clock(),
                      'expiresAt': self.clock() + 600, 'gatewayInstance': ready['instance'], 'notified': False}
            write(path, record)
            return record

    def status(self):
        _, record, _, _ = self.current()
        if not record:
            return {'status': 'not-requested'}
        result = dict(record)
        if result['status'] in ('queued', 'awaiting-confirmation') and self.clock() > result['expiresAt']:
            result['status'] = 'expired'
        if result['status'] in ('activating', 'resetting') and self.clock() > result.get('startedAt', 0) + 180:
            result['status'] = 'interrupted-review-required'
        return result

    def decide(self, record, source, text, *, authorized):
        """Only a new message from the bound owner/session consumes consent."""
        bound = record['source']
        identity = ('platform', 'chat_id', 'user_id', 'thread_id', 'key', 'id')
        if not authorized or any(source.get(k, '') != bound.get(k, '') for k in identity):
            return None
        message = source.get('message_id')
        if not message or message == bound['message_id'] or message == record.get('confirmationMessageId'):
            return None
        if record['status'] != 'awaiting-confirmation':
            return None
        if self.clock() > record['expiresAt']:
            record['status'] = 'expired'
        elif text.strip() == '确定':
            record.update(status='activating', confirmationMessageId=message, startedAt=self.clock())
        else:
            record['status'] = 'cancelled'
        return record['status']


def command(home, operation):
    state = Activation(home)
    if operation == 'request':
        return state.request(source_from_env(os.environ))
    return state.status()
