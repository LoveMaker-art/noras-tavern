#!/usr/bin/env python3
"""Stable skill entrypoint; the versioned updater implementation lives in ops."""
import os
from pathlib import Path
import runpy
import sys

source_ops = Path(__file__).resolve().parents[4]
home = Path(os.environ.get("HERMES_HOME", source_ops))
entry = source_ops / "updater/update.py"
if not entry.is_file():
    entry = home / "apps/tavern-ops/updater/update.py"
if not entry.is_file():
    raise SystemExit("Full-release updater is missing. Use ops/updater/update.py from the reviewed repository checkout.")
sys.path.insert(0, str(entry.parent))
runpy.run_path(str(entry), run_name="__main__")
