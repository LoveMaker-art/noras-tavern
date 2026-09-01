from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
CHECKER = ROOT / "ops/scripts/nora-tavern-update-check.sh"
UPDATER = ROOT / "ops/updater/update.py"


def load_updater():
    spec = importlib.util.spec_from_file_location("tavern_direct_updater_test", UPDATER)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(UPDATER.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(UPDATER.parent))
    return module


class UpdateCheckScriptTests(unittest.TestCase):
    def run_checker(self, home: Path, release: Path, *arguments: str, sender: Path | None = None):
        environment = {
            **os.environ,
            "HERMES_HOME": str(home),
            "TAVERN_UPDATE_PYTHON": sys.executable,
            "TAVERN_RELEASE_API_URL": release.as_uri(),
        }
        if sender is not None:
            environment["TAVERN_UPDATE_SENDER"] = str(sender)
        return subprocess.run(
            [CHECKER, *arguments],
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )

    def test_check_only_compares_installed_and_latest_versions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            marker = home / "apps/tavern-runtime/.tavern-release-version"
            marker.parent.mkdir(parents=True)
            marker.write_text("2.0.9\n", encoding="utf-8")
            release = root / "release.json"
            release.write_text(json.dumps({"tag_name": "v2.0.10"}), encoding="utf-8")

            result = self.run_checker(home, release, "--check-only")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                json.loads(result.stdout),
                {"installed": "2.0.9", "latest": "2.0.10", "updateAvailable": True},
            )

    def test_available_release_is_notified_only_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            marker = home / "apps/tavern-runtime/.tavern-release-version"
            marker.parent.mkdir(parents=True)
            marker.write_text("2.0.9\n", encoding="utf-8")
            release = root / "release.json"
            release.write_text(json.dumps({"tag_name": "v2.0.10"}), encoding="utf-8")
            calls = root / "calls"
            sender = root / "sender.py"
            sender.write_text(
                "from pathlib import Path\n"
                f"p = Path({str(calls)!r})\n"
                "p.write_text(p.read_text() + 'x' if p.exists() else 'x')\n",
                encoding="utf-8",
            )

            first = self.run_checker(home, release, sender=sender)
            second = self.run_checker(home, release, sender=sender)

            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(calls.read_text(encoding="utf-8"), "x")
            state = json.loads((home / "tavern-updates/notification-state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["last_notified_latest"], "2.0.10")


class UpdateCheckInstallerTests(unittest.TestCase):
    def test_install_is_idempotent_and_removes_duplicate_managed_jobs(self):
        updater = load_updater()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            cron = home / "cron"
            cron.mkdir(parents=True)
            (cron / "jobs.json").write_text(
                json.dumps({
                    "jobs": [
                        {"id": "keep", "name": "old name", "script": updater.UPDATE_CHECK_SCRIPT},
                        {"id": "duplicate", "name": updater.UPDATE_CHECK_JOB_NAME, "script": "old.sh"},
                    ]
                }),
                encoding="utf-8",
            )
            binary = root / "bin"
            binary.mkdir()
            hermes = binary / "hermes"
            hermes.write_text(
                f"#!{sys.executable}\n"
                "import json, os, sys\n"
                "from pathlib import Path\n"
                "p = Path(os.environ['HERMES_HOME']) / 'cron/jobs.json'\n"
                "data = json.loads(p.read_text())\n"
                "args = sys.argv[1:]\n"
                "action = args[1]\n"
                "def option(name, default=None):\n"
                "    return args[args.index(name) + 1] if name in args else default\n"
                "if action == 'edit':\n"
                "    job = next(j for j in data['jobs'] if j['id'] == args[2])\n"
                "    job.update({'name': option('--name'), 'script': option('--script'), 'deliver': option('--deliver'), 'no_agent': '--no-agent' in args, 'skills': [], 'prompt': option('--prompt', '')})\n"
                "    job['schedule'] = {'kind': 'cron', 'expr': option('--schedule'), 'display': option('--schedule')}\n"
                "elif action == 'remove':\n"
                "    data['jobs'] = [j for j in data['jobs'] if j['id'] != args[2]]\n"
                "elif action == 'create':\n"
                "    schedule = args[2]\n"
                "    data['jobs'].append({'id': 'created', 'name': option('--name'), 'script': option('--script'), 'deliver': option('--deliver'), 'no_agent': '--no-agent' in args, 'skills': [], 'prompt': '', 'schedule': {'kind': 'cron', 'expr': schedule, 'display': schedule}})\n"
                "p.write_text(json.dumps(data))\n",
                encoding="utf-8",
            )
            hermes.chmod(0o755)
            old_path = os.environ.get("PATH", "")
            os.environ["PATH"] = str(binary) + os.pathsep + old_path
            try:
                result = updater.install_update_check(home, ROOT / "ops")
                again = updater.install_update_check(home, ROOT / "ops")
            finally:
                os.environ["PATH"] = old_path

            self.assertEqual(result["status"], "installed")
            self.assertEqual(again["jobId"], "keep")
            jobs = json.loads((cron / "jobs.json").read_text(encoding="utf-8"))["jobs"]
            self.assertEqual(len(jobs), 1)
            self.assertEqual(jobs[0]["schedule"]["expr"], "0 9 * * *")
            self.assertTrue(jobs[0]["no_agent"])
            self.assertEqual(jobs[0]["deliver"], "local")
            for name in updater.UPDATE_CHECK_FILES:
                installed = home / "scripts" / name
                self.assertEqual(installed.read_bytes(), (ROOT / "ops/scripts" / name).read_bytes())
                self.assertTrue(installed.stat().st_mode & stat.S_IXUSR)


if __name__ == "__main__":
    unittest.main()
