"""Authoritative profile preservation and replay contracts, using temporary data."""
from contextlib import closing
import json
import os
from pathlib import Path
import subprocess
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

CORE = Path(__file__).resolve().parents[1] / 'core'
sys.path.insert(0, str(CORE))
import story_profile as profile
import reflection


class ScriptedModel:
    config = {'base_url': 'https://offline.invalid/v1', 'model': 'offline', 'max_tokens': 4000, 'context_tokens': 32000}

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def complete(self, messages):
        self.calls.append(messages)
        if not isinstance(messages, list):
            raise AssertionError('A model request must have prepared messages.')
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


class StorageReliability(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nora-profile-storage-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / '故事档案（保留数据）'
        self.seed = self.root / 'seed.md'
        self.seed.write_text('# 测试身份\n', encoding='utf-8')
        self.environment = patch.dict(os.environ, {
            'TAVERN_HERMES_MEMORIES_DIR': str(self.root / 'memories'),
            'TAVERN_HERMES_STATE_DB': str(self.root / 'state.db'),
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        profile.ensure_profile(self.state, self.seed)

    def learn(self, text, **kwargs):
        return profile.record_learning(self.state, self.seed, text, 'test source', **kwargs)

    def context(self, **extra):
        return {'world_id': 'w', 'session_id': 's', 'revision': 'r1', 'world_name': '临时世界',
                'story': [{'id': 'a', 'role': 'user', 'text': '我喜欢侦探题材。'},
                          {'id': 'b', 'role': 'char', 'text': '我们会展开侦探故事。'},
                          {'id': 'c', 'role': 'user', 'text': '请记住我偏爱侦探题材。'}], **extra}

    def extraction(self):
        return json.dumps({'preferences': [{'text': '偏爱侦探题材', 'evidence_ids': ['m0', 'm2']}]}, ensure_ascii=False)

    def summary(self):
        return json.dumps({key: ['侦探题材'] if key == 'story_tastes' else [] for key in profile.TASTE_PROFILE_V2_FIELDS}, ensure_ascii=False)

    def reflect(self, model, **extra):
        return reflection.reflect_context(profile, model, self.state, self.seed, self.context(**extra), write=True)

    def test_actual_reflection_persists_only_the_matching_user_evidence(self):
        result = self.reflect(ScriptedModel(self.extraction(), self.summary()))
        self.assertEqual(result['status'], 'completed')
        current = profile.load_profile(self.state, self.seed)
        self.assertEqual([e['message_id'] for e in current['preferences'][0]['evidence']], ['a', 'c'])
        self.assertTrue(all(e['world_id'] == 'w' and e['session_id'] == 's' for e in current['preferences'][0]['evidence']))

    def test_committed_projection_failure_is_partial_and_resume_never_extracts_twice(self):
        model = ScriptedModel(self.extraction(), self.summary())
        with patch.object(profile, 'sync_hermes_memories', side_effect=OSError('fixture projection failure')):
            first = self.reflect(model)
        self.assertEqual(first['status'], 'partial')
        self.assertTrue(first['extraction_complete'])
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 1)
        self.assertTrue(first['summary_saved'])
        self.assertEqual(len(model.calls), 2)
        retry = ScriptedModel()
        result = self.reflect(retry, resume_job_id=first['job_id'])
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(retry.calls), 0)
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 1)

    def test_locked_prompt_cache_reports_partial_and_job_resume_never_calls_model(self):
        database = self.root / 'state.db'
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute('CREATE TABLE sessions(id INTEGER PRIMARY KEY, source TEXT, ended_at INTEGER, system_prompt TEXT)')
            connection.execute('INSERT INTO sessions(source,ended_at,system_prompt) VALUES(?,?,?)',
                               ('clawchat', None, profile.MEMORY_START + ' synthetic plot ' + profile.MEMORY_END))
        writer = sqlite3.connect(database)
        self.addCleanup(writer.close)
        writer.execute('BEGIN IMMEDIATE')
        model = ScriptedModel(self.extraction(), self.summary())
        try:
            first = self.reflect(model)
        finally:
            writer.rollback()
        self.assertFalse(first['ok'])
        self.assertEqual(first['status'], 'partial')
        self.assertEqual(first['code'], 'STORY_PROFILE_PROMPT_CACHE_PENDING')
        self.assertTrue(first['summary_saved'])
        self.assertEqual(first['projections']['user']['status'], 'complete')
        self.assertEqual(first['projections']['memory']['status'], 'complete')
        self.assertEqual(len(model.calls), 2)
        before = {name: (self.state / name).read_bytes()
                  for name in (profile.PROFILE_FILENAME, profile.EVENTS_FILENAME)}
        retry = ScriptedModel()
        result = self.reflect(retry, resume_job_id=first['job_id'])
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['projections']['prompt_cache']['status'], 'complete')
        self.assertEqual(retry.calls, [])
        self.assertEqual({name: (self.state / name).read_bytes() for name in before}, before)

    def test_failed_extraction_can_retry_with_its_validated_original_context(self):
        first = self.reflect(ScriptedModel(reflection.StoryProfileReflectionError('denied', code='STORY_PROFILE_PROVIDER_DENIED')))
        retry = ScriptedModel(self.extraction(), self.summary())
        result = self.reflect(retry, resume_job_id=first['job_id'], retry=True)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(retry.calls), 2)
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 1)

    def test_summary_resume_after_chat_changed_uses_saved_preferences_only(self):
        first = self.reflect(ScriptedModel(self.extraction(), 'invalid summary'))
        retry = ScriptedModel(self.summary())
        result = self.reflect(retry, resume_job_id=first['job_id'], story=[], revision='r2')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['processed']['revision'], 'r1')
        self.assertEqual(len(retry.calls), 1)
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 1)

    def test_process_exit_during_extraction_does_not_auto_replay(self):
        with self.assertRaises(SystemExit):
            self.reflect(ScriptedModel(SystemExit('fixture process interruption')))
        retry = ScriptedModel()
        result = self.reflect(retry)
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['extraction_complete'])
        self.assertEqual(retry.calls, [])
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 0)

    def test_process_exit_during_summary_preserves_learning_and_requires_explicit_retry(self):
        with self.assertRaises(SystemExit):
            self.reflect(ScriptedModel(self.extraction(), SystemExit('fixture summary interruption')))
        job_id = next((self.state / 'story_profile_jobs').glob('reflect_*.json')).stem
        reconnect = ScriptedModel()
        result = self.reflect(reconnect, resume_job_id=job_id)
        self.assertTrue(result['extraction_complete'])
        self.assertEqual(result['code'], 'STORY_PROFILE_OUTCOME_UNKNOWN')
        self.assertEqual(reconnect.calls, [])
        retry = ScriptedModel(self.summary())
        result = self.reflect(retry, resume_job_id=job_id, retry=True)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(retry.calls), 1)
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 1)

    def test_malformed_job_document_cannot_write_unevidenced_preferences(self):
        first = self.reflect(ScriptedModel(reflection.StoryProfileReflectionError('denied', code='STORY_PROFILE_PROVIDER_DENIED')))
        path = self.state / 'story_profile_jobs' / (first['job_id'] + '.json')
        path.write_text(json.dumps({'world_id': 'w', 'texts': ['没有用户依据的偏好'], 'stage': 'extracted'}), encoding='utf-8')
        retry = ScriptedModel(self.summary())
        result = self.reflect(retry, resume_job_id=first['job_id'])
        self.assertFalse(result['extraction_complete'])
        self.assertEqual(retry.calls, [])
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 0)

    def test_existing_empty_job_is_corruption_not_permission_to_repeat_model_call(self):
        first = self.reflect(ScriptedModel(reflection.StoryProfileReflectionError('denied', code='STORY_PROFILE_PROVIDER_DENIED')))
        path = self.state / 'story_profile_jobs' / (first['job_id'] + '.json')
        path.write_text('{}', encoding='utf-8')
        retry = ScriptedModel(self.extraction(), self.summary())
        result = self.reflect(retry)
        self.assertFalse(result['extraction_complete'])
        self.assertEqual(retry.calls, [])
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 0)

    def test_retry_of_failed_extraction_does_not_reuse_old_job_for_changed_chat(self):
        first = self.reflect(ScriptedModel(reflection.StoryProfileReflectionError('denied', code='STORY_PROFILE_PROVIDER_DENIED')))
        changed = [{'id': 'new-a', 'role': 'user', 'text': '我喜欢科幻题材。'},
                   {'id': 'new-b', 'role': 'user', 'text': '请记住我喜欢科幻题材。'}]
        extraction = json.dumps({'preferences': [{'text': '偏爱科幻题材', 'evidence_ids': ['m0', 'm1']}]}, ensure_ascii=False)
        retry = ScriptedModel(extraction, self.summary())
        result = self.reflect(retry, resume_job_id=first['job_id'], retry=True, revision='r2', story=changed)
        self.assertFalse(result['extraction_complete'])
        self.assertEqual(retry.calls, [])
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 0)

    def test_summary_with_concurrent_learning_stays_partial_then_resumes_latest_source(self):
        owner = self
        class ConcurrentModel(ScriptedModel):
            def complete(self, messages):
                if len(self.calls) == 1:
                    owner.learn('希望叙述保持第一人称', source_id='concurrent-source', ts=200)
                return super().complete(messages)
        result = self.reflect(ConcurrentModel(self.extraction(), self.summary()))
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['code'], 'STORY_PROFILE_SUMMARY_STALE')
        self.assertTrue(result['extraction_complete'])
        current = profile.load_profile(self.state, self.seed)
        self.assertTrue(current['taste_profile_stale'])
        self.assertEqual(current['stats']['event_count'], 2)
        retry = ScriptedModel(self.summary())
        recovered = self.reflect(retry, resume_job_id=result['job_id'])
        self.assertEqual(recovered['status'], 'completed')
        self.assertEqual(len(retry.calls), 1)
        self.assertIn('希望叙述保持第一人称', retry.calls[0][1]['content'])
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 2)

    def test_public_recovery_completes_pending_journal_and_projection_without_model(self):
        self.learn('偏爱侦探题材', ts=100)
        write = profile._atomic_text
        armed = True
        def interrupted(path, text):
            nonlocal armed
            if path.name == profile.PROFILE_FILENAME and armed:
                armed = False
                raise OSError('fixture process interruption')
            return write(path, text)
        with patch.object(profile, '_atomic_text', side_effect=interrupted):
            with self.assertRaises(OSError):
                self.learn('希望叙述保持第一人称', source_id='recover-public', ts=200)
        self.assertTrue((self.state / profile.COMMIT_FILENAME).exists())
        recovered = profile.recover_profile(self.state, self.seed)
        self.assertFalse((self.state / profile.COMMIT_FILENAME).exists())
        self.assertEqual(recovered['stats']['event_count'], 2)
        self.assertEqual(len(profile.preference_texts(recovered)), 2)
        self.assertIn('希望叙述保持第一人称', (self.state / 'actor_self.md').read_text(encoding='utf-8'))

    def test_prompt_cache_connection_is_closed_after_transaction(self):
        database = self.root / 'state.db'
        connection = sqlite3.connect(database)
        connection.execute('CREATE TABLE sessions(id INTEGER PRIMARY KEY, source TEXT, ended_at INTEGER, system_prompt TEXT)')
        connection.execute("INSERT INTO sessions(source,ended_at,system_prompt) VALUES('clawchat',NULL,'old')")
        connection.commit()
        class TrackedConnection:
            closed = False
            def __enter__(self):
                connection.__enter__()
                return self
            def __exit__(self, *arguments):
                return connection.__exit__(*arguments)
            def __getattr__(self, key):
                return getattr(connection, key)
            def close(self):
                self.closed = True
                connection.close()
        tracked = TrackedConnection()
        try:
            with patch.object(profile.sqlite3, 'connect', return_value=tracked):
                result = profile._invalidate_hermes_prompt_cache({'revision': 10}, database)
            self.assertTrue(result['checked'])
            self.assertTrue(tracked.closed, 'transaction completion must release the native SQLite handle')
        finally:
            connection.close()

    def test_corrupt_events_abort_without_replacing_any_history(self):
        self.learn('偏爱侦探题材', ts=100)
        path = self.state / profile.EVENTS_FILENAME
        path.write_text(path.read_text(encoding='utf-8') + '{invalid json\n', encoding='utf-8')
        before = {p.name: p.read_bytes() for p in self.state.iterdir() if p.is_file()}
        with self.assertRaisesRegex(Exception, 'profile_events.jsonl'):
            self.learn('希望叙述保持第一人称', ts=200)
        after = {p.name: p.read_bytes() for p in self.state.iterdir() if p.is_file()}
        self.assertEqual(before, after)

    def test_corrupt_profile_is_not_remigrated_from_markdown(self):
        self.learn('偏爱侦探题材', ts=100)
        path = self.state / profile.PROFILE_FILENAME
        path.write_text('{broken', encoding='utf-8')
        events_before = (self.state / profile.EVENTS_FILENAME).read_bytes()
        with self.assertRaisesRegex(Exception, 'story_profile.json'):
            profile.load_profile(self.state, self.seed)
        self.assertEqual(path.read_text(encoding='utf-8'), '{broken')
        self.assertEqual((self.state / profile.EVENTS_FILENAME).read_bytes(), events_before)

    def test_missing_event_archive_is_not_treated_as_new_install(self):
        self.learn('偏爱侦探题材', ts=100)
        (self.state / profile.EVENTS_FILENAME).unlink()
        with self.assertRaisesRegex(Exception, 'profile_events.jsonl'):
            self.learn('希望叙述保持第一人称', ts=200)

    def test_opposite_or_similar_text_cannot_overwrite_locked_preference(self):
        self.learn('喜欢慢热', source_type='explicit', ts=100)
        initial = profile.load_profile(self.state, self.seed)
        identifier = initial['preferences'][0]['id']
        profile.update_preference(self.state, self.seed, identifier, locked=True)
        self.learn('不喜欢慢热', source_id='opposite', ts=200)
        result = profile.load_profile(self.state, self.seed)
        self.assertEqual(profile.preference_texts(result), ['喜欢慢热'])
        self.assertTrue(result['preferences'][0]['locked'])
        candidates = [p for p in result['preferences'] if p['status'] == 'candidate']
        self.assertEqual([p['text'] for p in candidates], ['不喜欢慢热'])
        self.assertEqual(candidates[0]['conflicts_with'], [identifier])
        self.assertTrue(profile.learning_receipt(self.state, 'opposite')['review_required'])

    def test_source_replay_keeps_original_event_and_does_not_learn_again(self):
        _, first = self.learn('偏爱侦探题材', source_id='world:session:range', evidence=[{'message_id': 'm1'}], ts=100)
        before = profile.load_profile(self.state, self.seed)
        _, replay = self.learn('希望叙述保持第一人称', source_id='world:session:range', ts=200)
        after = profile.load_profile(self.state, self.seed)
        self.assertEqual(first['id'], replay['id'])
        self.assertEqual(before, after)
        self.assertEqual(len(profile._read_events(self.state / profile.EVENTS_FILENAME)), 1)
        self.assertEqual(profile.learning_receipt(self.state, 'world:session:range')['event_id'], first['id'])

    def test_summary_rejects_outdated_preference_snapshot(self):
        self.learn('偏爱侦探题材', ts=100)
        old = profile.load_profile(self.state, self.seed)
        revision = profile.preference_revision(old)
        self.learn('希望叙述保持第一人称', ts=200)
        with self.assertRaisesRegex(Exception, 'changed|变化|过期'):
            profile.set_taste_profile(self.state, self.seed, {'story_themes': ['侦探']}, expected_revision=revision)
        current = profile.load_profile(self.state, self.seed)
        self.assertTrue(current['taste_profile_stale'])
        self.assertEqual(len(profile.preference_texts(current)), 2)

    def test_plot_only_change_does_not_invalidate_preference_snapshot(self):
        self.learn('偏爱侦探题材', ts=100)
        revision = profile.preference_revision(profile.load_profile(self.state, self.seed))
        profile.sync_story_states(self.state, self.seed, [{'id': 'w', 'name': 'world', 'story_state': {'turns': 15, 'timeline': ['故事事件']}}])
        profile.set_taste_profile(self.state, self.seed, {'story_themes': ['侦探']}, expected_revision=revision)
        self.assertFalse(profile.load_profile(self.state, self.seed)['taste_profile_stale'])

    def test_interrupted_canonical_commit_recovers_without_losing_old_or_new_events(self):
        _, first = self.learn('偏爱侦探题材', ts=100)
        write = profile._atomic_text
        armed = True
        def fail_profile_once(path, content):
            nonlocal armed
            if path.name == profile.PROFILE_FILENAME and armed:
                armed = False
                raise OSError('fixture interrupted canonical profile write')
            return write(path, content)
        with patch.object(profile, '_atomic_text', side_effect=fail_profile_once):
            with self.assertRaises(OSError):
                self.learn('希望叙述保持第一人称', source_id='second', ts=200)
        restored = profile.load_profile(self.state, self.seed)
        events = profile._read_events(self.state / profile.EVENTS_FILENAME)
        self.assertEqual(restored['stats']['event_count'], 2)
        self.assertEqual(len(profile.preference_texts(restored)), 2)
        self.assertIn(first['id'], [e['id'] for e in events])
        self.assertIsNotNone(profile.learning_receipt(self.state, 'second'))

    def test_cross_process_writers_preserve_both_updates(self):
        child_code = '''
import pathlib,sys
sys.path.insert(0,sys.argv[1])
import story_profile as p
print('ready',flush=True)
p.record_learning(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),'偏爱侦探题材','child',source_id='child')
'''
        with profile._profile_lock(self.state):
            child = subprocess.Popen([sys.executable, '-B', '-c', child_code, str(CORE), str(self.state), str(self.seed)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'ready')
                with self.assertRaises(subprocess.TimeoutExpired):
                    child.wait(timeout=0.15)
                self.learn('希望叙述保持第一人称', source_id='parent')
            except BaseException:
                child.kill()
                child.communicate()
                raise
        output, errors = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, errors)
        result = profile.load_profile(self.state, self.seed)
        self.assertEqual(len(profile.preference_texts(result)), 2)
        self.assertEqual(result['stats']['event_count'], 2)

    def test_legacy_markdown_archive_survives_initial_migration_and_new_learning(self):
        legacy = self.root / 'legacy'
        legacy.mkdir()
        actor = legacy / 'actor_self.md'
        actor.write_text('# 人格\n测试身份\n# 我对你的了解\n- 喜欢慢热\n# 成长记\n- 2026-01-01 旧复盘 → 偏爱侦探\n# 共同经历（阶段摘要）\n- 更早的八十笔历史摘要\n# 私人附记\n这段也要保留。\n', encoding='utf-8')
        profile.ensure_profile(legacy, self.seed)
        profile.record_learning(legacy, self.seed, '希望叙述保持第一人称', 'new')
        rendered = actor.read_text(encoding='utf-8')
        self.assertIn('更早的八十笔历史摘要', rendered)
        self.assertIn('这段也要保留。', rendered)

    def test_projection_failure_is_a_committed_result_and_replay_repairs_it(self):
        with patch.object(profile, 'sync_hermes_memories', side_effect=OSError('fixture projection failure')):
            _, event = self.learn('偏爱侦探题材', source_id='projection-case', ts=100)
        pending = profile.projection_status(self.state)
        self.assertEqual(pending['status'], 'pending')
        self.assertEqual(pending['memory']['code'], 'STORY_PROFILE_PROJECTION_PENDING')
        receipt = profile.learning_receipt(self.state, 'projection-case')
        self.assertEqual(receipt['event_id'], event['id'])
        self.learn('偏爱侦探题材', source_id='projection-case', ts=200)
        value = profile.load_profile(self.state, self.seed)
        self.assertEqual(value['stats']['event_count'], 1)
        self.assertEqual(len(profile.preference_texts(value)), 1)

    def test_unrelated_edit_after_interruption_is_not_overwritten_by_recovery(self):
        self.learn('偏爱侦探题材', ts=100)
        write = profile._atomic_text
        def fail_profile(path, text):
            if path.name == profile.PROFILE_FILENAME:
                raise OSError('fixture interrupted commit')
            return write(path, text)
        with patch.object(profile, '_atomic_text', side_effect=fail_profile):
            with self.assertRaises(OSError):
                self.learn('希望叙述保持第一人称', ts=200)
        path = self.state / profile.PROFILE_FILENAME
        external = json.loads(path.read_text(encoding='utf-8'))
        external['private_note'] = 'changed outside pending commit'
        path.write_text(json.dumps(external, ensure_ascii=False), encoding='utf-8')
        before = path.read_bytes()
        with self.assertRaisesRegex(Exception, 'conflicts'):
            profile.load_profile(self.state, self.seed)
        self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
