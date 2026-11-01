"""One local lock prevents two installers/runtimes from writing together."""
from contextlib import contextmanager
import os
import sys
import time
from pathlib import Path


def _linux_writer_record(kind):
    # Match fs-native-extensions' Linux F_OFD_SETLK primitive. BSD flock
    # does not conflict with the Node updater's record lock on this platform.
    import ctypes
    class Record(ctypes.Structure):
        _fields_ = [('kind', ctypes.c_short), ('whence', ctypes.c_short),
                    ('start', ctypes.c_int64), ('length', ctypes.c_int64), ('pid', ctypes.c_int)]
    return bytes(Record(kind, os.SEEK_SET, 0, 0, 0))


@contextmanager
def installation_lock(home, name="tavern-update.lock", *, blocking=True, descriptor=False):
    path = Path(home) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as stream:
        if os.name == "nt":
            import msvcrt
            if path.stat().st_size == 0:
                stream.write("\0")
                stream.flush()
            deadline = time.monotonic() + 120
            while True:
                stream.seek(0)
                try:
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if not blocking:
                        yield False
                        return
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Nora instance is busy")
                    time.sleep(0.1)
        else:
            import fcntl
            linux_writer = sys.platform.startswith('linux') and name == '.writer.lock'
            try:
                if linux_writer:
                    fcntl.fcntl(stream.fileno(), fcntl.F_OFD_SETLKW if blocking else fcntl.F_OFD_SETLK,
                                _linux_writer_record(fcntl.F_WRLCK))
                else:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            except BlockingIOError:
                yield False
                return
        try:
            yield stream if descriptor else True
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                if linux_writer:
                    fcntl.fcntl(stream.fileno(), fcntl.F_OFD_SETLK, _linux_writer_record(fcntl.F_UNLCK))
                else:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
