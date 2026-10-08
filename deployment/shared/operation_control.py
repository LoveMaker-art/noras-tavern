"""Private, per-operation executor channel. Environment values are only hints.

A maintenance process must receive an acknowledgement from the live guard that
owns its actual process handle. Nested maintenance is spawned by that guard;
neither PID polling nor a closed socket is reported as child completion.
"""
from __future__ import annotations

import base64
import collections
import io
import hashlib
import importlib.util
import json
import ntpath
import os
from pathlib import Path
import re
import runpy
import socket
import shutil
import subprocess
import sys
import threading
import time

_UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)
_PREFIX = 'NORA_OPERATION_'


def _windows_execution_path(value):
    """Give Node ordinary Win32 paths; its guard still resolves real identity."""
    value = os.fspath(value)
    if value.startswith('\\\\?\\UNC\\'):
        value = '\\\\' + value[8:]
    elif value.startswith('\\\\?\\'):
        value = value[4:]
    return ntpath.normpath(value)


class OperationControlError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _failure(code='OPERATION_GUARD_LOST'):
    return OperationControlError(code, '执行管控连接已中断。请保留安装和日志，重新检查状态后再继续。')


def _creation_time():
    # A self-report only supplements the guard's actual ChildProcess handle;
    # it never authorizes a process whose PID differs from that handle.
    import psutil
    return psutil.Process().create_time()


class _Output(io.RawIOBase):
    def __init__(self, gate):
        self.gate = gate
        self.condition = threading.Condition()
        self.chunks = collections.deque()
        self.ended = False

    def readable(self):
        return True

    def feed(self, value):
        with self.condition:
            self.chunks.append(value)
            self.condition.notify_all()

    def end(self):
        with self.condition:
            self.ended = True
            self.condition.notify_all()

    def readinto(self, buffer):
        with self.condition:
            while not self.chunks:
                if self.ended:
                    return 0
                self.gate.assert_active()
                self.condition.wait(0.1)
            value = self.chunks.popleft()
            size = min(len(buffer), len(value))
            buffer[:size] = value[:size]
            if size < len(value):
                self.chunks.appendleft(value[size:])
            return size


class _Input(io.RawIOBase):
    def __init__(self, process):
        self.process = process

    def writable(self):
        return True

    def write(self, data):
        data = bytes(data)
        for offset in range(0, len(data), 48 * 1024):
            self.process.gate.rpc('stdin', jobId=self.process.job_id,
                data=base64.b64encode(data[offset:offset + 48 * 1024]).decode('ascii'))
        return len(data)

    def close(self):
        if not self.closed:
            if self.process.gate.active:
                self.process.gate.rpc('stdin-end', jobId=self.process.job_id)
            super().close()


