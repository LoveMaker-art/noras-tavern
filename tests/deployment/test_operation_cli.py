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


if __name__ == '__main__':
    unittest.main()
