"""The public CLI must plan Python upgrades without isolated-only switches."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import test_full_update as fixtures


class ProductionEntryTests(unittest.TestCase):
    def test_default_review_accepts_python_and_plans_whole_tree_replacement(self):
        self.check_layout('backend/server.py', 'frontend')

    def test_real_installed_layout_enters_python_migration_not_node_gate(self):
        self.check_layout('server.py', 'web')

    def check_layout(self, entry, web):
        fixture = fixtures.FullUpdateTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        (fixture.home / 'apps/tavern-runtime/native-runtime.json').unlink()
        fixture.write('apps/tavern-runtime/' + entry, '# old Python fixture\n')
        fixture.write('apps/tavern-runtime/' + web + '/index.html', 'old UI')
        fixture.write('tavern-state/productions/prod_test.json', '{"id":"prod_test"}')
        before = fixture.snapshot()
        result = subprocess.run([sys.executable, str(fixtures.OPS / 'updater/update.py'),
            '--hermes-home', str(fixture.home), 'review', '--release-dir', str(fixture.release),
            '--manifest-sha256', fixtures.digest((fixture.release / 'release-manifest.json').read_bytes()), '--allow-candidate'],
            env={**os.environ, 'HERMES_HOME': str(fixture.home)}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        review = json.loads(result.stdout)
        plan = json.loads((Path(review['transaction']) / 'plan.json').read_text())
        self.assertTrue(plan['cleanTransaction'])
        self.assertFalse(plan['testMode'])
        self.assertEqual(plan['sourceRuntime'], 'python')
        self.assertEqual(plan['pythonSource'], {'entry': entry, 'web': web})
        self.assertIn(entry, review['inactiveCode']['app'])
        self.assertEqual(fixture.snapshot(), before, 'Review must not change active files')


if __name__ == '__main__':
    unittest.main()
