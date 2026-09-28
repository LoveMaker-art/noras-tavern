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


class LauncherTracebackTests(unittest.TestCase):
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
                result = subprocess.run([sys.executable, "-B", str(installer / name), *args],
                                        capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("Traceback (most recent call last):", result.stderr)
                self.assertIn(name, result.stderr)
                self.assertIn("RuntimeError", result.stderr)
                self.assertIn(message, result.stderr)


if __name__ == "__main__":
    unittest.main()
