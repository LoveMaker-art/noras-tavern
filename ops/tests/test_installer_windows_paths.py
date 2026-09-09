"""Long-path regressions; the native Windows case also runs with LongPathsEnabled=0 in CI."""
import builtins
import errno
import hashlib
import importlib.util
import io
import json
import ntpath
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("installer_paths_under_test", ROOT / "ops/installer/first_install.py")
INSTALLER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = INSTALLER
SPEC.loader.exec_module(INSTALLER)
WORKER = "app/engine/sillytavern/node_modules/@jsquash/oxipng/codec/pkg-parallel/snippets/wasm-bindgen-rayon-3e04391371ad0a8e/src/workerHelpers.worker.js"
WINDOWS_HOME = r"C:\Users\ROG\AppData\Local\NoraTavern-Tests\launcher-candidate-38e8e898aecc"


def dependency_fixture(directory, member=WORKER):
    directory.mkdir(parents=True)
    archive = directory / "dependencies.tar.gz"
    with tarfile.open(archive, "w:gz") as stream:
        entry = tarfile.TarInfo("nora-mcp/node_modules/zod/v4/mini")
        entry.type = tarfile.DIRTYPE
        stream.addfile(entry)
        item = tarfile.TarInfo(member)
        item.size = len(b"worker fixture")
        stream.addfile(item, io.BytesIO(b"worker fixture"))
    platform, arch = INSTALLER.runtime_platform()
    (directory / "nora-tavern-dependencies.json").write_text(json.dumps({
        "schema": 1, "platform": platform, "arch": arch,
        "archive": archive.name, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    }), encoding="utf-8")


class InstallerPathTests(unittest.TestCase):
    def test_archive_directory_metadata_normalizes_extended_windows_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dependency_fixture(root / "payload")
            extractall = tarfile.TarFile.extractall
            observed = []
            def checked_extract(stream, destination, *, members):
                for member in members:
                    if member.isdir():
                        self.assertEqual(member.name, str(Path("nora-mcp/node_modules/zod/v4/mini")))
                        observed.append(member.name)
                return extractall(stream, destination, members=members)
            with patch.object(tarfile.TarFile, "extractall", checked_extract):
                INSTALLER.extract_dependency_bundle(root / "payload", root / "source")
            self.assertEqual(len(observed), 1)
            self.assertTrue((root / "source/nora-mcp/node_modules/zod/v4/mini").is_dir())

    def test_install_extracts_reported_worker_with_simulated_legacy_windows_limit(self):
        # Exercise real install staging and tar extraction. Only the OS path limit is simulated.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            home, release = root / "home", root / "payload"
            cache = home / "cache/tmp"
            cache.mkdir(parents=True)
            dependency_fixture(release)
            original_open = builtins.open
            observed = []

            def legacy_open(file, *args, **kwargs):
                if not isinstance(file, int):
                    value = os.fspath(file)
                    if not value.startswith("\\\\?\\"):
                        path = Path(value)
                        if path.is_relative_to(home) and path.name == "workerHelpers.worker.js":
                            projected = ntpath.join(WINDOWS_HOME, *path.relative_to(home).parts)
                            observed.append(len(projected))
                            if len(projected) >= 260:
                                raise FileNotFoundError(errno.ENOENT, "Simulated Windows MAX_PATH", projected)
                return original_open(file, *args, **kwargs)

            def extract_then_stop(_args, work):
                with patch.object(tarfile, "bltn_open", side_effect=legacy_open):
                    INSTALLER.extract_dependency_bundle(release, work / "source")
                raise RuntimeError("fixture extraction completed")

            args = SimpleNamespace(apply=True, confirm=True, nora_home=str(home),
                hermes_home=str(home / "hermes"), install_root=str(home / "tavern"),
                port=18899, dedicated_nora=True, force_first_install=False)
            with patch.dict(os.environ), patch.object(tempfile, "tempdir", str(cache)), \
                 patch.object(INSTALLER, "validate_hermes", return_value={}), \
                 patch.object(INSTALLER, "source_from_release", side_effect=extract_then_stop), \
                 patch.object(INSTALLER, "event"):
                with self.assertRaisesRegex(RuntimeError, "fixture extraction completed"):
                    INSTALLER.install(args)
            if os.name != "nt":
                self.assertTrue(observed)
                self.assertLess(max(observed), 260)
            self.assertFalse(list(home.rglob("workerHelpers.worker.js")), "temporary files must be cleaned after failure")

    def test_windows_path_conversion_handles_drive_unc_and_existing_prefix(self):
        cases = [
            (r"C:\Nora\cache\..\source", "\\\\?\\C:\\Nora\\source"),
            (r"\\server\share\Nora\source", "\\\\?\\UNC\\server\\share\\Nora\\source"),
            ("\\\\?\\C:\\Nora\\source", "\\\\?\\C:\\Nora\\source"),
            ("\\\\?\\UNC\\server\\share\\Nora", "\\\\?\\UNC\\server\\share\\Nora"),
        ]
        with patch.object(INSTALLER.os, "name", "nt"):
            for path, expected in cases:
                self.assertEqual(INSTALLER.filesystem_path(path), expected)

    def test_non_windows_paths_are_unchanged(self):
        with patch.object(INSTALLER.os, "name", "posix"):
            self.assertEqual(INSTALLER.filesystem_path("/tmp/Nora Tavern/source"), "/tmp/Nora Tavern/source")

    def test_archive_traversal_is_still_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dependency_fixture(root / "payload", "../escape.js")
            with self.assertRaisesRegex(RuntimeError, "非法路径"):
                INSTALLER.extract_dependency_bundle(root / "payload", root / "source")
            self.assertFalse((root / "escape.js").exists())

    @unittest.skipIf(os.name == "nt", "creating Windows symlinks may require developer mode")
    def test_workspace_rejects_a_link_outside_the_isolated_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home, outside = root / "home", root / "outside"
            home.mkdir()
            outside.mkdir()
            (home / ".tmp").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "越过隔离目录"):
                INSTALLER.install_workspace(home)
            self.assertEqual(list(outside.iterdir()), [])

    @unittest.skipUnless(os.name == "nt", "requires native Windows filesystem")
    def test_native_long_path_extract_copy_backup_restore_and_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / ("中文用户-" + "x" * max(20, 175 - len(str(root))))
            home.mkdir()
            dependency_fixture(root / "payload")
            try:
                with INSTALLER.install_workspace(home) as temporary_work:
                    source = Path(temporary_work) / "source"
                    INSTALLER.extract_dependency_bundle(root / "payload", source)
                    target = home / "tavern/apps/tavern-runtime"
                    worker = target / WORKER.removeprefix("app/")
                    self.assertGreater(len(str(worker)), 260)
                    INSTALLER.copy_tree(source / "app", target)
                    backup = home / "backups/first-install/tavern"
                    records = INSTALLER.snapshot_targets(home, [target], backup)
                    Path(INSTALLER.filesystem_path(worker)).write_bytes(b"changed")
                    INSTALLER.restore_targets(home, records, backup)
                    self.assertEqual(Path(INSTALLER.filesystem_path(worker)).read_bytes(), b"worker fixture")
                self.assertFalse(Path(temporary_work).exists(), "workspace cleanup must support long descendants")
            finally:
                shutil.rmtree(INSTALLER.filesystem_path(home))


if __name__ == "__main__":
    unittest.main()
