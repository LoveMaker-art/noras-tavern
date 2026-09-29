import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import express from 'express';
import { getChatRevision } from '../src/chat-revision.js';
import { storageFixture } from './nora-storage-fixture.mjs';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(path.resolve('default/config.yaml'));
const { router } = await import('../src/endpoints/backups.js');
const { router: chatRouter } = await import('../src/endpoints/chats.js');
const { createNoraWorldsV2Router } = await import('../src/endpoints/nora-worlds-v2.js');
const { flushChatBackups, chatBackupStore } = await import('../src/chat-backup-runtime.js');
const { router: ledgerRouter } = await import('../src/endpoints/nora-story-ledger.js');
const { resolveStoryLedger } = await import('../src/nora-story-ledger/runtime.js');
const { chatSessionOperations } = await import('../src/chat-session-operations.js');
const { ledgerStatePath } = await import('../src/nora-story-ledger/state-file.js');

test('World deletion HTTP returns a conflict for active generation and one durable backup result on replay', async t => {
    const f = await storageFixture(t), world = await f.create('delete-http');
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const filePath = path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'), `${world.sessions.items[0].binding.chat_id}.jsonl`);
    const store = chatBackupStore(f.directories);
    const snapshot = await store.capture({ filePath, data: await fs.readFile(filePath, 'utf8'), protect: true });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories: f.directories }; next(); });
    app.use('/worlds', createNoraWorldsV2Router({ resolveCore: () => f.core }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const preview = await (await fetch(`http://127.0.0.1:${server.address().port}/worlds/worlds/${encodeURIComponent(world.world_id)}/delete-preview`)).json();
    assert.equal(preview.backups.length, 1);
    assert.equal(preview.backups[0].protected, true);
    assert.equal(preview.resources.filter(item => item.action === 'delete').length, 2);
    const remove = () => fetch(`http://127.0.0.1:${server.address().port}/worlds/worlds/${encodeURIComponent(world.world_id)}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotency_key: 'delete-http', expected_plan: preview.token }),
    });
    const operations = chatSessionOperations(f.directories), lease = operations.begin(scope, 'generation');
    const busy = await remove();
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error.code, 'NORA_CHAT_OPERATION_BUSY');
    assert.equal((await f.core.getWorld(world.world_id)).lifecycle.status, 'READY');
    operations.end(scope, lease.token);
    const done = await remove();
    assert.equal(done.status, 200);
    const result = await done.json();
    assert.equal(result.operation.result.backups.deleted.length, 1);
    assert.ok(result.operation.result.resources.some(item => item.kind === 'session'));
    await assert.rejects(store.download(snapshot.id), { code: 'ENOENT' });
    assert.deepEqual((await (await remove()).json()).operation.result, result.operation.result);
});

test('plain chat restores without MVU data or a prior ledger and accepts the next normal save', async t => {
    const f = await storageFixture(t), world = await f.create('restore-plain');
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const filePath = path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'), `${world.sessions.items[0].binding.chat_id}.jsonl`);
    const original = [...await f.chat(world), { is_user: false, mes: 'plain opening' }];
    const data = original.map(JSON.stringify).join('\n');
    await fs.writeFile(filePath, data);
    const store = chatBackupStore(f.directories), snapshot = await store.capture({ filePath, data });
    await fs.writeFile(filePath, [...original, { is_user: true, mes: 'discarded branch' }].map(JSON.stringify).join('\n'));
    const preview = await store.previewRestore({ ...scope, id: snapshot.id });
    const runtime = resolveStoryLedger(f.directories, { recoverProjection: false });
    await runtime.restore(scope, { id: snapshot.id, expectedRevision: preview.current.revision, sha256: preview.snapshot.sha256 });
    const restored = await f.chat(world);
    assert.deepEqual(restored.slice(1), original.slice(1));
    const state = await runtime.plugin.status(scope);
    assert.equal(state.active, null); assert.equal(state.pending, null); assert.equal(state.running, false);
    const continued = [...restored, { is_user: true, mes: 'continue from restored opening' }];
    await runtime.writeChat(filePath, continued, () => writeFileAtomicSync(filePath, continued.map(JSON.stringify).join('\n'), 'utf8'));
    assert.deepEqual(await f.chat(world), continued);
});

test('restoration HTTP coordinates ownership, invalidates ledger state, fences old saves and preserves normal continuation', async t => {
    const f = await storageFixture(t), world = await f.create('restore-runtime');
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const original = [...await f.chat(world), { is_user: false, mes: 'old reply', swipes: ['old reply', 'alternative'], swipe_id: 0,
        stat_data: { hp: 10 }, swipe_info: [{ extra: { stat_data: { hp: 10 } } }, { extra: { stat_data: { hp: 8 } } }], extra: { edited: true } }];
    original[0].chat_metadata.variables = { turn: 1 };
    const filePath = path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'), `${world.sessions.items[0].binding.chat_id}.jsonl`);
    await fs.writeFile(filePath, original.map(item => JSON.stringify(item)).join('\n'));
    const store = chatBackupStore(f.directories);
    const snapshot = await store.capture({ filePath, data: await fs.readFile(filePath), mvuState: 'confirmed' });
    await fs.writeFile(filePath, [...original, { is_user: true, mes: 'later action' }].map(item => JSON.stringify(item)).join('\n'));
    const statePath = ledgerStatePath(f.root, scope);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ version: 1, enabled: false, active: { id: 'old-active' }, pending: { id: 'old-pending' } }));
    const preview = await store.previewRestore({ ...scope, id: snapshot.id });
    const input = { id: snapshot.id, sha256: preview.snapshot.sha256, expectedRevision: preview.current.revision };
    const runtime = resolveStoryLedger(f.directories, { recoverProjection: false });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories: f.directories, profile: { handle: 'test' } }; next(); });
    app.use('/chats', chatRouter);
    app.use('/backups', router);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await flushChatBackups(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
    const restore = (extra = {}) => fetch(`http://127.0.0.1:${server.address().port}/backups/chat/restore`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...scope, ...input, filePath: '/not-authorized', ...extra }),
    });
    const operations = chatSessionOperations(f.directories);
    const active = operations.begin(scope, 'mvu');
    const busy = await restore();
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error, 'NORA_CHAT_OPERATION_BUSY');
    operations.end(scope, active.token);
    const stale = await restore({ expectedRevision: 'outdated' });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'NORA_BACKUP_RESTORE_STALE');
    const response = await restore();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.status, 'restored');
    const state = await runtime.plugin.status(scope);
    assert.equal(state.active, null); assert.equal(state.pending, null); assert.equal(state.enabled, false);
    assert.equal(state.restoreId, result.restoreId);
    const restored = await f.chat(world);
    assert.deepEqual(restored.slice(1), original.slice(1));
    assert.deepEqual(restored[0].chat_metadata.variables, { turn: 1 });
    const post = chat => fetch(`http://127.0.0.1:${server.address().port}/chats/save`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ avatar_url: world.runtime_card.binding.avatar, file_name: world.sessions.items[0].binding.chat_id,
            chat, nora_complete_history: true, nora_base_revision: result.revision }) });
    assert.equal((await post(original)).status, 409, 'even a fresh revision cannot remove the server-owned restore receipt');
    const continuation = [...restored, { is_user: true, mes: 'new action' }];
    assert.equal((await post(continuation)).status, 200);
    assert.deepEqual(await f.chat(world), continuation);
    const replay = await (await restore()).json();
    assert.equal(replay.status, 'already-restored');
    assert.deepEqual(await f.chat(world), continuation, 'replayed restore must not erase later user work');
    await flushChatBackups();
});

