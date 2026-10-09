import errno
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch


OPERATION_ID = '11111111-1111-4111-8111-111111111111'


class OperationEvidenceTests(unittest.TestCase):
    def test_retained_capacity_preserves_frozen_primary_and_marks_parent_save_failure(self):
        from ops.installer import operation_evidence, error_diagnostics
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary); installer = home / 'installer'
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(installer), 'NORA_OPERATION_ID': OPERATION_ID}):
                original = RuntimeError('original startup failure')
                first = operation_evidence.freeze(original, nora_home=home)
                path = Path(first['path']); before = path.read_bytes()
                generation_path = installer / 'operations/.evidence-generation.json'
                generation = json.loads(generation_path.read_text())
                other = installer / 'operations/22222222-2222-4222-8222-222222222222/evidence'
                other.mkdir(parents=True); (other / 'events.jsonl').write_bytes(b'x' * 512)
                original.secondary_errors = [RuntimeError('restore failed')]
                with patch.object(operation_evidence, 'MAX_RETAINED_BYTES', len(before) + 256), \
                        patch.object(operation_evidence, 'HISTORY_CAPACITY', 2), patch.object(operation_evidence, 'ACK_CAPACITY', 16):
                    result = operation_evidence.freeze(original, nora_home=home)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(result['primary'], first['primary'])
            self.assertIn('save_failed:CAPACITY', result['missingReasons'])
            diagnostic = error_diagnostics.exception_diagnostic(original)
            self.assertIn('save_failed:CAPACITY', diagnostic['missingReasons'])
            self.assertTrue(any(item['error'].get('code') == 'CAPACITY' for item in diagnostic['secondaryErrors']))
            final = json.loads(generation_path.read_text())
            self.assertEqual(final['schema'], 1); self.assertFalse(final['writing'])
            self.assertNotEqual(final['id'], generation['id'])

    def test_capacity_counts_only_evidence_files_and_enforces_each_file_limit(self):
        from ops.installer import operation_evidence
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary); installer = home / 'installer'
            other = installer / 'operations/22222222-2222-4222-8222-222222222222'
            (other / 'backups').mkdir(parents=True); (other / 'backups/kept').write_bytes(b'x' * 4096)
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(installer), 'NORA_OPERATION_ID': OPERATION_ID}):
                with patch.object(operation_evidence, 'MAX_RETAINED_BYTES', 2048), \
                        patch.object(operation_evidence, 'HISTORY_CAPACITY', 2), patch.object(operation_evidence, 'ACK_CAPACITY', 16):
                    first = operation_evidence.freeze(RuntimeError('first failure'), nora_home=home)
                self.assertEqual(first['missingReasons'], [])
                (other / 'evidence').mkdir(); (other / 'evidence/metadata.json').write_bytes(b'x' * (operation_evidence._BUDGET['evidenceBytes'] + 1))
                original = RuntimeError('later failure')
                result = operation_evidence.freeze(original, nora_home=home)
            self.assertIn('save_failed:CAPACITY', result['missingReasons'])
            self.assertEqual((other / 'backups/kept').stat().st_size, 4096)

    def test_ack_slots_are_reserved_and_new_evidence_cannot_exceed_history(self):
        from ops.installer import operation_evidence
        with tempfile.TemporaryDirectory() as temporary:
            operations = Path(temporary) / 'installer/operations'
            first = operations / OPERATION_ID / 'evidence'
            second = operations / '22222222-2222-4222-8222-222222222222/evidence'
            for directory in (first, second):
                directory.mkdir(parents=True)
                (directory / 'delivery.json').write_bytes(b'x' * 128)
            value = {'primary': 'known original cause'}
            size = len(json.dumps(value, ensure_ascii=False).encode('utf-8'))
            retained = 2048 - 2 * 128
            (second / 'events.jsonl').write_bytes(b'x' * (retained - size))
            with patch.object(operation_evidence, 'MAX_RETAINED_BYTES', 2048), \
                    patch.object(operation_evidence, 'HISTORY_CAPACITY', 2), patch.object(operation_evidence, 'ACK_CAPACITY', 128):
                operation_evidence._capacity(first / 'python.json', value)
                with self.assertRaises(operation_evidence.EvidenceCapacityError):
                    operation_evidence._capacity(first / 'python.json', {'primary': 'known original cause plus one'})
                third = operations / '33333333-3333-4333-8333-333333333333/evidence/python.json'
                with self.assertRaises(operation_evidence.EvidenceCapacityError):
                    operation_evidence._capacity(third, {})
            self.assertFalse(third.parent.exists())

    def test_primary_is_saved_outside_deleted_runtime_and_cannot_be_replaced(self):
        from ops.installer import operation_evidence
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {}, clear=False):
            home = Path(temporary)
            installer = home / 'installer'
            runtime = home / 'tavern/tavern-state/native-runtime'
            runtime.mkdir(parents=True)
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(installer), 'NORA_OPERATION_ID': OPERATION_ID}):
                original = RuntimeError('original startup failure')
                original.__cause__ = PermissionError(errno.EACCES, 'permission denied')
                first = operation_evidence.freeze(original, nora_home=home, context={'stage': 'first_install'})
                shutil.rmtree(runtime)
                operation_evidence.freeze(RuntimeError('later rollback failure'), nora_home=home)
            saved = json.loads(Path(first['path']).read_text())
            self.assertEqual(saved['operationId'], OPERATION_ID)
            self.assertEqual(saved['primary']['message'], 'original startup failure')
            self.assertEqual(saved['primary']['cause']['code'], 'EACCES')
            self.assertEqual(Path(first['path']).parent, installer / 'operations' / OPERATION_ID / 'evidence')
            self.assertTrue(Path(first['path']).is_file())
            self.assertTrue(Path(first['path']).parent.is_dir())
            if os.name != 'nt':
                self.assertEqual(Path(first['path']).stat().st_mode & 0o777, 0o600)
                self.assertEqual(Path(first['path']).parent.stat().st_mode & 0o777, 0o700)

    def test_actual_save_failure_preserves_primary_and_projects_missing_to_the_parent(self):
        from ops.installer import operation_evidence, error_diagnostics
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            blocked = home / 'blocked'
            blocked.write_text('fixture directory unavailable')
            with self.assertRaises(OSError) as unavailable:
                (blocked / 'operations' / OPERATION_ID / 'evidence').mkdir(parents=True, exist_ok=True)
            native_code = errno.errorcode[unavailable.exception.errno]
            original = RuntimeError('original startup failed')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(blocked), 'NORA_OPERATION_ID': OPERATION_ID}):
                saved = operation_evidence.freeze(original, nora_home=home)
            self.assertEqual(str(original), 'original startup failed')
            self.assertIn('save_failed:' + native_code, saved['missingReasons'])
            detail = error_diagnostics.exception_diagnostic(original)
            self.assertIn('save_failed:' + native_code, detail['missingReasons'])
            self.assertEqual(detail['secondaryErrors'][0]['error']['code'], native_code)
            self.assertIn('operation_evidence.py', detail['secondaryErrors'][0]['error']['stack'])

    def test_saved_program_evidence_excludes_sensitive_fields_and_subprocess_output(self):
        import subprocess
        from ops.installer import operation_evidence
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            child = subprocess.CalledProcessError(7, ['fixture', 'PRIVATE_ARGUMENT'], output='PRIVATE_OUTPUT', stderr='PRIVATE_STDERR')
            error = RuntimeError('write failed api_key="PRIVATE_KEY" /Users/private-account/runtime/data.yaml')
            error.__cause__ = child
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer'), 'NORA_OPERATION_ID': OPERATION_ID}):
                saved = operation_evidence.freeze(error, nora_home=home)
            serialized = Path(saved['path']).read_text()
            self.assertNotIn('PRIVATE_', serialized)
            self.assertNotIn('private-account', serialized)
            self.assertIn('7', serialized)

    def test_later_secondary_is_persisted_without_changing_the_frozen_primary(self):
        from ops.installer import operation_evidence
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer'), 'NORA_OPERATION_ID': OPERATION_ID}):
                error = RuntimeError('original startup failure')
                initial = operation_evidence.freeze(error, nora_home=home)['primary']
                error.secondary_errors = [PermissionError(errno.EACCES, 'rollback denied')]
                updated = operation_evidence.freeze(error, nora_home=home)
            saved = json.loads(Path(updated['path']).read_text())
            self.assertEqual(saved['primary'], initial)
            self.assertEqual(saved['secondaryErrors'][0]['error']['code'], 'EACCES')

    def test_unreviewed_persisted_fields_cannot_be_loaded_as_frozen_primary(self):
        from ops.installer import operation_evidence
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            directory = home / 'installer/operations' / OPERATION_ID / 'evidence'; directory.mkdir(parents=True)
            path = directory / 'python.json'
            path.write_text(json.dumps({'schema': 1, 'operationId': OPERATION_ID,
                'primary': {'name': 'RuntimeError', 'message': 'private-config', 'stdout': 'PRIVATE_OUTPUT'}}))
            original = RuntimeError('actual startup failure')
            with patch.dict(os.environ, {'NORA_INSTALLER_DIRECTORY': str(home / 'installer')}):
                result = operation_evidence.freeze(original, nora_home=home, operation_id=OPERATION_ID)
            self.assertEqual(result['primary']['message'], 'actual startup failure')
            self.assertNotIn('PRIVATE_OUTPUT', json.dumps(result))
            self.assertIn('save_failed:UNKNOWN', result['missingReasons'])


if __name__ == '__main__':
    unittest.main()
