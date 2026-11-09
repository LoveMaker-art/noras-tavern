import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
PROBE_PATH = REPO / "tooling" / "runtime" / "clawchat-bundle-check.py"
spec = importlib.util.spec_from_file_location("clawchat_bundle_check", PROBE_PATH)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ClawchatBundleCheckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.cache = self.home / "probe-cache.json"

    def tearDown(self):
        self.temporary.cleanup()

    def write_file(self, relative, data=b"fixture"):
        target = self.home / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target

    def components(self, files, terminal=None):
        value = {"schema": 1, "files": files,
                 "liveware": {"path": "clawchat/liveware/liveware", "sha256": files.get("clawchat/liveware/liveware", "0" * 64)}}
        if terminal:
            value["terminal"] = terminal
        return value

    PLUGIN_CONTENT = {
        "plugins/clawchat/plugin.yaml": b"yaml",
        "plugins/clawchat/__init__.py": b"init",
        "plugins/clawchat/clawchat_cli.py": b"cli",
        "clawchat/liveware/liveware": b"liveware",
    }

    def plugin_files(self):
        return {relative: sha256_of(data) for relative, data in self.PLUGIN_CONTENT.items()}

    def write_plugins(self):
        return {relative: self.write_file(relative, data) for relative, data in self.PLUGIN_CONTENT.items()}

    def test_hashed_files_pass_when_all_match(self):
        files = self.plugin_files()
        self.write_plugins()
        with patch.dict(os.environ, {"NORA_PROBE_CACHE": str(self.cache)}):
            probe.check_files(self.home, self.components(files))

    def test_hashed_files_reject_corrupt_content(self):
        files = self.plugin_files()
        self.write_plugins()
        (self.home / "clawchat/liveware/liveware").write_bytes(b"tampered")
        with patch.dict(os.environ, {"NORA_PROBE_CACHE": str(self.cache)}):
            with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                probe.check_files(self.home, self.components(files))

    def test_hashed_files_reject_missing_file(self):
        files = self.plugin_files()
        self.write_file("plugins/clawchat/plugin.yaml", b"yaml")
        with patch.dict(os.environ, {"NORA_PROBE_CACHE": str(self.cache)}):
            with self.assertRaisesRegex(RuntimeError, "Missing or unsafe"):
                probe.check_files(self.home, self.components(files))

    def test_resume_cache_skips_unchanged_files(self):
        files = self.plugin_files()
        self.write_plugins()
        with patch.dict(os.environ, {"NORA_PROBE_CACHE": str(self.cache)}):
            probe.check_files(self.home, self.components(files))
            self.assertTrue(self.cache.is_file(), "probe persists a resume cache")
            with patch.object(probe, "_hash_verified_file", side_effect=AssertionError("re-hash")):
                probe.check_files(self.home, self.components(files))

    def test_resume_cache_invalidates_after_change(self):
        files = self.plugin_files()
        targets = self.write_plugins()
        with patch.dict(os.environ, {"NORA_PROBE_CACHE": str(self.cache)}):
            probe.check_files(self.home, self.components(files))
            changed = targets["plugins/clawchat/clawchat_cli.py"]
            os.utime(changed, ns=(changed.stat().st_atime_ns + 1, changed.stat().st_mtime_ns + 1))
            calls = []
            with patch.object(probe, "_hash_verified_file", side_effect=lambda file: calls.append(file) or sha256_of(file.read_bytes())):
                probe.check_files(self.home, self.components(files))
            self.assertEqual(len(calls), 1, "only the touched file is re-hashed")

    def test_progress_heartbeats_emit_to_stderr(self):
        files = {f"dir/file-{index}": sha256_of(f"content-{index}".encode()) for index in range(5)}
        for relative, digest in files.items():
            self.write_file(relative, f"content-{relative.removeprefix('dir/file-')}".encode())
        stderr = io.StringIO()
        with patch.object(probe, "_PROGRESS_INTERVAL_FILES", 2), \
                patch.dict(os.environ, {"NORA_PROBE_CACHE": str(self.cache)}), \
                contextlib.redirect_stderr(stderr):
            probe._check_hashed_files(self.home, files, str(self.cache), {})
        lines = [line for line in stderr.getvalue().splitlines() if line.startswith("NORA_BUNDLE_PROGRESS=")]
        self.assertTrue(lines, "heartbeats are emitted")
        self.assertTrue(lines[-1].endswith("/5"), "final heartbeat reports completion")

    def tree_components(self):
        self.write_plugins()
        self.write_file("hermes-agent/vendor/git/bin/bash.exe", b"bash")
        self.write_file("hermes-agent/vendor/git/usr/bin/msys-2.0.dll", b"dll")
        self.write_file("hermes-agent/vendor/git/share/doc/manual.html", b"doc")
        seal = probe._seal_tree(self.home.resolve(), (self.home / "hermes-agent/vendor/git").resolve())
        terminal = {"kind": "git-bash", "command": "hermes-agent/vendor/git/bin/bash.exe", "tree": seal}
        return None, self.components(self.plugin_files(), terminal=terminal)

    def test_tree_seal_passes_for_intact_tree(self):
        _, components = self.tree_components()
        with patch.dict(os.environ, {"NORA_PROBE_CACHE": str(self.cache)}):
            probe.check_files(self.home, components)

    def test_tree_seal_rejects_deleted_file(self):
        _, components = self.tree_components()
        (self.home / "hermes-agent/vendor/git/share/doc/manual.html").unlink()
        with patch.dict(os.environ, {"NORA_PROBE_CACHE": str(self.cache)}):
            with self.assertRaisesRegex(RuntimeError, "tree seal mismatch"):
                probe.check_files(self.home, components)

    def test_tree_seal_rejects_resized_file(self):
        _, components = self.tree_components()
        (self.home / "hermes-agent/vendor/git/share/doc/manual.html").write_bytes(b"doc resized")
        with patch.dict(os.environ, {"NORA_PROBE_CACHE": str(self.cache)}):
            with self.assertRaisesRegex(RuntimeError, "tree seal mismatch"):
                probe.check_files(self.home, components)

    def test_legacy_terminal_files_still_fully_hashed(self):
        bash = self.write_file("hermes-agent/vendor/git/bin/bash.exe", b"bash")
        files = self.plugin_files()
        self.write_plugins()
        terminal = {"kind": "git-bash", "command": "hermes-agent/vendor/git/bin/bash.exe",
                    "files": {"hermes-agent/vendor/git/bin/bash.exe": sha256_of(b"bash")}}
        calls = []
        with patch.object(probe, "_hash_verified_file", side_effect=lambda file: calls.append(file) or sha256_of(file.read_bytes())):
            probe.check_files(self.home, self.components(files, terminal=terminal))
        self.assertEqual(len(calls), 5, "plugin and legacy terminal files are all hashed")

    def test_required_component_checksum_presence(self):
        files = {"clawchat/liveware/liveware": sha256_of(b"liveware")}
        self.write_file("clawchat/liveware/liveware", b"liveware")
        with self.assertRaisesRegex(RuntimeError, "Missing required component checksum"):
            probe.check_files(self.home, self.components(files))


if __name__ == "__main__":
    unittest.main()
