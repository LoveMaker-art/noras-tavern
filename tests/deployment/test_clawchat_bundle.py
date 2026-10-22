import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from ops.installer import launcher_bridge

SPEC = importlib.util.spec_from_file_location(
    'clawchat_bundle_check', Path(__file__).parents[1] / 'installer/clawchat-bundle-check.py')
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class ClawchatBundleTests(unittest.TestCase):
    def test_windows_terminal_must_be_sealed_before_backend_is_imported(self):
        for metadata in ({'files': {}}, {'terminal': {'kind': 'git-bash',
                'command': 'hermes-agent/vendor/git/bin/bash.exe'}, 'files': {}}):
            with self.subTest(metadata=metadata), self.assertRaisesRegex(RuntimeError, 'Git Bash'):
                CHECK.check_terminal(Path('/fixture'), metadata)

    def test_windows_gateway_receives_owned_bash_without_overwriting_old_host_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / 'hermes'
            bash = home / 'hermes-agent/vendor/git/bin/bash.exe'
            with patch.object(launcher_bridge, 'os', types.SimpleNamespace(
                    name='nt', pathsep=';', environ={'PATH': '', 'HERMES_GIT_BASH_PATH': 'host-bash'})):
                self.assertEqual(launcher_bridge.env_for(root, home, root / 'tavern')['HERMES_GIT_BASH_PATH'], 'host-bash')
                bash.parent.mkdir(parents=True)
                bash.write_bytes(b'fixture')
                self.assertEqual(launcher_bridge.env_for(root, home, root / 'tavern')['HERMES_GIT_BASH_PATH'], str(bash))

    def test_bundled_liveware_precedes_host_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = launcher_bridge.env_for(root, root / 'hermes', root / 'tavern')
            self.assertEqual(env['PATH'].split(__import__('os').pathsep)[0], str(root / 'hermes/clawchat/liveware'))

    def test_missing_plugin_is_actionable_and_never_downloads(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(launcher_bridge, 'run_stream') as run:
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as stopped:
                launcher_bridge.require_bundled_clawchat(Path(tmp))
            run.assert_not_called()
            self.assertEqual(stopped.exception.code, 1)
            events = [json.loads(line) for line in output.getvalue().splitlines() if line]
            self.assertEqual([event['event'] for event in events], ['diagnostic', 'error'])
            self.assertEqual(events[0]['component'], 'bridge')
            self.assertEqual(events[0]['error']['name'], 'RuntimeError')
            self.assertIn('新版完整安装包', events[-1]['message'])
            self.assertEqual(list(Path(tmp).iterdir()), [])

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
