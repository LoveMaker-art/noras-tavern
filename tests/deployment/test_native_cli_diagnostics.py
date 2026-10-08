"""Native startup evidence survives the real CLI/bridge/fault boundary."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

from ops.installer import launcher_bridge as bridge


ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get('NORA_TEST_NODE') or shutil.which('node')


class NativeCliDiagnosticTests(unittest.TestCase):
    def collect(self, command, *, env=None, native_cli=False):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
            bridge.run_stream(command, env=env, native_cli=native_cli)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def faults(self, events, directory):
        script = '''
const fs = require('node:fs');
const {createFaultPackets} = require(process.argv[1]);
const {createTelemetry} = require(process.argv[2]);
const events = JSON.parse(fs.readFileSync(0, 'utf8'));
const packets = createFaultPackets();
const collector = packets.collector(true, {output:false});
for (const event of events) collector.observe(event);
const error = collector.attach(new Error('Native startup failed.'));
const fault = packets.packet(error,{action:'start',history:[]});
const disabledCollector = packets.collector(false,{output:false});
for (const event of events) disabledCollector.observe(event);
const disabled = disabledCollector.attach(new Error('Native startup failed.'));
const telemetry = createTelemetry({file:process.argv[3],launcherVersion:'1.1.2',automatic:false});
telemetry.begin('start'); telemetry.report(disabled); telemetry.finish('failed',disabled);
console.log(JSON.stringify({fault,queue:JSON.parse(fs.readFileSync(process.argv[3],'utf8')).queue}));
telemetry.close();
'''
        desktop = Path(bridge.__file__).parent / 'desktop'
        result = subprocess.run([NODE, '-e', script,
                                 str(desktop / 'fault-packet.js'), str(desktop / 'telemetry.js'),
                                 str(directory / 'telemetry.json')], input=json.dumps(events),
                                text=True, capture_output=True, check=True)
        return json.loads(result.stdout)

    @unittest.skipUnless(NODE, 'requires a local Node executable')
    def test_real_native_cli_node_failure_reaches_fault_without_service_output(self):
        with tempfile.TemporaryDirectory(prefix='nora-native-cli-') as temporary:
            root = Path(temporary)
            app = root / 'apps/tavern-runtime'
            app.mkdir(parents=True)
            shutil.copy2(ROOT / 'app/native_lifecycle.py', app / 'native_lifecycle.py')
            operations = root / 'apps/tavern-ops'
            for name in ('runtime_lock', 'runtime_process'):
                target = operations / 'updater' / (name + '.py')
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / 'ops/updater' / (name + '.py'), target)
            helper = operations / 'installer'; helper.mkdir(parents=True)
            for name in ('error_diagnostics.py', 'operation_cli.py', 'operation_control.py'):
                shutil.copy2(ROOT / 'ops/installer' / name, helper / name)
            (app / 'native-runtime.json').write_text(json.dumps({
                'schema': 2, 'engine': 'SillyTavern',
                'upstream_repository': 'https://github.com/SillyTavern/SillyTavern',
                'upstream_tag': 'fixture', 'upstream_commit': 'a' * 40,
                'node_min_major': 20, 'source_dir': 'engine',
            }), encoding='utf-8')
            engine = app / 'engine'
            engine.mkdir()
            private = 'PRIVATE_NATIVE_STARTUP_MESSAGE_6942'
            (engine / 'server.js').write_text(
                f"setTimeout(() => {{ console.error('{private}'); require('nora-intentionally-missing-fixture'); }}, 150);\n",
                encoding='utf-8')
            config = root / 'tavern-state/native-runtime/config.yaml'
            config.parent.mkdir(parents=True)
            config.write_text('fixture config', encoding='utf-8')
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            env = {**os.environ, 'TAVERN_DATA_ROOT': str(root), 'TAVERN_APP_DIR': str(app),
                   'TAVERN_STATE_DIR': str(root / 'tavern-state'),
                   'HERMES_HOME': str(root / 'hermes'), 'NORA_TAVERN_HOME': str(root),
                   'NORA_TEST_VENV_HOME': sys.prefix, 'TAVERN_NODE_EXECUTABLE': NODE}
            events = self.collect([NODE, str(Path(__file__).with_name('launcher_owned_test_actor.cjs')),
                                   str(ROOT / 'ops/installer/desktop/operation-lock.js'), str(root.resolve()),
                                   sys.executable, str(app / 'native_lifecycle.py'),
                                   'start', '--run-id', 'fixture', '--port', str(port)],
                                  env=env, native_cli=True)
            diagnostics = [event['error'] for event in events
                           if event.get('event') == 'diagnostic' and event.get('component') == 'bridge']
            native = diagnostics[0]
            self.assertEqual(native['name'], 'NativeLifecycleError')
            self.assertEqual(native['code'], 'TAVERN_PROCESS_EXITED')
            self.assertEqual(native['context']['stage'], 'native_start')
            self.assertEqual(native['context']['port'], port)
            self.assertEqual(native['context']['exitCode'], 1)
            self.assertTrue(native['context']['loopback'])
            self.assertGreater(native['context']['pid'], 0)
            self.assertIn('cause', native)
            self.assertIn('MODULE_NOT_FOUND', json.dumps(native['secondaryErrors']))
            self.assertIn('server.js', json.dumps(native['secondaryErrors']))
            self.assertNotIn(private, json.dumps(diagnostics))
            self.assertNotIn('nora-intentionally-missing-fixture', json.dumps(diagnostics))
            result = self.faults(events, root)
            fault = result['fault']
            self.assertTrue(any('MODULE_NOT_FOUND' in error['message'] for error in fault['errors']))
            self.assertTrue(any('server.js' in frame for error in fault['errors'] for frame in error['frames']))
            self.assertEqual(fault['output'], [])
            self.assertNotIn(private, json.dumps(fault))
            self.assertTrue(all(event['fault'] is None for event in result['queue']))

    def test_untrusted_native_event_is_not_promoted_to_bridge(self):
        detail = {'name': 'RuntimeError', 'message': 'UNTRUSTED_NATIVE_CONTENT',
                  'code': None, 'stack': 'File "plugin.py", line 1, in run'}
        command = [sys.executable, '-c', 'import json,sys; '
                   f'print(json.dumps({{"event":"diagnostic","component":"native","error":{detail!r}}})); sys.exit(1)']
        events = self.collect(command)
        trusted = [event['error'] for event in events
                   if event.get('event') == 'diagnostic' and event.get('component') == 'bridge']
        self.assertEqual(len(trusted), 1)
        self.assertNotIn('UNTRUSTED_NATIVE_CONTENT', json.dumps(trusted))

    def test_invalid_native_event_retains_only_legacy_scalar_diagnostic(self):
        original = {'name': 'NativeLifecycleError', 'message': 'UNTRUSTED_INVALID_NATIVE',
                    'code': 'TAVERN_PROCESS_EXITED', 'stack': 'File "native_lifecycle.py", line 3, in run'}
        malformed = [{**original, 'locals': {'secret': 'private'}},
                     {**original, 'stack': 'File "/private/chat.json", line 1, in run'},
                     {**original, 'truncated': 'yes'},
                     {**original, 'context': {'pid': True}},
                     {**original, 'context': {'pid': -1}},
                     {**original, 'context': {'port': 65536}},
                     {**original, 'context': {'exitCode': 2 ** 40}},
                     {**original, 'context': {'loopback': 'yes'}},
                     {**original, 'context': {'stage': 'PRIVATE_STAGE'}},
                     {**original, 'context': {'path': '/private/chat.json'}},
                     {**original, 'missingReasons': ['private content']},
                     {**original, 'missingReasons': ['a' * 97]},
                     {**original, 'missingReasons': ['launch_log_unavailable'] * 17},
                     {**original, 'secondaryErrors': [{'error': original}] * 3}]
        chain = original
        for _ in range(4):
            chain = {**original, 'cause': chain}
        malformed.append(chain)
        for detail in malformed:
            with self.subTest(detail=detail):
                command = [sys.executable, '-c', 'import json,sys; '
                           f'print(json.dumps({{"event":"diagnostic","component":"native","error":{detail!r}}})); '
                           'print(json.dumps({"ok":False,"error":"legacy native error","code":"TAVERN_OWNERSHIP"})); sys.exit(1)']
                events = self.collect(command, native_cli=True)
                trusted = [event['error'] for event in events
                           if event.get('event') == 'diagnostic' and event.get('component') == 'bridge']
                self.assertEqual(len(trusted), 1)
                self.assertIn('legacy native error', trusted[0]['message'])
                self.assertNotIn('UNTRUSTED_INVALID_NATIVE', json.dumps(trusted))

    def test_reviewed_native_missing_reasons_and_secondary_context_are_accepted(self):
        detail = {'name': 'NativeLifecycleError', 'message': 'Native startup failed.',
                  'code': 'TAVERN_PROCESS_EXITED', 'stack': 'File "native_lifecycle.py", line 3, in run',
                  'context': {'pid': 42, 'exitCode': -1, 'port': 12345, 'loopback': True, 'stage': 'native_start'},
                  'missingReasons': ['launch_log_unavailable'], 'truncated': True,
                  'secondaryErrors': [{'error': {'name': 'Error', 'message': 'Node syntax validation failed.',
                     'code': None, 'stack': 'File "server.js", line 1, in node',
                     'context': {'pid': 42, 'exitCode': -1, 'stage': 'native_start'},
                     'missingReasons': ['non_project_frames_omitted']}}]}
        command = [sys.executable, '-c', 'import json,sys; '
                   f'print(json.dumps({{"event":"diagnostic","component":"native","error":{detail!r}}})); sys.exit(1)']
        events = self.collect(command, native_cli=True)
        trusted = [event['error'] for event in events
                   if event.get('event') == 'diagnostic' and event.get('component') == 'bridge']
        self.assertEqual(trusted[0], detail)

    def test_missing_optional_helper_keeps_actual_native_cli_scalar_failure(self):
        with tempfile.TemporaryDirectory(prefix='nora-native-cli-legacy-') as temporary:
            root = Path(temporary)
            app = root / 'apps/tavern-runtime'
            app.mkdir(parents=True)
            target = app / 'native_lifecycle.py'
            shutil.copy2(ROOT / 'app/native_lifecycle.py', target)
            events = self.collect([sys.executable, str(target), 'start'],
                                  env={**os.environ, 'TAVERN_APP_DIR': str(app)}, native_cli=True)
            trusted = [event['error'] for event in events
                       if event.get('event') == 'diagnostic' and event.get('component') == 'bridge']
            self.assertEqual(len(trusted), 1)
            self.assertIn('cannot read native runtime contract', trusted[0]['message'])


if __name__ == '__main__':
    unittest.main()
