"""Offline projection contracts: no model, real Hermes files or real sessions."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

CORE = Path(__file__).resolve().parents[1] / 'core'
sys.path.insert(0, str(CORE))
import story_profile as profile


class Projections(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='story-profile-projection-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'profile'
        self.seed = self.root / 'seed.md'
        self.seed.write_text('# 身份\n测试人物\n', encoding='utf-8')
        self.memories = self.root / 'memories'
        self.env = patch.dict(os.environ, {
            'TAVERN_HERMES_MEMORIES_DIR': str(self.memories),
            'TAVERN_HERMES_STATE_DB': str(self.root / 'state.db'),
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        profile.ensure_profile(self.state, self.seed)

    def production(self, identifier='world', at=1):
        return {'id': identifier, 'name': identifier, 'story_state': {
            'turns': 15, 'updated_at': at,
            'timeline': [f'事件{i}' for i in range(15)],
            'open_threads': [f'线索{i}' for i in range(8)],
        }}

    def test_limits_and_selection_preserve_original_rules(self):
        profile.set_taste_profile(self.state, self.seed, {
            key: ['口味' * 200] * 6 for key in profile.TASTE_PROFILE_FIELDS
        })
        worlds = profile.sync_story_states(self.state, self.seed, [self.production(f'世界{i}', i) for i in range(5)])
        self.assertEqual([item['world'] for item in worlds], ['世界4', '世界3', '世界2'])
        self.assertEqual(worlds[0]['events'], [f'事件{i}' for i in range(3, 15)])
        self.assertEqual(len(worlds[0]['open_threads']), 6)
        value = profile.load_profile(self.state, self.seed)
        preview = profile.memory_preview(value)
        self.assertLessEqual(len(preview['user']), 900)
        self.assertLessEqual(len(preview['memory']), 1300)
        self.assertIn('事件11', preview['memory'])
        self.assertNotIn('事件10', preview['memory'])
        self.assertIn('线索1', preview['memory'])
        self.assertNotIn('线索2', preview['memory'])
        self.assertNotIn('事件', preview['user'])
        self.assertNotIn('口味', preview['memory'])
        self.assertEqual(profile._bounded_markdown(['abc', 'too long', 'later'], 6), 'abc')

    def test_both_budget_caps_hold_with_long_distinct_fields(self):
        profile.set_taste_profile(self.state, self.seed, {
            key: [str(i) + '偏好' * 240 for i in range(7)] for key in profile.TASTE_PROFILE_FIELDS
        })
        production = self.production()
        production['story_state']['timeline'] = ['剧情' * 500] * 15
        production['story_state']['open_threads'] = ['线索' * 500] * 8
        profile.sync_story_states(self.state, self.seed, [production])
        value = profile.load_profile(self.state, self.seed)
        self.assertEqual(len(value['taste_profile']['pacing']), 4)
        self.assertEqual(len(value['taste_profile']['pacing'][0]), 240)
        self.assertEqual(len(value['shared_story_memory'][0]['events'][0]), 420)
        self.assertEqual(len(value['shared_story_memory'][0]['open_threads'][0]), 320)
        preview = profile.memory_preview(value)
        self.assertLessEqual(len(preview['user']), 900)
        self.assertLessEqual(len(preview['memory']), 1300)

    def test_literal_backslashes_and_unmanaged_content_survive_repeated_writes(self):
        target = self.memories / 'MEMORY.md'
        suffix = '\n## 私人记忆\n不属于酒馆的内容\n  \n\n'
        target.write_text(target.read_text() + suffix, encoding='utf-8')
        production = self.production()
        production['story_state']['timeline'] = [r'地图位于 C:\new\world，不是正则替换 \1']
        profile.sync_story_states(self.state, self.seed, [production])
        profile.sync_story_states(self.state, self.seed, [production])
        output = target.read_text()
        self.assertTrue(output.endswith(suffix))
        self.assertIn(r'C:\new\world', output)
        self.assertIn(r'\1', output)
        self.assertEqual(output.count(profile.MEMORY_START), 1)
        self.assertFalse((self.memories / 'SOUL.md').exists())
        self.assertFalse((self.memories / 'AGENTS.md').exists())
        self.assertEqual(profile.sync_profile_memories(self.state, self.seed)['changed'], [])

    def test_retry_repairs_partial_write_without_new_revision_or_preference_loss(self):
        profile.set_taste_profile(self.state, self.seed, {'pacing': ['慢热']})
        production = self.production()
        write = profile._atomic_text
        def fail_memory(path, body):
            if path.name == 'MEMORY.md':
                raise OSError('fixture write failure')
            return write(path, body)
        with patch.object(profile, '_atomic_text', side_effect=fail_memory):
            with self.assertRaises(OSError):
                profile.sync_story_states(self.state, self.seed, [production])
        before = profile.load_profile(self.state, self.seed)
        profile.sync_story_states(self.state, self.seed, [production])
        after = profile.load_profile(self.state, self.seed)
        self.assertEqual(before, after)
        self.assertEqual(after['taste_profile']['pacing'], ['慢热'])
        self.assertIn('事件14', (self.memories / 'MEMORY.md').read_text())
        profile.sync_story_states(self.state, self.seed, [])
        self.assertNotIn('事件14', (self.memories / 'MEMORY.md').read_text())
        self.assertEqual(profile.load_profile(self.state, self.seed)['taste_profile']['pacing'], ['慢热'])

    def test_projection_invalidates_only_active_clawchat_prompt_cache(self):
        db = sqlite3.connect(self.root / 'state.db')
        self.addCleanup(db.close)
        db.execute('CREATE TABLE sessions (id INTEGER PRIMARY KEY, source TEXT, ended_at INTEGER, system_prompt TEXT)')
        db.executemany('INSERT INTO sessions (source, ended_at, system_prompt) VALUES (?, ?, ?)', [('clawchat', None, 'old'), ('cli', None, 'keep'), ('clawchat', 1, 'ended')])
        db.commit()
        profile.sync_story_states(self.state, self.seed, [self.production()])
        self.assertEqual(db.execute('SELECT system_prompt FROM sessions').fetchall(), [(None,), ('keep',), ('ended',)])

    def test_cross_process_writer_waits_for_profile_transaction_and_keeps_both_updates(self):
        code = '''
import json, pathlib, sys
sys.path.insert(0, sys.argv[1])
import story_profile as p
state, seed = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
print('ready', flush=True)
p.sync_story_states(state, seed, [{'id':'world','name':'world','story_state':{'turns':15,'timeline':['模型事件']}}])
'''
        with profile._profile_lock(self.state):
            child = subprocess.Popen([sys.executable, '-c', code, str(CORE), str(self.state), str(self.seed)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'ready')
                with self.assertRaises(subprocess.TimeoutExpired):
                    child.wait(timeout=0.1)
                profile.set_taste_profile(self.state, self.seed, {'pacing': ['本次新增偏好']})
            except BaseException:
                child.kill()
                child.communicate()
                raise
        try:
            _, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 0, stderr)
        finally:
            if child.poll() is None:
                child.kill(); child.communicate()
        result = profile.load_profile(self.state, self.seed)
        self.assertEqual(result['taste_profile']['pacing'], ['本次新增偏好'])
        self.assertEqual(result['shared_story_memory'][0]['events'], ['模型事件'])


if __name__ == '__main__':
    unittest.main()