class ManagedProcess:
    def __init__(self, gate, job_id, args, *, stdout=None, stderr=None, stdin=None,
                 text=False, encoding=None, errors=None):
        self.gate, self.job_id, self.args = gate, job_id, args
        self.pid = None
        self.returncode = None
        self._condition = threading.Condition()
        self._spawned = False
        self._closed = False
        self._error = None
        self._combine = stderr == subprocess.STDOUT
        self._raw = {name: _Output(gate) for name in ('stdout', 'stderr')}
        self._targets = {'stdout': stdout, 'stderr': stderr}
        for name, target in self._targets.items():
            stream = io.BufferedReader(self._raw[name]) if target == subprocess.PIPE else None
            if stream is not None and (text or encoding):
                stream = io.TextIOWrapper(stream, encoding=encoding or 'utf-8', errors=errors or 'strict')
            setattr(self, name, stream)
        if self._combine:
            self.stderr = None
        self.stdin = _Input(self) if stdin == subprocess.PIPE else None
        if self.stdin is not None and (text or encoding):
            self.stdin = io.TextIOWrapper(io.BufferedWriter(self.stdin), encoding=encoding or 'utf-8', errors=errors or 'strict')

    def _event(self, message):
        with self._condition:
            event = message['event']
            if event == 'spawn':
                self.pid, self._spawned = message['pid'], True
            elif event == 'error':
                record = message.get('error', {})
                failure = OperationControlError(record.get('code') or 'OPERATION_CHILD_FAILED',
                    '维护任务无法启动，请检查运行环境。')
                self._error = self.gate._with_diagnostic(failure, record)
            elif event in ('stdout', 'stderr'):
                name = 'stdout' if self._combine else event
                value = base64.b64decode(message['data'], validate=True)
                target = self._targets[name]
                if target == subprocess.PIPE:
                    self._raw[name].feed(value)
                elif target != subprocess.DEVNULL:
                    destination = target if hasattr(target, 'write') else getattr(sys, name)
                    try:
                        destination.buffer.write(value)
                    except AttributeError:
                        destination.write(value.decode('utf-8', errors='replace'))
                    destination.flush()
            elif event == 'close':
                # The exit notification alone does not imply pipe/child closure.
                code = message.get('code')
                if code is None:
                    signals = {'SIGTERM': 15, 'SIGKILL': 9, 'SIGINT': 2}
                    code = -signals.get(message.get('signal'), 1)
                self.returncode, self._closed = code, True
                for output in self._raw.values():
                    output.end()
            self._condition.notify_all()

    def _wait(self, predicate, timeout):
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._condition:
            while not predicate():
                if self._error:
                    raise self._error
                self.gate.assert_active()
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise subprocess.TimeoutExpired(self.args, timeout)
                self._condition.wait(0.1 if remaining is None else min(0.1, remaining))

    def wait(self, timeout=None):
        self._wait(lambda: self._closed, timeout)
        return self.returncode

    def poll(self):
        return self.returncode if self._closed else None

    def send_signal(self, signal):
        import signal as signals
        name = signals.Signals(signal).name if isinstance(signal, int) else signal
        return self.gate.rpc('kill', jobId=self.job_id, signal=name).get('sent', False)

    def terminate(self):
        return self.send_signal('SIGTERM')

    def kill(self):
        return self.send_signal('SIGKILL')

    def communicate(self, input=None, timeout=None):
        results, failures = {}, []
        def drain(name):
            try:
                results[name] = getattr(self, name).read()
            except Exception as error:
                failures.append(error)
        threads = [threading.Thread(target=drain, args=(name,), daemon=True)
                   for name in ('stdout', 'stderr') if getattr(self, name) is not None]
        for thread in threads:
            thread.start()
        if self.stdin is not None:
            if input is not None:
                self.stdin.write(input)
                self.stdin.flush()
            self.stdin.close()
        elif input is not None:
            raise ValueError('stdin=PIPE is required for input')
        self.wait(timeout)
        for thread in threads:
            thread.join()
        if failures:
            raise failures[0]
        return results.get('stdout'), results.get('stderr')

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        for stream in (self.stdout, self.stderr, self.stdin):
            if stream is not None:
                stream.close()
        self.wait()


