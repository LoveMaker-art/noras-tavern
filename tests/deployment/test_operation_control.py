import base64
import importlib.util
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'installer/operation_control.py'
spec = importlib.util.spec_from_file_location('operation_control', SOURCE)
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
diagnostic_spec = importlib.util.spec_from_file_location('reviewed_diagnostics', SOURCE.with_name('error_diagnostics.py'))
diagnostics = importlib.util.module_from_spec(diagnostic_spec)
diagnostic_spec.loader.exec_module(diagnostics)


class Server:
    def __init__(self, error=None, *, child_error=False):
        self.error = error
        self.child_error = child_error

    def __enter__(self):
        self.listener = socket.socket()
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen()
        self.messages = []
        self.closed = threading.Event()
        self.env = {'NORA_OPERATION_DELEGATE_ENDPOINT': '127.0.0.1:%s' % self.listener.getsockname()[1],
                    'NORA_OPERATION_DELEGATE_TOKEN': 'a' * 64,
                    'NORA_OPERATION_JOB_ID': '11111111-1111-4111-8111-111111111111',
                    'NORA_OPERATION_ID': '22222222-2222-4222-8222-222222222222',
                    'NORA_OPERATION_OWNER_EPOCH': '9'}
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()
        return self

    def send(self, value):
        self.connection.sendall((json.dumps(value) + '\n').encode())

    def serve(self):
        self.connection, _ = self.listener.accept()
        stream = self.connection.makefile('rb')
        identity = json.loads(stream.readline())
        self.messages.append(identity)
        self.send({'schema': 'nora-operation-delegation-ack/1', 'token': self.env['NORA_OPERATION_DELEGATE_TOKEN'],
                   'jobId': self.env['NORA_OPERATION_JOB_ID'], 'operationId': self.env['NORA_OPERATION_ID'], 'ownerEpoch': 9})
        for line in stream:
            message = json.loads(line)
            self.messages.append(message)
            if self.child_error and message['type'] == 'spawn':
                self.send({'type': 'child', 'jobId': 'child-1', 'event': 'error', 'error': self.error})
                self.send({'type': 'reply', 'requestId': message['requestId'], 'result': {'jobId': 'child-1'}})
                self.send({'type': 'child', 'jobId': 'child-1', 'event': 'close', 'code': -1, 'signal': None})
                continue
            if self.error is not None:
                self.send({'type': 'reply', 'requestId': message['requestId'], 'error': self.error})
                continue
            if message['type'] == 'spawn':
                # Events may arrive before the spawn RPC response.
                self.send({'type': 'child', 'jobId': 'child-1', 'event': 'spawn', 'pid': 123})
                self.send({'type': 'reply', 'requestId': message['requestId'], 'result': {'jobId': 'child-1'}})
                self.send({'type': 'child', 'jobId': 'child-1', 'event': 'stdout', 'data': base64.b64encode(b'hello\n').decode()})
                self.send({'type': 'child', 'jobId': 'child-1', 'event': 'exit', 'code': 0, 'signal': None})
                def close_child():
                    self.closed.wait(3)
                    try:
                        self.send({'type': 'child', 'jobId': 'child-1', 'event': 'close', 'code': 0, 'signal': None})
                    except OSError:
                        pass
                threading.Thread(target=close_child, daemon=True).start()
            else:
                self.send({'type': 'reply', 'requestId': message['requestId'], 'result': {'sent': True}})

    def __exit__(self, *unused):
        self.closed.set()
        if hasattr(self, 'connection'):
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
        self.listener.close()
        self.thread.join(1)


