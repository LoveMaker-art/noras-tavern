"""External protocol adapter fixtures; actual update orchestration is exercised."""
import copy
import json
import unittest
from unittest.mock import patch

import test_full_update as fixtures
from liveware_integration import Integration, rows, initialize, require_idle


class FakePlatform:
    def __init__(self):
        self.available = [{'appId': 'app-' + role, 'domain': 'app-' + role + '.apps.clawling.io',
                           'status': 'active'} for role in ('console', 'actor')]
        self.registered = [{'app_id': a['appId'], 'name': 'old-' + a['appId'],
                            'url': 'https://' + a['domain'] + '/'} for a in self.available]
        self.writes = []
        self.fail_query = False
        self.fail_registration = False

    def apps(self):
        if self.fail_query:
            raise ValueError('Authorization unavailable')
        return copy.deepcopy(self.available)

    def registrations(self):
        return copy.deepcopy(self.registered)

    def backends(self, app_id):
        return [{'mode': 'tunnel', 'route': '/*', 'targetUrl': '', 'upstreamId': app_id}]

    def bind(self, app_id, target):
        self.writes.append(('bind', app_id, target))

    def launcher(self, operation, **parameters):
        self.writes.append((operation, parameters))
        app_id = parameters['app_id']
        if operation == 'unregister_app':
            self.registered = [a for a in self.registered if a['app_id'] != app_id]
        elif operation == 'register_app':
            if self.fail_registration:
                self.fail_registration = False
                raise TimeoutError('uncertain registration')
            self.registered.append(parameters)
        else:
            raise AssertionError('Creation/deletion is never part of update')
        return {'ok': True}


class LivewareTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.FullUpdateTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.platform = FakePlatform()
        self.fixture.write('tavern-state/apps.json', json.dumps({role: {
            'app_id': 'app-' + role, 'domain': 'app-' + role + '.apps.clawling.io'} for role in ('console', 'actor')}))
        self.integration = Integration(self.fixture.home, platform=self.platform)
        self.fixture.u.integration = self.integration
        self.journal = {}
        self.saved = []
        self.save = lambda: self.saved.append(copy.deepcopy(self.journal))

    def test_query_errors_and_invalid_shapes_cannot_create_apps(self):
        for value in ({'error': 'forbidden'}, {'apps': None}, [None], None):
            with self.assertRaises(ValueError):
                rows(value)
        self.platform.fail_query = True
        with self.assertRaisesRegex(ValueError, 'Authorization'):
            self.fixture.review()
        self.assertEqual(self.platform.writes, [])
        self.assertEqual(self.fixture.service.calls, [])

    def test_same_app_for_both_roles_is_refused_before_maintenance(self):
        self.fixture.write('tavern-state/apps.json', json.dumps({role: {
            'app_id': 'app-console', 'domain': 'app-console.apps.clawling.io'} for role in ('console', 'actor')}))
        with self.assertRaisesRegex(ValueError, 'distinct App IDs'):
            self.fixture.review()
        self.assertFalse(self.platform.writes)

    def test_apply_keeps_ids_and_distinguishes_binding_ack_from_actual_entry(self):
        before = copy.deepcopy(self.platform.available)
        with patch('liveware_integration.local_entry') as local:
            result = self.fixture.apply(self.fixture.review())
        self.assertEqual(self.platform.available, before)
        self.assertEqual([a['name'] for a in self.platform.registered], ['Tavern', 'Story Profile'])
        binds = [item for item in self.platform.writes if item[0] == 'bind']
        self.assertEqual(binds, [('bind', 'app-console', 'http://127.0.0.1:8799'),
                                ('bind', 'app-actor', 'http://127.0.0.1:8799/_liveware/story-profile')])
        self.assertEqual(local.call_count, 2)
        self.assertEqual(result['liveware']['status'], 'binding-acknowledged')
        self.assertFalse(result['liveware']['externalEntryVerified'])

    def test_local_entry_failure_does_not_touch_platform_and_restores_local(self):
        before = self.fixture.snapshot()
        with patch('liveware_integration.local_entry', side_effect=ValueError('wrong title')):
            with self.assertRaisesRegex(ValueError, 'wrong title'):
                self.fixture.apply(self.fixture.review())
        self.assertEqual(self.fixture.snapshot(), before)
        self.assertFalse(self.platform.writes)

    def test_unknown_binding_recovery_is_pending_not_a_false_success(self):
        old_registrations = copy.deepcopy(self.platform.registered)
        before = self.fixture.snapshot()
        review = self.fixture.review()
        self.platform.fail_registration = True
        with patch('liveware_integration.local_entry'):
            with self.assertRaisesRegex(ValueError, 'original Liveware binding'):
                self.fixture.apply(review)
        self.assertEqual(self.fixture.snapshot(), before)
        self.assertEqual(self.platform.registered, old_registrations[::-1])
        receipt = json.loads((__import__('pathlib').Path(review['transaction']) / 'receipt.json').read_text())
        self.assertEqual(receipt['status'], 'integration-pending')
        self.assertIn('failure', receipt)
        self.assertIn('recoveryFailure', receipt)
        stops = self.fixture.service.calls.count('stop')
        with self.assertRaisesRegex(ValueError, 'original Liveware binding'):
            self.fixture.u.rollback(review['transaction'], review['planDigest'])
        self.assertEqual(self.fixture.service.calls.count('stop'), stops, 'Already restored local runtime must not be stopped again')
        with self.assertRaisesRegex(ValueError, 'Unfinished'):
            self.fixture.apply(self.fixture.review())

    def test_concurrent_launcher_edit_is_not_overwritten_by_recovery(self):
        reviewed = self.integration.review()
        with patch('liveware_integration.local_entry'):
            self.integration.apply(reviewed, self.journal, self.save)
        self.platform.registered[1]['name'] = 'owner-edited'
        before = copy.deepcopy(self.platform.writes)
        with self.assertRaisesRegex(ValueError, 'Concurrent launcher'):
            self.integration.recover(self.journal, self.save)
        self.assertEqual(self.platform.writes, before)

    def test_isolated_mode_never_connects_to_real_platform(self):
        self.platform.fail_query = True
        isolated = Integration(self.fixture.home, platform=self.platform, isolated=True)
        review = isolated.review()
        self.assertEqual(isolated.apply(review, {}, lambda: None)['status'], 'isolated-not-connected')

    def test_initialization_query_failure_never_creates(self):
        self.platform.fail_query = True
        with self.assertRaisesRegex(ValueError, 'Authorization'):
            initialize(self.fixture.home, self.platform)
        self.assertFalse(self.platform.writes)

    def test_uncertain_create_is_not_repeated(self):
        (self.fixture.home / 'tavern-state/apps.json').unlink()
        self.platform.available = []
        def timeout(*args):
            self.platform.writes.append(args)
            raise TimeoutError('create response lost')
        self.platform.cli = timeout
        with self.assertRaises(TimeoutError):
            initialize(self.fixture.home, self.platform)
        with self.assertRaisesRegex(ValueError, 'creation is uncertain'):
            initialize(self.fixture.home, self.platform)
        self.assertEqual(len(self.platform.writes), 1)

    def test_completed_create_can_be_resolved_after_response_loss(self):
        self.test_uncertain_create_is_not_repeated()
        self.platform.available = [dict(a, name='Tavern' if a['appId'] == 'app-console' else 'Story Profile')
                                   for a in FakePlatform().available]
        resolved = initialize(self.fixture.home, self.platform)
        self.assertEqual(resolved['console']['app_id'], 'app-console')
        self.assertEqual(len(self.platform.writes), 1)

    def test_startup_refuses_unfinished_transaction_even_after_process_lock_released(self):
        root = self.fixture.home / 'tavern-updates-v2/review-interrupted'
        root.mkdir(parents=True, exist_ok=True)
        (root / 'receipt.json').write_text(json.dumps({'status': 'applying'}))
        with self.assertRaisesRegex(ValueError, 'Unfinished update'):
            require_idle(self.fixture.home)

    def test_modified_actual_gateway_hook_is_not_overwritten(self):
        self.fixture.write('hooks/tavern-liveware-register/run.sh', 'custom startup code')
        with self.assertRaisesRegex(ValueError, 'Modified startup hook'):
            self.fixture.review()

    def test_actual_gateway_hook_is_installed_and_rolled_back_with_release(self):
        review = self.fixture.review()
        before = self.fixture.snapshot()
        with patch('liveware_integration.local_entry', side_effect=ValueError('before platform changes')):
            with self.assertRaises(ValueError):
                self.fixture.apply(review)
        self.assertEqual(self.fixture.snapshot(), before)
        self.assertFalse((self.fixture.home / 'hooks/tavern-liveware-register/run.sh').exists())


if __name__ == '__main__':
    unittest.main()
