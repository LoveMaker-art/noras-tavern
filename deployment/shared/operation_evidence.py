"""Freeze reviewed operation evidence outside trees that rollback may replace."""
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import traceback
import uuid

_spec = importlib.util.spec_from_file_location('_operation_error_diagnostics', Path(__file__).with_name('error_diagnostics.py'))
_diagnostics = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_diagnostics)
_BUDGET = json.loads(Path(__file__).with_name('operation-budget.json').read_text(encoding='utf-8'))
MAX_BYTES = _BUDGET['pythonBytes']
MAX_RETAINED_BYTES = _BUDGET['globalBytes']
HISTORY_CAPACITY = _BUDGET['historyCapacity'] + _BUDGET['stopReserve']
ACK_CAPACITY = _BUDGET['ackCapacity']
EVIDENCE_FILES = ('metadata.json', 'events.jsonl', 'python.json')


class EvidenceCapacityError(ValueError):
    code = 'CAPACITY'


def operation_directory(nora_home, *, operation_id=None, installer_directory=None, install_root=None):
    value = operation_id or os.environ.get('NORA_OPERATION_ID') or str(uuid.uuid4())
    if not isinstance(value, str) or not re.fullmatch(r'[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}', value):
        raise ValueError('操作标识不是有效 UUID')
    root = Path(installer_directory or os.environ.get('NORA_INSTALLER_DIRECTORY') or Path(nora_home) / 'installer').absolute()
    if install_root is not None and root.resolve().is_relative_to(Path(install_root).resolve()):
        raise ValueError('操作记录必须位于安装恢复目录之外')
    target = root / 'operations' / value
    current = root
    if current.is_symlink(): raise ValueError('操作记录目录不能是链接')
    for part in ('operations', value):
        current /= part
        if current.is_symlink(): raise ValueError('操作记录目录不能是链接')
    return value, target


def _text(value):
    text = str(value or '')
    if re.search(r'\b(?:chat|conversation|config|response|prompt|content|messages)\b|聊天|模型回复', text, re.I):
        return '[CONTENT OMITTED]'
    text = re.sub(r'(?:https?|wss?)://[^\s"\'<>]+', '[URL]', text, flags=re.I)
    text = re.sub(r'\b(?:Bearer|Basic)\s+[^\s"\'<>]+', '[AUTH]', text, flags=re.I)
    text = re.sub(r'((?:api[_-]?key|token|secret|password|authorization|cookie)["\']?\s*[:=]\s*)(?:"[^\"]*"|\'[^\']*\'|[^\s,;}]+)', r'\1[REDACTED]', text, flags=re.I)
    text = re.sub(r'\b(?:sk-|ghp_|gho_)[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32,}', '[OPAQUE]', text)
    text = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[EMAIL]', text)
    return re.sub(r'(?:[A-Za-z]:[\\/]|/)(?:[^\s"\'<>),;]+)', '[PATH]', text)[:2000]


def _safe_detail(error):
    detail = _diagnostics.exception_diagnostic(error)
    def clean(node):
        if not node: return
        original = node['message']
        node['message'] = _text(original)
        if node['message'] != original:
            reason = 'sensitive_content_omitted' if node['message'] == '[CONTENT OMITTED]' else 'sensitive_fields_omitted'
            node['missingReasons'] = list(dict.fromkeys([*node.get('missingReasons', ()), reason]))
        clean(node.get('cause'))
        for item in node.get('secondaryErrors', []): clean(item['error'])
    clean(detail)
    return detail


