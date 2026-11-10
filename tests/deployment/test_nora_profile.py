import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

from ops.installer import nora_profile as profile
from ops.installer.launcher_bridge import env_for

if __package__:
    from .core_test_environment import resolve_node
    from .core_fixture_lifecycle import owned_fixture_directory, require_fixture_closure
else:
    from core_test_environment import resolve_node
    from core_fixture_lifecycle import owned_fixture_directory, require_fixture_closure

class NoraProfileTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / '.env').write_text('CLAWCHAT_USER_ID=usr_test\n', encoding='utf-8')
        (self.home / 'config.yaml').write_text('{}', encoding='utf-8')
        self.before = {'id': 'usr_test', 'nickname': 'Hermes', 'avatar_url': ''}
        self.after = {**self.before, 'nickname': '诺拉', 'avatar_url': profile.AVATAR_URL}
        self.client = AsyncMock()
        self.client.get_my_profile.side_effect = [dict(self.before), dict(self.after)]
        self.client.get_agent_owner.return_value = {'user': {'locale': 'zh'}}

    async def _assert_patch_failure_outcome(self, failure, *, may_verify):
        profile.receipt_path(self.home).unlink(missing_ok=True)
        self.client.reset_mock()
        self.client.get_my_profile.side_effect = [dict(self.before), dict(self.after)]
        self.client.update_my_profile.side_effect = failure
        original_cause = failure.__cause__
        if may_verify:
            result = await profile.initialize(self.home, 'usr_test', self.client)
            self.assertTrue(result['ok'])
        else:
            with self.assertRaises(Exception) as failed:
                await profile.initialize(self.home, 'usr_test', self.client)
            self.assertIs(failed.exception, failure)
        self.assertIs(failure.__cause__, original_cause)
        self.assertEqual(self.client.get_my_profile.await_count, 2 if may_verify else 1)
        self.client.update_my_profile.assert_awaited_once()
        self.assertEqual(profile.ready(self.home), may_verify)

    async def test_first_connection_updates_both_fields_and_verifies(self):
        self.assertFalse(profile.ready(self.home))
        result = await profile.initialize(self.home, 'usr_test', self.client)
        self.assertTrue(result['ok'])
        self.client.update_my_profile.assert_awaited_once_with(nickname='诺拉', avatar_url=profile.AVATAR_URL)
        self.assertEqual(self.client.get_my_profile.await_count, 2)
        self.assertTrue(profile.ready(self.home))
        saved = json.loads(profile.receipt_path(self.home).read_text())
        self.assertEqual(set(saved), {'schema', 'userId', 'verified', 'nickname', 'avatar_url'})

    async def test_repeat_start_preserves_later_custom_profile_and_does_not_request_api(self):
        await profile.initialize(self.home, 'usr_test', self.client)
        self.client.reset_mock()
        result = await profile.initialize(self.home, 'usr_test', self.client)
        self.assertTrue(result['alreadyInitialized'])
        self.client.get_my_profile.assert_not_awaited()
        self.client.update_my_profile.assert_not_awaited()

    async def test_chinese_name_does_not_depend_on_owner_locale(self):
        for locale, nickname in [('en', '诺拉'), ('zh-Hant', '诺拉'), ('zh_CN', '诺拉'), ('', '诺拉')]:
            with self.subTest(locale=locale):
                profile.receipt_path(self.home).unlink(missing_ok=True)
                self.client.get_agent_owner.return_value = {'locale': locale}
                self.client.get_my_profile.side_effect = [self.before, {'user': {**self.after, 'nickname': nickname}}]
                await profile.initialize(self.home, 'usr_test', self.client)
                self.assertEqual(self.client.update_my_profile.call_args.kwargs['nickname'], nickname)
                self.client.get_agent_owner.assert_not_awaited()

    async def test_failed_update_does_not_record_success(self):
        self.client.update_my_profile.side_effect = RuntimeError('network failed')
        with self.assertRaisesRegex(RuntimeError, 'network failed'):
            await profile.initialize(self.home, 'usr_test', self.client)
        self.assertFalse(profile.ready(self.home))

    async def test_timed_out_patch_can_finish_only_after_the_existing_readback_confirms_it(self):
        class ClawChatApiError(RuntimeError):
            pass
        failure = ClawChatApiError('fixture PATCH response lost')
        failure.__cause__ = TimeoutError('fixture timeout')
        self.client.update_my_profile.side_effect = failure
        # The server applied the PATCH, but its response never reached the client.
        self.client.get_my_profile.side_effect = [self.before, self.after]
        result = await profile.initialize(self.home, 'usr_test', self.client)
        self.assertTrue(result['ok'])
        self.assertTrue(profile.ready(self.home))
        self.assertEqual(self.client.get_my_profile.await_count, 2)
        self.client.update_my_profile.assert_awaited_once()

    async def test_timed_out_patch_without_confirmed_fields_retains_the_original_failure(self):
        for after in (self.before, {**self.after, 'id': 'usr_other'}):
            with self.subTest(after=after):
                self.client.reset_mock()
                failure = RuntimeError('fixture PATCH response lost')
                failure.__cause__ = TimeoutError('fixture timeout')
                self.client.update_my_profile.side_effect = failure
                self.client.get_my_profile.side_effect = [self.before, after]
                with self.assertRaises(RuntimeError) as failed:
                    await profile.initialize(self.home, 'usr_test', self.client)
                self.assertIs(failed.exception, failure)
                self.assertFalse(profile.ready(self.home))
                self.assertEqual(self.client.get_my_profile.await_count, 2)
                self.client.update_my_profile.assert_awaited_once()

    async def test_timed_out_patch_and_readback_keeps_the_write_timeout_as_primary(self):
        @dataclass(frozen=True)
        class ClawChatApiError(Exception):
            message: str
            status: int | None = None

        wrapped = ClawChatApiError('fixture PATCH response lost')
        object.__setattr__(wrapped, '__cause__', TimeoutError('fixture write timeout'))
        for failure in (wrapped, TimeoutError('fixture write timeout')):
            with self.subTest(failure=type(failure).__name__):
                self.client.reset_mock()
                original_context = failure.__context__
                verify = TimeoutError('fixture verification timeout')
                self.client.update_my_profile.side_effect = failure
                self.client.get_my_profile.side_effect = [self.before, verify]
                with self.assertRaises(type(failure)) as failed:
                    await profile.initialize(self.home, 'usr_test', self.client)
                self.assertIs(failed.exception, failure)
                self.assertIs(failed.exception.__context__, original_context)
                self.assertIn(verify, failed.exception.secondary_errors)
                self.assertFalse(profile.ready(self.home))
                self.assertEqual(self.client.get_my_profile.await_count, 2)
                self.client.update_my_profile.assert_awaited_once()

    async def test_a_definite_profile_refusal_does_not_add_a_verification_request(self):
        for order in ['refusal-then-timeout', 'timeout-then-refusal', 'wrapper-timeout-refusal']:
            with self.subTest(order=order):
                refused = RuntimeError('fixture forbidden')
                if order == 'refusal-then-timeout':
                    refused.response = SimpleNamespace(status_code=403)
                else:
                    refused.status = 403
                timed = TimeoutError('fixture timeout cannot override a definite HTTP refusal')
                if order == 'refusal-then-timeout':
                    refused.__cause__ = timed
                    failure = refused
                else:
                    timed.__cause__ = refused
                    failure = timed
                    if order == 'wrapper-timeout-refusal':
                        failure = RuntimeError('fixture SDK wrapper')
                        failure.__cause__ = timed
                await self._assert_patch_failure_outcome(failure, may_verify=False)

    async def test_a_cyclic_timeout_chain_cannot_authorize_profile_verification(self):
        for wrapped_cycle in [False, True]:
            with self.subTest(wrapped_cycle=wrapped_cycle):
                failure = TimeoutError('fixture cyclic timeout')
                tail = RuntimeError('fixture cyclic SDK wrapper') if wrapped_cycle else failure
                failure.__cause__ = tail
                tail.__cause__ = failure
                await self._assert_patch_failure_outcome(failure, may_verify=False)

    async def test_profile_verification_requires_the_bounded_chain_to_end(self):
        for depth, timeout_at, may_verify in [(4, 0, True), (4, 3, True),
                                              (5, 0, False), (5, 4, False)]:
            with self.subTest(depth=depth, timeout_at=timeout_at):
                errors = [RuntimeError('fixture SDK wrapper') for _ in range(depth)]
                errors[timeout_at] = TimeoutError('fixture PATCH timeout')
                if depth == 5 and timeout_at == 0:
                    errors[-1].response = SimpleNamespace(status_code=403)
                for error, cause in zip(errors, errors[1:]):
                    error.__cause__ = cause
                await self._assert_patch_failure_outcome(errors[0], may_verify=may_verify)

    async def test_successful_patch_without_saved_remote_fields_is_not_success(self):
        self.client.get_my_profile.side_effect = [self.before, self.before]
        with self.assertRaisesRegex(RuntimeError, '尚未保存'):
            await profile.initialize(self.home, 'usr_test', self.client)
        self.assertFalse(profile.ready(self.home))

    async def test_retry_after_remote_success_only_records_verified_result(self):
        self.client.get_my_profile.side_effect = [self.after, self.after]
        await profile.initialize(self.home, 'usr_test', self.client)
        self.client.update_my_profile.assert_not_awaited()
        self.assertTrue(profile.ready(self.home))

    async def test_wrong_account_never_updates_any_profile(self):
        self.client.get_my_profile.side_effect = [{'id': 'usr_other'}]
        with self.assertRaisesRegex(RuntimeError, '账号.*不一致'):
            await profile.initialize(self.home, 'usr_test', self.client)
        self.client.update_my_profile.assert_not_awaited()
        self.assertFalse(profile.ready(self.home))

    async def test_repair_with_new_account_invalidates_old_receipt(self):
        await profile.initialize(self.home, 'usr_test', self.client)
        (self.home / '.env').write_text('CLAWCHAT_USER_ID=usr_new\n', encoding='utf-8')
        self.assertFalse(profile.ready(self.home))
        self.client.get_my_profile.side_effect = [
            {**self.before, 'id': 'usr_new'}, {**self.after, 'id': 'usr_new'}]
        await profile.initialize(self.home, 'usr_new', self.client)
        self.assertTrue(profile.ready(self.home))
        self.assertEqual(self.client.update_my_profile.await_count, 2)

    async def test_account_must_match_local_pairing(self):
        with self.assertRaisesRegex(RuntimeError, '配对账号不完整'):
            await profile.initialize(self.home, 'usr_other', self.client)
        self.client.get_my_profile.assert_not_awaited()

    async def test_symlink_outside_instance_is_rejected_before_network(self):
        with tempfile.TemporaryDirectory() as outside:
            (self.home / 'clawchat').symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, '隔离目录'):
                await profile.initialize(self.home, 'usr_test', self.client)
            self.client.get_my_profile.assert_not_awaited()

    def test_profile_failure_preserves_status_and_type_without_request_credentials(self):
        secret = 'profile-token-private'
        cause = RuntimeError('request Authorization=Bearer '+secret)
        cause.response = SimpleNamespace(status_code=403)
        try:
            raise RuntimeError('url=https://example.test/?token='+secret) from cause
        except RuntimeError as error:
            result = profile.failure_result(error)
        encoded = json.dumps(result)
        self.assertNotIn(secret, encoded)
        self.assertNotIn('https://', encoded)
        self.assertEqual(result['diagnostic']['cause']['code'], 403)
        self.assertEqual(result['diagnostic']['cause']['name'], 'RuntimeError')
        self.assertFalse(result['ok'])

    def test_unowned_profile_entry_never_loads_the_client_or_writes_a_receipt(self):
        with patch.object(sys, 'argv', ['nora_profile.py', str(self.home)]), \
                patch.dict(os.environ, {'NORA_TAVERN_HOME': str(self.home.parent)}, clear=True):
            with self.assertRaises(RuntimeError) as caught:
                profile.main()
        self.assertEqual(caught.exception.code, 'OPERATION_CAPABILITY_INVALID')
        self.assertFalse(profile.receipt_path(self.home).exists())