test('generation ownership gates the canonical HTTP save, fences released tasks and leaves other Worlds writable', async t => {
    const f = await storageFixture(t);
    const world = await f.create('operation-http');
    const other = await f.create('operation-other');
    const original = await f.chat(world);
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories: f.directories, profile: { handle: 'test' } }; next(); });
    app.use('/chats', chatRouter);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await flushChatBackups(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
    const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/chats/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const begin = await post('operation/begin', { ...scope, kind: 'generation', baseRevision: getChatRevision(original) });
    assert.equal(begin.status, 200);
    const { token } = await begin.json();
    const next = [...original, { is_user: true, mes: 'Owner action' }];
    const payload = { avatar_url: world.runtime_card.binding.avatar, file_name: world.sessions.items[0].binding.chat_id,
        chat: next, nora_complete_history: true, nora_base_revision: getChatRevision(original) };
    assert.equal((await post('save', payload)).status, 409);
    assert.deepEqual(await f.chat(world), original);
    assert.equal((await post('save', { ...payload, nora_activity_token: token })).status, 200);
    assert.deepEqual(await f.chat(world), next);
    assert.equal((await post('operation/renew', { ...scope, token })).status, 200);
    assert.equal((await post('operation/end', { ...scope, token })).status, 200);
    assert.equal((await post('save', { ...payload, nora_activity_token: token, nora_base_revision: getChatRevision(next) })).status, 409);
    assert.equal((await post('operation/begin', { ...scope, kind: 'generation', baseRevision: getChatRevision(original) })).status, 409);
    assert.equal((await post('save', { avatar_url: other.runtime_card.binding.avatar, file_name: other.sessions.items[0].binding.chat_id,
        chat: [...await f.chat(other), { is_user: true, mes: 'Other World action' }] })).status, 200);
    await flushChatBackups();
});

