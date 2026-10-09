import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { storageFixture } from './nora-storage-fixture.mjs';
import { setConfigFilePath } from '../src/util.js';
import { createChatBackupStore, DEFAULT_CHAT_BACKUP_POLICY } from '../src/chat-backup-store.js';
import { chatBackupStore, chatBackupStatus, protectChatBeforeRewrite, queueChatBackup } from '../src/chat-backup-runtime.js';
import { resolveStoryLedger } from '../src/nora-story-ledger/runtime.js';
import { prefixText } from '../public/scripts/nora-story-ledger/history.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

async function scenario(t, key) {
    const f = await storageFixture(t);
    const world = await f.create(key);
    const scope = { worldId: world.world_id, sessionId: world.sessions.default_session_id };
    const filePath = path.join(f.directories.chats, path.basename(world.runtime_card.binding.avatar, '.png'),
        `${world.sessions.items[0].binding.chat_id}.jsonl`);
    const header = (await f.chat(world))[0];
    const runtime = resolveStoryLedger(f.directories, { recoverProjection: false });
    await runtime.resolve(scope);
    await runtime.configure(scope, { enabled: false });
    const store = chatBackupStore(f.directories);
    async function save(version) {
        const messages = [{ name: 'Narrator', is_user: false, mes: `Reply ${version}`,
            swipes: [`Reply ${version}`], swipe_id: 0, extra: { stat_data: { version } } }];
        const data = [header, ...messages].map(JSON.stringify).join('\n');
        await fs.writeFile(filePath, data);
        const expectedSignature = crypto.createHash('sha256').update(prefixText(messages, messages.length)).digest('hex');
        return { data, expectedSignature };
    }
    return { ...f, scope, filePath, runtime, store, save };
}

test('default policy and runtime both retain fifty automatic snapshots', async t => {
    const f = await scenario(t, 'default-fifty');
    assert.equal(DEFAULT_CHAT_BACKUP_POLICY.maxPerSession, 50);
    assert.equal((await f.store.list()).policy.maxPerSession, 50);
});

function assertOptionalCapture(result, completed) {
    if (['failed', 'skipped'].includes(result.status)) {
        assert.ok(['NORA_BACKUP_TIMEOUT', 'NORA_BACKUP_BUSY'].includes(result.code), JSON.stringify(result));
    } else {
        assert.equal(result.status, 'unchanged');
        assert.equal(result.id, completed.id);
    }
}

test('125 completed recovery points retain fifty rolling slots and five manual backups across optional checkpoints', async t => {
    const f = await scenario(t, 'repeated-checkpoint');
    const pinned = [];
    let latest;
    for (let i = 0; i < 125; i++) {
        latest = await f.save(i);
        // Retention applies to completed captures. The foreground checkpoint
        // remains best-effort and may hit its one-second storage deadline.
        const completed = await f.store.capture({ filePath: f.filePath, data: latest.data, protect: i < 5 });
        const checkpoint = await f.runtime.checkpoint(f.scope, { expectedSignature: latest.expectedSignature });
        assertOptionalCapture(checkpoint, completed);
        if (i < 5) {
            pinned.push({ id: completed.id, data: latest.data });
        }
    }
    const list = await f.store.list();
    assert.equal(list.snapshots.filter(item => !item.protected).length, 50);
    assert.equal(list.snapshots.filter(item => item.protected).length, 5);
    assert.deepEqual(list.snapshots.filter(item => !item.protected).map(item => item.sequence),
        Array.from({ length: 50 }, (_, i) => 125 - i));
    for (const item of pinned) assert.equal((await f.store.download(item.id)).toString(), item.data);
    assert.equal(await fs.readFile(f.filePath, 'utf8'), latest.data);
    const completed = await f.store.capture({ filePath: f.filePath, data: latest.data });
    assert.equal(completed.status, 'unchanged');
    const same = await f.runtime.checkpoint(f.scope, { expectedSignature: latest.expectedSignature });
    assertOptionalCapture(same, completed);
    assert.equal((await f.store.list()).snapshots.length, 55);
});

