"""One local lock prevents two installers/runtimes from writing together."""
from contextlib import contextmanager
import fcntl
from pathlib import Path


@contextmanager
def installation_lock(home):
    path = Path(home) / "tavern-update.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
