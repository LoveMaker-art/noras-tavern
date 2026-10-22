import importlib.util
import io
from pathlib import Path
import subprocess
import json
import time
import os
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SKILL_ROOT = ROOT / "nora/skills" if (ROOT / "nora/skills/system/tavern-updater/scripts/update.py").is_file() else ROOT / "ops/skills"
SPEC = importlib.util.spec_from_file_location(
    "updater_skill_environment",
    SKILL_ROOT / "system/tavern-updater/scripts/update.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class UpdaterSkillEnvironmentTests(unittest.TestCase):
    def test_desktop_check_returns_its_result_without_submitting_or_polling_an_update(self):
        reply = {'scope': 'desktop', 'action': 'check', 'status': 'succeeded', 'settled': True,
                 'result': {'current': '2.5.6', 'latest': 'v2.5.7', 'launcherLatest': '2.2.7'}}
        with tempfile.TemporaryDirectory() as directory:
            home, _ = self.managed(directory)
            with patch.dict(os.environ, {'HERMES_HOME': str(home)}), patch.object(sys, 'argv', ['update.py', '--check']), \
                    patch.object(MODULE, 'select_python', return_value=os.path.abspath(sys.executable)), \
                    patch.object(MODULE, 'desktop_transport', return_value=reply) as desktop, \
                    patch.object(MODULE, 'standalone_entry') as core, patch.object(MODULE, 'task_status') as status, \
                    patch('builtins.print') as output:
                MODULE.main()
            desktop.assert_called_once_with(home, 'check', confirm=False)
            core.assert_not_called()
            status.assert_not_called()
            self.assertEqual(json.loads(output.call_args.args[0]), reply)

    def test_desktop_update_submits_once_without_falling_back_to_core_only(self):
        with tempfile.TemporaryDirectory() as directory:
            home, _ = self.managed(directory)
            with patch.dict(os.environ, {'HERMES_HOME': str(home)}), patch.object(sys, 'argv', ['update.py', '--apply', '--confirm']), \
                    patch.object(MODULE, 'select_python', return_value=os.path.abspath(sys.executable)), \
                    patch.object(MODULE, 'desktop_transport', return_value={'scope': 'desktop', 'status': 'queued', 'requestId': 'same-request'}) as desktop, \
                    patch.object(MODULE, 'standalone_entry') as core, patch('builtins.print') as output:
                MODULE.main()
            desktop.assert_called_once_with(home, 'update', confirm=True)
            core.assert_not_called()
            self.assertEqual(json.loads(output.call_args.args[0])['status'], 'queued')

    def test_synchronous_desktop_check_allows_the_reader_budget_without_extending_submission_wait(self):
        for action, limit in [('check', 120), ('update', 45)]:
            with self.subTest(action=action), tempfile.TemporaryDirectory() as directory:
                home, _ = self.managed(directory)
                root = Path(directory).resolve()
                (root / 'installer/launcher-control.json').write_text('{}')
                node = home / 'node/bin/node'
                node.parent.mkdir(parents=True)
                node.write_text('selection fixture')
                entry = root / 'verified-reader.js'
                reply = {'scope': 'desktop', 'status': 'succeeded' if action == 'check' else 'queued'}
                replies = [subprocess.CompletedProcess([], 0, '{"desktopProtocol":"nora-desktop-update/1"}', ''),
                           subprocess.CompletedProcess([], 0, json.dumps(reply), '')]
                with patch.object(MODULE, 'query_entries', return_value=iter([entry])), \
                        patch.object(MODULE.subprocess, 'run', side_effect=replies) as run:
                    self.assertEqual(MODULE.desktop_transport(home, action, action == 'update'), reply)
                self.assertEqual(run.call_args.kwargs['timeout'], limit)
                if action == 'check':
                    self.assertGreater(run.call_args.kwargs['timeout'], 100,
                                       'the reader has a 100-second metadata budget')

    def test_old_reader_is_probed_before_any_desktop_update_submission(self):
        with tempfile.TemporaryDirectory() as directory:
            home, _ = self.managed(directory)
            root = Path(directory).resolve()
            (root / 'installer/launcher-control.json').write_text('{}')
            node = home / 'node/bin/node'
            node.parent.mkdir(parents=True)
            node.write_text('selection fixture')
            entry = root / 'verified-reader.js'
            with patch.object(MODULE, 'query_entries', return_value=iter([entry])), \
                    patch.object(MODULE.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '{"desktopProtocol":null}', '')) as run:
                with self.assertRaisesRegex(RuntimeError, '旧更新器'):
                    MODULE.desktop_transport(home, 'update', True)
            self.assertEqual(run.call_count, 1)
            self.assertIn('-e', run.call_args.args[0], 'an unsupported old reader must never receive action=update')

    def test_desktop_status_uses_existing_result_without_hermes_probe(self):
        reply = {'scope': 'desktop', 'status': 'succeeded', 'settled': True, 'busy': False,
                 'result': {'version': '2.5.6', 'launcherVersion': '2.2.6', 'updateComplete': True}}
        with patch.object(sys, 'argv', ['update.py', '--status']), \
                patch.object(MODULE, 'desktop_transport', return_value=reply), \
                patch.object(MODULE, 'select_python') as select, patch('builtins.print') as output:
            MODULE.main()
        select.assert_not_called()
        self.assertEqual(json.loads(output.call_args.args[0]), reply)

    def test_supported_desktop_reader_failure_is_not_reported_as_an_old_version(self):
        with tempfile.TemporaryDirectory() as directory:
            home, _ = self.managed(directory)
            root = Path(directory).resolve()
            (root / 'installer/launcher-control.json').write_text('{}')
            node = home / 'node/bin/node'
            node.parent.mkdir(parents=True)
            node.write_text('selection fixture')
            entry = root / 'verified-reader.js'
            replies = [subprocess.CompletedProcess([], 0, '{"desktopProtocol":"nora-desktop-update/1"}', ''),
                       subprocess.CompletedProcess([], 1, '', json.dumps({'event': 'error', 'code': 'QUERY_FAILED', 'message': '真实查询失败'}))]
            with patch.object(MODULE, 'query_entries', return_value=iter([entry])), \
                    patch.object(MODULE.subprocess, 'run', side_effect=replies):
                reply = MODULE.desktop_transport(home, 'status')
            self.assertEqual(reply['code'], 'QUERY_FAILED')
            self.assertEqual(reply['error'], '真实查询失败')
            self.assertFalse(reply['settled'])

    def test_status_json_preserves_unicode_on_a_legacy_windows_pipe(self):
        reply = {'status': 'succeeded', 'message': '更新成功，用户数据已保留'}
        raw = io.BytesIO()
        output = io.TextIOWrapper(raw, encoding='cp1252')
        with patch.object(sys, 'argv', ['update.py', '--status']), \
                patch.object(MODULE, 'task_status', return_value=reply), patch.object(sys, 'stdout', output):
            MODULE.main()
            output.flush()
        self.assertEqual(json.loads(raw.getvalue().decode('ascii')), reply)

    def test_cli_error_json_survives_isolated_legacy_encoding_without_hiding_the_reason(self):
        program = ('import sys,runpy;sys.stdout.reconfigure(encoding="cp1252");'
                   'sys.argv=[' + repr(str(Path(SPEC.origin))) + ',"--apply"];'
                   'runpy.run_path(sys.argv[0],run_name="__main__")')
        result = subprocess.run([sys.executable, '-I', '-S', '-c', program],
                                capture_output=True, encoding='utf-8', timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn('授权', json.loads(result.stdout)['error'])
        self.assertNotIn('UnicodeEncodeError', result.stderr)

    def test_plain_python_skill_does_not_write_cache_into_authenticated_ops(self):
        with tempfile.TemporaryDirectory(prefix='nora plain skill ') as directory:
            root = Path(directory).resolve()
            updater = root / 'apps/tavern-ops/updater'
            updater.mkdir(parents=True)
            (updater / 'bootstrap.py').write_text(
                'def resolve_update_target(home, managed_home=None):\n    return home, home\n')
            (updater / 'task.py').write_text('# transport endpoint\n')
            program = ('import runpy, pathlib; namespace=runpy.run_path(' + repr(str(Path(SPEC.origin))) + '); '
                'namespace["standalone_entry"](pathlib.Path(' + repr(str(root)) + ')); '
                'print(__import__("json").dumps([str(p) for p in pathlib.Path(' + repr(str(updater)) + ').rglob("*.pyc")]))')
            environment = {k: v for k, v in os.environ.items() if k != 'PYTHONDONTWRITEBYTECODE'}
            environment['TAVERN_DATA_ROOT'] = str(root)
            result = subprocess.run([sys.executable, '-c', program], env=environment,
                capture_output=True, text=True, timeout=15, check=True)
            self.assertEqual(json.loads(result.stdout), [], 'normal skill invocation must preserve the ops inventory')

    def test_installed_nora_update_does_not_require_a_launcher_endpoint(self):
        with tempfile.TemporaryDirectory(prefix='nora update without GUI ') as directory:
            root = Path(directory).resolve()
            home, _ = self.managed(directory)
            (root / 'installer/skill-update/endpoint.json').unlink()
            entry = root / 'tavern/apps/tavern-ops/updater/task.py'
            with patch.dict(os.environ, {'HERMES_HOME': str(home)}), \
                    patch.object(sys, 'argv', ['update.py', '--apply', '--confirm']), \
                    patch.object(MODULE, 'select_python', return_value=os.path.abspath(sys.executable)), \
                    patch.object(MODULE, 'standalone_entry', return_value=(entry, root / 'tavern')), \
                    patch.object(MODULE.subprocess, 'call', return_value=0) as invoke:
                with self.assertRaises(SystemExit) as result:
                    MODULE.main()
            self.assertEqual(result.exception.code, 0)
            self.assertEqual(invoke.call_count, 1, 'Nora must invoke the independent updater while GUI is closed')

    def test_managed_installation_does_not_fall_back_to_system(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "nora-instance.json").touch()
            self.assertEqual(list(MODULE.candidates(home)), [
                home / "hermes-agent/venv/Scripts/python.exe",
                home / "hermes-agent/venv/bin/python3",
                home / "hermes-agent/venv/bin/python",
            ])

    def test_skips_interpreter_without_dependencies(self):
        results = [subprocess.CompletedProcess([], 1, "", "ModuleNotFoundError: yaml"),
                   subprocess.CompletedProcess([], 0, "", "")]
        with patch.object(MODULE, "candidates", return_value=iter([
            Path("/system/python3"), Path("/hermes/venv/bin/python3"),
        ])), patch.object(Path, "is_file", return_value=True), patch.object(
            MODULE.subprocess, "run", side_effect=results,
        ):
            self.assertEqual(MODULE.select_python(Path("/home")), str(Path("/hermes/venv/bin/python3").absolute()))

    def test_space_path_stays_one_argument(self):
        candidate = Path("/home/my hermes/venv/bin/python3").absolute()
        with patch.object(MODULE, "candidates", return_value=iter([candidate])), patch.object(
            Path, "is_file", return_value=True,
        ), patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(MODULE.select_python(Path("/home")), str(candidate))
            self.assertEqual(run.call_args.args[0][0], str(candidate))

    def test_missing_dependencies_fail_with_path_and_reason(self):
        with patch.object(MODULE, "candidates", return_value=iter([Path("/system/python3")])), patch.object(
            Path, "is_file", return_value=True,
        ), patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess(
            [], 1, "", "ModuleNotFoundError: yaml",
        )):
            with self.assertRaisesRegex(SystemExit, "ModuleNotFoundError: yaml"):
                MODULE.select_python(Path("/home"))

    def test_probe_timeout_is_bounded_and_reported(self):
        with patch.object(MODULE, "candidates", return_value=iter([Path("/stuck/python3")])), patch.object(
            Path, "is_file", return_value=True,
        ), patch.object(MODULE.subprocess, "run", side_effect=subprocess.TimeoutExpired("python", 10)):
            with self.assertRaisesRegex(SystemExit, "TimeoutExpired"):
                MODULE.select_python(Path("/home"))

    def managed(self, directory):
        root = Path(directory).resolve()
        home = root / 'hermes'
        home.mkdir()
        (home / 'nora-instance.json').write_text(json.dumps({
            'schema': 1, 'noraHome': str(root), 'hermesHome': str(home), 'installRoot': str(root / 'tavern')}))
        target = root / 'installer/skill-update'
        target.mkdir(parents=True)
        (target / 'endpoint.json').write_text(json.dumps({
            'schema': 1, 'session': 'current', 'noraHome': str(root), 'updatedAt': int(time.time() * 1000)}))
        return home, target

    def test_wrong_managed_target_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            home, _ = self.managed(directory)
            instance = json.loads((home / 'nora-instance.json').read_text())
            instance['installRoot'] = str(home / 'wrong')
            (home / 'nora-instance.json').write_text(json.dumps(instance))
            with self.assertRaisesRegex(RuntimeError, 'Conflicting'):
                MODULE.managed_root(home)

    def test_status_calls_shared_query_without_a_gui_receiver_or_hermes_python(self):
        with tempfile.TemporaryDirectory() as directory:
            home, legacy = self.managed(directory)
            (legacy / 'endpoint.json').unlink()
            root = Path(directory).resolve()
            job_id = '6f110f8b-7671-4840-b7b3-740a42d2d923'
            operation_id = 'f94fe932-d9a1-47d9-88cc-44aac4137062'
            job = root / 'installer/update-jobs' / job_id
            job.mkdir(parents=True)
            (job / 'operation-ref.json').write_text(json.dumps({'operationId': operation_id}))
            operation = root / 'installer/operations' / operation_id
            operation.mkdir(parents=True)
            expected = {'state': 'succeeded', 'result': {'version': '2.5.2'}}
            (operation / 'operation.json').write_text(json.dumps(expected))
            entry = job / 'runner/ops/installer/desktop/updater-task.js'
            entry.parent.mkdir(parents=True); entry.write_text('// fixed query entry')
            node = root / 'node'; node.write_text('test Node selection')
            reply = {'status':'succeeded','requestId':job_id,'settled':True,'busy':False,'operation':expected}
            with patch.dict(os.environ, {'TAVERN_NODE_EXECUTABLE':str(node)}), \
                    patch.object(MODULE, 'select_python', side_effect=AssertionError('no Hermes Python probe')), \
                    patch.object(MODULE, 'query_entries', return_value=[entry]), \
                    patch.object(MODULE.subprocess, 'run', return_value=subprocess.CompletedProcess([],0,json.dumps(reply),'')) as query:
                actual = MODULE.task_status(home)
            self.assertEqual(actual['requestId'], job_id)
            self.assertEqual(actual['operation'], expected)
            self.assertEqual(query.call_args.args[0], [str(node),str(entry)])
            self.assertEqual(query.call_args.kwargs['encoding'], 'utf-8')
            self.assertEqual(json.loads(query.call_args.kwargs['input']), {'action':'status','noraHome':str(root)})
            self.assertFalse((legacy / 'request.json').exists())
            for old_reply in ({'status':'succeeded','requestId':job_id,'operation':expected},
                              {'status':'failed','requestId':job_id,'settled':False,'busy':True,'operation':expected}):
                with patch.dict(os.environ, {'TAVERN_NODE_EXECUTABLE':str(node)}), \
                        patch.object(MODULE, 'query_entries', return_value=[entry]), \
                        patch.object(MODULE.subprocess, 'run', return_value=subprocess.CompletedProcess([],0,json.dumps(old_reply),'')):
                    self.assertEqual(MODULE.task_status(home)['status'],'inspection-required')

    def test_status_delegates_job_discovery_to_the_shared_reader(self):
        with tempfile.TemporaryDirectory() as directory:
            home, _ = self.managed(directory)
            root = Path(directory).resolve()
            entry = root / 'tavern/apps/tavern-ops/installer/desktop/updater-task.js'
            entry.parent.mkdir(parents=True); entry.write_text('// selected trusted reader')
            node = root / 'node'; node.write_text('test Node selection')
            reply = {'status': 'none', 'settled': True, 'busy': False}
            with patch.dict(os.environ, {'TAVERN_NODE_EXECUTABLE': str(node)}), \
                    patch.object(MODULE, 'query_entries', return_value=[entry]), \
                    patch.object(MODULE.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(reply), '')) as query:
                self.assertEqual(MODULE.task_status(home), reply)
            query.assert_called_once()
            self.assertEqual(json.loads(query.call_args.kwargs['input']), {'action': 'status', 'noraHome': str(root)})

    def test_query_discovery_compares_absolute_path_identity_not_alias_spelling(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            job = root / 'installer/update-jobs/6f110f8b-7671-4840-b7b3-740a42d2d923'
            snapshot = job / 'runner/ops'
            desktop = snapshot / 'installer/desktop'
            desktop.mkdir(parents=True)
            artifacts = {}
            for name in ('updater-task.js', 'updater-capability.js'):
                file = desktop / name
                file.write_bytes(b'// bootstrap bytes\n')
                artifacts['ops/installer/desktop/' + name] = MODULE.hashlib.sha256(file.read_bytes()).hexdigest()
            manifest = job / 'runner/release-manifest.json'
            manifest.write_text(json.dumps({'schema': 'tavern-release/v2', 'artifacts': artifacts}))
            record = {'noraHome': str(root), 'hermesHome': str(root), 'opsRoot': str(snapshot),
                      'installRoot': str(root / 'tavern'),
                      'sourceManifest': {'path': str(manifest), 'sha256': MODULE.hashlib.sha256(manifest.read_bytes()).hexdigest()}}
            receipt = job / 'updater-control.json'
            expected = [desktop / 'updater-task.js']
            receipt.write_text(json.dumps(record))
            self.assertEqual(list(MODULE.query_entries(root, root)), expected)
            for field in ('noraHome', 'hermesHome', 'opsRoot', 'sourceManifest'):
                with self.subTest(field=field):
                    changed = json.loads(json.dumps(record))
                    value = record[field]['path'] if field == 'sourceManifest' else record[field]
                    target = Path(value)
                    alias = str(target.parent) + os.sep + '.' + os.sep + target.name
                    if field == 'sourceManifest':
                        changed[field]['path'] = alias
                    else:
                        changed[field] = alias
                    receipt.write_text(json.dumps(changed))
                    self.assertEqual(list(MODULE.query_entries(root, root)), expected)
                    # Canonicalization must not accept a different or relative target.
                    for wrong in (str(root / 'foreign'), target.name):
                        if field == 'sourceManifest':
                            changed[field]['path'] = wrong
                        else:
                            changed[field] = wrong
                        receipt.write_text(json.dumps(changed))
                        self.assertEqual(list(MODULE.query_entries(root, root)), [])

    def test_standalone_calls_shared_task_with_verified_paths(self):
        with tempfile.TemporaryDirectory(prefix='nora 中文 ') as directory:
            root = Path(directory).resolve()
            home = root / 'home'
            home.mkdir()
            entry = root / 'tavern/apps/tavern-ops/updater/task.py'
            with patch.dict(os.environ, {'HERMES_HOME': str(home)}), \
                    patch.object(sys, 'argv', ['update.py', '--apply', '--confirm']), \
                    patch.object(MODULE, 'select_python', return_value=os.path.abspath(sys.executable)), \
                    patch.object(MODULE, 'standalone_entry', return_value=(entry, root / 'tavern')), \
                    patch.object(MODULE.subprocess, 'call', return_value=0) as call:
                with self.assertRaises(SystemExit) as result:
                    MODULE.main()
            self.assertEqual(result.exception.code, 0)
            self.assertEqual(call.call_args.args[0], [os.path.abspath(sys.executable), '-u', '-B', str(entry),
                '--hermes-home', str(home), '--install-root', str(root / 'tavern'), '--apply', '--confirm'])
            self.assertEqual(call.call_args.kwargs['env']['TAVERN_DATA_ROOT'], str(root / 'tavern'))

    def test_update_requires_confirmation_before_probe_or_execution(self):
        with patch.object(sys, 'argv', ['update.py', '--apply']), patch.object(MODULE, 'select_python') as probe:
            with self.assertRaisesRegex(RuntimeError, '授权'):
                MODULE.main()
            probe.assert_not_called()

    def test_empty_probe_error_is_reported_without_index_error(self):
        with patch.object(MODULE, 'candidates', return_value=iter([Path('/broken/python')])), \
                patch.object(Path, 'is_file', return_value=True), \
                patch.object(MODULE.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', '')):
            with self.assertRaisesRegex(SystemExit, 'exit 1'):
                MODULE.select_python(Path('/home'))

    def test_status_survives_a_broken_hermes_interpreter(self):
        with tempfile.TemporaryDirectory() as directory:
            home, _ = self.managed(directory)
            root = Path(directory).resolve()
            node = root / 'node'; node.write_text('test Node selection')
            entry = root / 'trusted-reader.js'; entry.write_text('// manifest-verified fixture')
            reply = {'status': 'error', 'settled': True, 'busy': False, 'error': 'test failure'}
            with patch.dict(os.environ, {'HERMES_HOME': str(home), 'TAVERN_NODE_EXECUTABLE': str(node)}), \
                    patch.object(sys, 'argv', ['update.py', '--status']), \
                    patch.object(MODULE, 'select_python', side_effect=AssertionError('no interpreter needed')), \
                    patch.object(MODULE, 'query_entries', return_value=[entry]), \
                    patch.object(MODULE.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, json.dumps(reply), '')), \
                    patch('builtins.print') as output:
                with self.assertRaises(SystemExit) as result:
                    MODULE.main()
            self.assertEqual(result.exception.code, 1)
            self.assertEqual(json.loads(output.call_args.args[0])['error'], 'test failure')


if __name__ == "__main__":
    unittest.main()
