import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ops.installer import launcher_bridge

SPEC = importlib.util.spec_from_file_location(
    'clawchat_bundle_check', Path(__file__).parents[1] / 'installer/clawchat-bundle-check.py')
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class ClawchatBundleTests(unittest.TestCase):
    def test_bundled_liveware_precedes_host_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = launcher_bridge.env_for(root, root / 'hermes', root / 'tavern')
            self.assertEqual(env['PATH'].split(__import__('os').pathsep)[0], str(root / 'hermes/clawchat/liveware'))

    def test_missing_plugin_is_actionable_and_never_downloads(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(launcher_bridge, 'run_stream') as run:
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
                launcher_bridge.require_bundled_clawchat(Path(tmp))
            run.assert_not_called()
            self.assertIn('新版完整安装包', json.loads(output.getvalue())['message'])

    def test_probe_rejects_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, 'Missing'):
                CHECK.check_files(Path(tmp), {'files': {'plugins/clawchat/plugin.yaml': 'a'}})

    def test_probe_rejects_modified_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / 'file').write_text('changed')
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                CHECK.check_files(Path(tmp), {'files': {'file': 'a'}})

    def test_probe_rejects_path_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, 'unsafe'):
                CHECK.check_files(Path(tmp), {'files': {'../secret': 'a'}})

    def test_probe_requires_core_files_even_with_empty_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, 'required'):
                CHECK.check_files(Path(tmp), {'files': {}, 'liveware': {'path': 'clawchat/liveware/liveware'}})


if __name__ == '__main__':
    unittest.main()
