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


if __name__ == "__main__":
    unittest.main()
