"""No-APP lifecycle must use the real CLI, instance binding and shared writer."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

import yaml

from .launcher_test_environment import resolve_node

ROOT = Path(__file__).resolve().parents[2]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class CloudLifecycleCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nora-cloud-cli-')
        self.base = Path(self.temporary.name).resolve()
        self.home, self.root, self.state = [self.base / name for name in ('agent', 'programs', 'stories')]
        self.app = self.root / 'apps/tavern-runtime'
        self.app.mkdir(parents=True)
        self.home.mkdir()
        self.state.mkdir()
        contract = json.loads((ROOT / 'app/native-runtime.json').read_text())
        self.engine = self.app / contract['source_dir']
        self.engine.mkdir(parents=True)
        # A local HTTP fixture proves actual spawn/listener/ownership/stop.
        # Full engine and real user data are verified separately on Linux.
        (self.engine / 'server.js').write_text("""
const http=require('node:http');
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');
res.end(JSON.stringify({token:'fixture-token'}));}).listen(port,'127.0.0.1');
""", encoding='utf-8')
        shutil.copy2(ROOT / 'app/native_lifecycle.py', self.app)
        shutil.copy2(ROOT / 'app/native-runtime.json', self.app)
        operations = self.root / 'apps/tavern-ops'
        shutil.copytree(ROOT / 'ops/updater', operations / 'updater')
        (operations / 'installer').mkdir()
        for name in ('operation_cli.py', 'operation_control.py', 'error_diagnostics.py'):
            shutil.copy2(ROOT / 'ops/installer' / name, operations / 'installer' / name)
        (self.home / 'scripts').mkdir()
        self.entry = self.home / 'scripts/nora-instance.py'
        shutil.copy2(ROOT / 'ops/scripts/nora-instance.py', self.entry)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            self.port = listener.getsockname()[1]
        self.config = {'nora_tavern': {'installRoot': str(self.root),
            'stateRoot': str(self.state), 'appRoot': str(self.app), 'port': self.port}}
        self.save_config()
        (self.state / 'native-runtime').mkdir()
        (self.state / 'native-runtime/config.yaml').write_text('listen: false\n')
        self.story = self.state / 'chat.jsonl'
        self.story.write_text('{"text":"preserve original story"}\n', encoding='utf-8')
        self.before = {file: file.read_bytes() for file in
                       (self.home / 'config.yaml', self.state / 'native-runtime/config.yaml', self.story)}
        self.env = {name: value for name, value in os.environ.items()
                    if not name.startswith(('NORA_OPERATION_', 'TAVERN_', 'NORA_TAVERN_'))}
        self.env.update(HERMES_HOME=str(self.home), TAVERN_NODE_EXECUTABLE=resolve_node(required=True))
        self.addCleanup(self.cleanup_runtime)

    def save_config(self):
        (self.home / 'config.yaml').write_text(yaml.safe_dump(self.config), encoding='utf-8')

    def cleanup_runtime(self):
        module = load('cloud_cli_cleanup', self.app / 'native_lifecycle.py')
        runtime = module.NativeRuntime(self.root, self.app, self.state,
            module.RuntimeContract.from_dict(json.loads((self.app / 'native-runtime.json').read_text())))
        runtime.stop_run()
        self.temporary.cleanup()

    def command(self, action, *, env=None, direct=False, extra=()):
        command = [sys.executable, '-B', str(self.app / 'native_lifecycle.py' if direct else self.entry), action]
        environment = {**self.env, **(env or {})}
        if direct:
            environment.update(TAVERN_DATA_ROOT=str(self.root), TAVERN_APP_DIR=str(self.app),
                               TAVERN_STATE_DIR=str(self.state))
            environment.update(env or {})
        return subprocess.run([*command, *extra], env=environment, capture_output=True, text=True, timeout=30)

    def successful(self, action):
        result = self.command(action)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_bound_cloud_cli_starts_reuses_restarts_and_stops_without_an_app(self):
        started = self.successful('start')
        self.assertTrue(started['health']['ok'])
        self.assertEqual(self.successful('start')['native_pid'], started['native_pid'])
        restarted = self.command('restart', direct=True, extra=('--port', str(self.port)))
        self.assertEqual(restarted.returncode, 0, restarted.stderr)
        self.assertNotEqual(json.loads(restarted.stdout)['native_pid'], started['native_pid'])
        self.assertEqual(self.successful('stop')['stopped'], ['native'])
        self.assertFalse(self.successful('status')['processes']['native'])
        for file, original in self.before.items():
            self.assertEqual(file.read_bytes(), original, str(file))

    def test_same_writer_lease_blocks_start_and_stop_but_status_remains_readable(self):
        locks = load('cloud_cli_lock', ROOT / 'ops/updater/runtime_lock.py')
        with locks.installation_lock(self.home / 'installer/operations', '.writer.lock'):
            for action in ('start', 'stop'):
                result = self.command(action)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('OPERATION_BUSY', result.stderr)
            self.successful('status')
        self.assertFalse((self.state / 'native-runtime/runs').exists())

    def test_python_writer_and_actual_node_updater_lock_exclude_each_other(self):
        script = self.base / 'node-writer.cjs'
        script.write_text("""