test('restore preview binds a managed snapshot to its existing World without changing chat or disclosing content', async t => {
    const f = await storageFixture(t);
    const world = await f.create('restore-preview');
    const other = await f.create('restore-other');
    const filePath = path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'), `${world.sessions.items[0].binding.chat_id}.jsonl`);
    const old = [...await f.chat(world), { is_user: false, mes: 'Private old reply', swipes: ['Private old reply', 'Another private reply'], swipe_id: 0,
        swipe_info: [{ extra: { stat_data: { hp: 10 } } }, { extra: { stat_data: { hp: 8 } } }], extra: { stat_data: { hp: 10 } } }];
    const data = old.map(item => JSON.stringify(item)).join('\n');
    await fs.writeFile(filePath, data);
    const store = chatBackupStore(f.directories);
    const { id } = await store.capture({ filePath, data, mvuState: 'confirmed' });
    const current = [...old, { is_user: true, mes: 'Private later action' }];
    await fs.writeFile(filePath, current.map(item => JSON.stringify(item)).join('\n'));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories: f.directories }; next(); });
    app.use('/backups', router);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const post = body => fetch(`http://127.0.0.1:${server.address().port}/backups/chat/restore-preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const request = { id, worldId: world.world_id, sessionId: world.sessions.default_session_id, filePath: '/not-an-authorized-path' };
    const response = await post(request);
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.previewOnly, true);
    assert.equal(preview.current.revision, getChatRevision(current));
    assert.equal(preview.current.messageCount, current.length - 1);
    assert.equal(preview.snapshot.messageCount, old.length - 1);
    assert.equal(preview.snapshot.swipeCount, 2);
    assert.equal(preview.snapshot.mvuState, 'confirmed');
    assert.deepEqual(preview.excludes, ['world-card', 'worldbooks', 'library-originals', 'compression-ledger']);
    assert.doesNotMatch(JSON.stringify(preview), /Private|private|filePath|stat_data/);
    assert.deepEqual(await f.chat(world), current);
    assert.equal((await store.list()).snapshots.length, 1, 'preview does not create a protective backup');
    assert.equal((await post({ ...request, worldId: other.world_id, sessionId: other.sessions.default_session_id })).status, 409);
    await fs.writeFile(filePath, '{"chat_metadata":{}}\n{"mes":"unowned chat at the previous path"}');
    assert.equal((await post(request)).status, 409, 'a path binding alone cannot authorize a chat with missing ownership');
    await fs.writeFile(filePath, current.map(item => JSON.stringify(item)).join('\n'));
    await f.core.deleteWorld(world.world_id, { idempotencyKey: 'fixture:delete-preview-world' });
    assert.equal((await post(request)).status, 404, 'deleted worlds and their removed backups are never recreated by preview');
    await assert.rejects(store.download(id), { code: 'ENOENT' });
});

test('two pages saving the same revision cannot overwrite each other or back up the rejected candidate', async t => {
    const f = await storageFixture(t);
    const world = await f.create('two-pages');
    const original = [...await f.chat(world), { is_user: true, mes: 'Walk' }, { is_user: false, mes: 'Original reply', stat_data: { hp: 10 } }];
    const filePath = path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'), `${world.sessions.items[0].binding.chat_id}.jsonl`);
    await fs.writeFile(filePath, original.map(item => JSON.stringify(item)).join('\n'));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories: f.directories, profile: { handle: 'test' } }; next(); });
    app.use('/api/chats', chatRouter);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const candidates = [8, 9].map(hp => [...original.slice(0, -1), { ...original.at(-1), stat_data: { hp } }]);
    const responses = await Promise.all(candidates.map(chat => fetch(`http://127.0.0.1:${server.address().port}/api/chats/save`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ avatar_url: world.runtime_card.binding.avatar, file_name: world.sessions.items[0].binding.chat_id,
            chat, nora_complete_history: true, nora_base_revision: getChatRevision(original) }),
    })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winner = candidates[responses.findIndex(response => response.status === 200)];
    assert.deepEqual(await f.chat(world), winner);
    await flushChatBackups();
    const store = chatBackupStore(f.directories);
    const { snapshots } = await store.list();
    assert.equal(snapshots.length, 1);
    assert.deepEqual((await store.download(snapshots[0].id)).toString().split('\n').map(JSON.parse), winner);
});

