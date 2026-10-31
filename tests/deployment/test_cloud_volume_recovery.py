"""Real-filesystem rollback across program and persistent-data volumes.

The optional native Linux case uses /dev/shm only for private temporary files.
No services, installed application or external model are involved.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('cloud_volume_recovery', ROOT / 'ops/installer/update_recovery.py')
RECOVERY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECOVERY)


class CloudVolumeRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nora-core-volume-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        if not Path('/dev/shm').is_dir() or not os.access('/dev/shm', os.W_OK):
            self.skipTest('A second writable native filesystem is required')
        if Path('/dev/shm').stat().st_dev == self.base.stat().st_dev:
            self.skipTest('The native fixture needs two distinct filesystems')
        self.other = tempfile.TemporaryDirectory(prefix='nora-data-volume-', dir='/dev/shm')
        self.addCleanup(self.other.cleanup)
        self.volume = Path(self.other.name)
        self.home, self.state, self.root = self.volume/'agent', self.volume/'stories', self.base/'programs'
        for path in (self.home, self.state, self.root):path.mkdir()
        self.config = self.home/'config.yaml'
        self.config.write_text(yaml.safe_dump({'nora_tavern': {
            'installRoot': str(self.root), 'stateRoot': str(self.state), 'port': 18899}}))
        self.story = self.state/'story.txt'
        self.story.write_text('original story')
        self.app = self.root/'apps/tavern-runtime'
        self.skill = self.home/'skills/creative/tavern'
        for path in (self.app, self.skill):
            path.mkdir(parents=True)
            (path/'code.txt').write_text('old code')
        self.backup = self.root/'tavern-backups/fixture'
        (self.backup/'host/update-receipts').mkdir(parents=True)
        (self.backup/'agents-rollback').mkdir()
        updates = self.root/'tavern-updates'
        updates.mkdir()
        receipt = {'version': '2.4.2'}
        for path in (updates/'installed.json', self.backup/'host/update-receipts/installed.json'):
            path.write_text(json.dumps(receipt))
        shutil.copy2(self.config, self.backup/'host/config.yaml')
        (self.backup/RECOVERY.RECEIPT).write_text(json.dumps({
            'schema': 'nora-update-backup/1', 'owner': 'nora-tavern-updater',
            'installRoot': str(self.root), 'backupId': self.backup.name, 'status': 'prepared'}))
        self.sources = []
        for name, target in (('app', self.app), ('skill-creative-tavern', self.skill)):
            source = self.base/('new-'+name)
            source.mkdir()
            (source/'code.txt').write_text('new code')
            self.sources.append((name, source, target))

    def journal(self):
        return RECOVERY.Journal.create(self.home,self.root,self.backup,self.sources,
            version='2.5.8',before={'scope':'standalone-tavern','version':'2.4.2','running':False},state=self.state)

    def recover(self):
        return RECOVERY.recover(self.home,self.root,stop=lambda *_:{'offline':True},
            resume=lambda *_:None,verify=lambda *_:{'version':'2.4.2','running':False})

    def test_snapshot_program_config_and_data_recovery_across_real_volumes(self):
        original = self.config.read_bytes()
        journal = self.journal()
        journal.seal_offline({'offline':True})
        journal.snapshot_state()
        for name,_,_ in self.sources:journal.swap(name)
        journal.mark_metadata([self.config])
        value=yaml.safe_load(original)
        value['model']={'provider':'custom','default':'new'}
        self.config.write_text(yaml.safe_dump(value))
        journal.finish_metadata([self.config])
        (self.state/'new-cache.txt').write_text('runtime change')
        self.assertEqual(self.recover()['status'],'restored')
        self.assertEqual(self.config.read_bytes(),original)
        self.assertEqual(self.story.read_text(),'original story')
        self.assertFalse((self.state/'new-cache.txt').exists())
        for path in (self.app,self.skill):self.assertEqual((path/'code.txt').read_text(),'old code')
        self.assertNotEqual(self.root.stat().st_dev,self.state.stat().st_dev)
        self.assertFalse((self.root/'tavern-state').exists())
        # Re-reading the durable transaction is required, not just in-memory success.
        self.assertEqual(RECOVERY.load(self.home,self.root).record['status'],'restored')

    def test_migration_swap_and_interrupted_restore_resume_across_real_volumes(self):
        journal=self.journal()
        journal.seal_offline({'offline':True})
        prepared=self.base/'prepared-state'
        shutil.copytree(self.state,prepared)
        (prepared/'converted.txt').write_text('converted representation')
        journal.apply_state(prepared)
        self.assertTrue((self.state/'converted.txt').exists())
        replace=RECOVERY.os.replace
        failed=False
        def interrupted(source,target):
            nonlocal failed
            if Path(source)==journal.state_backup() and Path(target)==self.state and not failed:
                failed=True
                raise OSError('simulated interruption before original state publication')
            return replace(source,target)
        with patch.object(RECOVERY.os,'replace',side_effect=interrupted):
            with self.assertRaisesRegex(OSError,'simulated interruption'):self.recover()
        self.assertTrue(failed)
        self.assertEqual(self.recover()['status'],'restored')
        self.assertEqual(self.story.read_text(),'original story')
        self.assertFalse((self.state/'converted.txt').exists())

    def test_target_volume_backup_cleanup_requires_unchanged_owned_evidence(self):
        journal=self.journal()
        journal.seal_offline({'offline':True})
        journal.snapshot_state()
        journal.swap('skill-creative-tavern')
        journal.seal_volume_backups()
        state_workspace=journal.local_workspace(self.state)
        changed=state_workspace/'user-added.txt'
        changed.write_text('keep unknown evidence')
        with self.assertRaisesRegex(RuntimeError,'已变化'):
            RECOVERY.retire_volume_backups(self.home,self.root,self.backup,self.state)
        self.assertTrue(changed.exists())
        changed.unlink()
        RECOVERY.retire_volume_backups(self.home,self.root,self.backup,self.state)
        self.assertFalse(state_workspace.exists())
        self.assertEqual(self.story.read_text(),'original story')
        self.assertEqual((self.skill/'code.txt').read_text(),'new code')