class OperationControlTests(unittest.TestCase):
    def test_async_missing_or_invalid_diagnostic_preserves_guidance_and_omission_reason(self):
        invalid = {'name': 'Error', 'message': 'private-secret', 'code': 'EACCES',
                   'stack': '', 'path': 'PRIVATE_UNREVIEWED_PATH'}
        for record, reason in ((None, 'guard_diagnostic_missing'), (invalid, 'guard_diagnostic_invalid')):
            with self.subTest(reason=reason), \
                    Server({'code': 'EACCES', 'message': 'unused private text', 'diagnostic': record},
                           child_error=True) as server, patch.dict(os.environ, server.env, clear=True):
                gate = control.OperationDelegate.connect(creation_time=lambda: 10.5)
                try:
                    with self.assertRaises(control.OperationControlError) as failed:
                        gate.run([sys.executable, '-B', '-c', 'pass'])
                    error = failed.exception
                    self.assertEqual(str(error), '维护任务无法启动，请检查运行环境。')
                    self.assertEqual(error.code, 'EACCES')
                    self.assertIsNone(error.__cause__)
                    projected = diagnostics.exception_diagnostic(error)
                    self.assertEqual(projected['missingReasons'], [reason])
                    self.assertNotIn('private', json.dumps(projected))
                    self.assertNotIn('PRIVATE_UNREVIEWED_PATH', json.dumps(projected))
                finally:
                    gate.close()

    def test_reviewed_guard_failure_is_the_cause_of_the_existing_user_error(self):
        diagnostic = {'name': 'Error', 'message': '维护程序失败（EISDIR）。', 'code': 'EISDIR',
                      'stack': 'File "managed-python.js", line 11, in resolveExecution\n'
                               'File "operation-lock-worker.js", line 212, in spawnJob',
                      'missingReasons': ['non_project_frames_omitted']}
        with Server({'code': 'EISDIR', 'message': 'unused transport summary', 'diagnostic': diagnostic}) as server, \
                patch.dict(os.environ, server.env, clear=True):
            gate = control.OperationDelegate.connect(creation_time=lambda: 10.5)
            try:
                with self.assertRaises(control.OperationControlError) as failed:
                    gate.rpc('snapshot', jobId='child-1')
                error = failed.exception
                self.assertEqual(str(error), '维护任务无法执行，请保留日志并检查状态。')
                self.assertEqual(error.code, 'EISDIR')
                projected = diagnostics.exception_diagnostic(error)
                self.assertEqual(projected['cause']['name'], 'Error')
                self.assertEqual(projected['cause']['code'], 'EISDIR')
                self.assertIn('managed-python.js', projected['cause']['stack'])
                self.assertIn('operation-lock-worker.js', projected['cause']['stack'])
                self.assertEqual(projected['cause']['missingReasons'], ['non_project_frames_omitted'])
            finally:
                gate.close()

    def test_invalid_guard_record_does_not_replace_or_expose_the_primary_error(self):
        diagnostic = {'name': 'Error', 'message': 'private-secret', 'code': 'EISDIR',
                      'stack': 'File "managed-python.js", line 11, in resolveExecution',
                      'path': 'PRIVATE_UNREVIEWED_PATH'}
        with Server({'code': 'EISDIR', 'message': 'private-message', 'diagnostic': diagnostic}) as server, \
                patch.dict(os.environ, server.env, clear=True):
            gate = control.OperationDelegate.connect(creation_time=lambda: 10.5)
            try:
                with self.assertRaises(control.OperationControlError) as failed:
                    gate.rpc('snapshot', jobId='child-1')
                projected = diagnostics.exception_diagnostic(failed.exception)
                self.assertEqual(projected['code'], 'EISDIR')
                self.assertIsNone(failed.exception.__cause__)
                self.assertEqual(projected['missingReasons'], ['guard_diagnostic_invalid'])
                self.assertNotIn('private', json.dumps(projected))
                self.assertNotIn('PRIVATE_UNREVIEWED_PATH', json.dumps(projected))
            finally:
                gate.close()

    def test_missing_or_partial_environment_cannot_authorize_mutation(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(control.OperationControlError) as failed:
                control.require_operation()
            self.assertEqual(failed.exception.code, 'OPERATION_CAPABILITY_REQUIRED')
        with patch.dict(os.environ, {'NORA_OPERATION_ID': '22222222-2222-4222-8222-222222222222'}, clear=True):
            with self.assertRaises(control.OperationControlError):
                control.require_operation()

    def test_managed_executor_waits_for_actual_close_and_handles_early_events(self):
        with Server() as server, patch.dict(os.environ, server.env, clear=True):
            gate = control.OperationDelegate.connect(creation_time=lambda: 10.5)
            process = gate.popen([sys.executable, '-B', '-c', 'print("hello")'], stdout=-1, stderr=-2, text=True)
            self.assertEqual(process.pid, 123)
            self.assertEqual(process.stdout.readline(), 'hello\n')
            with self.assertRaises(control.subprocess.TimeoutExpired):
                process.wait(0.03)
            self.assertIsNone(process.poll())
            server.closed.set()
            self.assertEqual(process.wait(1), 0)
            gate.close()

    def test_guard_loss_is_not_reported_as_child_close(self):
        with Server() as server, patch.dict(os.environ, server.env, clear=True):
            gate = control.OperationDelegate.connect(creation_time=lambda: 10.5)
            process = gate.popen([sys.executable, '-c', 'pass'], stdout=-1, text=True)
            server.connection.shutdown(socket.SHUT_RDWR)
            with self.assertRaises(control.OperationControlError) as failed:
                process.wait(1)
            self.assertEqual(failed.exception.code, 'OPERATION_GUARD_LOST')
            self.assertIsNone(process.returncode)
            with self.assertRaises(control.OperationControlError):
                gate.assert_active()
            gate.close()


class ReviewedDiagnosticRecordTests(unittest.TestCase):
    def record(self):
        return {'name': 'Error', 'message': '维护程序失败（EISDIR）。', 'code': 'EISDIR',
                'stack': 'File "managed-python.js", line 11, in resolveExecution'}

    def test_cause_and_secondary_locations_round_trip_through_the_public_projection(self):
        record = self.record()
        record['cause'] = {**self.record(), 'name': 'TypeError',
                           'stack': 'File "operation-lock-worker.js", line 212, in spawnJob'}
        record['secondaryErrors'] = [{'error': {**self.record(), 'code': 'ENOENT'}}]
        record['truncated'] = True
        record['missingReasons'] = ['non_project_frames_omitted']
        projected = diagnostics.exception_diagnostic(diagnostics.exception_from_diagnostic(record))
        self.assertEqual(projected, record)

    def test_unreviewed_fields_and_nonformal_locations_are_rejected(self):
        values = [
            {**self.record(), key: 'PRIVATE_DATA'} for key in ('path', 'env', 'args', 'context')
        ] + [
            {**self.record(), 'stack': 'File "/private/managed-python.js", line 11, in resolveExecution'},
            {**self.record(), 'stack': 'File "managed-python.js", line 0, in resolveExecution'},
            {**self.record(), 'code': True},
            {**self.record(), 'code': 7},
            {**self.record(), 'code': '0BAD'},
            {**self.record(), 'secondaryErrors': [{'error': self.record(), 'output': 'PRIVATE_DATA'}]},
            {**self.record(), 'missingReasons': ['unreviewed /path']},
            {**self.record(), 'missingReasons': ['a' * 97]},
            {**self.record(), 'missingReasons': ['unrecognized_private_reason']},
            {**self.record(), 'cause': {**self.record(), 'truncated': True}},
            {**self.record(), 'truncated': 'yes'},
        ]
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                diagnostics.exception_from_diagnostic(value)

    def test_private_group_node_frame_and_utf8_message_budgets_are_enforced(self):
        root = self.record()
        current = root
        for _ in range(4):
            current['cause'] = self.record()
            current = current['cause']
        frame_overflow = self.record()
        frame_overflow['stack'] = '\n'.join([frame_overflow['stack']] * 12)
        frame_overflow['cause'] = self.record()
        cycle = self.record(); cycle['cause'] = cycle
        for value in (root, frame_overflow, cycle, {**self.record(), 'message': '密' * 401},
                      {**self.record(), 'secondaryErrors': [{'error': self.record()}] * 3}):
            with self.subTest(value=type(value)), self.assertRaises(ValueError):
                diagnostics.exception_from_diagnostic(value)


class ActualNestedExecutorTests(unittest.TestCase):
    def run_seed_writer(self, *, extended=False, diagnostic_failure=False, asynchronous_failure=False):
        hermes = os.environ.get('NORA_TEST_HERMES')
        node = os.environ.get('NORA_TEST_NODE') or shutil.which('node')
        if not hermes or not node:
            self.skipTest('requires the read-only Hermes Python and real Node/native lease')
        hermes = Path(hermes)
        python = hermes / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        if not python.is_file():
            self.skipTest('requires the read-only Hermes virtual environment')
        root = Path(__file__).resolve().parents[2]
        identity = json.loads(subprocess.check_output([str(python), '-B', '-c',
            'import json,sys;print(json.dumps([sys.prefix,sys.base_prefix]))'], text=True))
        with tempfile.TemporaryDirectory(prefix='nora-nested-config-home-') as temporary:
            fixture = Path(temporary)
            script = fixture / 'actor.py'
            script.write_text('''import contextlib,importlib.util,io,json,os,subprocess,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('owned_control',sys.argv[1])
control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
gate=control.require_operation()
seed=Path(sys.argv[2]);seed.mkdir()
if sys.argv[3] in ('diagnostic','diagnostic-async'):
    diagnostic_spec=importlib.util.spec_from_file_location('guard_evidence',Path(sys.argv[1]).with_name('error_diagnostics.py'))
    diagnostic=importlib.util.module_from_spec(diagnostic_spec);diagnostic_spec.loader.exec_module(diagnostic)
    try:
        if sys.argv[3]=='diagnostic-async':
            gate.run([sys.executable,'-B','-c','pass'],cwd=str(seed/'missing-cwd'),capture_output=True,text=True,check=True,timeout=30)
        else:
            gate.rpc('spawn',command=str(seed/('python.exe' if os.name=='nt' else 'python')),args=['-B','-c','pass'],kind='python-maintenance',options={'managedPythonRoot':sys.base_prefix,'venvHome':sys.prefix,'env':dict(os.environ)})
    except RuntimeError as error:
        detail=diagnostic.exception_diagnostic(error)
        assert detail['code']=='ENOENT',detail
        assert detail['cause']['code']=='ENOENT',detail
        if sys.argv[3]=='diagnostic':
            assert 'managed-python.js' in detail['cause']['stack'],detail
            assert 'operation-lock-worker.js' in detail['cause']['stack'],detail
        else:
            assert detail['cause']['missingReasons']==['non_project_frames_omitted'],detail
            assert str(error)=='维护任务无法启动，请检查运行环境。'
        assert str(seed) not in json.dumps(detail),detail
        sys.path.insert(0,str(Path(sys.argv[1]).parent))
        import launcher_bridge as bridge
        output=io.StringIO()
        event={'event':'diagnostic','component':'native','error':detail}
        with contextlib.redirect_stdout(output):
            try:
                bridge.run_stream([sys.executable,'-B','-c','import sys;print(sys.argv[1]);sys.exit(1)',json.dumps(event)],native_cli=True)
            except SystemExit as stopped:
                assert stopped.code==1
            else:
                raise AssertionError('the diagnostic adapter child must fail')
        events=[json.loads(line) for line in output.getvalue().splitlines()]
        reviewed=[event['error'] for event in events if event.get('event')=='diagnostic' and event.get('component')=='bridge']
        assert reviewed[0]['cause']['stack']==detail['cause']['stack'],reviewed
        print(json.dumps({'detail':detail,'events':events}),flush=True)
        sys.exit(0)
    raise AssertionError('the missing interpreter must not execute')
working=str(seed)
command=sys.executable
if sys.argv[3]=='extended':
    working='\\\\\\\\?\\\\'+working
    command='\\\\\\\\?\\\\'+command
    sys.prefix='\\\\\\\\?\\\\'+sys.prefix
    sys.base_prefix='\\\\\\\\?\\\\'+sys.base_prefix
environment={**os.environ,'HOME':working,'HERMES_HOME':working,'NORA_HERMES_HOME':working}
if os.name=='nt':
    try:
        gate.run([str(Path(sys.base_prefix)/'python.exe'),'-B','-c','raise AssertionError("unowned interpreter executed")'],env=environment,capture_output=True,text=True,timeout=30)
    except RuntimeError as error:
        assert getattr(error,'code',None)=='LOCK_CHILD_IDENTITY',repr(error)
    else:
        raise AssertionError('the base interpreter must not impersonate this venv')
probe="import json,os,sys;from pathlib import Path;Path('seeded.json').write_text(json.dumps({'home':os.environ['HERMES_HOME'],'cwd':os.getcwd(),'prefix':sys.prefix,'base':sys.base_prefix,'pid':os.getpid()}));print(os.getpid())"
try:
    result=gate.run([command,'-B','-c',probe],env=environment,cwd=working,capture_output=True,text=True,check=True,timeout=30)
except RuntimeError as error:
    print(json.dumps({'nestedError':getattr(error,'code',None)}),file=sys.stderr,flush=True)
    raise
facts=json.loads((seed/'seeded.json').read_text())
assert int(result.stdout)==facts['pid']
assert Path(facts['home']).samefile(seed) and Path(facts['cwd']).samefile(seed)
assert Path(facts['prefix']).samefile(sys.prefix) and Path(facts['base']).samefile(sys.base_prefix)
print(json.dumps(facts),flush=True)
''', encoding='utf-8')
            driver = '''const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');const {once}=require('node:events');
const [entry,directory,python,venv,base,control,script,seed,mode]=process.argv.slice(1);
(async()=>{const operationId=require('node:crypto').randomUUID();const lease=await require(entry).acquire({directory,operationId,ownerEpoch:1});
try{const child=lease.spawn(python,['-B',control,'--delegate-exec','-B',script,control,seed,mode],{kind:'python-maintenance',managedPythonRoot:base,venvHome:venv,env:process.env});
let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
const [code]=await once(child,'close');const jobs=(await lease.snapshot()).jobs;
let frozen,packet;
if(mode.startsWith('diagnostic')&&code===0){
const desktop=path.dirname(entry),{createFaultPackets,validFaultPacket}=require(path.join(desktop,'fault-packet.js'));
const packets=createFaultPackets(),collector=packets.collector(true,{output:false});
for(const event of JSON.parse(output).events)collector.observe(event);
const failure=collector.attach(new Error('Maintenance operation failed'));
const {createEvidenceStore}=require(path.join(desktop,'evidence-store.js')),store=createEvidenceStore({directory});
store.begin({operationId,action:'install'}).freeze({error:failure,outcome:'failed'});
frozen=createEvidenceStore({directory}).read(operationId);
packet=packets.packet(failure,{id:operationId,action:'install',history:[]},{evidence:frozen});
assert.equal(packet.schema,2);assert.equal(validFaultPacket(packet),true);
for(const filename of mode==='diagnostic'?['managed-python.js','operation-lock-worker.js']:[]){
assert.ok(frozen.primary.cause.frames.some(line=>line.includes(filename)),JSON.stringify(frozen));
assert.ok(packet.errors.some(error=>error.frames.some(line=>line.includes(filename))),JSON.stringify(packet));}
if(mode==='diagnostic-async'){
assert.ok(frozen.missingReasons.includes('non_project_frames_omitted'),JSON.stringify(frozen));
assert.ok(packet.errors.some(error=>error.code==='ENOENT'&&error.kind==='Error'),JSON.stringify(packet));}
// Raw child output stays disabled; reviewed omission markers remain visible.
assert.ok(packet.output.every(line=>/^\[WARNING\] evidence omitted: [a-z_]+$/.test(line)),JSON.stringify(packet));
assert.ok(packet.output.includes('[WARNING] evidence omitted: non_project_frames_omitted'));
assert.ok(!JSON.stringify(packet).includes(seed));}
console.log(JSON.stringify({code,output,errors,jobs,frozen,packet}));process.exitCode=code===0?0:1;
}finally{await lease.release();}})().catch(error=>{console.error(error);process.exitCode=1;});'''
            result = subprocess.run([str(node), '-e', driver,
                str(root / 'ops/installer/desktop/operation-lock.js'), str(fixture / 'installer'),
                str(python), *identity, str(SOURCE), str(script), str(fixture / 'seed-home'),
                'diagnostic-async' if asynchronous_failure else 'diagnostic' if diagnostic_failure else 'extended' if extended else 'normal'],
                capture_output=True, text=True, timeout=90)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            facts = json.loads(result.stdout)
            self.assertEqual(facts['code'], 0, facts)
            self.assertEqual(len(facts['jobs']), 3 if asynchronous_failure else 2, facts)
            for job in facts['jobs']:
                self.assertTrue(job['closedAt'])
                if asynchronous_failure and job.get('spawnFailedAt'):
                    self.assertIsNone(job['pid'])
                    self.assertEqual(job['spawnErrorCode'], 'ENOENT')
                else:
                    self.assertEqual(job['delegation']['identityStatus'], 'reported')
            if diagnostic_failure or asynchronous_failure:
                reviewed = json.loads(facts['output'])
                self.assertEqual(reviewed['detail']['code'], 'ENOENT')
                self.assertEqual(facts['packet']['schema'], 2)
                self.assertEqual(facts['frozen']['primary']['cause']['code'], 'ENOENT')
                return
            parent, child = facts['jobs']
            self.assertEqual(child['parentJobId'], parent['jobId'])
            seeded = json.loads(facts['output'])
            self.assertEqual(child['pid'], seeded['pid'])
            if os.name == 'nt':
                self.assertTrue(Path(child['executionIdentity']['managedPythonRoot']).samefile(identity[1]))
                self.assertFalse(child['executionIdentity']['managedPythonRoot'].startswith('\\\\?\\'))

    def test_config_home_does_not_choose_the_actual_nested_python_executor(self):
        self.run_seed_writer()

    def test_actual_guard_spawn_failure_preserves_project_js_cause_locations(self):
        self.run_seed_writer(diagnostic_failure=True)

    def test_actual_async_child_failure_preserves_reviewed_cause_through_bridge_and_packet(self):
        self.run_seed_writer(asynchronous_failure=True)

    @unittest.skipUnless(os.name == 'nt', 'Windows extended execution path regression')
    def test_extended_python_command_and_config_home_keep_real_executor_identity(self):
        self.run_seed_writer(extended=True)


if __name__ == '__main__':
    unittest.main()
