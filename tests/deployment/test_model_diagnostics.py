import io
import json
import unittest
from contextlib import redirect_stdout
from ops.installer import model_config


class ModelDiagnosticTests(unittest.TestCase):
    def test_program_failure_preserves_code_cause_and_project_location_without_key(self):
        secret='diagnostic-test-key-private'
        try:
            try:
                raise PermissionError(13, 'configuration write denied '+secret)
            except PermissionError as cause:
                raise RuntimeError('could not save '+secret) from cause
        except RuntimeError as error:
            output=io.StringIO()
            with redirect_stdout(output),self.assertRaises(SystemExit):
                model_config.fail(error,secret)
        encoded=output.getvalue();self.assertNotIn(secret,encoded)
        result=json.loads(encoded)
        self.assertEqual(result['diagnostic']['cause']['code'],'EACCES')
        self.assertNotIn('config.yaml',result)
        self.assertFalse(result['ok'])
