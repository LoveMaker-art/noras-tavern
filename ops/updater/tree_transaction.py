"""Bounded, recoverable directory replacement; never deletes the previous tree."""
import hashlib
import json
import os
from pathlib import Path
import stat


def _read_reviewed_link(root, path, name, *, state=False):
    if state or "node_modules" not in Path(name).parts or root not in path.resolve().parents:
        raise ValueError("Unreviewed symlink: " + str(path))
    return os.readlink(path)


def _walk(root, *, state=False, tolerate_missing=False):
    root = Path(root)
    if root.is_symlink():
        raise ValueError("Symlink root requires review: " + str(root))
    if not root.exists():
        return
    pending = [(root, "")]
    while pending:
        path, name = pending.pop()
        try:
            info = path.lstat()
            if "__pycache__" in Path(name).parts:
                continue
            if state and (name == "native-runtime/runs" or name.startswith("native-runtime/runs/")):
                continue  # Process IDs/logs are recreated; not conversation state.
            link = _read_reviewed_link(root, path, name, state=state) if stat.S_ISLNK(info.st_mode) else None
            children = sorted(path.iterdir()) if stat.S_ISDIR(info.st_mode) else ()
            if not (link is not None or children or stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError("Special file requires review: " + str(path))
            yield path, name, info, link
            pending.extend((child, (name + "/" if name else "") + child.name) for child in children)
        except FileNotFoundError:
            if tolerate_missing:
                continue
            raise


def inventory(root, *, state=False):
    root = Path(root)
    if not root.exists() and not root.is_symlink():
        return None
    result = {}
    for path, name, info, link in _walk(root, state=state):
        mode = info.st_mode & 0o777
        if link is not None:
            result[name] = {"link": link}
        elif stat.S_ISDIR(info.st_mode):
            result[name] = {"directory": True, "mode": mode}
        else:
            h = hashlib.sha256()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    h.update(block)
            result[name] = {"sha256": h.hexdigest(), "size": info.st_size, "mode": mode}
    return result


def fingerprint(root, *, state=False):
    return hashlib.sha256(json.dumps(inventory(root, state=state), sort_keys=True).encode()).hexdigest()


def size(root):
    """Estimate live tree bytes without weakening integrity inventories.

    Runtime atomic writes briefly expose a temporary directory entry and then
    rename it over its destination. A capacity estimate may safely omit an
    entry that vanished after listing; later stopped-runtime inventories and
    fingerprints remain strict and verify the exact transaction snapshot.
    """
    # Online atomic writers can rename a temporary entry between iterdir() and
    # lstat()/readlink(). It no longer consumes space and can be omitted here.
    return sum(info.st_size for _path, _name, info, _link in _walk(root, tolerate_missing=True)
               if stat.S_ISREG(info.st_mode))


def rename(source, target):
    """Atomic same-device rename plus directory fsync for durable intent replay."""
    source, target = Path(source), Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        raise ValueError("Refusing to overwrite recovery target: " + str(target))
    os.replace(source, target)
    for directory in {source.parent, target.parent}:
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def switch(entry):
    target, source, backup = (Path(entry[k]) for k in ("target", "source", "backup"))
    if target.exists():
        rename(target, backup)
    if source.exists():
        rename(source, target)


def recovery_check(entry, *, allow_state_change=False, accepted=None):
    target, source, backup = (Path(entry[k]) for k in ("target", "source", "backup"))
    state = entry.get("state", False)
    current = fingerprint(target, state=state)
    if backup.exists():
        if fingerprint(backup, state=state) != entry["before"]:
            raise ValueError("Recovery backup checksum mismatch: " + entry["name"])
        if target.exists():
            if source.exists():
                raise ValueError("Ambiguous recovery paths: " + entry["name"])
            expected = accepted if accepted is not None else entry["after"]
            if not (state and allow_state_change) and current != expected:
                raise ValueError("Recovery preserved a concurrent modification: " + entry["name"])
    elif entry["hadOld"]:
        if current != entry["before"]:
            raise ValueError("Missing recovery backup: " + entry["name"])
    elif not source.exists() and target.exists() and current != entry["after"] and not (state and allow_state_change):
        raise ValueError("Recovery preserved a concurrent modification: " + entry["name"])


def restore(entry):
    target, source, backup = (Path(entry[k]) for k in ("target", "source", "backup"))
    if backup.exists():
        if target.exists():
            rename(target, source)  # Retain failed/new tree for diagnosis.
        rename(backup, target)
    elif not entry["hadOld"] and target.exists() and not source.exists():
        rename(target, source)
