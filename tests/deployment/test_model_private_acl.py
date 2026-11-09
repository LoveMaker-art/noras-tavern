"""Windows identity probing for the candidate-config ACL step.

whoami/icacls answer in the machine codepage while the helper runs in UTF-8
mode, so a Chinese username must not break candidate permission restriction.
"""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]


def module_path(*candidates):
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError(candidates)


SUBJECT_PATH = module_path(REPO / "deployment" / "shared" / "hermes_model_config.py",
                           REPO / "ops" / "installer" / "hermes_model_config.py")
spec = importlib.util.spec_from_file_location("hermes_model_config_under_test", SUBJECT_PATH)
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)


class PrivateAclIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / "candidate"
        self.directory.mkdir()
        self.sid = "S-1-5-21-1000000000-2000000000-3000000000-1001"
        self.calls = []

    def run_whoami(self, stdout_bytes, returncode=0):
        result = subprocess.CompletedProcess(["whoami"], returncode,
                                             stdout=stdout_bytes, stderr=b"")
        def fake_run(command, **options):
            self.calls.append(command)
            if command[0] == "whoami":
                return result
            return subprocess.CompletedProcess(command, 0, stdout=b"", stderr=b"")
        return fake_run

    def test_machine_codepage_username_with_ascii_sid_is_accepted(self):
        csv_line = "DESKTOP-PC\\\u732b\u732b,S-1-5-21-1-2-3-1001\n".encode("gbk")
        with patch.object(subject.subprocess, "run", side_effect=self.run_whoami(csv_line)), \
                patch.object(subject.os, "name", "nt"):
            subject._private(self.directory)
        grant = [call for call in self.calls if call[0] == "icacls"]
        self.assertEqual(len(grant), 1, "icacls runs with the resolved SID")
        self.assertIn("S-1-5-21-1-2-3-1001", grant[0][-1])

    def test_utf8_username_output_is_accepted(self):
        csv_line = f"PC\\user,{self.sid}\n".encode("utf-8")
        with patch.object(subject.subprocess, "run", side_effect=self.run_whoami(csv_line)), \
                patch.object(subject.os, "name", "nt"):
            subject._private(self.directory)
        self.assertTrue(any(call[0] == "icacls" for call in self.calls))

    def test_empty_identity_output_is_rejected_clearly(self):
        with patch.object(subject.subprocess, "run", side_effect=self.run_whoami(b"")), \
                patch.object(subject.os, "name", "nt"):
            with self.assertRaisesRegex(ValueError, "未返回账户标识"):
                subject._private(self.directory)
        self.assertFalse(any(call[0] == "icacls" for call in self.calls),
                         "permissions are untouched when identity is unavailable")

    def test_whoami_failure_is_wrapped_without_touching_permissions(self):
        def failing(command, **options):
            self.calls.append(command)
            if command[0] == "whoami":
                raise subprocess.CalledProcessError(1, command, output=b"", stderr=b"denied")
            return subprocess.CompletedProcess(command, 0, stdout=b"", stderr=b"")
        with patch.object(subject.subprocess, "run", side_effect=failing), \
                patch.object(subject.os, "name", "nt"):
            with self.assertRaisesRegex(ValueError, "未修改原配置"):
                subject._private(self.directory)
        self.assertFalse(any(call[0] == "icacls" for call in self.calls))

    def test_non_windows_chmods_the_directory(self):
        with patch.object(subject.os, "name", "posix"):
            subject._private(self.directory)
        self.assertEqual((self.directory.stat().st_mode & 0o777), 0o700)


if __name__ == "__main__":
    unittest.main()