test('legacy protected copies do not consume automatic slots and are not silently unprotected', async t => {
    const f = await scenario(t, 'legacy-protection');
    const saved = await f.save(0);
    const original = await f.store.capture({ filePath: f.filePath, data: saved.data, protect: true });
    const store = createChatBackupStore({ directories: f.directories, policy: { maxPerSession: 1 } });
    const next = await f.save(1);
    const current = await store.capture({ filePath: f.filePath, data: next.data });
    assert.equal(current.status, 'created');
    assert.equal((await store.list()).snapshots.length, 2);
    assert.equal((await store.list()).snapshots.find(item => item.id === original.id).protected, true);
    assert.equal((await store.download(original.id)).toString(), saved.data);
    const future = createChatBackupStore({ directories: f.directories, now: () => Date.now() + 31 * 86400000,
        policy: { maxPerSession: 1 } });
    await future.maintain();
    assert.deepEqual((await future.list()).snapshots.map(item => item.id), [original.id]);
});

test('one hundred real message edits keep fifty rollback copies without exhausting a protected quota', async t => {
    const f = await scenario(t, 'repeated-edits');
    let saved = await f.save(0);
    for (let i = 1; i <= 100; i++) {
        await f.store.capture({ filePath: f.filePath, data: saved.data });
        const result = await f.runtime.edit(f.scope, { messageId: 0, text: `Edited reply ${i}`,
            expectedSignature: saved.expectedSignature });
        const messages = result.slice(1);
        saved = { data: result.map(JSON.stringify).join('\n'),
            expectedSignature: crypto.createHash('sha256').update(prefixText(messages, messages.length)).digest('hex') };
    }
    const list = await f.store.list();
    assert.equal(list.snapshots.length, 50);
    assert.ok(list.snapshots.every(item => !item.protected));
    assert.equal((await f.chat(await f.core.getWorld(f.scope.worldId))).at(-1).mes, 'Edited reply 100');
    assert.equal((await f.store.download(list.snapshots[0].id)).toString().split('\n').map(JSON.parse).at(-1).mes,
        'Edited reply 99');
});

test('disk, permission and metadata backup failures do not block editing or remove any prior backup', async t => {
    const f = await scenario(t, 'failure-at-limit');
    for (let i = 0; i < 50; i++) {
        const saved = await f.save(i);
        await f.store.capture({ filePath: f.filePath, data: saved.data });
    }
    const prior = await f.store.list();
    assert.equal(prior.snapshots.length, 50);
    for (const [metadataOnly, code] of [[false, 'ENOSPC'], [true, 'ENOSPC'], [false, 'EACCES']]) {
        const saved = await f.save(50);
        const open = fs.open;
        const fault = t.mock.method(fs, 'open', async (file, flags, ...args) => {
            if (flags === 'wx' && (!metadataOnly || String(file).endsWith('.json'))) {
                throw Object.assign(new Error('synthetic backup storage failure'), { code });
            }
            return open(file, flags, ...args);
        });
        const edited = await f.runtime.edit(f.scope, { messageId: 0, text: 'Editing still works',
            expectedSignature: saved.expectedSignature });
        fault.mock.restore();
        assert.equal(edited.at(-1).mes, 'Editing still works');
        assert.equal(chatBackupStatus(f.directories).recent.at(-1).code, code);
        assert.deepEqual((await f.store.list()).snapshots.map(item => item.id), prior.snapshots.map(item => item.id));
        for (const item of prior.snapshots) assert.equal((await f.store.download(item.id)).length, item.bytes);
    }
    const saved = await f.save(50);
    await f.runtime.edit(f.scope, { messageId: 0, text: 'Retry succeeded', expectedSignature: saved.expectedSignature });
    assert.equal((await f.store.list()).snapshots.length, 50);
});

