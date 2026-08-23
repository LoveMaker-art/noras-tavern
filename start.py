#!/usr/bin/env python3
"""One-command standalone launcher for Tavern."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from urllib.parse import urlparse
import venv


ROOT = Path(__file__).resolve().parent
ENV_FILE = ROOT / ".env"
ENV_EXAMPLE = ROOT / ".env.example"
VENV_DIR = ROOT / ".venv"
REQUIREMENTS = ROOT / "requirements.txt"
PLACEHOLDERS = {
    "https://your-provider.example/v1",
    "replace-with-your-key",
    "your-model-id",
}


def fail(message: str) -> None:
    print(f"\nError: {message}", file=sys.stderr)
    raise SystemExit(1)


def require_supported_python() -> None:
    if sys.version_info >= (3, 10):
        return
    for command in ("python3.13", "python3.12", "python3.11", "python3.10"):
        candidate = shutil.which(command)
        if candidate:
            print(f"Switching to {command} because the current Python is too old...")
            os.execv(candidate, [candidate, str(Path(__file__).resolve()), *sys.argv[1:]])
    fail(
        f"Python 3.10 or newer is required; current version is "
        f"{sys.version_info.major}.{sys.version_info.minor}. Install a current Python and retry."
    )


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            fail(f"{path} line {line_number} must use NAME=value syntax")
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def replace_env_value(text: str, key: str, value: str) -> str:
    safe = value.replace("\\", "\\\\").replace('"', '\\"')
    replacement = f'{key}="{safe}"'
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.lstrip().startswith(f"{key}="):
            lines[index] = replacement
            break
    else:
        lines.append(replacement)
    return "\n".join(lines) + "\n"


def prompt_value(label: str, current: str = "", *, secret: bool = False,
                 allow_empty: bool = False) -> str:
    while True:
        suffix = (
            f" [{current}]"
            if not secret and current and current not in PLACEHOLDERS
            else ""
        )
        prompt = f"{label}{suffix}: "
        value = getpass.getpass(prompt) if secret else input(prompt)
        value = value.strip() or (current if current not in PLACEHOLDERS else "")
        if value or allow_empty:
            return value
        print("This value is required.")


def normalize_api_base(value: str) -> str:
    base = value.strip().rstrip("/")
    suffix = "/chat/completions"
    if base.endswith(suffix):
        base = base[:-len(suffix)].rstrip("/")
        print(f"Using API base URL: {base}")
    parsed = urlparse(base)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        fail("API base URL must be an http:// or https:// address")
    return base


def configure(force: bool = False) -> None:
    file_values = parse_env(ENV_FILE)
    effective = {**file_values, **{key: value for key, value in os.environ.items() if key.startswith("TAVERN_")}}
    required_ready = all(
        effective.get(key, "").strip() not in ("", *PLACEHOLDERS)
        for key in ("TAVERN_MODEL_BASE", "TAVERN_MODEL")
    ) and effective.get("TAVERN_MODEL_KEY", "").strip() not in PLACEHOLDERS
    if required_ready and not force:
        return
    if not sys.stdin.isatty():
        fail(f"model configuration is incomplete; edit {ENV_FILE}")

    print("\nFirst-time setup: enter your OpenAI-compatible model details.")
    base = normalize_api_base(
        prompt_value("API base URL", effective.get("TAVERN_MODEL_BASE", ""))
    )
    key = prompt_value(
        "API key (leave empty only if your endpoint requires no authentication)",
        effective.get("TAVERN_MODEL_KEY", ""), secret=True, allow_empty=True,
    )
    model = prompt_value("Model ID", effective.get("TAVERN_MODEL", ""))

    template = ENV_FILE.read_text(encoding="utf-8") if ENV_FILE.exists() else ENV_EXAMPLE.read_text(encoding="utf-8")
    for name, value in (
        ("TAVERN_MODEL_BASE", base),
        ("TAVERN_MODEL_KEY", key),
        ("TAVERN_MODEL", model),
    ):
        template = replace_env_value(template, name, value)
    ENV_FILE.write_text(template, encoding="utf-8")
    try:
        ENV_FILE.chmod(0o600)
    except OSError:
        pass
    print(f"Configuration saved to {ENV_FILE}")


def effective_config() -> dict[str, str]:
    return {
        **parse_env(ENV_FILE),
        **{key: value for key, value in os.environ.items() if key.startswith("TAVERN_")},
    }


def check_listen_address(port_override: int | None = None) -> None:
    config = effective_config()
    host = config.get("TAVERN_HOST", "127.0.0.1") or "127.0.0.1"
    try:
        port = port_override or int(config.get("TAVERN_PORT", "8799") or "8799")
    except ValueError:
        fail("TAVERN_PORT must be a number between 1 and 65535")
    if not 1 <= port <= 65535:
        fail("TAVERN_PORT must be a number between 1 and 65535")
    with socket.socket() as probe:
        try:
            probe.bind((host, port))
        except OSError:
            fail(
                f"{host}:{port} is already in use. Tavern may already be running at "
                f"http://{host}:{port}; otherwise choose another TAVERN_PORT in .env."
            )


def venv_python() -> Path:
    return VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def requirements_digest() -> str:
    return hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()


def prepare_environment(skip_install: bool = False) -> Path:
    python = venv_python()
    if not python.exists():
        print("Creating the local Python environment...")
        venv.EnvBuilder(with_pip=True).create(VENV_DIR)
    marker = VENV_DIR / ".tavern-requirements.sha256"
    digest = requirements_digest()
    if not skip_install and (not marker.exists() or marker.read_text(encoding="utf-8").strip() != digest):
        print("Installing Tavern dependencies...")
        result = subprocess.run(
            [str(python), "-m", "pip", "install", "-r", str(REQUIREMENTS)],
            cwd=ROOT,
        )
        if result.returncode:
            fail("dependency installation failed; review the pip output above")
        marker.write_text(digest + "\n", encoding="utf-8")
    return python


def main() -> int:
    parser = argparse.ArgumentParser(description="Configure and start Tavern.")
    parser.add_argument("--configure", action="store_true", help="edit model configuration interactively")
    parser.add_argument("--check", action="store_true", help="validate setup without starting Tavern")
    parser.add_argument("--no-install", action="store_true", help="do not install missing dependencies")
    parser.add_argument("--port", type=int, help="override TAVERN_PORT for this run")
    args, server_args = parser.parse_known_args()

    require_supported_python()
    os.chdir(ROOT)
    configure(force=args.configure)
    python = prepare_environment(skip_install=args.no_install)
    if args.check:
        print("Tavern setup is ready.")
        return 0

    check_listen_address(args.port)
    print("Starting Tavern. Press Ctrl+C to stop it.\n")
    if args.port:
        server_args.extend(["--port", str(args.port)])
    try:
        return subprocess.call(
            [str(python), str(ROOT / "app/backend/server.py"), *server_args],
            cwd=ROOT,
        )
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
