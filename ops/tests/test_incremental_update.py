import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


BUNDLE = load("nora_incremental_bundle", "ops/updater/bundle.py")
BOOTSTRAP = load("nora_incremental_bootstrap", "ops/updater/bootstrap.py")
UPDATER = load("nora_incremental_updater", "ops/updater/update.py")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def archive(path, members):
    with tarfile.open(path, "w:gz") as package:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755 if name.endswith(".py") else 0o644
            package.addfile(info, io.BytesIO(data))


class IncrementalUpdateTests(unittest.TestCase):
    def test_same_commit_exits_before_release_download(self):
        with tempfile.TemporaryDirectory(prefix="nora-current-version-") as temporary:
            home = Path(temporary)
            record = home / "tavern-updates/installed.json"
            record.parent.mkdir(parents=True)
            record.write_text(json.dumps({"version": "2.1.2", "commit": "abc123"}), encoding="utf-8")
            for relative in (
                    "apps/tavern-runtime/native-runtime.json",
                    "apps/tavern-runtime/engine/sillytavern/server.js",
                    "apps/tavern-ops/updater/update.py",
                    "apps/nora-mcp/dist/server.js"):
                path = home / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture", encoding="utf-8")
            with mock.patch.object(sys, "argv", [
                    "bootstrap.py", "--hermes-home", str(home), "--target-commit", "abc123",
                    "--apply", "--confirm"]), mock.patch.object(BOOTSTRAP, "download", side_effect=AssertionError("must not download")):
                BOOTSTRAP.main()

    def test_native_install_downloads_only_changed_modules_and_target_updater(self):
        with tempfile.TemporaryDirectory(prefix="nora-incremental-plan-") as temporary:
            home = Path(temporary)
            app = home / "apps/tavern-runtime"
            ops = home / "apps/tavern-ops"
            app.mkdir(parents=True)
            ops.joinpath("updater").mkdir(parents=True)
            app.joinpath("native-runtime.json").write_bytes(b"target")
            ops.joinpath("updater/update.py").write_bytes(b"old updater")
            manifest = {
                "artifacts": {
                    "app/native-runtime.json": digest(b"target"),
                    "ops/updater/update.py": digest(b"new updater"),
                },
                "modules": {
                    "nora-runtime": {"name": "nora-tavern-module-nora-runtime.tar.gz", "artifacts": ["app/native-runtime.json"]},
                    "updater": {"name": "nora-tavern-module-updater.tar.gz", "artifacts": ["ops/updater/update.py"]},
                },
            }
            names, mode = BOOTSTRAP.required_archives(home, manifest)
            self.assertEqual(mode, "incremental")
            self.assertEqual(names, ["nora-tavern-module-updater.tar.gz"])

    def test_python_install_uses_complete_release_archives(self):
        with tempfile.TemporaryDirectory(prefix="nora-full-plan-") as temporary:
            names, mode = BOOTSTRAP.required_archives(Path(temporary), {"modules": {"updater": {}}})
            self.assertEqual(mode, "full")
            self.assertEqual(names, list(BOOTSTRAP.FULL_ARCHIVES))

    def test_mode_change_is_a_module_change_even_when_bytes_match(self):
        with tempfile.TemporaryDirectory(prefix="nora-mode-plan-") as temporary:
            home = Path(temporary)
            target = home / "apps/tavern-runtime/native-runtime.json"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"target")
            target.chmod(0o644)
            manifest = {
                "artifacts": {"app/native-runtime.json": digest(b"target")},
                "artifactModes": {"app/native-runtime.json": 0o755},
                "modules": {
                    "updater": {
                        "name": "nora-tavern-module-updater.tar.gz",
                        "artifacts": ["ops/updater/update.py"],
                    },
                    "nora-runtime": {
                        "name": "nora-tavern-module-nora-runtime.tar.gz",
                        "artifacts": ["app/native-runtime.json"],
                    },
                },
            }
            # Add a declared updater artifact so bootstrap can select the target runner.
            manifest["artifacts"]["ops/updater/update.py"] = digest(b"updater")
            manifest["artifactModes"]["ops/updater/update.py"] = 0o644
            names, mode = BOOTSTRAP.required_archives(home, manifest)
            self.assertEqual(mode, "incremental")
            self.assertEqual(names, [
                "nora-tavern-module-nora-runtime.tar.gz",
                "nora-tavern-module-updater.tar.gz",
            ])

    def test_incremental_extraction_reuses_matching_files_and_replaces_changed_module(self):
        required = {
            "app/native-runtime.json": b"new runtime",
            "app/story_profile_runtime/manifest.json": b"{}",
            "nora-mcp/dist/server.js": b"server",
            "nora-mcp/npm-shrinkwrap.json": b"{}",
            "ops/scripts/install-hermes-skills.py": b"skills",
            "ops/updater/update.py": b"updater",
            "ops/skills/agents-tavern.md": b"agents",
            "ops/skills/creative/nora-cardforge/SKILL.md": b"cardforge",
        }
        groups = {
            "nora-runtime": ["app/native-runtime.json", "app/story_profile_runtime/manifest.json"],
            "nora-mcp": ["nora-mcp/dist/server.js", "nora-mcp/npm-shrinkwrap.json"],
            "operations": ["ops/scripts/install-hermes-skills.py"],
            "updater": ["ops/updater/update.py"],
            "skills": ["ops/skills/agents-tavern.md", "ops/skills/creative/nora-cardforge/SKILL.md"],
        }
        with tempfile.TemporaryDirectory(prefix="nora-incremental-extract-") as temporary:
            root = Path(temporary)
            home = root / "home"
            roots = BUNDLE.installed_roots(home)
            for name, data in required.items():
                path = BUNDLE.artifact_path(name, roots)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"old runtime" if name == "app/native-runtime.json" else data)
            release = root / "release"
            release.mkdir()
            changed_name = "nora-tavern-module-nora-runtime.tar.gz"
            archive(release / changed_name, {name: required[name] for name in groups["nora-runtime"]})
            modules = {}
            for name, members in groups.items():
                archive_name = f"nora-tavern-module-{name}.tar.gz"
                modules[name] = {
                    "name": archive_name,
                    "sha256": digest((release / archive_name).read_bytes()) if (release / archive_name).is_file() else "0" * 64,
                    "artifacts": members,
                }
            manifest = {
                "artifacts": {name: digest(data) for name, data in required.items()},
                "modules": modules,
                "archives": {
                    "app": {"name": "nora-tavern-app.tar.gz", "sha256": "0" * 64},
                    "ops": {"name": "nora-tavern-ops.tar.gz", "sha256": "0" * 64},
                    "nora-mcp": {"name": "nora-tavern-nora-mcp.tar.gz", "sha256": "0" * 64},
                },
            }
            destination = root / "stage"
            report = BUNDLE.extract_bundle(release, destination, manifest, roots=roots)
            self.assertEqual(report["mode"], "incremental")
            self.assertEqual(report["changedModules"], ["nora-runtime"])
            for name, data in required.items():
                self.assertEqual(destination.joinpath(*Path(name).parts).read_bytes(), data)

    def test_dependencies_are_reused_when_lock_is_unchanged(self):
        with tempfile.TemporaryDirectory(prefix="nora-dependency-reuse-") as temporary:
            root = Path(temporary)
            current = root / "current"
            target = root / "target"
            for base in (current, target):
                base.mkdir()
                base.joinpath("package-lock.json").write_text('{"lockfileVersion":3}\n', encoding="utf-8")
            for relative in ("express/package.json", "webpack/package.json"):
                path = current / "node_modules" / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("{}\n", encoding="utf-8")
            result = UPDATER.reuse_or_install_dependencies(
                target,
                current,
                "package-lock.json",
                ["command-that-must-not-run"],
                ("express/package.json", "webpack/package.json"),
            )
            self.assertEqual(result, "reused")
            self.assertTrue((target / "node_modules/express/package.json").is_file())

    def test_dependency_marker_reads_the_installed_app_layout(self):
        with tempfile.TemporaryDirectory(prefix="nora-dependency-marker-") as temporary:
            app = Path(temporary) / "apps/tavern-runtime"
            lock = app / "engine/sillytavern/package-lock.json"
            lock.parent.mkdir(parents=True)
            lock.write_text('{"lockfileVersion":3}\n', encoding="utf-8")
            with mock.patch.object(UPDATER, "run") as run:
                run.return_value.stdout = "v22.22.0\n"
                marker = UPDATER.dependency_marker(app)
            self.assertEqual(marker["lock_sha256"], digest(lock.read_bytes()))
            self.assertEqual(marker["node_major"], 22)

    def test_legacy_fallback_preserves_all_user_and_liveware_state(self):
        with tempfile.TemporaryDirectory(prefix="nora-legacy-fallback-") as temporary:
            home = Path(temporary) / "home"
            old = home / "tavern-state"
            old.joinpath("cards").mkdir(parents=True)
            old.joinpath("cards/card.json").write_text("{}\n", encoding="utf-8")
            old.joinpath("apps.json").write_text('{"console":{"app_id":"app-1"}}\n', encoding="utf-8")
            old.joinpath("model_configs.json").write_text('{"models":[]}\n', encoding="utf-8")
            old.joinpath("story_profile.json").write_text("{}\n", encoding="utf-8")
            prepared, report = UPDATER.fallback_python_state(home, Path(temporary) / "work", "unsupported")
            self.assertEqual(report["status"], "archived")
            for relative in ("cards/card.json", "apps.json", "model_configs.json", "story_profile.json"):
                self.assertEqual((prepared / relative).read_bytes(), (old / relative).read_bytes())

    def test_agents_merge_is_idempotent_for_new_and_existing_managed_blocks(self):
        with tempfile.TemporaryDirectory(prefix="nora-agents-merge-") as temporary:
            home = Path(temporary)
            path = home / "AGENTS.md"
            path.write_text("# Personal rules\n\nKeep this.\n", encoding="utf-8")
            managed = b"<!-- BEGIN TAVERN SKILLS -->\nTavern rules.\n<!-- END TAVERN SKILLS -->\n"
            first = UPDATER.merged_agents(home, managed)
            path.write_bytes(first)
            second = UPDATER.merged_agents(home, managed)
            self.assertEqual(second, first)
            self.assertEqual(first.count(b"BEGIN TAVERN SKILLS"), 1)
            self.assertIn(b"Keep this.", first)

    def test_small_update_temporarily_skips_content_check_and_restores_config(self):
        with tempfile.TemporaryDirectory(prefix="nora-content-check-") as temporary:
            config = Path(temporary) / "config.yaml"
            original = b"port: 8000\nskipContentCheck: false\n"
            config.write_bytes(original)
            with UPDATER.temporary_content_check_skip(config, True):
                self.assertIn(b"skipContentCheck: true", config.read_bytes())
            self.assertEqual(config.read_bytes(), original)

    def test_engine_update_keeps_normal_content_check(self):
        with tempfile.TemporaryDirectory(prefix="nora-content-check-engine-") as temporary:
            config = Path(temporary) / "config.yaml"
            original = b"skipContentCheck: false\n"
            config.write_bytes(original)
            with UPDATER.temporary_content_check_skip(config, False):
                self.assertEqual(config.read_bytes(), original)

    def test_extra_managed_file_forces_clean_root_replacement_but_node_modules_do_not(self):
        with tempfile.TemporaryDirectory(prefix="nora-extra-file-") as temporary:
            home = Path(temporary)
            app = home / "apps/tavern-runtime"
            ops = home / "apps/tavern-ops"
            mcp = home / "apps/nora-mcp"
            for root in (app, ops, mcp):
                root.mkdir(parents=True)
            app.joinpath("native-runtime.json").write_text("{}", encoding="utf-8")
            app.joinpath("node_modules/runtime/package.json").parent.mkdir(parents=True)
            app.joinpath("node_modules/runtime/package.json").write_text("{}", encoding="utf-8")
            manifest = {"artifacts": {"app/native-runtime.json": digest(b"{}")}}
            self.assertEqual(UPDATER.roots_with_unmanaged_files(home, manifest), set())
            ops.joinpath("obsolete.py").write_text("old", encoding="utf-8")
            self.assertEqual(UPDATER.roots_with_unmanaged_files(home, manifest), {"ops"})


if __name__ == "__main__":
    unittest.main()
