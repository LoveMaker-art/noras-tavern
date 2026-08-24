import importlib.util
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "tavern_updater_under_test",
    ROOT / "skills/tavern-updater/scripts/update.py",
)
UPDATER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATER)


class UpdaterMergeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tavern-updater-test-")
        self.root = Path(self.temp.name)
        UPDATER.UPDATE_ROOT = self.root / "updates"
        UPDATER.BASELINE = UPDATER.UPDATE_ROOT / "baseline"
        UPDATER.BACKUPS = UPDATER.UPDATE_ROOT / "backups"
        UPDATER.PLANS = UPDATER.UPDATE_ROOT / "plans"
        UPDATER.STATE = UPDATER.UPDATE_ROOT / "state.json"
        UPDATER.LOCK = UPDATER.UPDATE_ROOT / "update.lock"
        UPDATER.TARGETS = {
            area: self.root / "installed" / area
            for area in ("runtime", "skills", "system-skills", "updater")
        }
        UPDATER.AGENTS_PATH = self.root / "installed/AGENTS.md"
        UPDATER.SKIP_SERVICE = True
        UPDATER.PYTHON = sys.executable
        UPDATER.ALLOWED_MANAGED = {
            "runtime": {"server.py"},
            "skills": set(UPDATER.CREATIVE_SKILL_FILES),
            "system-skills": set(UPDATER.SYSTEM_SKILL_FILES),
            "updater": set(),
        }

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def write(root, name, content):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def write_official_skill_stage(self, root, marker="release"):
        for name in UPDATER.CREATIVE_SKILL_FILES:
            self.write(root, name, marker + ":" + name + "\n")

    def write_official_system_skill_stage(self, root, marker="release"):
        for name in UPDATER.SYSTEM_SKILL_FILES:
            self.write(root, name, marker + ":" + name + "\n")

    def test_default_release_discovery_avoids_github_api(self):
        with mock.patch.object(
            UPDATER,
            "request_json",
            return_value={"version": "1.23.10"},
        ) as request:
            release = UPDATER.release_from_download()

        request.assert_called_once_with(
            "https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/manifest.json"
        )
        self.assertEqual(release["tag"], "v1.23.10")
        self.assertNotIn("api.github.com", " ".join(release["assets"].values()))
        self.assertTrue(
            release["assets"]["tavern-release.tar.gz"].endswith(
                "/releases/download/v1.23.10/tavern-release.tar.gz"
            )
        )
        self.assertIn("baseline-v1.21.5-manifest.json", release["assets"])
        self.assertIn("tavern-baseline-v1.21.5.tar.gz", release["assets"])

    def test_official_target_not_merged_install_becomes_next_baseline(self):
        base = self.root / "base/runtime"
        current = self.root / "current/runtime"
        incoming_v2 = self.root / "incoming-v2/runtime"
        staged_v2 = self.root / "staged-v2/runtime"
        self.write(base, "server.py", "base\nshared\n")
        self.write(current, "server.py", "base\nshared\nlocal customization\n")
        self.write(incoming_v2, "server.py", "upstream v2\nbase\nshared\n")

        report, conflicts = UPDATER.merge_area(
            "runtime", base, current, incoming_v2, staged_v2, {"server.py"})
        self.assertFalse(conflicts)
        self.assertEqual(report[0]["status"], "merged")
        self.assertIn("local customization", (staged_v2 / "server.py").read_text())

        upstream = self.root / "upstream"
        self.write(upstream / "runtime", "server.py", (incoming_v2 / "server.py").read_text())
        UPDATER.write_baseline(upstream, ["runtime/server.py"], "2.0.0")
        self.assertEqual(
            (UPDATER.BASELINE / "runtime/server.py").read_text(),
            (incoming_v2 / "server.py").read_text(),
        )

        incoming_v3 = self.root / "incoming-v3/runtime"
        staged_v3 = self.root / "staged-v3/runtime"
        self.write(incoming_v3, "server.py", "upstream v3\nbase\nshared\n")
        _report, conflicts = UPDATER.merge_area(
            "runtime",
            UPDATER.BASELINE / "runtime",
            staged_v2,
            incoming_v3,
            staged_v3,
            {"server.py"},
        )
        self.assertFalse(conflicts)
        self.assertIn("upstream v3", (staged_v3 / "server.py").read_text())
        self.assertIn("local customization", (staged_v3 / "server.py").read_text())

    def test_missing_trusted_baseline_never_overwrites_differing_file(self):
        base = self.root / "empty-base/runtime"
        current = self.root / "current/runtime"
        incoming = self.root / "incoming/runtime"
        output = self.root / "output/runtime"
        base.mkdir(parents=True)
        self.write(current, "server.py", "local version\n")
        self.write(incoming, "server.py", "new official version\n")

        report, conflicts = UPDATER.merge_area(
            "runtime", base, current, incoming, output, {"server.py"})
        self.assertEqual(conflicts, ["runtime/server.py"])
        self.assertEqual(report[0]["status"], "conflict")
        self.assertFalse((output / "server.py").exists())

    def test_known_transitional_runtime_is_migrated_to_upstream(self):
        base = self.root / "base/runtime"
        current = self.root / "current/runtime"
        incoming = self.root / "incoming/runtime"
        output = self.root / "output/runtime"
        self.write(base, "server.py", "official old\n")
        transitional = self.write(current, "server.py", "transitional build\n")
        self.write(incoming, "server.py", "official new\n")
        digest = hashlib.sha256(transitional.read_bytes()).hexdigest()
        migrations = {
            "runtime/server.py": {
                digest: {"min_target": "1.21.0", "reason": "test-migration"},
            },
        }

        with mock.patch.object(UPDATER, "COMPATIBILITY_REPLACEMENTS", migrations):
            report, conflicts = UPDATER.merge_area(
                "runtime", base, current, incoming, output, {"server.py"},
                compatibility_target="1.21.0")

        self.assertFalse(conflicts)
        self.assertEqual(report[0]["status"], "compatibility-migrated")
        self.assertEqual(report[0]["compatibility_migration"], "test-migration")
        self.assertEqual((output / "server.py").read_text(), "official new\n")

    def test_world_theme_preview_fingerprint_is_an_exact_compatibility_migration(self):
        migration = UPDATER.COMPATIBILITY_REPLACEMENTS["runtime/server.py"][
            "21deaa1e65bf5836827327b1857f8d72f3f5e12473e40131dc872cd94858cb46"
        ]
        self.assertEqual(migration["min_target"], "1.21.3")
        self.assertEqual(migration["reason"], "world-theme-preview")

    def test_runtime_allowlist_tracks_each_release_generation(self):
        self.assertEqual(
            UPDATER.runtime_files_for_version("1.14.12"),
            UPDATER.LEGACY_RUNTIME_FILES,
        )
        self.assertEqual(
            UPDATER.runtime_files_for_version("1.21.8"),
            UPDATER.EXPANDED_RUNTIME_FILES,
        )
        self.assertEqual(
            UPDATER.runtime_files_for_version("1.22.0"),
            UPDATER.MODULAR_RUNTIME_FILES,
        )
        self.assertEqual(
            UPDATER.runtime_files_for_version("1.23.6"),
            UPDATER.SINGLE_PASS_RUNTIME_FILES,
        )
        self.assertEqual(
            UPDATER.runtime_files_for_version("1.23.9"),
            UPDATER.VOICE_CATALOG_RUNTIME_FILES,
        )
        self.assertEqual(
            UPDATER.runtime_files_for_version("1.23.13"),
            UPDATER.CARD_PREPARATION_RUNTIME_FILES,
        )
        self.assertEqual(
            UPDATER.runtime_files_for_version("1.23.18"),
            UPDATER.STARTER_ASSET_RUNTIME_FILES,
        )
        self.assertEqual(
            UPDATER.runtime_files_for_version("1.24.0"),
            UPDATER.PRE_RETRY_RUNTIME_FILES,
        )
        self.assertEqual(
            UPDATER.runtime_files_for_version("1.24.6"),
            UPDATER.RUNTIME_FILES,
        )
        self.assertIn("generation_service.py", UPDATER.RUNTIME_FILES)
        self.assertIn("qwen_audio_voices.json", UPDATER.RUNTIME_FILES)
        self.assertIn("card_preparation.py", UPDATER.RUNTIME_FILES)
        self.assertIn("personality_service.py", UPDATER.RUNTIME_FILES)
        self.assertIn("model_retry.py", UPDATER.RUNTIME_FILES)
        self.assertIn("env_loader.py", UPDATER.RUNTIME_FILES)
        self.assertNotIn("model_retry.py", UPDATER.PRE_RETRY_RUNTIME_FILES)
        self.assertNotIn("env_loader.py", UPDATER.PRE_RETRY_RUNTIME_FILES)
        self.assertIn("assets/fixtures/starter/index.json", UPDATER.RUNTIME_FILES)
        self.assertFalse(
            UPDATER.STARTER_ASSET_FILES & UPDATER.CARD_PREPARATION_RUNTIME_FILES
        )
        self.assertNotIn("card_preparation.py", UPDATER.VOICE_CATALOG_RUNTIME_FILES)
        self.assertNotIn("qwen_audio_voices.json", UPDATER.SINGLE_PASS_RUNTIME_FILES)
        self.assertNotIn("generation_service.py", UPDATER.EXPANDED_RUNTIME_FILES)
        self.assertIn("turn_plan_service.py", UPDATER.MODULAR_RUNTIME_FILES)
        self.assertNotIn("turn_plan_service.py", UPDATER.RUNTIME_FILES)

    def test_env_loader_file_boundary_matches_historical_releases(self):
        self.assertNotIn("env_loader.py", UPDATER.runtime_files_for_version("1.24.4"))
        self.assertEqual(
            UPDATER.runtime_files_for_version("1.24.5"),
            UPDATER.ENV_LOADER_RUNTIME_FILES,
        )
        self.assertIn("env_loader.py", UPDATER.runtime_files_for_version("1.24.7"))
        self.assertIn("model_retry.py", UPDATER.runtime_files_for_version("1.24.7"))

    def test_obsolete_runtime_file_is_removed_and_restored_on_rollback(self):
        obsolete = self.write(
            UPDATER.TARGETS["runtime"],
            "turn_plan_service.py",
            "legacy planner\n",
        )
        backup = UPDATER.backup_current(
            "1.23.5",
            ["runtime/server.py"],
            ["runtime/turn_plan_service.py"],
        )

        UPDATER.remove_obsolete_managed_files(["runtime/turn_plan_service.py"])
        self.assertFalse(obsolete.exists())

        UPDATER.restore(backup)
        self.assertEqual(obsolete.read_text(encoding="utf-8"), "legacy planner\n")

    def test_unknown_transitional_runtime_still_conflicts(self):
        base = self.root / "base/runtime"
        current = self.root / "current/runtime"
        incoming = self.root / "incoming/runtime"
        output = self.root / "output/runtime"
        self.write(base, "server.py", "same = 'base'\n")
        self.write(current, "server.py", "same = 'local'\n")
        self.write(incoming, "server.py", "same = 'upstream'\n")

        report, conflicts = UPDATER.merge_area(
            "runtime", base, current, incoming, output, {"server.py"},
            compatibility_target="1.21.0")

        self.assertEqual(conflicts, ["runtime/server.py"])
        self.assertEqual(report[0]["status"], "conflict")

    def test_index_asset_query_changes_are_metadata_only_during_upgrade(self):
        base = self.root / "base/runtime"
        current = self.root / "current/runtime"
        incoming = self.root / "incoming/runtime"
        output = self.root / "output/runtime"
        self.write(
            base, "web/index.html",
            '<script src="i18n.js"></script>\n<script src="app.js?v=old"></script>\n',
        )
        self.write(
            current, "web/index.html",
            '<script src="i18n.js?v=cache"></script>\n<script src="app.js?v=new"></script>\n',
        )
        self.write(
            incoming, "web/index.html",
            '<script src="i18n.js?v=cache"></script>\n<script src="security.js"></script>\n'
            '<script src="app.js?v=new"></script>\n',
        )

        report, conflicts = UPDATER.merge_area(
            "runtime", base, current, incoming, output, {"web/index.html"},
            compatibility_target="1.21.0")

        self.assertFalse(conflicts)
        self.assertEqual(report[0]["status"], "metadata-normalized")
        self.assertTrue(report[0]["metadata_normalized"])
        self.assertIn("security.js", (output / "web/index.html").read_text())

    def test_index_asset_query_changes_are_preserved_without_upgrade(self):
        base = self.root / "base/runtime"
        current = self.root / "current/runtime"
        incoming = self.root / "incoming/runtime"
        output = self.root / "output/runtime"
        self.write(base, "web/index.html", '<script src="app.js?v=base"></script>\n')
        self.write(current, "web/index.html", '<script src="app.js?v=local"></script>\n')
        self.write(incoming, "web/index.html", '<script src="app.js?v=upstream"></script>\n')

        report, conflicts = UPDATER.merge_area(
            "runtime", base, current, incoming, output, {"web/index.html"})

        self.assertEqual(conflicts, ["runtime/web/index.html"])
        self.assertEqual(report[0]["status"], "conflict")

    def test_missing_legacy_version_marker_is_added_from_target(self):
        base = self.root / "base/runtime"
        current = self.root / "current/runtime"
        incoming = self.root / "incoming/runtime"
        output = self.root / "output/runtime"
        self.write(base, ".tavern-release-version", "1.14.12\n")
        current.mkdir(parents=True)
        self.write(incoming, ".tavern-release-version", "1.20.1\n")

        report, conflicts = UPDATER.merge_area(
            "runtime", base, current, incoming, output, {".tavern-release-version"})

        self.assertFalse(conflicts)
        self.assertEqual(report[0]["status"], "upstream-added")
        self.assertEqual((output / ".tavern-release-version").read_text(), "1.20.1\n")

    def test_bundled_historical_baseline_is_hash_verified(self):
        source = self.root / "baseline-source/runtime"
        for name in UPDATER.LEGACY_RUNTIME_FILES:
            content = "1.14.12\n" if name == ".tavern-release-version" else f"legacy {name}\n"
            self.write(source, name, content)
        archive = self.root / "tavern-baseline-v1.14.12.tar.gz"
        with tarfile.open(archive, "w:gz") as package:
            package.add(source, arcname="runtime")
        files = {
            f"runtime/{name}": hashlib.sha256((source / name).read_bytes()).hexdigest()
            for name in UPDATER.LEGACY_RUNTIME_FILES
        }
        manifest = self.root / "baseline-v1.14.12-manifest.json"
        manifest.write_text(json.dumps({
            "schema": 1,
            "scope": "tavern-historical-baseline",
            "version": "1.14.12",
            "archive": archive.name,
            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            "managed_files": sorted(files),
            "files": files,
        }), encoding="utf-8")
        assets = {
            manifest.name: str(manifest),
            archive.name: str(archive),
        }

        with mock.patch.object(UPDATER, "download", side_effect=lambda src, dst: shutil.copy2(src, dst)):
            unpacked = UPDATER.bundled_baseline(
                self.root / "downloaded", {"assets": assets}, "1.14.12")

        self.assertEqual((unpacked / "runtime/server.py").read_text(), "legacy server.py\n")

        bad_manifest = json.loads(manifest.read_text(encoding="utf-8"))
        bad_manifest["files"]["runtime/server.py"] = "0" * 64
        manifest.write_text(json.dumps(bad_manifest), encoding="utf-8")
        with mock.patch.object(UPDATER, "download", side_effect=lambda src, dst: shutil.copy2(src, dst)):
            with self.assertRaisesRegex(RuntimeError, "file manifest mismatch"):
                UPDATER.bundled_baseline(
                    self.root / "tampered", {"assets": assets}, "1.14.12")

    def test_historical_split_skill_manifest_accepts_safe_older_subset(self):
        current = {"skills/" + name for name in UPDATER.CREATIVE_SKILL_FILES}
        older = {
            path for path in current
            if not path.startswith("skills/tavern-world-visuals/")
        }

        UPDATER.validate_split_skill_managed(older, historical=True)
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            UPDATER.validate_split_skill_managed(older, historical=False)
        with self.assertRaisesRegex(RuntimeError, "historical"):
            UPDATER.validate_split_skill_managed(older | {"skills/tavern/unknown.md"}, historical=True)

    def test_legacy_review_uses_bundled_baseline_when_tagged_release_is_missing(self):
        dist = ROOT / "dist"
        required_assets = (
            "manifest.json",
            "tavern-release.tar.gz",
            "skill-manifest.json",
            "tavern-skill.tar.gz",
            "baseline-v1.14.12-manifest.json",
            "tavern-baseline-v1.14.12.tar.gz",
        )
        if not all((dist / name).is_file() for name in required_assets):
            self.skipTest("build release assets before migration validation")
        manifest = json.loads((dist / "manifest.json").read_text(encoding="utf-8"))
        skill_manifest = json.loads((dist / "skill-manifest.json").read_text(encoding="utf-8"))
        UPDATER.ALLOWED_MANAGED = {
            "runtime": {
                path.partition("/")[2]
                for path in manifest["managed_files"]
                if path.startswith("runtime/")
            },
            "skills": set(UPDATER.CREATIVE_SKILL_FILES),
            "system-skills": {
                path.partition("/")[2]
                for path in manifest["managed_files"]
                if path.startswith("system-skills/")
            },
            "updater": {
                path.partition("/")[2]
                for path in manifest["managed_files"]
                if path.startswith("updater/")
            },
        }
        baseline_runtime = ROOT / "legacy-baselines/v1.14.12/runtime"
        shutil.copytree(baseline_runtime, UPDATER.TARGETS["runtime"])
        (UPDATER.TARGETS["runtime"] / ".tavern-release-version").unlink()
        self.write(UPDATER.TARGETS["skills"], "tavern/SKILL.md", "---\nname: tavern\nversion: 1.14.12\n---\n")
        self.write(UPDATER.TARGETS["skills"], "tavern/references/legacy.md", "old monolith\n")
        self.write(self.root / "installed", "AGENTS.md", "# Old agent routing\n")
        release = {
            "tag": "v" + manifest["version"],
            "url": "https://example.invalid/releases/latest",
            "assets": {name: (dist / name).as_uri() for name in required_assets},
        }

        output = io.StringIO()
        with mock.patch.object(UPDATER, "latest_release", return_value=release), \
                mock.patch.object(UPDATER, "tagged_release", side_effect=RuntimeError("404")), \
                mock.patch.dict(os.environ, {"PYTHONPYCACHEPREFIX": str(self.root / "pycache")}), \
                contextlib.redirect_stdout(output):
            UPDATER.command_review.__wrapped__(SimpleNamespace())

        review = json.loads(output.getvalue())
        plan = json.loads((UPDATER.PLANS / review["plan_id"] / "plan.json").read_text())
        self.assertTrue(review["ready"])
        self.assertEqual(review["conflicts"], [])
        self.assertTrue(plan["baseline_trusted"])
        self.assertEqual(plan["baseline_source"], "bundled-historical-baseline")
        self.assertEqual(plan["target"], skill_manifest["version"])

    def test_cached_baseline_rejects_tampering(self):
        upstream = self.root / "upstream"
        self.write(upstream / "runtime", "server.py", "official\n")
        managed = ["runtime/server.py"]
        UPDATER.write_baseline(upstream, managed, "2.0.0")
        self.assertEqual(UPDATER.cached_baseline("2.0.0", managed), UPDATER.BASELINE)

        (UPDATER.BASELINE / "runtime/server.py").write_text("tampered\n", encoding="utf-8")
        self.assertIsNone(UPDATER.cached_baseline("2.0.0", managed))

    def test_official_skills_are_replaced_exactly_and_custom_skill_is_preserved(self):
        staged = self.root / "staged/skills"
        self.write_official_skill_stage(staged)
        self.write(UPDATER.TARGETS["skills"], "tavern/SKILL.md", "old router\n")
        self.write(UPDATER.TARGETS["skills"], "tavern/references/legacy.md", "stale\n")
        self.write(UPDATER.TARGETS["skills"], "tavern-cards/SKILL.md", "retired cards\n")
        self.write(UPDATER.TARGETS["skills"], "tavern-worldbooks/SKILL.md", "retired lore\n")
        self.write(UPDATER.TARGETS["skills"], "custom-skill/SKILL.md", "custom\n")

        UPDATER.replace_official_skills(staged)

        self.assertFalse((UPDATER.TARGETS["skills"] / "tavern/references/legacy.md").exists())
        self.assertFalse((UPDATER.TARGETS["skills"] / "tavern-cards").exists())
        self.assertFalse((UPDATER.TARGETS["skills"] / "tavern-worldbooks").exists())
        self.assertEqual((UPDATER.TARGETS["skills"] / "custom-skill/SKILL.md").read_text(), "custom\n")
        self.assertEqual(UPDATER.official_skill_hashes(), UPDATER.official_skill_hashes(staged))

    def test_skill_review_reports_stale_official_files_without_conflict(self):
        incoming = self.root / "incoming/skills"
        output = self.root / "output/skills"
        self.write_official_skill_stage(incoming)
        self.write(UPDATER.TARGETS["skills"], "tavern/references/legacy.md", "local legacy\n")

        report, conflicts = UPDATER.stage_official_skills(
            incoming, output, UPDATER.CREATIVE_SKILL_FILES)

        self.assertFalse(conflicts)
        self.assertIn("replaced", {item["status"] for item in report})
        self.assertEqual(UPDATER.tree_hashes(output), UPDATER.tree_hashes(incoming))

    def test_system_skill_is_replaced_exactly_and_other_system_skills_are_preserved(self):
        staged = self.root / "staged/system-skills"
        self.write_official_system_skill_stage(staged)
        self.write(
            UPDATER.TARGETS["system-skills"],
            "model-api-manager/references/stale.md",
            "stale\n",
        )
        self.write(
            UPDATER.TARGETS["system-skills"],
            "custom-system-skill/SKILL.md",
            "custom\n",
        )

        UPDATER.replace_official_system_skills(staged)

        self.assertFalse((
            UPDATER.TARGETS["system-skills"]
            / "model-api-manager/references/stale.md"
        ).exists())
        self.assertEqual((
            UPDATER.TARGETS["system-skills"]
            / "custom-system-skill/SKILL.md"
        ).read_text(), "custom\n")
        self.assertEqual(
            UPDATER.official_system_skill_hashes(),
            UPDATER.official_system_skill_hashes(staged),
        )

    def test_skill_fingerprint_covers_unlisted_files_inside_official_directories(self):
        path = self.write(UPDATER.TARGETS["skills"], "tavern/local-note.md", "one\n")
        before = UPDATER.managed_fingerprint(["runtime/server.py"])
        path.write_text("two\n", encoding="utf-8")
        after = UPDATER.managed_fingerprint(["runtime/server.py"])
        self.assertNotEqual(before, after)

    def test_agents_file_is_replaced_in_full(self):
        unpacked = self.root / "unpacked"
        plan = self.root / "plan"
        self.write(self.root / "installed", "AGENTS.md", "# Local operations\n\nKeep this note.\n")
        desired = "# AGENTS.md\n\nOfficial routing only.\n"
        self.write(unpacked / "updater/references", "AGENTS.md", desired)

        staged, report = UPDATER.stage_agents(unpacked, plan)

        self.assertEqual(staged.read_text(), desired)
        self.assertNotIn("Keep this note.", staged.read_text())
        self.assertEqual(report["status"], "upstream")

    def test_malformed_release_agents_file_is_rejected(self):
        unpacked = self.root / "unpacked"
        self.write(unpacked / "updater/references", "AGENTS.md", "not canonical\n")

        with self.assertRaisesRegex(RuntimeError, "malformed"):
            UPDATER.stage_agents(unpacked, self.root / "plan")

    def test_complete_skill_directories_and_agents_are_restored_on_rollback(self):
        managed = (
            ["runtime/server.py"]
            + ["skills/" + name for name in UPDATER.CREATIVE_SKILL_FILES]
            + ["system-skills/" + name for name in UPDATER.SYSTEM_SKILL_FILES]
        )
        self.write(UPDATER.TARGETS["runtime"], "server.py", "runtime\n")
        self.write(UPDATER.TARGETS["skills"], "tavern/scripts/smoke.py", "legacy\n")
        self.write(UPDATER.TARGETS["skills"], "tavern-cards/SKILL.md", "old card skill\n")
        self.write(UPDATER.TARGETS["skills"], "tavern-worldbooks/SKILL.md", "old lore skill\n")
        self.write(UPDATER.TARGETS["skills"], "custom-skill/SKILL.md", "custom\n")
        self.write(
            UPDATER.TARGETS["system-skills"],
            "model-api-manager/references/local.md",
            "local system skill data\n",
        )
        self.write(
            UPDATER.TARGETS["system-skills"],
            "custom-system-skill/SKILL.md",
            "custom system\n",
        )
        self.write(self.root / "installed", "AGENTS.md", "local agents\n")
        backup = UPDATER.backup_current("1.19.7", managed)

        staged = self.root / "staged/skills"
        self.write_official_skill_stage(staged)
        UPDATER.replace_official_skills(staged)
        staged_system = self.root / "staged/system-skills"
        self.write_official_system_skill_stage(staged_system)
        UPDATER.replace_official_system_skills(staged_system)
        UPDATER.atomic_write_text(UPDATER.AGENTS_PATH, "updated agents\n")
        UPDATER.restore(backup)

        self.assertEqual((UPDATER.TARGETS["skills"] / "tavern/scripts/smoke.py").read_text(), "legacy\n")
        self.assertEqual((UPDATER.TARGETS["skills"] / "tavern-cards/SKILL.md").read_text(), "old card skill\n")
        self.assertEqual((UPDATER.TARGETS["skills"] / "tavern-worldbooks/SKILL.md").read_text(), "old lore skill\n")
        self.assertFalse((UPDATER.TARGETS["skills"] / "tavern-world").exists())
        self.assertEqual((UPDATER.TARGETS["skills"] / "custom-skill/SKILL.md").read_text(), "custom\n")
        self.assertEqual((
            UPDATER.TARGETS["system-skills"]
            / "model-api-manager/references/local.md"
        ).read_text(), "local system skill data\n")
        self.assertEqual((
            UPDATER.TARGETS["system-skills"]
            / "custom-system-skill/SKILL.md"
        ).read_text(), "custom system\n")
        self.assertEqual(UPDATER.AGENTS_PATH.read_text(), "local agents\n")

    def test_default_report_omits_file_hashes(self):
        managed = ["runtime/server.py"]
        self.write(UPDATER.TARGETS["runtime"], "server.py", "installed\n")
        plan_id = "concise-report"
        plan_dir = UPDATER.PLANS / plan_id
        plan_dir.mkdir(parents=True)
        plan = {
            "plan_id": plan_id,
            "installed": "1.19.2",
            "target": "1.19.3",
            "ready": True,
            "baseline_trusted": True,
            "baseline_source": "installed-release",
            "baseline_warning": "",
            "validation": {"python": 1, "shell": 0, "javascript": 0},
            "counts": {"upstream": 1},
            "categories": {"backend": 1},
            "conflicts": [],
            "metadata_normalized": [],
            "managed_files": managed,
            "current_fingerprint": UPDATER.managed_fingerprint(managed),
            "files": [{
                "path": "runtime/server.py",
                "category": "backend",
                "status": "upstream",
                "base_sha256": "base",
                "installed_sha256": "installed",
                "release_sha256": "release",
                "metadata_normalized": False,
            }],
        }
        (plan_dir / "plan.json").write_text(json.dumps(plan), encoding="utf-8")

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            UPDATER.command_report.__wrapped__(SimpleNamespace(plan=plan_id, details=False))
        report = json.loads(output.getvalue())

        self.assertFalse(report["details"])
        self.assertEqual(
            report["changes"],
            [{"path": "runtime/server.py", "category": "backend", "status": "upstream"}],
        )
        self.assertNotIn("installed_sha256", output.getvalue())

    def test_apply_rejects_plan_with_hidden_file_conflicts(self):
        plan_id = "inconsistent-conflict-plan"
        plan_dir = UPDATER.PLANS / plan_id
        plan_dir.mkdir(parents=True)
        plan = {
            "schema": 2,
            "skill_install_mode": "exact-directories",
            "ready": True,
            "conflicts": [],
            "files": [{"path": "runtime/server.py", "status": "conflict"}],
        }
        (plan_dir / "plan.json").write_text(json.dumps(plan), encoding="utf-8")

        with self.assertRaisesRegex(RuntimeError, "conflict state is inconsistent"):
            UPDATER.load_plan(plan_id)


class RuntimeStateBoundaryTests(unittest.TestCase):
    def test_existing_actor_profile_is_migrated_without_losing_content(self):
        with tempfile.TemporaryDirectory(prefix="tavern-state-test-") as temp:
            state = Path(temp)
            profile = state / "actor_self.md"
            original = "# Personal preference\n\n- Preserve this exact text.\n"
            profile.write_text(original, encoding="utf-8")
            env = os.environ.copy()
            env["TAVERN_STATE_DIR"] = str(state)
            env["TAVERN_HERMES_MEMORIES_DIR"] = str(state / "memories")
            command = (
                "import server; "
                "assert 'Preserve this exact text.' in server.actor_self_text()"
            )
            subprocess.run(
                [sys.executable, "-c", command],
                cwd=ROOT / "app/backend",
                env=env,
                check=True,
            )
            self.assertIn("Preserve this exact text.", profile.read_text(encoding="utf-8"))
            self.assertTrue((state / "story_profile.json").is_file())


if __name__ == "__main__":
    unittest.main()