const lock=require(process.argv[2]);
const lease=lock.acquire({directory:process.argv[3],probe:process.argv[4]==='probe'});
console.log(JSON.stringify({busy:lease.busy}));
if(process.argv[4]==='probe')lease.release();
else { process.stdin.resume();process.stdin.on('end',()=>lease.release()); }
""")
        command = [resolve_node(required=True), str(script),
                   str(ROOT / 'ops/installer/desktop/os-lock.js'), str(self.home / 'installer')]
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(json.loads(child.stdout.readline()), {'busy': False})
            result = self.command('start')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('OPERATION_BUSY', result.stderr)
        finally:
            child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0)
        locks = load('cross_language_writer', ROOT / 'ops/updater/runtime_lock.py')
        with locks.installation_lock(self.home / 'installer/operations', '.writer.lock'):
            probe = subprocess.run([*command, 'probe'], capture_output=True, text=True, check=True, timeout=10)
            self.assertEqual(json.loads(probe.stdout), {'busy': True})
        probe = subprocess.run([*command, 'probe'], capture_output=True, text=True, check=True, timeout=10)
        self.assertEqual(json.loads(probe.stdout), {'busy': False})

    def test_lost_delegation_and_desktop_record_never_fall_back_to_cloud_writer(self):
        result = self.command('start', env={'NORA_OPERATION_ID': 'invalid-guard'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('OPERATION_CAPABILITY_REQUIRED', result.stderr)
        (self.home / 'nora-instance.json').write_text(json.dumps({'schema': 1,
            'noraHome': str(self.home), 'hermesHome': str(self.home),
            'installRoot': str(self.root), 'port': self.port}))
        result = self.command('start')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('OPERATION_ENTRY_UNSUPPORTED', result.stderr)
        self.assertFalse((self.home / 'installer').exists())

    def test_direct_cli_cannot_select_another_state_or_port(self):
        for env, extra in (({'TAVERN_STATE_DIR': str(self.base / 'other')}, ('--port', str(self.port))),
                           ({}, ('--port', str(self.port + 1 if self.port < 65535 else self.port - 1)))):
            result = self.command('start', direct=True, env=env, extra=extra)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('CONDITIONS_CHANGED', result.stderr)
        self.assertFalse((self.home / 'installer').exists())

    def test_pending_program_transaction_blocks_but_completed_history_and_changed_stories_do_not(self):
        directory = self.root / 'tavern-updates'
        directory.mkdir()
        journal = directory / 'transaction.json'
        journal.write_text(json.dumps({'schema': 1, 'status': 'prepared'}))
        result = self.command('start')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('RECOVERY_REQUIRED', result.stderr)
        # Prepared resources/data backups are not unfinished program writes.
        record = {'schema': 1, 'status': 'prepared', 'recoveryPlan': {'schema': 1,
            'hermesHome': str(self.home), 'installRoot': str(self.root),
            'targets': [{'phase': 'pending'}], 'state': {'phase': 'saved', 'savedDigest': 'changed-user-backup'}}}
        journal.write_text(json.dumps(record))
        self.assertTrue(self.successful('start')['health']['ok'])
        self.successful('stop')
        record['recoveryPlan']['targets'][0]['phase'] = 'moving-old'
        journal.write_text(json.dumps(record))
        result = self.command('start')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('RECOVERY_REQUIRED', result.stderr)
        journal.write_text(json.dumps({'schema': 1, 'status': 'committed', 'backup': str(self.base / 'removed-backup')}))
        self.story.write_text('user changed their story\n', encoding='utf-8')
        self.assertTrue(self.successful('start')['health']['ok'])
        self.successful('stop')
        self.assertEqual(self.story.read_text(), 'user changed their story\n')


if __name__ == '__main__':
    unittest.main()
