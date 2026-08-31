"""Opt-in actual Node lifecycle/MCP update and rollback on a private temporary instance."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile

OPS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / "updater"))
from bundle import digest, extract_bundle, read_bundle
from clean_update import CleanUpdater, MARKER


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-dir", type=Path, required=True)
    args = parser.parse_args()
    sha = digest((args.release_dir / "release-manifest.json").read_bytes())
    manifest = read_bundle(args.release_dir, sha, candidate=True)
    with tempfile.TemporaryDirectory(prefix="tavern-native-update-qa-") as temporary:
        root = Path(temporary).resolve()
        home = root / "hermes"
        home.mkdir()
        os.environ["HERMES_HOME"] = str(home)
        os.environ["TAVERN_PERSONALITY_FILE"] = str(home / "SOUL.md")
        for key in ("TAVERN_DATA_ROOT", "TAVERN_STATE_DIR", "TAVERN_APP_DIR"):
            os.environ.pop(key, None)
        stage = root / "initial"
        extract_bundle(args.release_dir, stage, manifest)
        (home / "apps").mkdir()
        shutil.copytree(stage / "app", home / "apps/tavern-runtime")
        shutil.copytree(stage / "nora-mcp", home / "apps/nora-mcp")
        shutil.copytree(stage / "ops", home / "apps/tavern-ops")
        (home / MARKER).write_text(json.dumps({'schema': 1, 'home': str(home), 'purpose': 'isolated-update-test'}))
        # A harmless code-only difference proves the real rollback restores the
        # former tree. No user's existing world/state/ports are used.
        old_marker = home / "apps/tavern-runtime/.tavern-release-version"
        old_marker.write_text("qa-before-upgrade\n")
        (home / "AGENTS.md").write_text("# Private QA instructions\nKeep this block.\n")
        (home / "config.yaml").write_text("model: {provider: qa-not-a-real-provider}\n")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        updater = CleanUpdater(home, port=port)
        lifecycle = updater.lifecycle
        runtime = lifecycle.runtime()
        runtime.install()
        cfg = runtime.config_path.read_bytes() + b"\n# operator setting must survive update\n"
        runtime.config_path.write_bytes(cfg)
        private = runtime.native_data_root / "default-user/qa-preserve.txt"
        private.parent.mkdir(parents=True, exist_ok=True)
        private.write_text("preserve original user state")
        try:
            before = runtime.start(port=port)
            review = updater.review(args.release_dir, sha, candidate=True)
            installed = updater.apply(review["transaction"], review["planDigest"])
            assert installed["status"] == "installed-awaiting-hermes-reload"
            assert installed["verification"]["nativePid"] != before["native_pid"]
            assert runtime.config_path.read_bytes() == cfg
            assert private.read_text() == "preserve original user state"
            wrapper = home / "skills/system/tavern-updater/scripts/update.py"
            assert wrapper.is_file()
            import subprocess
            subprocess.run([sys.executable, str(wrapper), "--help"], check=True, stdout=subprocess.DEVNULL)
            updater.rollback(review["transaction"], review["planDigest"])
            assert old_marker.read_text() == "qa-before-upgrade\n"
            assert runtime.config_path.read_bytes() == cfg
            assert private.read_text() == "preserve original user state"
            assert (home / "AGENTS.md").read_text() == "# Private QA instructions\nKeep this block.\n"
            assert lifecycle.runtime().health(port)["ok"]
            print(json.dumps({"actualNodeUpdate": True, "actualNodeRollback": True,
                              "newMcpStdio": installed["verification"]["newMcpProcess"],
                              "userConfigAndStatePreserved": True, "livewareDeployment": False,
                              "manifestSha256": sha, "port": port}, indent=2))
        finally:
            lifecycle.stop()


if __name__ == "__main__":
    main()