@unittest.skipUnless(os.environ.get('NORA_CLAWCHAT_PLUGIN'), 'requires the bundled ClawChat plugin')
class BundledProfileIntegrationTests(unittest.TestCase):
    def test_real_bundled_client_initializes_through_cli_and_preserves_customization(self):
        state = {'id': 'usr_test', 'nickname': 'Hermes', 'avatar_url': ''}
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def respond(self, payload):
                body = json.dumps({'code': 0, 'data': payload}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                requests.append(('GET', self.path))
                self.respond({'user': {'locale': 'zh'}} if self.path == '/v1/agents/me/owner' else {'user': state})

            def do_PATCH(self):
                requests.append(('PATCH', self.path))
                state.update(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.respond({'user': state})

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with owned_fixture_directory(prefix='nora-owned-profile-') as fixture:
                root = fixture.root
                home = root / 'hermes'
                (home / 'plugins').mkdir(parents=True)
                (home / 'plugins/clawchat').symlink_to(Path(os.environ['NORA_CLAWCHAT_PLUGIN']).resolve(), target_is_directory=True)
                (home / 'config.yaml').write_text('{}', encoding='utf-8')
                (home / '.env').write_text(
                    f'CLAWCHAT_USER_ID=usr_test\nCLAWCHAT_TOKEN=test-only\nCLAWCHAT_BASE_URL=http://127.0.0.1:{server.server_port}\n', encoding='utf-8')
                env = env_for(root, home, root / 'tavern')
                env['CLAWCHAT_USER_ID'] = 'wrong-inherited-account'
                env['CLAWCHAT_TOKEN'] = 'wrong-inherited-token'
                command = [sys.executable, '-B', str(Path(profile.__file__).resolve()), str(home)]
                # The real client remains beneath the same native operation
                # lease used by the APP; never bypass ownership for integration.
                def owned_client():
                    node = resolve_node(required=True)
                    entry = Path(profile.__file__).resolve().parent / 'desktop/operation-lock.js'
                    actor = Path(__file__).with_name('core_owned_test_actor.cjs')
                    owned_env = {**env, 'NORA_TEST_VENV_HOME': sys.prefix}
                    fixture.closed = False
                    result = subprocess.run([node, str(actor), str(entry), str(root), *command[:1], *command[2:]],
                                          env=owned_env, text=True, capture_output=True, timeout=30)
                    require_fixture_closure(fixture, result.stderr)
                    return result
                result = owned_client()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertTrue(json.loads(result.stdout)['ok'], result.stdout)
                self.assertEqual(state['nickname'], '诺拉')
                self.assertEqual(state['avatar_url'], profile.AVATAR_URL)
                self.assertEqual(requests, [('GET', '/v1/users/me'),
                                            ('PATCH', '/v1/users/me'), ('GET', '/v1/users/me')])
                state.update(nickname='custom name', avatar_url='https://example.org/custom.png')
                requests.clear()
                result = owned_client()
                self.assertTrue(json.loads(result.stdout)['alreadyInitialized'])
                self.assertEqual(requests, [])
                self.assertEqual(state['nickname'], 'custom name')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