test('sixty manually kept backups exceeding the configured budget warn without blocking checkpoint, edit or reset', async t => {
    const f = await scenario(t, 'kept-over-budget');
    for (let i = 0; i < 60; i++) await f.store.capture({ ...await f.save(i), filePath: f.filePath, protect: true });
    const inventory = await f.store.list();
    assert.equal(inventory.overBudget, false);
    assert.equal(inventory.capacity.protectedCountExceeded, true, 'manual count over fifty produces a soft cleanup reminder');
    const key = 'SILLYTAVERN_BACKUPS_CHAT_RETENTION_MAXBYTES', previous = process.env[key];
    process.env[key] = String(inventory.totalBytes - 1);
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    const saved = await f.save(60);
    const checkpoint = await f.runtime.checkpoint(f.scope, { expectedSignature: saved.expectedSignature });
    assert.equal(checkpoint.status, 'failed');
    assert.equal(checkpoint.code, 'NORA_BACKUP_BUDGET_EXCEEDED');
    const list = await chatBackupStore(f.directories).list();
    assert.equal(list.capacity.protectedCount, 60);
    assert.equal(list.capacity.protectedLimitReached, true);
    const edited = await f.runtime.edit(f.scope, { messageId: 0, text: 'Can still play', expectedSignature: saved.expectedSignature });
    assert.equal(edited.at(-1).mes, 'Can still play');
    const inspected = await f.runtime.plugin.inspect(f.scope);
    await f.runtime.reset(f.scope, { expectedRevision: inspected.configRevision, expectedSignature: inspected.expectedSignature });
    assert.equal((await f.store.list()).snapshots.length, 60);
});

test('stalled backup storage has a bounded wait and cannot queue unlimited tasks or prune after timeout', async t => {
    const f = await scenario(t, 'stalled-backup');
    await f.store.capture({ filePath: f.filePath, data: (await f.save(0)).data });
    const saved = await f.save(1), open = fs.open;
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { entered = resolve; });
    const fault = t.mock.method(fs, 'open', async (file, flags, ...args) => {
        if (flags === 'wx') { entered(); await held; }
        return open(file, flags, ...args);
    });
    t.after(() => { release(); fault.mock.restore(); });
    const start = performance.now();
    const editing = f.runtime.edit(f.scope, { messageId: 0, text: 'First edit', expectedSignature: saved.expectedSignature });
    await reached;
    const first = await editing;
    assert.ok(performance.now() - start < 2500, 'backup stall cannot indefinitely hold normal editing');
    assert.equal(first.at(-1).mes, 'First edit');
    const signature = crypto.createHash('sha256').update(prefixText(first.slice(1), first.length - 1)).digest('hex');
    const nextStart = performance.now();
    const second = await f.runtime.edit(f.scope, { messageId: 0, text: 'Second edit', expectedSignature: signature });
    assert.ok(performance.now() - nextStart < 500, 'a stalled backup is skipped, not queued repeatedly');
    assert.equal(second.at(-1).mes, 'Second edit');
    release(); fault.mock.restore();
    const list = await f.store.list();
    assert.equal(list.snapshots.length, 1, 'timed out capture cannot commit or prune later');
    assert.equal((await f.chat(await f.core.getWorld(f.scope.worldId))).at(-1).mes, 'Second edit');
});

