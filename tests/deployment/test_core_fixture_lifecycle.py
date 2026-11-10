import json, shutil, subprocess, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from .core_fixture_lifecycle import CLOSURE_PREFIX, owned_fixture_directory, require_fixture_closure, close_fixture_child, cleanup_fixture_children

class FixtureChildLifecycleTests(unittest.TestCase):
    def test_missing_false_and_mismatched_receipts_preserve_the_fixture(self):
        for invalid in ('missing', 'false', 'wrong-root', 'duplicate'):
            with self.subTest(receipt=invalid):
                fixture = None
                try:
                    with self.assertRaises(RuntimeError), owned_fixture_directory('nora-pure-receipt-') as fixture:
                        (fixture.root / 'evidence').write_text('retain')
                        fixture.closed = False
                        record = {'schema': 'nora-fixture-closure/1', 'root': str(fixture.root), 'closed': True}
                        if invalid == 'false': record['closed'] = False
                        if invalid == 'wrong-root': record['root'] = str(fixture.root / 'other')
                        output = CLOSURE_PREFIX + json.dumps(record)
                        if invalid == 'missing': output = 'original stderr remains visible'
                        if invalid == 'duplicate': output += '\n' + output
                        require_fixture_closure(fixture, output)
                    self.assertFalse(fixture.closed)
                    self.assertEqual((fixture.root / 'evidence').read_text(), 'retain')
                finally:
                    # These pure cases admitted no actor; remove only their fresh roots.
                    if fixture and fixture.root.exists(): shutil.rmtree(fixture.root)

    def test_closed_receipt_allows_cleanup_after_an_expected_program_failure(self):
        fixture = None
        with self.assertRaisesRegex(ValueError, 'original expected program failure'):
            with owned_fixture_directory('nora-pure-closed-receipt-') as fixture:
                fixture.closed = False
                require_fixture_closure(fixture, CLOSURE_PREFIX + json.dumps({
                    'schema': 'nora-fixture-closure/1', 'root': str(fixture.root), 'closed': True}))
                raise ValueError('original expected program failure')
        self.assertTrue(fixture.closed)
        self.assertFalse(fixture.root.exists())

    def test_term_timeout_requires_kill_and_actual_wait(self):
        from unittest.mock import Mock
        child = Mock(stdin=None, stdout=None, stderr=None)
        child.poll.side_effect = [None, 0]
        child.wait.side_effect = [subprocess.TimeoutExpired('fixture', 2), 0]
        close_fixture_child(child)
        child.terminate.assert_called_once_with(); child.kill.assert_called_once_with()
        self.assertEqual(child.wait.call_count, 2)

    def test_missing_close_remains_a_failure_after_forced_stop(self):
        from unittest.mock import Mock
        child = Mock(stdin=None, stdout=None, stderr=None)
        child.poll.return_value = None
        child.wait.side_effect = subprocess.TimeoutExpired('fixture', 2)
        with self.assertRaises(subprocess.TimeoutExpired):
            close_fixture_child(child)
        child.kill.assert_called_once_with()

    def test_unconfirmed_child_keeps_its_fixture_root(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory(prefix='nora-pure-cleanup-') as temporary:
            root = Path(temporary)
            evidence = root / 'evidence'; evidence.write_text('retain')
            child = Mock(stdin=None, stdout=None, stderr=None)
            child.poll.return_value = None
            child.wait.side_effect = subprocess.TimeoutExpired('fixture', 2)
            fixture = SimpleNamespace(root=root, fixture_children=[child])
            with self.assertRaisesRegex(RuntimeError, 'Retaining fixture'):
                cleanup_fixture_children(fixture)
            self.assertEqual(evidence.read_text(), 'retain')
