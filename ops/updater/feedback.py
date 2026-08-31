"""Terminal feedback only; never retries, changes transaction policy or calls a model."""
from contextlib import contextmanager
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback

PREFIX = '[tavern-updater] '
HEARTBEAT_SECONDS = 10


def emit(value):
    try:
        print(PREFIX + json.dumps(value, ensure_ascii=False), file=sys.stderr, flush=True)
    except OSError:
        pass  # A lost terminal must not interrupt switching or transaction recovery.


@contextmanager
def phase(name, message, *, record=None):
    started = time.monotonic()
    stopped = threading.Event()
    def report(status):
        event = {'event': 'progress', 'phase': name, 'message': message,
                 'status': status, 'elapsedSeconds': round(time.monotonic() - started, 1)}
        if record is not None and status != 'running':
            record(event)
        emit(event)
    def heartbeat():
        while not stopped.wait(HEARTBEAT_SECONDS):
            report('running')
    report('started')
    worker = threading.Thread(target=heartbeat, daemon=True)
    worker.start()
    status = 'completed'
    try:
        yield
    except BaseException as error:
        status = 'failed'
        if not hasattr(error, 'update_phase'):
            error.update_phase = name
        raise
    finally:
        stopped.set()
        worker.join()
        report(status)


def step(name, message, operation, *args, **kwargs):
    with phase(name, message):
        return operation(*args, **kwargs)


def public_reason(error):
    # Subprocess errors can contain command arguments, environment or responses.
    if isinstance(error, subprocess.CalledProcessError):
        return '子进程执行失败，退出码 ' + str(error.returncode) + '；详细输出保存在本机私有日志。'
    text = str(error)
    text = re.sub(r'https?://\S+', '<URL>', text)
    text = re.sub(r'(?i)(bearer\s+|LWT=|(?:api[_-]?key|token|password|secret|authorization)[\s\"\x27]*[:=][\s\"\x27]*)([^\s,;\"\x27}]+)', r'\1<REDACTED>', text)
    text = re.sub(r'\b(?:sk-|ghp_|github_pat_|gsk_)[A-Za-z0-9_-]+', '<REDACTED>', text)
    return ' '.join(text.split())[:1200]


def failure_report(error, transaction=None):
    result = {'event': 'failure', 'ok': False, 'phase': getattr(error, 'update_phase', 'preflight'),
              'error': public_reason(error), 'status': 'unconfirmed',
              'next_step': '本次更新已停止。立即报告原因和恢复状态；等待用户另行同意排查或重试。'}
    if transaction is not None:
        from update import atomic, safe
        try:
            transaction = safe(transaction)
            result['transaction'] = str(transaction)
            receipt_path = safe(transaction / 'receipt.json')
            if receipt_path.exists():
                receipt = json.loads(receipt_path.read_text())
                from update_status import receipt_result
                result.update(receipt_result(receipt))
                original = receipt.get('failure', {})
                if original:
                    if original['reason'] != result['error']:
                        result['recoveryError'] = result['error']
                    result.update(error=original['reason'], phase=original['phase'])
                if receipt.get('recoveryFailure'):
                    result['recoveryError'] = receipt['recoveryFailure']['reason']
            # Never infer successful recovery from an exit code or partial journal.
            if result['status'] == 'rolled-back':
                result['recovery'] = '已回滚，原版本的运行/停服状态已恢复。'
            elif result['status'] == 'refused-before-maintenance':
                result['recovery'] = '维护前已拒绝；没有停止原服务或切换活动文件，无需回滚。'
            else:
                result['recovery'] = '尚未确认恢复完成，请勿当作更新成功或直接重试。'
            if transaction.is_dir():
                log = safe(transaction / 'failure-detail.log')
                atomic(log, ''.join(traceback.format_exception(type(error), error, error.__traceback__)).encode())
                result['errorLog'] = str(log)
        except (OSError, ValueError, TypeError, KeyError):
            result.setdefault('recovery', '无法完整读取恢复记录，恢复状态未确认。')
    return result


def run_cli(command, *, env, log):
    """Forward structured progress immediately; retain raw child output privately."""
    from update import safe
    log = safe(log)
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    os.fchmod(fd, 0o600)
    final = None
    with os.fdopen(fd, 'w') as errors, tempfile.TemporaryFile(mode='w+') as output:
        with subprocess.Popen(command, env={**env, 'PYTHONUNBUFFERED': '1'}, stdout=output,
                              stderr=subprocess.PIPE, text=True, errors='replace', bufsize=1) as process:
            for line in process.stderr:
                errors.write(line)
                errors.flush()
                if line.startswith(PREFIX):
                    try:
                        event = json.loads(line[len(PREFIX):])
                    except ValueError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    if event.get('event') == 'progress':
                        emit(event)
                    elif event.get('event') == 'failure':
                        final = event
            code = process.wait()
        output.seek(0)
        return subprocess.CompletedProcess(command, code, output.read(), json.dumps(final, ensure_ascii=False) if final else '')
