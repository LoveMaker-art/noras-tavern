from __future__ import annotations

import builtins
import importlib.util
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]


def lifecycle_module():
    spec = importlib.util.spec_from_file_location('native_startup_evidence_test', ROOT / 'app/native_lifecycle.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(shutil.which('node'), 'requires a local Node executable')
class NativeStartupEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nora-startup-evidence-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.lifecycle = lifecycle_module()
        app = self.base / 'app'
        (app / 'engine').mkdir(parents=True)
        contract = self.lifecycle.RuntimeContract('https://github.com/SillyTavern/SillyTavern', 'test', 'a' * 40, 20, 'engine')
        self.runtime = self.lifecycle.NativeRuntime(self.base, app, self.base / 'state', contract)
        self.runtime.config_path.parent.mkdir(parents=True)
        self.runtime.config_path.write_text('fixture config', encoding='utf-8')
        self.runtime.managed_service = lambda: None
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            self.port = listener.getsockname()[1]
        self.original_wait = self.runtime.wait_for_health
        # Keep the red run short while exercising the real start/health path.
        self.runtime.wait_for_health = lambda port, **kwargs: self.original_wait(port, timeout=0.5, **kwargs)

    def script(self, source):
        (self.runtime.engine_root / 'server.js').write_text(source, encoding='utf-8')

    def failure(self):
        with self.assertRaises(self.lifecycle.NativeLifecycleError) as caught:
            self.runtime.start(port=self.port)
        return caught.exception

    def current_child_records(self, processes):
        original = processes.process_record
        def record(pid, script):
            actual = original(pid, script)
            if actual is not None:
                return actual
            # A platform without psutil may need a fixture-only OS seam. Never
            # turn another Node PID discovered on the host into this runtime.
            child = self.runtime._children.get(pid)
            if (child is None or child.poll() is not None
                    or Path(script).resolve() != (self.runtime.engine_root / 'server.js').resolve()):
                return None
            return {'pid': pid, 'argv': self.runtime.node_command(self.port, self.runtime.native_data_root),
                    'cwd': str(self.runtime.engine_root)}
        return record

    def test_real_node_exit_preserves_exit_code_and_program_locations(self):
        self.script("setTimeout(() => { require('nora-intentionally-missing-test-module'); }, 150);\n")
        error = self.failure()
        self.assertIn('exited with status 1', str(error))
        self.assertIsNotNone(error.__cause__)
        self.assertEqual(error.code, 'TAVERN_PROCESS_EXITED')
        evidence = error.secondary_errors[0]
        self.assertIn('MODULE_NOT_FOUND', str(evidence))
        self.assertTrue(any(frame.filename == 'server.js' for frame in evidence._bridge_diagnostic_stack))
        self.assertNotIn(str(self.base), str(evidence))
        self.assertNotIn('nora-intentionally-missing-test-module', str(evidence))

    def test_two_real_starts_exclude_old_output_and_unknown_configuration_text(self):
        self.script("setTimeout(() => { console.error(\"Error [ERR_MODULE_NOT_FOUND]: old secret\"); process.exit(7); }, 50);\n")
        first = self.failure()
        self.assertIn('exited with status 7', str(first))
        self.assertIn('ERR_MODULE_NOT_FOUND', str(first.secondary_errors[0]))
        self.script("setTimeout(() => { console.error(\"api_key: private-value\\nmodel answer private-text\\nuser chat private-chat\"); process.exit(8); }, 50);\n")
        second = self.failure()
        self.assertIn('exited with status 8', str(second))
        projected = str(second) + ' '.join(str(error) for error in second.secondary_errors)
        for private in ('ERR_MODULE_NOT_FOUND', 'old secret', 'private-value', 'private-text', 'private-chat'):
            self.assertNotIn(private, projected)
        self.assertIn('no recognized program error code', projected)

    def test_current_startup_evidence_is_bounded_to_the_last_16_kib(self):
        self.script("setTimeout(() => { console.error('Error [ERR_REQUIRE_ESM]: earlier output'); process.stderr.write('x'.repeat(17*1024)); console.error(\"\\nError [ERR_MODULE_NOT_FOUND]: current private text\"); process.exit(9); }, 50);\n")
        error = self.failure()
        evidence = str(error.secondary_errors[0])
        self.assertIn('ERR_MODULE_NOT_FOUND', evidence)
        self.assertNotIn('ERR_REQUIRE_ESM', evidence)
        self.assertNotIn('current private text', evidence)

    def test_live_child_without_listener_preserves_health_error_and_cleanup_error(self):
        self.script("setInterval(() => {}, 1000);\n")
        processes = self.runtime.process_module()
        record = self.current_child_records(processes)
        cleanup_error = RuntimeError('controlled cleanup failure')
        try:
            with mock.patch.object(processes, 'process_record', side_effect=record), \
                    mock.patch.object(self.runtime, '_stop_run', side_effect=cleanup_error):
                error = self.failure()
            self.assertIn('was still running', str(error))
            self.assertIn('health check timed out', str(error.__cause__))
            self.assertIn('controlled cleanup failure', str(error.secondary_errors[-1]))
            self.assertIs(error.secondary_errors[-1], cleanup_error)
            self.assertNotEqual(error.code, 'TAVERN_PROCESS_EXITED')
        finally:
            for child in self.runtime._children.values():
                if child.poll() is None: child.terminate()
                child.wait(timeout=5)

    def test_non_integer_poll_result_is_not_reported_as_process_exit(self):
        for result in (True, mock.Mock()):
            with self.subTest(result=type(result).__name__):
                child = mock.Mock()
                child.poll.return_value = result
                with mock.patch.object(self.lifecycle.time, 'sleep'), \
                        mock.patch.object(self.lifecycle.time, 'monotonic', side_effect=[0, 0, 1]):
                    with self.assertRaisesRegex(self.lifecycle.NativeLifecycleError, 'health check timed out') as caught:
                        self.original_wait(self.port, timeout=0.5, child=child)
                self.assertNotEqual(caught.exception.code, 'TAVERN_PROCESS_EXITED')

    def test_optional_evidence_reader_failure_does_not_block_real_spawn(self):
        self.script("setInterval(() => {}, 1000);\n")
        processes = self.runtime.process_module()
        record = self.current_child_records(processes)
        self.runtime.wait_for_health = lambda *_args, **_kwargs: {'ok': True}
        def evidence_open(path, mode, **kwargs):
            if mode == 'rb': raise PermissionError('optional reader denied')
            return builtins.open(path, mode, **kwargs)
        try:
            with mock.patch.object(self.lifecycle, 'open', side_effect=evidence_open, create=True), \
                    mock.patch.object(processes, 'process_record', side_effect=record), \
                    mock.patch.object(processes, 'require_listener'):
                result = self.runtime.start(port=self.port)
            self.assertTrue(result['health']['ok'])
        finally:
            for child in self.runtime._children.values():
                if child.poll() is None: child.terminate()
                child.wait(timeout=5)

    def test_success_closes_evidence_handle_while_child_keeps_running(self):
        self.script("setInterval(() => {}, 1000);\n")
        children = []
        original_spawn = self.runtime.spawn
        def capture(*args):
            child = original_spawn(*args)
            children.append((child, getattr(child, '_nora_startup_log', None)))
            return child
        processes = self.runtime.process_module()
        record = self.current_child_records(processes)
        self.runtime.spawn = capture
        self.runtime.wait_for_health = lambda *_args, **_kwargs: {'ok': True}
        try:
            with mock.patch.object(processes, 'process_record', side_effect=record), mock.patch.object(processes, 'require_listener'):
                result = self.runtime.start(port=self.port)
            self.assertTrue(result['health']['ok'])
            self.assertIsNone(children[0][0].poll())
            self.assertIsNotNone(children[0][1])
            self.assertTrue(children[0][1][0].closed)
        finally:
            for child, _cursor in children:
                if child.poll() is None: child.terminate()
                child.wait(timeout=5)

    def test_metadata_write_failure_closes_reader_without_changing_stop_semantics(self):
        self.script("setInterval(() => {}, 1000);\n")
        children = []
        original_spawn = self.runtime.spawn
        def capture(*args):
            child = original_spawn(*args)
            children.append((child, getattr(child, '_nora_startup_log', None)))
            return child
        processes = self.runtime.process_module()
        record = self.current_child_records(processes)
        self.runtime.spawn = capture
        try:
            with mock.patch.object(processes, 'process_record', side_effect=record), \
                    mock.patch.object(self.lifecycle, '_atomic_text', side_effect=OSError('metadata write failure')):
                with self.assertRaisesRegex(OSError, 'metadata write failure'):
                    self.runtime.start(port=self.port)
            self.assertIsNone(children[0][0].poll())
            self.assertTrue(children[0][1][0].closed)
        finally:
            for child, _cursor in children:
                if child.poll() is None: child.terminate()
                child.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
