"""Isolated consent/activation contract tests. No gateway or model is started."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

OPS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'updater'))
from activation import Activation, PROTOCOL, digest, implementation, read, source_from_env, write
from activation.gateway import Bridge, HermesAdapter
from update import Updater, plan_digest


class Fixture:
    def setup(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tavern-activation-test-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.root = self.home / 'tavern-updates-v2'
        self.transaction = self.root / 'review-fixture'
        self.transaction.mkdir(parents=True)
        target = self.home / 'apps/tavern-ops/updater/activation'
        shutil.copytree(OPS / 'updater/activation', target, ignore=shutil.ignore_patterns('__pycache__'))
        (self.home / 'AGENTS.md').write_text('new context')
        (self.home / 'config.yaml').write_text('plugins: {enabled: [tavern-update-activation]}\n')
        files = {'home/AGENTS.md': digest(self.home / 'AGENTS.md')}
        files.update({'ops/updater/activation/' + name: digest(target / name) for name in ('__init__.py', 'gateway.py')})
        self.plan = {'home': str(self.home), 'files': files, 'manifestSha256': 'a' * 64, 'versions': {'mcp': 'fixture'}}
        self.installed = {'transaction': self.transaction.name, 'planDigest': plan_digest(self.plan),
                          'manifestSha256': self.plan['manifestSha256'], 'files': files}
        write(self.transaction / 'plan.json', self.plan)
        write(self.transaction / 'receipt.json', {'status': 'installed-awaiting-hermes-reload'})
        write(self.root / 'installed.json', self.installed)
        write(self.root / 'activation-gateway.json', {'protocol': PROTOCOL, 'pid': os.getpid(),
              'instance': 'live-bridge', 'implementation': implementation(target)})
        self.source = {'platform': 'clawchat', 'chat_id': 'chat-owner', 'user_id': 'owner',
                       'thread_id': '', 'key': 'session-key', 'id': 'old-session', 'message_id': 'request-message'}
        self.state = Activation(self.home, clock=lambda: 1000)

    def pending(self):
        record = self.state.request(self.source)
        record['status'] = 'awaiting-confirmation'
        write(self.transaction / 'activation.json', record)
        return record


class ConsentTests(Fixture, unittest.TestCase):
    def setUp(self):
        self.setup()

    def test_request_is_not_consent_and_has_no_cli_confirmation(self):
        record = self.state.request(self.source)
        self.assertEqual(record['status'], 'queued')
        self.assertNotIn('confirmationMessageId', record)
        self.assertEqual(self.state.request(self.source)['requestId'], record['requestId'])

    def test_owner_session_message_and_expiry_are_all_required(self):
        for key in ('platform', 'user_id', 'chat_id', 'thread_id', 'key', 'id'):
            record = self.pending()
            source = {**self.source, key: 'another', 'message_id': 'confirmation'}
            self.assertIsNone(self.state.decide(record, source, '确定', authorized=True), key)
        record = self.pending()
        source = {**self.source, 'message_id': 'confirmation'}
        self.assertIsNone(self.state.decide(record, source, '确定', authorized=False))
        self.assertIsNone(self.state.decide(record, self.source, '确定', authorized=True))
        self.assertEqual(self.state.decide(record, source, '确定', authorized=True), 'activating')
        self.assertIsNone(self.state.decide(record, source, '确定', authorized=True))
        record = self.pending()
        self.state.clock = lambda: 1601
        self.assertEqual(self.state.decide(record, source, '确定', authorized=True), 'expired')

    def test_other_reply_cancels_not_hidden_global_yes_trigger(self):
        record = self.pending()
        self.assertEqual(self.state.decide(record, {**self.source, 'message_id': 'next'}, '先聊别的', authorized=True), 'cancelled')
        self.assertIsNone(self.state.decide(record, {**self.source, 'message_id': 'later'}, '确定', authorized=True))

    def test_bootstrap_requires_a_loaded_matching_gateway_bridge(self):
        (self.root / 'activation-gateway.json').unlink()
        with self.assertRaisesRegex(ValueError, 'not loaded'):
            self.state.request(self.source)
        write(self.root / 'activation-gateway.json', {'protocol': 999})
        with self.assertRaisesRegex(ValueError, 'not loaded'):
            self.state.request(self.source)
        self.assertFalse((self.transaction / 'activation.json').exists())

    def test_rollback_or_changed_files_reject_activation(self):
        (self.home / 'AGENTS.md').write_text('changed after installation')
        with self.assertRaisesRegex(ValueError, 'files changed'):
            self.state.request(self.source)
        write(self.transaction / 'receipt.json', {'status': 'rolled-back'})
        with self.assertRaisesRegex(ValueError, 'successfully installed'):
            self.state.request(self.source)

    def test_rehearsal_and_forged_plan_fail_closed(self):
        plan = {**self.plan, 'testMode': True}
        write(self.transaction / 'plan.json', plan)
        with self.assertRaises(ValueError):
            self.state.request(self.source)

    def test_activation_and_update_share_lock(self):
        with self.state.lock():
            with self.assertRaises(BlockingIOError), Updater(self.home).lock():
                pass

    def test_disabled_plugin_cannot_activate_using_old_live_handshake(self):
        (self.home / 'config.yaml').write_text('plugins: {enabled: [], disabled: [tavern-update-activation]}\n')
        with self.assertRaisesRegex(ValueError, 'disabled'):
            self.state.request(self.source)
        self.assertFalse((self.transaction / 'activation.json').exists())

    def test_cli_requires_injected_context_and_has_no_identity_flags(self):
        with self.assertRaisesRegex(ValueError, 'session context'):
            source_from_env({})
        env = {'HERMES_SESSION_' + k.upper(): v for k, v in self.source.items()}
        self.assertEqual(source_from_env(env), self.source)

    def test_symlink_record_is_not_followed(self):
        other = self.home / 'other.json'
        other.write_text('{}')
        (self.transaction / 'activation.json').symlink_to(other)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.state.request(self.source)


class FakeAdapter:
    def __init__(self, source):
        self.source = source
        self.messages = []
        self.calls = []
        self.fail = None
        self.new_id = source['id']
        self.authorized = True

    def owner(self, source):
        return self.authorized and source.user_id == self.source['user_id']

    def event(self, source):
        return SimpleNamespace(source=SimpleNamespace(user_id=source['user_id']), text='',
                               identity=dict(source), message_id=source['message_id'], internal=False)

    def identity(self, event):
        return {**event.identity, 'id': self.new_id}

    async def send(self, event, text):
        if self.fail == 'notify' and self.new_id != self.source['id']:
            raise RuntimeError('delivery unavailable')
        self.messages.append(text)
        return 'sent-' + str(len(self.messages))

    async def idle(self, key):
        if self.fail == 'idle':
            raise TimeoutError('assistant turn did not finish')

    async def reload(self, event, plan):
        self.calls.append('reload')
        if self.fail == 'reload':
            raise RuntimeError('MCP offline')
        return {'gatewayMcpReloaded': True, 'skills': ['fixture']}

    async def reset(self, event):
        self.calls.append('reset')
        self.new_id = 'fresh-session'
        if self.fail == 'reset':
            raise RuntimeError('interrupted after reset')
        return self.new_id


class WorkflowTests(Fixture, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.setup()

    async def asyncSetUp(self):
        self.adapter = FakeAdapter(self.source)
        self.bridge = Bridge(self.home, self.adapter, asyncio.get_running_loop(), instance='live-bridge')
        self.bridge.state = self.state

    async def drain(self):
        await asyncio.sleep(0)
        while self.bridge.tasks:
            await asyncio.gather(*self.bridge.tasks)
            await asyncio.sleep(0)

    async def confirm(self):
        event = self.adapter.event({**self.source, 'message_id': 'confirm-message'})
        event.text = '确定'
        self.assertEqual(self.bridge.dispatch(event=event)['action'], 'skip')
        await self.drain()
        return event

    async def test_complete_flow_notifies_and_replay_does_not_reset_twice(self):
        record = self.state.request(self.source)
        await self.bridge.prompt(record['requestId'], self.source)
        self.assertEqual(self.state.status()['status'], 'awaiting-confirmation')
        self.assertEqual(self.adapter.calls, [])
        event = await self.confirm()
        result = self.state.status()
        self.assertEqual(result['status'], 'active')
        self.assertTrue(result['notified'])
        self.assertEqual(result['newSessionId'], 'fresh-session')
        self.assertEqual(self.adapter.calls, ['reload', 'reset'])
        self.assertEqual(self.bridge.dispatch(event=event)['action'], 'skip')
        await self.drain()
        self.assertEqual(self.adapter.calls, ['reload', 'reset'])
        self.assertEqual(read(self.transaction / 'receipt.json')['status'], 'installed-awaiting-hermes-reload')

    async def test_no_pending_request_leaves_ordinary_confirmation_alone(self):
        event = self.adapter.event({**self.source, 'message_id': 'ordinary'})
        event.text = '确定'
        self.assertIsNone(self.bridge.dispatch(event=event))

    async def test_failed_reload_never_resets_or_reports_success(self):
        self.pending()
        self.adapter.fail = 'reload'
        await self.confirm()
        self.assertEqual(self.state.status()['status'], 'failed')
        self.assertEqual(self.adapter.calls, ['reload'])

    async def test_idle_timeout_records_failure_and_releases_chat_guard(self):
        self.pending()
        self.adapter.fail = 'idle'
        await self.confirm()
        self.assertEqual(self.state.status()['status'], 'failed')
        self.assertFalse(self.bridge.busy)
        self.assertEqual(self.adapter.calls, [])

    async def test_failed_delivery_does_not_repeat_activation(self):
        self.pending()
        self.adapter.fail = 'notify'
        await self.confirm()
        self.assertEqual(self.state.status()['status'], 'active')
        self.assertFalse(self.state.status()['notified'])
        self.assertEqual(self.state.request(self.source)['status'], 'active')
        self.assertEqual(self.adapter.calls, ['reload', 'reset'])

    async def test_interrupted_reset_requires_review_not_automatic_replay(self):
        self.pending()
        self.adapter.fail = 'reset'
        await self.confirm()
        self.assertTrue(self.state.status()['resetReviewRequired'])
        with self.assertRaisesRegex(ValueError, 'interrupted'):
            self.state.request(self.source)

    async def test_busy_message_is_explicitly_reported_not_run_during_reset(self):
        self.pending()
        self.bridge.busy.add(self.source['key'])
        event = self.adapter.event({**self.source, 'message_id': 'another'})
        event.text = '请继续'
        self.assertEqual(self.bridge.dispatch(event=event)['action'], 'skip')
        await self.drain()
        self.assertIn('尚未处理', self.adapter.messages[-1])


class OwnerTests(unittest.TestCase):
    def test_only_real_owner_dm_passes(self):
        platform = SimpleNamespace(value='clawchat')
        # Use a hashable platform, just as Hermes Platform is.
        class Platform(str):
            value = 'clawchat'
        platform = Platform('clawchat')
        gateway = SimpleNamespace(adapters={platform: SimpleNamespace(_owner_user_id=lambda: 'owner')},
                                  _is_user_authorized=lambda source: True)
        adapter = HermesAdapter(gateway)
        source = SimpleNamespace(platform=platform, user_id='owner', chat_type='dm', is_bot=False)
        self.assertTrue(adapter.owner(source))
        for key, value in (('user_id', 'other'), ('chat_type', 'group'), ('is_bot', True)):
            self.assertFalse(adapter.owner(SimpleNamespace(**{**vars(source), key: value})))


class ConnectionProofTests(unittest.IsolatedAsyncioTestCase):
    async def test_old_connection_cannot_pass_as_reloaded_even_when_version_matches(self):
        import threading
        server = SimpleNamespace(session=object(), initialize_result=SimpleNamespace(serverInfo=SimpleNamespace(version='same')),
                                 _registered_tool_names=['nora_read'], _config={'args': ['/fixture/apps/nora-mcp/dist/server.js']})
        mcp = SimpleNamespace(_MCP_AVAILABLE=True, _servers={'nora': server}, _lock=threading.Lock())
        async def failed_reload(event):
            return 'reload failed'  # Native handler returns an error string, not an exception.
        gateway = SimpleNamespace(_execute_mcp_reload=failed_reload)
        with patch.dict(sys.modules, {'tools.mcp_tool': mcp}):
            with self.assertRaisesRegex(RuntimeError, 'fresh'):
                await HermesAdapter(gateway).reload(None, {'home': '/fixture', 'versions': {'mcp': 'same'}})


if __name__ == '__main__':
    unittest.main()