test('history edit stops on backup failure, leaves chat intact, and succeeds on retry with a protected original', async t => {
    const f = await storageFixture(t);
    const world = await f.create('edit-protection');
    const original = [...await f.chat(world), { is_user: true, mes: 'original action' }, { is_user: false, mes: 'original reply', extra: { stat_data: { hp: 10 } } }];
    const filePath = path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'), `${world.sessions.items[0].binding.chat_id}.jsonl`);
    const data = original.map(item => JSON.stringify(item)).join('\n');
    await fs.writeFile(filePath, data);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories: f.directories, profile: { handle: 'test' } }; next(); });
    app.use('/ledger', ledgerRouter);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/ledger/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const { expectedSignature } = await (await post('inspect', scope)).json();
    const edit = { ...scope, expectedSignature, messageId: 0, text: 'changed action' };
    const open = fs.open;
    const fault = t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (flags === 'wx') throw Object.assign(new Error('synthetic'), { code: 'ENOSPC' });
        return open(file, flags, ...args);
    });
    const rejected = await post('edit', edit);
    assert.equal(rejected.status, 409);
    const failure = await rejected.json();
    assert.equal(failure.code, 'NORA_BACKUP_REQUIRED');
    assert.equal(failure.backupCode, 'ENOSPC');
    assert.deepEqual(await f.chat(world), original);
    fault.mock.restore();
    assert.equal((await post('edit', edit)).status, 200);
    const list = await chatBackupStore(f.directories).list();
    assert.equal(list.snapshots.length, 1);
    assert.equal(list.snapshots[0].protected, true);
    assert.equal((await chatBackupStore(f.directories).download(list.snapshots[0].id)).toString(), data);
    const changed = await f.chat(world);
    assert.equal(changed.length, 2);
    assert.equal(changed[1].mes, 'changed action');
    assert.equal((await post('edit', edit)).status, 409, 'stale replay cannot overwrite the newer history');
    assert.equal((await chatBackupStore(f.directories).list()).snapshots.length, 1);
    assert.equal((await post('checkpoint', { ...scope, expectedSignature })).status, 409);
    const current = await (await post('inspect', scope)).json();
    const checkpoint = await post('checkpoint', { ...scope, expectedSignature: current.expectedSignature });
    assert.equal(checkpoint.status, 200);
    assert.deepEqual(await f.chat(world), changed, 'regeneration preflight never edits the chat');
    const copies = (await chatBackupStore(f.directories).list()).snapshots;
    assert.equal(copies.length, 2);
    assert.ok(copies.every(item => item.protected));
    // A changed MVU value must invalidate preparation even when the narrative
    // signature is unchanged. This simulates a writer outside the session lock.
    changed[1].extra = { stat_data: { hp: 8 } };
    await fs.writeFile(filePath, changed.map(item => JSON.stringify(item)).join('\n'));
    const race = t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (flags === 'wx' && String(file).endsWith('.jsonl')) {
            changed[1].extra.stat_data.hp = 7;
            await fs.writeFile(filePath, changed.map(item => JSON.stringify(item)).join('\n'));
        }
        return open(file, flags, ...args);
    });
    const raced = await post('edit', { ...scope, expectedSignature: current.expectedSignature, messageId: 0, text: 'must not replace changed variables' });
    assert.equal(raced.status, 409);
    race.mock.restore();
    assert.deepEqual(await f.chat(world), changed);
    assert.equal((await chatBackupStore(f.directories).list()).snapshots.length, 2);
});