class OperationDelegate:
    @classmethod
    def connect(cls, *, creation_time=_creation_time):
        endpoint = os.environ.get(_PREFIX + 'DELEGATE_ENDPOINT', '')
        token = os.environ.get(_PREFIX + 'DELEGATE_TOKEN', '')
        job_id = os.environ.get(_PREFIX + 'JOB_ID', '')
        operation_id = os.environ.get(_PREFIX + 'ID', '')
        epoch = os.environ.get(_PREFIX + 'OWNER_EPOCH', '')
        if (not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}', endpoint) or not re.fullmatch(r'[0-9a-f]{64}', token)
                or not _UUID.fullmatch(job_id) or not _UUID.fullmatch(operation_id)
                or not epoch.isdigit() or not 0 < int(epoch) <= 2**53 - 1):
            raise OperationControlError('OPERATION_CAPABILITY_REQUIRED',
                '该维护命令需要由新版完整启动器执行。安装和数据未修改，请在启动器中继续操作。')
        connection = socket.create_connection(('127.0.0.1', int(endpoint.split(':')[1])), timeout=10)
        stream = connection.makefile('rb')
        identity = {'schema': 'nora-operation-executor/1', 'jobId': job_id, 'token': token,
                    'pid': os.getpid(), 'creationTime': creation_time(), 'precisionSeconds': 0.001}
        connection.sendall((json.dumps(identity) + '\n').encode())
        try:
            ack = json.loads(stream.readline(8193))
            if (ack.get('schema') != 'nora-operation-delegation-ack/1' or ack.get('jobId') != job_id
                    or ack.get('token') != token or ack.get('operationId') != operation_id or ack.get('ownerEpoch') != int(epoch)):
                raise _failure('OPERATION_CAPABILITY_REJECTED')
        except Exception:
            stream.close()
            connection.close()
            raise
        connection.settimeout(None)
        return cls(connection, stream, operation_id, int(epoch))

    def __init__(self, connection, stream, operation_id, owner_epoch):
        self.connection, self.stream = connection, stream
        self.operation_id, self.owner_epoch = operation_id, owner_epoch
        self.active = True
        # Load the sealed sibling while this executor's source still exists;
        # a managed update may subsequently exchange the installed ops tree.
        self._diagnostic_module = None
        diagnostic_path = Path(__file__).resolve().with_name('error_diagnostics.py')
        if not diagnostic_path.is_symlink():
            try:
                spec = importlib.util.spec_from_file_location('nora_guard_diagnostics', diagnostic_path)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                self._diagnostic_module = module
            except (OSError, ImportError, SyntaxError):
                pass
        self._condition, self._write_lock = threading.Condition(), threading.Lock()
        self._sequence, self._replies, self._jobs, self._early = 0, {}, {}, {}
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def assert_active(self):
        if not self.active:
            raise _failure()

    def _read(self):
        try:
            while True:
                line = self.stream.readline(256 * 1024 + 1)
                if not line or len(line) > 256 * 1024:
                    break
                message = json.loads(line)
                with self._condition:
                    if message.get('type') == 'reply':
                        self._replies[message['requestId']] = message
                    elif message.get('type') == 'child':
                        job = self._jobs.get(message['jobId'])
                        if job:
                            job._event(message)
                        else:
                            events = self._early.setdefault(message['jobId'], [])
                            if len(events) >= 256:
                                raise _failure()
                            events.append(message)
                    self._condition.notify_all()
        except (OSError, ValueError, OperationControlError):
            pass
        finally:
            with self._condition:
                self.active = False
                self._condition.notify_all()

    def _with_diagnostic(self, failure, record):
        diagnostic = record.get('diagnostic')
        if diagnostic is None:
            failure._diagnostic_missing = ['guard_diagnostic_missing']
        elif self._diagnostic_module is None:
            failure._diagnostic_missing = ['guard_diagnostic_unavailable']
        else:
            try:
                failure.__cause__ = self._diagnostic_module.exception_from_diagnostic(diagnostic)
            except ValueError:
                failure._diagnostic_missing = ['guard_diagnostic_invalid']
        return failure

    def rpc(self, action, **fields):
        deadline = time.monotonic() + 15
        with self._condition:
            self.assert_active()
            self._sequence += 1
            request_id = str(self._sequence)
        frame = (json.dumps({'type': action, 'requestId': request_id, **fields}) + '\n').encode()
        if len(frame) > 256 * 1024:
            raise OperationControlError('OPERATION_REQUEST_TOO_LARGE', '维护命令超过允许范围。')
        with self._write_lock:
            try:
                self.connection.sendall(frame)
            except OSError as error:
                self.active = False
                raise _failure() from error
        with self._condition:
            while request_id not in self._replies:
                self.assert_active()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise _failure('OPERATION_GUARD_TIMEOUT')
                self._condition.wait(remaining)
            reply = self._replies.pop(request_id)
        if reply.get('error'):
            failure = OperationControlError(reply['error'].get('code', 'OPERATION_CHILD_FAILED'),
                '维护任务无法执行，请保留日志并检查状态。')
            raise self._with_diagnostic(failure, reply['error'])
        return reply.get('result', {})

    def popen(self, args, *, stdout=None, stderr=None, stdin=None, text=False, encoding=None, errors=None,
              env=None, cwd=None, bufsize=-1, **unsupported):
        if unsupported or not isinstance(args, (list, tuple)) or not args:
            raise ValueError('Guarded maintenance requires an explicit command list and supported pipe options')
        args = [str(value) for value in args]
        command = Path(args[0])
        options = {'env': dict(os.environ if env is None else env), 'windowsHide': True}
        if cwd is not None:
            options['cwd'] = str(cwd)
        node = command.name.lower() in ('node', 'node.exe')
        if node:
            if not command.is_absolute():
                located = shutil.which(str(command), path=options['env'].get('PATH'))
                if not located:
                    raise OperationControlError('NODE_UNAVAILABLE', 'Nora 自带的 Node 不可用。')
                command = Path(located)
            pinned = options['env'].get('TAVERN_NODE_EXECUTABLE')
            if not pinned or command.resolve() != Path(pinned).resolve() or len(args) < 2 or not Path(args[1]).is_absolute():
                raise OperationControlError('OPERATION_CHILD_UNSUPPORTED', '维护任务必须使用 Nora 自带的 Node 和明确的程序脚本。')
            options['managedNodeRoot'] = str(command.parent if os.name == 'nt' else command.parent.parent)
            child_args = [str(Path(__file__).with_name('operation_node.mjs')), *args[1:]]
            kind = 'node-maintenance'
        else:
            if not command.is_absolute() or not command.name.lower().startswith('python'):
                raise OperationControlError('OPERATION_CHILD_UNSUPPORTED', '维护任务必须使用 Nora 自带的 Python。')
            child_args = ['-B', '-u', str(Path(__file__).resolve()), '--delegate-exec', *args[1:]]
            kind = 'python-maintenance'
        if not node and os.name == 'nt':
            # Configuration may live in a separate staged HOME. Execution stays
            # bound to this acknowledged interpreter and its real venv/root.
            command = Path(_windows_execution_path(command))
            options['venvHome'] = _windows_execution_path(sys.prefix)
            options['managedPythonRoot'] = _windows_execution_path(sys.base_prefix)
        result = self.rpc('spawn', command=str(command), args=child_args, kind=kind, options=options)
        process = ManagedProcess(self, result['jobId'], args, stdout=stdout, stderr=stderr, stdin=stdin,
                                 text=text, encoding=encoding, errors=errors)
        with self._condition:
            self._jobs[process.job_id] = process
            for event in self._early.pop(process.job_id, []):
                process._event(event)
        process._wait(lambda: process._spawned, 15)
        if stdin != subprocess.PIPE:
            self.rpc('stdin-end', jobId=process.job_id)
        return process

    def run(self, args, **options):
        return _managed_run(self, args, **options)

    def resource(self, name):
        self.assert_active()
        if name not in ('mcp_probe.mjs', 'operation_control.py', 'operation_node.mjs'):
            raise OperationControlError('OPERATION_CHILD_UNSUPPORTED', '维护资源不在受管范围内。')
        target = Path(__file__).resolve().with_name(name)
        if target.is_symlink() or not target.is_file():
            raise OperationControlError('RESOURCE_INCOMPLETE', '维护资源缺失，请保留数据并重新安装新版启动器。')
        return target

    def close(self):
        self.active = False
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.connection.close()
        self._reader.join(1)
        self.stream.close()


