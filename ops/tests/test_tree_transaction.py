"""Directory transaction primitives keep estimates and integrity checks separate."""
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import tree_transaction as trees


class TreeTransactionTests(unittest.TestCase):
    def test_space_size_tolerates_an_atomic_temp_file_disappearing_after_listing(self):
        with tempfile.TemporaryDirectory(prefix='tavern-tree-size-') as directory:
            root = Path(directory)
            user = root / 'native/default-user'
            user.mkdir(parents=True)
            stable = user / 'settings.json'
            stable.write_bytes(b'stable')
            transient = user / 'settings.json.1778046006'
            transient.write_bytes(b'atomic temporary file')
            original_iterdir = Path.iterdir

            def delete_transient_after_listing(path):
                entries = list(original_iterdir(path))
                if path == user and transient.exists():
                    transient.unlink()
                return iter(entries)

            with patch.object(Path, 'iterdir', delete_transient_after_listing):
                self.assertEqual(trees.size(root), stable.stat().st_size)

    def test_integrity_inventory_stays_strict_when_a_file_disappears(self):
        with tempfile.TemporaryDirectory(prefix='tavern-tree-inventory-') as directory:
            root = Path(directory)
            user = root / 'native/default-user'
            user.mkdir(parents=True)
            transient = user / 'settings.json.1778046006'
            transient.write_bytes(b'atomic temporary file')
            original_iterdir = Path.iterdir

            def delete_transient_after_listing(path):
                entries = list(original_iterdir(path))
                if path == user and transient.exists():
                    transient.unlink()
                return iter(entries)

            with patch.object(Path, 'iterdir', delete_transient_after_listing):
                with self.assertRaises(FileNotFoundError):
                    trees.inventory(root)


if __name__ == '__main__':
    unittest.main()
