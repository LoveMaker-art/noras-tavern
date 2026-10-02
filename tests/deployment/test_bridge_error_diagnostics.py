import ast
import contextlib
import errno
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from ops.installer import launcher_bridge as bridge
from ops.installer import launcher_services as services


class BridgeErrorDiagnosticTests(unittest.TestCase):
    def capture_fail(self, message, code=None, user_code=None, **kwargs):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as stopped:
                bridge.fail(message, code, user_code, **kwargs)
        self.assertEqual(stopped.exception.code, 1)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([event['event'] for event in events], ['diagnostic', 'error'])
        self.assertEqual(events[0]['component'], 'bridge')
        return events, output.getvalue()

    def assert_location_stack(self, error, function):
        stack = error['stack']
        self.assertIsInstance(stack, str)
        self.assertTrue(stack.strip())
        self.assertIn(function, stack)
        for line in stack.splitlines():
            self.assertRegex(line, r'^\s*File "[^"]+", line \d+, in [^\r\n]+$')

    def test_explicit_fail_has_call_location_and_preserves_error_event(self):
        message = '未找到完整的 Nora 运行时'
        events, raw = self.capture_fail(message, 'EACCES', 'GATEWAY_IDENTITY')
        error = events[0]['error']
        self.assertEqual(error['message'], message)
        self.assertTrue(error['name'])
        self.assertEqual(error['code'], 'EACCES')
        self.assert_location_stack(error, 'test_explicit_fail_has_call_location')
        self.assertIn(Path(__file__).name, error['stack'])
        self.assertNotIn('events, raw = self.capture_fail(', raw)
        self.assertEqual(events[1], {
            'event': 'error', 'message': message, 'code': 'EACCES',
            'userCode': 'GATEWAY_IDENTITY',
        })

    def test_exception_retains_permission_cause_and_both_locations(self):
        try:
            try:
                raise PermissionError(errno.EACCES, 'fixture permission denied')
            except PermissionError as cause:
                raise RuntimeError('无法读取后台进程状态') from cause
        except RuntimeError as error:
            events, raw = self.capture_fail(str(error), error=error)
        diagnostic = events[0]['error']
        self.assertEqual(diagnostic['name'], 'RuntimeError')
        self.assertEqual(diagnostic['message'], '无法读取后台进程状态')
        self.assert_location_stack(diagnostic, 'test_exception_retains_permission_cause')
        cause = diagnostic['cause']
        self.assertEqual(cause['name'], 'PermissionError')
        self.assertEqual(cause['code'], 'EACCES')
        self.assertIn('fixture permission denied', cause['message'])
        self.assert_location_stack(cause, 'test_exception_retains_permission_cause')
        self.assertNotEqual(diagnostic['stack'], cause['stack'])
        self.assertNotIn('raise RuntimeError(', raw)
        self.assertNotIn('raise PermissionError(', raw)
        self.assertEqual(events[1]['message'], '无法读取后台进程状态')

    def test_gateway_status_keeps_localized_error_and_access_denied_cause(self):
        import psutil

        with tempfile.TemporaryDirectory(prefix='nora-bridge-diagnostic-') as temporary:
            root = Path(temporary)
            (root / 'installer').mkdir()
            (root / 'installer/gateway.json').write_text(json.dumps({
                'pid': 5560, 'created': 100, 'command': ['python', 'gateway', 'run'],
            }), encoding='utf-8')
            process = Mock(pid=5560)
            process.create_time.return_value = 100
            process.cmdline.side_effect = psutil.AccessDenied(5560)
            with patch('psutil.Process', return_value=process), \
                 patch.object(services, '_before_windows_boot', return_value=False):
                try:
                    services.gateway_status(root, root / 'hermes')
                except services.GatewayIdentityError as error:
                    events, _ = self.capture_fail(
                        str(error), error.code, error.user_code, error=error)
                else:
                    self.fail('gateway_status must report unreadable process identity')
        diagnostic = events[0]['error']
        self.assertEqual(diagnostic['name'], 'GatewayIdentityError')
        self.assertEqual(diagnostic['message'], '无法查询诺拉后台状态：系统拒绝读取进程信息。')
        self.assertEqual(diagnostic['code'], 'EACCES')
        self.assert_location_stack(diagnostic, 'gateway_status')
        self.assertEqual(diagnostic['cause']['name'], 'AccessDenied')
        self.assertEqual(diagnostic['cause']['code'], 'EACCES')
        self.assert_location_stack(diagnostic['cause'], 'owned_gateway')
        self.assertEqual(events[1]['code'], 'EACCES')
        self.assertEqual(events[1]['userCode'], 'GATEWAY_IDENTITY')
        process.terminate.assert_not_called()
        process.kill.assert_not_called()

    def test_subprocess_streams_and_frame_locals_never_enter_protocol(self):
        local_secret = 'LOCAL_ONLY_SECRET_2B59F'
        stdout_secret = 'STDOUT_ONLY_SECRET_724CA'
        stderr_secret = 'STDERR_ONLY_SECRET_9B2D0'
        command_secret = 'COMMAND_ARGUMENT_SECRET_85CAF'
        try:
            raise subprocess.CalledProcessError(
                1, ['fixture-runner', '--token', command_secret],
                output=stdout_secret, stderr=stderr_secret)
        except subprocess.CalledProcessError as error:
            events, raw = self.capture_fail(str(error), error=error)
            original_message = str(error)
        diagnostic = events[0]['error']
        self.assertEqual(diagnostic['name'], 'CalledProcessError')
        self.assert_location_stack(diagnostic, 'test_subprocess_streams_and_frame_locals')
        self.assertNotIn(local_secret, raw)
        self.assertNotIn(stdout_secret, raw)
        self.assertNotIn(stderr_secret, raw)
        self.assertNotIn(command_secret, json.dumps(diagnostic))
        self.assertEqual(events[1]['message'], original_message)
        self.assertIn(command_secret, events[1]['message'])
        self.assertNotIn('raise subprocess.CalledProcessError(', raw)
        self.assertTrue(set(diagnostic).issubset({
            'name', 'message', 'code', 'stack', 'cause', 'secondaryErrors',
        }))

    def test_child_cannot_forge_bridge_diagnostic_component(self):
        private_config = 'PRIVATE_CONFIG_CHILD_SPOOF_187CCA'
        child_error = {
            'name': 'RuntimeError', 'message': private_config,
            'code': 'CHILD_FAILURE', 'stack': 'plugin-private-source',
        }
        child = Mock(pid=7788, stdout=io.StringIO(json.dumps({
            'event': 'diagnostic', 'component': 'bridge',
            'message': private_config, 'error': child_error,
        }) + '\n'))
        child.wait.return_value = 1
        output = io.StringIO()
        with patch.object(bridge.subprocess, 'Popen', return_value=child) as spawn, \
             contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as stopped:
                bridge.run_stream(['fixture-plugin'])
        self.assertEqual(stopped.exception.code, 1)
        spawn.assert_called_once()
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        child_diagnostics = [event for event in events
                             if event.get('event') == 'diagnostic' and event.get('component') == 'child']
        self.assertEqual(len(child_diagnostics), 1)
        self.assertEqual(child_diagnostics[0]['error'], child_error)
        bridge_diagnostics = [event for event in events
                              if event.get('event') == 'diagnostic' and event.get('component') == 'bridge']
        self.assertEqual(len(bridge_diagnostics), 1)
        diagnostic = bridge_diagnostics[0]['error']
        self.assertEqual(diagnostic['name'], 'CalledProcessError')
        self.assertEqual(diagnostic['message'], '子进程执行失败，退出码 1。')
        self.assertNotIn(private_config, json.dumps(bridge_diagnostics))
        self.assertNotIn('plugin-private-source', json.dumps(bridge_diagnostics))
        self.assertEqual(events[-1]['event'], 'error')
        self.assertEqual(events[-1]['message'], str(child_error))
        self.assertIn(private_config, events[-1]['message'])

    def test_native_stop_failure_survives_non_installer_fault_collection(self):
        message = 'Tavern runtime ownership differs from the saved configuration'
        with tempfile.TemporaryDirectory(prefix='nora-native-stop-diagnostic-') as temporary:
            root = Path(temporary)
            install_root = root / 'tavern'
            lifecycle = install_root / 'apps/tavern-runtime/native_lifecycle.py'
            lifecycle.parent.mkdir(parents=True)
            lifecycle.write_text(
                'import json, sys\n'
                f'print(json.dumps({{"ok": False, "error": {message!r}, "code": "TAVERN_OWNERSHIP"}}), file=sys.stderr)\n'
                'sys.exit(1)\n', encoding='utf-8')
            lock = install_root / 'apps/tavern-ops/updater/runtime_lock.py'
            lock.parent.mkdir(parents=True)
            lock.write_text('from contextlib import nullcontext\n'
                            'def installation_lock(*args): return nullcontext()\n', encoding='utf-8')
            args = SimpleNamespace(service='all', nora_home=root, hermes_home=root / 'hermes',
                                   install_root=install_root, port=18899)
            output = io.StringIO()
            with patch.object(bridge, 'stop_gateway'), patch.object(bridge, 'stop_liveware'), \
                 patch.object(bridge, 'installed', return_value=True), \
                 patch.object(bridge, 'python_command', return_value=sys.executable), \
                 patch.object(bridge, 'status_payload') as status, \
                 contextlib.redirect_stdout(output):
                with self.assertRaises(RuntimeError) as failed:
                    bridge.command_stop(args)
            status.assert_not_called()
        emitted = [json.loads(line) for line in output.getvalue().splitlines()]
        events, _ = self.capture_fail(str(failed.exception), error=failed.exception)
        diagnostic = events[0]['error']
        self.assertEqual(diagnostic['cause']['name'], 'CalledProcessError')
        self.assertIn(message, diagnostic['cause']['message'])
        self.assertEqual(diagnostic['cause']['code'], 'TAVERN_OWNERSHIP')
        self.assert_location_stack(diagnostic['cause'], 'run_stream')
        self.assertTrue(any(item.get('event') == 'error' and item.get('message') == message
                            for item in emitted))
        script = '''
const fs = require('node:fs');
const { createFaultPackets } = require(process.argv[1]);
const packets = createFaultPackets();
const collector = packets.collector(true, { output: false });
for (const event of JSON.parse(fs.readFileSync(0, 'utf8'))) collector.observe(event);
const error = collector.attach(new Error('停止服务失败。'));
console.log(JSON.stringify(packets.packet(error, { action: 'stop', history: [] })));
'''
        packet = subprocess.run(['node', '-e', script,
                                 str(Path(bridge.__file__).parent / 'desktop/fault-packet.js')],
                                input=json.dumps(emitted + events), text=True, capture_output=True,
                                check=True)
        fault = json.loads(packet.stdout)
        self.assertTrue(any(message in item['message'] for item in fault['errors']))
        self.assertEqual(fault['output'], [])

    def test_untrusted_scalar_child_error_does_not_enter_bridge_diagnostic(self):
        private_config = 'PRIVATE_UNTRUSTED_SCALAR_ERROR_724F'
        command = [sys.executable, '-c', 'import json,sys; '
                   f'print(json.dumps({{"ok":False,"error":{private_config!r},"code":"EACCES"}})); '
                   'sys.exit(1)']
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
            bridge.run_stream(command)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        diagnostic = next(item['error'] for item in events
                          if item.get('event') == 'diagnostic' and item.get('component') == 'bridge')
        self.assertEqual(diagnostic['message'], '子进程执行失败，退出码 1。')
        self.assertNotIn(private_config, json.dumps(diagnostic))

    def test_cause_cycle_is_finite_and_does_not_repeat_nodes(self):
        first = RuntimeError('cycle first')
        second = PermissionError(errno.EACCES, 'cycle second')
        first.__cause__ = second
        second.__cause__ = first
        events, _ = self.capture_fail(str(first), error=first)
        current = events[0]['error']
        names = []
        while isinstance(current, dict):
            names.append(current['name'])
            self.assertLessEqual(len(names), 2)
            current = current.get('cause')
        self.assertEqual(names, ['RuntimeError', 'PermissionError'])

    def test_cause_depth_is_limited_to_four_total_nodes(self):
        error = RuntimeError('cause level 10')
        for level in reversed(range(10)):
            parent = RuntimeError(f'cause level {level}')
            parent.__cause__ = error
            error = parent
        events, _ = self.capture_fail(str(error), error=error)
        current = events[0]['error']
        messages = []
        while isinstance(current, dict):
            messages.append(current['message'])
            self.assertLessEqual(len(messages), 4)
            current = current.get('cause')
        self.assertGreater(len(messages), 1)
        self.assertEqual(messages, [f'cause level {level}' for level in range(len(messages))])

    def test_stop_preserves_original_errors_before_status_inspection(self):
        args = Mock(service='all', nora_home=Path('/fixture/nora'),
                    hermes_home=Path('/fixture/nora/hermes'),
                    install_root=Path('/fixture/nora/tavern'), port=8799)
        primary = services.GatewayIdentityError('无法确认后台进程身份')
        secondary = PermissionError(errno.EACCES, '无法停止 Liveware')
        with patch.object(bridge, 'stop_gateway', side_effect=primary) as stop_gateway, \
             patch.object(bridge, 'stop_liveware', side_effect=secondary) as stop_liveware, \
             patch.object(bridge, 'installed', return_value=False), \
             patch.object(bridge, 'status_payload', side_effect=RuntimeError('status hides stop failure')) as status, \
             patch.object(bridge, 'emit'):
            with self.assertRaises(RuntimeError) as failed:
                bridge.command_stop(args)
        self.assertIs(failed.exception.__cause__, primary)
        self.assertEqual(failed.exception.secondary_errors, [secondary])
        self.assertIn(str(primary), str(failed.exception))
        self.assertIn(str(secondary), str(failed.exception))
        stop_gateway.assert_called_once()
        stop_liveware.assert_called_once()
        status.assert_not_called()
        events, _ = self.capture_fail(str(failed.exception), error=failed.exception)
        diagnostic = events[0]['error']
        self.assertEqual(diagnostic['cause']['name'], 'GatewayIdentityError')
        self.assertEqual(diagnostic['cause']['code'], 'EACCES')
        self.assertEqual(len(diagnostic['secondaryErrors']), 1)
        secondary_diagnostic = diagnostic['secondaryErrors'][0]['error']
        self.assertEqual(secondary_diagnostic['name'], 'PermissionError')
        self.assertEqual(secondary_diagnostic['code'], 'EACCES')
        self.assert_location_stack(secondary_diagnostic, 'command_stop')

    def test_secondary_errors_share_the_four_node_budget(self):
        error = RuntimeError('primary fixture failure')
        error.secondary_errors = [RuntimeError(f'secondary fixture {index}') for index in range(8)]
        events, _ = self.capture_fail(str(error), error=error)
        diagnostic = events[0]['error']
        self.assertTrue(diagnostic['secondaryErrors'])
        pending = [diagnostic]
        count = 0
        while pending:
            current = pending.pop()
            count += 1
            self.assertLessEqual(count, 4)
            if isinstance(current.get('cause'), dict):
                pending.append(current['cause'])
            pending.extend(item['error'] for item in current.get('secondaryErrors', []))

    def test_dual_stop_failures_keep_subprocess_cause_within_four_nodes(self):
        import psutil

        args = Mock(service='all', nora_home=Path('/fixture/nora'),
                    hermes_home=Path('/fixture/nora/hermes'),
                    install_root=Path('/fixture/nora/tavern'), port=8799)
        child_error = subprocess.CalledProcessError(7, ['fixture-plugin'])

        def stop_gateway_fixture(*args, **kwargs):
            try:
                raise psutil.AccessDenied(5560)
            except psutil.AccessDenied as cause:
                raise services.GatewayIdentityError('无法确认后台进程身份') from cause

        def stop_tavern_fixture(*args, **kwargs):
            bridge.fail('child失败', error=child_error)

        with patch.object(bridge, 'stop_gateway', side_effect=stop_gateway_fixture), \
             patch.object(bridge, 'stop_liveware', side_effect=stop_tavern_fixture), \
             patch.object(bridge, 'installed', return_value=False), \
             patch.object(bridge, 'status_payload') as status, \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError) as failed:
                bridge.command_stop(args)
        status.assert_not_called()
        aggregate = failed.exception
        expected_summary = '无法确认后台进程身份；酒馆停止命令未完成'
        self.assertEqual(str(aggregate), expected_summary)
        events, _ = self.capture_fail(str(aggregate), error=aggregate)
        diagnostic = events[0]['error']
        self.assertEqual(diagnostic['cause']['name'], 'GatewayIdentityError')
        self.assertEqual(diagnostic['cause']['cause']['name'], 'AccessDenied')
        self.assertEqual(diagnostic['cause']['cause']['code'], 'EACCES')
        self.assertEqual(len(diagnostic['secondaryErrors']), 1)
        secondary = diagnostic['secondaryErrors'][0]['error']
        self.assertEqual(secondary['name'], 'CalledProcessError')
        self.assertIn('7', secondary['message'])
        self.assert_location_stack(secondary, 'command_stop')
        self.assertIn('stop_tavern_fixture', secondary['stack'])
        pending = [diagnostic]
        names = []
        while pending:
            current = pending.pop()
            names.append(current['name'])
            self.assertLessEqual(len(names), 4)
            if isinstance(current.get('cause'), dict):
                pending.append(current['cause'])
            pending.extend(item['error'] for item in current.get('secondaryErrors', []))
        self.assertCountEqual(names, [
            'RuntimeError', 'GatewayIdentityError', 'AccessDenied', 'CalledProcessError',
        ])
        self.assertEqual(events[1]['message'], expected_summary)

    def test_sensitive_exception_types_use_stable_diagnostic_summaries(self):
        import yaml

        class FixtureParseFailure(Exception):
            pass

        def yaml_failure(secret):
            try:
                yaml.safe_load(f'credential: [{secret}\n')
            except yaml.YAMLError as error:
                return error
            self.fail('invalid YAML fixture must fail parsing')

        cases = {
            'yaml': yaml_failure,
            'json': lambda secret: json.JSONDecodeError(secret, '{"credential":"' + secret + '"}', 0),
            'unicode': lambda secret: UnicodeDecodeError('utf-8', b'\xff' + secret.encode(), 0, 1, secret),
            'command': lambda secret: subprocess.CalledProcessError(
                1, ['fixture-runner', '--token', secret], output=secret, stderr=secret),
            'timeout': lambda secret: subprocess.TimeoutExpired(
                ['fixture-runner', '--token', secret], 5, output=secret, stderr=secret),
            'unknown': lambda secret: FixtureParseFailure(secret),
        }
        for label, make_error in cases.items():
            summaries = []
            for variant in ('A', 'B'):
                with self.subTest(kind=label, variant=variant):
                    secret = f'PRIVATE_{label.upper()}_{variant}_925CEA'
                    error = make_error(secret)
                    self.assertIn(secret, str(error))
                    try:
                        raise error
                    except Exception as caught:
                        events, _ = self.capture_fail(str(caught), error=caught)
                    diagnostic = events[0]['error']
                    summaries.append(diagnostic['message'])
                    self.assertEqual(diagnostic['name'], type(error).__name__)
                    self.assertNotIn(secret, json.dumps(diagnostic))
                    self.assertTrue(diagnostic['message'])
                    self.assert_location_stack(diagnostic,
                        'yaml_failure' if label == 'yaml' else 'test_sensitive_exception_types')
                    self.assertEqual(events[1]['message'], str(error))
            if len(summaries) == 2:
                self.assertEqual(summaries[0], summaries[1], label)

    def test_entrypoint_passes_original_exception_to_diagnostic_protocol(self):
        def fixture_main():
            try:
                raise PermissionError(errno.EACCES, 'entrypoint fixture denied')
            except PermissionError as cause:
                raise services.GatewayIdentityError('无法查询诺拉后台状态') from cause

        source = Path(bridge.__file__).read_text(encoding='utf-8')
        entrypoint = ast.parse(source).body[-1]
        self.assertIsInstance(entrypoint, ast.If)
        self.assertEqual(ast.unparse(entrypoint.test), "__name__ == '__main__'")
        code = compile(ast.Module(body=[entrypoint], type_ignores=[]), bridge.__file__, 'exec')
        namespace = {**vars(bridge), '__name__': '__main__', 'main': fixture_main}
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                exec(code, namespace)
        self.assertEqual(stopped.exception.code, 1)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([event['event'] for event in events], ['diagnostic', 'error'])
        diagnostic = events[0]['error']
        self.assertEqual(diagnostic['name'], 'GatewayIdentityError')
        self.assertEqual(diagnostic['message'], '无法查询诺拉后台状态')
        self.assertEqual(diagnostic['code'], 'EACCES')
        self.assert_location_stack(diagnostic, 'fixture_main')
        self.assertEqual(diagnostic['cause']['name'], 'PermissionError')
        self.assertEqual(diagnostic['cause']['code'], 'EACCES')
        self.assert_location_stack(diagnostic['cause'], 'fixture_main')
        self.assertEqual(events[1]['code'], 'EACCES')
        self.assertEqual(events[1]['userCode'], 'GATEWAY_IDENTITY')


if __name__ == '__main__':
    unittest.main()
