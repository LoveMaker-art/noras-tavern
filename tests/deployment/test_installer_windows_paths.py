"""Long-path regressions; the native Windows case also runs with LongPathsEnabled=0 in CI."""
import builtins
from contextlib import ExitStack
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
import traceback
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("installer_paths_under_test", ROOT / "ops/installer/first_install.py")
INSTALLER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = INSTALLER
SPEC.loader.exec_module(INSTALLER)
WORKER = "app/engine/sillytavern/node_modules/@jsquash/oxipng/codec/pkg-parallel/snippets/wasm-bindgen-rayon-3e04391371ad0a8e/src/workerHelpers.worker.js"
# Preserve the reported MAX_PATH fixture length without a person's machine name.
WINDOWS_HOME = r"C:\Users\Usr\AppData\Local\NoraTavern-Tests\launcher-candidate-000000000000"


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
        self.native_long_path_extract_copy_backup_restore_and_cleanup()

    @unittest.skipUnless(os.name == "nt", "requires native Windows filesystem")
    def test_native_restore_stage_with_simulated_legacy_directory_limit(self):
        # Keep the real Windows filesystem and the product's default journal
        # location. Only legacy mkdir/stat/open limits are simulated on policy=1.
        original_mkdir, original_stat, original_lstat = os.mkdir, os.stat, os.lstat
        original_open, original_io_open, original_os_open = builtins.open, io.open, os.open
        observed = []

        def legacy_path(path, operation, limit):
            if isinstance(path, int):
                return
            value = os.fsdecode(path)
            extended = value.startswith("\\\\?\\")
            logical = value[8:] if value.startswith("\\\\?\\UNC\\") else value[4:] if extended else value
            if "nora-native-paths-" in logical and len(logical) > limit:
                observed.append({"path": value, "extended": extended, "length": len(logical), "operation": operation})
                if not extended:
                    raise OSError(0, "Simulated legacy Windows filesystem length limit", value, 206)

        def legacy_mkdir(path, *args, **kwargs):
            legacy_path(path, "mkdir", 248)
            return original_mkdir(path, *args, **kwargs)

        def legacy_stat(path, *args, **kwargs):
            legacy_path(path, "stat", 259)
            return original_stat(path, *args, **kwargs)

        def legacy_lstat(path, *args, **kwargs):
            legacy_path(path, "lstat", 259)
            return original_lstat(path, *args, **kwargs)

        def legacy_open(path, *args, **kwargs):
            legacy_path(path, "open", 259)
            return original_open(path, *args, **kwargs)

        def legacy_io_open(path, *args, **kwargs):
            legacy_path(path, "io.open", 259)
            return original_io_open(path, *args, **kwargs)

        def legacy_os_open(path, *args, **kwargs):
            legacy_path(path, "os.open", 259)
            return original_os_open(path, *args, **kwargs)

        with ExitStack() as stack:
            for owner, name, replacement in [(os, "mkdir", legacy_mkdir), (os, "stat", legacy_stat),
                    (os, "lstat", legacy_lstat), (builtins, "open", legacy_open),
                    (io, "open", legacy_io_open), (os, "open", legacy_os_open)]:
                stack.enter_context(patch.object(owner, name, side_effect=replacement))
            self.native_long_path_extract_copy_backup_restore_and_cleanup()
        self.assertTrue(any(item["operation"] == "mkdir" and "first-install" in item["path"] for item in observed),
            "the product's default journal/restore/archive directory must exercise legacy mkdir limits")
        self.assertTrue(any(item["operation"] in ("stat", "lstat", "open", "io.open", "os.open")
            and "backups" in item["path"] for item in observed), "the real deep backup must exercise legacy file limits")
        self.assertTrue(all(item["extended"] for item in observed), observed)

    def native_long_path_extract_copy_backup_restore_and_cleanup(self):
        # Own the outer directory explicitly: TemporaryDirectory's implicit
        # cleanup could hide the recovery error behind another MAX_PATH error.
        root = Path(tempfile.mkdtemp(prefix="nora-native-paths-")).resolve()
        primary = None
        try:
            home = root / ("中文用户-" + "x" * max(20, 175 - len(str(root))))
            home.mkdir()
            dependency_fixture(root / "payload")
            with INSTALLER.install_workspace(home) as temporary_work:
                source = Path(temporary_work) / "source"
                INSTALLER.extract_dependency_bundle(root / "payload", source)
                target = home / "tavern/apps/tavern-runtime"
                worker = target / WORKER.removeprefix("app/")
                self.assertGreater(len(str(worker)), 260)
                INSTALLER.copy_tree(source / "app", target)
                hermes = home / "hermes"
                hermes.mkdir()
                # A real selected installation keeps its journal beneath home;
                # a shorter test override must not hide long backup/restore I/O.
                with patch.dict(os.environ):
                    os.environ.pop("NORA_INSTALLER_DIRECTORY", None)
                    journal = INSTALLER.FirstInstallJournal.create(home, hermes, home / "tavern")
                    self.assertEqual(journal.directory.parents[2], home / "installer")
                    self.assertGreater(len(str(journal.directory)), 248)
                    self.assertFalse(str(journal.file).startswith("\\\\?\\"))
                    journal.prepare({"tavern": [target]}, manifest={})
                    saved_target = journal.backup_target(journal.record["targets"][0])
                    self.assertEqual(saved_target, journal.directory / "backups/000")
                    legacy_saved = journal.directory / "backups/tavern/apps/tavern-runtime"
                    self.assertEqual(len(str(legacy_saved)) - len(str(saved_target)),
                        len("backups/tavern/apps/tavern-runtime") - len("backups/000"))
                    saved_worker = saved_target / WORKER.removeprefix("app/")
                    self.assertGreater(len(str(saved_worker)), 260, "the actual journal backup must exercise long paths")
                    journal.checkpoint("apply", "intent")
                    Path(INSTALLER.filesystem_path(worker)).write_bytes(b"changed")
                    journal.checkpoint("apply", "failed")
                    result = INSTALLER.resume_first_install(journal.file, stop=lambda: {"offline": True})
                    errors = result.get("errors", [])
                    traces = "\n".join("".join(traceback.format_exception(error)) for error in errors)
                    self.assertEqual(result["status"], "restored", f"recovery result: {result!r}\n{traces}")
                    restored_journal = INSTALLER.FirstInstallJournal.load(journal.file)
                    staged = restored_journal.record["targets"][0]["staged"]
                    self.assertFalse(staged.startswith("\\\\?\\"), "the journal must retain its logical relative path")
                    self.assertEqual(Path(staged).parent, Path(restored_journal.record["targets"][0]["path"]).parent)
                    self.assertRegex(Path(staged).name, r"^\.nfi-r-[a-f0-9]{32}$")
                    staged_path = Path(restored_journal.record["roots"]["tavern"]) / staged
                    legacy_staged = staged_path.with_name(".nora-first-install-restore-" + staged_path.name.removeprefix(".nfi-r-"))
                    self.assertEqual(len(str(legacy_staged)) - len(str(staged_path)),
                        len(".nora-first-install-restore-") - len(".nfi-r-"))
                    self.assertGreater(len(str(staged_path / WORKER.removeprefix("app/"))), 260,
                        "the restored tree's real worker path still requires long-path I/O")
                    self.assertEqual(INSTALLER.resume_first_install(journal.file, stop=lambda: {"offline": True})["status"], "restored",
                        "a repeated recovery must retain the same default-journal contract")
                self.assertEqual(Path(INSTALLER.filesystem_path(saved_worker)).read_bytes(), b"worker fixture",
                    "restoration must preserve the journal's source snapshot")
                self.assertEqual(Path(INSTALLER.filesystem_path(worker)).read_bytes(), b"worker fixture")
                context = INSTALLER.module_at("windows_managed_context", ROOT / "ops/updater/managed_context.py")
                (hermes / "AGENTS.md").write_bytes(b"old rules")
                (hermes / "AGENTS.md.bak").write_bytes(b"previous rules")
                agents_backup = Path(INSTALLER.filesystem_path(
                    home / "tavern/tavern-first-install-backups/20260910-120000-2.2.11-1789011117954000000/agents-rollback"))
                context.snapshot_agents(hermes, agents_backup)
                context.install_agents(hermes, b"new rules")
                context.restore_agents(hermes, agents_backup)
                self.assertEqual((hermes / "AGENTS.md").read_bytes(), b"old rules")
                self.assertEqual((hermes / "AGENTS.md.bak").read_bytes(), b"previous rules")
                # The next attempt must rotate the same deep default journal,
                # preserving the original transaction bytes and its backups.
                old_journal = Path(INSTALLER.filesystem_path(journal.file)).read_bytes()
                with patch.dict(os.environ):
                    os.environ.pop("NORA_INSTALLER_DIRECTORY", None)
                    retry = INSTALLER.FirstInstallJournal.create(home, hermes, home / "tavern",
                        operation_id=journal.record["operationId"])
                self.assertEqual(retry.record["attempt"], 2)
                archive = journal.directory.parent / retry.record["previousArchive"]
                self.assertFalse(str(archive).startswith("\\\\?\\"))
                self.assertEqual(Path(INSTALLER.filesystem_path(archive / "transaction.json")).read_bytes(), old_journal)
                self.assertEqual(Path(INSTALLER.filesystem_path(archive / "backups/000"
                    / WORKER.removeprefix("app/"))).read_bytes(), b"worker fixture")
            self.assertFalse(Path(temporary_work).exists(), "workspace cleanup must support long descendants")
        except BaseException as error:
            primary = error
            raise
        finally:
            try:
                shutil.rmtree(INSTALLER.filesystem_path(root))
            except BaseException as error:
                message = f"Native path fixture cleanup failed; retained: {root}; cause: {error}"
                if primary is None:
                    raise RuntimeError(message) from error
                primary.add_note(message)


if __name__ == "__main__":
    unittest.main()
