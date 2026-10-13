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
from types import SimpleNamespace
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

if __package__:
    from .launcher_test_environment import resolve_node
    from .test_launcher_update_recovery import close_fixture_child, require_fixture_closure
else:
    from launcher_test_environment import resolve_node
    from test_launcher_update_recovery import close_fixture_child, require_fixture_closure

ROOT = Path(__file__).resolve().parents[2]
NODE = resolve_node()


def lifecycle_module():
    spec = importlib.util.spec_from_file_location('native_startup_evidence_test', ROOT / 'app/native_lifecycle.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(NODE, 'requires a local Node executable')
class NativeStartupEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix='nora-startup-evidence-')).resolve()
        self.fixture_children = []
        self.guard_closure_confirmed = True
        self.fixture_removed = False
        self.addCleanup(self.cleanup_fixture)
        self.lifecycle = lifecycle_module()
        pinned = mock.patch.dict(os.environ, {'TAVERN_NODE_EXECUTABLE': NODE})
        pinned.start(); self.addCleanup(pinned.stop)
        app = self.base / 'app'
        (app / 'engine').mkdir(parents=True)
        contract = self.lifecycle.RuntimeContract('https://github.com/SillyTavern/SillyTavern', 'test', 'a' * 40, 20, 'engine')
        self.runtime = self.lifecycle.NativeRuntime(self.base, app, self.base / 'state', contract)
        original_spawn = self.runtime.spawn
        def tracked_spawn(*args, **kwargs):
            child = original_spawn(*args, **kwargs)
            self.fixture_children.append(child)
            return child
        self.runtime.spawn = tracked_spawn
        self.runtime.config_path.parent.mkdir(parents=True)
        self.runtime.config_path.write_text('fixture config', encoding='utf-8')
        self.runtime.managed_service = lambda: None
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            self.port = listener.getsockname()[1]
        self.original_wait = self.runtime.wait_for_health
        # Keep the red run short while exercising the real start/health path.
        self.runtime.wait_for_health = lambda port, **kwargs: self.original_wait(port, timeout=0.5, **kwargs)

    def close_fixture_children(self):
        primary = sys.exc_info()[1]
        failures = []
        runtime = getattr(self, 'runtime', None)
        children = self.fixture_children + list(getattr(runtime, '_children', {}).values())
        seen = set()
        for child in children:
            if id(child) in seen:
                continue
            seen.add(id(child))
            try:
                close_fixture_child(child)
                self.runtime.close_startup_log(child)
            except BaseException as error:
                failures.append(error)
        if failures:
            message = f'Native startup fixture child closure unconfirmed; retained: {self.base}; cause: {failures[0]}'
            if primary is not None:
                primary.add_note(message)
            else:
                raise RuntimeError(message) from failures[0]
        return not failures

    def cleanup_fixture(self):
        if self.fixture_removed:
            return
        primary = sys.exc_info()[1]
        try:
            if not self.close_fixture_children():
                raise RuntimeError('Native startup held child is not closed')
            if not self.guard_closure_confirmed:
                raise RuntimeError('Native fixture delegate or guard closure remains unconfirmed')
            shutil.rmtree(self.base)
            self.fixture_removed = True
        except BaseException as error:
            message = f'Native startup fixture cleanup failed; retained: {self.base}; cause: {error}'
            if primary is not None:
                primary.add_note(message)
            else:
                raise RuntimeError(message) from error

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
primary = None
try:
    case.script("setTimeout(() => { require('nora-intentionally-missing-test-module'); }, 150);\\n")
    case.runtime.wait_for_health = lambda port, **kwargs: case.original_wait(port, timeout=2, **kwargs)
    events, local = UpdateErrorDiagnosticTests().entrypoint(first_install, lambda: case.runtime.start(port=case.port))
    assert not case.runtime._children or all(child.poll() is not None for child in case.runtime._children.values())
    print(json.dumps({'events': events, 'nativeClosed': True, 'localStderr': local}))
except BaseException as error:
    primary = error
    raise
finally:
    case.cleanup_fixture()
    if not case.doCleanups():
        if primary is not None: primary.add_note('native fixture cleanup failed; root retained')
        else: raise RuntimeError('native fixture cleanup failed; root retained')
''', encoding='utf-8')
        driver = self.base / 'guarded-failure.cjs'
        driver.write_text('''
