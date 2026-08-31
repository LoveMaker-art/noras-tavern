"""Real prepared-state worker on copied fixture data; no app, network or model starts."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import test_full_update
from clean_update import MARKER
import tree_transaction as trees


class PreparedPythonDataTests(unittest.TestCase):
    def test_worker_defers_bad_data_and_preserves_original_state(self):
        repository = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix='prepared-python-data-') as temporary:
            home = Path(temporary).resolve()
            transaction = home / 'tavern-updates-v2/review-fixture'
            state = transaction / 'prepared/state'
            app = transaction / 'source/app'
            app.mkdir(parents=True)
            # Read-only fixture dependency link, never part of an installation.
            (app / 'engine').symlink_to(repository / 'app/engine', target_is_directory=True)
            original = home / 'tavern-state'
            fixture = json.loads((repository / 'ops/tests/fixtures/python-state.json').read_text())
            for namespace in ('cards', 'worldbooks', 'productions'):
                (original / namespace).mkdir(parents=True)
                for item in fixture[namespace]:
                    (original / namespace / (item['id'] + '.json')).write_text(json.dumps(item))
            (original / 'cards/card_backup.json.bak_agefix').write_bytes(b'private original backup')
            (original / 'worldbooks/wb_st.json').write_text(json.dumps({'id': 'wb_st', 'entries': {'0': {'content': 'ST lore'}}}))
            (original / 'productions/prod_bad.json').write_bytes(b'{bad chat')
            (original / 'story_profile.json').write_bytes(b'{bad profile')
            (original / 'model_configs.json').write_bytes(b'{bad models')
            before = trees.fingerprint(original, state=True)
            shutil.copytree(original, state)
            (home / MARKER).write_text(json.dumps({'schema': 1, 'home': str(home), 'purpose': 'isolated-update-test'}))
            (transaction / 'plan.json').write_text(json.dumps({'cleanTransaction': True, 'home': str(home),
                                                              'testMode': True, 'pythonSource': {'web': 'web'}}))
            (transaction / 'prepared/model-input.json').write_text(json.dumps({
                'legacyApp': str(home / 'apps/tavern-runtime'), 'legacyWeb': 'web'}))
            result = subprocess.run(['node', str(repository / 'ops/updater/prepare-state.mjs'), str(state), str(app)],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report['status'], 'partial')
            self.assertEqual(len(report['worlds']), 2)
            self.assertEqual(len(report['deferred']), 4)
            self.assertEqual(len(report['archived']), 1)
            self.assertEqual(report['modelsCalled'], 0)
            self.assertEqual(trees.fingerprint(original, state=True), before)
            for item in report['deferred'] + report['archived']:
                self.assertEqual((state / item['archiveFile']).read_bytes(), (original / item['file']).read_bytes())


if __name__ == '__main__':
    unittest.main()
