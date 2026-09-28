from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
UPDATER = ROOT / "ops/updater/update.py"
SERVICE_MANAGER = ROOT / "ops/updater/service_manager.py"


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
            script.write_text(
                "import signal, time\n"
                "signal.signal(signal.SIGTERM, lambda *_: raise SystemExit(0))\n"
                "while True:\n"
                "    time.sleep(1)\n",
                encoding="utf-8",
            )
            child = subprocess.Popen(
                [sys.executable, str(script), "--port", "8799"],
                cwd=root,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and child.poll() is not None:
                    time.sleep(0.05)
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

        self.assertTrue(service_manager.service_references_app(
            Path("/opt/data/apps/tavern-runtime"),
            "/opt/hermes/.venv/bin/python /opt/data/apps/tavern-runtime/server.py --port 8799",
            "/opt/data",
        ))

    def test_unrelated_service_is_ignored(self):
        service_manager = load_service_manager()

        self.assertFalse(service_manager.service_references_app(
            Path("/opt/data/apps/tavern-runtime"),
            "/usr/bin/python3 /tmp/other-app/server.py --port 8799",
            "/tmp/other-app",
        ))


if __name__ == "__main__":
    unittest.main()
