"""Pin the executing updater to each reviewed transaction, not a mutable pointer.

An application update can replace installed ops while still running. Recovery
therefore owns a private, digest-bound engine snapshot next to its plan/receipt.
This is not an active installation and never enters skill discovery.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil


def checked(path):
    path = Path(os.path.abspath(path))
    if any(item.is_symlink() for item in (path, *path.parents)):
        raise ValueError('Updater engine symlink requires review')
    return path


def inventory(root):
    root = checked(root)
    if not root.is_dir():
        raise ValueError('Reviewed updater engine is missing')
    files = {}
    total = 0
    for file in sorted(root.rglob('*')):
        relative = file.relative_to(root)
        if '__pycache__' in relative.parts:
            continue
        checked(file)
        if file.is_dir():
            continue
        if not file.is_file():
            raise ValueError('Updater engine contains a non-regular file')
        total += file.stat().st_size
        if total > 16 * 1024 * 1024 or len(files) >= 1000:
            raise ValueError('Updater engine exceeds snapshot bounds')
        files[str(relative)] = hashlib.sha256(file.read_bytes()).hexdigest()
    if 'update.py' not in files:
        raise ValueError('Updater engine entry is missing')
    return files


def identity(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def capture(transaction, source):
    source = checked(source)
    target = checked(Path(transaction) / 'engine')
    files = inventory(source)
    target.mkdir(mode=0o700)
    for name in files:
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, destination)
        destination.chmod(0o600)
    if inventory(source) != files or inventory(target) != files:
        raise ValueError('Updater engine changed while creating the review')
    return {'schema': 1, 'entry': str(target / 'update.py'), 'files': files, 'sha256': identity(files)}


def verify(transaction, descriptor):
    expected = checked(Path(transaction) / 'engine/update.py')
    if not isinstance(descriptor, dict) or descriptor.get('schema') != 1 or descriptor.get('entry') != str(expected):
        raise ValueError('Invalid transaction-bound updater engine')
    if any(expected.parent.rglob('__pycache__')):
        raise ValueError('Unreviewed bytecode in updater engine; execution refused')
    files = inventory(expected.parent)
    if files != descriptor.get('files') or identity(files) != descriptor.get('sha256'):
        raise ValueError('Reviewed updater engine changed; execution refused')
    return expected
