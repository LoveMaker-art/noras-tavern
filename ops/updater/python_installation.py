"""Recognize Python-era source and installed layouts without importing old code.

One descriptor drives review, process ownership, asset migration and recovery.
Do not guess between two executable installations or follow links outside them.
"""
from pathlib import Path

from update import safe


def python_installation(app):
    app = safe(Path(app))
    if safe(app / 'native-runtime.json').exists():
        return None
    entries = [name for name in ('server.py', 'backend/server.py') if safe(app / name).is_file()]
    if len(entries) > 1:
        raise ValueError('Ambiguous Python installation: both server.py and backend/server.py exist')
    if not entries:
        return None
    entry = entries[0]
    web = 'web' if entry == 'server.py' else ('frontend' if safe(app / 'frontend').is_dir() else 'backend/web')
    safe(app / web)
    return {'entry': entry, 'web': web}


def python_script(app):
    layout = python_installation(app)
    if layout is None:
        raise ValueError('Original Python installation is missing')
    return safe(Path(app) / layout['entry'])
