from __future__ import annotations

from contextlib import contextmanager, redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
LIFECYCLE = ROOT / "app/native_lifecycle.py"


def load_lifecycle():
    spec = importlib.util.spec_from_file_location("tavern_native_lifecycle_lock_test", LIFECYCLE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class NonReentrantLock:
    def __init__(self):
        self.active = False
        self.acquisitions = 0

    @contextmanager
    def installation_lock(self, _home):
        if self.active:
            raise RuntimeError("recursive lifecycle lock")
        self.active = True
        self.acquisitions += 1
        try:
            yield
        finally:
            self.active = False


class FakeRuntime:
    def __init__(self):
        self.data_root = Path("/tmp/tavern-lock-test")
        self.state_root = self.data_root / "state"
        self.lock = NonReentrantLock()
        self.calls = []

    def operations_module(self, name):
        if name != "runtime_lock":
            raise AssertionError(name)
        return types.SimpleNamespace(installation_lock=self.lock.installation_lock)

    def start(self, run_id="production", port=8799, data_root=None, *, assets_prepared=False):
        with self.lock.installation_lock(self.data_root):
            return self._start(run_id, port, data_root, assets_prepared=assets_prepared)

    def _start(self, run_id, port, data_root, *, assets_prepared):
        self.calls.append(("start", run_id, port, data_root, assets_prepared))
        return {"ok": True, "health": {"ok": True}}

    def stop_run(self, run_id="production"):
        with self.lock.installation_lock(self.data_root):
            return self._stop_run(run_id)

    def _stop_run(self, run_id):
        self.calls.append(("stop", run_id))
        return {"ok": True}

    def install(self):
        self.calls.append(("install",))
        return {"ok": True}

    def sync_assets(self, native_data_root=None):
        self.calls.append(("sync", native_data_root))
        return {"ok": True}

    def write_ready_marker(self, health):
        self.calls.append(("ready", health))
        return {"ok": True}


class NativeLifecycleLockTests(unittest.TestCase):
    def invoke(self, *arguments):
        lifecycle = load_lifecycle()
        runtime = FakeRuntime()
        output = io.StringIO()
        with (
            mock.patch.object(lifecycle.NativeRuntime, "from_environment", return_value=runtime),
            redirect_stdout(output),
        ):
            lifecycle.main(list(arguments))
        return runtime, output.getvalue()

    def test_production_logging_config_disables_request_and_debug_noise(self):
        lifecycle = load_lifecycle()
        source = "logging:\n  enableAccessLog: true\n  minLogLevel: 0\nperformance:\n  lazyLoadCharacters: true\n"

        rendered = lifecycle.render_production_logging_config(source)

        self.assertIn("  enableAccessLog: false", rendered)
        self.assertIn("  minLogLevel: 1", rendered)
        self.assertIn("  lazyLoadCharacters: true", rendered)

    def test_production_logging_config_upgrades_legacy_config_without_logging_keys(self):
        lifecycle = load_lifecycle()

        rendered = lifecycle.render_production_logging_config("listen: false\n")

        self.assertIn("logging:\n  enableAccessLog: false\n  minLogLevel: 1", rendered)

    def test_runtime_log_keeps_only_one_bounded_previous_file(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory() as temporary:
            log_path = Path(temporary) / "native.log"
            log_path.write_bytes(b"old-log")

            lifecycle.prepare_runtime_log(log_path, max_bytes=4)

            self.assertFalse(log_path.exists())
            self.assertEqual((Path(temporary) / "native.log.1").read_bytes(), b"old-log")

    def test_start_cli_owns_the_lifecycle_lock_once(self):
        runtime, _ = self.invoke("start")

        self.assertEqual(runtime.lock.acquisitions, 1)
        self.assertEqual(runtime.calls, [("start", "production", 8799, None, False)])

    def test_restart_cli_stops_and_starts_inside_one_lock(self):
        runtime, _ = self.invoke("restart")

        self.assertEqual(runtime.lock.acquisitions, 1)
        self.assertEqual(
            runtime.calls,
            [
                ("stop", "production"),
                ("start", "production", 8799, None, False),
            ],
        )

    def test_prepare_cli_uses_one_lock_for_the_canary_transaction(self):
        runtime, _ = self.invoke("prepare")

        self.assertEqual(runtime.lock.acquisitions, 1)
        self.assertEqual(
            runtime.calls,
            [
                ("install",),
                ("start", "canary", 18801, runtime.state_root / "native-canary", False),
                ("ready", {"ok": True}),
                ("stop", "canary"),
            ],
        )

    def test_failed_start_cleans_up_without_reacquiring_the_lock(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
            runtime.data_root = root
            runtime.state_root = root / "state"
            runtime.native_data_root = runtime.state_root / "native"
            runtime.runtime_state = runtime.state_root / "native-runtime"
            runtime.engine_root = root / "engine"
            runtime.engine_root.mkdir()
            runtime.contract = types.SimpleNamespace(commit="test")
            runtime.config_path = runtime.runtime_state / "config.yaml"
            runtime._children = {}
            runtime.verify_install = mock.Mock()
            runtime.sync_assets = mock.Mock()
            runtime.managed_service = mock.Mock(return_value=None)
            runtime._read_pid = mock.Mock(return_value=None)
            runtime.node_command = mock.Mock(return_value=["node", "server.js"])
            runtime.spawn = mock.Mock(return_value=types.SimpleNamespace(pid=123))
            runtime.wait_for_health = mock.Mock(side_effect=RuntimeError("health failure"))
            runtime.stop_run = mock.Mock(side_effect=AssertionError("public stop reacquired the lock"))
            runtime._stop_run = mock.Mock(return_value={"ok": True})
            processes = types.SimpleNamespace(
                port_open=lambda _port: False,
                process_record=lambda _pid, _script: {
                    "pid": 123,
                    "argv": ["node", "server.js"],
                    "cwd": str(runtime.engine_root),
                },
                require_listener=lambda *_args, **_kwargs: None,
            )
            runtime.process_module = mock.Mock(return_value=processes)

            with self.assertRaisesRegex(RuntimeError, "health failure"):
                runtime._start("production", 8799, None, assets_prepared=False)

        runtime._stop_run.assert_called_once_with("production")
        runtime.stop_run.assert_not_called()

    def test_started_process_identity_waits_for_child_exec(self):
        lifecycle = load_lifecycle()
        runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
        child = mock.Mock()
        child.poll.return_value = None
        expected = {
            "pid": 123,
            "argv": ["node", "server.js"],
            "cwd": "/tmp/engine",
        }
        processes = types.SimpleNamespace(
            process_record=mock.Mock(side_effect=[None, None, expected]),
        )

        with mock.patch.object(time, "sleep", return_value=None):
            actual = runtime.wait_for_process_identity(
                processes,
                123,
                Path("/tmp/engine/server.js"),
                child=child,
                timeout=1,
            )

        self.assertEqual(actual, expected)
        self.assertEqual(processes.process_record.call_count, 3)

    def test_started_process_identity_reports_a_real_early_exit(self):
        lifecycle = load_lifecycle()
        runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
        child = mock.Mock()
        child.poll.return_value = 7
        processes = types.SimpleNamespace(process_record=mock.Mock(return_value=None))

        with self.assertRaisesRegex(
            lifecycle.NativeLifecycleError,
            "exited with status 7 before identity verification",
        ):
            runtime.wait_for_process_identity(
                processes,
                123,
                Path("/tmp/engine/server.js"),
                child=child,
                timeout=1,
            )

    def test_unverified_spawn_is_terminated_before_start_failure_escapes(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = lifecycle.NativeRuntime.__new__(lifecycle.NativeRuntime)
            runtime.data_root = root
            runtime.state_root = root / "state"
            runtime.native_data_root = runtime.state_root / "native"
            runtime.runtime_state = runtime.state_root / "native-runtime"
            runtime.engine_root = root / "engine"
            runtime.engine_root.mkdir()
            runtime.contract = types.SimpleNamespace(commit="test")
            runtime.config_path = runtime.runtime_state / "config.yaml"
            runtime._children = {}
            runtime.verify_install = mock.Mock()
            runtime.sync_assets = mock.Mock()
            runtime.managed_service = mock.Mock(return_value=None)
            runtime._read_pid = mock.Mock(return_value=None)
            runtime.node_command = mock.Mock(return_value=["node", "server.js"])
            child = mock.Mock(pid=123)
            child.poll.side_effect = [None, None]
            runtime.spawn = mock.Mock(return_value=child)
            runtime.wait_for_process_identity = mock.Mock(
                side_effect=lifecycle.NativeLifecycleError("identity timeout")
            )
            processes = types.SimpleNamespace(port_open=lambda _port: False)
            runtime.process_module = mock.Mock(return_value=processes)

            with self.assertRaisesRegex(lifecycle.NativeLifecycleError, "identity timeout"):
                runtime._start("production", 8799, None, assets_prepared=False)

        child.terminate.assert_called_once_with()
        child.wait.assert_called_once_with(timeout=3)
        self.assertNotIn(123, runtime._children)

    def test_real_start_cli_fails_fast_instead_of_waiting_on_its_own_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            environment = {
                **os.environ,
                "HERMES_HOME": str(root),
                "TAVERN_DATA_ROOT": str(root),
                "TAVERN_APP_DIR": str(ROOT / "app"),
                "TAVERN_STATE_DIR": str(root / "state"),
            }

            result = subprocess.run(
                [sys.executable, "-B", str(LIFECYCLE), "start"],
                env=environment,
                text=True,
                capture_output=True,
                timeout=2,
                check=False,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("dependencies", result.stderr.lower())


if __name__ == "__main__":
    unittest.main()
