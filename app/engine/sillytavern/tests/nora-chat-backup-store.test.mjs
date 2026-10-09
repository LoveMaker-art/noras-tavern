import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { storageFixture } from './nora-storage-fixture.mjs';
import { createChatBackupStore } from '../src/chat-backup-store.js';
import atomic from 'write-file-atomic';
import { ledgerAfterRestore } from '../src/nora-story-ledger/state-file.js';
import { chatSessionOperations } from '../src/chat-session-operations.js';

async function savedChat(f, world, hp = 10) {
    const filePath = path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'),
        `${world.sessions.items[0].binding.chat_id}.jsonl`);
    const lines = (await f.chat(world)).slice(0, 1);
    lines.push({ name: 'NPC', mes: 'Same prose', extra: { stat_data: { hp } }, swipes: ['Same prose'] });
    const data = lines.map(line => JSON.stringify(line)).join('\n');
    await fs.writeFile(filePath, data);
    return { filePath, data };
}

test('a backward system clock preserves newest backup order and the latest retention slots', async t => {
    const f = await storageFixture(t), world = await f.create('clock-backward');
    let clock = Date.now();
    const store = createChatBackupStore({ directories: f.directories, now: () => clock,
        policy: { maxPerSession: 2 } });
    const saved = []; let input;
    for (const hp of [1, 2, 3]) {
        input = await savedChat(f, world, hp);
        saved.push({ ...(await store.capture(input)), data: input.data });
        clock -= 1000;
    }
    const list = await store.list();
    assert.deepEqual(list.snapshots.map(item => item.id), [saved[2].id, saved[1].id]);
    assert.deepEqual(list.snapshots.map(item => item.sequence), [3, 2]);
    for (const item of saved.slice(1)) assert.equal((await store.download(item.id)).toString(), item.data);
    assert.equal(await fs.readFile(input.filePath, 'utf8'), saved[2].data);
});

test('list exposes bounded message summaries without changing metadata, snapshot bytes or the current chat', async t => {
    const f = await storageFixture(t), world = await f.create('read-only-summary');
    const store = createChatBackupStore({ directories: f.directories });
    const input = await savedChat(f, world);
    const saved = await store.capture(input);
    const metadataPath = path.join(f.directories.backups, '.nora-chat', `${saved.id}.json`);
    const before = await fs.readFile(metadataPath, 'utf8');
    const list = await store.list();
    assert.equal(list.snapshots[0].messageCount, 1);
    assert.equal(list.snapshots[0].preview, 'Same prose');
    assert.equal(await fs.readFile(metadataPath, 'utf8'), before);
    assert.equal((await store.download(saved.id)).toString(), input.data);
    assert.equal(await fs.readFile(input.filePath, 'utf8'), input.data);
    assert.equal(JSON.parse(before).messageCount, undefined, 'summary is not a migration of old metadata');
});

test('summaries truncate long messages and do not turn unreadable content into a fabricated count', async t => {
    const f = await storageFixture(t), world = await f.create('bounded-summary');
    const store = createChatBackupStore({ directories: f.directories });
    const input = await savedChat(f, world);
    const header = JSON.parse(input.data.split('\n')[0]);
    const data = [header, { mes: `  ${'long '.repeat(100)}` }].map(JSON.stringify).join('\n');
    await fs.writeFile(input.filePath, data);
    await store.capture({ filePath: input.filePath, data });
    assert.equal((await store.list()).snapshots[0].preview.length, 140);
    const broken = [header, { mes: 42 }].map(JSON.stringify).join('\n');
    await fs.writeFile(input.filePath, broken);
    const saved = await store.capture({ filePath: input.filePath, data: broken });
    const item = (await store.list()).snapshots.find(item => item.id === saved.id);
    assert.equal(item.messageCount, null);
    assert.equal(item.preview, '');
    assert.equal((await store.download(saved.id)).toString(), broken, 'unreadable content is preserved, not silently repaired');
});

test('bounded backup reads and optional digest guards share existing storage validation', async t => {
    const f = await storageFixture(t), world = await f.create('mcp-window');
    const store = createChatBackupStore({ directories: f.directories });
    const input = await savedChat(f, world);
    const header = JSON.parse(input.data.split('\n')[0]);
    const data = [header, { name: 'NPC', mes: 'x'.repeat(5000) }, { mes: 'Next' }].map(JSON.stringify).join('\n');
    await fs.writeFile(input.filePath, data);
    const saved = await store.capture({ filePath: input.filePath, data });
    const item = (await store.list()).snapshots[0];
    const result = await store.inspect({ id: saved.id, sha256: item.sha256, limit: 1 });
    assert.equal(result.messageCount, 2);
    assert.equal(result.messages[0].text.length, 4000);
    assert.equal(result.messages[0].truncated, true);
    assert.equal(result.hasMore, true);
    for (const limit of [0, 21, 1.5]) await assert.rejects(store.inspect({ id: saved.id, limit }), { code: 'NORA_BACKUP_INVALID_WINDOW' });
    await assert.rejects(store.inspect({ id: '../escape' }), { code: 'NORA_BACKUP_INVALID_ID' });
    const wrong = '0'.repeat(64);
    for (const action of [() => store.inspect({ id: saved.id, sha256: wrong }), () => store.download(saved.id, wrong),
        () => store.protect(saved.id, true, wrong), () => store.remove(saved.id, wrong)]) {
        await assert.rejects(action(), { code: 'NORA_BACKUP_CHANGED' });
    }
    assert.equal(await fs.readFile(input.filePath, 'utf8'), data);
    assert.equal((await store.download(saved.id)).toString(), data);
    assert.equal((await store.list()).snapshots[0].protected, false);
});

test('display summaries omit markup, draft comments and runtime blocks without changing backup bytes', async t => {
    const f = await storageFixture(t), world = await f.create('readable-summary');
    const store = createChatBackupStore({ directories: f.directories });
    const input = await savedChat(f, world);
    const header = JSON.parse(input.data.split('\n')[0]);
    const mes = `<!-- ${'draft '.repeat(100)} --><content><p>Good &amp; readable</p><p>Next line</p></content><UpdateVariable>private update</UpdateVariable><script>bad()</script><style>body{}</style>`;
    const data = [header, { mes }].map(JSON.stringify).join('\n');
    await fs.writeFile(input.filePath, data);
    const saved = await store.capture({ filePath: input.filePath, data });
    assert.equal((await store.list()).snapshots[0].preview, 'Good & readable Next line');
    assert.equal((await store.download(saved.id)).toString(), data);
    assert.equal(await fs.readFile(input.filePath, 'utf8'), data);
});

