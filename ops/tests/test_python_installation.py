import tempfile
from pathlib import Path
import unittest

import test_full_update  # Registers updater import path.
from python_installation import python_installation, python_script


class PythonInstallationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='python-layout-test-')
        self.addCleanup(temp.cleanup)
        self.app = Path(temp.name).resolve()

    def test_flat_installed_layout(self):
        (self.app / 'server.py').touch()
        self.assertEqual(python_installation(self.app), {'entry': 'server.py', 'web': 'web'})
        self.assertEqual(python_script(self.app), self.app / 'server.py')

    def test_source_layout_and_backend_web_layout(self):
        (self.app / 'backend').mkdir()
        (self.app / 'backend/server.py').touch()
        self.assertEqual(python_installation(self.app)['web'], 'backend/web')
        (self.app / 'frontend').mkdir()
        self.assertEqual(python_installation(self.app)['web'], 'frontend')

    def test_ambiguous_layout_is_rejected(self):
        (self.app / 'backend').mkdir()
        (self.app / 'backend/server.py').touch()
        (self.app / 'server.py').touch()
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            python_installation(self.app)

    def test_node_marker_does_not_enable_python_migration(self):
        (self.app / 'native-runtime.json').write_text('{"schema":2}')
        (self.app / 'server.py').touch()
        self.assertIsNone(python_installation(self.app))

    def test_entrypoint_and_web_symlinks_are_rejected(self):
        (self.app / 'server.py').symlink_to(self.app / 'missing.py')
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            python_installation(self.app)
        (self.app / 'server.py').unlink()
        (self.app / 'server.py').touch()
        (self.app / 'web').symlink_to(self.app / 'missing-web')
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            python_installation(self.app)


if __name__ == '__main__':
    unittest.main()
