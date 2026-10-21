"""Four-category summary and independent, capacity-safe memory projection contracts."""
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'core'))
import story_profile as p
import reflection as r


class Model:
    config = {'base_url': 'https://offline.invalid/v1', 'model': 'offline', 'max_tokens': 4000, 'context_tokens': 32000}
    def __init__(self, *responses):
        self.responses, self.calls = list(responses), []
    def complete(self, messages):
        self.calls.append(messages)
        if not self.responses:
            raise AssertionError('Unexpected additional model call')
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


class CompactMemoryContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nora-compact-memory-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state, self.memories = self.root / 'profile', self.root / 'memories'
        self.seed = self.root / 'actor.md'
        self.seed.write_text('# 合成测试人格\n', encoding='utf-8')
        (self.root / 'config.yaml').write_text('memory:\n  user_char_limit: 2000\n  memory_char_limit: 2200\n', encoding='utf-8')
        environment = patch.dict(os.environ, {'TAVERN_HERMES_MEMORIES_DIR': str(self.memories), 'TAVERN_HERMES_STATE_DB': str(self.root / 'state.db')})
        environment.start(); self.addCleanup(environment.stop)
        p.ensure_profile(self.state, self.seed)

    def summary(self, **items):
        return {key: items.get(key, []) for key in ('story_tastes', 'narrative_habits', 'co_creation', 'boundaries')}

    def production(self, identifier='world', session='session', at=1, status='prepared', **overrides):
        item = {'id': identifier, 'world_id': identifier, 'name': identifier, 'session_id': session, 'session_name': session, 'total_turns': 30,
                'story_state': {'status': status, 'turns': 15, 'covered_turns': 15, 'total_turns': 30, 'updated_at': at,
                                'timeline': [f'{identifier}发生的关键事件'], 'open_threads': [f'{identifier}待解事项'], 'secrets': ['未揭晓秘密不可注入']}}
        item['story_state'].update(overrides)
        return item

    def test_new_summary_caps_are_strict_and_old_eight_fields_are_preserved(self):
        legacy = {'pacing': ['旧节奏规则'], 'boundaries': ['旧边界规则']}
        p.set_taste_profile(self.state, self.seed, legacy)
        before = p.load_profile(self.state, self.seed)['taste_profile']
        values = self.summary(story_tastes=['题材'+str(i)+'甲'*97 for i in range(4)], narrative_habits=['乙'*100]*3,
                              co_creation=['丙'*100]*3, boundaries=['丁'*100]*4)
        p.set_taste_profile(self.state, self.seed, values)
        value = p.load_profile(self.state, self.seed)
        self.assertEqual(value['taste_profile'], before)
        self.assertEqual(value['taste_profile_v2'], values)
        for invalid in (self.summary(story_tastes=['x']*5), self.summary(narrative_habits=['x']*4), self.summary(boundaries=['不要'+ 'x'*99])):
            with self.assertRaises(Exception):
                p.set_taste_profile(self.state, self.seed, invalid)
        self.assertEqual(p.load_profile(self.state, self.seed)['taste_profile_v2'], values)

    def test_model_prompt_and_validator_use_the_same_four_category_contract(self):
        p.record_learning(self.state, self.seed, '偏爱悬疑题材', 'test')
        expected = self.summary(story_tastes=['偏爱悬疑题材'])
        model = Model(json.dumps(expected, ensure_ascii=False))
        result = r.refresh_taste_profile(p, model, self.state, self.seed)
        self.assertEqual(result, expected)
        self.assertEqual(len(model.calls), 1)
        self.assertIn('story_tastes', model.calls[0][0]['content'])
        self.assertIn('1400', model.calls[0][0]['content'])
        invalid = Model(json.dumps(self.summary(narrative_habits=['只有条件满足时才允许'+ 'x'*100]), ensure_ascii=False))
        with self.assertRaises(Exception):
            r.refresh_taste_profile(p, invalid, self.state, self.seed)
        self.assertEqual(p.load_profile(self.state, self.seed)['taste_profile_v2'], expected)

    def test_legacy_long_values_are_not_silently_cut_and_memory_can_still_sync(self):
        raw = {'pacing': ['不要'+ '条件'*80 + '，否则不允许。']}
        p.set_taste_profile(self.state, self.seed, raw)
        p.sync_story_states(self.state, self.seed, [self.production()])
        current = p.load_profile(self.state, self.seed)
        self.assertEqual(current['taste_profile']['pacing'], raw['pacing'])
        result = p.sync_profile_memories(self.state, self.seed)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['user']['code'], 'STORY_PROFILE_SUMMARY_REFRESH_REQUIRED')
        self.assertEqual(result['memory']['status'], 'complete')

    def test_user_full_file_limit_and_reserve_keep_unmanaged_text(self):
        target = self.memories / 'USER.md'
        target.write_text('私有前文\n' + target.read_text(encoding='utf-8') + '\n私有后文\n', encoding='utf-8')
        values = self.summary(story_tastes=[f'{i}'+'甲'*99 for i in range(4)], narrative_habits=[f'{i}'+'乙'*99 for i in range(3)],
                              co_creation=[f'{i}'+'丙'*99 for i in range(3)], boundaries=[f'{i}'+'丁'*99 for i in range(4)])
        p.set_taste_profile(self.state, self.seed, values)
        text = target.read_text(encoding='utf-8')
        self.assertTrue(text.startswith('私有前文\n')); self.assertTrue(text.endswith('\n私有后文\n'))
        self.assertLessEqual(len(text), 1897)
        self.assertEqual(sum(len(x) for group in values.values() for x in group), 1400)
        self.assertIn(values['boundaries'][-1], text)
        self.assertEqual(p.sync_profile_memories(self.state, self.seed)['changed'], [])

    def test_all_archival_story_sentences_remain_available_but_never_enter_resident_memory(self):
        p.set_taste_profile(self.state, self.seed, self.summary())
        stories = [self.production(f'世界{i}', f'会话{i}', at=i, timeline=[f'世界{i}简短关键事件', '长事件'*300], open_threads=[f'世界{i}未解线索']) for i in range(4)]
        p.sync_story_states(self.state, self.seed, stories)
        current = p.load_profile(self.state, self.seed)
        self.assertEqual(len(current['shared_story_memory']), 4)
        self.assertEqual(current['shared_story_memory'][0]['events'][-1], '长事件'*300)
        self.assertFalse((self.memories/'MEMORY.md').exists())
        self.assertEqual(p.memory_preview(current)['memory'], '')
        self.assertNotIn('简短关键事件', p.context_for_message(current))

    def test_full_unmanaged_memory_neither_changes_nor_prevents_user_success(self):
        target = self.memories / 'MEMORY.md'
        target.write_text('M'*2190, encoding='utf-8'); before = target.read_bytes()
        p.sync_story_states(self.state, self.seed, [self.production()])
        p.set_taste_profile(self.state, self.seed, self.summary(story_tastes=['新口味']))
        result = p.sync_profile_memories(self.state, self.seed)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['user']['status'], 'complete')
        self.assertEqual(result['memory']['action'], 'no_story_block')
        self.assertEqual(target.read_bytes(), before)
        self.assertIn('新口味', (self.memories / 'USER.md').read_text(encoding='utf-8'))

    def test_user_read_failure_does_not_prevent_memory_success(self):
        target = self.memories / 'USER.md'
        read = Path.read_text
        def unreadable(path, *args, **kwargs):
            if path == target: raise PermissionError('synthetic read denial')
            return read(path, *args, **kwargs)
        p.sync_story_states(self.state, self.seed, [self.production()])
        current = p.load_profile(self.state, self.seed)
        with patch.object(Path, 'read_text', unreadable):
            result = p.sync_hermes_memories(current, state_dir=self.state)
        self.assertEqual(result['user']['status'], 'pending')
        self.assertEqual(result['memory']['status'], 'complete')
        self.assertEqual(result['status'], 'partial')

    def test_each_target_reads_its_own_configured_limit_and_attempts_writes(self):
        settings = self.root / 'config.yaml'
        settings.write_text('memory:\n  user_char_limit: false\n  memory_char_limit: 2200\n', encoding='utf-8')
        result = p.sync_profile_memories(self.state, self.seed)
        self.assertEqual(result['user']['code'], 'STORY_PROFILE_USER_BUDGET_UNREADABLE')
        self.assertEqual(result['memory']['status'], 'complete')
        settings.write_text('memory:\n  user_char_limit: 2000\n  memory_char_limit: false\n', encoding='utf-8')
        result = p.sync_profile_memories(self.state, self.seed)
        self.assertEqual(result['user']['status'], 'complete')
        self.assertEqual(result['memory']['status'], 'complete')
        settings.write_text('memory:\n  user_char_limit: 2000\n  memory_char_limit: 2200\n', encoding='utf-8')
        target = self.memories/'MEMORY.md'
        target.write_text(p.MEMORY_START+'旧剧情'+p.MEMORY_END, encoding='utf-8')
        original = Path.read_bytes
        def denied(path):
            if path == target: raise PermissionError('synthetic read denial')
            return original(path)
        with patch.object(Path, 'read_bytes', denied):
            result = p.sync_story_states(self.state, self.seed, [self.production()], include_status=True)['projections']
        self.assertEqual(result['user']['status'], 'complete')
        self.assertEqual(result['memory']['status'], 'pending')

    def test_unwritable_receipt_cannot_reuse_old_success_after_current_projection_failed(self):
        p.set_taste_profile(self.state, self.seed, self.summary(story_tastes=['悬疑']))
        old = p.projection_status(self.state)
        self.assertEqual(old['status'], 'complete')
        (self.memories / 'MEMORY.md').write_text(p.MEMORY_START+'不完整旧块', encoding='utf-8')
        original = p._atomic_text
        def denied(path, text):
            if path.name == p.PROJECTION_STATUS_FILENAME: raise PermissionError('synthetic receipt denial')
            return original(path, text)
        with patch.object(p, '_atomic_text', side_effect=denied):
            result = r._saved_result(p, self.state, self.seed, {'extraction_complete': True})
        self.assertEqual(result['status'], 'partial')
        self.assertTrue(result['summary_saved'])
        self.assertEqual(result['projections']['memory']['code'], 'STORY_PROFILE_MEMORY_MARKERS_UNCONFIRMED')
        self.assertEqual(result['projections']['report_code'], 'STORY_PROFILE_PROJECTION_STATUS_UNWRITABLE')
        self.assertEqual(p.projection_status(self.state)['status'], 'complete')  # old disk receipt is deliberately unchanged

    def test_actual_cli_reports_saved_sources_and_partial_projection_without_model(self):
        app = self.root / 'app'; app.mkdir()
        (app / 'actor_self.md').write_text('# 合成测试人格\n', encoding='utf-8')
        environment = {**os.environ, 'TAVERN_APP_DIR': str(app), 'TAVERN_STATE_DIR': str(self.state),
                       'PYTHONPATH': str(Path(__file__).resolve().parents[2] / 'app'), 'PYTHONDONTWRITEBYTECODE': '1'}
        command = [sys.executable, '-B', str(Path(__file__).resolve().parents[1] / 'adapters/nora/cli.py')]
        (self.memories / 'MEMORY.md').write_text(p.MEMORY_START+'不完整旧块', encoding='utf-8')
        sync = subprocess.run(command + ['sync-story-states'], input=json.dumps({'productions':[self.production()]}),
                              env=environment, text=True, capture_output=True, timeout=10)
        self.assertEqual(sync.returncode, 0, sync.stderr)
        report = json.loads(sync.stdout)
        self.assertTrue(report['saved']); self.assertEqual(report['status'], 'partial')
        self.assertEqual(report['projections']['user']['status'], 'complete')
        self.assertEqual(p.load_profile(self.state, self.seed)['shared_story_memory'][0]['status'], 'prepared')
        recovery = subprocess.run(command + ['recover-profile'], input='{}', env=environment, text=True, capture_output=True, timeout=10)
        self.assertEqual(recovery.returncode, 2, recovery.stderr)
        report = json.loads(recovery.stdout)
        self.assertEqual(report['status'], 'partial'); self.assertFalse(report['model_called'])
        self.assertTrue(report['summary_saved']); self.assertEqual(report['projections']['memory']['status'], 'pending')

    def test_prepared_branches_are_distinct_and_unknown_coverage_is_not_zero(self):
        items = [self.production('同一个世界', f'branch{i}', at=i) for i in range(3)]
        items.append(self.production('未知范围', 'unknown', at=4, covered_turns=None, total_turns=None))
        items.append(self.production('无效摘要', 'bad', at=5, status='stale', timeline=['失效正文不得投影']))
        worlds = p.sync_story_states(self.state, self.seed, items)
        self.assertEqual(len(worlds), 5)
        self.assertEqual(len([item for item in worlds if item['world_id']=='同一个世界']), 3)
        unknown = next(item for item in worlds if item['world_id']=='未知范围')
        self.assertIsNone(unknown['covered_turns']); self.assertIsNone(unknown['total_turns'])
        self.assertEqual(p.memory_preview(p.load_profile(self.state, self.seed))['memory'], '')
        self.assertFalse((self.memories/'MEMORY.md').exists())

    def test_stale_profile_argument_cannot_overwrite_latest_projection(self):
        p.set_taste_profile(self.state, self.seed, self.summary(story_tastes=['旧口味']))
        old = p.load_profile(self.state, self.seed)
        p.set_taste_profile(self.state, self.seed, self.summary(story_tastes=['新口味']))
        result = p.sync_hermes_memories(old, state_dir=self.state)
        text = (self.memories / 'USER.md').read_text(encoding='utf-8')
        self.assertIn('新口味', text); self.assertNotIn('旧口味', text)
        self.assertEqual(result['revision'], p.load_profile(self.state, self.seed)['revision'])

    def test_model_work_completes_despite_cleanup_pending_then_local_retry_is_free(self):
        target = self.memories / 'MEMORY.md'; target.write_text(p.MEMORY_START+'不完整旧块', encoding='utf-8')
        context = {'world_id':'w', 'session_id':'s', 'revision':'r', 'story':[{'id':'a','role':'user','text':'我喜欢悬疑题材。'}, {'id':'b','role':'user','text':'请记住我喜欢悬疑题材。'}]}
        extraction = json.dumps({'preferences':[{'text':'偏爱悬疑题材','evidence_ids':['m0','m1']}]}, ensure_ascii=False)
        model = Model(extraction, json.dumps(self.summary(story_tastes=['偏爱悬疑题材']), ensure_ascii=False))
        first = r.reflect_context(p, model, self.state, self.seed, context, write=True)
        self.assertEqual(len(model.calls), 2)
        self.assertTrue(first['extraction_complete']); self.assertTrue(first['summary_saved'])
        self.assertEqual(first['status'], 'partial')
        self.assertEqual(first['projections']['user']['status'], 'complete')
        self.assertEqual(first['projections']['memory']['status'], 'pending')
        target.write_text('', encoding='utf-8')
        retry = Model()
        second = r.reflect_context(p, retry, self.state, self.seed, {**context,'resume_job_id':first['job_id']}, write=True)
        self.assertEqual(second['status'], 'completed'); self.assertEqual(retry.calls, [])
        self.assertEqual(p.load_profile(self.state, self.seed)['stats']['event_count'], 1)


if __name__ == '__main__':
    unittest.main()