test('managed HTTP operations enforce protection and isolate backup failure from successful chat saves', async t => {
    const f = await storageFixture(t);
    const world = await f.create('managed-http');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { directories: f.directories, profile: { handle: 'test' } }; next(); });
    app.use('/api/chats', chatRouter);
    app.use('/api/backups', router);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await flushChatBackups(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const post = (route, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const chat = [...await f.chat(world), { mes: 'Saved despite backup fault' }];
    const payload = { avatar_url: world.runtime_card.binding.avatar, file_name: world.sessions.items[0].binding.chat_id, chat };
    const saved = await (await post('/chats/save', payload)).json();
    assert.equal(saved.ok, true);
    const open = fs.open;
    const fault = t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (flags === 'wx') throw Object.assign(new Error('synthetic'), { code: 'ENOSPC' });
        return open(file, flags, ...args);
    });
    await flushChatBackups();
    fault.mock.restore();
    const failed = await post('/backups/chat/managed');
    assert.equal(failed.status, 200);
    const failure = await failed.json();
    assert.equal(failure.status.recent.at(-1).code, 'ENOSPC');
    assert.deepEqual(await f.chat(world), chat);
    await post('/chats/save', payload);
    await flushChatBackups();
    const listing = await (await post('/backups/chat/managed')).json();
    const id = listing.snapshots[0].id;
    assert.equal(listing.snapshots.length, 1);
    assert.equal((await post('/backups/chat/protect', { id, protected: true })).status, 200);
    assert.equal((await post('/backups/chat/remove', { id })).status, 409);
    assert.equal((await post('/backups/chat/delete', { name: `chat_nora1_${id}.jsonl` })).status, 409, 'legacy route cannot bypass protection');
    assert.equal((await post('/backups/chat/delete', { name: `chat_nora1_${id}.jsonl/` })).status, 400, 'normalization cannot bypass managed protection');
    assert.equal((await post('/backups/chat/delete', { name: `chat_nora1_${id.toUpperCase()}.jsonl` })).status, 409, 'case-insensitive filesystems cannot bypass managed protection');
    assert.equal((await post('/backups/chat/protect', { id, protected: false })).status, 200);
    assert.equal((await post('/backups/chat/remove', { id })).status, 200);
    assert.equal((await chatBackupStore(f.directories).list()).snapshots.length, 0);
    assert.equal((await post('/backups/chat/remove', { id: '../foreign' })).status, 400);
});

test('authenticated backup inventory ignores caller paths, exposes metadata only, and preserves the native list response', async t => {
    const f = await storageFixture(t);
    const foreign = await storageFixture(t);
    const world = await f.create('http');
    await f.backup('chat_local.jsonl', [...await f.chat(world), { mes: 'PRIVATE_BODY', name: 'NPC', is_user: false }]);
    await foreign.backup('chat_foreign.jsonl', [{ user_name: 'User', character_name: 'FOREIGN' }]);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { directories: f.directories }; next(); });
    app.use('/api/backups', router);
    app.use('/api/nora-worlds-v2', createNoraWorldsV2Router({
        resolveCore() { throw new Error('Read-only inventory must not initialize the mutating World loader'); },
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const url = `http://127.0.0.1:${server.address().port}/api/backups`;
    const response = await fetch(`${url}/chat/inventory`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: foreign.root, backups: foreign.directories.backups }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.backups.map(item => item.name), ['chat_local.jsonl']);
    assert.equal(result.backups[0].owner.worldId, world.world_id);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY|FOREIGN/);
    const legacy = await fetch(`${url}/chat/get`, { method: 'POST' });
    assert.equal(legacy.status, 200);
    assert.ok(Array.isArray(await legacy.json()), 'native ST callers keep their existing array contract');
    const storage = await fetch(`http://127.0.0.1:${server.address().port}/api/nora-worlds-v2/storage/inventory?root=${encodeURIComponent(foreign.root)}`);
    assert.equal(storage.status, 200);
    assert.equal(storage.headers.get('cache-control'), 'no-store');
    const report = await storage.json();
    assert.equal(report.readOnly, true);
    assert.ok(report.files.some(item => item.path === 'backups/chat_local.jsonl'));
    assert.ok(!report.files.some(item => item.path.includes('chat_foreign')));
});

