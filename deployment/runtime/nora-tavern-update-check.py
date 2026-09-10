from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request


HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path(__file__).resolve().parents[1])).expanduser().resolve()
INSTANCE = HERMES_HOME / "nora-instance.json"


def installed_data_root():
    config_path = HERMES_HOME / "config.yaml"
    bound = INSTANCE.is_file()
    if config_path.is_file() and not bound:
        import yaml
        config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        bound = "nora" in config.get("mcp_servers", {})
    if bound:
        spec = importlib.util.spec_from_file_location("update_check_instance", Path(__file__).with_name("nora-instance.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        root = Path(module.configuration(HERMES_HOME)["installRoot"]).resolve()
        if not INSTANCE.is_file() and os.environ.get("TAVERN_DATA_ROOT") and Path(os.environ["TAVERN_DATA_ROOT"]).expanduser().resolve() != root:
            raise RuntimeError("安装目录与 MCP 绑定冲突，已停止版本检查")
        return root
    return Path(os.environ.get("TAVERN_DATA_ROOT") or HERMES_HOME).expanduser().resolve()


DATA_ROOT = installed_data_root()
CHANNEL = json.loads(INSTANCE.read_text(encoding="utf-8")).get("releaseChannel", "stable") if INSTANCE.is_file() else "stable"
API_URL = os.environ.get(
    "TAVERN_RELEASE_API_URL",
    "https://api.github.com/repos/LoveMaker-art/noras-tavern/releases?per_page=100" if CHANNEL == 'beta'
    else "https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest",
)
MARKER = DATA_ROOT / "apps/tavern-runtime/.tavern-release-version"
INSTALL_RECORD = DATA_ROOT / "tavern-updates/installed.json"
NOTICE_STATE = DATA_ROOT / "tavern-updates/notification-state.json"
LOG_FILE = HERMES_HOME / "logs/nora-tavern-update-check.log"
SENDER = Path(os.environ.get("TAVERN_UPDATE_SENDER", HERMES_HOME / "scripts/nora-tavern-card-send.py"))
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
    if CHANNEL == 'beta':
        releases = [item for item in payload if isinstance(item, dict) and not item.get('draft')
                    and item.get('prerelease') and re.fullmatch(r'v?\d+\.\d+\.\d+-beta\.\d+', item.get('tag_name', ''))]
        if not releases:
            raise RuntimeError('尚未发布 Beta 测试版本')
        payload = max(releases, key=lambda item: version_key(normalize_version(item['tag_name'])))
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


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        record_error(error)
        raise SystemExit(1)
