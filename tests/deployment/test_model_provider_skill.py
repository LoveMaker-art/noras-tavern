"""Local-only model skill: real Hermes config API in disposable instances."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

import yaml
from ops.installer import launcher_bridge as bridge, first_install
from ops.updater import update

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / 'ops/skills/system/model-provider-config'


class SkillDistributionTests(unittest.TestCase):
    def test_frontmatter_and_local_only_distribution(self):
        text = (SKILL / 'SKILL.md').read_text(encoding='utf-8')
        meta = yaml.safe_load(text.split('---', 2)[1])
        self.assertEqual(meta['name'], 'model-provider-config')
        self.assertEqual(meta['platforms'], ['macos', 'windows'])
        self.assertIn('hermes', meta['metadata'])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fresh = first_install.prepare_skills(ROOT, root / 'fresh')
            cloud = update.prepare_skills(ROOT, root / 'cloud')
            local = update.prepare_skills(ROOT, root / 'local', local=True)
            self.assertIn('system/model-provider-config', fresh)
            self.assertIn('system/model-provider-config', local)
            self.assertNotIn('system/model-provider-config', cloud)

    def test_entrypoint_refuses_missing_home_without_writes(self):
        env = {**os.environ, 'HERMES_HOME': '', 'PYTHONDONTWRITEBYTECODE': '1'}
        result = subprocess.run([sys.executable, '-B', str(SKILL / 'scripts/configure_provider.py')],
                                input='{}', env=env, text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertIn('HERMES_HOME', json.loads(result.stdout)['error'])


@unittest.skipUnless(os.environ.get('NORA_TEST_HERMES'), 'Read-only installed Hermes source required')
class LocalModelSkillTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='nora-model-skill-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / 'hermes'
        self.tavern = self.root / 'tavern'
        self.home.mkdir()
        agent = Path(os.environ['NORA_TEST_HERMES']).resolve()
        (self.home / 'hermes-agent').symlink_to(agent, target_is_directory=True)
        self.entry = self.home / 'skills/system/model-provider-config/scripts/configure_provider.py'
        shutil.copytree(SKILL, self.entry.parent.parent)
        helper = self.tavern / 'apps/tavern-ops/installer'
        helper.mkdir(parents=True)
        for name in ['model_config.py', 'nora_system.py', 'operation_cli.py',
                     'operation_control.py', 'error_diagnostics.py']:
            shutil.copy2(ROOT / 'ops/installer' / name, helper / name)
        (self.home / 'nora-instance.json').write_text(json.dumps({
            'schema': 1, 'noraHome': str(self.root), 'hermesHome': str(self.home),
            'installRoot': str(self.tavern), 'port': 18999,
        }))
        self.config = self.home / 'config.yaml'
        self.config.write_text(yaml.safe_dump({
            'model': {'provider': 'custom', 'default': 'old', 'base_url': 'https://old.example/v1', 'api_key': 'old-key'},
            'fallback_providers': [{'provider': 'old-fallback', 'model': 'keep'}],
            'mcp_servers': {'nora': {'command': 'keep'}},
            'platforms': {'clawchat': {'enabled': True}},
        }))
        self.env = {**os.environ, 'HERMES_HOME': str(self.home), 'HOME': str(self.home),
                    'USERPROFILE': str(self.home), 'PYTHONNOUSERSITE': '1',
                    'PYTHONDONTWRITEBYTECODE': '1', 'XDG_CACHE_HOME': str(self.root / 'cache'),
                    'NORA_TAVERN_HOME': str(self.root), 'TAVERN_DATA_ROOT': str(self.tavern)}
        self.marker = self.root / 'installer/model.json'
        self.request = {'provider': 'custom', 'model': 'test-model', 'api_key': 'test-only-not-valid',
                        'base_url': 'https://example.invalid/v1'}

    def owned_run(self, script, data, *args):
        node = os.environ.get('NORA_TEST_NODE') or shutil.which('node')
        self.assertTrue(node, 'A real Node runtime is required for the owned model actor')
        return subprocess.run([node, str(Path(__file__).with_name('launcher_owned_test_actor.cjs')),
            str(ROOT / 'ops/installer/desktop/operation-lock.js'), str(self.root),
            sys.executable, str(script), *map(str, args)], env={**self.env, 'NORA_TEST_VENV_HOME': sys.prefix},
            input=json.dumps(data), capture_output=True, text=True, timeout=60)

    def invoke(self, data=None):
        result = self.owned_run(self.entry, data or self.request)
        self.assertNotIn(self.request['api_key'], result.stdout + result.stderr)
        return result, json.loads(result.stdout.splitlines()[-1])

    def test_real_custom_save_updates_launcher_not_tavern_and_creates_no_backups(self):
        sentinel = self.tavern / 'user-model.json'
        sentinel.write_text('keep')
        before = yaml.safe_load(self.config.read_text())
        result, reply = self.invoke()
        self.assertEqual(result.returncode, 0, reply)
        self.assertEqual(reply['activation'], 'next-session')
        self.assertEqual(reply['validation'], 'configuration-only')
        current = yaml.safe_load(self.config.read_text())
        for key in ['fallback_providers', 'mcp_servers', 'platforms']:
            self.assertEqual(current[key], before[key])
        self.assertEqual(sentinel.read_text(), 'keep')
        self.assertEqual(current['model']['api_key'], self.request['api_key'])
        self.assertEqual(bridge.read_verified_model(self.root, self.home)['model'], 'test-model')
        self.assertNotIn(self.request['api_key'], self.marker.read_text())
        self.assertNotIn('verifiedAt', json.loads(self.marker.read_text()))
        self.assertFalse((self.home / 'backups').exists())
        self.assertFalse(list(self.home.glob('*.bak')))

    def test_deepseek_default_and_existing_settings(self):
        request = {'provider': 'deepseek', 'api_key': self.request['api_key']}
        result, reply = self.invoke(request)
        self.assertEqual(result.returncode, 0, reply)
        self.assertEqual(reply['model'], 'deepseek-v4-flash')
        self.assertEqual(bridge.read_verified_model(self.root, self.home)['provider'], 'deepseek')

    def test_named_custom_replacement_changes_the_real_runtime_not_just_the_file(self):
        config = yaml.safe_load(self.config.read_text())
        config['model']['provider'] = 'custom:old-relay'
        config['custom_providers'] = [{
            'name': 'old-relay', 'model': 'old', 'base_url': 'https://old.example/v1',
            'api_key': 'old-key', 'api_mode': 'anthropic_messages',
        }]
        self.config.write_text(yaml.safe_dump(config))
        old_entry = config['custom_providers'][0].copy()
        # Seed the real old credential pool without sending a model request.
        code = 'from hermes_cli.runtime_provider import resolve_runtime_provider; resolve_runtime_provider()'
        seeded = subprocess.run([sys.executable, '-B', '-c', code], env=self.env,
                                cwd=self.home / 'hermes-agent', capture_output=True, text=True, timeout=30)
        self.assertEqual(seeded.returncode, 0)
        for action, key in [('save-local', 'test-only-not-valid'), ('save', 'rotated-fixture-only')]:
            request = {**self.request, 'api_key': key}
            if action == 'save-local':
                result, reply = self.invoke(request)
            else:
                payload = {'action': 'save', 'provider': 'custom', 'model': request['model'],
                           'keyEnv': '', 'key': key, 'baseUrl': request['base_url']}
                result = self.owned_run(ROOT / 'ops/installer/model_config.py', payload)
                reply = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertEqual(result.returncode, 0, reply)
            current = yaml.safe_load(self.config.read_text())
            self.assertEqual(current['custom_providers'][0], old_entry)
            check = (
                'import json; from hermes_cli.runtime_provider import resolve_runtime_provider; '
                'r=resolve_runtime_provider(); print(json.dumps({'
                '"endpointMatches":r.get("base_url")=='+repr(request['base_url'])+','
                '"credentialMatches":r.get("api_key")=='+repr(key)+','
                '"modelMatches":r.get("model")=="test-model",'
                '"protocolMatches":r.get("api_mode")=="chat_completions"}))'
            )
            resolved = subprocess.run([sys.executable, '-B', '-c', check], env=self.env,
                                      cwd=self.home / 'hermes-agent', capture_output=True, text=True, timeout=30)
            self.assertEqual(resolved.returncode, 0)
            checks = json.loads(resolved.stdout.strip().splitlines()[-1])
            self.assertTrue(all(checks.values()), checks)
            self.assertNotIn(key, result.stdout + result.stderr + resolved.stdout + resolved.stderr)

    def test_runtime_mismatch_rolls_back_config_credentials_and_marker(self):
        paths = [self.home / name for name in ['config.yaml', '.env', 'auth.json']]
        self.marker.parent.mkdir()
        self.marker.write_text('{"preserve":"old-verification"}')
        paths.append(self.marker)
        before = {p: p.read_bytes() if p.exists() else None for p in paths}
        payload = {'action': 'save-local', 'provider': 'custom', 'model': 'test-model',
                   'keyEnv': '', 'key': 'fixture-new-secret', 'baseUrl': 'https://example.invalid/v1'}
        code = (
            'import sys; from unittest.mock import patch; '
            'sys.path.insert(0,sys.argv[1]); import model_config; '
            'p=patch.object(model_config,"verify_custom_runtime",side_effect=ValueError("runtime mismatch")); '
            'p.start(); model_config.main()'
        )
        runner = self.root / 'runtime-mismatch.py'; runner.write_text(code, encoding='utf-8')
        result = self.owned_run(runner, payload, ROOT / 'ops/installer')
        self.assertEqual(result.returncode, 1)
        self.assertIn('runtime mismatch', json.loads(result.stdout.splitlines()[-1])['error'])
        self.assertNotIn(payload['key'], result.stdout + result.stderr)
        for path, contents in before.items():
            self.assertEqual(path.read_bytes() if path.exists() else None, contents)

    def test_managed_provider_name_collision_does_not_overwrite_user_entry(self):
        config = yaml.safe_load(self.config.read_text())
        config['providers'] = {'custom:nora-launcher': {'base_url': 'https://user.example/v1', 'api_key': 'keep'}}
        self.config.write_text(yaml.safe_dump(config))
        before = self.config.read_bytes()
        result, reply = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertIn('名称已被其他配置占用', reply['error'])
        self.assertEqual(self.config.read_bytes(), before)

    def test_saved_runtime_really_sends_to_new_endpoint_with_new_key_and_model(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(handler):
                payload = json.loads(handler.rfile.read(int(handler.headers['Content-Length'])))
                received.append((handler.path, handler.headers.get('Authorization'), payload.get('model')))
                body = b'{"choices":[{"message":{"content":"NORA_OK"}}]}'
                handler.send_response(200)
                handler.send_header('Content-Type', 'application/json')
                handler.send_header('Content-Length', str(len(body)))
                handler.end_headers()
                handler.wfile.write(body)
            def log_message(handler, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}/new/v1'
        config = yaml.safe_load(self.config.read_text())
        config['model']['provider'] = 'custom:old-relay'
        config['custom_providers'] = [{'name': 'old-relay', 'base_url': f'http://127.0.0.1:{server.server_port}/old/v1',
                                      'model': 'old', 'api_key': 'old-key'}]
        self.config.write_text(yaml.safe_dump(config))
        request = {**self.request, 'base_url': base}
        result, reply = self.invoke(request)
        self.assertEqual(result.returncode, 0, reply)
        # Send through the real resolver's values, never the form's submitted values.
        code = (
            'import json,urllib.request; from hermes_cli.runtime_provider import resolve_runtime_provider; '
            'r=resolve_runtime_provider(); data=json.dumps({"model":r["model"],'
            '"messages":[{"role":"user","content":"NORA_OK"}]}).encode(); '
            'q=urllib.request.Request(r["base_url"]+"/chat/completions",data=data,'
            'headers={"Content-Type":"application/json","Authorization":"Bearer "+r["api_key"]}); '
            'assert json.load(urllib.request.urlopen(q,timeout=5))["choices"][0]["message"]["content"]=="NORA_OK"'
        )
        sent = subprocess.run([sys.executable, '-B', '-c', code], env=self.env,
                              cwd=self.home / 'hermes-agent', capture_output=True, text=True, timeout=15)
        self.assertEqual(sent.returncode, 0, 'Resolved local fixture request failed')
        self.assertEqual(received, [('/new/v1/chat/completions', 'Bearer '+request['api_key'], 'test-model')])

    def test_real_hermes_can_discover_and_load_skill(self):
        code = (
            'import json; from tools.skills_tool import skills_list, skill_view; '
            'listing=skills_list(); assert "model-provider-config" in listing, listing; '
            'view=json.loads(skill_view("model-provider-config")); '
            'assert view.get("success"), view; '
            'assert "scripts/configure_provider.py" in str(view), view; '
            'print("skill discovered and loaded")'
        )
        result = subprocess.run([sys.executable, '-B', '-c', code], env=self.env,
                                cwd=self.home / 'hermes-agent', capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_invalid_requests_do_not_mutate_configuration(self):
        before = self.config.read_bytes()
        requests = [
            {**self.request, 'model': ''},
            {**self.request, 'provider': 'deepseek'},
            {**self.request, 'base_url': 'https://user:password@example.invalid/v1'},
            {**self.request, 'api_key': ''},
            {**self.request, 'api_key': 'key with spaces'},
            {**self.request, 'base_url': 'https://example.invalid/v1?token=anything'},
            {**self.request, 'extra': 'unsupported'},
        ]
        for request in requests:
            with self.subTest(request={k: v for k, v in request.items() if k != 'api_key'}):
                result, _ = self.invoke(request)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(self.config.read_bytes(), before)
                self.assertFalse(self.marker.exists())

    def test_corrupt_configuration_is_left_intact_without_backup(self):
        self.config.write_text('model: [broken')
        before = self.config.read_bytes()
        result, _ = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.config.read_bytes(), before)

    def test_redirected_config_is_rejected(self):
        outside = self.root / 'outside.yaml'
        outside.write_bytes(self.config.read_bytes())
        before = outside.read_bytes()
        self.config.unlink()
        # A link is rejected even when it stays inside the overall data root.
        self.config.symlink_to(outside)
        result, _ = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(outside.read_bytes(), before)
        self.assertFalse(list(self.home.glob('*.bak')))

    def test_mismatched_instance_cannot_write_other_home(self):
        record = self.home / 'nora-instance.json'
        data = json.loads(record.read_text())
        data['noraHome'] = str(self.root.parent)
        record.write_text(json.dumps(data))
        before = self.config.read_bytes()
        result, _ = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.config.read_bytes(), before)

    def test_marker_write_failure_restores_configuration_in_memory(self):
        # Exercise the same shared writer used by the UI with a failed final step.
        paths = [self.home / name for name in ['config.yaml', '.env', 'auth.json']]
        before = {p: p.read_bytes() if p.exists() else None for p in paths}
        request = {'action': 'save-local', 'provider': 'custom', 'model': 'test-model',
                   'keyEnv': '', 'key': self.request['api_key'], 'baseUrl': self.request['base_url']}
        # Invoke in a fresh interpreter so Hermes cannot cache another test home.
        code = (
            'import sys; from unittest.mock import patch; '
            'sys.path.insert(0, sys.argv[1]); import model_config, nora_system; '
            'p=patch.object(nora_system,"save_json",side_effect=OSError("test-only failure")); '
            'p.start(); model_config.main()'
        )
        runner = self.root / 'marker-failure.py'; runner.write_text(code, encoding='utf-8')
        result = self.owned_run(runner, request, ROOT / 'ops/installer')
        self.assertEqual(result.returncode, 1)
        self.assertIn('test-only failure', json.loads(result.stdout.splitlines()[-1])['error'])
        self.assertNotIn(self.request['api_key'], result.stdout + result.stderr)
        for p, contents in before.items():
            self.assertEqual(p.read_bytes() if p.exists() else None, contents)
        self.assertFalse(self.marker.exists())
        self.assertFalse((self.home / 'backups').exists())


if __name__ == '__main__':
    unittest.main()