test('legacy upgrade rejects changed World inventory before deleting any old snapshot', async t => {
    const f = await storageFixture(t), world = await f.create('upgrade-world-race');
    const input = await savedChat(f, world);
    await f.backup('chat_old.jsonl', input.data);
    const store = createChatBackupStore({ directories: f.directories });
    const open = fs.open;
    let changed = false;
    const fault = t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (!changed && flags === 'wx' && String(file).endsWith('.jsonl')) {
            changed = true;
            await fs.writeFile(path.join(f.root, 'nora-world-core/worlds/new-world-pending.json'), '{}');
        }
        return open(file, flags, ...args);
    });
    await assert.rejects(store.upgradeLegacy(), { code: 'NORA_BACKUP_CHANGED' });
    fault.mock.restore();
    assert.equal(await fs.readFile(path.join(f.directories.backups, 'chat_old.jsonl'), 'utf8'), input.data);
    assert.equal(await fs.readFile(input.filePath, 'utf8'), input.data);
});

test('legacy upgrade retains unknown, broken and protected files, cleans deleted-World history, and runs only once', async t => {
    const f = await storageFixture(t), world = await f.create('upgrade-retain'), removedWorld = await f.create('upgrade-deleted');
    const store = createChatBackupStore({ directories: f.directories });
    const input = await savedChat(f, world), removedChat = await savedChat(f, removedWorld);
    const protectedSnapshot = await store.capture({ ...input, protect: true });
    await f.core.deleteWorld(removedWorld.world_id, { idempotencyKey: 'upgrade-deleted' });
    await f.backup('chat_deleted_world.jsonl', removedChat.data);
    await f.backup('chat_owned.jsonl', input.data);
    const unknown = await f.backup('chat_same_name.jsonl', [{ chat_metadata: {}, character_name: world.name }, { mes: 'not proven ownership' }]);
    await f.backup('chat_broken.jsonl', '{broken');
    await f.backup('settings_manual.json', '{"keep":true}');
    assert.equal((await store.upgradeLegacy()).removed, 2);
    const list = await store.list();
    assert.equal(list.snapshots.length, 1, 'matching protected snapshot is reused');
    assert.equal(list.snapshots[0].protected, true);
    assert.equal((await store.download(protectedSnapshot.id)).toString(), input.data);
    assert.equal(list.legacyFiles, 2);
    assert.equal(await fs.readFile(path.join(f.directories.backups, 'chat_same_name.jsonl'), 'utf8'), unknown);
    assert.equal(await fs.readFile(path.join(f.directories.backups, 'chat_broken.jsonl'), 'utf8'), '{broken');
    assert.equal(await fs.readFile(path.join(f.directories.backups, 'settings_manual.json'), 'utf8'), '{"keep":true}');
    await f.backup('chat_user_added_after_upgrade.jsonl', input.data);
    const restarted = createChatBackupStore({ directories: f.directories });
    assert.equal((await restarted.upgradeLegacy()).status, 'already-complete');
    assert.equal((await restarted.list()).legacyFiles, 3, 'future manually added files are not silently cleaned');
});

test('legacy upgrade preserves every old backup on ENOSPC and succeeds after a retry without duplicating baselines', async t => {
    const f = await storageFixture(t), a = await f.create('upgrade-disk-a'), b = await f.create('upgrade-disk-b');
    const first = await savedChat(f, a), second = await savedChat(f, b);
    await f.backup('chat_old_a.jsonl', first.data);
    await f.backup('chat_old_b.jsonl', second.data);
    const store = createChatBackupStore({ directories: f.directories });
    const open = fs.open;
    let writes = 0;
    const fault = t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (flags === 'wx' && String(file).endsWith('.jsonl') && ++writes === 2) throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' });
        return open(file, flags, ...args);
    });
    await assert.rejects(store.upgradeLegacy(), { code: 'ENOSPC' });
    fault.mock.restore();
    assert.equal((await store.list()).legacyFiles, 2);
    assert.equal(await fs.readFile(path.join(f.directories.backups, 'chat_old_a.jsonl'), 'utf8'), first.data);
    assert.equal(await fs.readFile(path.join(f.directories.backups, 'chat_old_b.jsonl'), 'utf8'), second.data);
    assert.equal((await store.upgradeLegacy()).removed, 2);
    assert.equal((await store.list()).snapshots.length, 2);
    assert.equal((await store.list()).legacyFiles, 0);
});

test('legacy upgrade can retry an interrupted deletion using the verified new baselines', async t => {
    const f = await storageFixture(t), world = await f.create('upgrade-unlink');
    const input = await savedChat(f, world);
    await f.backup('chat_old_one.jsonl', input.data);
    await f.backup('chat_old_two.jsonl', input.data);
    const store = createChatBackupStore({ directories: f.directories });
    const unlink = fsSync.unlinkSync;
    let calls = 0;
    const fault = t.mock.method(fsSync, 'unlinkSync', file => {
        if (path.basename(file).startsWith('chat_old_') && ++calls === 2) throw Object.assign(new Error('Synthetic interrupted cleanup'), { code: 'EIO' });
        return unlink(file);
    });
    await assert.rejects(store.upgradeLegacy(), { code: 'EIO' });
    fault.mock.restore();
    const partial = await store.list();
    assert.equal(partial.legacyFiles, 1);
    assert.equal((await store.download(partial.snapshots[0].id)).toString(), input.data);
    assert.equal((await store.upgradeLegacy()).removed, 1);
    assert.equal((await store.list()).snapshots.length, 1);
    assert.equal((await store.list()).legacyFiles, 0);
});

