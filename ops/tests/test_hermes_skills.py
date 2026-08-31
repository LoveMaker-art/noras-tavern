"""Isolated installer/content checks. No real runtime, network or model calls."""

import importlib.util
from pathlib import Path
import re
import shutil
import tempfile
import unittest
from unittest.mock import patch


OPS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("install_skills", OPS / "scripts/install-hermes-skills.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class SkillInstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tavern-skills-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.source = OPS / "skills"

    def write(self, relative, content):
        path = self.home / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def plan(self):
        return installer.build_plan(self.source, self.home)

    def apply(self, plan=None):
        plan = self.plan() if plan is None else plan
        return installer.apply_plan(plan, self.home, installer.plan_summary(plan)["digest"])

    def test_read_only_plan_and_three_unique_main_documents(self):
        plan = self.plan()
        self.assertEqual(list(self.home.iterdir()), [])
        mains = [c for c in plan if c["path"].endswith("/SKILL.md") and c["new"]]
        self.assertEqual(len(mains), 3)

    def test_old_visual_helper_is_retired_without_removing_user_images(self):
        helper = self.write("skills/creative/tavern-world-visuals/scripts/world_theme.py", "old Python endpoint")
        schema = self.write("skills/creative/tavern-world-visuals/references/theme-schema.md", "old interface")
        image = self.write("tavern-state/world-assets/user/background.png", "keep existing artwork")
        self.apply()
        self.assertFalse(helper.exists())
        self.assertFalse(schema.exists())
        self.assertEqual(image.read_text(), "keep existing artwork")
        reference = self.home / "skills/creative/tavern/references/world-visuals.md"
        self.assertIn("theme.apply", reference.read_text())
        self.assertEqual(self.plan(), [])

    def test_apply_and_reapply_are_idempotent(self):
        result = self.apply()
        self.assertFalse(result["servicesRestarted"])
        self.assertEqual(self.plan(), [])
        self.assertEqual(self.apply()["status"], "unchanged")
        self.assertEqual(len(list((self.home / "tavern-skill-backups").iterdir())), 1)

    def test_profile_helper_is_relocated_once_with_recoverable_old_copies(self):
        original = (OPS / "scripts/profile_memory.py").read_bytes()
        old_paths = [self.write("skills/" + name, original.decode()) for name in installer.OLD_PROFILE_HELPERS]
        result = self.apply()
        self.assertEqual((self.home / "skills" / installer.PROFILE_HELPER).read_bytes(), original)
        self.assertTrue(all(not file.exists() for file in old_paths))
        self.assertIn(original, [file.read_bytes() for file in Path(result["backup"]).glob("*.bak")])
        self.assertEqual(self.plan(), [])

    def test_customized_profile_helper_blocks_retirement_without_writes(self):
        modified = self.write("skills/" + installer.OLD_PROFILE_HELPERS[0], "custom implementation")
        with self.assertRaisesRegex(ValueError, "Modified legacy profile helper"):
            self.plan()
        self.assertEqual(modified.read_text(), "custom implementation")
        self.assertFalse((self.home / "skills" / installer.PROFILE_HELPER).exists())

    def test_retirement_preserves_scripts_custom_skills_and_recoverable_bytes(self):
        old = "---\nname: tavern\ndescription: old\n---\nold content\n"
        duplicate = self.write("skills/creative/.tavern-pre-20260827-203039/SKILL.md", old)
        retired = self.write("skills/creative/tavern-world/SKILL.md", "old world instructions")
        nested = self.write("skills/creative/tavern/specialists/tavern-story-profile/SKILL.md", "old profile")
        script = self.write("skills/creative/tavern-world/scripts/helper.py", "user script")
        updater = self.write("skills/system/tavern-updater/scripts/update.py", "retained updater")
        custom = self.write("skills/creative/my-skill/SKILL.md", "---\nname: my-skill\n---\nuser owned")
        result = self.apply()
        for file in (duplicate, retired, nested):
            self.assertFalse(file.exists())
        self.assertEqual(script.read_text(), "user script")
        self.assertEqual(updater.read_text(), "retained updater")
        self.assertIn("user owned", custom.read_text())
        backup = Path(result["backup"])
        self.assertFalse(list(backup.rglob("SKILL.md")))
        self.assertIn(old.encode(), [f.read_bytes() for f in backup.glob("*.bak")])

    def test_provision_changes_only_the_known_copy_block_and_preserves_mode(self):
        script = self.write("skills/creative/tavern/scripts/provision.sh",
                            "#!/bin/sh\nCUSTOM=preserved\n" + installer.PROVISION_OLD + "echo done\n")
        script.chmod(0o750)
        self.apply()
        self.assertEqual(script.read_text(), "#!/bin/sh\nCUSTOM=preserved\n" + installer.PROVISION_NEW + "echo done\n")
        self.assertEqual(script.stat().st_mode & 0o777, 0o750)

    def test_unknown_provision_block_is_not_guessed(self):
        self.write("skills/creative/tavern/scripts/provision.sh", "STORY_PROFILE_SKILL_SOURCE=custom\n")
        with self.assertRaisesRegex(ValueError, "Unrecognized provision"):
            self.plan()

    def test_unknown_duplicate_is_preserved_and_blocks(self):
        file = self.write("skills/custom/another/SKILL.md", "---\nname: tavern\n---\ncustom\n")
        with self.assertRaisesRegex(ValueError, "Unmanaged duplicate"):
            self.plan()
        self.assertTrue(file.exists())

    def test_unrelated_nonstandard_skill_is_untouched(self):
        file = self.write("skills/custom/plain/SKILL.md", "plain document without frontmatter")
        self.apply()
        self.assertEqual(file.read_text(), "plain document without frontmatter")

    def test_symlink_targets_and_parents_are_rejected(self):
        outside = self.write("untouched.txt", "original")
        target = self.home / "AGENTS.md"
        target.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            self.plan()
        target.unlink()
        (self.home / "skills").symlink_to(self.home / "elsewhere", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            self.plan()
        self.assertEqual(outside.read_text(), "original")

    def test_source_beneath_discovery_root_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Stage source outside"):
            installer.build_plan(self.home / "skills/creative/tavern/skills", self.home)

    def test_archive_metadata_is_not_installed_as_a_reference(self):
        source = self.home / "source"
        shutil.copytree(self.source, source)
        (source.parent / "scripts").mkdir()
        shutil.copyfile(OPS / "scripts/profile_memory.py", source.parent / "scripts/profile_memory.py")
        (source / "creative/tavern/references/._worlds.md").write_bytes(b"AppleDouble")
        plan = installer.build_plan(source, self.home / "target")
        self.assertFalse(any("._worlds.md" in c["path"] for c in plan))

    def test_changed_plan_or_target_does_not_write(self):
        plan = self.plan()
        with self.assertRaisesRegex(ValueError, "Plan changed"):
            installer.apply_plan(plan, self.home, "wrong")
        self.assertEqual(list(self.home.iterdir()), [])
        self.write("AGENTS.md", "user update\n")
        with self.assertRaisesRegex(ValueError, "Target changed"):
            self.apply(plan)
        self.assertFalse((self.home / "skills").exists())

    def test_failure_restores_old_contents_and_retires_new_files(self):
        file = self.write("AGENTS.md", "# Personal instructions\nKeep me.\n")
        plan = self.plan()
        original_write = installer.atomic_write
        count = 0

        def fail_third(path, data, mode):
            nonlocal count
            count += 1
            if count == 3:
                raise OSError("test failure")
            original_write(path, data, mode)

        with patch.object(installer, "atomic_write", side_effect=fail_third):
            with self.assertRaisesRegex(RuntimeError, r"restore failures=\[\]"):
                self.apply(plan)
        self.assertEqual(file.read_text(), "# Personal instructions\nKeep me.\n")
        self.assertFalse(list((self.home / "skills").rglob("SKILL.md")))

    def test_agents_custom_content_survives_and_managed_block_is_idempotent(self):
        block = (self.source / "agents-tavern.md").read_text()
        original = "# Personal\nDo not change my identity.\n\n## Other app\nCustom instructions.\n"
        merged = installer.merge_agents(original, block)
        self.assertTrue(merged.startswith(original.rstrip()))
        self.assertEqual(installer.merge_agents(merged, block), merged)
        amended = merged + "\n## Later addition\nAlso keep.\n"
        self.assertTrue(installer.merge_agents(amended, block).endswith("Also keep.\n"))

    def test_only_exact_legacy_sections_are_removed(self):
        heading = "## Tavern Skill Routing"
        legacy = heading + "\nKnown old instructions."
        block = (self.source / "agents-tavern.md").read_text()
        with patch.dict(installer.LEGACY_SECTIONS, {heading: installer.digest(legacy.encode())}):
            merged = installer.merge_agents("# AGENTS\n\n" + legacy + "\n\n## Personal\nKeep.\n", block)
            self.assertNotIn("Known old", merged)
            self.assertIn("## Personal\nKeep.", merged)
            with self.assertRaisesRegex(ValueError, "Modified legacy"):
                installer.merge_agents(legacy + "\nCustom change.", block)

    def test_invalid_or_mixed_agents_markers_are_rejected(self):
        block = (self.source / "agents-tavern.md").read_text()
        for text in [installer.BEGIN, installer.END, block + block,
                     installer.END + installer.BEGIN, block + "\n## Tavern Updates\nold"]:
            with self.assertRaises(ValueError):
                installer.merge_agents(text, block)

    def test_lowercase_agents_requires_explicit_selection(self):
        self.write("agents.md", "# Existing instructions\n")
        with self.assertRaisesRegex(ValueError, "lowercase agents"):
            self.plan()
        plan = installer.build_plan(self.source, self.home, self.home / "agents.md")
        self.assertTrue(any(c["path"].endswith("/agents.md") for c in plan))

    def test_reference_links_and_official_section_order(self):
        sections = ["When to Use", "Prerequisites", "How to Run", "Quick Reference", "Procedure", "Pitfalls", "Verification"]
        for rel in installer.SKILLS:
            directory = self.source / rel
            main = (directory / "SKILL.md").read_text()
            description = re.search(r"(?m)^description: (.+)$", main).group(1)
            self.assertLessEqual(len(description), 60)
            self.assertEqual(re.findall(r"(?m)^## (.+)$", main), sections)
            for file in directory.rglob("*.md"):
                for target in re.findall(r"\]\(([^)]+)\)", file.read_text()):
                    if "://" not in target and not target.startswith("#"):
                        self.assertTrue((file.parent / target).is_file(), (file, target))
        self.assertEqual(len(list((OPS).rglob("SKILL.md"))), 3)


if __name__ == "__main__":
    unittest.main()
