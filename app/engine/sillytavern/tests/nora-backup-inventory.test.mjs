import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { storageFixture } from './nora-storage-fixture.mjs';
import { inspectChatBackups, inspectUserStorage } from '../src/nora-world-core/storage-inventory.js';
import { documentFileName } from '../src/nora-world-core/atomic-json.js';

test('backup inventory distinguishes same-name Worlds sharing a source and follows identities after rename and deletion', async t => {
    const f = await storageFixture(t);
    const first = await f.create('first');
    const second = await f.create('second');
    assert.equal(first.name, second.name);
    assert.equal(first.source.sha256, second.source.sha256);
    const lines = await f.chat(first);
    await f.backup('chat_unrelated_name_1.jsonl', lines);
    const historical = await f.chat(second);
    await f.backup('chat_unrelated_name_2.jsonl', historical);
    await f.core.updateWorld(first.world_id, { name: '改名后的世界' }, { expectedRevision: first.revision });
    await f.core.deleteWorld(second.world_id, { idempotencyKey: 'delete:second' });
    await assert.rejects(fs.stat(path.join(f.directories.backups, 'chat_unrelated_name_2.jsonl')), { code: 'ENOENT' });
    // Simulate an old-version backup retained before coordinated deletion existed.
    await f.backup('chat_unrelated_name_2.jsonl', historical);
    const result = await inspectChatBackups(f.directories);
    assert.equal(result.readOnly, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.backups.map(item => item.owner), [
        { confidence: 'identified', worldId: first.world_id, sessionId: first.sessions.default_session_id,
            worldStatus: 'READY', reason: 'identity-match' },
        { confidence: 'identified', worldId: second.world_id, sessionId: second.sessions.default_session_id,
            worldStatus: 'DELETED', reason: 'identity-match' },
    ]);
    assert.equal(result.backups[0].messageCount, 0, 'header-only sessions are valid, not corrupt');
    assert.equal((await f.core.getWorld(first.world_id)).name, '改名后的世界');
});

test('inventory refuses symlinked files and directories and reports unreadable ownership instead of repairing files', async t => {
    const f = await storageFixture(t);
    const world = await f.create('safe');
    await f.backup('chat_safe.jsonl', await f.chat(world));
    const external = path.join(f.root, 'private-external.jsonl');
    await fs.writeFile(external, 'PRIVATE_OUTSIDE_INVENTORY');
    await fs.symlink(external, path.join(f.directories.backups, 'chat_link.jsonl'));
    await fs.writeFile(path.join(f.root, 'nora-world-core', 'worlds', 'broken.json'), '{');
    const report = await inspectChatBackups(f.directories);
    assert.equal(report.complete, false);
    assert.ok(report.warnings.some(item => item.code === 'unsafe-path'));
    assert.equal(report.backups.find(item => item.name === 'chat_link.jsonl').sha256, null);
    assert.equal(await fs.readFile(path.join(f.root, 'nora-world-core', 'worlds', 'broken.json'), 'utf8'), '{');
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_OUTSIDE_INVENTORY/);
    await fs.rename(f.directories.backups, path.join(f.root, 'real-backups'));
    await fs.symlink(path.join(f.root, 'real-backups'), f.directories.backups);
    const linked = await inspectChatBackups(f.directories);
    assert.equal(linked.backups.length, 0);
    assert.equal(linked.complete, false);
    await assert.rejects(inspectChatBackups({ ...f.directories, backups: path.dirname(f.root) }), /outside/i);
});

test('absent storage remains absent; ambiguous manifests never become certain ownership and rescan uses current files', async t => {
    const f = await storageFixture(t);
    const first = await inspectChatBackups(f.directories);
    assert.equal(first.complete, true);
    await assert.rejects(fs.stat(path.join(f.root, 'nora-world-core', 'worlds')), { code: 'ENOENT' });
    const world = await f.create('ambiguous');
    await f.backup('chat_snapshot.jsonl', await f.chat(world));
    const directory = path.join(f.root, 'nora-world-core', 'worlds');
    const name = (await fs.readdir(directory))[0];
    await fs.copyFile(path.join(directory, name), path.join(directory, 'duplicate.json'));
    const duplicate = await inspectChatBackups(f.directories);
    assert.equal(duplicate.backups[0].owner.confidence, 'unknown');
    assert.equal(duplicate.backups[0].owner.reason, 'ambiguous-world');
    await fs.unlink(path.join(directory, 'duplicate.json'));
    assert.equal((await inspectChatBackups(f.directories)).backups[0].owner.confidence, 'identified');
});