const path=require('node:path'),assert=require('node:assert/strict'),{PassThrough}=require('node:stream');
const [root,directory,python,basePython,venv,runner]=process.argv.slice(2);
const lock=require(path.join(root,'ops/installer/desktop/operation-lock.js'));
const {runOwnedActor,CLOSURE_PREFIX}=require(path.join(root,'ops/tests/launcher_owned_test_actor.cjs'));
const fixtureRoot=path.dirname(directory);
const receipt=closed=>console.error(CLOSURE_PREFIX+JSON.stringify({schema:'nora-fixture-closure/1',root:fixtureRoot,closed}));
process.env.NORA_TEST_MANAGED_PYTHON_ROOT=basePython;process.env.NORA_TEST_VENV_HOME=venv;
let child,lastFacts;
const observedLock={...lock,acquire:async options=>{
 const lease=await lock.acquire(options),spawn=lease.spawn.bind(lease),snapshot=lease.snapshot.bind(lease);
 lease.spawn=(command,args,options)=>{child=spawn(command,args,{...options,cwd:root});return child;};
 lease.snapshot=async(...args)=>{const facts=await snapshot(...args);lastFacts=facts;return facts;};
 return lease;
}};
(async()=>{
 const stdin=new PassThrough(),stdout=new PassThrough(),stderr=new PassThrough();stdin.end();
 let text='',diagnostic='';stdout.on('data',value=>text+=value);stderr.on('data',value=>diagnostic+=value);
 let closed=false;
 try {
  await runOwnedActor({entry:path.join(root,'ops/installer/desktop/operation-lock.js'),root:fixtureRoot,
   python,script:path.join(root,'ops/installer/operation_control.py'),args:['--delegate-exec',runner],
   lock:observedLock,streams:{stdin,stdout,stderr},executionMs:14000,cleanupMs:4000});
  closed=true;
  const job=lastFacts.jobs.find(value=>value.jobId===child.jobId);
  assert.equal(job.delegation.identityStatus,'reported');assert.ok(job.closedAt);
  assert.equal(job.creationIdentity.pid,child.pid);assert.ok(job.creationIdentity.creationTime>0);
  const output=JSON.parse(text),proof={actualPid:child.pid,identityStatus:job.delegation.identityStatus,closed:true};
  process.stdout.write(JSON.stringify({output,executor:proof,released:true}));
 }catch(error){
  if(diagnostic)console.error(diagnostic);
  closed=closed||error.fixtureClosureConfirmed===true;
  error.fixtureClosureConfirmed=closed;throw error;
 }finally{receipt(closed);}
})().catch(error=>{process.stderr.write(error.stack);if(error.fixtureClosureConfirmed!==true)process.exit(1);else process.exitCode=1;});
''', encoding='utf-8')
        env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(ROOT), os.environ.get('PYTHONPATH', '')]),
            **{key: str(profile) for key in ('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR')},
            'PYTHONDONTWRITEBYTECODE': '1'}
        self.guard_closure_confirmed = False
        completed = subprocess.run([NODE, str(driver), str(ROOT), str(self.base / 'installer'), sys.executable,
            sys.base_prefix, sys.prefix, str(runner)], env=env, capture_output=True, text=True, check=False, timeout=30)
        closure = SimpleNamespace(root=self.base, closed=False)
        require_fixture_closure(closure, completed.stderr)
        self.guard_closure_confirmed = closure.closed
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        result = json.loads(completed.stdout)
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
            self.close_fixture_children()

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
            self.close_fixture_children()

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
            self.close_fixture_children()

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
            self.close_fixture_children()


class NativeFixtureCleanupTests(unittest.TestCase):
    def fixture(self, child=None, *, guard_closed=True):
        # These handles are pure fakes; no PID or actor exists to remove later.
        case = NativeStartupEvidenceTests('test_real_node_exit_preserves_exit_code_and_program_locations')
        case.base = Path(tempfile.mkdtemp(prefix='nora-startup-cleanup-seam-')).resolve()
        self.addCleanup(shutil.rmtree, case.base, ignore_errors=True)
        case.fixture_children = [child] if child is not None else []
        case.guard_closure_confirmed = guard_closed
        case.fixture_removed = False
        case.runtime = SimpleNamespace(_children={}, close_startup_log=lambda _child: None)
        return case

    def test_unconfirmed_raw_child_retains_root_and_original_error(self):
        calls = []
        def waiting(timeout):
            calls.append(('wait', timeout))
            raise subprocess.TimeoutExpired('pure fixture handle', timeout)
        child = SimpleNamespace(stdin=None, stdout=None, stderr=None, poll=lambda: None,
            terminate=lambda: calls.append('term'), kill=lambda: calls.append('kill'), wait=waiting)
        case = self.fixture(child)
        primary = ValueError('original body error')
        with self.assertRaises(ValueError) as failure:
            try:
                raise primary
            finally:
                case.cleanup_fixture()
        self.assertIs(failure.exception, primary)
        self.assertEqual(calls, ['term', ('wait', 2), 'kill', ('wait', 2)])
        self.assertTrue(case.base.is_dir())
        self.assertIn(str(case.base), '\n'.join(primary.__notes__))

    def test_unconfirmed_guard_retains_root_even_without_raw_children(self):
        case = self.fixture(guard_closed=False)
        with self.assertRaisesRegex(RuntimeError, 'guard closure remains unconfirmed'):
            case.cleanup_fixture()
        self.assertTrue(case.base.is_dir())

    def test_known_child_close_allows_cleanup_without_replacing_body_failure(self):
        calls = []
        child = SimpleNamespace(stdin=None, stdout=None, stderr=None, poll=lambda: 9,
            wait=lambda timeout: calls.append(('actual-wait', timeout)) or 9)
        case = self.fixture(child)
        primary = ValueError('expected body failure')
        with self.assertRaises(ValueError) as failure:
            try:
                raise primary
            finally:
                case.cleanup_fixture()
        self.assertIs(failure.exception, primary)
        self.assertEqual(calls, [('actual-wait', 2)])
        self.assertFalse(case.base.exists())


if __name__ == '__main__':
    unittest.main()
