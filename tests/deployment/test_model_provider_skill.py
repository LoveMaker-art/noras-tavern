"""Local-only model skill: real Hermes config API in disposable instances."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

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
        for name in ['model_config.py', 'nora_system.py']:
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
                    'PYTHONDONTWRITEBYTECODE': '1', 'XDG_CACHE_HOME': str(self.root / 'cache')}
        self.marker = self.root / 'installer/model.json'
        self.request = {'provider': 'custom', 'model': 'test-model', 'api_key': 'test-only-not-valid',
                        'base_url': 'https://example.invalid/v1'}

    def invoke(self, data=None):
        result = subprocess.run([sys.executable, '-B', str(self.entry)], env=self.env,
                                input=json.dumps(data or self.request), capture_output=True,
                                text=True, timeout=60)
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
        result = subprocess.run([sys.executable, '-B', '-c', code, str(ROOT / 'ops/installer')],
                                input=json.dumps(request), env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(self.request['api_key'], result.stdout + result.stderr)
        for p, contents in before.items():
            self.assertEqual(p.read_bytes() if p.exists() else None, contents)
        self.assertFalse(self.marker.exists())
        self.assertFalse((self.home / 'backups').exists())


if __name__ == '__main__':
    unittest.main()
