import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { storageFixture } from './nora-storage-fixture.mjs';
import { setConfigFilePath } from '../src/util.js';
import { createChatBackupStore } from '../src/chat-backup-store.js';
setConfigFilePath(path.resolve('default/config.yaml'));
const { queueChatBackup, flushChatBackups, chatBackupStatus, startChatBackupMaintenance, chatBackupStore } = await import('../src/chat-backup-runtime.js');

test('intermediate transaction saves cancel an older pending snapshot; shutdown flushes the final saved state', async t => {
    const f = await storageFixture(t);
    const world = await f.create('queued');
    const filePath = path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'), `${world.sessions.items[0].binding.chat_id}.jsonl`);
    const data = await fs.readFile(filePath, 'utf8');
    assert.equal(queueChatBackup({ directories: f.directories, filePath, data }).status, 'queued');
    assert.equal(queueChatBackup({ directories: f.directories, filePath, data, skip: true }).status, 'skipped');
    await flushChatBackups();
    assert.equal((await chatBackupStore(f.directories).list()).snapshots.length, 0);
    queueChatBackup({ directories: f.directories, filePath, data });
    const stop = startChatBackupMaintenance([f.directories]);
    await stop();
    assert.equal((await chatBackupStore(f.directories).list()).snapshots.length, 1);
    assert.equal(chatBackupStatus(f.directories).pending, 0);
    assert.equal(chatBackupStatus(f.directories).recent.at(-1).status, 'created');
    assert.deepEqual(queueChatBackup({ directories: f.directories, filePath, data }), { status: 'skipped', reason: 'shutdown' });
    assert.equal(chatBackupStatus(f.directories).pending, 0);
});

test('startup maintenance expires inactive managed snapshots without touching unidentified legacy files', async t => {
    const f = await storageFixture(t);
    const world = await f.create('startup');
    const filePath = path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'), `${world.sessions.items[0].binding.chat_id}.jsonl`);
    const data = await fs.readFile(filePath, 'utf8');
    const old = createChatBackupStore({ directories: f.directories, now: () => Date.now() - 31 * 86400000 });
    await old.capture({ filePath, data });
    await f.backup('chat_old_manual.jsonl', [{ chat_metadata: {}, character_name: world.name }]);
    const stop = startChatBackupMaintenance([f.directories]);
    t.after(stop);
    const deadline = Date.now() + 3000;
    while (!chatBackupStatus(f.directories).recent.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(chatBackupStatus(f.directories).recent.at(-1)?.status, 'maintenance');
    const list = await old.list();
    assert.equal(list.snapshots.length, 0);
    assert.equal(list.legacyFiles, 1);
});

test('missing backup storage is a backup failure, not a silently superseded save', async t => {
    const f = await storageFixture(t);
    const world = await f.create('missing-backups');
    const filePath = path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'), `${world.sessions.items[0].binding.chat_id}.jsonl`);
    const data = await fs.readFile(filePath, 'utf8');
    await fs.rmdir(f.directories.backups);
    queueChatBackup({ directories: f.directories, filePath, data });
    await flushChatBackups();
    assert.equal(chatBackupStatus(f.directories).recent.at(-1).status, 'failed');
    assert.equal(await fs.readFile(filePath, 'utf8'), data);
});