def _atomic(path, value, *, evidence_permissions=True):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or path.is_symlink(): raise ValueError('证据目录不能是链接')
    for directory in ((path.parent, path.parent.parent, path.parent.parent.parent) if evidence_permissions else (path.parent,)):
        os.chmod(directory, 0o700)
    encoded = json.dumps(value, ensure_ascii=False).encode('utf-8')
    if len(encoded) > MAX_BYTES: raise EvidenceCapacityError('操作证据超过安全容量')
    fd, temporary = tempfile.mkstemp(prefix='.python-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(encoded); stream.flush(); os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        if os.name != 'nt':
            directory = os.open(path.parent, os.O_RDONLY)
            try: os.fsync(directory)
            finally: os.close(directory)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def _capacity(path, value):
    """Stat reviewed evidence only; never remove journals, backups or pending work.

    The native owner serializes data actors. Independent ACKs own only a bounded
    sibling, whose complete space is reserved here before accepting data.
    """
    size = len(json.dumps(value, ensure_ascii=False).encode('utf-8'))
    if size > MAX_BYTES: raise EvidenceCapacityError('操作证据超过安全容量')
    total = 0
    operations = path.parents[2]
    if operations.exists():
        entries = [entry for entry in operations.iterdir() if re.fullmatch(r'[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}', entry.name)]
        prospective = len(entries) + (0 if any(entry.name == path.parents[1].name for entry in entries) else 1)
        if prospective > HISTORY_CAPACITY: raise EvidenceCapacityError('操作证据历史超过安全容量')
        for operation in entries:
            if operation.is_symlink(): raise ValueError('操作目录不能是链接')
            if not operation.is_dir(): continue
            evidence = operation / 'evidence'
            if evidence.is_symlink(): raise ValueError('证据目录不能是链接')
            for name in EVIDENCE_FILES:
                file = evidence / name
                try: details = file.lstat()
                except FileNotFoundError: continue
                if not stat.S_ISREG(details.st_mode): raise ValueError('证据文件不是受管普通文件')
                maximum = MAX_BYTES if name == 'python.json' else _BUDGET['evidenceBytes']
                if details.st_size > maximum: raise EvidenceCapacityError('现存操作证据超过安全容量')
                if file != path: total += details.st_size
    if total + size > MAX_RETAINED_BYTES - HISTORY_CAPACITY * ACK_CAPACITY:
        raise EvidenceCapacityError('保留的操作证据超过安全容量')


def _persist(path, value):
    marker = path.parents[2] / '.evidence-generation.json'
    _atomic(marker, {'schema': 1, 'id': str(uuid.uuid4()), 'writing': True}, evidence_permissions=False)
    failure = None
    try:
        _capacity(path, value)
        _atomic(path, value)
    except (OSError, ValueError, TypeError) as error:
        failure = error
    try:
        _atomic(marker, {'schema': 1, 'id': str(uuid.uuid4()), 'writing': False}, evidence_permissions=False)
    except (OSError, ValueError, TypeError):
        if failure is None: raise
        # Keep the first persistence failure. A writing marker also forces
        # readers to recount rather than trusting a stale capacity cache.
    if failure is not None: raise failure


def _validate_record(record, identity):
    """Treat a saved file as a protocol projection, never arbitrary JSON."""
    if not isinstance(record, dict) or set(record) - {'schema', 'operationId', 'outcome', 'primary',
            'secondaryErrors', 'missingReasons', 'truncated', 'context'}:
        raise ValueError('证据记录字段不受支持')
    if record.get('schema') != 1 or record.get('operationId') != identity or record.get('outcome') != 'failed':
        raise ValueError('证据身份不一致')
    count = 0
    def context(value):
        if not isinstance(value, dict) or set(value) - {'stage', 'pid', 'port', 'exitCode', 'loopback'}:
            raise ValueError('证据技术上下文无效')
        for key, item in value.items():
            if key == 'stage' and item not in ('native_start', 'first_install', 'update_apply', 'restoring'):
                raise ValueError('证据阶段无效')
            if key in ('pid', 'port', 'exitCode') and type(item) is not int: raise ValueError('证据数值无效')
            if key == 'loopback' and type(item) is not bool: raise ValueError('证据地址类型无效')
    def reasons(value):
        if not isinstance(value, list) or len(value) > 16 or any(not isinstance(item, str) or
                not re.fullmatch(r'[a-z_]+(?::[A-Z_]+)?', item) for item in value): raise ValueError('证据缺失标记无效')
    def secondaries(value):
        if not isinstance(value, list): raise ValueError('证据次因格式无效')
        for item in value:
            if not isinstance(item, dict) or set(item) != {'error'}: raise ValueError('证据次因字段无效')
            node(item['error'])
    def node(value):
        nonlocal count
        count += 1
        if count > 4 or not isinstance(value, dict) or set(value) - {'name', 'message', 'code', 'stack',
                'cause', 'secondaryErrors', 'context', 'missingReasons', 'truncated'}: raise ValueError('证据错误字段无效')
        if not isinstance(value.get('name'), str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', value['name']):
            raise ValueError('证据错误类型无效')
        message = value.get('message')
        if not isinstance(message, str) or len(message) > 2000 or _text(message) != message: raise ValueError('证据消息未经审查')
        code = value.get('code')
        if code is not None and not (type(code) is int or isinstance(code, str) and re.fullmatch(r'[A-Z0-9_]{1,64}', code)):
            raise ValueError('证据代码无效')
        stack = value.get('stack')
        if not isinstance(stack, str) or len(stack.splitlines()) > 12 or any(not re.fullmatch(
            r'File "[A-Za-z0-9_.-]{1,120}\.(?:py|js|cjs|mjs)", line [0-9]{1,7}, in [A-Za-z_<>][A-Za-z0-9_<>.]{0,119}', line)
            for line in stack.splitlines()): raise ValueError('证据位置无效')
        if 'context' in value: context(value['context'])
        if 'missingReasons' in value: reasons(value['missingReasons'])
        if 'truncated' in value and type(value['truncated']) is not bool: raise ValueError('证据裁剪标记无效')
        if 'cause' in value: node(value['cause'])
        if 'secondaryErrors' in value: secondaries(value['secondaryErrors'])
    reasons(record.get('missingReasons'))
    if type(record.get('truncated')) is not bool: raise ValueError('证据裁剪标记无效')
    node(record.get('primary'))
    if 'secondaryErrors' in record: secondaries(record['secondaryErrors'])
    if 'context' in record: context(record['context'])
    return record


def freeze(error, *, nora_home, operation_id=None, installer_directory=None, install_root=None, context=None):
    current = _safe_detail(error)
    record = {'schema': 1, 'operationId': operation_id or os.environ.get('NORA_OPERATION_ID') or str(uuid.uuid4()),
              'outcome': 'failed', 'primary': current, 'missingReasons': [], 'truncated': False}
    path = None
    try:
        identity, directory = operation_directory(nora_home, operation_id=record['operationId'],
            installer_directory=installer_directory, install_root=install_root)
        record['operationId'] = identity
        path = directory / 'evidence/python.json'
        if path.parent.is_symlink(): raise ValueError('证据目录不能是链接')
        if path.is_file():
            if path.is_symlink() or path.stat().st_size > MAX_BYTES: raise ValueError('证据文件不是有效记录')
            saved = json.loads(path.read_text(encoding='utf-8'))
            record = _validate_record(saved, identity)
        def nodes(node):
            if not node: return []
            return [node, *nodes(node.get('cause')), *[entry for item in node.get('secondaryErrors', []) for entry in nodes(item['error'])]]
        existing = nodes(record['primary']) + [node for item in record.get('secondaryErrors', []) for node in nodes(item['error'])]
        candidates = [item['error'] for item in current.get('secondaryErrors', [])]
        if any(current.get(key) != record['primary'].get(key) for key in ('name', 'message', 'code')): candidates.insert(0, current)
        for candidate in candidates:
            if any(json.dumps(candidate, sort_keys=True) == json.dumps(saved, sort_keys=True) for saved in existing): continue
            available = 4 - len(existing)
            if available <= 0:
                record['truncated'] = True; break
            def bounded(node):
                nonlocal available
                if available <= 0: record['truncated'] = True; return None
                available -= 1
                value = {key: item for key, item in node.items() if key not in ('cause', 'secondaryErrors')}
                if node.get('cause'):
                    cause = bounded(node['cause'])
                    if cause: value['cause'] = cause
                return value
            value = bounded(candidate)
            record.setdefault('secondaryErrors', []).append({'error': value})
            existing.extend(nodes(value))
        for node in [*existing, *nodes(current)]:
            for reason in node.get('missingReasons', []):
                if reason not in record['missingReasons']: record['missingReasons'].append(reason)
        if len(record['missingReasons']) > 16:
            record['missingReasons'] = record['missingReasons'][:16]; record['truncated'] = True
        if context and not record.get('context'):
            record['context'] = {key: value for key, value in context.items()
                if key in ('stage',) and value in ('first_install', 'update_apply', 'restoring')}
        record['truncated'] |= record['primary'].get('truncated', False) is True
        _persist(path, record)
    except (OSError, ValueError, TypeError) as saving:
        code = getattr(saving, 'errno', None)
        import errno
        name = 'CAPACITY' if isinstance(saving, EvidenceCapacityError) else errno.errorcode.get(code, 'UNKNOWN')
        reason = 'save_failed:' + name
        record['missingReasons'].append(reason)
        missing = list(getattr(error, '_diagnostic_missing', ()))
        error._diagnostic_missing = list(dict.fromkeys([*missing, reason]))
        secondary = RuntimeError('操作证据保存未完成。')
        secondary.code = name if name != 'UNKNOWN' else None
        secondary._bridge_diagnostic_stack = [traceback.FrameSummary(frame.f_code.co_filename, line,
            frame.f_code.co_name, lookup_line=False) for frame, line in traceback.walk_tb(saving.__traceback__)]
        error.secondary_errors = [*getattr(error, 'secondary_errors', ()), secondary]
    return {**record, 'path': str(path) if path else ''}
