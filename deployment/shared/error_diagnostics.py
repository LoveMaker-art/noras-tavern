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
        name = type(current).__name__
        code = errno.errorcode.get(current.errno) if isinstance(current, OSError) else getattr(current, 'code', None)
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
