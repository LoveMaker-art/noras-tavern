"""Retirement keeps user overrides safe and never reloads a gateway."""
import json
from pathlib import Path
import unittest
import yaml
import test_clean_update as fixtures
from activation_retirement import PLUGIN


class RetirementTests(unittest.TestCase):
    def setUp(self):
        f = fixtures.CleanUpdateTests()
        f.setUp()
        self.addCleanup(f.doCleanups)
        self.f, self.u = f.fixture, f.u
        for name in ('__init__.py', 'plugin.yaml'):
            self.f.write('plugins/' + PLUGIN + '/' + name,
                (fixtures.fixtures.OPS / ('tests/fixtures/activation-rc2-' + name + '.txt')).read_text())
        self.f.write('config.yaml', 'plugins: {enabled: [clawchat, tavern-update-activation]}\n')

    def test_owned_bridge_retires_without_mutating_historical_request(self):
        old = self.u.root / 'review-old/activation.json'
        old.parent.mkdir(parents=True)
        old.write_text(json.dumps({'status': 'queued', 'requestId': 'old-owner-request'}))
        before = self.f.snapshot()
        result = self.f.review()
        self.f.apply(result)
        self.assertFalse((self.u.home / 'plugins' / PLUGIN / '__init__.py').exists())
        self.assertEqual(yaml.safe_load((self.u.home / 'config.yaml').read_text())['plugins']['enabled'], ['clawchat'])
        self.assertEqual(json.loads(old.read_text())['status'], 'queued')
        self.u.rollback(result['transaction'], result['planDigest'])
        self.assertEqual(self.f.snapshot(), before)
        self.assertEqual(json.loads(old.read_text())['status'], 'queued')

    def test_historical_request_status_change_after_review_does_not_block_update(self):
        old = self.u.root / 'review-old/activation.json'
        old.parent.mkdir(parents=True)
        old.write_text(json.dumps({'status': 'queued'}))
        review = self.f.review()
        old.write_text(json.dumps({'status': 'completed'}))
        self.f.apply(review)
        self.assertEqual(json.loads(old.read_text())['status'], 'completed')

    def test_in_progress_reset_refuses_before_changes(self):
        old = self.u.root / 'review-old/activation.json'
        old.parent.mkdir(parents=True)
        old.write_text(json.dumps({'status': 'resetting'}))
        before = self.f.snapshot()
        with self.assertRaisesRegex(ValueError, 'Interrupted activation'):
            self.f.review()
        self.assertEqual(self.f.snapshot(), before)

    def test_corrupt_historical_activation_record_does_not_block_retirement(self):
        old = self.u.root / 'review-old/activation.json'
        old.parent.mkdir(parents=True)
        old.write_text('{interrupted old record')
        review = self.f.review()
        self.f.apply(review)
        self.assertEqual(old.read_text(), '{interrupted old record')

    def test_changed_owner_plugin_is_preserved(self):
        self.f.write('plugins/' + PLUGIN + '/__init__.py', 'user customized')
        with self.assertRaisesRegex(ValueError, 'Modified activation plugin'):
            self.f.review()
        self.assertEqual((self.u.home / 'plugins' / PLUGIN / '__init__.py').read_text(), 'user customized')


if __name__ == '__main__':
    unittest.main()