def require_operation():
    gate = getattr(sys, '_nora_operation_delegate', None)
    if gate is None:
        gate = OperationDelegate.connect()
        sys._nora_operation_delegate = gate
    gate.assert_active()
    return gate


def managed_popen(args, **options):
    return require_operation().popen(args, **options)


def managed_run(args, *, input=None, capture_output=False, timeout=None, check=False, **options):
    return _managed_run(require_operation(), args, input=input, capture_output=capture_output,
                        timeout=timeout, check=check, **options)


def _managed_run(delegate, args, *, input=None, capture_output=False, timeout=None, check=False, **options):
    if capture_output:
        if 'stdout' in options or 'stderr' in options:
            raise ValueError('capture_output conflicts with stdout/stderr')
        options.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if input is not None:
        options['stdin'] = subprocess.PIPE
    process = delegate.popen(args, **options)
    try:
        stdout, stderr = process.communicate(input=input, timeout=timeout)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(10)
        raise
    result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
    if check:
        result.check_returncode()
    return result


def _exec_python(args):
    require_operation()
    # Supported flags have already been applied to the wrapper interpreter.
    while args and args[0] in ('-B', '-u'):
        args = args[1:]
    if not args:
        raise ValueError('A maintenance script or module is required')
    if args[0] == '-c':
        sys.path.insert(0, os.getcwd())
        sys.argv = ['-c', *args[2:]]
        exec(compile(args[1], '<string>', 'exec'), {'__name__': '__main__', '__file__': '<string>'})
    elif args[0] == '-m':
        sys.path.insert(0, os.getcwd())
        sys.argv = [args[1], *args[2:]]
        runpy.run_module(args[1], run_name='__main__', alter_sys=True)
    else:
        if args[0].startswith('-'):
            raise ValueError('Unsupported maintenance interpreter option')
        script = Path(args[0]).resolve(strict=True)
        sys.argv = [str(script), *args[1:]]
        sys.path.insert(0, str(script.parent))
        runpy.run_path(str(script), run_name='__main__')


