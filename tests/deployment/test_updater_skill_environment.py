import importlib.util
from pathlib import Path
import subprocess
import json
import time
import os
import sys
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
                home / "hermes-agent/venv/bin/python",
            ])

    def test_skips_interpreter_without_dependencies(self):
        results = [subprocess.CompletedProcess([], 1, "", "ModuleNotFoundError: yaml"),
                   subprocess.CompletedProcess([], 0, "", "")]
        with patch.object(MODULE, "candidates", return_value=iter([
            Path("/system/python3"), Path("/hermes/venv/bin/python3"),
        ])), patch.object(Path, "is_file", return_value=True), patch.object(
            MODULE.subprocess, "run", side_effect=results,
        ):
            self.assertEqual(MODULE.select_python(Path("/home")), str(Path("/hermes/venv/bin/python3").absolute()))

    def test_space_path_stays_one_argument(self):
        candidate = Path("/home/my hermes/venv/bin/python3").absolute()
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
            with self.assertRaisesRegex(SystemExit, "ModuleNotFoundError: yaml"):
                MODULE.select_python(Path("/home"))

    def test_probe_timeout_is_bounded_and_reported(self):
        with patch.object(MODULE, "candidates", return_value=iter([Path("/stuck/python3")])), patch.object(
            Path, "is_file", return_value=True,
        ), patch.object(MODULE.subprocess, "run", side_effect=subprocess.TimeoutExpired("python", 10)):
            with self.assertRaisesRegex(SystemExit, "TimeoutExpired"):
                MODULE.select_python(Path("/home"))

    def managed(self, directory):
        root = Path(directory).resolve()
        home = root / 'hermes'
        home.mkdir()
        (home / 'nora-instance.json').write_text(json.dumps({
            'schema': 1, 'noraHome': str(root), 'hermesHome': str(home), 'installRoot': str(root / 'tavern')}))
        target = root / 'installer/skill-update'
        target.mkdir(parents=True)
        (target / 'endpoint.json').write_text(json.dumps({
            'schema': 1, 'session': 'current', 'noraHome': str(root), 'updatedAt': int(time.time() * 1000)}))
        return home, target

    def test_managed_handoff_uses_actual_instance_root_and_never_runs_a_process(self):
        with tempfile.TemporaryDirectory(prefix='nora with spaces ') as directory:
            home, target = self.managed(directory)
            with patch.object(MODULE.time, 'monotonic', side_effect=[0, 9]), patch.object(MODULE.subprocess, 'call') as call:
                result = MODULE.managed_request(home, 'update')
            self.assertEqual(result['status'], 'queued')
            self.assertEqual(result['action'], 'update')
            self.assertEqual(json.loads((target / 'request.json').read_text())['id'], result['id'])
            call.assert_not_called()
            self.assertEqual(MODULE.managed_request(home, 'check')['id'], result['id'])
            self.assertEqual(MODULE.managed_request(home, 'status')['id'], result['id'])

    def test_offline_launcher_or_wrong_instance_fails_without_a_task(self):
        with tempfile.TemporaryDirectory() as directory:
            home, target = self.managed(directory)
            (target / 'endpoint.json').unlink()
            with self.assertRaisesRegex(RuntimeError, '启动器'):
                MODULE.managed_request(home, 'update')
            self.assertFalse((target / 'request.json').exists())
            instance = json.loads((home / 'nora-instance.json').read_text())
            instance['installRoot'] = str(home / 'wrong')
            (home / 'nora-instance.json').write_text(json.dumps(instance))
            with self.assertRaisesRegex(RuntimeError, 'Conflicting'):
                MODULE.managed_root(home)

    def test_standalone_calls_bootstrap_with_verified_paths_not_raw_updater(self):
        with tempfile.TemporaryDirectory(prefix='nora 中文 ') as directory:
            root = Path(directory).resolve()
            home = root / 'home'
            home.mkdir()
            entry = root / 'tavern/apps/tavern-ops/updater/bootstrap.py'
            with patch.dict(os.environ, {'HERMES_HOME': str(home)}), \
                    patch.object(sys, 'argv', ['update.py', '--apply', '--confirm']), \
                    patch.object(MODULE, 'select_python', return_value=os.path.abspath(sys.executable)), \
                    patch.object(MODULE, 'standalone_entry', return_value=(entry, root / 'tavern')), \
                    patch.object(MODULE.subprocess, 'call', return_value=0) as call:
                with self.assertRaises(SystemExit) as result:
                    MODULE.main()
            self.assertEqual(result.exception.code, 0)
            self.assertEqual(call.call_args.args[0], [os.path.abspath(sys.executable), '-u', '-B', str(entry),
                '--hermes-home', str(home), '--install-root', str(root / 'tavern'), '--apply', '--confirm'])
            self.assertEqual(call.call_args.kwargs['env']['TAVERN_DATA_ROOT'], str(root / 'tavern'))

    def test_update_requires_confirmation_before_probe_or_execution(self):
        with patch.object(sys, 'argv', ['update.py', '--apply']), patch.object(MODULE, 'select_python') as probe:
            with self.assertRaisesRegex(RuntimeError, '授权'):
                MODULE.main()
            probe.assert_not_called()

    def test_empty_probe_error_is_reported_without_index_error(self):
        with patch.object(MODULE, 'candidates', return_value=iter([Path('/broken/python')])), \
                patch.object(Path, 'is_file', return_value=True), \
                patch.object(MODULE.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', '')):
            with self.assertRaisesRegex(SystemExit, 'exit 1'):
                MODULE.select_python(Path('/home'))

    def test_status_survives_a_broken_hermes_interpreter(self):
        with tempfile.TemporaryDirectory() as directory:
            home, target = self.managed(directory)
            (target / 'request.json').write_text(json.dumps({'status': 'error', 'error': 'test failure'}))
            with patch.dict(os.environ, {'HERMES_HOME': str(home)}), \
                    patch.object(sys, 'argv', ['update.py', '--status']), \
                    patch.object(MODULE, 'select_python', side_effect=AssertionError('no interpreter needed')), \
                    patch('builtins.print') as output:
                with self.assertRaises(SystemExit) as result:
                    MODULE.main()
            self.assertEqual(result.exception.code, 1)
            self.assertEqual(json.loads(output.call_args.args[0])['error'], 'test failure')


if __name__ == "__main__":
    unittest.main()
