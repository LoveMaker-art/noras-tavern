"""Offline installation probe; no activation, credentials, or network requests."""

import hashlib
import asyncio
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys


def check_files(home, components):
    for relative, expected in components["files"].items():
        file = (home / relative).resolve()
        if not file.is_relative_to(home.resolve()) or not file.is_file():
            raise RuntimeError("Missing or unsafe bundled component: " + relative)
        if hashlib.sha256(file.read_bytes()).hexdigest() != expected:
            raise RuntimeError("Bundled component checksum mismatch: " + relative)
    for relative in ("plugins/clawchat/plugin.yaml", "plugins/clawchat/__init__.py",
                     "plugins/clawchat/clawchat_cli.py", components["liveware"]["path"]):
        if relative not in components["files"]:
            raise RuntimeError("Missing required component checksum: " + relative)


def check(home):
    components = json.loads((home / "nora-components.json").read_text(encoding="utf-8"))
    check_files(home, components)
    liveware = home / components["liveware"]["path"]
    result = subprocess.run([str(liveware), "--help"], capture_output=True, timeout=15)
    if result.returncode:
        raise RuntimeError("Bundled Liveware cannot execute")

    # A readiness check must not silently download a missing dependency or call a model.
    network_attempts = []
    def offline(event, args):
        if event in {"socket.connect", "socket.getaddrinfo"}:
            network_attempts.append(event)
            raise RuntimeError("Network access is forbidden during the offline bundle probe")
    with asyncio.Runner() as runner:
        # Windows builds its event-loop wakeup socketpair using local TCP.
        runner.get_loop()
        sys.addaudithook(offline)
        sys.path.insert(0, str(home / "hermes-agent"))
        from hermes_cli.plugins_cmd import cmd_enable
        cmd_enable("clawchat", allow_tool_override=False)
        from hermes_cli.plugins import get_plugin_manager
        manager = get_plugin_manager()
        manager.discover_and_load()
        plugin = next((p for p in manager.list_plugins() if p["name"] == "clawchat"), None)
        if not plugin or not plugin["enabled"] or plugin["error"] or not plugin["tools"] or not plugin["hooks"]:
            raise RuntimeError("ClawChat registration failed: " + json.dumps(plugin))
        sys.path.insert(0, str(home / "plugins/clawchat"))
        from clawchat_gateway.adapter import ClawChatAdapter
        from clawchat_gateway.liveware_cli import resolve_liveware_path, wait_liveware_cli_ready
        runner.run(wait_liveware_cli_ready())
    if network_attempts:
        raise RuntimeError("ClawChat attempted network access during offline registration")
    resolved = resolve_liveware_path()
    if Path(shutil.which(resolved or '') or resolved or "").resolve() != liveware.resolve():
        raise RuntimeError("Liveware did not resolve to the bundled executable")
    print(json.dumps({"ok": True, "clawchat": plugin["version"], "liveware": "ready",
                      "tools": plugin["tools"], "hooks": plugin["hooks"]}))


if __name__ == "__main__":
    check(Path(os.environ["HERMES_HOME"]))
