import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from contextlib import ExitStack
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/updater"))
import managed_context as context


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


INSTALLER = load("context_first_install", "ops/installer/first_install.py")
UPDATER = load("context_update", "ops/updater/update.py")
STORIES = load("context_stories", "ops/skills/creative/nora-cardforge/scripts/starter-story.py")
DOCUMENT = (ROOT / "ops/skills/agents-tavern.md").read_bytes()


class ManagedContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()

    def test_full_replacement_keeps_only_one_previous_revision_and_noop_preserves_it(self):
        path, backup = [self.home / name for name in context.AGENTS_FILES]
        old = b"# Personal\nold rules\n<!-- BEGIN TAVERN SKILLS -->\nold managed\n<!-- END TAVERN SKILLS -->\nextra rules\n"
        path.write_bytes(old)
        INSTALLER.install_agents(self.home, DOCUMENT.decode())
        self.assertEqual(path.read_bytes(), DOCUMENT)
        self.assertEqual(backup.read_bytes(), old)
        context.install_agents(self.home, DOCUMENT)
        self.assertEqual(backup.read_bytes(), old)
        next_document = DOCUMENT + b"\n# Next revision\n"
        context.install_agents(self.home, next_document)
        self.assertEqual(backup.read_bytes(), DOCUMENT)
        self.assertEqual(sorted(p.name for p in self.home.iterdir()), ["AGENTS.md", "AGENTS.md.bak"])
        self.assertEqual(UPDATER.merged_agents(self.home, DOCUMENT), DOCUMENT)

    def test_empty_legacy_or_symlink_targets_fail_without_modification(self):
        path = self.home / "AGENTS.md"
        path.write_bytes(b"keep")
        for invalid in (b"", b" \n", b"<!-- BEGIN TAVERN SKILLS -->\nold block"):
            with self.assertRaises(RuntimeError):
                context.install_agents(self.home, invalid)
            self.assertEqual(path.read_bytes(), b"keep")
        outside = self.root / "outside"
        outside.write_bytes(b"outside")
        (self.home / "AGENTS.md.bak").symlink_to(outside)
        with self.assertRaises(RuntimeError):
            context.install_agents(self.home, DOCUMENT)
        self.assertEqual(path.read_bytes(), b"keep")
        self.assertEqual(outside.read_bytes(), b"outside")

    def test_rollback_restores_both_original_document_and_previous_backup(self):
        for existing in (False, True):
            for name in context.AGENTS_FILES:
                (self.home / name).unlink(missing_ok=True)
                if existing:
                    (self.home / name).write_text("original " + name)
            snapshot = self.root / str(existing)
            context.snapshot_agents(self.home, snapshot)
            context.install_agents(self.home, DOCUMENT)
            context.restore_agents(self.home, snapshot)
            for name in context.AGENTS_FILES:
                self.assertEqual((self.home / name).exists(), existing)
                if existing:
                    self.assertEqual((self.home / name).read_text(), "original " + name)

    def apply_greeting(self):
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            swaps, report = context.prepare_greeting(self.home, ROOT, Path(temporary))
            for _, source, target in swaps:
                context.atomic(target, source.read_bytes())
            return report

    def test_greeting_matches_template_and_preserves_later_user_edits(self):
        report = self.apply_greeting()
        self.assertEqual(report["status"], "managed")
        greeting = self.home / "clawchat/greeting.md"
        expected = (ROOT / "ops/installer/templates/greeting.md").read_bytes()
        self.assertEqual(greeting.read_bytes(), expected)
        self.apply_greeting()
        greeting.write_text("My own greeting")
        self.assertEqual(self.apply_greeting()["status"], "preserved-custom")
        self.assertEqual(greeting.read_text(), "My own greeting")
        self.assertEqual((self.home / "clawchat/greeting.nora-example.md").read_bytes(), expected)
        self.assertFalse((self.home / "tavern-state/imports").exists())

    def test_greeting_rejects_directory_escape(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.home / "clawchat").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            self.apply_greeting()
        self.assertEqual(list(outside.iterdir()), [])

    def test_optional_stories_stage_in_standalone_instance_without_importing(self):
        self.apply_greeting()
        (self.home / "config.yaml").write_bytes(INSTALLER.render_mcp(self.home, 18765))
        resources = ROOT / "ops/skills/creative/nora-cardforge/resources/starter-stories"
        for story in ("suzhou-rain", "xiamen-breeze"):
            result = STORIES.stage(self.home, resources, story, "request-1")
            self.assertFalse(result["imported"])
            self.assertTrue(Path(result["filePath"]).is_relative_to(self.home / "tavern-state/imports"))
            self.assertEqual(result, STORIES.stage(self.home, resources, story, "request-1"))
        self.assertFalse((self.home / "tavern-state/native/default-user/characters").exists())

    def installation_fixture(self):
        source = self.root / "source"
        (source / "app").mkdir(parents=True)
        (source / "nora-mcp").mkdir()
        (source / "app/.tavern-release-version").write_text("2.2.10")
        for name in ("ops/updater/managed_context.py", "ops/updater/clawchat_greeting_patch.py",
                     "ops/installer/templates/greeting.md", "ops/installer/templates/SOUL.md",
                     "ops/skills/agents-tavern.md", "ops/scripts/nora-instance.py",
                     "ops/hooks/tavern-liveware-register/HOOK.yaml", "ops/hooks/tavern-liveware-register/handler.py",
                     "ops/hooks/tavern-liveware-register/run.sh"):
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        (self.home / "config.yaml").write_text("unrelated: preserve\n")
        (self.home / "AGENTS.md").write_bytes(b"old rules")
        (self.home / "AGENTS.md.bak").write_bytes(b"previous rules")
        (self.home / "SOUL.md").write_bytes(b"custom soul")
        (self.home / "USER.md").write_bytes(b"user memory")
        return SimpleNamespace(apply=True, confirm=True, hermes_home=self.home,
                               source_root=source, force_first_install=True, replace_soul=False,
                               port=18765, skip_liveware=True)

    def test_first_install_success_and_retry_do_not_duplicate_rules_or_backups(self):
        args = self.installation_fixture()
        with patch.object(INSTALLER, "prepare_skills", return_value={}), \
             patch.object(INSTALLER, "start_tavern", return_value={"health": {"ok": True}}), \
             patch.object(INSTALLER, "install_update_check", return_value={}), \
             patch("builtins.print"):
            INSTALLER.install(args)
            INSTALLER.install(args)
            INSTALLER.install(args)
        self.assertEqual((self.home / "AGENTS.md").read_bytes(), DOCUMENT)
        self.assertEqual((self.home / "AGENTS.md.bak").read_bytes(), b"old rules")
        self.assertEqual((self.home / "SOUL.md").read_bytes(), b"custom soul")
        self.assertEqual((self.home / "USER.md").read_bytes(), b"user memory")
        self.assertEqual(list(self.home.rglob("agents-rollback")), [])
        self.assertEqual(len(list(self.home.rglob("AGENTS.md.bak"))), 1)

    def test_first_install_failure_restores_context_and_removes_new_greeting(self):
        args = self.installation_fixture()
        with patch.object(INSTALLER, "prepare_skills", return_value={}), \
             patch.object(INSTALLER, "start_tavern", side_effect=RuntimeError("failed startup")):
            with self.assertRaisesRegex(RuntimeError, "failed startup"):
                INSTALLER.install(args)
        self.assertEqual((self.home / "AGENTS.md").read_bytes(), b"old rules")
        self.assertEqual((self.home / "AGENTS.md.bak").read_bytes(), b"previous rules")
        self.assertEqual((self.home / "SOUL.md").read_bytes(), b"custom soul")
        self.assertFalse((self.home / "clawchat/greeting.md").exists())
        self.assertFalse((self.home / "scripts/nora-instance.py").exists())

    def test_real_updater_transaction_replaces_or_rolls_back_agents_and_greeting(self):
        import bundle
        for failure in (False, True):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                case = Path(temporary).resolve()
                home = case / "home"
                home.mkdir()
                (home / "skills").mkdir()
                (home / "AGENTS.md").write_bytes(b"old rules")
                (home / "AGENTS.md.bak").write_bytes(b"previous rules")
                (home / "config.yaml").write_bytes(b"unrelated: preserve\n")
                def extract(_release, source, _manifest, **_kwargs):
                    for name in ("ops/skills/agents-tavern.md", "ops/installer/templates/greeting.md",
                                 "ops/scripts/nora-instance.py", "ops/updater/managed_context.py",
                                 "ops/updater/clawchat_greeting_patch.py"):
                        target = source / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(ROOT / name, target)
                    return {"changedModules": []}
                original_loader = UPDATER.module_at
                def modules(name, path):
                    if name == "simple_service_manager":
                        return SimpleNamespace(ManagedService=SimpleNamespace(discover=lambda *_: None))
                    if name == "simple_skill_names":
                        return SimpleNamespace(RETIRED=())
                    return original_loader(name, path)
                original_write = UPDATER.json_write
                def write(path, value):
                    if failure and path.name == "installed.json":
                        raise RuntimeError("test receipt failure")
                    return original_write(path, value)
                with ExitStack() as stack:
                    for name, value in {"python_layout": None, "changed_roots": set(),
                                        "roots_with_unmanaged_files": set(), "prepare_dependencies": {},
                                        "prepare_skills": {}, "prepare_host_hook_swap": None,
                                        "port_open": True, "render_mcp": b"unrelated: preserve\n"}.items():
                        stack.enter_context(patch.object(UPDATER, name, return_value=value))
                    stack.enter_context(patch.object(UPDATER, "module_at", side_effect=modules))
                    stack.enter_context(patch.object(UPDATER, "json_write", side_effect=write))
                    stack.enter_context(patch.object(bundle, "read_bundle", return_value={"versions": {"tavern": "2.2.10"}, "commit": "test"}))
                    stack.enter_context(patch.object(bundle, "extract_bundle", side_effect=extract))
                    stack.enter_context(patch("builtins.print"))
                    args = SimpleNamespace(home=home, release_dir=case, manifest_sha256="test")
                    if failure:
                        with self.assertRaisesRegex(RuntimeError, "test receipt failure"):
                            UPDATER.install(args)
                    else:
                        UPDATER.install(args)
                        UPDATER.install(args)
                self.assertEqual((home / "AGENTS.md").read_bytes(), b"old rules" if failure else DOCUMENT)
                self.assertEqual((home / "AGENTS.md.bak").read_bytes(), b"previous rules" if failure else b"old rules")
                self.assertEqual((home / "config.yaml").read_bytes(), b"unrelated: preserve\n")
                self.assertEqual((home / "clawchat/greeting.md").exists(), not failure)
                self.assertEqual(list(home.rglob("agents-rollback")), [])
                self.assertEqual(len(list(home.rglob("AGENTS.md.bak"))), 1)
