import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RepositoryHygieneTests(unittest.TestCase):
    def test_bootstrap_fetches_latest_assets_without_github_api(self):
        bootstrap = load_module(
            "tavern_bootstrap_fetch",
            ROOT / "bootstrap/tavern_updater_bootstrap.py",
        )
        downloaded = []

        def fake_download(url, destination):
            downloaded.append(url)
            name = Path(url).name
            if name == bootstrap.ASSET_MANIFEST:
                destination.write_text('{"version":"1.22.0"}', encoding="utf-8")
            elif name == bootstrap.SKILL_ASSET_MANIFEST:
                destination.write_text("{}", encoding="utf-8")
            else:
                destination.write_bytes(b"archive")

        with tempfile.TemporaryDirectory() as temp, mock.patch.object(
                bootstrap, "download", side_effect=fake_download):
            release, manifest, *_rest = bootstrap.fetch_release(Path(temp))

        self.assertEqual(manifest["version"], "1.22.0")
        self.assertEqual(release["tag"], "v1.22.0")
        self.assertEqual(len(downloaded), 4)
        self.assertTrue(all("/releases/latest/download/" in url for url in downloaded))
        self.assertTrue(all("api.github.com" not in url for url in downloaded))

    def test_bootstrap_and_updater_skill_allowlists_match(self):
        bootstrap = load_module(
            "tavern_bootstrap_allowlist",
            ROOT / "bootstrap/tavern_updater_bootstrap.py",
        )
        updater = load_module(
            "tavern_updater_allowlist",
            ROOT / "skills/tavern-updater/scripts/update.py",
        )

        self.assertEqual(set(bootstrap.SKILL_FILES), updater.CREATIVE_SKILL_FILES)
        self.assertEqual(set(bootstrap.SYSTEM_SKILL_FILES), updater.SYSTEM_SKILL_FILES)

    def test_bootstrap_transition_guidance_is_consistent(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        updater_skill = (ROOT / "skills/tavern-updater/SKILL.md").read_text(encoding="utf-8")
        updater_agents = (ROOT / "integrations/hermes/AGENTS.md").read_text(encoding="utf-8")
        bootstrap_source = (ROOT / "bootstrap/tavern_updater_bootstrap.py").read_text(encoding="utf-8")
        updater_source = (ROOT / "skills/tavern-updater/scripts/update.py").read_text(encoding="utf-8")

        command = "install-tavern-updater.sh | sh"
        self.assertIn(command, readme)
        self.assertIn(command, updater_skill)
        self.assertIn(command, updater_agents)
        self.assertIn("Every check, review, or update request must begin", updater_skill)
        self.assertNotIn("replace_agents(", bootstrap_source)
        self.assertIn("EXPANDED_RUNTIME_VERSION = (1, 21, 0)", updater_source)
        self.assertIn("MODULAR_RUNTIME_VERSION = (1, 22, 0)", updater_source)
        self.assertNotIn(">= (1, 21, 0)", updater_source)

    def test_runtime_release_contains_refactored_modules(self):
        archive = ROOT / "dist/tavern-release.tar.gz"
        manifest_path = ROOT / "dist/manifest.json"
        if not archive.is_file() or not manifest_path.is_file():
            self.skipTest("build release assets before archive validation")

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        expected = {
            "runtime/background_jobs.py",
            "runtime/card_preparation.py",
            "runtime/continuity_model.py",
            "runtime/generation_service.py",
            "runtime/memory_cache.py",
            "runtime/message_segments.py",
            "runtime/model_registry.py",
            "runtime/model_retry.py",
            "runtime/production_views.py",
            "runtime/reply_format.py",
            "runtime/request_security.py",
            "runtime/runtime_cast_service.py",
            "runtime/runtime_http.py",
            "runtime/state_store.py",
            "runtime/story_ledger.py",
            "runtime/story_profile.py",
            "runtime/story_state_service.py",
            "runtime/tts_service.py",
            "runtime/web/security.js",
            "runtime/assets/fixtures/starter/index.json",
            "runtime/assets/fixtures/starter/audrey-barista.png",
            "runtime/assets/fixtures/starter/doria-android.png",
            "runtime/assets/fixtures/starter/ichitora-detective.png",
            "runtime/assets/fixtures/starter/kuchanan-explorer.png",
            "runtime/assets/fixtures/starter/librarian.png",
            "runtime/assets/fixtures/starter/medieval-knight.png",
            "runtime/assets/fixtures/starter/reiko-samurai.png",
            "runtime/assets/fixtures/starter/yan-buddy.png",
            "system-skills/model-api-manager/SKILL.md",
            "system-skills/model-api-manager/scripts/model_api_manager.py",
        }
        self.assertTrue(expected.issubset(set(manifest["managed_files"])))
        with tarfile.open(archive, "r:gz") as package:
            names = {member.name for member in package.getmembers() if member.isfile()}
        self.assertTrue(expected.issubset(names))
        self.assertEqual(set(manifest["managed_files"]), names)

    def test_legacy_persona_and_tools_are_absent(self):
        forbidden = (
            ROOT / "skill/SOUL.md",
            ROOT / "agentchat/chat_server.py",
            ROOT / "skill/tools/bringup.sh",
            ROOT / "skill/tools/provision.sh",
            ROOT / "skill/tools/tavern_cli.py",
            ROOT / "skill/tools/install.sh",
            ROOT / "skill/tools/make_test_card.py",
            ROOT / "skill/tools/smoke.py",
            ROOT / "skill/fixtures/lin.png",
            ROOT / "skill/fixtures/worldbook_rainy_city.json",
        )
        self.assertFalse([str(path.relative_to(ROOT)) for path in forbidden if path.exists()])

    def test_documented_install_paths_exist(self):
        self.assertTrue((ROOT / "requirements.txt").is_file())
        self.assertTrue((ROOT / ".env.example").is_file())
        for name in ("standalone.md", "hermes.md", "architecture.md", "configuration.md"):
            self.assertTrue((ROOT / "docs" / name).is_file(), name)

        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertNotIn("skill/requirements.txt", readme)
        self.assertIn("requirements.txt", readme)

        self.assertTrue((ROOT / "app/backend/server.py").is_file())
        self.assertTrue((ROOT / "app/frontend/index.html").is_file())
        self.assertTrue((ROOT / "app/assets/fixtures/starter/index.json").is_file())
        self.assertTrue((ROOT / "integrations/hermes/SOUL.md").is_file())
        self.assertFalse(any((ROOT / "skill").rglob("*")))

    def test_hermes_scripts_have_one_source_of_truth(self):
        canonical = ROOT / "skills/tavern"
        self.assertTrue((canonical / "scripts/bringup.sh").is_file())
        self.assertTrue((canonical / "scripts/provision.sh").is_file())
        self.assertTrue((canonical / "scripts/runtime.sh").is_file())
        self.assertTrue((canonical / "scripts/tavern_cli.py").is_file())
        self.assertTrue((ROOT / "tools/tavern_cli.py").is_file())
        self.assertTrue((canonical / "hooks/tavern-liveware-register/HOOK.yaml").is_file())
        self.assertFalse((ROOT / "integrations/clawchat").exists())
        self.assertFalse((ROOT / "integrations/hermes/skills").exists())
        duplicates = [
            path.relative_to(ROOT).as_posix()
            for path in (ROOT / "skill/tools").glob("*")
            if path.is_file()
        ]
        self.assertEqual(duplicates, [])

    def test_skill_release_contains_complete_split_skill_suite(self):
        archive = ROOT / "dist/tavern-skill.tar.gz"
        manifest_path = ROOT / "dist/skill-manifest.json"
        if not archive.is_file() or not manifest_path.is_file():
            self.skipTest("build release assets before archive validation")

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        scripts = {
            path
            for path in manifest["managed_files"]
            if "/scripts/" in path
        }
        self.assertEqual(
            scripts,
            {
                "skills/tavern/scripts/bringup.sh",
                "skills/tavern/scripts/provision.sh",
                "skills/tavern/scripts/runtime.sh",
                "skills/tavern/scripts/tavern_cli.py",
                "skills/tavern-continuity/scripts/tavern_repair.py",
                "skills/tavern-story-profile/scripts/profile_memory.py",
                "skills/tavern-world-visuals/scripts/world_theme.py",
            },
        )
        self.assertEqual(manifest["schema"], 3)
        self.assertEqual(manifest["scope"], "tavern-creative-skills")
        self.assertEqual(manifest["install_mode"], "exact-directories")
        self.assertEqual(len(manifest["directories"]), 6)
        self.assertNotIn("obsolete_files", manifest)
        for name in (
                "tavern", "tavern-world", "tavern-story-profile",
                "tavern-continuity", "tavern-ops", "tavern-world-visuals"):
            self.assertIn(f"skills/{name}/SKILL.md", manifest["managed_files"])
        self.assertIn(
            "skills/tavern/references/conversation-cards.md",
            manifest["managed_files"],
        )
        for hook_file in ("HOOK.yaml", "handler.py", "run.sh"):
            self.assertIn(
                f"skills/tavern/hooks/tavern-liveware-register/{hook_file}",
                manifest["managed_files"],
            )
        self.assertNotIn("skills/tavern-cards/SKILL.md", manifest["managed_files"])
        self.assertNotIn("skills/tavern-worldbooks/SKILL.md", manifest["managed_files"])
        with tarfile.open(archive, "r:gz") as package:
            names = {member.name for member in package.getmembers() if member.isfile()}
        self.assertFalse(any(name.endswith("/SOUL.md") for name in names))
        self.assertNotIn("skills/tavern/scripts/install.sh", names)
        self.assertNotIn("skills/tavern/scripts/smoke.py", names)
        self.assertNotIn("skills/tavern/scripts/make_test_card.py", names)
        self.assertEqual(set(manifest["managed_files"]), names)

    def test_all_creative_skill_versions_match_release(self):
        release_version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        creative_names = (
            "tavern", "tavern-world", "tavern-story-profile",
            "tavern-continuity", "tavern-ops", "tavern-world-visuals",
        )
        for skill_file in (ROOT / "skills" / name / "SKILL.md" for name in creative_names):
            version_line = next(
                line for line in skill_file.read_text(encoding="utf-8").splitlines()
                if line.startswith("version:")
            )
            self.assertEqual(
                version_line.split(":", 1)[1].strip(),
                release_version,
                skill_file.relative_to(ROOT).as_posix(),
            )

        updater_skill = ROOT / "skills/tavern-updater/SKILL.md"
        updater_version = next(
            line for line in updater_skill.read_text(encoding="utf-8").splitlines()
            if line.startswith("version:")
        )
        self.assertEqual(updater_version.split(":", 1)[1].strip(), release_version)

    def test_release_contains_one_canonical_agents_file(self):
        canonical = ROOT / "integrations/hermes/AGENTS.md"
        self.assertTrue(canonical.is_file())
        self.assertTrue(canonical.read_text(encoding="utf-8").startswith("# AGENTS.md"))
        self.assertFalse((ROOT / "skills/tavern-updater/references/agents-block.md").exists())
        self.assertNotIn("tavern-updater:start", canonical.read_text(encoding="utf-8"))

    def test_soul_is_a_source_template_not_a_release_managed_file(self):
        soul = ROOT / "integrations/hermes/SOUL.md"
        self.assertTrue(soul.is_file())
        manifest_path = ROOT / "dist/manifest.json"
        skill_manifest_path = ROOT / "dist/skill-manifest.json"
        if not manifest_path.is_file() or not skill_manifest_path.is_file():
            self.skipTest("build release assets before identity-boundary validation")
        managed = (
            json.loads(manifest_path.read_text(encoding="utf-8"))["managed_files"]
            + json.loads(skill_manifest_path.read_text(encoding="utf-8"))["managed_files"]
        )
        self.assertFalse(any(path.lower().endswith("soul.md") for path in managed))

    def test_managed_system_skill_is_packaged_from_hermes_integration(self):
        source = ROOT / "skills/model-api-manager"
        self.assertTrue((source / "SKILL.md").is_file())
        self.assertTrue((source / "scripts/model_api_manager.py").is_file())
        archive = ROOT / "dist/tavern-release.tar.gz"
        if not archive.is_file():
            self.skipTest("build release assets before archive validation")
        with tarfile.open(archive, "r:gz") as package:
            names = {member.name for member in package.getmembers() if member.isfile()}
        self.assertIn("system-skills/model-api-manager/SKILL.md", names)
        self.assertIn("system-skills/model-api-manager/scripts/model_api_manager.py", names)

    def test_legacy_baseline_release_is_runtime_only_and_hash_complete(self):
        manifest_path = ROOT / "dist/baseline-v1.14.12-manifest.json"
        archive = ROOT / "dist/tavern-baseline-v1.14.12.tar.gz"
        if not manifest_path.is_file() or not archive.is_file():
            self.skipTest("build release assets before baseline validation")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], 1)
        self.assertEqual(manifest["scope"], "tavern-historical-baseline")
        self.assertEqual(manifest["version"], "1.14.12")
        self.assertEqual(len(manifest["managed_files"]), 12)
        self.assertTrue(all(path.startswith("runtime/") for path in manifest["managed_files"]))
        self.assertFalse(any("tavern-state" in path for path in manifest["managed_files"]))
        with tarfile.open(archive, "r:gz") as package:
            names = {member.name for member in package.getmembers() if member.isfile()}
        self.assertEqual(set(manifest["managed_files"]), names)
        self.assertEqual(set(manifest["files"]), names)

    def test_persona_profile_has_accessible_detail_entry(self):
        app = (ROOT / "app/frontend/app.js").read_text(encoding="utf-8")
        self.assertIn('data-persona-detail="1"', app)
        self.assertIn('role="button"', app)
        self.assertIn("openPersonaDetailSheet", app)


if __name__ == "__main__":
    unittest.main()
