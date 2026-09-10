"""Retire the greeting-order patch; the caller owns backup, swap and rollback.

The legacy patch filename and manifest field remain for bundle compatibility.
Its new digest identifies removal of the old ordering gates, not their presence.
"""
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

FILES = ("clawchat_gateway/adapter.py", "clawchat_gateway/storage.py")


def validate_independent_sources(directory):
    for relative in FILES:
        tree = ast.parse((Path(directory) / relative).read_text(encoding="utf-8"))
        if any(getattr(node, "name", None) == "has_sent_activation_bootstrap"
               or getattr(node, "attr", None) == "has_sent_activation_bootstrap"
               for node in ast.walk(tree)):
            raise ValueError("Legacy greeting gate is still present; source left unchanged")


def bundled_patch_ready(home):
    """Verified prepatched runtimes do not require Git on the user's computer."""
    home = Path(home)
    try:
        components = json.loads((home / "nora-components.json").read_text(encoding="utf-8"))
        expected = hashlib.sha256(Path(__file__).with_name("clawchat-greeting-order.patch").read_bytes()).hexdigest()
        if components.get("clawchat", {}).get("greetingPatchSha256") != expected:
            return False
        for relative in FILES:
            path = home / "plugins/clawchat" / relative
            key = "plugins/clawchat/" + relative
            if (path.is_symlink() or not path.resolve().is_relative_to(home.resolve())
                    or hashlib.sha256(path.read_bytes()).hexdigest() != components.get("files", {}).get(key)):
                return False
        return True
    except (OSError, ValueError, AttributeError):
        return False


def prepare(home, destination):
    plugin = Path(home) / "plugins/clawchat"
    destination = Path(destination)
    if not plugin.is_dir():
        return [], {"status": "not-installed"}
    if bundled_patch_ready(home):
        return [], {"status": "already-patched"}
    try:
        # Work only on these two source files, never the plugin checkout or user data.
        for relative in FILES:
            source = plugin / relative
            if source.is_symlink() or not source.is_file():
                raise ValueError("Missing or linked gateway source: " + relative)
            if plugin.resolve() not in source.resolve().parents:
                raise ValueError("Gateway source is outside plugin directory")
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        patch = Path(__file__).with_name("clawchat-greeting-order.patch")
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        # Staging may live inside a user's checkout. Do not let git discover it.
        env["GIT_CEILING_DIRECTORIES"] = str(destination.resolve().parent)

        def apply(*flags):
            return subprocess.run(
                ["git", "apply", *flags, str(patch)], cwd=destination,
                capture_output=True, text=True, timeout=15, env=env,
            ).returncode == 0

        # This patch reverses only our known ordering changes. Clean upstream
        # sources are already in the desired state; partial/unknown edits fail closed.
        if apply("--reverse", "--check"):
            validate_independent_sources(destination)
            return [], {"status": "already-patched"}
        if not apply("--check") or not apply():
            raise ValueError("Gateway source does not match the supported greeting patch; left unchanged")
        validate_independent_sources(destination)
        swaps = []
        for relative in FILES:
            prepared = destination / relative
            ast.parse(prepared.read_text(encoding="utf-8"), filename=relative)
            if prepared.read_bytes() == (plugin / relative).read_bytes():
                raise ValueError("Gateway patch did not change both expected files")
            swaps.append(("clawchat-greeting-" + Path(relative).stem, prepared, plugin / relative))
        return swaps, {"status": "prepared", "restartRequired": True}
    except (OSError, ValueError, SyntaxError, subprocess.SubprocessError) as error:
        return [], {"status": "pending", "warnings": [str(error)]}
