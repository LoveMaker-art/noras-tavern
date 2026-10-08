import json
import shutil
import unittest

from ops.installer import first_install
from ops.tests import test_native_startup_evidence as fixtures


@unittest.skipUnless(shutil.which('node'), 'requires a local Node executable')
class NativeProgramEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.NativeStartupEvidenceTests('test_real_node_exit_preserves_exit_code_and_program_locations')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_unknown_type_error_has_safe_program_header_locations_and_launch_facts(self):
        self.fixture.script('setTimeout(() => { const broken = undefined; broken.fixture; }, 100);\n')
        error = self.fixture.failure()
        detail = first_install._error_diagnostics.exception_diagnostic(error)
        program = next(item['error'] for item in detail['secondaryErrors'] if item['error']['name'] == 'TypeError')
        self.assertIn('Cannot read properties of undefined', program['message'])
        self.assertIn('server.js', program['stack'])
        self.assertEqual(program['context']['exitCode'], 1)
        self.assertEqual(program['context']['stage'], 'native_start')
        self.assertTrue(program['context']['loopback'])
        self.assertGreater(program['context']['pid'], 0)
        self.assertNotIn(str(self.fixture.base), json.dumps(detail))
        self.assertNotIn('const broken', json.dumps(detail))
        self.assertIsNotNone(error.__cause__)

    def test_replaced_log_filename_cannot_supply_evidence_for_the_owned_launch(self):
        self.fixture.script('setTimeout(() => { const broken = undefined; broken.PRIVATE_PROPERTY; }, 150);\n')
        original = self.fixture.runtime.spawn
        def spawn(command, env, log_path):
            child = original(command, env, log_path)
            log_path.unlink()
            log_path.write_text('Error [EACCES]: PRIVATE_REPLACEMENT_LOG\n')
            return child
        self.fixture.runtime.spawn = spawn
        detail = first_install._error_diagnostics.exception_diagnostic(self.fixture.failure())
        serialized = json.dumps(detail)
        self.assertIn('TypeError', serialized)
        self.assertIn('server.js', serialized)
        self.assertNotIn('PRIVATE_', serialized)
        self.assertNotIn('EACCES', serialized)


if __name__ == '__main__':
    unittest.main()
