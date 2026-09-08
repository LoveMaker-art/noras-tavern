import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock

from ops.installer import nora_profile as profile
from ops.installer.launcher_bridge import env_for


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

    async def test_owner_locale_controls_name_including_nested_response(self):
        for locale, nickname in [('en', 'Nora'), ('zh-Hant', '诺拉'), ('zh_CN', '诺拉'), ('', 'Nora')]:
            with self.subTest(locale=locale):
                profile.receipt_path(self.home).unlink(missing_ok=True)
                self.client.get_agent_owner.return_value = {'locale': locale}
                self.client.get_my_profile.side_effect = [self.before, {'user': {**self.after, 'nickname': nickname}}]
                await profile.initialize(self.home, 'usr_test', self.client)
                self.assertEqual(self.client.update_my_profile.call_args.kwargs['nickname'], nickname)

    async def test_failed_update_does_not_record_success(self):
        self.client.update_my_profile.side_effect = RuntimeError('network failed')
        with self.assertRaisesRegex(RuntimeError, 'network failed'):
            await profile.initialize(self.home, 'usr_test', self.client)
        self.assertFalse(profile.ready(self.home))

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
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
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
                result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0)
                self.assertTrue(json.loads(result.stdout)['ok'], result.stdout)
                self.assertEqual(state['nickname'], '诺拉')
                self.assertEqual(state['avatar_url'], profile.AVATAR_URL)
                self.assertEqual(requests, [('GET', '/v1/users/me'), ('GET', '/v1/agents/me/owner'),
                                            ('PATCH', '/v1/users/me'), ('GET', '/v1/users/me')])
                state.update(nickname='custom name', avatar_url='https://example.org/custom.png')
                requests.clear()
                result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=30)
                self.assertTrue(json.loads(result.stdout)['alreadyInitialized'])
                self.assertEqual(requests, [])
                self.assertEqual(state['nickname'], 'custom name')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
