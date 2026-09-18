import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "updater_skill_environment",
    ROOT / "nora/skills/system/tavern-updater/scripts/update.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class UpdaterSkillEnvironmentTests(unittest.TestCase):
    def test_managed_installation_does_not_fall_back_to_system(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "nora-instance.json").touch()
            self.assertEqual(list(MODULE.candidates(home)), [
                home / "hermes-agent/venv/Scripts/python.exe",
                home / "hermes-agent/venv/bin/python3",
            ])

    def test_skips_interpreter_without_dependencies(self):
        results = [subprocess.CompletedProcess([], 1, "", "ModuleNotFoundError: yaml"),
                   subprocess.CompletedProcess([], 0, "", "")]
        with patch.object(MODULE, "candidates", return_value=iter([
            Path("/system/python3"), Path("/hermes/venv/bin/python3"),
        ])), patch.object(Path, "is_file", return_value=True), patch.object(
            MODULE.subprocess, "run", side_effect=results,
        ):
            self.assertEqual(MODULE.select_python(Path("/home")), "/hermes/venv/bin/python3")

    def test_space_path_stays_one_argument(self):
        candidate = Path("/home/my hermes/venv/bin/python3")
        with patch.object(MODULE, "candidates", return_value=iter([candidate])), patch.object(
            Path, "is_file", return_value=True,
        ), patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(MODULE.select_python(Path("/home")), str(candidate))
            self.assertEqual(run.call_args.args[0][0], str(candidate))

    def test_missing_dependencies_fail_with_path_and_reason(self):
        with patch.object(MODULE, "candidates", return_value=iter([Path("/system/python3")])), patch.object(
            Path, "is_file", return_value=True,
        ), patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess(
            [], 1, "", "ModuleNotFoundError: yaml",
        )):
            with self.assertRaisesRegex(SystemExit, "/system/python3: ModuleNotFoundError: yaml"):
                MODULE.select_python(Path("/home"))

    def test_probe_timeout_is_bounded_and_reported(self):
        with patch.object(MODULE, "candidates", return_value=iter([Path("/stuck/python3")])), patch.object(
            Path, "is_file", return_value=True,
        ), patch.object(MODULE.subprocess, "run", side_effect=subprocess.TimeoutExpired("python", 10)):
            with self.assertRaisesRegex(SystemExit, "TimeoutExpired"):
                MODULE.select_python(Path("/home"))


if __name__ == "__main__":
    unittest.main()
