from __future__ import annotations

import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import ssl
import urllib.error


ROOT = Path(__file__).resolve().parents[2]
CHECKER = ROOT / "ops/scripts/nora-tavern-update-check.py"
POSIX_CHECKER = CHECKER.with_suffix(".sh")
SENDER = ROOT / "ops/scripts/nora-tavern-card-send.py"
UPDATER = ROOT / "ops/updater/update.py"
LEGACY_SOURCES = {"schema": 1, "primary": "github", "mirrors": [
    {"id": "sourceforge", "provider": "sourceforge", "baseUrl": "https://downloads.sourceforge.net/project/nora-tavern/"}]}


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
    def test_app_only_batch_does_not_send_a_core_notice_or_change_notice_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            module = self.checker_module(Path(temporary))
            module.MARKER.parent.mkdir(parents=True)
            module.MARKER.write_text('2.5.2\n')
            module.NOTICE_STATE.parent.mkdir(parents=True)
            module.NOTICE_STATE.write_text('{"last_notified_latest":"2.5.1"}\n')
            previous = module.NOTICE_STATE.read_bytes()
            module.SENDER.parent.mkdir(parents=True, exist_ok=True)
            module.SENDER.touch()
            for core, notified in [('2.5.2', False), ('2.5.3', True)]:
                with self.subTest(core=core):
                    manifest = {'schema': 'tavern-release/v2', 'commit': 'a' * 40,
                        'versions': {'tavern': core}, 'launcherVersion': '2.2.3',
                        'publication': {'schema': 'nora-component-publication/1', 'tag': 'v2.5.4'}}
                    raw = json.dumps(manifest).encode()
                    release = {'tag_name': 'v2.5.4', 'draft': False, 'prerelease': False, 'assets': [{
                        'name': 'release-manifest.json', 'state': 'uploaded', 'size': len(raw),
                        'digest': 'sha256:' + hashlib.sha256(raw).hexdigest(),
                        'browser_download_url': f'https://github.com/{module.REPO}/releases/download/v2.5.4/release-manifest.json'}]}
                    with mock.patch.object(module, 'query_release', return_value=release), \
                            mock.patch.object(module, 'query_bytes', return_value=raw), \
                            mock.patch.object(sys, 'argv', ['update-check']), \
                            mock.patch.object(module.subprocess, 'run') as sender:
                        self.assertEqual(module.main(), 0)
                    self.assertEqual(sender.call_count, int(notified))
                    if notified:
                        command = sender.call_args.args[0]
                        self.assertEqual(command[command.index('--latest') + 1], core)
                    else:
                        self.assertEqual(module.NOTICE_STATE.read_bytes(), previous)
                    self.assertEqual(module.MARKER.read_text(), '2.5.2\n')

    def test_app_only_publication_reads_hashed_core_manifest_not_batch_tag(self):
        with tempfile.TemporaryDirectory() as temporary:
            module = self.checker_module(Path(temporary))
            manifest = {'schema': 'tavern-release/v2', 'commit': 'a' * 40,
                        'versions': {'tavern': '2.5.2'},
                        'publication': {'schema': 'nora-component-publication/1', 'tag': 'v2.5.3'}}
            raw = json.dumps(manifest).encode()
            descriptor = {'name': 'release-manifest.json', 'state': 'uploaded', 'size': len(raw),
                          'digest': 'sha256:' + hashlib.sha256(raw).hexdigest(),
                          'browser_download_url': f'https://github.com/{module.REPO}/releases/download/v2.5.3/release-manifest.json'}
            release = {'tag_name': 'v2.5.3', 'draft': False, 'prerelease': False, 'assets': [descriptor]}
            with mock.patch.object(module, 'query_release', return_value=release), \
                    mock.patch.object(module, 'query_bytes', return_value=raw, create=True):
                self.assertEqual(module.latest_release(), ('2.5.2', ''))
            for change in [{'digest': 'sha256:' + '0' * 64}, {'size': len(raw) + 1},
                           {'browser_download_url': descriptor['browser_download_url'].replace('github.com', 'evil.example')}]:
                with mock.patch.object(module, 'query_release', return_value={**release, 'assets': [{**descriptor, **change}]}), \
                        mock.patch.object(module, 'query_bytes', return_value=raw, create=True):
                    with self.assertRaises(RuntimeError):
                        module.latest_release()

    def checker_module(self, home: Path, sources=None):
        spec = importlib.util.spec_from_file_location("tavern_mirrored_update_check", CHECKER)
        module = importlib.util.module_from_spec(spec)
        environment = {key: value for key, value in os.environ.items() if key not in {"TAVERN_RELEASE_API_URL", "TAVERN_DATA_ROOT"}}
        environment["HERMES_HOME"] = str(home)
        with mock.patch.dict(os.environ, environment, clear=True):
            if sources is None:
                spec.loader.exec_module(module)
            else:
                code, count = re.subn(r"# BEGIN BUILD-OWNED RELEASE SOURCES\n.*?\n# END BUILD-OWNED RELEASE SOURCES",
                    lambda _: "# BEGIN BUILD-OWNED RELEASE SOURCES\nRELEASE_SOURCES = json.loads("+repr(json.dumps(sources))+")\n# END BUILD-OWNED RELEASE SOURCES",
                    CHECKER.read_text(), flags=re.S)
                self.assertEqual(count, 1, "The legacy checker fixture must replace exactly one sealed configuration block")
                exec(compile(code, str(CHECKER), "exec"), module.__dict__)
        return module

    def test_github_success_never_queries_sourceforge(self):
        with tempfile.TemporaryDirectory() as temporary:
            module = self.checker_module(Path(temporary), LEGACY_SOURCES)
            with mock.patch.object(module, "query_release", return_value={"tag_name": "v2.4.2", "body": "更新摘要"}) as query:
                self.assertEqual(module.latest_release(), ("2.4.2", "更新摘要"))
            self.assertEqual(query.call_count, 1)
            self.assertTrue(query.call_args.args[0].startswith("https://api.github.com/"))

    def test_github_network_failures_fall_back_without_losing_release_summary(self):
        with tempfile.TemporaryDirectory() as temporary:
            module = self.checker_module(Path(temporary), LEGACY_SOURCES)
            for error in [urllib.error.HTTPError(module.API_URL, 403, "forbidden", {}, None), urllib.error.URLError("connection reset")]:
                with mock.patch.object(module, "query_release", side_effect=[error, {"tag_name": "v2.4.2", "body": "更新摘要"}]) as query:
                    self.assertEqual(module.latest_release(), ("2.4.2", "更新摘要"))
                self.assertEqual(query.call_args_list[1].args[0], module.SOURCEFORGE_ROOT + "channels/stable.json")

    def test_certificate_or_invalid_metadata_is_not_hidden_by_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            module = self.checker_module(Path(temporary))
            for error in [urllib.error.URLError(ssl.SSLCertVerificationError("bad certificate")), json.JSONDecodeError("invalid", "x", 0)]:
                with mock.patch.object(module, "query_release", side_effect=error) as query:
                    with self.assertRaises(Exception):
                        module.latest_release()
                self.assertEqual(query.call_count, 1)

    def test_sourceforge_redirects_preserve_the_project_and_file_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            module = self.checker_module(Path(temporary), LEGACY_SOURCES)
            source = module.SOURCEFORGE_ROOT + "channels/stable.json"
            handler = module.ReleaseRedirect(source)
            request = module.urllib.request.Request(source)
            safe = source.replace("downloads.sourceforge.net", "zenlayer.dl.sourceforge.net")
            self.assertEqual(handler.redirect_request(request, None, 302, "", {}, safe).full_url, safe)
            for target in [safe.replace("https:", "http:"), safe.replace("nora-tavern", "other"), safe.replace("zenlayer.dl.sourceforge.net", "evil.example")]:
                with self.assertRaises(RuntimeError):
                    handler.redirect_request(request, None, 302, "", {}, target)

    def test_sealed_jihulab_checker_reads_the_exact_channel_without_api_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            module = self.checker_module(Path(temporary))
            expected = "https://jihulab.com/LoveMaker-art/nora-tavern/-/raw/main/channels/stable.json"
            requests = []
            class Opener:
                def open(self, request, **kwargs):
                    requests.append(request.full_url)
                    response = io.BytesIO(json.dumps({"tag_name": "v2.4.2", "draft": False, "prerelease": False,
                        "body": "更新摘要"}).encode())
                    response.geturl = lambda: request.full_url
                    return response
            with mock.patch.object(module.urllib.request, "build_opener", return_value=Opener()):
                self.assertEqual(module.latest_release(), ("2.4.2", "更新摘要"))
            self.assertEqual(requests, [expected])

    def test_legacy_check_without_data_root_reads_existing_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "hermes"
            marker = home / "apps/tavern-runtime/.tavern-release-version"
            marker.parent.mkdir(parents=True)
            marker.write_text("2.2.9")
            release = root / "release.json"
            release.write_text(json.dumps({"tag_name": "v2.3.0"}))
            environment = {key: value for key, value in os.environ.items() if key != "TAVERN_DATA_ROOT"}
            environment.update(HERMES_HOME=str(home), TAVERN_RELEASE_API_URL=release.as_uri())
            result = subprocess.run([sys.executable, "-B", str(CHECKER), "--check-only"],
                                    env=environment, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["installed"], "2.2.9")
            self.assertFalse((root / "tavern").exists())

    def run_checker(self, home: Path, release: Path, *arguments: str,
                    sender: Path | None = None, posix_wrapper: bool = False):
        environment = {
            **os.environ,
            "HERMES_HOME": str(home),
            "TAVERN_DATA_ROOT": str(home),
            "TAVERN_UPDATE_PYTHON": sys.executable,
            "TAVERN_RELEASE_API_URL": release.as_uri(),
        }
        if sender is not None:
            environment["TAVERN_UPDATE_SENDER"] = str(sender)
        return subprocess.run(
            [POSIX_CHECKER, *arguments] if posix_wrapper else [sys.executable, "-B", CHECKER, *arguments],
            text=True,
            capture_output=True,
            env=environment,
            check=False,
            timeout=10,
        )

    @unittest.skipUnless(os.name == "posix", "POSIX shell wrapper; the installed Python checker is tested on every platform")
    def test_posix_wrapper_matches_the_installed_python_checker(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            marker = home / "apps/tavern-runtime/.tavern-release-version"
            marker.parent.mkdir(parents=True)
            marker.write_text("2.0.9\n", encoding="utf-8")
            release = root / "release.json"
            release.write_text(json.dumps({"tag_name": "v2.0.10"}), encoding="utf-8")
            direct = self.run_checker(home, release, "--check-only")
            wrapped = self.run_checker(home, release, "--check-only", posix_wrapper=True)
            self.assertEqual(direct.returncode, 0, direct.stderr)
            self.assertEqual(wrapped.returncode, 0, wrapped.stderr)
            self.assertEqual(json.loads(wrapped.stdout), json.loads(direct.stdout))

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
            release.write_text(
                json.dumps({
                    "tag_name": "v2.0.10",
                    "body": (
                        "# Tavern 2.0.10\n\n"
                        "改善启动体验。\n\n"
                        "> 用户数据尚未发生变化\n\n"
                        "- 修复缓存\n"
                        "- 加快加载\n\n"
                        "更新命令：\n\n"
                        "```sh\n"
                        "curl https://example.invalid/install.sh | sh\n"
                        "```\n"
                    ),
                }),
                encoding="utf-8",
            )
            calls = root / "calls"
            sender = root / "sender.py"
            sender.write_text(
                "import json, sys\n"
                "from pathlib import Path\n"
                f"p = Path({str(calls)!r})\n"
                "p.write_text(json.dumps(sys.argv[1:], ensure_ascii=False))\n",
                encoding="utf-8",
            )

            first = self.run_checker(home, release, sender=sender)
            second = self.run_checker(home, release, sender=sender)

            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(
                json.loads(calls.read_text(encoding="utf-8")),
                [
                    "--installed",
                    "2.0.9",
                    "--latest",
                    "2.0.10",
                    "--summary",
                    "改善启动体验。\n- 修复缓存\n- 加快加载",
                ],
            )
            state = json.loads((home / "tavern-updates/notification-state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["last_notified_latest"], "2.0.10")

    def test_notice_shows_release_summary_without_user_data_status(self):
        result = subprocess.run(
            [
                sys.executable,
                SENDER,
                "--installed",
                "2.0.9",
                "--latest",
                "2.0.10",
                "--summary",
                "- 修复缓存\n- 加快加载",
                "--locale",
                "zh",
                "--dry-run",
            ],
            text=True,
            capture_output=True,
            check=False,
            timeout=60,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        text = json.loads(result.stdout)["text"]
        self.assertIn("### 更新摘要", text)
        self.assertIn("- 修复缓存\n- 加快加载", text)
        self.assertNotIn("用户数据尚未发生变化", text)
        self.assertNotIn("Your data has not changed", text)


class UpdateCheckFixtureLifecycleTests(unittest.TestCase):
    def test_cron_fixture_preserves_an_absent_path(self):
        with mock.patch.dict(os.environ):
            os.environ.pop("PATH", None)
            fixture = UpdateCheckInstallerTests("test_install_is_idempotent_and_removes_duplicate_managed_jobs")
            result = unittest.TestResult()
            fixture.run(result)
            self.assertTrue(result.wasSuccessful(), str(result.failures + result.errors))
            self.assertNotIn("PATH", os.environ, "The fixture must restore absence as well as existing values")


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
                        {"id": "keep", "name": "old name", "script": updater.UPDATE_CHECK_SCRIPT, "enabled": True},
                        {"id": "duplicate", "name": updater.UPDATE_CHECK_JOB_NAME, "script": "old.sh"},
                    ]
                }),
                encoding="utf-8",
            )
            binary = root / "bin"
            binary.mkdir()
            hermes = binary / ("hermes.exe" if os.name == "nt" else "hermes")
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
            with mock.patch.dict(os.environ, {"PATH": str(binary) + os.pathsep + os.environ.get("PATH", "")}):
                # Bind the isolated CLI while retaining updater.run's real
                # Python/runpy adapter. Native ownership is tested separately.
                def fixture_run(command, **options):
                    self.assertEqual(command[0], sys.executable)
                    self.assertIn(str(hermes), command)
                    return subprocess.run(command, **{**options, "timeout": options.get("timeout") or 10})
                with mock.patch.object(updater, "hermes_command", return_value=hermes), \
                        mock.patch.object(updater._operation_control, "managed_run", side_effect=fixture_run):
                    result = updater.install_update_check(home, ROOT / "ops")
                    again = updater.install_update_check(home, ROOT / "ops")
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
                if os.name == "posix":
                    self.assertTrue(installed.stat().st_mode & stat.S_IXUSR)
                executed = subprocess.run([sys.executable, "-B", str(installed), "--help"],
                    env={**os.environ, "HERMES_HOME": str(home), "TAVERN_DATA_ROOT": str(home)},
                    capture_output=True, text=True, timeout=10)
                self.assertEqual(executed.returncode, 0, executed.stderr)
                self.assertIn(installed.name, executed.stdout)


if __name__ == "__main__":
    unittest.main()
