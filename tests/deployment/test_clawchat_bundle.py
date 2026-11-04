import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import sys
import types
import unittest
from unittest.mock import patch

from ops.installer import launcher_bridge

SPEC = importlib.util.spec_from_file_location(
    'clawchat_bundle_check', Path(__file__).parents[1] / 'installer/clawchat-bundle-check.py')
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class ClawchatBundleTests(unittest.TestCase):
    def _run_probe_with_isolated_components(self, failure_step=None):
        """Exercise the real probe ordering without loading Hermes or running binaries."""
        class Progress(io.StringIO):
            flushes = 0

            def flush(self):
                self.flushes += 1
                super().flush()

        def check_step(step):
            if step == failure_step:
                raise RuntimeError('synthetic probe interruption')

        async def wait_ready():
            check_step('liveware_ready')

        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / 'nora-components.json').write_text(json.dumps({
                'liveware': {'path': 'clawchat/liveware/liveware'}, 'files': {}}))
            manager = types.SimpleNamespace(
                discover_and_load=lambda: check_step('plugin_discovery'),
                list_plugins=lambda: [{'name': 'clawchat', 'enabled': True, 'error': None,
                                       'tools': 1, 'hooks': 1, 'version': 'fixture'}])
            modules = {
                'hermes_cli': types.ModuleType('hermes_cli'),
                'hermes_cli.plugins_cmd': types.SimpleNamespace(
                    cmd_enable=lambda *args, **kwargs: check_step('plugin_enable')),
                'hermes_cli.plugins': types.SimpleNamespace(get_plugin_manager=lambda: manager),
                'clawchat_gateway': types.ModuleType('clawchat_gateway'),
                'clawchat_gateway.adapter': types.SimpleNamespace(ClawChatAdapter=object),
                'clawchat_gateway.liveware_cli': types.SimpleNamespace(
                    wait_liveware_cli_ready=wait_ready,
                    resolve_liveware_path=lambda: str(home / 'clawchat/liveware/liveware')),
            }
            # Keep the probe's platform branch isolated from the host's real sys module.
            isolated_sys = types.SimpleNamespace(platform='win32', path=[], addaudithook=lambda fn: None)
            stdout, stderr = io.StringIO(), Progress()
            isolated_sys.stderr = stderr
            with patch.dict(sys.modules, modules), patch.object(CHECK, 'sys', isolated_sys), \
                    patch.object(CHECK, 'check_files', side_effect=lambda *args: check_step('components_files')), \
                    patch.object(CHECK, 'check_terminal', side_effect=lambda *args: check_step('windows_terminal')), \
                    patch.object(CHECK.subprocess, 'run', side_effect=lambda *args, **kwargs:
                                 (check_step('liveware_help'), types.SimpleNamespace(returncode=0))[1]), \
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                if failure_step:
                    with self.assertRaisesRegex(RuntimeError, 'synthetic probe interruption'):
                        CHECK.check(home)
                else:
                    CHECK.check(home)
            return stdout.getvalue(), stderr.getvalue(), stderr.flushes, str(home)

    def test_probe_flushes_the_last_fixed_stage_before_an_interrupted_check(self):
        stages = ['components_files', 'liveware_help', 'windows_terminal', 'plugin_enable',
                  'plugin_discovery', 'adapter_import', 'liveware_ready']
        for failed in ['components_files', 'liveware_help', 'windows_terminal',
                       'plugin_discovery', 'liveware_ready']:
            with self.subTest(failed=failed):
                stdout, stderr, flushes, home = self._run_probe_with_isolated_components(failed)
                expected = [f'NORA_BUNDLE_STEP={step}' for step in stages[:stages.index(failed) + 1]]
                self.assertEqual(stderr.splitlines(), expected)
                self.assertEqual(flushes, len(expected))
                self.assertEqual(stdout, '')
                self.assertNotIn(home, stderr)

    def test_probe_progress_does_not_replace_the_final_result_or_disclose_runtime_paths(self):
        stdout, stderr, flushes, home = self._run_probe_with_isolated_components()
        stages = ['components_files', 'liveware_help', 'windows_terminal', 'plugin_enable',
                  'plugin_discovery', 'adapter_import', 'liveware_ready', 'liveware_resolve', 'complete']
        self.assertEqual(stderr.splitlines(), [f'NORA_BUNDLE_STEP={step}' for step in stages])
        self.assertEqual(flushes, len(stages))
        self.assertEqual(json.loads(stdout), {'ok': True, 'clawchat': 'fixture', 'liveware': 'ready',
                                             'tools': 1, 'hooks': 1})
        self.assertNotIn(home, stderr)

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
