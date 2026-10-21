"""Automatic requests re-read saved choices; manual authorization is independent."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'core'))
import reflection
import story_profile as profile

spec = importlib.util.spec_from_file_location('nora_preference_guard_cli', ROOT / 'adapters/nora/cli.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class AutomaticPreferenceGuard(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='nora-automatic-guard-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / 'profile'
        self.state.mkdir()
        self.legacy = self.root / 'default-user/story_profile_preferences.json'
        self.legacy.parent.mkdir()
        self.settings = self.state / 'story_profile_preference_settings.json'
        self.seed = self.root / 'actor.md'
        self.seed.write_text('# 合成测试\n', encoding='utf-8')
        environment = patch.dict(os.environ, {'TAVERN_HERMES_MEMORIES_DIR': str(self.root / 'memories'),
                                             'TAVERN_HERMES_STATE_DB': str(self.root / 'state.db')})
        environment.start()
        self.addCleanup(environment.stop)
        state = patch.object(cli, 'STATE_DIR', self.state)
        state.start()
        self.addCleanup(state.stop)
        self.context = {'world_id': 'w', 'session_id': 's', 'revision': 'r', 'world_name': '测试世界',
                        'story': [{'role': 'user', 'text': '我喜欢悬疑题材，请记住这个偏好。'},
                                  {'role': 'char', 'text': '好的。'},
                                  {'role': 'user', 'text': '后续也请采用悬疑题材。'}]}
        self.extraction = json.dumps({'preferences': [{'text': '偏爱悬疑题材', 'evidence_ids': ['m0', 'm2']}]}, ensure_ascii=False)
        self.summary = json.dumps({key: ['偏爱悬疑题材'] if key == 'story_tastes' else [] for key in profile.TASTE_PROFILE_V2_FIELDS}, ensure_ascii=False)

    def model(self, responses, *, automatic=True, after_dispatch=None):
        owner = self

        class Fake:
            config = {'model': 'offline', 'max_tokens': 4000, 'context_tokens': 32000}
            last_response = None

            def __init__(self):
                self.calls = []

            def complete(self, messages):
                self.calls.append(messages)
                self.last_response = {'usage': {'completion_tokens': len(self.calls)}}
                if after_dispatch:
                    after_dispatch(len(self.calls))
                return responses.pop(0)

        client = Fake()
        payload = {'model': {'offline': True}}
        if automatic:
            payload['automatic_preference_file'] = str(owner.legacy)
        with patch.object(reflection, 'OpenAICompatibleModelClient', return_value=client):
            return cli._model(payload), client

    def test_close_during_extraction_keeps_its_result_but_prevents_a_new_summary_request(self):
        self.settings.write_text(json.dumps({'auto_enabled': True}), encoding='utf-8')

        def close(_count):
            self.settings.write_text(json.dumps({'auto_enabled': False}), encoding='utf-8')

        guarded, client = self.model([self.extraction, self.summary], after_dispatch=close)
        result = reflection.reflect_context(profile, guarded, self.state, self.seed, self.context, write=True)
        self.assertEqual(len(client.calls), 1)
        self.assertTrue(result['extraction_complete'])
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['code'], 'STORY_PROFILE_AUTO_REFLECTION_DISABLED')
        saved = profile.load_profile(self.state, self.seed)
        self.assertEqual(profile.preference_texts(saved), ['偏爱悬疑题材'])
        self.assertEqual(saved['stats']['event_count'], 1)
        self.assertIs(guarded.config, client.config)
        self.assertEqual(guarded.last_response, client.last_response)

        # A separately authorized manual continuation may finish the pending
        # summary while off, without extracting or learning the preference again.
        manual, resumed = self.model([self.summary], automatic=False)
        completed = reflection.reflect_context(profile, manual, self.state, self.seed,
                                               {**self.context, 'resume_job_id': result['job_id']}, write=True)
        self.assertEqual(len(resumed.calls), 1)
        self.assertEqual(completed['status'], 'completed')
        self.assertEqual(profile.load_profile(self.state, self.seed)['stats']['event_count'], 1)
        self.assertFalse(json.loads(self.settings.read_text())['auto_enabled'])

    def test_unknown_current_or_legacy_records_never_dispatch_as_the_enabled_default(self):
        for source in [self.settings, self.legacy]:
            for content in ['null', '[]', 'false', '{broken',
                            '{"auto_enabled":"false"}' if source == self.settings else '{"automatic_reflection":{"enabled":"false"}}',
                            '{"auto_enabled":true,"extra":NaN}' if source == self.settings else '{"automatic_reflection":{"enabled":true},"extra":Infinity}']:
                with self.subTest(source=source.name, content=content):
                    source.write_text(content, encoding='utf-8')
                    model, client = self.model(['NONE'])
                    with self.assertRaises(reflection.StoryProfileReflectionError) as raised:
                        model.complete([{'role': 'user', 'content': 'fixture'}])
                    self.assertEqual(raised.exception.code, 'STORY_PROFILE_SETTINGS_UNREADABLE')
                    self.assertEqual(client.calls, [])
                    self.assertEqual(source.read_text(encoding='utf-8'), content)
                    source.unlink()

    def test_legacy_utf8_bom_choices_match_the_node_reader(self):
        for enabled in [False, True]:
            with self.subTest(enabled=enabled):
                self.legacy.write_bytes(b'\xef\xbb\xbf' + json.dumps({'automatic_reflection': {'enabled': enabled}}).encode('utf-8'))
                model, client = self.model(['NONE'])
                if enabled:
                    self.assertEqual(model.complete([{'role': 'user', 'content': 'fixture'}]), 'NONE')
                    self.assertEqual(len(client.calls), 1)
                else:
                    with self.assertRaises(reflection.StoryProfileReflectionError) as raised:
                        model.complete([{'role': 'user', 'content': 'fixture'}])
                    self.assertEqual(raised.exception.code, 'STORY_PROFILE_AUTO_REFLECTION_DISABLED')
                    self.assertEqual(client.calls, [])


if __name__ == '__main__':
    unittest.main()
