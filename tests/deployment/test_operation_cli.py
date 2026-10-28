import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parents[1] / 'installer'
spec = importlib.util.spec_from_file_location('cli_under_test', HERE / 'operation_cli.py')
CLI = importlib.util.module_from_spec(spec)
spec.loader.exec_module(CLI)


class CliBoundaryTest(unittest.TestCase):
    def test_existing_guard_must_be_active_and_never_forwards_after_guard_loss(self):
        control = mock.Mock()
        with mock.patch.object(CLI, '_control', return_value=control), mock.patch.object(sys, '_nora_operation_delegate', object(), create=True):
            self.assertIs(CLI.ensure_operation('update', ['known.py'], nora_home='/unused'), control.require_operation.return_value)
            control.require_operation.side_effect = RuntimeError('guard lost')
            with mock.patch.object(CLI, 'validate_receipt') as receipt:
                with self.assertRaisesRegex(RuntimeError, 'guard lost'):
                    CLI.ensure_operation('update', ['known.py'], nora_home='/unused')
                receipt.assert_not_called()

    def test_missing_receipt_refuses_write_with_keep_data_instruction(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(CLI.OperationCliError) as raised:
                CLI.ensure_operation('update', ['/unknown.py'], nora_home=directory, stdin=b'')
            self.assertEqual(raised.exception.code, 'OPERATION_CAPABILITY_INVALID')
            self.assertIn('保留', str(raised.exception))

    def test_successful_forward_exits_original_python_and_keeps_stdin_only_in_memory(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {'NODE_OPTIONS': '--require untrusted.js'}, clear=True):
            home = Path(directory).resolve()
            receipt = {'executable': {'path': '/trusted/Nora'}, 'entry': '/trusted/resources/app.asar/operation-cli.js', 'noraHome': str(home)}
            with mock.patch.object(CLI, 'validate_receipt', return_value=receipt), mock.patch.object(CLI, 'authorize_target'), mock.patch.object(CLI.subprocess, 'run') as run:
                run.return_value.returncode = 0
                with self.assertRaises(SystemExit) as exit_code:
                    CLI.ensure_operation('pair', ['/trusted/launcher_bridge.py', 'pair'], nora_home=home, stdin=b'{"code":"private-pair"}')
                self.assertEqual(exit_code.exception.code, 0)
                args, options = run.call_args
                self.assertEqual(args[0][0], '/trusted/Nora')
                self.assertNotIn('NODE_OPTIONS', options['env'])
                request = json.loads(options['input'])
                self.assertEqual(request['argv'], ['/trusted/launcher_bridge.py', 'pair'])
                self.assertNotIn('private-pair', str(args))
                self.assertEqual(list(home.iterdir()), [])

    def test_unknown_script_and_python_code_flags_are_rejected(self):
        receipt = {'platform': sys.platform, 'resources': {'launcher_bridge.py': {'path': '/trusted/launcher_bridge.py'}, 'first_install.py': {'path': '/trusted/first_install.py'}, 'bootstrap.py': {'path': '/trusted/bootstrap.py'}}, 'managed': {}}
        for target in ('-c', '-m', '/arbitrary.py', '/trusted/model_config.py'):
            with self.subTest(target=target), self.assertRaises(CLI.OperationCliError):
                CLI.authorize_target(receipt, target)

    def test_unknown_kind_and_oversized_input_never_exec_app(self):
        with mock.patch.object(CLI.subprocess, 'run') as run:
            with self.assertRaises(CLI.OperationCliError):
                CLI.ensure_operation('arbitrary', ['x'], nora_home='/tmp', stdin=b'')
            with self.assertRaises(CLI.OperationCliError):
                CLI.ensure_operation('update', ['x'], nora_home='/tmp', stdin=b'x'*(1024*1024+1))
            run.assert_not_called()


class ModelCliBoundaryTest(unittest.TestCase):
    def test_unowned_model_is_forwarded_only_to_the_verified_app_resource(self):
        import base64
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {}, clear=True):
            root = Path(directory).resolve()
            entry = str(root / 'resources/model_config.py')
            receipt = {'executable': {'path': '/trusted/Nora'}, 'entry': '/trusted/resources/app.asar/operation-cli.js',
                       'noraHome': str(root), 'resources': {'model_config.py': {'path': entry}}, 'managed': {}}
            body = json.dumps({'action': 'save-local', 'provider': 'opencode-go', 'key': 'private-key'})
            with mock.patch.object(CLI, 'validate_receipt', return_value=receipt), mock.patch.object(CLI.subprocess, 'run') as run:
                run.return_value.returncode = 0
                with self.assertRaises(SystemExit) as raised:
                    CLI.ensure_operation('model', [entry], nora_home=root, stdin=body)
                self.assertEqual(raised.exception.code, 0)
                request = json.loads(run.call_args.kwargs['input'])
                self.assertEqual(request['kind'], 'model')
                self.assertEqual(json.loads(base64.b64decode(request['stdin']))['provider'], 'opencode-go')
                self.assertNotIn('private-key', str(run.call_args.args))
                with self.assertRaises(CLI.OperationCliError):
                    CLI.ensure_operation('model', [str(root / 'skills/configure_provider.py')], nora_home=root, stdin=body)
                self.assertEqual(run.call_count, 1)

    def test_native_login_uses_the_same_live_stdin_without_persisting_prompt_replies(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {}, clear=True):
            root = Path(directory).resolve()
            entry = str(root / 'resources/model_config.py')
            receipt = {'executable': {'path': '/trusted/Nora'}, 'entry': '/trusted/resources/app.asar/operation-cli.js',
                       'noraHome': str(root), 'resources': {'model_config.py': {'path': entry}}, 'managed': {}}
            output = io.BytesIO()
            class Pipe(io.BytesIO):
                def close(self):
                    output.write(self.getvalue())
                    super().close()
            process = mock.Mock(stdin=Pipe(), returncode=0)
            source = io.StringIO('{"promptId":"one","response":"private-code"}\n')
            def wait():
                import time
                for _ in range(100):
                    if process.stdin.closed:
                        return 0
                    time.sleep(.001)
                raise AssertionError('stdin relay did not finish')
            process.wait.side_effect = wait
            with mock.patch.object(CLI, 'validate_receipt', return_value=receipt), mock.patch.object(CLI.subprocess, 'Popen', return_value=process) as run, mock.patch.object(sys, 'stdin', source):
                with self.assertRaises(SystemExit) as raised:
                    CLI.ensure_operation('model', [entry], nora_home=root, stdin='{"action":"authenticate","provider":"native"}')
                self.assertEqual(raised.exception.code, 0)
                lines = output.getvalue().splitlines()
                self.assertEqual(json.loads(lines[0])['kind'], 'model')
                self.assertEqual(json.loads(lines[1])['response'], 'private-code')
                self.assertNotIn('private-code', str(run.call_args.args))
                self.assertEqual(list(root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
