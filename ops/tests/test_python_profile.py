import json
from pathlib import Path
import tempfile
import unittest
import test_full_update
from python_profile import normalize_empty_placeholder


class PythonProfileTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='profile-normalization-')
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name).resolve() / 'prepared/state'
        self.state.mkdir(parents=True)
        self.value = {'schema_version': 1, 'revision': 1, 'preferences': {}, 'recent': [], 'taste': {},
                      'shared_facts': [], 'display': {'identity_markdown': '保留原始身份'},
                      'stats': {'messages_seen': 0, 'productions_seen': 0, 'last_event_ts': None}}
        self.file = self.state / 'story_profile.json'

    def test_empty_seed_is_normalized_with_exact_original_archive(self):
        self.file.write_text(json.dumps(self.value, ensure_ascii=False))
        original = self.file.read_bytes()
        result = normalize_empty_placeholder(self.state)
        self.assertFalse(result['contentDiscarded'])
        value = json.loads(self.file.read_text())
        self.assertEqual(value['display'], self.value['display'])
        self.assertEqual(value['preferences'], [])
        self.assertEqual(value['recent_timeline'], [])
        self.assertEqual((self.state / result['original']).read_bytes(), original)
        self.assertIsNone(normalize_empty_placeholder(self.state))

    def test_populated_unknown_seed_is_never_guessed_or_changed(self):
        self.value['preferences'] = {'unknown': '用户内容'}
        self.file.write_text(json.dumps(self.value))
        original = self.file.read_bytes()
        self.assertIsNone(normalize_empty_placeholder(self.state))
        self.assertEqual(self.file.read_bytes(), original)

    def test_invalid_json_is_left_for_nonblocking_record_import(self):
        self.file.write_bytes(b'{invalid')
        self.assertIsNone(normalize_empty_placeholder(self.state))
        self.assertEqual(self.file.read_bytes(), b'{invalid')

    def test_live_state_cannot_be_normalized(self):
        with self.assertRaisesRegex(ValueError, 'prepared state'):
            normalize_empty_placeholder(self.state.parent)


if __name__ == '__main__': unittest.main()
