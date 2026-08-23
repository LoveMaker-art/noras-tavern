"""Minimal .env loading for standalone Tavern deployments.

The loader intentionally has no third-party dependency so configuration is
available before the rest of the backend is imported.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path


_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _decode_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return json.loads(value)
    comment = value.find(" #")
    return value[:comment].rstrip() if comment >= 0 else value


def load_env_file(path: Path, *, override: bool = False) -> bool:
    """Load a simple dotenv file without overriding process configuration."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return False

    for line_number, raw_line in enumerate(lines, 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ValueError(f"invalid .env line {line_number}: expected NAME=value")
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not _KEY_RE.fullmatch(key):
            raise ValueError(f"invalid .env line {line_number}: invalid variable name")
        if override or key not in os.environ:
            os.environ[key] = _decode_value(raw_value)
    return True


def load_standalone_env(server_file: str) -> Path | None:
    """Load an explicit or source-checkout .env and return its path."""
    explicit = os.environ.get("TAVERN_ENV_FILE", "").strip()
    candidates = [Path(explicit).expanduser()] if explicit else [Path.cwd() / ".env"]

    server_path = Path(server_file).resolve()
    if server_path.parent.name == "backend" and server_path.parent.parent.name == "app":
        candidates.append(server_path.parents[2] / ".env")

    seen = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if load_env_file(resolved):
            return resolved
    return None
