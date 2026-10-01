import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('actual stdio MCP → backup/ledger HTTP verifies read, export, protection, isolation and replay-safe restore', async t => {
    assert.ok(process.env.NORA_TAVERN_SOURCE, 'Set NORA_TAVERN_SOURCE to the Tavern engine directory');
    const engine = path.resolve(process.env.NORA_TAVERN_SOURCE);
    const fromEngine = file => import(pathToFileURL(path.join(engine, file)).href);
    const express = createRequire(path.join(engine, 'package.json'))('express');
    const { setConfigFilePath } = await fromEngine('src/util.js');
    setConfigFilePath(path.join(engine, 'default/config.yaml'));
    // Production World identities/storage and backup/ledger behavior. All state
    // and projection destinations are temporary; no model routes are mounted.
    const { storageFixture } = await fromEngine('tests/nora-storage-fixture.mjs');
    const { router } = await fromEngine('src/endpoints/backups.js');
    const { chatBackupStore } = await fromEngine('src/chat-backup-runtime.js');
    const { chatSessionOperations } = await fromEngine('src/chat-session-operations.js');
    const f = await storageFixture(t);
    const a = await f.create('backup-a'), b = await f.create('backup-b');
    const scope = world => ({ worldId: world.world_id, sessionId: world.sessions.default_session_id });
    const chatFile = world => path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'), `${world.sessions.items[0].binding.chat_id}.jsonl`);
    const header = (await f.chat(a))[0];
    const original = [header, { name: 'NPC', mes: 'x'.repeat(5000), extra: { stat_data: { hp: 10 } } }, { is_user: true, mes: 'Open at nine' }].map(JSON.stringify).join('\n');
    await fs.writeFile(chatFile(a), original);
    const store = chatBackupStore(f.directories);
    const saved = await store.capture({ filePath: chatFile(a), data: original, mvuState: 'confirmed' });
    const otherBefore = await fs.readFile(chatFile(b));
    const other = await store.capture({ filePath: chatFile(b), data: otherBefore });
    const app = express();
    app.use(express.json());
    app.get('/csrf-token', (_req, res) => res.cookie('session', 'fixture').json({ token: 'fixture' }));
    let advertisedRoot = f.root;
    app.get('/api/nora-worlds-v2/status', (_req, res) => res.json({ userDataRoot: advertisedRoot }));
    let received = 0;
    app.use((req, res, next) => {
        received++;
        if (req.headers['x-csrf-token'] !== 'fixture' || !req.headers.cookie?.includes('session=fixture')) return res.sendStatus(403);
        req.user = { directories: f.directories, profile: { handle: 'fixture' } }; next();
    });
    app.use('/api/backups', router);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const client = new Client({ name: 'backup-isolation', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../../dist/server.js', import.meta.url))], env: {
            ...process.env, NORA_MCP_STATE_ROOT: f.root, NORA_MCP_USER_DATA_ROOT: f.root,
            NORA_MCP_MODE: 'operator', NORA_MCP_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        }, stderr: 'pipe' }));
    t.after(() => client.close());
    async function call(name, args = {}) {
        const result = await client.callTool({ name, arguments: args });
        let data;
        try { data = JSON.parse(result.content[0].text); }
        catch {
            assert.equal(result.isError, true, 'Only SDK validation errors may be non-JSON');
            data = { validationError: true };
        }
        return { error: result.isError === true, data };
    }
    const listed = await call('nora.backup.list', { ...scope(a), limit: 1 });
    assert.equal(listed.error, false);
    assert.equal(listed.data.totalMatched, 1);
    const item = listed.data.snapshots[0], proof = { id: item.id, sha256: item.sha256 };
    assert.equal(item.id, saved.id);
    const window = await call('nora.backup.read', { ...proof, offset: 0, limit: 1 });
    assert.equal(window.error, false);
    assert.equal(window.data.messageCount, 2);
    assert.equal(window.data.messages.length, 1);
    assert.equal(window.data.messages[0].text.length, 4000);
    assert.equal(window.data.messages[0].truncated, true);
    assert.equal(window.data.messages[0].extra, undefined);
    assert.equal(window.data.hasMore, true);
    const page2 = await call('nora.backup.read', { ...proof, offset: 1, limit: 1 });
    assert.equal(page2.data.messages[0].text, 'Open at nine');
    const countBefore = received;
    const denied = await call('nora.backup.delete', proof);
    assert.equal(denied.error, true);
    assert.equal(received, countBefore, 'Missing approval is rejected before any backend call');
    assert.equal((await call('nora.backup.read', { ...proof, sha256: '0'.repeat(64) })).data.code, 'NORA_BACKUP_CHANGED');
    assert.equal((await call('nora.backup.delete', { ...proof, sha256: '0'.repeat(64), confirm: true })).data.code, 'NORA_BACKUP_CHANGED');
    assert.equal((await call('nora.backup.protect', { ...proof, protected: true, confirm: true })).data.status, 'updated');
    assert.equal((await call('nora.backup.delete', { ...proof, confirm: true })).data.code, 'NORA_BACKUP_PROTECTED');
    assert.ok((await call('nora.backup.list')).data.snapshots.find(x => x.id === saved.id).protected);
    await call('nora.backup.protect', { ...proof, protected: false, confirm: true });
    const exported = await call('nora.backup.download', { ...proof, confirm: true });
    assert.equal(exported.error, false);
    assert.equal(await fs.readFile(exported.data.path, 'utf8'), original);
    assert.equal(exported.data.sha256, proof.sha256);
    assert.equal((await fs.stat(exported.data.path)).mode & 0o777, 0o600);
    assert.equal((await call('nora.backup.restore_preview', { id: saved.id, ...scope(b) })).data.code, 'NORA_BACKUP_RESTORE_SCOPE_MISMATCH');
    let preview = (await call('nora.backup.restore_preview', { id: saved.id, ...scope(a) })).data;
    assert.equal(preview.previewOnly, true);
    assert.equal(preview.snapshot.sha256, proof.sha256);
    const stale = { ...proof, ...scope(a), expectedRevision: preview.current.revision };
    const continued = `${original}\n${JSON.stringify({ mes: 'A later message' })}`;
    await fs.writeFile(chatFile(a), continued);
    assert.equal((await call('nora.backup.restore', { ...stale, confirm: true })).data.code, 'NORA_BACKUP_RESTORE_STALE');
    assert.equal(await fs.readFile(chatFile(a), 'utf8'), continued);
    preview = (await call('nora.backup.restore_preview', { id: saved.id, ...scope(a) })).data;
    const accepted = { ...proof, ...scope(a), expectedRevision: preview.current.revision, confirm: true };
    assert.equal((await call('nora.backup.restore', { ...accepted, confirm: false })).error, true);
    const activity = chatSessionOperations(f.directories);
    const generation = activity.begin(scope(a), 'generation');
    try { assert.equal((await call('nora.backup.restore', accepted)).data.code, 'NORA_CHAT_OPERATION_BUSY'); }
    finally { activity.end(scope(a), generation.token); }
    const restored = await call('nora.backup.restore', accepted);
    assert.equal(restored.error, false, JSON.stringify(restored.data));
    assert.equal(restored.data.status, 'restored');
    assert.equal(restored.data.reloadRequired, true);
    assert.equal((await store.download(restored.data.protectedBackupId)).toString(), continued);
    assert.equal((await call('nora.backup.restore', accepted)).data.status, 'already-restored');
    const restoredLines = (await fs.readFile(chatFile(a), 'utf8')).split('\n').map(JSON.parse);
    assert.equal(restoredLines.length, 3);
    assert.deepEqual(restoredLines[1].extra, { stat_data: { hp: 10 } });
    assert.deepEqual(await fs.readFile(chatFile(b)), otherBefore, 'Other World is unchanged');
    const otherItem = (await call('nora.backup.list', scope(b))).data.snapshots.find(x => x.id === other.id);
    assert.equal((await call('nora.backup.delete', { id: other.id, sha256: otherItem.sha256, confirm: true })).data.status, 'deleted');
    assert.deepEqual(await fs.readFile(chatFile(b)), otherBefore, 'Deleting its backup never deletes the chat');
    advertisedRoot = f.directories.characters;
    assert.equal((await call('nora.backup.list')).data.code, 'NORA_INSTANCE_MISMATCH');
});