test('legacy upgrade does not delete old files when current chats or the remaining quota cannot support new baselines', async t => {
    const f = await storageFixture(t), world = await f.create('upgrade-insufficient');
    const input = await savedChat(f, world);
    await f.backup('chat_old.jsonl', input.data);
    const small = createChatBackupStore({ directories: f.directories, policy: { maxBytes: 1 } });
    await assert.rejects(small.upgradeLegacy(), { code: 'NORA_BACKUP_BUDGET_EXCEEDED' });
    assert.equal((await small.list()).legacyFiles, 1);
    assert.equal((await small.list()).snapshots.length, 0);
    await fs.writeFile(input.filePath, '{broken');
    await assert.rejects(createChatBackupStore({ directories: f.directories }).upgradeLegacy());
    assert.equal(await fs.readFile(path.join(f.directories.backups, 'chat_old.jsonl'), 'utf8'), input.data);
});

test('explicit World deletion removes owned protected and legacy backups but retains other Worlds and unknown files', async t => {
    const f = await storageFixture(t), world = await f.create('delete-backups'), other = await f.create('delete-other');
    const store = createChatBackupStore({ directories: f.directories });
    const original = await savedChat(f, world);
    const owned = await store.capture({ ...original, protect: true });
    const foreign = await store.capture(await savedChat(f, other));
    await f.backup('chat_legacy-owned.jsonl', original.data);
    await f.backup('chat_same-name.jsonl', [{ character_name: world.name }, { mes: 'name is not ownership' }]);
    await assert.rejects(store.removeWorld(world), { code: 'NORA_BACKUP_WORLD_NOT_DELETING' });
    const manifestFile = path.join(f.root, 'nora-world-core/worlds', (await import('../src/nora-world-core/atomic-json.js')).documentFileName(world.world_id));
    const deleting = { ...world, lifecycle: { status: 'DELETING', error: null } };
    await fs.writeFile(manifestFile, JSON.stringify(deleting));
    const result = await store.removeWorld(deleting);
    assert.equal(result.deleted.length, 2);
    assert.equal(result.retained.length, 1);
    await assert.rejects(store.download(owned.id), { code: 'ENOENT' });
    assert.ok(await store.download(foreign.id));
    assert.match(await fs.readFile(path.join(f.directories.backups, 'chat_same-name.jsonl'), 'utf8'), /name is not ownership/);
    assert.equal((await store.removeWorld(deleting)).deleted.length, 0, 'retry does not create files or delete another World');
});

test('World deletion rejects an active page without damaging readiness, then removes protected backups through the same operation', async t => {
    const f = await storageFixture(t), world = await f.create('delete-coordinated');
    const store = createChatBackupStore({ directories: f.directories });
    const snapshot = await store.capture({ ...await savedChat(f, world), protect: true });
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const operations = chatSessionOperations(f.directories), lease = operations.begin(scope, 'generation');
    await assert.rejects(f.core.deleteWorld(world.world_id, { idempotencyKey: 'delete-coordinated' }), { code: 'NORA_CHAT_OPERATION_BUSY' });
    assert.equal((await f.core.getWorld(world.world_id)).lifecycle.status, 'READY');
    assert.ok(await store.download(snapshot.id));
    operations.end(scope, lease.token);
    const result = await f.core.deleteWorld(world.world_id, { idempotencyKey: 'delete-coordinated' });
    assert.equal(result.world.lifecycle.status, 'DELETED');
    await assert.rejects(store.download(snapshot.id), { code: 'ENOENT' });
    assert.equal(result.operation.result.backups.deleted.length, 1);
    const replay = await f.core.deleteWorld(world.world_id, { idempotencyKey: 'delete-coordinated' });
    assert.equal(replay.reused, true);
    assert.equal(replay.operation.result.backups.deleted.length, 1);
});

test('interrupted World deletion resumes its durable backup plan without leaving orphan metadata', async t => {
    const f = await storageFixture(t), world = await f.create('delete-interrupted');
    const store = createChatBackupStore({ directories: f.directories });
    const snapshot = await store.capture({ ...await savedChat(f, world), protect: true });
    await f.backup('chat_unknown.jsonl', [{ character_name: world.name }]);
    const metadata = path.join(await fs.realpath(f.directories.backups), '.nora-chat', `${snapshot.id}.json`);
    const unlink = fsSync.unlinkSync;
    const fault = t.mock.method(fsSync, 'unlinkSync', file => {
        if (file === metadata) throw Object.assign(new Error('Synthetic filesystem failure'), { code: 'EIO' });
        return unlink(file);
    });
    await assert.rejects(f.core.deleteWorld(world.world_id, { idempotencyKey: 'delete-interrupted' }), { code: 'NORA_WORLD_DELETE_FAILED' });
    assert.equal((await f.core.getWorld(world.world_id)).lifecycle.status, 'FAILED');
    assert.ok(await fs.stat(metadata));
    await assert.rejects(fs.stat(path.join(f.directories.backups, `chat_nora1_${snapshot.id}.jsonl`)), { code: 'ENOENT' });
    fault.mock.restore();
    const result = await f.core.deleteWorld(world.world_id, { idempotencyKey: 'delete-interrupted' });
    assert.equal(result.world.lifecycle.status, 'DELETED');
    assert.equal(result.operation.result.backups.deleted.length, 1);
    assert.equal(result.operation.result.backups.alreadyAbsent, 1);
    await assert.rejects(fs.stat(metadata), { code: 'ENOENT' });
    assert.ok(await fs.stat(path.join(f.directories.backups, 'chat_unknown.jsonl')));
});

test('deletion retry refuses new or modified backup targets instead of expanding the confirmed plan', async t => {
    const f = await storageFixture(t), world = await f.create('delete-changed-plan');
    const store = createChatBackupStore({ directories: f.directories });
    const original = await savedChat(f, world);
    const snapshot = await store.capture(original);
    const unlink = fsSync.unlinkSync;
    const fault = t.mock.method(fsSync, 'unlinkSync', file => {
        if (String(file).endsWith(`chat_nora1_${snapshot.id}.jsonl`)) throw Object.assign(new Error('Synthetic failure before removal'), { code: 'EIO' });
        return unlink(file);
    });
    await assert.rejects(f.core.deleteWorld(world.world_id, { idempotencyKey: 'delete-changed-plan' }));
    fault.mock.restore();
    await f.backup('chat_added-after-confirmation.jsonl', original.data);
    await assert.rejects(f.core.deleteWorld(world.world_id, { idempotencyKey: 'delete-changed-plan' }));
    assert.ok(await store.download(snapshot.id));
    assert.ok(await fs.stat(path.join(f.directories.backups, 'chat_added-after-confirmation.jsonl')));
    // A new explicit deletion confirms the newly observed scope.
    const result = await f.core.deleteWorld(world.world_id, { idempotencyKey: 'delete-reconfirmed' });
    assert.equal(result.operation.result.backups.deleted.length, 2);
});