test('a blocked background backup does not delay a newer formal save or commit its stale chat bytes', { timeout: 15000 }, async t => {
    const f = await storageFixture(t);
    const world = await f.create('save-during-backup');
    const app = express();
    app.use(express.json({ limit: '8mb' }));
    app.use((req, _res, next) => { req.user = { directories: f.directories, profile: { handle: 'test' } }; next(); });
    app.use('/api/chats', chatRouter);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const original = await f.chat(world);
    const chat = [...original, { mes: 'x'.repeat(2 * 1024 * 1024), extra: { stat_data: { hp: 10 } } }];
    const payload = { avatar_url: world.runtime_card.binding.avatar, file_name: world.sessions.items[0].binding.chat_id, chat,
        nora_complete_history: true, nora_base_revision: getChatRevision(original) };
    const save = async skip_backup => {
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chats/save`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, skip_backup }),
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.ok, true);
        payload.nora_base_revision = result.revision;
        return { result, ms: performance.now() - started };
    };
    const without = [];
    for (let i = 0; i < 3; i++) without.push((await save(true)).ms);
    await save(false);
    const open = fs.open;
    let entered, release;
    const checkpoint = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const stalled = t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (flags === 'wx' && String(file).endsWith('.jsonl')) { entered(); await gate; }
        return open(file, flags, ...args);
    });
    const flush = flushChatBackups();
    t.after(async () => { release(); stalled.mock.restore(); await flush; await flushChatBackups(); });
    await checkpoint;
    chat.at(-1).extra.stat_data.hp = 9;
    const during = await save(false);
    assert.equal(during.result.backup.status, 'queued');
    assert.ok(during.ms < 2000, 'formal save must not wait for the held backup write');
    assert.equal((await f.chat(world)).at(-1).extra.stat_data.hp, 9);
    release();
    await flush;
    stalled.mock.restore();
    await flushChatBackups();
    const list = await chatBackupStore(f.directories).list();
    assert.equal(list.snapshots.length, 1);
    assert.equal(list.legacyFiles, 0);
    const downloaded = (await chatBackupStore(f.directories).download(list.snapshots[0].id)).toString().split('\n').map(JSON.parse);
    assert.equal(downloaded.at(-1).extra.stat_data.hp, 9);
    t.diagnostic(`2 MiB HTTP save skip-backup ms=${without.map(value => value.toFixed(1)).join('/')} backup-held ms=${during.ms.toFixed(1)}`);
});

test('native save produces an inventoried snapshot retaining message variables without changing save semantics', { timeout: 20000 }, async t => {
    const f = await storageFixture(t);
    const world = await f.create('save');
    const chat = [...await f.chat(world), { name: 'NPC', is_user: false, mes: 'Synthetic first reply',
        extra: { stat_data: { hp: 10 } }, swipe_id: 0, swipes: ['Synthetic first reply'] }];
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { directories: f.directories, profile: { handle: 'isolated-storage-test' } }; next(); });
    app.use('/api/chats', chatRouter);
    app.use('/api/backups', router);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const url = `http://127.0.0.1:${server.address().port}`;
    const saved = await fetch(`${url}/api/chats/save`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ avatar_url: world.runtime_card.binding.avatar,
            file_name: world.sessions.items[0].binding.chat_id, chat, nora_backup_mvu_state: 'confirmed' }) });
    assert.equal(saved.status, 200);
    const saveResult = await saved.json();
    assert.equal(saveResult.ok, true);
    assert.equal(saveResult.backup.status, 'queued');
    let inventory;
    const deadline = Date.now() + 14000;
    do {
        inventory = await (await fetch(`${url}/api/backups/chat/inventory`, { method: 'POST' })).json();
        if (inventory.backups.length) break;
        await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    assert.equal(inventory.backups.length, 1);
    assert.equal(inventory.backups[0].owner.worldId, world.world_id);
    assert.equal(inventory.backups[0].messageCount, 1);
    const download = await fetch(`${url}/api/backups/chat/download`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: inventory.backups[0].name }) });
    assert.equal(download.status, 200);
    const restoredLines = (await download.text()).split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(restoredLines, chat, 'inventory and backup must retain MVU and swipe data without rewriting it');
    const managed = await (await fetch(`${url}/api/backups/chat/managed`, { method: 'POST' })).json();
    assert.equal(managed.snapshots[0].mvuState, 'confirmed');
    assert.equal(managed.snapshots[0].consistency, 'chat-only');
});
