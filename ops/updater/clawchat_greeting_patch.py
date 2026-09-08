"""Stage the paired gateway fix; the caller owns backup, swap and rollback."""
import ast
import os
from pathlib import Path
import shutil
import subprocess

FILES = ("clawchat_gateway/adapter.py", "clawchat_gateway/storage.py")


def prepare(home, destination):
    plugin = Path(home) / "plugins/clawchat"
    destination = Path(destination)
    if not plugin.is_dir():
        return [], {"status": "not-installed"}
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

        if apply("--reverse", "--check"):
            return [], {"status": "already-patched"}
        if not apply("--check") or not apply():
            raise ValueError("Gateway source does not match the supported greeting patch; left unchanged")
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