def inspect_executors(sessions):
    """Read-only process proof. Return bounded facts, never argv or environment."""
    import psutil
    processes = {}
    inaccessible = False
    for process in psutil.process_iter(['pid', 'create_time', 'exe', 'cmdline']):
        try:
            processes[process.pid] = process.info
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            inaccessible = True
    results = []
    for session in sessions:
        for job in session.get('jobs', []):
            if job.get('closedAt') or job.get('spawnFailedAt'):
                continue
            expected = job.get('executionIdentity', {})
            creation = job.get('creationIdentity', {})
            marker = expected.get('jobArgument')
            process = processes.get(job.get('pid'))
            matches = [value for value in processes.values() if marker and marker in (value.get('cmdline') or [])]
            if len(matches) == 1:
                process = matches[0]
            if process is None:
                state = 'unknown' if (not job.get('pid') or inaccessible and marker) else 'offline'
            else:
                args = process.get('cmdline') or []
                normalized = [os.path.realpath(args[0]), *args[1:]] if args else []
                argv_digest = hashlib.sha256(json.dumps(normalized, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
                ctime = process.get('create_time')
                tolerance = max(float(creation.get('precisionSeconds', 0)), 0.001)
                identity = (process.get('pid') == creation.get('pid') and isinstance(ctime, (int, float))
                    and isinstance(creation.get('creationTime'), (int, float))
                    and abs(ctime - creation['creationTime']) <= tolerance
                    and expected.get('argvDigest') == argv_digest)
                if identity:
                    state = 'active-verified'
                elif creation.get('creationTime') and ctime and abs(ctime - creation['creationTime']) > tolerance and not matches:
                    state = 'offline' if not marker or not inaccessible else 'unknown'
                else:
                    state = 'active-unverified'
            results.append({'jobId': job.get('jobId'), 'operationId': session.get('operationId'), 'state': state})
    return {'schema': 'nora-executor-inspection/1', 'jobs': results}


if __name__ == '__main__':
    if sys.argv[1:] == ['--inspect']:
        value = json.loads(sys.stdin.buffer.read(256 * 1024 + 1))
        print(json.dumps(inspect_executors(value['sessions'])))
        raise SystemExit(0)
    if len(sys.argv) > 1 and sys.argv[1].startswith('--nora-operation-job='):
        job = sys.argv.pop(1).split('=', 1)[1]
        if job != os.environ.get('NORA_OPERATION_JOB_ID'):
            raise _failure('OPERATION_CAPABILITY_REJECTED')
    if len(sys.argv) < 2 or sys.argv[1] != '--delegate-exec':
        raise SystemExit('This executor is private to the Nora launcher')
    _exec_python(sys.argv[2:])
