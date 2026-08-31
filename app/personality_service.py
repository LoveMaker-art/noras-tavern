"""Safe access to the optional Agent personality document."""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path


MAX_PERSONALITY_CHARS = 20_000


class PersonalityConflict(ValueError):
    """Raised when the document changed after the editor loaded it."""


def configured_path() -> Path | None:
    raw = os.environ.get("TAVERN_PERSONALITY_FILE", "").strip()
    return Path(raw).expanduser().resolve() if raw else None


def _revision(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def read_document() -> dict:
    path = configured_path()
    if path is None:
        return {"supported": False, "content": "", "revision": "", "max_chars": MAX_PERSONALITY_CHARS}
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        content = ""
    return {
        "supported": True,
        "content": content,
        "revision": _revision(content),
        "max_chars": MAX_PERSONALITY_CHARS,
    }


def write_document(content: object, expected_revision: object) -> dict:
    path = configured_path()
    if path is None:
        raise ValueError("personality editing is not configured")
    if not isinstance(content, str):
        raise ValueError("content must be a string")
    content = content.strip()
    if not content:
        raise ValueError("personality document cannot be empty")
    if len(content) > MAX_PERSONALITY_CHARS:
        raise ValueError(f"personality document exceeds {MAX_PERSONALITY_CHARS} characters")

    current = read_document()
    if str(expected_revision or "") != current["revision"]:
        raise PersonalityConflict("personality document changed; reload before saving")

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return read_document()