test('inventory preserves legacy and broken snapshots, distinguishes MVU changes, and never promises complete restoration', async t => {
    const f = await storageFixture(t);
    const world = await f.create('variables');
    const header = (await f.chat(world))[0];
    const message = { name: 'NPC', is_user: false, mes: 'PRIVATE_SYNTHETIC_MESSAGE',
        extra: { stat_data: { hp: 10 } }, swipes: ['alternate'], swipe_id: 0 };
    const source = await f.backup('chat_original.jsonl', [header, message]);
    await f.backup('chat_duplicate.jsonl', source);
    await f.backup('chat_mvu_changed.jsonl', [header, { ...message, extra: { stat_data: { hp: 9 } } }]);
    await f.backup('chat_legacy.jsonl', [{ user_name: 'User', character_name: world.name }, message]);
    await f.backup('chat_broken.jsonl', `${JSON.stringify(header)}\n{"mes":`);
    const result = await inspectChatBackups(f.directories);
    const byName = Object.fromEntries(result.backups.map(item => [item.name, item]));
    assert.equal(byName['chat_broken.jsonl'].format, 'invalid');
    assert.equal(byName['chat_broken.jsonl'].owner.confidence, 'unknown');
    assert.equal(byName['chat_legacy.jsonl'].owner.confidence, 'candidate');
    assert.deepEqual(byName['chat_legacy.jsonl'].owner.worldIds, [world.world_id]);
    assert.notEqual(byName['chat_original.jsonl'].sha256, byName['chat_mvu_changed.jsonl'].sha256);
    assert.equal(result.summary.duplicateFiles, 1);
    assert.equal(result.summary.duplicateBytes, Buffer.byteLength(source));
    assert.equal(result.complete, false, 'broken content is explicitly reported, not silently omitted');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SYNTHETIC_MESSAGE|alternate|stat_data/);
    assert.equal(await fs.readFile(path.join(f.directories.backups, 'chat_original.jsonl'), 'utf8'), source);
    assert.equal((await fs.readdir(f.directories.backups)).length, 5, 'inventory must not delete or quarantine');
});

test('large snapshots are streamed while oversized files, malformed headers and session conflicts are explicit', async t => {
    const f = await storageFixture(t);
    const world = await f.create('large');
    const header = (await f.chat(world))[0];
    const file = await fs.open(path.join(f.directories.backups, 'chat_large.jsonl'), 'w');
    await file.writeFile(JSON.stringify(header));
    const line = '\n' + JSON.stringify({ mes: 'x'.repeat(256 * 1024), is_user: false });
    for (let i = 0; i < 68; i++) await file.write(line);
    await file.close();
    await f.backup('chat_not_header.jsonl', [{}]);
    const wrong = structuredClone(header);
    wrong.chat_metadata.nora_session.id = 'session:belongs-elsewhere';
    await f.backup('chat_wrong_session.jsonl', [wrong]);
    const sparse = await fs.open(path.join(f.directories.backups, 'chat_too_big.jsonl'), 'w');
    await sparse.truncate(257 * 1024 * 1024);
    await sparse.close();
    const result = await inspectChatBackups(f.directories);
    const byName = Object.fromEntries(result.backups.map(item => [item.name, item]));
    assert.equal(byName['chat_large.jsonl'].messageCount, 68);
    assert.equal(byName['chat_large.jsonl'].owner.confidence, 'identified');
    assert.equal(byName['chat_not_header.jsonl'].format, 'invalid');
    assert.equal(byName['chat_wrong_session.jsonl'].owner.reason, 'session-mismatch');
    assert.equal(byName['chat_too_big.jsonl'].owner.reason, 'file-too-large');
    assert.ok(result.metrics.readBytes < 20 * 1024 * 1024, 'oversized snapshot must not be read');
});

test('deletion during inventory invalidates earlier ownership evidence instead of reporting a stale READY World', async t => {
    const f = await storageFixture(t);
    const world = await f.create('race');
    await f.backup('chat_race.jsonl', await f.chat(world));
    const open = fs.open.bind(fs);
    let changed = false;
    // Filesystem race at the OS seam, not a mock of the inventory implementation.
    t.mock.method(fs, 'open', async (...args) => {
        const handle = await open(...args);
        if (!changed && String(args[0]).endsWith('chat_race.jsonl')) {
            changed = true;
            await f.core.deleteWorld(world.world_id, { idempotencyKey: 'delete:during-scan' });
        }
        return handle;
    });
    const report = await inspectChatBackups(f.directories);
    assert.equal(report.complete, false);
    assert.equal(report.backups[0].owner.confidence, 'unknown');
    assert.equal(report.backups[0].owner.reason, 'ownership-changed-during-scan');
});

