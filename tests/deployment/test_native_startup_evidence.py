from __future__ import annotations

import builtins
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get('NORA_TEST_NODE') or os.environ.get('TAVERN_NODE_EXECUTABLE') or shutil.which('node')


def lifecycle_module():
    spec = importlib.util.spec_from_file_location('native_startup_evidence_test', ROOT / 'app/native_lifecycle.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(NODE, 'requires a local Node executable')
class NativeStartupEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nora-startup-evidence-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.lifecycle = lifecycle_module()
        pinned = mock.patch.dict(os.environ, {'TAVERN_NODE_EXECUTABLE': NODE})
        pinned.start(); self.addCleanup(pinned.stop)
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

    def test_local_health_is_direct_even_when_system_proxy_does_not_bypass_loopback(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers()
                self.wfile.write(b'{"token":"fixture-health-token"}')
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with mock.patch.object(self.lifecycle.urllib.request, '_opener', None), \
                    mock.patch.object(self.lifecycle.urllib.request, 'getproxies', return_value={'http': 'http://127.0.0.1:1'}), \
                    mock.patch.object(self.lifecycle.urllib.request, 'proxy_bypass', return_value=False):
                result = self.runtime.health(server.server_port)
            self.assertTrue(result['ok'], result)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def readiness_window(self, ready_at, *, exit_code=None):
        elapsed = 0
        def sleep(seconds):
            nonlocal elapsed
            elapsed += seconds
        child = mock.Mock()
        child.poll.return_value = exit_code
        with mock.patch.object(self.lifecycle.time, 'monotonic', side_effect=lambda: elapsed), \
                mock.patch.object(self.lifecycle.time, 'sleep', side_effect=sleep), \
                mock.patch.object(self.runtime, 'health', side_effect=lambda _port: {
                    'ok': elapsed >= ready_at,
                    'details': {'native': {'error': 'connection refused'}}}):
            try:
                return self.original_wait(self.port, child=child), elapsed
            except self.lifecycle.NativeLifecycleError as error:
                return error, elapsed

    def test_default_readiness_window_accepts_a_live_child_ready_after_60_seconds(self):
        result, elapsed = self.readiness_window(60)
        self.assertIsInstance(result, dict, str(result))
        self.assertTrue(result['ok'])
        self.assertEqual(elapsed, 60)

    def test_default_readiness_window_stops_at_120_seconds_and_preserves_timeout_facts(self):
        error, elapsed = self.readiness_window(float('inf'))
        self.assertIsInstance(error, self.lifecycle.NativeLifecycleError)
        self.assertEqual(elapsed, 120)
        self.assertEqual(error.code, 'TAVERN_START_TIMEOUT')
        self.assertIn('after 120.0s', str(error))
        self.assertIn('limit=120s', str(error))
        self.assertIn('child=running', str(error))
        self.assertIn('connection refused', str(error))
        child = mock.Mock(spec=['poll'])
        child.poll.return_value = None
        failure = self.runtime.startup_failure(error, child)
        self.assertEqual(failure.code, 'TAVERN_START_TIMEOUT')

    def test_default_readiness_window_still_fails_immediately_when_child_exits(self):
        error, elapsed = self.readiness_window(60, exit_code=7)
        self.assertIsInstance(error, self.lifecycle.NativeLifecycleError)
        self.assertEqual(elapsed, 0)
        self.assertEqual(error.code, 'TAVERN_PROCESS_EXITED')
        self.assertIn('exited with status 7', str(error))

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

    def test_wrapped_os_denial_on_an_unrelated_pid_does_not_block_runtime_discovery(self):
        processes = self.runtime.process_module()
        if processes.psutil is None:
            self.skipTest('requires the packaged process library')
        script = self.runtime.engine_root / 'server.js'
        for field in ('cmdline', 'cwd'):
            with self.subTest(field=field):
                denied = mock.Mock()
                denied.cmdline.return_value = [NODE, str(script)]
                denied.cwd.return_value = str(self.runtime.engine_root)
                error = SystemError('proc inspection returned a result with an exception set')
                error.__cause__ = PermissionError('sysctl denied process inspection')
                getattr(denied, field).side_effect = error
                owned = mock.Mock()
                owned.cmdline.return_value = [NODE, str(script)]
                owned.cwd.return_value = str(self.runtime.engine_root)
                with mock.patch.object(processes.psutil, 'pids', return_value=[1001, 1002]), \
                        mock.patch.object(processes.psutil, 'Process', side_effect=lambda pid: denied if pid == 1001 else owned):
                    records = processes.find_processes(script)
                    self.assertEqual([item['pid'] for item in records], [1002])
                    with self.assertRaisesRegex(self.lifecycle.NativeLifecycleError, 'expected identity'):
                        self.runtime.wait_for_process_identity(processes, 1001, script, timeout=0)

    def test_unclassified_process_library_failure_remains_visible(self):
        processes = self.runtime.process_module()
        if processes.psutil is None:
            self.skipTest('requires the packaged process library')
        candidate = mock.Mock()
        candidate.cmdline.side_effect = SystemError('unexpected library fault')
        with mock.patch.object(processes.psutil, 'Process', return_value=candidate):
            with self.assertRaisesRegex(SystemError, 'unexpected library fault'):
                processes.process_record(1001, self.runtime.engine_root / 'server.js')

    def guarded_failure_events(self):
        """Run the real Node owner inside an ACKed maintenance Python handle."""
        profile = self.base / 'guard-profile'; profile.mkdir()
        runner = self.base / 'guarded-failure.py'
        runner.write_text('''
import json
from ops.installer import first_install
from ops.tests.test_native_startup_evidence import NativeStartupEvidenceTests
from ops.tests.test_update_error_diagnostics import UpdateErrorDiagnosticTests
case = NativeStartupEvidenceTests('test_real_node_exit_preserves_exit_code_and_program_locations')
case.setUp()
try:
    case.script("setTimeout(() => { require('nora-intentionally-missing-test-module'); }, 150);\\n")
    case.runtime.wait_for_health = lambda port, **kwargs: case.original_wait(port, timeout=2, **kwargs)
    events, local = UpdateErrorDiagnosticTests().entrypoint(first_install, lambda: case.runtime.start(port=case.port))
    assert not case.runtime._children or all(child.poll() is not None for child in case.runtime._children.values())
    print(json.dumps({'events': events, 'nativeClosed': True, 'localStderr': local}))
finally:
    case.doCleanups()
''', encoding='utf-8')
        driver = self.base / 'guarded-failure.cjs'
        driver.write_text('''
const path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const [root,directory,python,basePython,venv,runner]=process.argv.slice(2);
const lock=require(path.join(root,'ops/installer/desktop/operation-lock.js'));
(async()=>{
 const lease=await lock.acquire({directory,operationId:crypto.randomUUID(),ownerEpoch:1});
 let output,proof;
 try {
  const child=lease.spawn(python,['-B','-u',path.join(root,'ops/installer/operation_control.py'),'--delegate-exec',runner],
   {kind:'python-maintenance',managedPythonRoot:basePython,venvHome:venv,cwd:root,env:process.env});
  output=await new Promise((resolve,reject)=>{
   let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
   child.once('error',reject);child.once('close',code=>code===0?resolve(JSON.parse(stdout)):
    reject(new Error(`Guarded fixture exited ${code}: ${stderr}`)));
  });
  const facts=await lease.snapshot(),job=facts.jobs.find(value=>value.jobId===child.jobId);
  assert.equal(job.delegation.identityStatus,'reported');assert.ok(job.closedAt);
  assert.equal(job.creationIdentity.pid,child.pid);assert.ok(job.creationIdentity.creationTime>0);
  proof={actualPid:child.pid,identityStatus:job.delegation.identityStatus,closed:true};
 } finally {await lease.release();}
 assert.equal((await lock.probe({directory})).busy,false);
 process.stdout.write(JSON.stringify({output,executor:proof,released:true}));
})().catch(error=>{process.stderr.write(error.stack);process.exitCode=1;});
''', encoding='utf-8')
        env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(ROOT), os.environ.get('PYTHONPATH', '')]),
            **{key: str(profile) for key in ('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR')},
            'PYTHONDONTWRITEBYTECODE': '1'}
        result = json.loads(subprocess.run([NODE, str(driver), str(ROOT), str(self.base / 'installer'), sys.executable,
            sys.base_prefix, sys.prefix, str(runner)], env=env, capture_output=True, text=True, check=True, timeout=30).stdout)
        self.assertEqual(result['executor']['identityStatus'], 'reported')
        self.assertTrue(result['executor']['closed']); self.assertTrue(result['released'])
        self.assertTrue(result['output']['nativeClosed'])
        self.assertNotIn('nora-intentionally-missing-test-module', result['output']['localStderr'])
        return result['output']['events']

    def test_guarded_node_failure_preserves_program_diagnostic_after_actual_executor_close(self):
        events = self.guarded_failure_events()
        self.assertEqual(events[1]['code'], 'TAVERN_PROCESS_EXITED')
        detail = events[0]['error']
        self.assertTrue(any('MODULE_NOT_FOUND' in item['error']['message'] for item in detail['secondaryErrors']))
        self.assertNotIn('nora-intentionally-missing-test-module', json.dumps(events))

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
