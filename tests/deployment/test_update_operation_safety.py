"""Public updater entry and dependency checks, without real network/runtime."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from ops.updater import update


class UpdateOperationSafetyTests(unittest.TestCase):
    def test_actual_cli_requires_live_operation_before_install_is_called(self):
        with patch.object(sys, 'argv', ['update.py', 'install', '--release-dir', '/fixture',
                '--manifest-sha256', 'a' * 64, '--confirm']), patch.object(update, 'install') as install:
            with self.assertRaises(RuntimeError) as caught:
                update.main()
            self.assertEqual(caught.exception.code, 'OPERATION_CAPABILITY_REQUIRED')
            install.assert_not_called()

    def test_python_maintenance_uses_managed_channel(self):
        with patch.object(update, '_operation_control', create=True) as control, patch.object(update.subprocess, 'run') as naked:
            control.managed_run.return_value = subprocess.CompletedProcess([sys.executable], 0, 'verified', '')
            result = update.run([sys.executable, '-B', '/fixture/check.py'], capture=True, timeout=4)
            self.assertEqual(result.stdout, 'verified')
            self.assertEqual(control.managed_run.call_args.args[0], [sys.executable, '-B', '/fixture/check.py'])
            naked.assert_not_called()

    def test_runtime_dependency_gap_never_runs_npm(self):
        with tempfile.TemporaryDirectory(prefix='nora-update-deps-') as temporary:
            root=Path(temporary);current=root/'current';target=root/'prepared'
            for directory in (current,target):
                directory.mkdir();(directory/'package-lock.json').write_text('{}')
            with patch.object(update,'run') as command:
                with self.assertRaises(RuntimeError) as raised:
                    update.reuse_dependencies(target,current,'package-lock.json',('missing/package.json',))
                self.assertEqual(raised.exception.code,'RESOURCE_INCOMPLETE')
                command.assert_not_called()

    def test_bundled_dependency_flag_is_not_proof_of_complete_dependencies(self):
        with tempfile.TemporaryDirectory(prefix='nora-update-bundle-deps-') as temporary:
            source=Path(temporary);engine=source/'app/engine/sillytavern';engine.mkdir(parents=True)
            (engine/'package.json').write_text(json.dumps({'dependencies':{'missing':'1.0.0'}}))
            with self.assertRaises(RuntimeError) as raised:
                update.prepare_dependencies(source,source/'old',source/'old-mcp',app_changed=True,mcp_changed=False,bundled=True)
            self.assertEqual(raised.exception.code,'RESOURCE_INCOMPLETE')


if __name__ == '__main__': unittest.main()
