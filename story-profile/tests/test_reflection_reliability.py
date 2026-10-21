"""Exercise real reflection orchestration, with isolated storage and no network."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'core'))
import reflection
import story_profile as profile


class Model:
    config = {'model': 'offline', 'base_url': 'https://offline.invalid/v1', 'max_tokens': 4000, 'context_tokens': 32000}

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def complete(self, messages):
        self.calls.append(messages)
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


class ReflectionReliability(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='nora-reflection-reliability-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / 'state'
        self.seed = self.root / 'actor.md'
        self.seed.write_text('# 测试人物\n# 我对你的了解\n\n# 成长记\n', encoding='utf-8')
        env = patch.dict(os.environ, {'TAVERN_HERMES_MEMORIES_DIR': str(self.root / 'memories'), 'TAVERN_HERMES_STATE_DB': str(self.root / 'state.db')})
        env.start()
        self.addCleanup(env.stop)
        self.context = {'world_id': 'w', 'session_id': 's', 'revision': 'r', 'world_name': '测试世界',
                        'story': [{'id': 'a', 'role': 'user', 'text': '我喜欢悬疑题材，请记住这个偏好。'},
                                  {'id': 'b', 'role': 'char', 'text': '好的。'},
                                  {'id': 'c', 'role': 'user', 'text': '后续也请采用悬疑题材。'}]}
        self.extraction = json.dumps({'preferences': [{'text': '偏爱悬疑题材', 'evidence_ids': ['m0', 'm2']}]}, ensure_ascii=False)
        self.taste = json.dumps({key: ['悬疑'] if key == 'story_tastes' else [] for key in profile.TASTE_PROFILE_V2_FIELDS}, ensure_ascii=False)

    def reflect(self, model, **extra):
        return reflection.reflect_context(profile, model, self.state, self.seed, {**self.context, **extra}, write=True)

    def test_truncated_or_empty_model_answer_is_not_none(self):
        for message, finish, code in [({'content': None, 'reasoning_content': 'thinking'}, 'length', 'STORY_PROFILE_OUTPUT_TRUNCATED'), ({'content': ''}, 'stop', 'STORY_PROFILE_EMPTY_OUTPUT')]:
            document = {'choices': [{'message': message, 'finish_reason': finish}]}
            client = reflection.OpenAICompatibleModelClient(Model.config)
            with self.subTest(code=code), patch.object(reflection.urllib.request.OpenerDirector, 'open', return_value=io.BytesIO(json.dumps(document).encode())):
                with self.assertRaises(reflection.StoryProfileReflectionError) as raised:
                    client.complete([{'role': 'user', 'content': 'test'}])
                self.assertEqual(raised.exception.code, code)

    def test_partial_summary_resumes_without_extracting_or_learning_twice(self):
        first = Model(self.extraction, 'not JSON')
        result = self.reflect(first)
        self.assertEqual(result['status'], 'partial')
        self.assertTrue(result['extraction_complete'])
        before = profile.load_profile(self.state, self.seed)
        self.assertEqual(before['stats']['event_count'], 1)
        retry = Model(self.taste)
        recovered = self.reflect(retry, resume_job_id=result['job_id'])
        after = profile.load_profile(self.state, self.seed)
        self.assertEqual(recovered['status'], 'completed')
        self.assertEqual(len(retry.calls), 1)
        self.assertEqual(after['stats']['event_count'], 1)
        self.assertEqual(after['preferences'], before['preferences'])
        self.assertFalse(after['taste_profile_stale'])
        replay = Model()
        self.assertEqual(self.reflect(replay)['status'], 'completed')
        self.assertEqual(replay.calls, [])

    def test_only_user_evidence_can_create_preference(self):
        bad = json.dumps({'preferences': [{'text': '偏爱悬疑题材', 'evidence_ids': ['m1']}]})
        model = Model(bad)
        result = self.reflect(model)
        self.assertFalse(result['extraction_complete'])
        self.assertEqual(result['code'], 'STORY_PROFILE_INVALID_EVIDENCE')
        self.assertEqual(profile.preference_texts(profile.load_profile(self.state, self.seed)), [])

    def test_explicit_none_is_a_success_but_arbitrary_text_is_not(self):
        result = self.reflect(Model('NONE'))
        self.assertEqual(result['status'], 'completed')
        self.assertTrue(result['extraction_complete'])
        self.assertFalse(result['written'])
        bad = self.reflect(Model('模型随便解释了一段'), revision='r2')
        self.assertEqual(bad['code'], 'STORY_PROFILE_INVALID_OUTPUT')
        self.assertFalse(bad['extraction_complete'])

    def test_failed_extract_is_not_replayed_by_page_reconnect(self):
        model = Model(reflection.StoryProfileReflectionError('denied', code='STORY_PROFILE_PROVIDER_DENIED'))
        result = self.reflect(model)
        self.assertEqual(result['status'], 'failed')
        reconnect = Model()
        self.assertEqual(self.reflect(reconnect)['status'], 'failed')
        self.assertEqual(reconnect.calls, [])
        manual = Model(self.extraction, self.taste)
        self.assertEqual(self.reflect(manual, retry=True)['status'], 'completed')

    def test_historical_archive_never_enters_reflection_prompt(self):
        profile.ensure_profile(self.state, self.seed)
        (self.state / 'actor_self.md').write_text('# 我对你的了解\n- 喜欢侦探\n# 成长记\n' + '旧档案不应发送' * 30000, encoding='utf-8')
        model = Model('NONE')
        result = self.reflect(model)
        self.assertEqual(result['status'], 'completed')
        prompt = json.dumps(model.calls, ensure_ascii=False)
        self.assertNotIn('旧档案不应发送', prompt)
        self.assertLess(len(prompt.encode('utf-8')), 24000)

    def test_recent_initial_window_reports_unprocessed_old_history(self):
        story = [{'role': 'user', 'text': f'第{i}轮：我喜欢侦探。'} for i in range(1, 312)]
        model = Model('NONE')
        result = self.reflect(model, story=story)
        self.assertEqual(result['processed']['from_user_turn'], 297)
        self.assertEqual(result['processed']['to_user_turn'], 311)
        self.assertEqual(result['processed']['skipped_before'], 296)

    def test_independent_summary_recovery_confirms_an_interrupted_job_without_model_replay(self):
        partial = self.reflect(Model(self.extraction, 'not JSON'))
        path = self.state / 'story_profile_jobs' / (partial['job_id'] + '.json')
        job = json.loads(path.read_text(encoding='utf-8'))
        job['stage'] = 'requesting_summary'
        path.write_text(json.dumps(job), encoding='utf-8')
        reflection.refresh_taste_profile(profile, Model(self.taste), self.state, self.seed)
        no_call = Model()
        result = self.reflect(no_call, resume_job_id=partial['job_id'])
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['summary_status'], 'current')
        self.assertEqual(no_call.calls, [])

    def test_long_context_only_role_reply_is_excerpted_without_rejecting_short_user_text(self):
        story = []
        for turn in range(16):
            story.extend([{'role': 'user', 'text': f'第{turn + 1}轮：继续平静的探索。'},
                          {'role': 'char', 'text': '冗长的辅助角色正文' * 10000}])
        model = Model('NONE')
        result = self.reflect(model, story=story)
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(result['processed']['from_user_turn'], 2)
        self.assertLessEqual(result['processed']['input_bytes'], result['processed']['input_budget_bytes'])
        self.assertNotIn('冗长的辅助角色正文' * 10000, json.dumps(model.calls, ensure_ascii=False))
        self.assertIn('第2轮：继续平静的探索。', json.dumps(model.calls, ensure_ascii=False))

    def test_saved_summary_cannot_finish_until_nora_memory_projection_recovers(self):
        profile.ensure_profile(self.state, self.seed)
        taste = {key: [] for key in profile.TASTE_PROFILE_V2_FIELDS}
        taste['story_tastes'] = ['总结投影标记']
        original_sync = profile.sync_hermes_memories
        def fail_summary_projection(current, *args, **kwargs):
            if current.get('taste_profile_v2', {}).get('story_tastes') == ['总结投影标记']:
                raise OSError('injected summary projection failure')
            return original_sync(current, *args, **kwargs)
        with patch.object(profile, 'sync_hermes_memories', side_effect=fail_summary_projection):
            first = self.reflect(Model(self.extraction, json.dumps(taste, ensure_ascii=False)))
            self.assertEqual(first['code'], 'STORY_PROFILE_PROJECTION_PENDING')
            no_call = Model()
            still_pending = self.reflect(no_call, resume_job_id=first['job_id'])
        self.assertEqual(still_pending['status'], 'partial', still_pending)
        self.assertEqual(still_pending['code'], 'STORY_PROFILE_PROJECTION_PENDING')
        self.assertEqual(no_call.calls, [])
        no_call = Model()
        recovered = self.reflect(no_call, resume_job_id=first['job_id'])
        self.assertEqual(recovered['status'], 'completed', recovered)
        self.assertEqual(no_call.calls, [])
        self.assertIn('总结投影标记', (self.root / 'memories/USER.md').read_text(encoding='utf-8'))
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 1)

    def test_new_preference_during_local_recovery_cannot_confirm_an_old_summary(self):
        first = self.reflect(Model(self.extraction, 'not JSON'))
        reflection.refresh_taste_profile(profile, Model(self.taste), self.state, self.seed)
        original_recover = profile.recover_profile
        def concurrent_learning(*args, **kwargs):
            profile.record_learning(self.state, self.seed, '也喜欢安静的日常探索', 'concurrent explicit choice')
            return original_recover(*args, **kwargs)
        no_call = Model()
        with patch.object(profile, 'recover_profile', side_effect=concurrent_learning):
            pending = self.reflect(no_call, resume_job_id=first['job_id'])
        self.assertEqual(pending['status'], 'partial', pending)
        self.assertEqual(pending['code'], 'STORY_PROFILE_SUMMARY_STALE')
        self.assertEqual(no_call.calls, [])
        self.assertTrue(profile.load_profile(self.state, self.seed)['taste_profile_stale'])
        summary_only = Model(self.taste)
        recovered = self.reflect(summary_only, resume_job_id=first['job_id'])
        self.assertEqual(recovered['status'], 'completed', recovered)
        self.assertEqual(len(summary_only.calls), 1)
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 2)


if __name__ == '__main__':
    unittest.main()
