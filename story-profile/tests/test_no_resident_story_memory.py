"""The archive remains intact; normal Nora memory contains no resident plot."""
import os
import hashlib
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'core'))
import story_profile as p


class NoResidentPlotMemory(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nora-no-plot-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state, self.memories = self.root / '档案原件', self.root / 'memories'
        self.seed = self.root / 'seed.md'
        self.seed.write_text('# 合成身份\n', encoding='utf-8')
        (self.root / 'config.yaml').write_text('memory:\n  user_char_limit: 2000\n', encoding='utf-8')
        environment = patch.dict(os.environ, {'TAVERN_HERMES_MEMORIES_DIR': str(self.memories),
                                              'TAVERN_HERMES_STATE_DB': str(self.root / 'state.db')})
        environment.start(); self.addCleanup(environment.stop)
        p.ensure_profile(self.state, self.seed)

    def summary(self, text='偏爱悬疑题材'):
        return {key: [text] if key == 'story_tastes' else [] for key in p.TASTE_PROFILE_V2_FIELDS}

    def production(self):
        return {'id':'world', 'world_id':'world', 'session_id':'branch', 'name':'合成世界', 'total_turns':20,
                'story_state':{'status':'prepared','covered_turns':15,'total_turns':20,
                               'timeline':['绝不能常驻注入的合成剧情'], 'open_threads':['仅按需查看的未解事项']}}

    def old_memory(self, revision=None):
        value = p.load_profile(self.state, self.seed)
        revision = value['revision'] if revision is None else revision
        prefix = 'Hermes自己的记忆\r\n不要更改此处。\r\n'.encode('utf-8')
        suffix = '\r\n## 私人附记\r\n保留全部末尾空行。\r\n\r\n'.encode('utf-8')
        block = (p.MEMORY_START+'\r\n'+p.PROJECTION_REVISION_PREFIX+str(revision)+' -->\r\n旧剧情\r\n'+p.MEMORY_END).encode('utf-8')
        target = self.memories / 'MEMORY.md'; target.write_bytes(prefix+block+suffix)
        return target, prefix+block+suffix, prefix+suffix

    def test_normal_sync_does_not_create_memory_file_or_inject_plot_into_legacy_context(self):
        p.sync_story_states(self.state, self.seed, [self.production()])
        current = p.load_profile(self.state, self.seed)
        self.assertFalse((self.memories/'MEMORY.md').exists())
        self.assertEqual(p.memory_preview(current)['memory'], '')
        self.assertNotIn('绝不能常驻注入', p.context_for_message(current))
        self.assertNotIn('与用户共同记得的故事', p.context_for_message(current))
        self.assertEqual(current['shared_story_memory'][0]['events'], ['绝不能常驻注入的合成剧情'])

    def test_complete_owned_block_is_backed_up_then_only_its_bytes_are_removed(self):
        target, before, expected = self.old_memory()
        result = p.sync_profile_memories(self.state, self.seed)
        self.assertEqual(result['memory']['status'], 'complete')
        self.assertEqual(result['memory']['action'], 'removed_legacy_story_block')
        self.assertEqual(target.read_bytes(), expected)
        backup = Path(result['memory']['backup'])
        self.assertEqual(backup.read_bytes(), before)
        self.assertTrue(backup.resolve().is_relative_to(self.memories.resolve()))
        user = (self.memories/'USER.md').read_bytes()
        again = p.sync_profile_memories(self.state, self.seed)
        self.assertFalse(again['memory']['changed']); self.assertEqual(target.read_bytes(), expected)
        self.assertEqual((self.memories/'USER.md').read_bytes(), user)
        self.assertEqual(backup.read_bytes(), before)

    def test_confirmed_older_source_revision_is_backed_up_and_removed(self):
        p.set_taste_profile(self.state, self.seed, self.summary())
        current = p.load_profile(self.state, self.seed)
        target, before, expected = self.old_memory(revision=current['revision'] - 1)
        result = p.sync_profile_memories(self.state, self.seed)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['memory']['action'], 'removed_legacy_story_block')
        self.assertEqual(target.read_bytes(), expected)
        self.assertEqual(Path(result['memory']['backup']).read_bytes(), before)

    def test_unmanaged_memory_is_unchanged_even_when_full_or_its_budget_is_invalid(self):
        target = self.memories/'MEMORY.md'; before = ('Hermes非托管记忆。'*400).encode('utf-8'); target.write_bytes(before)
        (self.root/'config.yaml').write_text('memory:\n  user_char_limit: 2000\n  memory_char_limit: false\n', encoding='utf-8')
        p.set_taste_profile(self.state, self.seed, self.summary())
        result = p.sync_profile_memories(self.state, self.seed)
        self.assertEqual(result['status'], 'complete'); self.assertEqual(result['memory']['action'], 'no_story_block')
        self.assertEqual(target.read_bytes(), before)
        self.assertIn('偏爱悬疑题材', (self.memories/'USER.md').read_text(encoding='utf-8'))

    def test_damaged_or_repeated_boundaries_do_not_remove_anything_or_block_user(self):
        target = self.memories/'MEMORY.md'
        for content in (p.MEMORY_START+'\n不完整', p.MEMORY_END+'\n反序'+p.MEMORY_START,
                        p.MEMORY_START+p.MEMORY_END+p.MEMORY_START+p.MEMORY_END):
            with self.subTest(content=content):
                raw = content.encode('utf-8'); target.write_bytes(raw)
                result = p.sync_profile_memories(self.state, self.seed)
                self.assertEqual(result['user']['status'], 'complete')
                self.assertEqual(result['memory']['code'], 'STORY_PROFILE_MEMORY_MARKERS_UNCONFIRMED')
                self.assertEqual(result['status'], 'partial'); self.assertEqual(target.read_bytes(), raw)

    def test_backup_failure_or_removal_failure_preserves_original_and_user_can_sync(self):
        original = getattr(p, '_atomic_bytes', None)
        for failure_site in ('backup', 'target'):
            with self.subTest(failure_site=failure_site):
                target, before, _ = self.old_memory()
                def denied(path, content):
                    if (failure_site == 'target' and path == target) or (failure_site == 'backup' and path != target):
                        raise PermissionError('synthetic independent cleanup failure')
                    return original(path, content)
                with patch.object(p, '_atomic_bytes', side_effect=denied, create=True):
                    result = p.sync_profile_memories(self.state, self.seed)
                self.assertEqual(result['user']['status'], 'complete')
                self.assertEqual(result['memory']['status'], 'pending')
                self.assertEqual(target.read_bytes(), before)

    def test_all_local_entry_points_keep_the_archive_but_never_reinject_plot(self):
        p.record_learning(self.state, self.seed, '偏爱悬疑题材', '合成证据', source_id='one')
        p.set_taste_profile(self.state, self.seed, self.summary())
        p.sync_story_states(self.state, self.seed, [self.production()])
        before = p.load_profile(self.state, self.seed)
        events = (self.state/p.EVENTS_FILENAME).read_bytes()
        p.sync_profile_memories(self.state, self.seed)
        p.recover_profile(self.state, self.seed)
        p.sync_story_states(self.state, self.seed, [self.production()])
        after = p.load_profile(self.state, self.seed)
        self.assertEqual(after, before); self.assertEqual((self.state/p.EVENTS_FILENAME).read_bytes(), events)
        self.assertEqual(after['shared_story_memory'], before['shared_story_memory'])
        self.assertEqual(p.memory_preview(after)['memory'], '')
        self.assertFalse((self.memories/'MEMORY.md').exists())

    def test_cleanup_invalidates_same_revision_cached_plot_and_retries_without_file_change(self):
        target, _, _ = self.old_memory()
        current = p.load_profile(self.state, self.seed)
        marker = p._projection_marker(current)
        database = self.root/'state.db'
        with closing(sqlite3.connect(database)) as db, db:
            db.execute('CREATE TABLE sessions(id INTEGER PRIMARY KEY, source TEXT, ended_at INTEGER, system_prompt TEXT)')
            db.executemany('INSERT INTO sessions(source,ended_at,system_prompt) VALUES(?,?,?)',
                           [('clawchat',None,marker+' '+p.MEMORY_START+'旧剧情'+p.MEMORY_END),
                            ('clawchat',None,marker+' 保留当前USER提示'), ('cli',None,'保留CLI提示')])
        first = p.sync_profile_memories(self.state, self.seed)
        with closing(sqlite3.connect(database)) as db, db:
            self.assertEqual(db.execute('SELECT system_prompt FROM sessions ORDER BY id').fetchall(), [(None,), (marker+' 保留当前USER提示',), ('保留CLI提示',)])
            db.execute('UPDATE sessions SET system_prompt=? WHERE id=1', (marker+' '+p.MEMORY_START+'旧剧情'+p.MEMORY_END,))
        second = p.sync_profile_memories(self.state, self.seed)
        self.assertEqual(second['changed'], [])
        with closing(sqlite3.connect(database)) as db, db:
            self.assertIsNone(db.execute('SELECT system_prompt FROM sessions WHERE id=1').fetchone()[0])
        self.assertGreaterEqual(first['prompt_cache']['invalidated'],1); self.assertGreaterEqual(second['prompt_cache']['invalidated'],1)

    def test_old_snapshot_cannot_remove_a_block_with_newer_revision(self):
        current = p.load_profile(self.state, self.seed)
        target, before, _ = self.old_memory(revision=current['revision']+10)
        result = p.sync_hermes_memories(current)
        self.assertEqual(result['memory']['code'], 'STORY_PROFILE_PROJECTION_STALE')
        self.assertEqual(target.read_bytes(), before)

    def test_locked_prompt_cache_is_partial_and_retries_after_memory_block_is_removed(self):
        target, _, expected = self.old_memory()
        database = self.root / 'state.db'
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute('CREATE TABLE sessions(id INTEGER PRIMARY KEY, source TEXT, ended_at INTEGER, system_prompt TEXT)')
            cached = p.MEMORY_START + ' cached synthetic plot ' + p.MEMORY_END
            connection.execute('INSERT INTO sessions(source,ended_at,system_prompt) VALUES(?,?,?)', ('clawchat', None, cached))
        with closing(sqlite3.connect(database)) as writer:
            writer.execute('BEGIN IMMEDIATE')
            try:
                first = p.sync_profile_memories(self.state, self.seed)
            finally:
                writer.rollback()
        self.assertEqual(first['status'], 'partial')
        self.assertEqual(first['user']['status'], 'complete')
        self.assertEqual(first['memory']['status'], 'complete')
        self.assertEqual(target.read_bytes(), expected)
        self.assertEqual(first['prompt_cache']['status'], 'pending')
        self.assertEqual(first['prompt_cache']['code'], 'STORY_PROFILE_PROMPT_CACHE_PENDING')
        self.assertTrue(first['prompt_cache']['retryable'])
        self.assertEqual(p.projection_status(self.state)['status'], 'partial')
        with closing(sqlite3.connect(database)) as connection:
            self.assertEqual(connection.execute('SELECT system_prompt FROM sessions').fetchone()[0], cached)
        user = (self.memories / 'USER.md').read_bytes()
        second = p.sync_profile_memories(self.state, self.seed)
        self.assertEqual(second['status'], 'complete')
        self.assertEqual(second['changed'], [])
        self.assertEqual(second['prompt_cache']['status'], 'complete')
        self.assertEqual(second['prompt_cache']['invalidated'], 1)
        self.assertEqual(target.read_bytes(), expected)
        self.assertEqual((self.memories / 'USER.md').read_bytes(), user)
        with closing(sqlite3.connect(database)) as connection:
            self.assertIsNone(connection.execute('SELECT system_prompt FROM sessions').fetchone()[0])

    def test_corrupt_or_unsupported_prompt_cache_stays_partial_without_replacing_database(self):
        database = self.root / 'state.db'
        for mode in ('corrupt', 'unsupported-schema'):
            with self.subTest(mode=mode):
                if database.exists():
                    database.unlink()
                if mode == 'corrupt':
                    database.write_bytes(b'synthetic invalid SQLite')
                else:
                    with closing(sqlite3.connect(database)) as connection, connection:
                        connection.execute('CREATE TABLE sessions(id INTEGER PRIMARY KEY, system_prompt TEXT)')
                original = database.read_bytes()
                result = p.recover_profile(self.state, self.seed, include_status=True)['projections']
                self.assertEqual(result['status'], 'partial')
                self.assertEqual(result['user']['status'], 'complete')
                self.assertEqual(result['memory']['status'], 'complete')
                self.assertEqual(result['prompt_cache']['status'], 'pending')
                self.assertEqual(result['prompt_cache']['code'], 'STORY_PROFILE_PROMPT_CACHE_PENDING')
                self.assertEqual(database.read_bytes(), original)

    def test_missing_prompt_cache_is_not_needed_and_does_not_create_database(self):
        database = self.root / 'state.db'
        result = p.sync_profile_memories(self.state, self.seed)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['prompt_cache']['status'], 'not-needed')
        self.assertFalse(result['prompt_cache']['retryable'])
        self.assertFalse(database.exists())

    def test_unverifiable_or_multiple_source_revisions_keep_original_memory_pending(self):
        current = p.load_profile(self.state, self.seed)
        revision = current['revision']
        marker = p.PROJECTION_REVISION_PREFIX + str(revision) + ' -->'
        cases = {
            'missing': '',
            'malformed-value': p.PROJECTION_REVISION_PREFIX + 'invalid -->',
            'malformed-close': p.PROJECTION_REVISION_PREFIX + str(revision),
            'negative': p.PROJECTION_REVISION_PREFIX + '-1 -->',
            'partial-number': p.PROJECTION_REVISION_PREFIX + str(revision) + 'x -->',
            'trailing-garbage': marker + ' damaged',
            'line-prefix': 'damaged ' + marker,
            'duplicate': marker + '\n' + marker,
            'conflicting': marker + '\n' + p.PROJECTION_REVISION_PREFIX + str(revision + 10) + ' -->',
        }
        target = self.memories / 'MEMORY.md'
        for name, source in cases.items():
            with self.subTest(name=name):
                original = ('Hermes自己的记忆\r\n' + p.MEMORY_START + '\r\n' + source
                            + '\r\n合成剧情\r\n' + p.MEMORY_END + '\r\n保留末尾\r\n').encode('utf-8')
                target.write_bytes(original)
                result = p.sync_profile_memories(self.state, self.seed)
                self.assertEqual(result['status'], 'partial')
                self.assertEqual(result['user']['status'], 'complete')
                self.assertEqual(result['memory']['status'], 'pending')
                self.assertEqual(result['memory']['code'], 'STORY_PROFILE_MEMORY_REVISION_UNCONFIRMED')
                self.assertEqual(target.read_bytes(), original)
                self.assertFalse((self.memories / '.tavern-shared-memory-backups').exists())

    def test_inline_memory_boundaries_are_preserved_as_unconfirmed(self):
        current = p.load_profile(self.state, self.seed)
        block = p.MEMORY_START + '\n' + p._projection_marker(current) + '\n合成剧情\n' + p.MEMORY_END
        cases = (block.replace(p.MEMORY_START, 'inline ' + p.MEMORY_START),
                 block.replace(p.MEMORY_START, p.MEMORY_START + ' damaged'),
                 block.replace(p.MEMORY_END, 'inline ' + p.MEMORY_END),
                 block.replace(p.MEMORY_END, p.MEMORY_END + ' damaged'))
        target = self.memories / 'MEMORY.md'
        for content in cases:
            with self.subTest(content=content):
                original = content.encode('utf-8')
                target.write_bytes(original)
                result = p.sync_profile_memories(self.state, self.seed)
                self.assertEqual(result['status'], 'partial')
                self.assertEqual(result['memory']['code'], 'STORY_PROFILE_MEMORY_MARKERS_UNCONFIRMED')
                self.assertEqual(target.read_bytes(), original)

    def test_conflicting_backup_is_preserved_and_cannot_authorize_removal(self):
        target, before, _ = self.old_memory()
        backups = self.memories/'.tavern-shared-memory-backups'; backups.mkdir()
        backup = backups/('MEMORY.'+hashlib.sha256(before).hexdigest()+'.md')
        backup.write_bytes(b'preexisting unconfirmed backup')
        result = p.sync_profile_memories(self.state,self.seed)
        self.assertEqual(result['user']['status'],'complete')
        self.assertEqual(result['memory']['code'],'STORY_PROFILE_MEMORY_BACKUP_UNCONFIRMED')
        self.assertEqual(target.read_bytes(),before)
        self.assertEqual(backup.read_bytes(),b'preexisting unconfirmed backup')

    def test_external_change_after_backup_is_not_overwritten_by_cleanup(self):
        target, before, _ = self.old_memory()
        original = p._atomic_bytes
        def another_writer(path, content):
            original(path,content)
            if path.parent.name == '.tavern-shared-memory-backups':
                target.write_bytes(before+b'\r\nother writer memory')
        with patch.object(p,'_atomic_bytes',side_effect=another_writer):
            result = p.sync_profile_memories(self.state,self.seed)
        self.assertEqual(result['memory']['code'],'STORY_PROFILE_MEMORY_CHANGED')
        self.assertEqual(target.read_bytes(),before+b'\r\nother writer memory')
        backups=list((self.memories/'.tavern-shared-memory-backups').glob('*.md'))
        self.assertEqual(len(backups),1); self.assertEqual(backups[0].read_bytes(),before)


if __name__ == '__main__':
    unittest.main()
