"""Partial managed repair authenticates old records; no first-install fallback."""
from contextlib import ExitStack
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ops.installer import launcher_bridge as bridge
from ops.updater import bootstrap, update


class ManagedPartialRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='nora-managed-partial-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home, self.tavern = self.root / 'hermes', self.root / 'tavern'
        self.args = SimpleNamespace(nora_home=self.root, hermes_home=self.home,
                                    install_root=self.tavern, port=18899)
        self.commit = 'a' * 40
        self.instance = {'schema': 1, 'noraHome': str(self.root), 'hermesHome': str(self.home),
                         'installRoot': str(self.tavern), 'port': self.args.port}
        self.write(self.home / 'nora-instance.json', self.instance)
        self.write(self.tavern / 'tavern-updates/installed.json', {
            'schema': 2, 'version': '2.4.5', 'commit': self.commit})
        self.write(self.tavern / 'tavern-updates/installed-manifest.json', {
            'schema': 'tavern-release/v2', 'versions': {'tavern': '2.4.5'}, 'commit': self.commit})
        self.write(self.tavern / 'tavern-updates/nora-system.json', {
            'schema': 1, 'version': '2.4.5', 'commit': self.commit,
            'proof': {name: True for name in bridge.nora_system.PROOFS}})
        self.write(self.home / 'hermes-agent/.hermes-bootstrap-complete', {
            'schema': 1, 'source': 'nora-integrated-runtime', 'sha256': 'b' * 64,
            'platform': 'win32' if os.name == 'nt' else 'darwin', 'arch': 'x64'})
        self.write(self.home / 'hermes-agent/venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python'), 'fixture Python')
        self.write(self.home / 'skills/creative/tavern/SKILL.md', 'preserved skill')
        self.write(self.home / 'config.yaml', update.render_mcp(self.home, self.tavern, self.args.port).decode())
        self.write(self.tavern / 'tavern-state/native/default-user/nora-world-core/worlds/story.json', '{"worldId":"story"}')
        self.write(self.tavern / 'tavern-state/native/default-user/chats/story/chat.jsonl', '{"message":"keep"}\n')

    def write(self, file, value):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(value) if isinstance(value, dict) else value, encoding='utf-8')

    def inventory(self):
        return {p.relative_to(self.root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.root.rglob('*') if p.is_file() and not p.is_symlink()}

    def snapshot(self):
        return bridge.partial_installation_snapshot(self.args)

    def test_missing_native_program_keeps_version_and_precise_absence_without_writes(self):
        before = self.inventory()
        snapshot = self.snapshot()
        self.assertEqual(snapshot['schema'], 'nora-managed-partial-installation/1')
        self.assertEqual((snapshot['version'], snapshot['commit']), ('2.4.5', self.commit))
        self.assertEqual(snapshot['missing'], {'nativeRuntime': True, 'nativeLifecycle': True, 'python': False})
        self.assertIsNone(snapshot['programs']['app'])
        self.assertEqual(self.inventory(), before)

    def test_python_only_missing_is_a_partial_installation_even_with_native_markers(self):
        (self.home / 'hermes-agent/venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')).unlink()
        self.write(self.tavern / 'apps/tavern-runtime/native-runtime.json', '{}')
        self.write(self.tavern / 'apps/tavern-runtime/native_lifecycle.py', 'pass\n')
        before = self.inventory()
        snapshot = self.snapshot()
        self.assertEqual(snapshot['missing'], {'nativeRuntime': False, 'nativeLifecycle': False, 'python': True})
        self.assertRegex(snapshot['programs']['app']['digest'], r'^[a-f0-9]{64}$')
        self.assertEqual(self.inventory(), before)

    def test_conflicting_version_records_and_wrong_instance_never_get_repair_admission(self):
        for relative, field, value in (
            ('tavern/tavern-updates/nora-system.json', 'commit', 'c' * 40),
            ('tavern/tavern-updates/installed.json', 'version', '2.0.1'),
            ('tavern/tavern-updates/installed-manifest.json', 'commit', 'c' * 40),
            ('hermes/nora-instance.json', 'port', 18898),
            ('hermes/nora-instance.json', 'installRoot', str(self.root / 'other')),
        ):
            file = self.root / relative
            previous = file.read_bytes()
            record = json.loads(previous)
            record[field] = value
            file.write_text(json.dumps(record))
            before = self.inventory()
            with self.subTest(relative=relative, field=field), self.assertRaises(RuntimeError):
                self.snapshot()
            self.assertEqual(self.inventory(), before)
            file.write_bytes(previous)

    def test_dangling_record_links_and_data_links_refuse_without_following_or_removing(self):
        target = self.tavern / 'tavern-updates/installed.json'
        original = target.read_bytes()
        target.unlink()
        try:
            target.symlink_to(self.root / 'outside-missing-record')
        except OSError as error:
            self.skipTest(f'symlink unavailable: {error}')
        with self.assertRaises(RuntimeError):
            self.snapshot()
        self.assertTrue(target.is_symlink())
        target.unlink()
        target.write_bytes(original)
        story = self.tavern / 'tavern-state/native/default-user/nora-world-core/worlds/story.json'
        original = story.read_bytes()
        external = self.root / 'external-story.json'
        external.write_bytes(original)
        story.unlink()
        story.symlink_to(external)
        with self.assertRaises(RuntimeError):
            self.snapshot()
        self.assertTrue(story.is_symlink())
        self.assertEqual(external.read_bytes(), original)

    def test_offline_preflight_requires_process_proof_and_refuses_live_or_unknown_gateway(self):
        before = self.inventory()
        with patch.object(bridge, '_recovery_require_native_offline') as native, \
                patch.object(bridge, 'check_gateway_control') as control, \
                patch.object(bridge, 'gateway_status', return_value={'gatewayRunning': False}):
            result = bridge.partial_repair_preflight(self.args)
        native.assert_called_once_with(self.args)
        control.assert_called_once()
        self.assertEqual(result['offline'], True)
        self.assertEqual(result['systemReady'], False)
        for state in ({'gatewayRunning': True}, {'gatewayRunning': None}, {}):
            with patch.object(bridge, '_recovery_require_native_offline'), \
                    patch.object(bridge, 'check_gateway_control'), \
                    patch.object(bridge, 'gateway_status', return_value=state), \
                    self.subTest(state=state), self.assertRaises(RuntimeError):
                bridge.partial_repair_preflight(self.args)
        self.assertEqual(self.inventory(), before)

    def test_snapshot_changed_after_preflight_cannot_be_reused_for_rollback(self):
        snapshot = self.snapshot()
        self.write(self.tavern / 'apps/tavern-runtime/native-runtime.json', '{}')
        before = self.inventory()
        with patch.object(bridge, '_recovery_require_native_offline'), \
                patch.object(bridge, 'check_gateway_control'), \
                patch.object(bridge, 'gateway_status', return_value={'gatewayRunning': False}), \
                self.assertRaises(RuntimeError):
            bridge.verify_partial_restoration(self.args, snapshot)
        self.assertEqual(self.inventory(), before)

    def test_partial_rollback_dto_cannot_bypass_canonical_journal_ownership(self):
        snapshot = self.snapshot()
        self.write(self.tavern / 'tavern-updates/transaction.json', {
            'recoveryPlan': {'state': {'phase': 'pending'}, 'targets': []}})
        before = self.inventory()
        with patch.object(bridge, '_recovery_require_native_offline'), \
                patch.object(bridge, 'check_gateway_control'), \
                patch.object(bridge, 'gateway_status', return_value={'gatewayRunning': False}), \
                self.assertRaises(RuntimeError):
            bridge.verify_partial_baseline(self.args, snapshot)
        self.assertEqual(self.inventory(), before)

    def test_only_authenticated_managed_partial_targets_bypass_missing_native_marker(self):
        with patch.dict(os.environ, {'HERMES_HOME': str(self.home)}, clear=True), \
                self.assertRaisesRegex(RuntimeError, '完整'):
            bootstrap.resolve_update_target(self.home, self.tavern, managed_home=self.root)
        snapshot = self.snapshot()
        plan = {**self.instance, 'before': {'version': '2.4.5', 'systemReady': False,
                 'running': False, 'gatewayRunning': False, 'clawchatConnected': False}, 'partialRepair': snapshot}
        before = self.inventory()
        with patch.dict(os.environ, {'HERMES_HOME': str(self.home), 'NORA_UPDATE_LIFECYCLE': json.dumps(plan)}, clear=True):
            self.assertEqual(bootstrap.resolve_update_target(self.home, self.tavern, managed_home=self.root), (self.home, self.tavern))
            plan['partialRepair']['bindings']['receipt'] = '0' * 64
            os.environ['NORA_UPDATE_LIFECYCLE'] = json.dumps(plan)
            with self.assertRaises(RuntimeError):
                bootstrap.resolve_update_target(self.home, self.tavern, managed_home=self.root)
        self.assertEqual(self.inventory(), before)


if __name__ == '__main__':
    unittest.main()
