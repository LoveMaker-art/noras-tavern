"""Current Tavern process operations."""
import errno
import os
from pathlib import Path
import signal
import socket
import time

try:
    import psutil
except ImportError:  # Linux release environments can use /proc without psutil.
    psutil = None

PROCESS_ERRORS = (OSError,) if psutil is None else (OSError, psutil.Error)
GONE_ERRORS = (FileNotFoundError, ProcessLookupError) if psutil is None else (FileNotFoundError, ProcessLookupError, psutil.NoSuchProcess)


def _wrapped_os_denial(error):
    # Some macOS psutil C calls wrap syscall failures in SystemError instead
    # of AccessDenied. Unknown library faults must still remain visible.
    return isinstance(error.__cause__ or error.__context__, OSError)


def _command(candidate):
    if psutil is not None:
        return candidate.cmdline()
    return [os.fsdecode(value) for value in (candidate / 'cmdline').read_bytes().split(b'\0') if value]


def _cwd(candidate):
    return Path(candidate.cwd()).resolve() if psutil is not None else (candidate / 'cwd').resolve(strict=True)


def _script_record(candidate, pid, expected, argv, birth):
    scripts = [Path(value) for value in argv if value.endswith(('server.js', 'server.py'))]
    if not any(value.name == expected.name and (not value.is_absolute() or value.resolve() == expected)
               for value in scripts):
        return None
    cwd = _cwd(candidate)
    if not any((value if value.is_absolute() else cwd / value).resolve() == expected for value in scripts):
        return None
    if _process_gone(candidate) or _birth(_candidate(pid)) != birth:
        return None
    return {'pid': pid, 'cwd': str(cwd), 'argv': argv, 'script': str(expected), 'created_at': birth}


def process_record(pid, script):
    if not pid:
        return None
    try:
        candidate = _candidate(pid)
        birth = _birth(candidate)
        return _script_record(candidate, int(pid), Path(script).resolve(), _command(candidate), birth)
    except (ValueError, *PROCESS_ERRORS):
        return None
    except SystemError as error:
        if not _wrapped_os_denial(error):
            raise
        return None


def _same_account(candidate):
    if psutil is None:
        return candidate.stat().st_uid == os.getuid()
    if hasattr(os, 'getuid'):
        return candidate.uids().real == os.getuid()
    return candidate.username().casefold() == psutil.Process(os.getpid()).username().casefold()


def find_processes(script, *, strict=False, hint=None, executable=None):
    if psutil is None:
        proc = Path('/proc')
        if strict and not (proc / 'self/stat').is_file():
            raise RuntimeError('Tavern process inspection is unavailable')
        pids = [int(entry.name) for entry in proc.iterdir() if entry.name.isdigit()] if proc.is_dir() else []
    else:
        pids = psutil.pids()
    if not strict:
        return [record for pid in pids if (record := process_record(pid, script))]
    expected = Path(script).resolve()
    names = {'node', 'node.exe', 'nodejs', 'nodejs.exe', 'bun', 'bun.exe'}
    if executable:
        names.add(Path(executable).resolve().name.casefold())
    result = []
    for pid in pids:
        relevant = pid == hint
        try:
            candidate = _candidate(pid)
            name = candidate.name() if psutil is not None else (candidate / 'comm').read_text().strip()
            relevant = relevant or name.casefold() in names
            if not relevant:
                continue
            birth = _birth(candidate)
            argv = _command(candidate)
            if not argv and not _process_gone(candidate):
                raise RuntimeError('Tavern candidate command cannot be inspected')
            if record := _script_record(candidate, pid, expected, argv, birth):
                result.append(record)
        except GONE_ERRORS:
            continue
        except (RuntimeError, SystemError, *PROCESS_ERRORS) as error:
            if isinstance(error, SystemError) and not _wrapped_os_denial(error):
                raise
            if not relevant:
                continue
            # Failure reading an unrelated user's Node command is expected.
            # If account inspection itself fails, preserve uncertainty.
            try:
                foreign = not _same_account(_candidate(pid))
            except GONE_ERRORS:
                continue
            except (SystemError, *PROCESS_ERRORS):
                foreign = False
            if not foreign:
                raise RuntimeError('Tavern candidate process inspection failed') from error
    return result


def same_runtime(current, saved):
    return bool(current and saved and current.get('cwd') == saved.get('cwd')
                and current.get('argv') == saved.get('argv'))


def port_open(port):
    with socket.socket() as probe:
        probe.settimeout(0.3)
        result = probe.connect_ex(('127.0.0.1', int(port)))
    if result not in (0, errno.ECONNREFUSED, 10061):  # Winsock WSAECONNREFUSED
        raise OSError(result, 'Tavern listener state could not be confirmed')
    return result == 0


