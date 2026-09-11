"""Installation entry points retain traceback chains for the desktop log."""

from pathlib import Path
import subprocess
import sys
import unittest


class LauncherTracebackTests(unittest.TestCase):
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