test('deletion preflight failure leaves the World and its revision unchanged', async t => {
    const f = await storageFixture(t), world = await f.create('delete-preflight');
    await fs.rmdir(f.directories.backups);
    await fs.writeFile(f.directories.backups, 'not a backup directory');
    await assert.rejects(f.core.deleteWorld(world.world_id, { idempotencyKey: 'delete-preflight' }));
    assert.deepEqual(await f.core.getWorld(world.world_id), world);
    assert.ok(await f.chat(world));
});

test('restoration atomically replaces only chat, preserves a rolling prior state and is replay-safe', async t => {
    const f = await storageFixture(t), world = await f.create('restore');
    const store = createChatBackupStore({ directories: f.directories });
    const original = await savedChat(f, world, 10);
    const snapshot = await store.capture(original);
    const latest = await savedChat(f, world, 3);
    const changed = latest.data.split('\n').map(JSON.parse);
    changed[0].chat_metadata.world_info = 'current-worldbook-binding';
    latest.data = changed.map(JSON.stringify).join('\n');
    await fs.writeFile(latest.filePath, latest.data);
    const scope = { id: snapshot.id, worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const preview = await store.previewRestore(scope);
    const input = { ...scope, expectedRevision: preview.current.revision, sha256: preview.snapshot.sha256 };
    await assert.rejects(store.restore({ ...input, expectedRevision: 'outdated' }), { code: 'NORA_BACKUP_RESTORE_STALE' });
    assert.equal(await fs.readFile(latest.filePath, 'utf8'), latest.data);
    const result = await store.restore(input, { ledgerEnabled: false });
    assert.equal(result.status, 'restored');
    const restored = await f.chat(world);
    assert.deepEqual(restored.slice(1), original.data.split('\n').map(JSON.parse).slice(1));
    assert.equal(restored[0].chat_metadata.nora_restore.ledgerEnabled, false);
    assert.equal(restored[0].chat_metadata.nora_restore.id, result.restoreId);
    assert.equal(restored[0].chat_metadata.world_info, 'current-worldbook-binding');
    assert.equal((await store.download(result.protectedBackupId)).toString(), latest.data);
    const inventory = await store.list();
    assert.equal(inventory.snapshots.find(item => item.id === result.protectedBackupId).protected, false);
    assert.equal(inventory.snapshots.find(item => item.id === snapshot.id).protected, false, 'restoring does not change selected snapshot protection');
    const retry = await store.restore(input);
    assert.equal(retry.status, 'already-restored');
    assert.equal(retry.restoreId, result.restoreId);
    assert.equal((await store.list()).snapshots.length, 2);
    assert.equal((await f.core.getWorld(world.world_id)).revision, world.revision);
    await store.remove(snapshot.id);
    assert.equal((await store.restore(input)).status, 'already-restored', 'a lost acknowledgement remains recoverable after source snapshot removal');
});

test('restoration succeeds with an explicit warning when its optional rollback backup fails', async t => {
    const f = await storageFixture(t), world = await f.create('restore-failure');
    const store = createChatBackupStore({ directories: f.directories });
    const snapshot = await store.capture(await savedChat(f, world));
    const latest = await savedChat(f, world, 3);
    const scope = { id: snapshot.id, worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const preview = await store.previewRestore(scope);
    const open = fs.open;
    t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (flags === 'wx') throw Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC' });
        return open(file, flags, ...args);
    });
    const input = { ...scope, expectedRevision: preview.current.revision, sha256: preview.snapshot.sha256 };
    const result = await store.restore(input);
    assert.equal(result.status, 'restored');
    assert.equal(result.protectedBackupId, null);
    assert.equal(result.backupWarning.code, 'ENOSPC');
    const restored = (await fs.readFile(latest.filePath, 'utf8')).split('\n').map(JSON.parse);
    assert.deepEqual(restored.slice(1), (await store.download(snapshot.id)).toString().split('\n').map(JSON.parse).slice(1));
    assert.deepEqual((await store.restore(input)).backupWarning, result.backupWarning);
});

