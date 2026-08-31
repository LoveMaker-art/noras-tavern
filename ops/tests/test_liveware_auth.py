"""Real child-process authentication adapter, using only synthetic credentials."""
import json
import os
import sys
import unittest
from unittest.mock import patch

import test_full_update as fixtures
import liveware_integration as liveware


class LivewareAuthTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.FullUpdateTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.home = self.fixture.home
        self.fixture.write('tavern-state/apps.json', '{}')
        self.fixture.write('clawchat/liveware/liveware', '#!' + sys.executable + '''
import json, os, sys
from pathlib import Path
home = Path(os.environ['HERMES_HOME'])
with (home / 'cli-calls').open('a') as log:
    log.write(' '.join(sys.argv[1:3]) + '\\n')
mode = (home / 'mode').read_text() if (home / 'mode').exists() else ''
if mode == 'network':
    print('connection reset by peer', file=sys.stderr)
    sys.exit(1)
if mode == 'protocol':
    print('not JSON')
    sys.exit(0)
if mode == 'timeout':
    print('request timed out', file=sys.stderr)
    sys.exit(1)
valid = (os.environ.get('LIVEWARE_TOKEN') == 'target-test-token'
         and os.environ.get('HOME') == str(home)
         and os.environ.get('LIVEWARE_API_URL') == 'https://platform.invalid'
         and os.environ.get('LIVEWARE_INSTANCE_ID') == 'target-instance')
if not valid or mode in ('denied', 'zero-auth', 'bind-denied'):
    print('unauthorized token=synthetic-secret-never-log', file=sys.stderr if mode != 'zero-auth' else sys.stdout)
    sys.exit(0 if mode == 'zero-auth' else 1)
print(json.dumps([{'appId': 'app-console', 'name': 'Unauthorized'}]))
''')
        self.binary = self.home / 'clawchat/liveware/liveware'
        self.binary.chmod(0o755)
        self.fixture.write('plugins/clawchat/clawchat_gateway/__init__.py', '')
        self.fixture.write('plugins/clawchat/clawchat_gateway/tools.py', '''
import json, os
from pathlib import Path
async def liveware_login():
    home = Path(os.environ['HERMES_HOME'])
    assert os.environ['HOME'] == str(home)
    with (home / 'login-calls').open('a') as log:
        log.write('login\\n')
    target = home / '.clawling/liveware.json'
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps({'token': 'target-test-token', 'apiUrl': 'https://platform.invalid', 'instanceId': 'target-instance'}))
    return {'ok': True}
''')
        self.env = patch.dict(os.environ, {
            'HOME': str(self.fixture.root / 'wrong-home'),
            'HERMES_HOME': str(self.fixture.root / 'wrong-home'),
            'LIVEWARE_BIN': str(self.binary),
            'CLAWCHAT_PLUGIN_DIR': str(self.home / 'plugins/clawchat'),
            'LIVEWARE_TOKEN': 'wrong-caller-token',
            'LIVEWARE_API_URL': 'https://wrong.invalid',
            'LIVEWARE_INSTANCE_ID': 'wrong-instance',
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.platform = liveware.Platform(self.home)

    def credentials(self):
        self.fixture.write('.clawling/liveware.json', json.dumps({
            'token': 'target-test-token', 'apiUrl': 'https://platform.invalid', 'instanceId': 'target-instance'}))

    def test_target_credentials_and_home_win_without_changing_parent(self):
        self.credentials()
        before = dict(os.environ)
        self.assertEqual(self.platform.apps()[0]['appId'], 'app-console')
        self.assertEqual(dict(os.environ), before)
        self.assertFalse((self.home / 'login-calls').exists())

    def test_confirmed_update_prepares_login_once_and_reloads_credentials(self):
        liveware.prepare_update(self.home, allow_login=True)
        self.assertEqual((self.home / 'login-calls').read_text(), 'login\n')
        self.assertEqual((self.home / 'cli-calls').read_text(), 'app list\napp list\n')

    def test_review_never_logs_in_or_turns_auth_failure_into_empty_apps(self):
        with self.assertRaisesRegex(ValueError, 'LIVEWARE_AUTH') as raised:
            liveware.prepare_update(self.home)
        self.assertNotIn('synthetic-secret-never-log', str(raised.exception))
        self.assertFalse((self.home / 'login-calls').exists())
        self.assertFalse((self.home / '.clawling/liveware.json').exists())
        self.assertEqual(self.fixture.service.calls, [])

    def test_network_timeout_and_bad_protocol_do_not_trigger_login(self):
        for mode, code in [('network', 'COMMAND'), ('timeout', 'TIMEOUT'), ('protocol', 'PROTOCOL')]:
            self.fixture.write('mode', mode)
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, 'LIVEWARE_' + code):
                liveware.prepare_update(self.home, allow_login=True)
            self.assertFalse((self.home / 'login-calls').exists())

    def test_failed_auth_after_login_is_not_retried_or_reported_as_success(self):
        self.fixture.write('mode', 'denied')
        with self.assertRaisesRegex(ValueError, 'LIVEWARE_AUTH'):
            liveware.prepare_update(self.home, allow_login=True)
        self.assertEqual((self.home / 'login-calls').read_text(), 'login\n')
        self.assertEqual((self.home / 'cli-calls').read_text(), 'app list\napp list\n')

    def test_exit_zero_auth_error_is_classified_without_leaking_output(self):
        self.fixture.write('mode', 'zero-auth')
        with self.assertRaisesRegex(ValueError, 'LIVEWARE_AUTH') as raised:
            self.platform.apps()
        self.assertNotIn('synthetic-secret-never-log', str(raised.exception))

    def test_mutating_command_is_never_automatically_logged_in_or_replayed(self):
        self.credentials()
        self.fixture.write('mode', 'bind-denied')
        with self.assertRaisesRegex(ValueError, 'LIVEWARE_AUTH'):
            self.platform.bind('app-console', 'http://127.0.0.1:8799')
        self.assertEqual((self.home / 'cli-calls').read_text(), 'tunnel bind\n')
        self.assertFalse((self.home / 'login-calls').exists())

    def test_absent_app_identity_does_not_contact_platform(self):
        (self.home / 'tavern-state/apps.json').unlink()
        liveware.prepare_update(self.home, allow_login=True)
        self.assertFalse((self.home / 'cli-calls').exists())

    def test_malformed_or_linked_credentials_are_not_silently_replaced(self):
        self.fixture.write('.clawling/liveware.json', '{bad json')
        with self.assertRaisesRegex(ValueError, 'LIVEWARE_CREDENTIALS'):
            liveware.prepare_update(self.home, allow_login=True)
        self.assertFalse((self.home / 'login-calls').exists())
        (self.home / '.clawling/liveware.json').unlink()
        (self.home / '.clawling/liveware.json').symlink_to(self.home / 'config.yaml')
        with self.assertRaises(ValueError):
            liveware.prepare_update(self.home, allow_login=True)
        self.assertFalse((self.home / 'login-calls').exists())

    def test_subprocess_timeout_never_exposes_command_or_retries(self):
        import subprocess
        with patch('liveware_integration.subprocess.run', side_effect=subprocess.TimeoutExpired(['secret-command'], 45)) as run:
            with self.assertRaisesRegex(ValueError, 'LIVEWARE_TIMEOUT') as raised:
                liveware.prepare_update(self.home, allow_login=True)
        self.assertEqual(run.call_count, 1)
        self.assertNotIn('secret-command', str(raised.exception))

    def test_isolation_must_be_proven_and_never_contacts_real_platform(self):
        with self.assertRaisesRegex(ValueError, 'marker'):
            liveware.prepare_update(self.home, isolated=True, allow_login=True)
        self.fixture.write('.tavern-isolated-update.json', json.dumps({
            'schema': 1, 'home': str(self.home), 'purpose': 'isolated-update-test'}))
        liveware.prepare_update(self.home, isolated=True, allow_login=True)
        self.assertFalse((self.home / 'cli-calls').exists())
        self.assertFalse((self.home / 'login-calls').exists())
