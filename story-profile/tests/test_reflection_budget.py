"""Exercise the real HTTP payload and both reflection stages without network calls."""
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
import story_profile


class ReflectionBudget(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='nora-reflection-budget-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.seed = self.root / 'seed.md'
        self.seed.write_text('# 身份\n测试\n# 我对你的了解\n（无）\n# 成长记\n（无）\n')
        env = patch.dict(os.environ, {
            'TAVERN_HERMES_MEMORIES_DIR': str(self.root / 'memories'),
            'TAVERN_HERMES_STATE_DB': str(self.root / 'state.db'),
        })
        env.start()
        self.addCleanup(env.stop)
        self.budgets = []
        self.taste = {key: [] for key in story_profile.TASTE_PROFILE_V2_FIELDS}
        self.taste['narrative_habits'] = ['缓慢建立信任']

    def client(self, budget):
        config = {'base_url': 'https://offline.invalid/v1', 'model': 'fixture'}
        if budget is not None:
            config['max_tokens'] = budget
        return reflection.OpenAICompatibleModelClient(config)

    def response(self, request, **_kwargs):
        body = json.loads(request.data)
        self.budgets.append(body['max_tokens'])
        is_taste = 'story_tastes=' in body['messages'][0]['content']
        content = json.dumps(self.taste) if is_taste else json.dumps({'preferences': [{'text': '偏好慢慢建立信任，不喜欢突然进入亲密关系', 'evidence_ids': ['m0', 'm1']}]})
        return io.BytesIO(json.dumps({'choices': [{'message': {'content': content}}]}).encode())

    def test_saved_output_budget_is_not_silently_capped(self):
        for configured, expected in [(4000, 4000), (8000, 8000), (1024, 1024), (None, 1600)]:
            with self.subTest(configured=configured):
                with patch.object(reflection.urllib.request.OpenerDirector, 'open', side_effect=self.response):
                    self.client(configured).complete([{'role': 'user', 'content': 'offline request'}])
                self.assertEqual(self.budgets[-1], expected)

    def test_explicit_temperature_is_preserved_without_allowing_task_or_budget_override(self):
        for envelope, extra, expected in (({}, {}, 0.2), ({}, {'temperature': 1}, 1), ({'temperature': 0.7}, {'temperature': 1}, 0.7)):
            with self.subTest(envelope=envelope, extra=extra):
                client = self.client(4000)
                client.config.update(envelope, body_parameters={**extra, 'model': 'wrong', 'messages': [], 'max_tokens': 1})
                sent = []
                def response(request, **_kwargs):
                    sent.append(json.loads(request.data))
                    return io.BytesIO(json.dumps({'choices': [{'message': {'content': 'NONE'}}]}).encode())
                messages = [{'role': 'user', 'content': 'task'}]
                with patch.object(reflection.urllib.request.OpenerDirector, 'open', side_effect=response):
                    client.complete(messages)
                self.assertEqual(sent[0]['temperature'], expected)
                self.assertEqual(sent[0]['model'], 'fixture')
                self.assertEqual(sent[0]['messages'], messages)
                self.assertEqual(sent[0]['max_tokens'], 4000)

    def test_tavern_direct_route_never_reads_ambient_system_proxy(self):
        with patch.object(reflection.urllib.request, 'getproxies', side_effect=AssertionError('Do not read WinINET')), \
                patch.object(reflection.urllib.request.OpenerDirector, 'open', side_effect=self.response):
            self.client(4000).complete([{'role': 'user', 'content': 'offline'}])
        self.assertEqual(self.budgets, [4000])

    def test_explicit_http_proxy_and_provider_exclusions_are_preserved(self):
        client = self.client(4000)
        client.config.update(proxy_url='http://127.0.0.1:17897', body_parameters={'max_completion_tokens': 1, 'provider_option': 'kept'}, exclude_body=['temperature', 'max_tokens'])
        original = reflection.urllib.request.build_opener
        selected = []
        sent = []
        def build(handler):
            selected.append(handler.proxies)
            return original(handler)
        def response(request, **_kwargs):
            sent.append(json.loads(request.data))
            return io.BytesIO(json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': 'NONE'}}]}).encode())
        with patch.object(reflection.urllib.request, 'build_opener', side_effect=build), \
                patch.object(reflection.urllib.request.OpenerDirector, 'open', side_effect=response):
            client.complete([{'role': 'user', 'content': 'offline'}])
        self.assertEqual(selected, [{'http': client.config['proxy_url'], 'https': client.config['proxy_url']}])
        self.assertNotIn('temperature', sent[0])
        self.assertNotIn('max_tokens', sent[0])
        self.assertEqual(sent[0]['max_completion_tokens'], 4000)
        self.assertEqual(sent[0]['provider_option'], 'kept')

    def test_unsupported_proxy_is_explicit_and_cannot_silently_bypass(self):
        client = self.client(4000)
        client.config['proxy_url'] = 'socks5://127.0.0.1:17897'
        with patch.object(reflection.urllib.request.OpenerDirector, 'open') as request:
            with self.assertRaises(reflection.StoryProfileReflectionError) as raised:
                client.complete([{'role': 'user', 'content': 'offline'}])
        self.assertEqual(raised.exception.code, 'STORY_PROFILE_PROXY_UNSUPPORTED')
        request.assert_not_called()

    def test_selected_proxy_cannot_be_bypassed_by_windows_registry_rules(self):
        request = reflection.urllib.request.Request('https://model.invalid/v1/chat/completions')
        proxy = 'http://127.0.0.1:17897'
        handler = reflection.TavernProxyHandler({'https': proxy})
        with patch.object(reflection.urllib.request, 'proxy_bypass', side_effect=AssertionError('Tavern already resolved bypass')):
            handler.proxy_open(request, proxy, 'https')
        self.assertEqual(request.host, '127.0.0.1:17897')
        self.assertEqual(request._tunnel_host, 'model.invalid')

    def test_extraction_and_taste_summary_follow_budget_and_preserve_old_preferences(self):
        state = self.root / 'profile'
        story_profile.record_learning(state, self.seed, '喜欢悬疑题材', 'existing preference', source_type='explicit')
        before = story_profile.load_profile(state, self.seed)
        old_ids = {item['id'] for item in before['preferences']}
        context = {'world_id': 'offline', 'world_name': 'offline', 'card': {'name': '角色'},
                   'story': [{'role': 'user', 'text': '慢一点发展关系'}, {'role': 'user', 'text': '请保留克制与留白'}]}
        with patch.object(reflection.urllib.request.OpenerDirector, 'open', side_effect=self.response):
            result = reflection.reflect_context(story_profile, self.client(4000), state, self.seed, context, write=True)
        after = story_profile.load_profile(state, self.seed)
        self.assertEqual(self.budgets, [4000, 4000])
        self.assertTrue(result['written'])
        self.assertTrue(old_ids.issubset({item['id'] for item in after['preferences']}))
        self.assertEqual(after['stats']['event_count'], before['stats']['event_count'] + 1)
        self.assertFalse(after['taste_profile_stale'])
        self.assertEqual(after['taste_profile_v2']['narrative_habits'], ['缓慢建立信任'])

    def test_retry_of_saved_preferences_refreshes_taste_without_duplicate_event(self):
        state = self.root / 'profile'
        addition = '偏好慢慢建立信任，不喜欢突然进入亲密关系'
        story_profile.record_learning(state, self.seed, addition, 'already saved', source_type='reflection')
        before = story_profile.load_profile(state, self.seed)
        with patch.object(reflection.urllib.request.OpenerDirector, 'open', side_effect=self.response):
            reflection.refresh_taste_profile(story_profile, self.client(4000), state, self.seed)
        after = story_profile.load_profile(state, self.seed)
        self.assertEqual(self.budgets, [4000])
        self.assertEqual(after['stats']['event_count'], before['stats']['event_count'])
        self.assertEqual(after['preferences'], before['preferences'])
        self.assertFalse(after['taste_profile_stale'])


if __name__ == '__main__':
    unittest.main()
