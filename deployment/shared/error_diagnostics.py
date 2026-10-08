"""Bounded project exception metadata for the installer and updater.

This projection never reads locals, source lines or subprocess streams. The
desktop's existing fault-packet projection applies privacy redaction afterward.
"""
import errno
import json
from pathlib import Path
import re
import subprocess
import traceback
import urllib.error


PROJECT_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_FILES = frozenset({'native_lifecycle.py', 'runtime_process.py', 'runtime_lock.py', 'service_manager.py'})


def exception_from_diagnostic(record):
    """Restore only the formal, reviewed record received from the live guard."""
    try:
        size = len(json.dumps(record, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    except (TypeError, ValueError, UnicodeError, RecursionError) as error:
        raise ValueError('Invalid reviewed diagnostic') from error
    if size > 16 * 1024:
        raise ValueError('Reviewed diagnostic exceeds its budget')
    allowed = {'name', 'message', 'code', 'stack', 'cause', 'secondaryErrors', 'truncated', 'missingReasons'}
    reasons = {'non_project_frames_omitted', 'program_message_unreviewed', 'program_error_missing',
               'launch_log_empty_or_changed', 'launch_log_unavailable', 'unknown_evidence_gap'}
    location = re.compile(r'File "([A-Za-z0-9_.-]{1,120}\.(?:js|cjs|mjs))", line ([1-9][0-9]{0,6}), in ([A-Za-z_<>][A-Za-z0-9_<>.]{0,119})')
    nodes, frames = 0, 0

    def restore(value, *, root=False):
        nonlocal nodes, frames
        nodes += 1
        if (nodes > 4 or not isinstance(value, dict) or not set(value) <= (allowed if root else allowed - {'truncated'})
                or not {'name', 'message', 'code', 'stack'} <= set(value)):
            raise ValueError('Invalid reviewed diagnostic node')
        name, message, code, stack = (value[key] for key in ('name', 'message', 'code', 'stack'))
        if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', name)
                or not isinstance(message, str) or len(message.encode('utf-8')) > 1200
                or '\x00' in message or not isinstance(stack, str)):
            raise ValueError('Invalid reviewed diagnostic fields')
        if code is not None and not (type(code) is int and 100 <= code <= 599
                or isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', code)):
            raise ValueError('Invalid reviewed diagnostic code')
        locations = []
        for line in stack.splitlines():
            match = location.fullmatch(line)
            if match is None:
                raise ValueError('Invalid reviewed diagnostic location')
            filename, lineno, function = match.groups()
            locations.append(traceback.FrameSummary(filename, int(lineno), function, lookup_line=False))
        frames += len(locations)
        if frames > 12:
            raise ValueError('Reviewed diagnostic exceeds its frame budget')
        missing = value.get('missingReasons', [])
        if (not isinstance(missing, list) or len(missing) > 16 or any(not isinstance(reason, str) or len(reason) > 96
                or reason not in reasons for reason in missing)
                or 'truncated' in value and type(value['truncated']) is not bool):
            raise ValueError('Invalid reviewed diagnostic markers')
        secondary = value.get('secondaryErrors', [])
        if (not isinstance(secondary, list) or len(secondary) > 2
                or any(not isinstance(item, dict) or set(item) != {'error'} for item in secondary)):
            raise ValueError('Invalid reviewed diagnostic secondary errors')
        error = RuntimeError(message)
        error._diagnostic_name, error.code = name, code
        error._bridge_diagnostic_stack = locations
        error._diagnostic_missing = missing
        error._diagnostic_truncated = value.get('truncated', False)
        if 'cause' in value:
            error.__cause__ = restore(value['cause'])
        error.secondary_errors = [restore(item['error']) for item in secondary]
        return error

    try:
        return restore(record, root=True)
    except (TypeError, UnicodeError, RecursionError) as error:
        raise ValueError('Invalid reviewed diagnostic') from error


def exception_diagnostic(error, *, project_root=None, stack=None):
    seen = set()
    truncated = False
    root = Path(project_root or PROJECT_ROOT).resolve()

    def locations(current, supplied=None):
        nonlocal truncated
        if supplied is None:
            supplied = getattr(current, '_bridge_diagnostic_stack', None)
        frames = supplied if supplied is not None else (
            traceback.FrameSummary(frame.f_code.co_filename, line, frame.f_code.co_name,
                                   lookup_line=False)
            for frame, line in traceback.walk_tb(current.__traceback__)
        )
        result = []
        for frame in frames:
            if not isinstance(frame, traceback.FrameSummary):
                continue
            filename = Path(frame.filename)
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}\.(?:py|js|cjs|mjs)', filename.name):
                continue
            if supplied is None and not (filename.resolve().is_relative_to(root)
                                         or filename.name in RUNTIME_FILES):
                continue
            if not isinstance(frame.lineno, int) or not 0 < frame.lineno < 10000000:
                continue
            name = frame.name if re.fullmatch(r'[A-Za-z_<>][A-Za-z0-9_<>.]{0,119}', frame.name) else 'operation'
            result.append(f'File "{filename.name}", line {frame.lineno}, in {name}')
        if len(result) > 12:
            truncated = True
        return '\n'.join(result[-12:])

    def project(current, supplied=None):
        nonlocal truncated
        if current is None or id(current) in seen:
            return None
        if len(seen) >= 4:
            truncated = True
            return None
        seen.add(id(current))
        name = getattr(current, '_diagnostic_name', type(current).__name__)
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', name):
            name = type(current).__name__
        code = errno.errorcode.get(current.errno) if isinstance(current, OSError) else getattr(current, 'code', None)
        if code is not None and not (type(code) is int or isinstance(code, str) and re.fullmatch(r'[A-Z0-9_]{1,64}', code)):
            code = None
        if isinstance(current, subprocess.CalledProcessError):
            message = getattr(current, '_bridge_diagnostic_message',
                              f'子进程执行失败，退出码 {current.returncode}。')
        elif isinstance(current, subprocess.TimeoutExpired):
            code, message = 'TIMEOUT', '子进程操作超时。'
        elif isinstance(current, json.JSONDecodeError):
            message = f'JSON 解析失败，行 {current.lineno}，列 {current.colno}。'
        elif isinstance(current, UnicodeError):
            message = '程序文本编码处理失败。'
        elif isinstance(current, urllib.error.HTTPError):
            message = f'服务请求失败，HTTP 状态 {current.code}。'
        elif isinstance(current, urllib.error.URLError):
            message = '服务连接失败。'
        elif name == 'AccessDenied':
            code, message = 'EACCES', '系统拒绝读取进程信息。'
        elif isinstance(current, (RuntimeError, OSError)):
            message = getattr(current, '_bridge_diagnostic_message', str(current))
        else:
            message = f'程序操作失败（{name}）。'
        if len(message) > 2000:
            message = message[:2000]
            truncated = True
        detail = {'name': name, 'message': message, 'code': code, 'stack': locations(current, supplied)}
        context = getattr(current, '_diagnostic_context', None)
        if isinstance(context, dict):
            facts = {}
            for key in ('pid', 'exitCode', 'port'):
                if type(context.get(key)) is int: facts[key] = context[key]
            if type(context.get('loopback')) is bool: facts['loopback'] = context['loopback']
            if context.get('stage') in ('native_start', 'first_install', 'update_apply', 'restoring'): facts['stage'] = context['stage']
            if facts: detail['context'] = facts
        missing = getattr(current, '_diagnostic_missing', ())
        if isinstance(missing, (list, tuple)):
            reasons = [reason for reason in missing if isinstance(reason, str) and re.fullmatch(r'[a-z_]+(?::[A-Z_]+)?', reason)]
            if reasons: detail['missingReasons'] = list(dict.fromkeys(reasons))[:16]
        truncated |= getattr(current, '_diagnostic_truncated', False) is True
        cause = current.__cause__ or (None if current.__suppress_context__ else current.__context__)
        child = project(cause)
        if child:
            detail['cause'] = child
        secondary = []
        for item in getattr(current, 'secondary_errors', []):
            if item is None or id(item) in seen:
                continue
            if len(secondary) >= 2:
                truncated = True
                break
            child = project(item)
            if child:
                secondary.append({'error': child})
        if secondary:
            detail['secondaryErrors'] = secondary
        return detail

    detail = project(error, stack)
    if detail is not None and truncated:
        detail['truncated'] = True
    return detail
