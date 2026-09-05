#!/usr/bin/env bash
set -euo pipefail

python_bin="${TAVERN_UPDATE_PYTHON:-/opt/hermes/.venv/bin/python3}"
if [[ ! -x "$python_bin" ]]; then
  python_bin="$(command -v python3 || command -v python)"
fi

exec "$python_bin" -B - "$@" <<'PY'
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request


HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))
API_URL = os.environ.get(
    "TAVERN_RELEASE_API_URL",
    "https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest",
)
MARKER = HOME / "apps/tavern-runtime/.tavern-release-version"
INSTALL_RECORD = HOME / "tavern-updates/installed.json"
NOTICE_STATE = HOME / "tavern-updates/notification-state.json"
LOG_FILE = HOME / "logs/nora-tavern-update-check.log"
SENDER = Path(os.environ.get("TAVERN_UPDATE_SENDER", HOME / "scripts/nora-tavern-card-send.py"))
SUMMARY_MAX_CHARS = 1200
SUMMARY_MAX_LINES = 10


def normalize_version(value: object) -> str:
    text = str(value or "").strip()
    return text[1:] if text.startswith("v") else text


def version_key(value: str):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?", value)
    if not match:
        raise RuntimeError(f"无法识别版本号：{value!r}")
    base = tuple(int(match.group(index)) for index in range(1, 4))
    prerelease = match.group(4)
    if prerelease is None:
        return base, 1, ()
    tokens = tuple(
        (0, int(token)) if token.isdigit() else (1, token.lower())
        for token in prerelease.split(".")
    )
    return base, 0, tokens


def installed_version() -> str:
    if MARKER.is_file():
        value = normalize_version(MARKER.read_text(encoding="utf-8"))
        version_key(value)
        return value
    if INSTALL_RECORD.is_file():
        value = normalize_version(json.loads(INSTALL_RECORD.read_text(encoding="utf-8")).get("version"))
        version_key(value)
        return value
    raise RuntimeError("未找到 Tavern 安装版本标记")


def release_summary(value: object) -> str:
    lines: list[str] = []
    in_code_block = False
    for raw_line in str(value or "").splitlines():
        line = raw_line.strip()
        if line.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block or not line or line.startswith("<!--"):
            continue
        heading = re.sub(r"^#{1,6}\s+", "", line).strip()
        if re.fullmatch(r"(?:更新命令|安装命令|update command|install command)[:：]?", heading, re.IGNORECASE):
            break
        if heading != line:
            continue
        if re.match(r"^(?:curl|wget)\s", line, re.IGNORECASE):
            continue
        plain = line.lstrip("> ").strip().casefold()
        if plain in {"用户数据尚未发生变化", "your data has not changed"}:
            continue
        lines.append(line)
        if len(lines) >= SUMMARY_MAX_LINES:
            break

    summary = "\n".join(lines)
    if len(summary) <= SUMMARY_MAX_CHARS:
        return summary
    return summary[: SUMMARY_MAX_CHARS - 1].rstrip() + "…"


def latest_release() -> tuple[str, str]:
    request = urllib.request.Request(
        API_URL,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "nora-tavern-update-check/2",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read(1024 * 1024))
    value = normalize_version(payload.get("tag_name"))
    version_key(value)
    return value, release_summary(payload.get("body"))


def load_notice_state() -> dict:
    try:
        value = json.loads(NOTICE_STATE.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def record_error(error: Exception) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    message = f"{dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} update check failed: {error}"
    with LOG_FILE.open("a", encoding="utf-8") as stream:
        stream.write(message + "\n")
    print(message, file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    installed = installed_version()
    latest, summary = latest_release()
    update_available = version_key(latest) > version_key(installed)
    result = {
        "installed": installed,
        "latest": latest,
        "updateAvailable": update_available,
    }
    if args.check_only:
        print(json.dumps(result, ensure_ascii=False))
        return 0
    if not update_available:
        return 0

    previous = load_notice_state()
    if normalize_version(previous.get("last_notified_latest")) == latest:
        return 0
    if not SENDER.is_file():
        raise RuntimeError(f"更新提醒发送器不存在：{SENDER}")
    subprocess.run(
        [
            sys.executable,
            str(SENDER),
            "--installed",
            installed,
            "--latest",
            latest,
            "--summary",
            summary,
        ],
        check=True,
        timeout=30,
    )
    atomic_json(
        NOTICE_STATE,
        {
            "last_notified_latest": latest,
            "last_notified_installed": installed,
            "last_notified_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
    )
    return 0


try:
    raise SystemExit(main())
except Exception as error:
    record_error(error)
    raise SystemExit(1)
PY
