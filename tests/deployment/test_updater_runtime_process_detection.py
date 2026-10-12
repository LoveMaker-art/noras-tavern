from __future__ import annotations

import importlib.util
import os
import shlex
import subprocess
from pathlib import Path
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
UPDATER = ROOT / "ops/updater/update.py"
SERVICE_MANAGER = ROOT / "ops/updater/service_manager.py"


def legacy_server_source():
    return '''import signal, time
from pathlib import Path
def stop(*_):
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
Path(__file__).with_suffix('.ready').write_text('ready', encoding='utf-8')
while True:
    time.sleep(1)
'''


def start_legacy_server_fixture(script, cwd):
    source = legacy_server_source()
    compile(source, str(script), 'exec')
    script.write_text(source, encoding='utf-8')
    ready = script.with_suffix('.ready')
    ready.unlink(missing_ok=True)
    child = subprocess.Popen([sys.executable, '-B', str(script), '--port', '8799'], cwd=cwd,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 3
    while not ready.is_file() and child.poll() is None and time.monotonic() < deadline:
        time.sleep(0.01)
    if not ready.is_file() or child.poll() is not None:
        code = child.poll()
        if code is None:
            child.kill()
            child.wait(timeout=3)
        raise AssertionError(f'The legacy Python server fixture did not acknowledge startup (exit={code}).')
    return child


def load_updater():
    spec = importlib.util.spec_from_file_location("tavern_direct_updater_process_test", UPDATER)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(UPDATER.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(UPDATER.parent))
    return module


def load_service_manager():
    spec = importlib.util.spec_from_file_location(
        "tavern_direct_updater_service_manager_test",
        SERVICE_MANAGER,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class UpdaterRuntimeProcessDetectionTests(unittest.TestCase):
    @unittest.skipIf(os.name == 'nt', 'This fixture check exercises POSIX SIGTERM handling')
    def test_legacy_server_fixture_acknowledges_start_and_handles_sigterm(self):
        # This proves the generated actor, not Linux updater process discovery.
        with tempfile.TemporaryDirectory(prefix='tavern-legacy-actor-') as temporary:
            root = Path(temporary)
            child = start_legacy_server_fixture(root / 'server.py', root)
            try:
                self.assertTrue((root / 'server.ready').is_file())
                self.assertIsNone(child.poll())
                child.terminate()
                self.assertEqual(child.wait(timeout=3), 0)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=3)

    def test_detects_legacy_python_server_when_cwd_is_outside_app(self):
        updater = load_updater()
        app = Path("/opt/data/apps/tavern-runtime")

        matched = updater.runtime_process_belongs_to_app(
            app,
            Path("/opt/data"),
            [
                "/opt/hermes/.venv/bin/python",
                "/opt/data/apps/tavern-runtime/server.py",
                "--port",
                "8799",
            ],
        )

        self.assertTrue(matched)

    def test_detects_relative_server_when_cwd_is_app(self):
        updater = load_updater()
        app = Path("/opt/data/apps/tavern-runtime")

        matched = updater.runtime_process_belongs_to_app(
            app,
            app,
            ["/usr/bin/python3", "server.py", "--port", "8799"],
        )

        self.assertTrue(matched)

    def test_ignores_unrelated_server_with_same_port(self):
        updater = load_updater()

        matched = updater.runtime_process_belongs_to_app(
            Path("/opt/data/apps/tavern-runtime"),
            Path("/tmp/other-app"),
            ["/usr/bin/python3", "/tmp/other-app/server.py", "--port", "8799"],
        )

        self.assertFalse(matched)

    @unittest.skipUnless(Path("/proc").is_dir(), "requires Linux /proc process inspection")
    def test_stop_unmanaged_stops_legacy_process_started_from_outside_app(self):
        updater = load_updater()
        with tempfile.TemporaryDirectory(prefix="tavern-updater-stop-test-") as temporary:
            root = Path(temporary)
            app = root / "apps/tavern-runtime"
            app.mkdir(parents=True)
            script = app / "server.py"
            child = start_legacy_server_fixture(script, root)
            try:
                self.assertIsNone(child.poll())

                stopped = updater.stop_unmanaged(app)

                self.assertIn(child.pid, stopped)
                child.wait(timeout=3)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=3)


class ManagedServiceDiscoveryMatchingTests(unittest.TestCase):
    def test_service_directory_may_be_inside_app_root(self):
        service_manager = load_service_manager()

        self.assertTrue(service_manager.service_references_app(
            Path("/opt/data/apps/tavern-runtime"),
            "node server.js --port 8799",
            "/opt/data/apps/tavern-runtime/engine/sillytavern",
        ))

    def test_service_command_may_point_at_legacy_server_inside_app(self):
        service_manager = load_service_manager()
        with tempfile.TemporaryDirectory(prefix='tavern-service-command-') as temporary:
            root = Path(temporary).resolve()
            app = root / 'apps/tavern-runtime'
            command = shlex.join([sys.executable, str(app / 'server.py'), '--port', '8799'])
            self.assertTrue(service_manager.service_references_app(app, command, str(root)))

    def test_unrelated_service_is_ignored(self):
        service_manager = load_service_manager()

        self.assertFalse(service_manager.service_references_app(
            Path("/opt/data/apps/tavern-runtime"),
            "/usr/bin/python3 /tmp/other-app/server.py --port 8799",
            "/tmp/other-app",
        ))


if __name__ == "__main__":
    unittest.main()