def _proc_stat(entry):
    fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
    return fields[0], int(fields[19])


def _process_gone(candidate):
    return (candidate.status() == psutil.STATUS_ZOMBIE if psutil is not None
            else _proc_stat(candidate)[0] in ('Z', 'X'))


def _birth(candidate):
    return candidate.create_time() if psutil is not None else _proc_stat(candidate)[1]


def _local_identity(candidate):
    if psutil is None:
        owner = str(candidate.stat().st_uid)
        executable = (candidate / 'exe').resolve(strict=True)
    else:
        owner = candidate.username()
        executable = Path(candidate.exe()).resolve()
    return str(executable), owner, _same_account(candidate)


def _owns_listener(candidate, port):
    if psutil is not None:
        return any(connection.status == psutil.CONN_LISTEN and connection.laddr
                   and connection.laddr.port == int(port)
                   and connection.laddr.ip in ('127.0.0.1', '0.0.0.0')
                   for connection in candidate.net_connections(kind='tcp'))
    inodes = set()
    for descriptor in (candidate / 'fd').iterdir():
        try:
            target = os.readlink(descriptor)
        except FileNotFoundError:
            continue
        if target.startswith('socket:['):
            inodes.add(target[8:-1])
    listeners = (candidate / 'net/tcp').read_text().splitlines()[1:]
    return any(address in ('0100007F', '00000000') and int(number, 16) == int(port)
               and row[3] == '0A' and row[9] in inodes
               for line in listeners if len(row := line.split()) > 9
               for address, number in [row[1].split(':')])


def _candidate(pid):
    return psutil.Process(int(pid)) if psutil is not None else Path('/proc') / str(int(pid))


def verify_owned_process(process, script, *, listener_port=None):
    """Verify the exact local OS process and, when needed, its own listener."""
    pid = int(process['pid'])
    try:
        candidate = _candidate(pid)
        created = _birth(candidate)
        executable, owner, same_owner = _local_identity(candidate)
        if not same_owner or Path(executable) != Path(process['argv'][0]).resolve():
            raise RuntimeError('Tavern executable or OS owner differs')
        if listener_port is not None and not _owns_listener(candidate, listener_port):
            raise RuntimeError('Tavern does not own the expected IPv4 listener')
        current = process_record(pid, script)
        if not same_runtime(current, process) or _birth(_candidate(pid)) != created or _process_gone(candidate):
            raise RuntimeError('Tavern changed during ownership inspection')
        evidence = {**current, 'exe': executable, 'owner': owner, 'created_at': created}
        if any(key in process and process[key] != evidence[key] for key in ('exe', 'owner', 'created_at')):
            raise RuntimeError('Tavern instance changed during ownership inspection')
        return evidence
    except (ValueError, *PROCESS_ERRORS) as error:
        raise RuntimeError('Tavern ownership inspection failed') from error
    except SystemError as error:
        if not _wrapped_os_denial(error):
            raise
        raise RuntimeError('Tavern ownership inspection failed') from error


def require_listener(process, script, port):
    return verify_owned_process(process, script, listener_port=port)


def verify_owned_listener(process, script, port):
    return require_listener(process, script, port)


def _same_live_process(process):
    try:
        current = _candidate(process['pid'])
        return current if _birth(current) == process['created_at'] and not _process_gone(current) else None
    except GONE_ERRORS:
        return None


def stop_process(process, script, *, stop=None):
    evidence = verify_owned_process(process, script)

    def authorized_signal_target():
        candidate = _same_live_process(evidence)
        if candidate is None:
            return None
        try:
            verify_owned_process(evidence, script)
        except RuntimeError as error:
            # A process can disappear during inspection. Leave completion
            # to the bounded birth/liveness check without signalling that PID.
            if isinstance(error.__cause__, GONE_ERRORS) or _same_live_process(evidence) is None:
                return None
            raise
        return candidate

    def signal_live(*, force=False):
        candidate = authorized_signal_target()
        if candidate is None:
            return
        try:
            if psutil is None:
                os.kill(evidence['pid'], signal.SIGKILL if force else signal.SIGTERM)
            elif force:
                candidate.kill()
            else:
                candidate.terminate()
        except GONE_ERRORS:
            pass

    def wait_stopped(seconds):
        deadline = time.monotonic() + seconds
        while _same_live_process(evidence) is not None:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.1)
        return True

    if stop is not None:
        if authorized_signal_target() is not None:
            stop()
        if not wait_stopped(8):
            raise RuntimeError('Tavern managed process has not stopped')
    else:
        signal_live()
        if not wait_stopped(8):
            signal_live(force=True)
            if not wait_stopped(5):
                raise RuntimeError('Tavern process has not stopped')
    return {'pid': evidence['pid'], 'stopped': True}
