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


class UpdaterSkillCliRoutingTests(unittest.TestCase):
    def installation(self):
        temporary = tempfile.TemporaryDirectory(prefix='nora skill core routing ')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        home, install = root / 'hermes', root / 'tavern'
        home.mkdir()
        (home / 'config.yaml').write_text('{}\n')
        (home / 'nora-instance.json').write_text(json.dumps({
            'schema': 1, 'noraHome': str(root), 'hermesHome': str(home),
            'installRoot': str(install), 'port': 18899}))
        (root / 'installer').mkdir()
        (root / 'installer/launcher-control.json').write_text('{}')
        # The interpreter and installed updater are process boundaries. Tiny
        # offline endpoints exercise the real CLI dispatch and instance checks;
        # they do not claim a full Hermes installation or update acceptance.
        hermes_code = root / 'hermes-code'
        (hermes_code / 'hermes_cli').mkdir(parents=True)
        (hermes_code / 'hermes_cli/__init__.py').write_text('')
        (hermes_code / 'hermes_constants.py').write_text(
            'import os\nfrom pathlib import Path\ndef get_hermes_home():\n    return Path(os.environ["HERMES_HOME"])\n')
        ops = install / 'apps/tavern-ops'
        updater, desktop = ops / 'updater', ops / 'installer/desktop'
        updater.mkdir(parents=True)
        desktop.mkdir(parents=True)
        (updater / 'bootstrap.py').write_text(
            'from pathlib import Path\ndef resolve_update_target(home, managed_home=None):\n'
            '    assert home == Path(' + repr(str(home)) + ')\n'
            '    assert managed_home == Path(' + repr(str(root)) + ')\n'
            '    return home, Path(' + repr(str(install)) + ')\n')
        (updater / 'task.py').write_text(
            'import json,sys\nreply={"scope":"core","argv":sys.argv[1:]}\n'
            'reply.update({"state":"available","latest":"v2.6.0"} if "--check" in sys.argv else '
            '{"status":"submitting","requestId":"core-request"})\nprint(json.dumps(reply))\n')
        probe_log = root / 'desktop-probes.jsonl'
        (desktop / 'updater-task.js').write_text(
            'const fs=require("node:fs");const log=' + json.dumps(str(probe_log)) + ';\n'
            'module.exports.desktopProtocol="nora-desktop-update/1";\n'
            'if(require.main!==module)fs.appendFileSync(log,"desktop protocol probe\\n");\n'
            'else {let input="";process.stdin.on("data",data=>input+=data);process.stdin.on("end",()=>{\n'
            'const request=JSON.parse(input);if(request.scope==="desktop"){fs.appendFileSync(log,input+"\\n");\n'
            'const old=' + json.dumps(str(root / 'legacy-status.json')) + ';console.log(fs.existsSync(old)?'
            'fs.readFileSync(old,"utf8"):JSON.stringify({scope:"desktop",status:"error",error:"APP lookup must not run"}));}\n'
            'else console.log(fs.readFileSync(' + json.dumps(str(root / 'core-status.json')) + ',"utf8"));});}\n')
        (root / 'core-status.json').write_text(json.dumps({'status': 'none', 'settled': True, 'busy': False}))
        (desktop / 'updater-capability.js').write_text('// authenticated fixture reader companion\n')
        artifacts = {'ops/installer/desktop/' + name: MODULE.hashlib.sha256((desktop / name).read_bytes()).hexdigest()
                     for name in ('updater-task.js', 'updater-capability.js')}
        receipts = install / 'tavern-updates'
        receipts.mkdir()
        (receipts / 'installed-manifest.json').write_text(json.dumps({
            'schema': 'tavern-release/v2', 'commit': 'a' * 40, 'versions': {'tavern': '2.5.7'}, 'artifacts': artifacts}))
        (receipts / 'installed.json').write_text(json.dumps({'version': '2.5.7', 'commit': 'a' * 40}))
        environment = {key: value for key, value in os.environ.items()
                       if key not in ('HERMES_HOME', 'NORA_TAVERN_HOME', 'NORA_HERMES_HOME',
                                      'TAVERN_DATA_ROOT', 'HERMES_INSTALL_DIR', 'NORA_PYTHON')}
        environment.update(HERMES_HOME=str(home), HERMES_INSTALL_DIR=str(hermes_code),
                           NORA_PYTHON=sys.executable, PYTHONPATH=str(hermes_code),
                           TAVERN_NODE_EXECUTABLE=os.environ['NORA_TEST_NODE'], PYTHONDONTWRITEBYTECODE='1')
        return root, home, install, probe_log, environment

    def test_desktop_nora_apply_submits_only_the_independent_core_task(self):
        root, home, install, probe_log, environment = self.installation()
        before = (home / 'config.yaml').read_bytes()
        result = subprocess.run([sys.executable, '-B', str(SPEC.origin), '--apply', '--confirm'],
                                env=environment, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        reply = json.loads(result.stdout)
        self.assertEqual(reply['scope'], 'core')
        self.assertEqual(reply['requestId'], 'core-request')
        self.assertEqual(reply['argv'], ['--hermes-home', str(home), '--install-root', str(install), '--apply', '--confirm'])
        self.assertFalse(probe_log.exists(), 'Nora must not query or submit to the APP receiver')
        self.assertEqual((home / 'config.yaml').read_bytes(), before)

    def test_desktop_nora_check_returns_core_metadata_without_an_app_query(self):
        root, home, install, probe_log, environment = self.installation()
        result = subprocess.run([sys.executable, '-B', str(SPEC.origin), '--check'],
                                env=environment, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        reply = json.loads(result.stdout)
        self.assertEqual(reply['scope'], 'core')
        self.assertEqual(reply['state'], 'available')
        self.assertEqual(reply['latest'], 'v2.6.0')
        self.assertEqual(reply['argv'], ['--hermes-home', str(home), '--install-root', str(install), '--check'])
        self.assertFalse(probe_log.exists(), 'APP lookup must not delay or reject the independent core check')

    def test_status_prefers_the_core_task_without_loading_the_app_reader(self):
        for state, settled, busy, code in [('succeeded', True, False, 0), ('failed', True, False, 1),
                                           ('recovering', False, True, 0), ('inspection-required', False, None, 1)]:
            with self.subTest(state=state):
                root, home, install, probe_log, environment = self.installation()
                reply = {'status': state, 'requestId': 'core-request', 'settled': settled, 'busy': busy,
                         'operation': {'kind': 'update', 'state': state}}
                (root / 'core-status.json').write_text(json.dumps(reply))
                # Task reads must still work if the Hermes probe can no longer run.
                environment['NORA_PYTHON'] = str(root / 'missing-python')
                result = subprocess.run([sys.executable, '-B', str(SPEC.origin), '--status'],
                                        env=environment, capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, code, result.stdout + result.stderr)
                self.assertEqual(json.loads(result.stdout), reply)
                self.assertFalse(probe_log.exists(), 'Historical APP state cannot mask an independent core task')

    def test_status_reads_legacy_desktop_history_only_when_the_core_reader_confirms_no_task(self):
        root, home, install, probe_log, environment = self.installation()
        reply = {'scope': 'desktop', 'status': 'partial', 'settled': True, 'busy': False,
                 'result': {'version': '2.5.7', 'launcherVersion': '2.2.6', 'updateComplete': False}}
        (root / 'legacy-status.json').write_text(json.dumps(reply))
        environment['NORA_PYTHON'] = str(root / 'missing-python')
        result = subprocess.run([sys.executable, '-B', str(SPEC.origin), '--status'],
                                env=environment, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout), reply)
        requests = [json.loads(line) for line in probe_log.read_text().splitlines() if line.startswith('{')]
        self.assertEqual(requests, [{'scope': 'desktop', 'action': 'status', 'confirm': False, 'noraHome': str(root)}])
        self.assertFalse((root / 'installer/skill-update/request.json').exists())


class UpdaterSkillEnvironmentTests(unittest.TestCase):
    def test_legacy_desktop_transport_cannot_check_or_submit_updates(self):
        for action, confirm in [('check', False), ('update', True), ('status', True)]:
            with self.subTest(action=action, confirm=confirm), patch.object(MODULE.subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, '仅供查询'):
                    MODULE.desktop_transport(Path('/unused'), action, confirm)
                run.assert_not_called()

    def test_old_reader_is_probed_before_a_legacy_desktop_status_request(self):
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
                    MODULE.desktop_transport(home, 'status')
            self.assertEqual(run.call_count, 1)
            self.assertIn('-e', run.call_args.args[0], 'an unsupported old reader must never receive a request')

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

    def test_corrupt_instance_cannot_select_another_interpreter(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "nora-instance.json").touch()
            with self.assertRaises(ValueError):
                list(MODULE.candidates(home))

    def test_discovery_without_yaml_can_find_an_explicit_candidate_but_never_skips_its_probe(self):
        def binding(home,*,query=False):
            if not query:raise ModuleNotFoundError("No module named 'yaml'",name='yaml')
            return {'desktopManaged':False}
        with patch.object(MODULE,'instance_paths',side_effect=binding), \
                patch.dict(os.environ,{'NORA_PYTHON':'/explicit/hermes/python'}):
            self.assertEqual(next(MODULE.candidates(Path('/home'))),Path('/explicit/hermes/python'))
        with patch.object(MODULE,'candidates',return_value=iter([Path('/explicit/hermes/python')])), \
                patch.object(Path,'is_file',return_value=True), \
                patch.object(MODULE.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'','wrong Hermes instance')) as run:
            with self.assertRaisesRegex(SystemExit,'wrong Hermes instance'):
                MODULE.select_python(Path('/home'))
            self.assertIn('verify_hermes_python',run.call_args.args[0][3])

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
            'schema': 1, 'noraHome': str(root), 'hermesHome': str(home), 'installRoot': str(root / 'tavern'), 'port': 18899}))
        target = root / 'installer/skill-update'
        target.mkdir(parents=True)
        (target / 'endpoint.json').write_text(json.dumps({
            'schema': 1, 'session': 'current', 'noraHome': str(root), 'updatedAt': int(time.time() * 1000)}))
        return home, target

    def test_wrong_managed_target_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            home, _ = self.managed(directory)
            instance = json.loads((home / 'nora-instance.json').read_text())
            instance['hermesHome'] = str(home / 'wrong')
            (home / 'nora-instance.json').write_text(json.dumps(instance))
            with self.assertRaisesRegex(RuntimeError, 'Invalid Nora instance'):
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
