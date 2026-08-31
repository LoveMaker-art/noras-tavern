"""Completion guidance must describe the installed state, never execute a restart."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'updater'))
from completion import installation_guidance


class CompletionTests(unittest.TestCase):
    def test_installed_release_asks_owner_to_restart_in_clawchat(self):
        result = installation_guidance({'status': 'installed-awaiting-hermes-reload'})
        self.assertEqual(result['restartCommand'], '/restart')
        self.assertEqual(result['restartSurface'], 'ClawChat')
        self.assertIn('/restart', result['next_step'])
        self.assertNotIn('activation request', str(result))
        self.assertNotIn('确定', result['next_step'])

    def test_isolated_rehearsal_does_not_request_a_real_gateway_restart(self):
        result = installation_guidance({'status': 'installed-awaiting-hermes-reload'}, isolated=True)
        self.assertNotIn('restartCommand', result)
        self.assertNotIn('/restart', result['next_step'])

    def test_incomplete_or_failed_receipt_cannot_claim_installation_success(self):
        for status in (None, 'preparing', 'applying', 'files-restored', 'rolled-back'):
            with self.subTest(status=status), self.assertRaises(ValueError):
                installation_guidance({'status': status})


if __name__ == '__main__':
    unittest.main()
