from __future__ import annotations

from contextlib import contextmanager, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

if __package__:
    from .launcher_test_environment import resolve_node
    from .test_launcher_update_recovery import owned_fixture_directory, require_fixture_closure
else:
    from launcher_test_environment import resolve_node
    from test_launcher_update_recovery import owned_fixture_directory, require_fixture_closure


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
        # This seam admits only the unit transaction; the real CLI case below
        # obtains a real native lease instead of bypassing the capability gate.
        self.admission = mock.Mock(side_effect=self.admit_unit_cli)

    def admit_unit_cli(self, kind, *, nora_home):
        if kind != "native" or self.lock.active or self.calls:
            raise AssertionError("unit admission must precede the lifecycle transaction")

    def operations_module(self, name):
        if name == "operation_cli":
            return types.SimpleNamespace(ensure_operation=self.admission)
        if name != "runtime_lock":
            raise AssertionError(name)
        return types.SimpleNamespace(installation_lock=self.lock.installation_lock)

    @contextmanager
    def cli_operation(self, args):
        self.admission('native', nora_home=os.environ.get('NORA_TAVERN_HOME'))
        yield

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
        runtime.admission.assert_called_once_with("native", nora_home=os.environ.get("NORA_TAVERN_HOME"))
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
                ("sync", runtime.state_root / "native-canary"),
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
            (runtime.engine_root / 'server.js').write_text('// fixture')
            runtime.config_path.parent.mkdir(parents=True)
            runtime.config_path.write_text('fixture config')
            runtime._children = {}
            runtime.dependencies_ready = mock.Mock(return_value=True)
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
            (runtime.engine_root / 'server.js').write_text('// fixture')
            runtime.config_path.parent.mkdir(parents=True)
            runtime.config_path.write_text('fixture config')
            runtime._children = {}
            runtime.dependencies_ready = mock.Mock(return_value=True)
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

    def test_unqualified_start_cli_rejects_before_lock_or_modification(self):
        lifecycle = load_lifecycle()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            environment = {name: value for name, value in os.environ.items()
                           if not name.startswith("NORA_OPERATION_")}
            environment.update({"HERMES_HOME": str(root), "NORA_TAVERN_HOME": str(root),
                                "TAVERN_DATA_ROOT": str(root), "TAVERN_APP_DIR": str(ROOT / "app"),
                                "TAVERN_STATE_DIR": str(root / "state")})
            with mock.patch.dict(os.environ, environment, clear=True), \
                 mock.patch.object(sys, "_nora_operation_delegate", None, create=True), \
                 mock.patch.object(lifecycle.NativeRuntime, "_start") as start:
                runtime = lifecycle.NativeRuntime.from_environment()
                cli = runtime.operations_module("operation_cli")
                lock = runtime.operations_module("runtime_lock")
                with mock.patch.object(lock, "installation_lock") as acquire, \
                     self.assertRaises(cli.OperationCliError) as refused:
                    lifecycle.main(["start"])
                self.assertEqual(refused.exception.code, "OPERATION_ENTRY_UNSUPPORTED")
                acquire.assert_not_called()
                start.assert_not_called()
            self.assertEqual(list(root.iterdir()), [])

    @unittest.skipUnless(all(os.environ.get(name) for name in
                             ("NORA_TEST_PYTHON", "NORA_TEST_MANAGED_PYTHON_ROOT", "NORA_TEST_HERMES")),
                         "no actual managed runtime; qualified CLI requires the native transaction gate")
    def test_real_start_cli_fails_fast_instead_of_waiting_on_its_own_lock(self):
        self.assertTrue(Path(sys.executable).samefile(os.environ["NORA_TEST_PYTHON"]))
        self.assertTrue(Path(sys.base_prefix).samefile(os.environ["NORA_TEST_MANAGED_PYTHON_ROOT"]))
        self.assertTrue((Path(sys.prefix) / "pyvenv.cfg").is_file())
        self.assertTrue(Path(sys.prefix).parent.samefile(os.environ["NORA_TEST_HERMES"]))
        with owned_fixture_directory(prefix="nora-qualified-native-start-") as fixture:
            root = fixture.root
            (root / "installer").mkdir()
            environment = {
                **os.environ,
                "NORA_TAVERN_HOME": str(root),
                "HERMES_HOME": str(root),
                "TAVERN_DATA_ROOT": str(root),
                "TAVERN_APP_DIR": str(ROOT / "app"),
                "TAVERN_STATE_DIR": str(root / "state"),
                "NORA_TEST_MANAGED_PYTHON_ROOT": sys.base_prefix,
                "NORA_TEST_VENV_HOME": sys.prefix,
            }
            actor = Path(__file__).with_name("launcher_owned_test_actor.cjs")
            adapter = root / "qualified-start.cjs"
            adapter.write_text(
                "const {runOwnedActor,CLOSURE_PREFIX}=require(" + json.dumps(str(actor)) + ");\n"
                "const [entry,root,python,script]=process.argv.slice(2);\n"
                "const receipt=closed=>console.error(CLOSURE_PREFIX+JSON.stringify({schema:'nora-fixture-closure/1',root,closed}));\n"
                "runOwnedActor({entry,root,python,script,args:['start'],executionMs:2000,cleanupMs:4000})"
                ".then(()=>receipt(true)).catch(error=>{console.error(error);receipt(error.fixtureClosureConfirmed===true);"
                "if(error.fixtureClosureConfirmed===false)process.exit(1);else process.exitCode=1;});\n",
                encoding="utf-8")
            # Preserve the original 2 s execution requirement. The caller also
            # allows 4 s for owned close/release and 2 s for the Node adapter.
            fixture.closed = False
            result = subprocess.run(
                [resolve_node(required=True), str(adapter),
                 str(Path(__file__).resolve().parents[1] / "installer/desktop/operation-lock.js"),
                 str(root), sys.executable, str(LIFECYCLE)],
                env=environment,
                text=True,
                capture_output=True,
                timeout=8,
                check=False,
            )
            require_fixture_closure(fixture, result.stderr)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("configuration is missing", result.stderr.lower())
        self.assertNotIn("OPERATION_ENTRY_UNSUPPORTED", result.stderr)
        self.assertNotIn("FIXTURE_ACTOR_TIMEOUT", result.stderr)


if __name__ == "__main__":
    unittest.main()
