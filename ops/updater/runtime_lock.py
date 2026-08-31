"""Installation-scoped maintenance exclusion shared by updater and launchers.

The lock lives outside switched state/code directories. Child launchers may
inherit the actual locked descriptor (not a boolean environment bypass).
"""
import argparse
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import subprocess
import threading

FD_ENV = 'TAVERN_MAINTENANCE_FD'
_held = {}


def _path(home):
    root = Path(home).absolute() / 'tavern-updates-v2'
    path = root / 'lock'
    if any(item.is_symlink() for item in (path, *path.parents)):
        raise ValueError('Maintenance lock path must not contain symlinks')
    root.mkdir(parents=True, exist_ok=True)
    return path


def _inherited(path):
    value = os.environ.get(FD_ENV)
    if value is None:
        return None
    try:
        fd = int(value)
        actual, expected = os.fstat(fd), path.stat()
        if fd < 3 or (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
            raise ValueError('Inherited maintenance descriptor belongs to a different installation')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except (OSError, ValueError) as error:
        raise ValueError('Invalid or unavailable inherited maintenance lock') from error


@contextmanager
def installation_lock(home):
    path = _path(home)
    key = (os.getpid(), threading.get_ident(), str(path))
    if key in _held:
        yield _held[key]
        return
    inherited = _inherited(path)
    if inherited is not None:
        _held[key] = inherited
        try:
            yield inherited
        finally:
            del _held[key]
        return
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError('Tavern maintenance is already running; no operation was started') from error
        _held[key] = fd
        try:
            yield fd
        finally:
            del _held[key]
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', required=True)
    parser.add_argument('--check-inherited', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.check_inherited:
        if _inherited(_path(args.home)) is None:
            raise ValueError('Inherited maintenance lock is required')
        return 0
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('command is required')
    with installation_lock(args.home) as fd:
        environment = {**os.environ, FD_ENV: str(fd)}
        return subprocess.call(command, env=environment, pass_fds=(fd,))


if __name__ == '__main__':
    raise SystemExit(main())
