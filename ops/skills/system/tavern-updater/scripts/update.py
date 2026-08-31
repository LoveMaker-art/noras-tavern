#!/usr/bin/env python3
"""Stable skill entrypoint; the versioned updater implementation lives in ops."""
import os
import hashlib
import json
from pathlib import Path
import runpy
import sys

source_ops = Path(__file__).resolve().parents[4]
home = Path(os.environ.get("HERMES_HOME", source_ops))
entry = source_ops / "updater/update.py"
if not entry.is_file():
    pointer = home / 'tavern-updates-v2/bootstrap-runtime.json'
    if pointer.exists():
        value = json.loads(pointer.read_text())
        entry = Path(value['entry'])
        expected = home / 'tavern-updates-v2' / ('bootstrap-' + value['manifestSha256']) / 'ops/updater/update.py'
        if entry != expected or entry.resolve() != expected or hashlib.sha256(entry.read_bytes()).hexdigest() != value['sha256']:
            raise SystemExit('Pinned bootstrap updater changed; review again using the verified installer.')
    else:
        entry = home / "apps/tavern-ops/updater/update.py"
if not entry.is_file():
    raise SystemExit("Full-release updater is missing. Use ops/updater/update.py from the reviewed repository checkout.")
sys.path.insert(0, str(entry.parent))
runpy.run_path(str(entry), run_name="__main__")
