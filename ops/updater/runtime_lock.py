"""One local lock prevents two installers/runtimes from writing together."""
from contextlib import contextmanager
import os
import time
from pathlib import Path


@contextmanager
def installation_lock(home, name="tavern-update.lock", *, blocking=True):
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
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            except BlockingIOError:
                yield False
                return
        try:
            yield True
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