test('legacy name collisions and partial IDs remain untrusted; invalid UTF-8 and overlong lines stay intact', async t => {
    const f = await storageFixture(t);
    const first = await f.create('collision-a');
    const second = await f.create('collision-b');
    const header = (await f.chat(first))[0];
    await f.backup('chat____legacy.jsonl', [{ user_name: 'User', character_name: first.name }]);
    const partial = structuredClone(header);
    delete partial.chat_metadata.nora_session;
    await f.backup('chat_partial.jsonl', [partial]);
    await f.backup('chat_long.jsonl', [header, { mes: 'x'.repeat(4 * 1024 * 1024 + 1) }]);
    await fs.writeFile(path.join(f.directories.backups, 'chat_utf8.jsonl'),
        Buffer.concat([Buffer.from(JSON.stringify(header) + '\n{"mes":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
    const report = await inspectChatBackups(f.directories);
    const byName = Object.fromEntries(report.backups.map(item => [item.name, item]));
    assert.deepEqual(byName['chat____legacy.jsonl'].owner.worldIds, [first.world_id, second.world_id].sort());
    assert.equal(byName['chat____legacy.jsonl'].owner.confidence, 'candidate');
    assert.equal(byName['chat_partial.jsonl'].owner.confidence, 'unknown');
    assert.equal(byName['chat_long.jsonl'].owner.reason, 'line-too-large');
    assert.equal(byName['chat_utf8.jsonl'].owner.reason, 'invalid-jsonl');
    assert.equal((await fs.readdir(f.directories.backups)).length, 4);
});

test('read-only inventory has bounded metadata and measures a 400-snapshot synthetic baseline', { timeout: 15000 }, async t => {
    const f = await storageFixture(t);
    const world = await f.create('scale');
    const source = (await f.chat(world)).map(JSON.stringify).join('\n') + '\n' + JSON.stringify({ mes: 'x'.repeat(64 * 1024) });
    for (let i = 0; i < 400; i++) await f.backup(`chat_scale_${String(i).padStart(3, '0')}.jsonl`, source);
    const durations = [];
    for (let run = 0; run < 3; run++) {
        const report = await inspectChatBackups(f.directories);
        assert.equal(report.complete, true);
        assert.equal(report.summary.files, 400);
        assert.equal(report.summary.duplicateFiles, 399);
        assert.ok(report.metrics.readBytes < 27 * 1024 * 1024);
        assert.ok(Buffer.byteLength(JSON.stringify(report)) < 400 * 1024, 'metadata must not include source payload');
        durations.push(report.metrics.durationMs);
    }
    t.diagnostic(`400 snapshots / ~25 MiB; sequential runs in ms: ${durations.join(', ')}`);
    assert.ok([...durations].sort((a, b) => a - b)[1] < 2000, 'isolated 25 MiB scan median regression budget is 2s');
});

test('inventory overlaps only a bounded number of readers and closes them before returning', async t => {
    const f = await storageFixture(t), world = await f.create('parallel-read');
    const source = await f.chat(world);
    for (let i = 0; i < 8; i++) await f.backup(`chat_parallel_${i}.jsonl`, source);
    const open = fs.open.bind(fs);
    let active = 0, peak = 0;
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await open(file, ...args);
        if (String(file).includes('chat_parallel_')) {
            active++; peak = Math.max(peak, active);
            const read = handle.read.bind(handle), close = handle.close.bind(handle);
            handle.read = async (...values) => {
                await new Promise(resolve => setTimeout(resolve, 5));
                return read(...values);
            };
            handle.close = async () => { try { return await close(); } finally { active--; } };
        }
        return handle;
    });
    const report = await inspectChatBackups(f.directories);
    assert.equal(report.complete, true);
    assert.equal(report.summary.files, 8);
    assert.equal(report.summary.duplicateFiles, 7);
    assert.ok(peak > 1 && peak <= 4);
    assert.equal(active, 0);
    assert.deepEqual(report.backups.map(item => item.name), Array.from({ length: 8 }, (_, i) => `chat_parallel_${i}.jsonl`));
});

test('a file exchanged for an external symlink before open never receives a digest or trusted owner', async t => {
    const f = await storageFixture(t);
    const world = await f.create('exchange');
    await f.backup('chat_exchange.jsonl', await f.chat(world));
    const target = path.join(f.directories.backups, 'chat_exchange.jsonl');
    const external = path.join(f.root, 'outside-scope');
    await fs.writeFile(external, 'PRIVATE_EXTERNAL_CONTENT');
    const open = fs.open.bind(fs);
    let exchanged = false;
    t.mock.method(fs, 'open', async (...args) => {
        if (!exchanged && String(args[0]).endsWith('chat_exchange.jsonl')) {
            exchanged = true;
            await fs.rename(target, path.join(f.root, 'original-snapshot'));
            await fs.symlink(external, target);
        }
        return open(...args);
    });
    const report = await inspectChatBackups(f.directories);
    assert.equal(report.complete, false);
    assert.equal(report.backups[0].sha256, null);
    assert.equal(report.backups[0].owner.confidence, 'unknown');
    assert.equal(report.backups[0].format, 'unreadable');
    assert.equal(await fs.readFile(external, 'utf8'), 'PRIVATE_EXTERNAL_CONTENT');
});

test('a snapshot replaced while another file is read is excluded from duplicate evidence', async t => {
    const f = await storageFixture(t);
    const world = await f.create('replace');
    const lines = await f.chat(world);
    await f.backup('chat_a.jsonl', lines);
    await f.backup('chat_b.jsonl', lines);
    const open = fs.open.bind(fs);
    let changed = false;
    t.mock.method(fs, 'open', async (...args) => {
        const handle = await open(...args);
        if (!changed && String(args[0]).endsWith('chat_b.jsonl')) {
            changed = true;
            await f.backup('chat_a.jsonl', [...lines, { mes: 'new message' }]);
        }
        return handle;
    });
    const report = await inspectChatBackups(f.directories);
    assert.equal(report.complete, false);
    assert.equal(report.backups[0].owner.reason, 'changed-during-scan');
    assert.equal(report.backups[0].sha256, null);
    assert.equal(report.summary.duplicateFiles, 0);
});

test('storage inventory separates references, source archives and unknown files without treating them as deletion candidates', async t => {
    const f = await storageFixture(t);
    const first = await f.create('ownership-a');
    const second = await f.create('ownership-b');
    await fs.writeFile(path.join(f.directories.characters, 'user-managed.png'), 'CUSTOM_USER_FILE');
    const sources = path.join(f.root, 'nora-world-core', 'library-cards', 'sources');
    await fs.mkdir(sources, { recursive: true });
    await fs.writeFile(path.join(sources, 'original.json'), 'SOURCE_ARCHIVE');
    const report = await inspectUserStorage(f.directories);
    assert.equal(report.complete, true);
    assert.equal(report.readOnly, true);
    const runtime = report.files.find(item => item.path === `characters/${first.runtime_card.binding.avatar}`);
    assert.deepEqual(runtime.references.map(item => item.worldId), [first.world_id]);
    assert.equal(runtime.category, 'world-resource');
    const other = report.files.find(item => item.path === `characters/${second.runtime_card.binding.avatar}`);
    assert.deepEqual(other.references.map(item => item.worldId), [second.world_id]);
    assert.equal(report.files.find(item => item.path === 'characters/user-managed.png').reason, 'unassigned-card-preserved');
    assert.equal(report.files.find(item => item.path.endsWith('sources/original.json')).reason, 'source-archive-preserved');
    assert.doesNotMatch(JSON.stringify(report), /CUSTOM_USER_FILE|SOURCE_ARCHIVE/);
    assert.ok(report.summary.bytes > 0);
    assert.equal(await fs.readFile(path.join(f.directories.characters, 'user-managed.png'), 'utf8'), 'CUSTOM_USER_FILE');
});

test('storage inventory reports shared resource references, preserves unknown files, and refuses nested symlinks', async t => {
    const f = await storageFixture(t);
    const first = await f.create('shared-a');
    const second = await f.create('shared-b');
    first.runtime_card.ownership = 'shared';
    second.runtime_card = structuredClone(first.runtime_card);
    for (const world of [first, second]) {
        await fs.writeFile(path.join(f.root, 'nora-world-core', 'worlds', documentFileName(world.world_id)), JSON.stringify(world));
    }
    const cardFile = path.join(f.directories.characters, first.runtime_card.binding.avatar);
    const original = await fs.readFile(cardFile);
    await fs.symlink(f.directories.characters, path.join(f.directories.chats, 'external-link'));
    const report = await inspectUserStorage(f.directories);
    const item = report.files.find(item => item.path === `characters/${first.runtime_card.binding.avatar}`);
    assert.deepEqual(item.references.map(ref => ref.worldId).sort(), [first.world_id, second.world_id].sort());
    assert.equal(report.complete, false);
    assert.ok(report.warnings.some(w => w.code === 'unsafe-path'));
    assert.ok(!report.files.some(file => file.path.includes('external-link/')));
    assert.deepEqual(await fs.readFile(cardFile), original);
});
