import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "ops/installer/first_install.py"
SPEC = importlib.util.spec_from_file_location("nora_first_install", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FirstInstallSnapshotTests(unittest.TestCase):
    def test_restores_existing_targets_and_removes_targets_created_after_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="nora-first-install-test-") as temporary:
            home = Path(temporary) / "home"
            backup = Path(temporary) / "backup"
            existing_file = home / "config.yaml"
            existing_tree = home / "skills/creative/tavern"
            new_tree = home / "apps/tavern-runtime"
            existing_tree.mkdir(parents=True)
            existing_file.write_text("original: true\n", encoding="utf-8")
            (existing_tree / "SKILL.md").write_text("original skill\n", encoding="utf-8")

            records = MODULE.snapshot_targets(home, [existing_file, existing_tree, new_tree], backup)
            existing_file.write_text("changed: true\n", encoding="utf-8")
            (existing_tree / "SKILL.md").write_text("changed skill\n", encoding="utf-8")
            new_tree.mkdir(parents=True)
            (new_tree / "server.js").write_text("new runtime\n", encoding="utf-8")

            MODULE.restore_targets(home, records, backup)

            self.assertEqual(existing_file.read_text(encoding="utf-8"), "original: true\n")
            self.assertEqual((existing_tree / "SKILL.md").read_text(encoding="utf-8"), "original skill\n")
            self.assertFalse(new_tree.exists())

    def test_installs_the_runtime_hook_at_the_path_hermes_executes(self):
        with tempfile.TemporaryDirectory(prefix="nora-first-install-hook-") as temporary:
            root = Path(temporary)
            home = root / "home"
            source = root / "source"
            origin = source / "ops/hooks/tavern-liveware-register"
            origin.mkdir(parents=True)
            (origin / "HOOK.yaml").write_text("name: tavern-liveware-register\n", encoding="utf-8")
            (origin / "handler.py").write_text("HANDLER = 'new'\n", encoding="utf-8")
            (origin / "run.sh").write_text("#!/bin/sh\n# ensure\n", encoding="utf-8")

            installed = MODULE.install_host_hook(home, source)

            self.assertEqual(installed, str(home / "hooks/tavern-liveware-register"))
            self.assertEqual(
                (home / "hooks/tavern-liveware-register/run.sh").read_text(encoding="utf-8"),
                "#!/bin/sh\n# ensure\n",
            )


if __name__ == "__main__":
    unittest.main()
