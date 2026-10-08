import ast
import contextlib
import errno
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import traceback
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import yaml

from ops.installer import first_install, launcher_bridge as bridge
from ops.updater import update
from ops.tests import test_native_startup_evidence as native_fixtures


class UpdateErrorDiagnosticTests(unittest.TestCase):
    def entrypoint(self, module, work):
        entry = ast.parse(Path(module.__file__).read_text()).body[-1]
        self.assertIsInstance(entry, ast.If)
        output, errors = io.StringIO(), io.StringIO()
        namespace = {**vars(module), '__name__': '__main__', 'main': work}
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit) as stopped:
                exec(compile(ast.Module(body=[entry], type_ignores=[]), module.__file__, 'exec'), namespace)
        self.assertEqual(stopped.exception.code, 1)
        return [json.loads(line) for line in output.getvalue().splitlines()], errors.getvalue()

    def test_real_updater_entrypoint_preserves_project_cause_without_private_values(self):
        def failure():
            try:
                private_local = 'PRIVATE_CONFIG_VALUE'
                raise PermissionError(errno.EACCES, 'fixture permission denied')
            except PermissionError as cause:
                raise RuntimeError('启动器实例记录与当前目录不一致，已停止更新。') from cause

        events, local = self.entrypoint(update, failure)
        self.assertEqual([event['event'] for event in events], ['diagnostic', 'error'])
        self.assertEqual(events[0]['component'], 'updater')
        detail = events[0]['error']
        self.assertEqual(detail['name'], 'RuntimeError')
        self.assertEqual(detail['message'], '启动器实例记录与当前目录不一致，已停止更新。')
        self.assertEqual(detail['cause']['name'], 'PermissionError')
        self.assertEqual(detail['cause']['code'], 'EACCES')
        self.assertIn('test_update_error_diagnostics.py', detail['cause']['stack'])
        self.assertIn('failure', detail['cause']['stack'])
        self.assertNotIn('PRIVATE_', json.dumps(events) + local)
        self.assertNotIn('/private/user', json.dumps(events) + local)
        self.assertNotIn('raise PermissionError', json.dumps(events) + local)

    def test_actual_instance_guard_reason_remains_readable_at_updater_entrypoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def failure():
                update.managed_instance(root / 'hermes', root)
            events, _local = self.entrypoint(update, failure)
        expected = '无法核对启动器实例记录，已停止更新：缺少 nora-instance.json。'
        self.assertEqual(events[0]['error']['message'], expected)
        self.assertEqual(events[1]['message'], expected)
        self.assertNotIn('cause', events[0]['error'])

    def test_real_first_install_entrypoint_preserves_stable_node_locations(self):
        def failure():
            node = RuntimeError('Node 在启动检查前退出，退出码 1。')
            node.code = 'TAVERN_UNHEALTHY'
            node._bridge_diagnostic_stack = [traceback.FrameSummary(
                'server.js', 27, 'node', line='PRIVATE_NODE_LOG_TEXT', lookup_line=False)]
            raise RuntimeError('酒馆启动检查未完成，保留现有安装。') from node

        events, _local = self.entrypoint(first_install, failure)
        self.assertEqual([event['event'] for event in events], ['diagnostic', 'error'])
        self.assertEqual(events[0]['component'], 'installer')
        detail = events[0]['error']
        self.assertIn('保留现有安装', detail['message'])
        self.assertEqual(detail['cause']['message'], 'Node 在启动检查前退出，退出码 1。')
        self.assertEqual(detail['cause']['stack'], 'File "server.js", line 27, in node')
        self.assertNotIn('PRIVATE_NODE_LOG_TEXT', json.dumps(events))

    def test_managed_recovery_failure_keeps_primary_cause_and_secondary(self):
        source = ast.parse(Path(update.__file__).read_text())
        handler = next(node for node in ast.walk(source)
                       if isinstance(node, ast.ExceptHandler)
                       and any(isinstance(item, ast.If) and ast.unparse(item.test) == 'committed'
                               for item in node.body))
        branch = next(node for node in handler.body
                      if isinstance(node, ast.If) and ast.unparse(node.test) == 'journal is not None')
        primary, secondary = RuntimeError('original startup failed'), PermissionError(errno.EACCES, 'restore denied')

        def fail_start():
            raise primary

        def fail_restore(*_args, **_kwargs):
            raise secondary

        tree = ast.parse('def transaction():\n try:\n  fail_start()\n except BaseException as error:\n  pass\n')
        tree.body[0].body[0].handlers[0].body = [branch]
        ast.fix_missing_locations(tree)
        namespace = {'fail_start': fail_start, 'journal': object(), 'recovery_helper': SimpleNamespace(recover=fail_restore),
                     '_operation_evidence': SimpleNamespace(freeze=Mock()), 'managed_home': Path('/fixture'),
                     'hermes_home': Path('/fixture/hermes'), 'install_root': Path('/fixture/tavern'),
                     'version': '2.4.2', 'backup': Path('/fixture/backup')}
        exec(compile(tree, update.__file__, 'exec'), namespace)
        with self.assertRaises(RuntimeError) as caught:
            namespace['transaction']()
        self.assertIs(caught.exception.__cause__, primary)
        self.assertEqual(caught.exception.secondary_errors, [secondary])

    def test_parser_sdk_and_subprocess_payloads_never_enter_structured_events(self):
        secret = 'PRIVATE_PARSER_OR_SDK_PAYLOAD'
        cases = [json.JSONDecodeError(secret, '{"api_key":"' + secret + '"}', 0),
                 yaml.YAMLError(secret), ValueError(secret), Exception(secret),
                 UnicodeDecodeError('utf-8', secret.encode(), 0, 1, secret),
                 subprocess.CalledProcessError(7, ['node', secret], output=secret, stderr=secret),
                 subprocess.TimeoutExpired(['node', secret], 1, output=secret, stderr=secret)]
        for error in cases:
            with self.subTest(kind=type(error).__name__):
                def failure():
                    private_local = secret
                    raise error
                events, _local = self.entrypoint(update, failure)
                self.assertTrue(events[0]['error']['message'])
                self.assertNotIn(secret, json.dumps(events))
                self.assertNotIn('private_local', json.dumps(events))
                self.assertNotIn('raise error', json.dumps(events))
                self.assertTrue(set(events[0]['error']).issubset(
                    {'name', 'message', 'code', 'stack', 'cause', 'secondaryErrors'}))

    def test_projection_limits_nodes_and_excludes_foreign_source_locations(self):
        namespace = {}
        exec(compile('def sdk_failure():\n raise ValueError("PRIVATE_SDK_VALUE")\n',
                     '/private/sdk/customer_settings.py', 'exec'), namespace)
        def failure():
            namespace['sdk_failure']()
        events, _local = self.entrypoint(update, failure)
        self.assertNotIn('customer_settings.py', json.dumps(events))
        self.assertNotIn('PRIVATE_SDK_VALUE', json.dumps(events))
        root = RuntimeError('guard')
        root.__cause__ = root
        root.secondary_errors = [RuntimeError('cleanup ' + str(index)) for index in range(8)]
        detail = update._error_diagnostics.exception_diagnostic(root)
        pending, seen = [detail], []
        while pending:
            node = pending.pop(); seen.append(node)
            if node.get('cause'):
                pending.append(node['cause'])
            pending.extend(item['error'] for item in node.get('secondaryErrors', []))
        self.assertLessEqual(len(seen), 4)

    def test_projection_marks_actual_frame_node_and_message_cropping(self):
        helper = update._error_diagnostics
        error = RuntimeError('bounded program failure')
        frames = [traceback.FrameSummary('server.js', line, 'node', lookup_line=False)
                  for line in range(1, 14)]
        detail = helper.exception_diagnostic(error, stack=frames)
        self.assertEqual(len(detail['stack'].splitlines()), 12)
        self.assertTrue(detail['truncated'])
        self.assertNotIn('truncated', helper.exception_diagnostic(error, stack=frames[:12]))
        error.__cause__ = error
        self.assertNotIn('truncated', helper.exception_diagnostic(error))
        error.__cause__ = None
        current = error
        for _ in range(4):
            current.__cause__ = RuntimeError('cause')
            current = current.__cause__
        self.assertTrue(helper.exception_diagnostic(error)['truncated'])
        detail = helper.exception_diagnostic(RuntimeError('x' * 2001))
        self.assertEqual(len(detail['message']), 2000)
        self.assertTrue(detail['truncated'])

    def test_bridge_and_installer_use_the_same_exception_projection(self):
        try:
            raise PermissionError(errno.EACCES, 'program permission failure')
        except PermissionError as cause:
            error = RuntimeError('shared classification')
            error.__cause__ = cause
        expected = update._error_diagnostics.exception_diagnostic(
            error, project_root=Path(bridge.__file__).parent.parent)
        self.assertEqual(bridge.exception_diagnostic(error), expected)

    def bridge_events(self, events):
        child = Mock(pid=42, stdout=io.StringIO(''.join(json.dumps(event) + '\n' for event in events)))
        child.wait.return_value = 1
        output = io.StringIO()
        with patch.object(bridge.subprocess, 'Popen', return_value=child), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit):
                bridge.run_stream(['fixture-installer-or-updater'])
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def fault_packet(self, events, action):
        desktop = Path(__file__).resolve().parents[1] / 'installer/desktop/fault-packet.js'
        script = """
const {createFaultPackets}=require(process.argv[1]);
const faults=createFaultPackets(),collector=faults.collector(true,{output:true});
for(const event of JSON.parse(process.argv[2]))collector.observe(event);
const packet=faults.packet(collector.attach(new Error('outer exit wrapper')),{action:process.argv[3],history:[]});
process.stdout.write(JSON.stringify(packet));
"""
        return json.loads(subprocess.run([native_fixtures.NODE, '-e', script, str(desktop), json.dumps(events), action],
                                         capture_output=True, text=True, check=True).stdout)

    @unittest.skipUnless(native_fixtures.NODE, 'requires a real Node executable')
    def test_real_node_failure_crosses_first_install_bridge_and_fault_packet(self):
        case = native_fixtures.NativeStartupEvidenceTests('test_real_node_exit_preserves_exit_code_and_program_locations')
        case.setUp()
        self.addCleanup(case.doCleanups)
        events = case.guarded_failure_events()
        self.assertEqual(events[1]['code'], 'TAVERN_PROCESS_EXITED')
        forwarded = self.bridge_events(events)
        self.assertTrue(any(event.get('component') == 'installer' for event in forwarded))
        self.assertEqual([event['error']['name'] for event in forwarded if event.get('component') == 'bridge'],
                         ['CalledProcessError'])
        packet = self.fault_packet(forwarded, 'install')
        self.assertTrue(any('MODULE_NOT_FOUND' in error['message'] for error in packet['errors']))
        self.assertTrue(any('server.js' in frame for error in packet['errors'] for frame in error['frames']))
        self.assertNotIn('nora-intentionally-missing-test-module', json.dumps(packet))
        self.assertNotIn(str(case.base), json.dumps(packet))

    @unittest.skipUnless(native_fixtures.NODE, 'requires a real Node executable')
    def test_four_node_updater_diagnostic_keeps_primary_after_outer_bridge_exit(self):
        def failure():
            primary = RuntimeError('原始更新失败，必须保留。')
            primary.__cause__ = PermissionError(errno.EACCES, '原始权限拒绝。')
            node = RuntimeError('Node startup program evidence: MODULE_NOT_FOUND')
            node._bridge_diagnostic_stack = [traceback.FrameSummary('server.js', 27, 'node', lookup_line=False)]
            primary.secondary_errors = [node, RuntimeError('回滚未完成。')]
            raise primary
        events, _local = self.entrypoint(update, failure)
        forwarded = self.bridge_events(events)
        packet = self.fault_packet(forwarded, 'update')
        messages = [error['message'] for error in packet['errors']]
        self.assertIn('原始更新失败，必须保留。', messages)
        self.assertIn('回滚未完成。', messages)
        self.assertTrue(any('MODULE_NOT_FOUND' in message for message in messages))
        self.assertLessEqual(len(packet['errors']), 4)


if __name__ == '__main__':
    unittest.main()
