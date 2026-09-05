import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "ops/updater/update.py"
SPEC = importlib.util.spec_from_file_location("nora_updater_host_hook", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class UpdaterHostHookTests(unittest.TestCase):
    def test_marks_a_stale_runtime_hook_for_transactional_replacement(self):
        with tempfile.TemporaryDirectory(prefix="nora-update-hook-") as temporary:
            root = Path(temporary)
            home = root / "home"
            source = root / "source"
            current = home / "hooks/tavern-liveware-register"
            desired = source / "ops/hooks/tavern-liveware-register"
            prepared_root = root / "prepared"
            current.mkdir(parents=True)
            desired.mkdir(parents=True)
            (current / "run.sh").write_text("old provision\n", encoding="utf-8")
            (desired / "run.sh").write_text("ensure\n", encoding="utf-8")
            (desired / "handler.py").write_text("handler\n", encoding="utf-8")
            (desired / "HOOK.yaml").write_text("name: tavern-liveware-register\n", encoding="utf-8")

            swap = MODULE.prepare_host_hook_swap(home, source, prepared_root)

            self.assertEqual(
                swap,
                (
                    "host-hook-tavern-liveware-register",
                    prepared_root / "tavern-liveware-register",
                    current,
                ),
            )
            self.assertEqual((swap[1] / "run.sh").read_text(encoding="utf-8"), "ensure\n")

    def test_skips_an_identical_runtime_hook(self):
        with tempfile.TemporaryDirectory(prefix="nora-update-hook-") as temporary:
            root = Path(temporary)
            home = root / "home"
            source = root / "source"
            current = home / "hooks/tavern-liveware-register"
            desired = source / "ops/hooks/tavern-liveware-register"
            current.mkdir(parents=True)
            desired.mkdir(parents=True)
            for name in ("run.sh", "handler.py", "HOOK.yaml"):
                (current / name).write_text(name + "\n", encoding="utf-8")
                (desired / name).write_text(name + "\n", encoding="utf-8")

            self.assertIsNone(MODULE.prepare_host_hook_swap(home, source, root / "prepared"))

    def test_ops_swap_cannot_invalidate_the_prepared_runtime_hook(self):
        with tempfile.TemporaryDirectory(prefix="nora-update-hook-order-") as temporary:
            root = Path(temporary)
            home = root / "home"
            source = root / "source"
            current = home / "hooks/tavern-liveware-register"
            desired = source / "ops/hooks/tavern-liveware-register"
            current.mkdir(parents=True)
            desired.mkdir(parents=True)
            (source / "ops/updater").mkdir(parents=True)
            (source / "ops/updater/update.py").write_text("new updater\n", encoding="utf-8")
            for name in ("run.sh", "handler.py", "HOOK.yaml"):
                (current / name).write_text("old " + name + "\n", encoding="utf-8")
                (desired / name).write_text("new " + name + "\n", encoding="utf-8")

            hook_swap = MODULE.prepare_host_hook_swap(home, source, root / "prepared")
            MODULE.swap_tree(source / "ops", home / "apps/tavern-ops", root / "backup/ops")
            MODULE.swap_tree(hook_swap[1], hook_swap[2], root / "backup/host-hook")

            self.assertEqual(
                (home / "apps/tavern-ops/hooks/tavern-liveware-register/run.sh").read_text(encoding="utf-8"),
                "new run.sh\n",
            )
            self.assertEqual(current.joinpath("run.sh").read_text(encoding="utf-8"), "new run.sh\n")


if __name__ == "__main__":
    unittest.main()
