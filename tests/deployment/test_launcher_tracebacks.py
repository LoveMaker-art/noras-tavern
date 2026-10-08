"""Installation entry points retain traceback chains for the desktop log."""

from pathlib import Path
import subprocess
import sys
import unittest
import io
import contextlib
import json
from unittest.mock import patch
import ast
import os
import shutil
import tempfile


class LauncherTracebackTests(unittest.TestCase):
    def test_gateway_identity_failure_has_readable_json_and_permission_code_with_local_cause(self):
        script = Path(__file__).resolve().parents[1] / 'installer/launcher_bridge.py'
        tree = ast.parse(script.read_text(encoding='utf-8'))
        replacement = ast.parse('''
def main():
    import psutil
    from .launcher_services import GatewayIdentityError
    try:
        raise psutil.AccessDenied(5560)
    except psutil.AccessDenied as cause:
        raise GatewayIdentityError('无法确认安装记录中的后台进程。') from cause
''').body[0]
        tree.body = [replacement if isinstance(node, ast.FunctionDef) and node.name == 'main' else node
                     for node in tree.body]
        output, error_output = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error_output), \
             self.assertRaises(SystemExit) as failure:
            exec(compile(ast.fix_missing_locations(tree), str(script), 'exec'),
                 {'__name__': '__main__', '__file__': str(script), '__package__': 'ops.installer'})
        self.assertEqual(failure.exception.code, 1)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        event = events[-1]
        self.assertEqual(event, {'event': 'error', 'message': '无法确认安装记录中的后台进程。',
                                 'code': 'EACCES', 'userCode': 'GATEWAY_IDENTITY'})
        self.assertIn('psutil.AccessDenied: (pid=5560)', error_output.getvalue())
        self.assertIn('GatewayIdentityError', error_output.getvalue())
        self.assertEqual(events[0]['component'], 'bridge')
        self.assertEqual(events[0]['error']['cause']['name'], 'AccessDenied')

    def test_status_keeps_its_single_json_document_contract(self):
        root = Path(__file__).resolve().parent
        script = root.parent / "installer/launcher_bridge.py"
        tree = ast.parse(script.read_text(encoding="utf-8"))
        # Keep the real CLI entrypoint, stubbing only inspection of installed services.
        tree.body = [ast.parse("def status_payload(*args): return {'installed': False}").body[0]
                     if isinstance(node, ast.FunctionDef) and node.name == "status_payload" else node
                     for node in tree.body]
        output = io.StringIO()
        with patch.object(sys, "argv", ["bridge", "--nora-home", str(root),
                                       "--hermes-home", str(root / "hermes"),
                                       "--install-root", str(root / "tavern"), "status"]), \
             contextlib.redirect_stdout(output):
            exec(compile(ast.fix_missing_locations(tree), str(script), "exec"),
                 {"__name__": "__main__", "__file__": str(script), "__package__": "ops.installer"})
        self.assertEqual(json.loads(output.getvalue()), {"event": "result", "installed": False})

    def test_entrypoints_report_exception_type_and_call_site(self):
        installer = Path(__file__).resolve().parents[1] / "installer"
        cases = [
            ("first_install.py", [], "首次安装必须显式传入"),
            ("launcher_bridge.py", ["--nora-home", str(installer), "--hermes-home", str(installer),
                                    "--install-root", str(installer / "tavern"), "status"], "必须是隔离目录内的子目录"),
        ]
        for name, args, message in cases:
            with self.subTest(entrypoint=name):
                if name == 'first_install.py':
                    node = os.environ.get('NORA_TEST_NODE') or shutil.which('node')
                    self.assertTrue(node, 'A real Node runtime is required for the owned install actor')
                    with tempfile.TemporaryDirectory(prefix='nora-traceback-owner-') as temporary:
                        result = subprocess.run([node, str(Path(__file__).with_name('launcher_owned_test_actor.cjs')),
                            str(installer / 'desktop/operation-lock.js'), str(Path(temporary).resolve()),
                            sys.executable, str(installer / name), *args],
                            env={**os.environ, 'NORA_TEST_VENV_HOME': sys.prefix},
                            capture_output=True, text=True, timeout=20, input='')
                else:
                    result = subprocess.run([sys.executable, "-B", str(installer / name), *args],
                                            capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("Traceback (most recent call last):", result.stderr)
                self.assertIn(name, result.stderr)
                self.assertIn("RuntimeError", result.stderr)
                self.assertIn(message, result.stderr)


if __name__ == "__main__":
    unittest.main()
