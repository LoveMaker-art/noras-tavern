"""Real Hermes deletion in disposable homes; all network access is denied."""
import json
import os
import sqlite3
import unittest

import yaml

from . import test_hermes_model_profiles as profiles


@unittest.skipUnless(os.environ.get('NORA_TEST_HERMES'), 'Installed Hermes source required')
class ModelDeleteTests(unittest.TestCase):
    setUp = profiles.SavedModelProfileTests.setUp
    snapshot = profiles.SavedModelProfileTests.snapshot
    assert_snapshot = profiles.SavedModelProfileTests.assert_snapshot
    assert_preserved = profiles.SavedModelProfileTests.assert_preserved
    run_python = profiles.SavedModelProfileTests.run_python
    invoke = profiles.SavedModelProfileTests.invoke
    state = profiles.SavedModelProfileTests.state
    save = profiles.SavedModelProfileTests.save

    def delete(self, target, inject=''):
        result = self.run_python('''
            import json, os, sys
            from pathlib import Path
            import hermes_model_config as subject
            request = json.load(sys.stdin)
            home = Path(os.environ['HERMES_HOME'])
            instance = json.loads((home / 'nora-instance.json').read_text())
            exec(request.get('inject', ''))
            try:
                value = subject.delete(home, instance, request['id'])
            except Exception as error:
                print(json.dumps({'ok': False, 'error': subject.redact(error),
                    'phase': getattr(error, 'failure_phase', '')}))
            else:
                print(json.dumps(value))
        ''', {'id': target, 'inject': inject})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout.splitlines()[-1])

    def test_exclusive_builtin_cleans_native_credentials_pool_and_cache(self):
        target = self.save('deepseek', 'remove-model', key='delete-only-fixture-key')['selectedId']
        selected = self.save('openrouter', 'keep-model')['selectedId']
        auth_path = self.home / 'auth.json'
        auth = json.loads(auth_path.read_text())
        auth['credential_pool'] = {
            'deepseek': [{'id':'delete-pool', 'source':'env:DEEPSEEK_API_KEY', 'api_key':'delete-only-fixture-key'}],
            'openrouter': [{'id':'keep-pool', 'source':'manual', 'api_key':'keep-pool-key'}]}
        auth_path.write_text(json.dumps(auth))
        cache = self.home / 'provider_models_cache.json'
        cache.write_text(json.dumps({'deepseek':{'models':['remove-model']}, 'openrouter':{'models':['keep-model']}}))
        result = self.delete(target)
        self.assertTrue(result['ok'], result)
        self.assertNotIn(target, {row['id'] for row in self.state()['models']})
        self.assertEqual(self.state()['selectedId'], selected)
        self.assertNotIn('DEEPSEEK_API_KEY', (self.home / '.env').read_text())
        self.assertNotIn('delete-only-fixture-key', auth_path.read_text() + self.config.read_text())
        self.assertIn('keep-pool-key', auth_path.read_text())
        self.assertNotIn('deepseek', json.loads(cache.read_text()))
        self.assertEqual(json.loads(cache.read_text())['openrouter'], {'models':['keep-model']})
        self.assertEqual(json.loads(self.marker.read_text())['previousSelectedId'], '')
        self.assert_preserved()

    def test_last_custom_connection_really_removed_without_resurrection(self):
        target = self.save('custom', 'remove-model', 'https://delete.invalid/v1', key='custom-delete-key')['selectedId']
        self.save('custom', 'keep-model', 'https://keep.invalid/v1', key='custom-keep-key')
        result = self.delete(target)
        self.assertTrue(result['ok'], result)
        content = self.config.read_text()
        for value in ['remove-model', 'delete.invalid', 'custom-delete-key']:
            self.assertNotIn(value, content)
        self.assertIn('keep.invalid', content)
        self.assertIn('custom-keep-key', content)
        self.assertNotIn(target, {row['id'] for row in self.state()['models']})
        self.assert_preserved()

    def test_same_service_other_model_keeps_credential_and_shared_connection(self):
        target = self.save('deepseek', 'remove-model')['selectedId']
        selected = self.save('deepseek', 'keep-model')['selectedId']
        before_env = (self.home / '.env').read_bytes()
        result = self.delete(target)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['cleanup'], 'shared-retained')
        self.assertEqual((self.home / '.env').read_bytes(), before_env)
        self.assertEqual(self.state()['selectedId'], selected)
        self.assertTrue(next(row for row in self.state()['models'] if row['id']==selected)['available'])
        self.assert_preserved()

    def test_inline_key_shared_by_another_native_use_is_preserved(self):
        shared_key = 'fixture-key-with-"quote'
        target = self.save('deepseek', 'remove-model', key=shared_key)['selectedId']
        self.save('openrouter', 'keep-model')
        config = yaml.safe_load(self.config.read_text())
        config['auxiliary'] = {'vision': {'provider':'custom:vision', 'model':'vision', 'api_key':shared_key}}
        self.config.write_text(yaml.safe_dump(config))
        before_env = (self.home / '.env').read_bytes()
        before_aux = config['auxiliary']
        result = self.delete(target)
        self.assertTrue(result['ok'], result)
        self.assertEqual((self.home / '.env').read_bytes(), before_env)
        self.assertEqual(yaml.safe_load(self.config.read_text())['auxiliary'], before_aux)

    def test_current_fallback_and_auxiliary_references_refuse_without_writes(self):
        target = self.save('deepseek', 'remove-model')['selectedId']
        before = self.snapshot()
        self.assertIn('当前默认', self.delete(target)['error'])
        self.assert_snapshot(before)
        self.save('openrouter', 'keep-model')
        original = yaml.safe_load(self.config.read_text())
        for section in ('fallback_providers', 'auxiliary', 'model_aliases'):
            config = dict(original)
            binding = {'provider':'deepseek', 'model':'remove-model'}
            config[section] = [binding] if section=='fallback_providers' else {'vision':binding} if section=='auxiliary' else {'shortcut':'remove-model'}
            self.config.write_text(yaml.safe_dump(config))
            before = self.snapshot()
            result = self.delete(target)
            self.assertFalse(result['ok'], result)
            self.assertEqual(result['phase'], 'candidate')
            self.assert_snapshot(before)

    def test_session_db_is_primary_and_legacy_only_fills_missing_keys(self):
        target = self.save('deepseek', 'remove-model')['selectedId']
        self.save('openrouter', 'keep-model')
        legacy = self.home / 'sessions/sessions.json'
        legacy.parent.mkdir()
        legacy.write_text(json.dumps({'session':{'model_override':{'provider':'deepseek','model':'remove-model'}}}))
        before = self.snapshot()
        self.assertIn('会话', self.delete(target)['error'])
        self.assert_snapshot(before)
        db = sqlite3.connect(self.home / 'state.db')
        db.execute('CREATE TABLE gateway_routing (scope TEXT, session_key TEXT, entry_json TEXT)')
        db.execute('INSERT INTO gateway_routing VALUES (?,?,?)',
                   (str(legacy.parent), 'session', json.dumps({'model_override': {'provider':'openrouter','model':'keep-model'}})))
        db.commit(); db.close()
        before_legacy = legacy.read_bytes()
        self.assertTrue(self.delete(target)['ok'])
        self.assertEqual(legacy.read_bytes(), before_legacy)
        self.assert_preserved()

    def test_session_using_another_model_keeps_shared_connection(self):
        target = self.save('custom', 'remove-model', 'https://delete.invalid/v1', key='session-key')['selectedId']
        self.save('openrouter', 'keep-model')
        config = yaml.safe_load(self.config.read_text())
        row = next(row for row in config['nora_model_profiles']['models'] if row['id']==target)
        provider = row['provider']
        legacy = self.home / 'sessions/sessions.json'; legacy.parent.mkdir()
        legacy.write_text(json.dumps({'session':{'model_override':{'provider':provider,'model':'session-model'}}}))
        result = self.delete(target)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['cleanup'], 'shared-retained')
        self.assertIn('session-key', self.config.read_text())
        self.assertIn(provider, yaml.safe_load(self.config.read_text())['providers'])
        self.assertNotIn(target, {row['id'] for row in self.state()['models']})

    def test_corrupt_session_or_cache_is_not_treated_as_empty(self):
        target = self.save('deepseek', 'remove-model')['selectedId']
        self.save('openrouter', 'keep-model')
        legacy = self.home / 'sessions/sessions.json'; legacy.parent.mkdir()
        legacy.write_text('{broken')
        before = self.snapshot()
        self.assertIn('无法核验', self.delete(target)['error'])
        self.assert_snapshot(before)
        legacy.unlink()
        cache = self.home / 'provider_models_cache.json'; cache.write_text('{broken')
        before = self.snapshot()
        self.assertIn('缓存格式无效', self.delete(target)['error'])
        self.assert_snapshot(before)
        self.assertEqual(cache.read_text(), '{broken')

    def test_write_failure_restores_every_file_and_next_delete_can_succeed(self):
        target = self.save('deepseek', 'remove-model')['selectedId']
        self.save('openrouter', 'keep-model')
        before = self.snapshot()
        failure = '''
original_atomic = subject._atomic
count = 0
def fail_once(file, contents):
    global count
    if file == home / '.env':
        count += 1
        if count == 1: raise OSError('fixture commit failure')
    return original_atomic(file, contents)
subject._atomic = fail_once
'''
        result = self.delete(target, failure)
        self.assertFalse(result['ok'], result)
        self.assert_snapshot(before)
        self.assertTrue(self.delete(target)['ok'])
        self.assert_preserved()

    def test_main_model_alias_reference_blocks_and_unrelated_text_does_not(self):
        target = self.save('deepseek', 'remove-model')['selectedId']
        self.save('openrouter', 'keep-model')
        config = yaml.safe_load(self.config.read_text())
        config['model']['aliases'] = {'old-choice':'deepseek/remove-model'}
        self.config.write_text(yaml.safe_dump(config))
        before = self.snapshot()
        self.assertFalse(self.delete(target)['ok'])
        self.assert_snapshot(before)
        config['model'].pop('aliases')
        config['mcp_servers']['nora']['args'] = ['remove-model']
        self.config.write_text(yaml.safe_dump(config))
        result = self.delete(target)
        self.assertTrue(result['ok'], result)
        self.assertEqual(yaml.safe_load(self.config.read_text())['mcp_servers'], config['mcp_servers'])

    def test_missing_credential_record_can_be_deleted_and_same_service_can_be_added_again(self):
        target = self.save('deepseek', 'remove-model')['selectedId']
        self.save('openrouter', 'keep-model')
        env_path = self.home / '.env'
        env_path.write_text('\n'.join(line for line in env_path.read_text().splitlines() if not line.startswith('DEEPSEEK_API_KEY=')) + '\n')
        self.assertFalse(next(row for row in self.state()['models'] if row['id']==target)['available'])
        self.assertTrue(self.delete(target)['ok'])
        readded = self.save('deepseek', 'remove-model')['selectedId']
        self.assertEqual(readded, target)
        self.assertTrue(next(row for row in self.state()['models'] if row['id']==target)['available'])
        self.assert_preserved()

    def test_unconfirmed_restore_retains_private_originals_without_claiming_success(self):
        target = self.save('deepseek', 'remove-model')['selectedId']
        self.save('openrouter', 'keep-model')
        before = self.snapshot()
        result = self.delete(target, '''
original_atomic = subject._atomic
config_writes = 0
def fail_commit_and_restore(file, contents):
    global config_writes
    if file == home / 'config.yaml':
        config_writes += 1
        if config_writes > 1: raise OSError('fixture restore failed')
    if file == home / '.env': raise OSError('fixture commit failed')
    return original_atomic(file, contents)
subject._atomic = fail_commit_and_restore
''')
        self.assertFalse(result['ok'])
        self.assertEqual(result['phase'], '')
        backups = list((self.root / 'installer/operations').glob('.model-delete-recovery-*/originals.json'))
        self.assertEqual(len(backups), 1)
        import base64
        originals = json.loads(backups[0].read_text())['files']
        for file, value in before.items():
            encoded = originals[str(file.relative_to(self.root))]
            self.assertEqual(None if encoded is None else base64.b64decode(encoded), value)
        if os.name != 'nt':
            self.assertEqual(backups[0].parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
        for file, contents in self.sentinels.items():
            self.assertEqual(file.read_bytes(), contents)
