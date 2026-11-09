"""Offline installation probe; no activation, credentials, or network requests."""

import hashlib
import asyncio
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile


_PROGRESS_INTERVAL_FILES = 200


def _progress(step):
    # Call sites use fixed stage literals only: no paths, config, or credentials.
    # Flush before each check so a deadline still identifies the pending stage.
    print("NORA_BUNDLE_STEP=" + step, file=sys.stderr, flush=True)


def _progress_files(current, total):
    print(f"NORA_BUNDLE_PROGRESS={current}/{total}", file=sys.stderr, flush=True)


_CACHE_FLUSH_EVERY = 50


def _load_cache():
    raw = os.environ.get("NORA_PROBE_CACHE")
    if not raw:
        return None, {}
    try:
        data = json.loads(Path(raw).read_text(encoding="utf-8"))
        if data.get("schema") == 1 and isinstance(data.get("verified"), dict):
            return raw, data["verified"]
    except (OSError, ValueError):
        pass
    return raw, {}


def _save_cache(path, verified):
    if not path:
        return
    payload = json.dumps({"schema": 1, "verified": verified}, separators=(",", ":"))
    try:
        target = Path(path)
        fd, temporary = tempfile.mkstemp(prefix=target.name + ".", dir=str(target.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    except OSError:
        # The cache is an optimisation only; verification correctness never
        # depends on being able to persist it.
        pass


def check_terminal(home, components):
    """Exercise Hermes' actual Windows backend without installing host software."""
    terminal = components.get("terminal", {})
    relative = "hermes-agent/vendor/git/bin/bash.exe"
    if terminal.get("kind") != "git-bash" or terminal.get("command") != relative:
        raise RuntimeError("Missing bundled Git Bash; use the complete Windows runtime")
    if not (home / relative).is_file():
        raise RuntimeError("Bundled Git Bash has no component checksum")
    os.environ["HERMES_GIT_BASH_PATH"] = str(home / relative)
    from tools.environments.local import LocalEnvironment
    shell = LocalEnvironment(cwd=str(home), timeout=15)
    result = shell.execute("printf NORA_SHELL_READY", timeout=15)
    if result.get("returncode") != 0 or result.get("output", "").strip() != "NORA_SHELL_READY":
        raise RuntimeError("Bundled Hermes terminal cannot execute")


def _hash_verified_file(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def _check_hashed_files(home, expected, cache_path, cached):
    """Verify a small per-file checksum map, resuming from the cache when possible."""
    pending = list(expected.items())
    total = len(pending)
    verified = dict(cached) if cached else {}
    since_flush = 0
    for index, (relative, wanted) in enumerate(pending, start=1):
        file = (home / relative).resolve()
        if not file.is_relative_to(home.resolve()) or not file.is_file():
            raise RuntimeError("Missing or unsafe bundled component: " + relative)
        stat = file.stat()
        entry = verified.get(relative)
        if entry and entry.get("size") == stat.st_size and entry.get("mtime_ns") == stat.st_mtime_ns \
                and entry.get("sha256") == wanted:
            digest = wanted
        else:
            digest = _hash_verified_file(file)
            if digest != wanted:
                raise RuntimeError("Bundled component checksum mismatch: " + relative)
            verified[relative] = {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "sha256": digest}
            since_flush += 1
            if cache_path and since_flush >= _CACHE_FLUSH_EVERY:
                _save_cache(cache_path, verified)
                since_flush = 0
        if index % _PROGRESS_INTERVAL_FILES == 0 or index == total:
            _progress_files(index, total)
    if cache_path:
        _save_cache(cache_path, verified)


def _seal_tree(home, root):
    """Aggregate seal over name+size pairs; stat-only, no content reads."""
    entries = []
    def visit(directory):
        for child in sorted(os.listdir(directory)):
            file = os.path.join(directory, child)
            relative = os.path.relpath(file, home).replace(os.sep, '/')
            stat = os.lstat(file)
            if os.path.islink(file):
                raise RuntimeError("Bundled component tree has an unexpected symbolic link: " + relative)
            if os.path.isdir(file):
                visit(file)
            elif os.path.isfile(file):
                entries.append((relative, stat.st_size))
            else:
                raise RuntimeError("Bundled component tree has an unexpected entry: " + relative)
    visit(str(root))
    aggregate = hashlib.sha256()
    for name, size in sorted(entries):
        aggregate.update(name.encode("utf-8"))
        aggregate.update(b"\0")
        aggregate.update(str(size).encode("ascii"))
        aggregate.update(b"\0")
    return {"schema": 1, "files": len(entries), "bytes": sum(size for _, size in entries),
            "sha256": aggregate.hexdigest()}


def _check_tree(home, terminal):
    """Verify a sealed component tree (name+size aggregate) without reading content."""
    command = terminal.get("command", "")
    if not command:
        raise RuntimeError("Bundled terminal component is missing its command")
    root = (home / command).resolve().parent.parent
    home_resolved = home.resolve()
    if not root.is_relative_to(home_resolved):
        raise RuntimeError("Bundled terminal tree escapes the runtime home")
    if not root.is_dir():
        raise RuntimeError("Bundled component tree is missing: " + command)
    _progress_files(0, 1)
    actual = _seal_tree(home_resolved, root)
    _progress_files(1, 1)
    expected = terminal["tree"]
    if actual["sha256"] != expected["sha256"] or actual["files"] != expected["files"] \
            or actual["bytes"] != expected["bytes"]:
        raise RuntimeError("Bundled component tree seal mismatch: " + command)


def check_files(home, components):
    cache_path, cached = _load_cache()
    _check_hashed_files(home, components["files"], cache_path, cached)
    terminal = components.get("terminal", {})
    if terminal.get("tree"):
        _check_tree(home, terminal)
    elif terminal.get("files"):
        # Legacy manifests seal every extracted Portable Git file individually.
        _check_hashed_files(home, terminal["files"], cache_path, cached)
    for relative in ("plugins/clawchat/plugin.yaml", "plugins/clawchat/__init__.py",
                     "plugins/clawchat/clawchat_cli.py", components["liveware"]["path"]):
        if relative not in components["files"]:
            raise RuntimeError("Missing required component checksum: " + relative)


def check(home):
    _progress("components_files")
    components = json.loads((home / "nora-components.json").read_text(encoding="utf-8"))
    check_files(home, components)
    liveware = home / components["liveware"]["path"]
    _progress("liveware_help")
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
        if sys.platform == "win32":
            _progress("windows_terminal")
            check_terminal(home, components)
        _progress("plugin_enable")
        from hermes_cli.plugins_cmd import cmd_enable
        cmd_enable("clawchat", allow_tool_override=False)
        _progress("plugin_discovery")
        from hermes_cli.plugins import get_plugin_manager
        manager = get_plugin_manager()
        manager.discover_and_load()
        plugin = next((p for p in manager.list_plugins() if p["name"] == "clawchat"), None)
        if not plugin or not plugin["enabled"] or plugin["error"] or not plugin["tools"] or not plugin["hooks"]:
            raise RuntimeError("ClawChat registration failed: " + json.dumps(plugin))
        _progress("adapter_import")
        sys.path.insert(0, str(home / "plugins/clawchat"))
        from clawchat_gateway.adapter import ClawChatAdapter
        from clawchat_gateway.liveware_cli import resolve_liveware_path, wait_liveware_cli_ready
        _progress("liveware_ready")
        runner.run(wait_liveware_cli_ready())
    if network_attempts:
        raise RuntimeError("ClawChat attempted network access during offline registration")
    _progress("liveware_resolve")
    resolved = resolve_liveware_path()
    if Path(shutil.which(resolved or '') or resolved or "").resolve() != liveware.resolve():
        raise RuntimeError("Liveware did not resolve to the bundled executable")
    _progress("complete")
    print(json.dumps({"ok": True, "clawchat": plugin["version"], "liveware": "ready",
                      "tools": plugin["tools"], "hooks": plugin["hooks"]}))


if __name__ == "__main__":
    check(Path(os.environ["HERMES_HOME"]))