test('failed restore replacement retains canonical bytes and its completed protection checkpoint', async t => {
    const f = await storageFixture(t), world = await f.create('restore-write-failure');
    const store = createChatBackupStore({ directories: f.directories });
    const selected = await store.capture(await savedChat(f, world));
    const latest = await savedChat(f, world, 2);
    const scope = { id: selected.id, worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const preview = await store.previewRestore(scope);
    const original = atomic.sync;
    const canonicalPath = await fs.realpath(latest.filePath);
    t.mock.method(atomic, 'sync', (file, ...args) => {
        if (file === canonicalPath) throw Object.assign(new Error('synthetic rename failure'), { code: 'EACCES' });
        return original(file, ...args);
    });
    await assert.rejects(store.restore({ ...scope, expectedRevision: preview.current.revision, sha256: preview.snapshot.sha256 }), { code: 'EACCES' });
    assert.equal(await fs.readFile(latest.filePath, 'utf8'), latest.data);
    const protectedPoint = (await store.list()).snapshots[0];
    assert.equal((await store.download(protectedPoint.id)).toString(), latest.data);
});

test('process exit immediately after atomic restore is recoverable without resurrecting the old ledger', { timeout: 10000 }, async t => {
    const f = await storageFixture(t), world = await f.create('restore-crash');
    const store = createChatBackupStore({ directories: f.directories });
    const original = await savedChat(f, world, 10);
    const selected = await store.capture(original);
    const latest = await savedChat(f, world, 2);
    const scope = { id: selected.id, worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const preview = await store.previewRestore(scope);
    const input = { ...scope, expectedRevision: preview.current.revision, sha256: preview.snapshot.sha256 };
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import atomic from 'write-file-atomic';
        import { createChatBackupStore } from ${JSON.stringify(new URL('../src/chat-backup-store.js', import.meta.url).href)};
        let raw = ''; for await (const chunk of process.stdin) raw += chunk;
        const { directories, input, filePath } = JSON.parse(raw);
        const write = atomic.sync;
        atomic.sync = (file, ...args) => { write(file, ...args); if (file === filePath) process.exit(77); };
        await createChatBackupStore({ directories }).restore(input);
    `], { cwd: new URL('../', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdin.end(JSON.stringify({ directories: f.directories, input, filePath: await fs.realpath(latest.filePath) }));
    const [code] = await exited;
    assert.equal(code, 77, errors);
    const restored = await f.chat(world);
    assert.deepEqual(restored.slice(1), original.data.split('\n').map(JSON.parse).slice(1));
    assert.equal(ledgerAfterRestore({ active: { id: 'old' } }, restored[0].chat_metadata).active, null);
    const retry = await createChatBackupStore({ directories: f.directories }).restore(input);
    assert.equal(retry.status, 'already-restored');
    assert.equal((await store.download(retry.protectedBackupId)).toString(), latest.data);
});

test('repeated saved content has one snapshot; MVU-only changes and a return to previous state remain distinct', async t => {
    const f = await storageFixture(t);
    const world = await f.create('dedupe');
    await f.backup('chat_legacy.jsonl', [{ user_name: 'User', character_name: 'old' }]);
    const store = createChatBackupStore({ directories: f.directories });
    const first = await savedChat(f, world);
    assert.equal((await store.capture(first)).status, 'created');
    assert.equal((await store.capture(first)).status, 'unchanged');
    assert.equal((await store.capture(await savedChat(f, world, 9))).status, 'created');
    assert.equal((await store.capture(await savedChat(f, world, 10))).status, 'created');
    const listed = await store.list();
    assert.equal(listed.snapshots.length, 3);
    assert.ok(listed.snapshots.every(item => item.worldId === world.world_id));
    assert.equal(listed.legacyFiles, 1);
    assert.equal((await store.download(listed.snapshots[0].id)).toString(), first.data);
    assert.equal(listed.snapshots[0].consistency, 'chat-only');
    assert.equal(await fs.readFile(path.join(f.directories.backups, 'chat_legacy.jsonl'), 'utf8'),
        '{"user_name":"User","character_name":"old"}');
});

test('MVU confirmation annotates identical snapshot bytes without adding copies or erasing stronger evidence', async t => {
    const f = await storageFixture(t);
    const input = await savedChat(f, await f.create('mvu-evidence'));
    const store = createChatBackupStore({ directories: f.directories });
    const first = await store.capture({ ...input, mvuState: 'pending' });
    assert.equal((await store.list()).snapshots[0].mvuState, 'pending');
    assert.equal((await store.capture({ ...input, mvuState: 'incomplete' })).id, first.id);
    assert.equal((await store.list()).snapshots[0].mvuState, 'incomplete');
    await store.capture({ ...input, mvuState: 'confirmed' });
    await store.capture({ ...input, protect: true });
    const list = await store.list();
    assert.equal(list.snapshots.length, 1);
    assert.equal(list.snapshots[0].mvuState, 'confirmed');
    assert.equal(list.snapshots[0].protected, true);
    assert.equal(list.snapshots[0].consistency, 'chat-only');
    assert.equal((await store.download(first.id)).toString(), input.data);
    await assert.rejects(store.capture({ ...input, mvuState: 'world-restorable' }), { code: 'NORA_BACKUP_INVALID_MVU_STATE' });
});

test('restore preview rejects damaged JSONL, invalid swipe selection and changed or unowned backup bytes', async t => {
    const f = await storageFixture(t);
    const world = await f.create('restore-invalid');
    const store = createChatBackupStore({ directories: f.directories });
    const input = await savedChat(f, world);
    const header = JSON.parse(input.data.split('\n')[0]);
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    for (const invalid of ['{"mes":', '{"mes":42}', '{"mes":"x","swipes":["x"],"swipe_id":2}']) {
        const data = JSON.stringify(header) + '\n' + invalid;
        await fs.writeFile(input.filePath, data);
        const { id } = await store.capture({ ...input, data });
        await assert.rejects(store.previewRestore({ ...scope, id }), { code: 'NORA_BACKUP_INVALID_RESTORE_CHAT' });
        assert.equal(await fs.readFile(input.filePath, 'utf8'), data);
    }
    await fs.writeFile(input.filePath, input.data);
    const { id } = await store.capture(input);
    await fs.appendFile(path.join(f.directories.backups, `chat_nora1_${id}.jsonl`), '\n{"mes":"changed"}');
    await assert.rejects(store.previewRestore({ ...scope, id }), { code: 'NORA_BACKUP_CHANGED' });
    await assert.rejects(store.previewRestore({ ...scope, id: '../chat_legacy.jsonl' }), { code: 'NORA_BACKUP_INVALID_ID' });
    const foreign = await storageFixture(t);
    await fs.unlink(input.filePath);
    const foreignPath = path.join(foreign.directories.chats, 'outside.jsonl');
    await fs.writeFile(foreignPath, input.data);
    await fs.symlink(foreignPath, input.filePath);
    // A separately valid snapshot is needed so source validation, rather than
    // digest rejection, is exercised below.
    await fs.writeFile(path.join(f.directories.backups, `chat_nora1_${id}.jsonl`), input.data);
    await assert.rejects(store.previewRestore({ ...scope, id }), { code: 'NORA_BACKUP_UNSAFE_PATH' });
    assert.equal(await fs.readFile(foreignPath, 'utf8'), input.data);
});

test('a failed replacement keeps the last valid snapshot; concurrent identical captures create only one', async t => {
    const f = await storageFixture(t);
    const world = await f.create('failure');
    const store = createChatBackupStore({ directories: f.directories, policy: { maxPerSession: 1 } });
    const input = await savedChat(f, world);
    const results = await Promise.all([store.capture(input), store.capture(input), store.capture(input)]);
    assert.deepEqual(results.map(item => item.status).sort(), ['created', 'unchanged', 'unchanged']);
    assert.equal(new Set(results.map(item => item.id)).size, 1);
    const changed = await savedChat(f, world, 8);
    const open = fs.open;
    t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (flags === 'wx') throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
        return open(file, flags, ...args);
    });
    await assert.rejects(store.capture(changed), { code: 'ENOSPC' });
    assert.equal((await store.download(results[0].id)).toString(), input.data);
    assert.equal((await store.list()).snapshots.length, 1);
});

test('changed snapshots, missing metadata, and child symlinks are preserved rather than auto-cleaned', async t => {
    const f = await storageFixture(t);
    const foreign = await storageFixture(t);
    const world = await f.create('safety');
    let clock = Date.UTC(2026, 8, 29);
    const store = createChatBackupStore({ directories: f.directories, now: () => clock });
    const result = await store.capture(await savedChat(f, world));
    const listed = (await store.list()).snapshots[0];
    const files = await fs.readdir(f.directories.backups);
    const snapshotPath = path.join(f.directories.backups, files.find(name => name.endsWith('.jsonl')));
    await fs.appendFile(snapshotPath, '\n{"mes":"User edit"}');
    clock += 31 * 86400000;
    await store.maintain();
    assert.match(await fs.readFile(snapshotPath, 'utf8'), /User edit/);
    assert.equal((await store.list()).legacyFiles, 1);
    await assert.rejects(store.remove(result.id), { code: 'NORA_BACKUP_CHANGED' });
    await assert.rejects(store.download('../escape'), { code: 'NORA_BACKUP_INVALID_ID' });
    await fs.unlink(path.join(f.directories.backups, '.nora-chat', `${listed.id}.json`));
    await store.maintain();
    assert.equal((await store.list()).legacyFiles, 1);
    await foreign.backup('chat_foreign.jsonl', 'untouched');
    await fs.symlink(path.join(foreign.directories.backups, 'chat_foreign.jsonl'), path.join(f.directories.backups, 'chat_link.jsonl'));
    await assert.rejects(store.maintain(), { code: 'NORA_BACKUP_UNSAFE_PATH' });
    assert.equal(await fs.readFile(path.join(foreign.directories.backups, 'chat_foreign.jsonl'), 'utf8'), 'untouched');
});

test('stale or deleted-world queued saves cannot create new snapshots', async t => {
    const f = await storageFixture(t);
    const world = await f.create('stale');
    const store = createChatBackupStore({ directories: f.directories });
    const stale = await savedChat(f, world);
    await savedChat(f, world, 8);
    await assert.rejects(store.capture(stale), { code: 'NORA_BACKUP_SOURCE_CHANGED' });
    const current = await savedChat(f, world, 9);
    await fs.unlink(current.filePath);
    await assert.rejects(store.capture(current), { code: 'NORA_BACKUP_SOURCE_MISSING' });
    assert.equal((await store.list()).snapshots.length, 0);
});

test('World deletion waits for an admitted snapshot and removes both old and newly committed backups', { timeout: 10000 }, async t => {
    const f = await storageFixture(t);
    const world = await f.create('delete-during-commit');
    const store = createChatBackupStore({ directories: f.directories, policy: { maxPerSession: 1 } });
    const original = await savedChat(f, world);
    await store.capture(original);
    const changed = await savedChat(f, world, 9);
    const open = fs.open;
    let deletion;
    const fault = t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (!deletion && flags === 'wx' && String(file).endsWith('.json')) {
            deletion = f.core.deleteWorld(world.world_id, { idempotencyKey: 'delete:commit-race' });
        }
        return open(file, flags, ...args);
    });
    await store.capture(changed);
    assert.ok(deletion);
    assert.equal((await deletion).world.lifecycle.status, 'DELETED');
    fault.mock.restore();
    const list = await store.list();
    assert.equal(list.snapshots.length, 0);
    assert.equal(list.legacyFiles, 0);
    await assert.rejects(store.capture(changed), { code: 'NORA_BACKUP_SOURCE_MISSING' });
});

test('metadata write failure removes only its own incomplete addition and preserves the previous snapshot', async t => {
    const f = await storageFixture(t);
    const world = await f.create('metadata-fault');
    const store = createChatBackupStore({ directories: f.directories, policy: { maxPerSession: 1 } });
    const first = await store.capture(await savedChat(f, world));
    const open = fs.open;
    t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (flags === 'wx' && String(file).endsWith('.json')) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
        return open(file, flags, ...args);
    });
    await assert.rejects(store.capture(await savedChat(f, world, 8)), { code: 'ENOSPC' });
    const list = await store.list();
    assert.equal(list.legacyFiles, 0);
    assert.deepEqual(list.snapshots.map(item => item.id), [first.id]);
});

test('legacy and protected bytes consume the budget; rejected additions do not destroy existing data', async t => {
    const f = await storageFixture(t);
    const world = await f.create('quota');
    const input = await savedChat(f, world);
    const bytes = Buffer.byteLength(input.data);
    const store = createChatBackupStore({ directories: f.directories, policy: { maxPerSession: 2, maxBytes: bytes + 100 } });
    const first = await store.capture(input);
    await store.protect(first.id, true);
    await assert.rejects(store.capture(await savedChat(f, world, 9)), { code: 'NORA_BACKUP_BUDGET_EXCEEDED' });
    assert.equal((await store.list()).snapshots.length, 1);
    assert.equal((await store.download(first.id)).toString(), input.data);
    await f.backup('chat_legacy_quota.jsonl', 'x'.repeat(101));
    await assert.rejects(store.capture(await savedChat(f, world, 8)), { code: 'NORA_BACKUP_BUDGET_EXCEEDED' });
    assert.equal((await store.list()).overBudget, true);
    assert.equal((await f.chat(world)).at(-1).extra.stat_data.hp, 8, 'formal saved chat is independent of backup failure');
});

test('retention is per session, ages inactive sessions, and never prunes protected or legacy snapshots', async t => {
    const f = await storageFixture(t);
    const a = await f.create('retention-a');
    const b = await f.create('retention-b');
    let clock = Date.UTC(2026, 8, 29);
    const store = createChatBackupStore({ directories: f.directories, now: () => clock,
        policy: { maxPerSession: 2, maxAgeDays: 30, maxBytes: 512 * 1024 * 1024 } });
    await f.backup('chat_old.jsonl', [{ user_name: 'User' }]);
    const protectedCopy = await store.capture(await savedChat(f, a, 10));
    await store.protect(protectedCopy.id, true);
    clock++;
    const obsolete = await store.capture(await savedChat(f, a, 9));
    clock++;
    await store.capture(await savedChat(f, b, 8));
    clock++;
    await store.capture(await savedChat(f, a, 7));
    clock++;
    await store.capture(await savedChat(f, a, 6));
    let list = await store.list();
    assert.equal(list.snapshots.filter(item => item.worldId === a.world_id).length, 3);
    assert.ok(!list.snapshots.some(item => item.id === obsolete.id));
    clock += 31 * 86400000;
    await store.maintain();
    list = await store.list();
    assert.deepEqual(list.snapshots.map(item => item.id), [protectedCopy.id]);
    assert.equal(list.legacyFiles, 1);
    await assert.rejects(store.remove(protectedCopy.id), { code: 'NORA_BACKUP_PROTECTED' });
    await store.protect(protectedCopy.id, false);
    await store.remove(protectedCopy.id);
    assert.equal((await store.list()).snapshots.length, 0);
});

test('default retention bounds disk growth at fifty snapshots and repeated same-state saves add zero bytes', async t => {
    const f = await storageFixture(t);
    const world = await f.create('growth');
    const store = createChatBackupStore({ directories: f.directories });
    let input = await savedChat(f, world);
    const messages = input.data.split('\n').map(JSON.parse);
    messages[1].mes = 'x'.repeat(64 * 1024);
    const times = [];
    for (let hp = 80; hp > 0; hp--) {
        messages[1].extra.stat_data.hp = hp;
        input.data = messages.map(item => JSON.stringify(item)).join('\n');
        await fs.writeFile(input.filePath, input.data);
        const start = performance.now();
        await store.capture(input);
        times.push(performance.now() - start);
    }
    const before = await store.list();
    for (let i = 0; i < 10; i++) assert.equal((await store.capture(input)).status, 'unchanged');
    const after = await store.list();
    assert.equal(after.snapshots.length, 50);
    assert.equal(after.totalBytes, before.totalBytes);
    assert.equal(after.legacyFiles, 0);
    assert.ok(after.totalBytes < 3.4 * 1024 * 1024);
    times.sort((a, b) => a - b);
    t.diagnostic(`80 changed + 10 unchanged saves: files=${after.snapshots.length}, bytes=${after.totalBytes}, capture median=${times[40].toFixed(1)}ms, max=${times.at(-1).toFixed(1)}ms`);
    assert.ok(times.at(-1) < 2000, 'isolated 64 KiB snapshot retention must finish within two seconds');
});

test('an oversized addition fails but a kept copy does not consume an automatic slot', async t => {
    const f = await storageFixture(t);
    const world = await f.create('limits');
    const input = await savedChat(f, world);
    const tooSmall = createChatBackupStore({ directories: f.directories, policy: { maxBytes: Buffer.byteLength(input.data) - 1 } });
    await assert.rejects(tooSmall.capture(input), { code: 'NORA_BACKUP_BUDGET_EXCEEDED' });
    assert.equal((await tooSmall.list()).snapshots.length, 0);
    const store = createChatBackupStore({ directories: f.directories, policy: { maxPerSession: 1 } });
    const first = await store.capture(input);
    await store.protect(first.id, true);
    assert.equal((await store.capture(await savedChat(f, world, 7))).status, 'created');
    assert.equal((await store.list()).snapshots.length, 2);
    await fs.truncate(input.filePath, 257 * 1024 * 1024);
    await assert.rejects(store.capture(input), { code: 'NORA_BACKUP_UNSAFE_FILE' });
    assert.equal((await store.download(first.id)).toString(), input.data);
});

test('explicit keep is committed with capture and reuses unchanged bytes outside automatic slots', async t => {
    const f = await storageFixture(t);
    const world = await f.create('required-protection');
    const store = createChatBackupStore({ directories: f.directories, policy: { maxPerSession: 1 } });
    const input = await savedChat(f, world);
    const first = await store.capture(input);
    const protectedCopy = await store.capture({ ...input, protect: true });
    assert.equal(protectedCopy.id, first.id);
    assert.equal((await store.list()).snapshots[0].protected, true);
    await assert.rejects(store.remove(first.id), { code: 'NORA_BACKUP_PROTECTED' });
    assert.equal((await store.capture({ ...await savedChat(f, world, 8), protect: true })).status, 'created');
    assert.equal((await store.list()).snapshots.length, 2);
    assert.equal((await store.download(first.id)).toString(), input.data);
});

test('a killed writer leaves the previous snapshot usable and an uncommitted file untouched after restart', { timeout: 15000 }, async t => {
    const f = await storageFixture(t);
    const world = await f.create('crash');
    const store = createChatBackupStore({ directories: f.directories, policy: { maxPerSession: 1 } });
    const original = await savedChat(f, world);
    const first = await store.capture(original);
    const changed = await savedChat(f, world, 6);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs/promises';
        import { createChatBackupStore } from ${JSON.stringify(new URL('../src/chat-backup-store.js', import.meta.url).href)};
        let input = ''; for await (const chunk of process.stdin) input += chunk;
        const { directories, filePath, data } = JSON.parse(input);
        const open = fs.open;
        fs.open = async (file, flags, ...args) => {
            if (flags === 'wx' && String(file).endsWith('.json')) {
                process.stdout.write('before-metadata');
                await new Promise(() => { setInterval(() => {}, 1000); });
            }
            return open(file, flags, ...args);
        };
        await createChatBackupStore({ directories, policy: { maxPerSession: 1 } }).capture({ filePath, data });
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    let output = '', errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const reached = new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => { output += chunk; if (output.includes('before-metadata')) resolve(); });
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`writer exited before checkpoint: ${errors}`)));
    });
    child.stdin.end(JSON.stringify({ directories: f.directories, ...changed }));
    await reached;
    child.kill('SIGKILL');
    await exited;
    const restarted = createChatBackupStore({ directories: f.directories, policy: { maxPerSession: 1 } });
    await restarted.maintain();
    assert.deepEqual((await restarted.list()).snapshots.map(item => item.id), [first.id]);
    assert.equal((await restarted.list()).legacyFiles, 1, 'uncommitted snapshot is not adopted or erased');
    assert.equal((await restarted.download(first.id)).toString(), original.data);
    assert.equal(await fs.readFile(changed.filePath, 'utf8'), changed.data);
    assert.equal((await restarted.capture(changed)).status, 'created');
    assert.equal((await restarted.list()).legacyFiles, 1);
});

test('inactive maintenance and a second store instance cannot interleave a partially written snapshot', async t => {
    const f = await storageFixture(t);
    const world = await f.create('concurrent-maintenance');
    const store = createChatBackupStore({ directories: f.directories });
    const input = await savedChat(f, world);
    const open = fs.open;
    let release, reached;
    const checkpoint = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const fault = t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (flags === 'wx' && String(file).endsWith('.json')) { reached(); await gate; }
        return open(file, flags, ...args);
    });
    const capture = store.capture(input);
    await checkpoint;
    const other = createChatBackupStore({ directories: f.directories });
    let finished = false;
    const maintenance = other.maintain().then(result => { finished = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    release();
    const created = await capture;
    await maintenance;
    fault.mock.restore();
    await other.protect(created.id, true);
    assert.equal((await store.list()).snapshots[0].protected, true);
    assert.equal((await store.download(created.id)).toString(), input.data);
});

test('two path spellings of the same user root share backup serialization', async t => {
    const f = await storageFixture(t);
    const outside = await storageFixture(t);
    const alias = path.join(outside.root, 'user-alias');
    await fs.symlink(f.root, alias, 'junction');
    const directories = Object.fromEntries(Object.entries(f.directories).map(([key, value]) => [key, path.join(alias, path.relative(f.root, value))]));
    const store = createChatBackupStore({ directories: f.directories });
    const other = createChatBackupStore({ directories });
    const input = await savedChat(f, await f.create('root-alias'));
    const open = fs.open;
    let release, reached;
    const gate = new Promise(resolve => { release = resolve; });
    const checkpoint = new Promise(resolve => { reached = resolve; });
    t.after(() => release());
    let held = false;
    t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (!held && flags === 'wx' && String(file).endsWith('.json')) {
            held = true;
            reached();
            await gate;
        }
        return open(file, flags, ...args);
    });
    const first = store.capture(input);
    await checkpoint;
    const second = other.capture({ ...input, filePath: path.join(alias, path.relative(f.root, input.filePath)) });
    // Give the other instance enough time to reach the held commit. Without
    // canonical locking it sees no metadata and commits a duplicate snapshot.
    const early = await Promise.race([second.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(early, false);
    assert.equal(a.id, b.id);
    assert.equal((await other.list()).snapshots.length, 1);
});

test('a twenty-snapshot, forty-MiB fixture has bounded listing latency and does not return chat bodies', { timeout: 30000 }, async t => {
    const f = await storageFixture(t);
    const world = await f.create('large');
    const store = createChatBackupStore({ directories: f.directories });
    const input = await savedChat(f, world);
    const messages = input.data.split('\n').map(JSON.parse);
    messages[1].mes = 'x'.repeat(2 * 1024 * 1024);
    for (let i = 0; i < 20; i++) {
        messages[1].extra.stat_data.hp = i;
        input.data = messages.map(item => JSON.stringify(item)).join('\n');
        await fs.writeFile(input.filePath, input.data);
        await store.capture(input);
    }
    const times = [];
    let list;
    for (let i = 0; i < 3; i++) {
        const started = performance.now();
        list = await store.list();
        times.push(performance.now() - started);
    }
    assert.equal(list.snapshots.length, 20);
    assert.ok(list.totalBytes > 40 * 1024 * 1024 && list.totalBytes < 41 * 1024 * 1024);
    assert.ok(JSON.stringify(list).length < 16000);
    assert.ok([...times].sort((a, b) => a - b)[1] < 2000);
    t.diagnostic(`40 MiB listing ms=${times.map(value => value.toFixed(1)).join('/')} maxRSSKiB=${process.resourceUsage().maxRSS}`);
});

// Twenty real captures populate 500 MiB and verify earlier snapshots each time.
// Allow cold native storage to prepare the fixture; the measured list budget
// below remains two seconds.
test('near the default user budget, automatic backups roll across Worlds without changing either chat', { timeout: 120000 }, async t => {
    const f = await storageFixture(t);
    const store = createChatBackupStore({ directories: f.directories });
    const input = await savedChat(f, await f.create('near-budget'));
    const messages = input.data.split('\n').map(JSON.parse);
    messages[1].mes = 'x'.repeat(25 * 1024 * 1024);
    for (let hp = 0; hp < 20; hp++) {
        messages[1].extra.stat_data.hp = hp;
        input.data = messages.map(item => JSON.stringify(item)).join('\n');
        await fs.writeFile(input.filePath, input.data);
        await store.capture(input);
    }
    const start = performance.now();
    const list = await store.list();
    const elapsed = performance.now() - start;
    assert.equal(list.snapshots.length, 20);
    assert.ok(list.totalBytes > 500 * 1024 * 1024 && list.totalBytes < 501 * 1024 * 1024);
    assert.ok(JSON.stringify(list).length < 20000);
    assert.ok(elapsed < 2000, 'near-budget metadata listing must finish within the agreed local scan budget');
    const another = await savedChat(f, await f.create('over-budget'));
    const otherMessages = another.data.split('\n').map(JSON.parse);
    otherMessages[1].mes = messages[1].mes;
    another.data = otherMessages.map(item => JSON.stringify(item)).join('\n');
    await fs.writeFile(another.filePath, another.data);
    const captured = await store.capture(another);
    assert.equal(captured.status, 'created');
    assert.equal(await fs.readFile(another.filePath, 'utf8'), another.data);
    const after = await store.list();
    assert.equal(after.snapshots.length, 20);
    assert.ok(after.totalBytes <= after.policy.maxBytes);
    assert.ok(after.snapshots.some(item => item.id === captured.id));
    assert.ok(!after.snapshots.some(item => item.id === list.snapshots.at(-1).id), 'oldest automatic snapshot is evicted');
    assert.equal(await fs.readFile(input.filePath, 'utf8'), input.data);
    t.diagnostic(`500 MiB listing ms=${elapsed.toFixed(1)} maxRSSKiB=${process.resourceUsage().maxRSS}`);
});