test('a corrupted new backup is rejected before pruning old copies or editing the canonical chat', async t => {
    const f = await scenario(t, 'verify-before-prune');
    const oldStore = createChatBackupStore({ directories: f.directories, policy: { maxPerSession: 1 } });
    const previous = await f.save(0);
    const first = await oldStore.capture({ filePath: f.filePath, data: previous.data });
    const saved = await f.save(1);
    const open = fs.open;
    const fault = t.mock.method(fs, 'open', async (file, flags, ...args) => {
        const handle = await open(file, flags, ...args);
        if (flags === 'wx' && String(file).endsWith('.json')) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
                await close();
                const id = path.basename(String(file), '.json');
                await fs.appendFile(path.join(f.directories.backups, `chat_nora1_${id}.jsonl`), '\ncorrupted');
            };
        }
        return handle;
    });
    await assert.rejects(oldStore.capture({ filePath: f.filePath, data: saved.data }), { code: 'NORA_BACKUP_CHANGED' });
    fault.mock.restore();
    assert.equal((await oldStore.download(first.id)).toString(), previous.data);
    assert.equal(await fs.readFile(f.filePath, 'utf8'), saved.data);
});

test('restore checkpoints roll rather than becoming permanent pins, while preserving the selected source', async t => {
    const f = await scenario(t, 'repeated-restore');
    const first = await f.save(0);
    const selected = await f.store.capture({ filePath: f.filePath, data: first.data });
    await f.store.protect(selected.id, true);
    for (let i = 1; i <= 60; i++) {
        const saved = await f.save(i);
        const completed = await f.store.capture({ filePath: f.filePath, data: saved.data });
        const scope = { ...f.scope, id: selected.id };
        const preview = await f.store.previewRestore(scope);
        const input = { ...scope, expectedRevision: preview.current.revision, sha256: preview.snapshot.sha256 };
        const restored = await f.store.restore(input, { ledgerEnabled: false });
        if (restored.protectedBackupId) assert.equal(restored.protectedBackupId, completed.id);
        else assert.ok(['NORA_BACKUP_TIMEOUT', 'NORA_BACKUP_BUSY'].includes(restored.backupWarning?.code));
        assert.equal((await f.store.download(completed.id)).toString(), saved.data);
        assert.equal((await f.store.restore(input)).status, 'already-restored');
        assert.equal((await f.chat(await f.core.getWorld(f.scope.worldId))).at(-1).mes, 'Reply 0');
    }
    const list = await f.store.list();
    assert.equal(list.snapshots.filter(item => !item.protected).length, 50);
    assert.deepEqual(list.snapshots.filter(item => item.protected).map(item => item.id), [selected.id]);
});

test('pre-rewrite rollback attempts still work with background backups disabled, without creating permanent pins', async t => {
    const f = await scenario(t, 'background-disabled');
    const key = 'SILLYTAVERN_BACKUPS_CHAT_ENABLED', previous = process.env[key];
    process.env[key] = 'false';
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    const saved = await f.save(0);
    assert.equal(queueChatBackup({ directories: f.directories, filePath: f.filePath, data: saved.data }).status, 'disabled');
    const result = await protectChatBeforeRewrite({ directories: f.directories, filePath: f.filePath, data: saved.data });
    assert.equal((await f.store.list()).snapshots.find(item => item.id === result.id).protected, false);
});

test('restore validates the native canonical root when legacy synchronous realpath retains a short alias', async t => {
    const f = await scenario(t, 'native-root-identity');
    const first = await f.save(0);
    const selected = await f.store.capture({ filePath: f.filePath, data: first.data });
    await f.save(1);
    const scope = { ...f.scope, id: selected.id };
    const preview = await f.store.previewRestore(scope);
    const original = fsSync.realpathSync;
    const legacy = Object.assign((file, ...args) => path.resolve(file) === path.resolve(f.root)
        ? f.root + '-short-alias' : original(file, ...args), { native: original.native });
    t.mock.method(fsSync, 'realpathSync', legacy);
    const restored = await f.store.restore({ ...scope, expectedRevision: preview.current.revision, sha256: preview.snapshot.sha256 },
        { ledgerEnabled: false });
    assert.equal(restored.status, 'restored');
    assert.deepEqual((await fs.readFile(f.filePath, 'utf8')).split('\n').slice(1), first.data.split('\n').slice(1));
});
