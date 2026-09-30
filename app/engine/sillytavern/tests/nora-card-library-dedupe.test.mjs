import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { deflateSync } from 'node:zlib';
import encodePng from '../src/png/encode.js';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { createStCardCodec } from '../src/nora-world-core/st-card-codec.js';
import { createCardLibrary } from '../src/nora-world-core/library-cards.js';
import { KeyedLock } from '../src/nora-world-core/locks.js';
import { stageLibraryCard } from '../src/nora-world-core/st-import-staging.js';
import express from 'express';
import multer from 'multer';
import { createNoraWorldsV2Router } from '../src/endpoints/nora-worlds-v2.js';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { createStBackendMaterializer } from '../src/nora-world-core/st-backend-materializer.js';

async function fixture(t, real = false) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-card-dedupe-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directories = Object.fromEntries(['characters', 'chats', 'worlds'].map(key => [key, path.join(root, key)]));
    const stagingRoot = path.join(root, 'core', 'staging');
    for (const dir of [...Object.values(directories), stagingRoot]) await fs.mkdir(dir, { recursive: true });
    const codec = real ? createStCardCodec({ serverRoot: fileURLToPath(new URL('../', import.meta.url)) }) : { decode: async ({ buffer }) => ({ card: JSON.parse(buffer), runtimeCardBuffer: buffer }),
        encodeRuntimeCard: async ({ card }) => Buffer.from(JSON.stringify(card)) };
    const materializer = createStBackendMaterializer({ directories, stagingRoot, cardCodec: codec });
    const core = createNoraWorldCore({ root: path.join(root, 'core'), materializer });
    const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Same card', description: 'Profile', first_mes: 'Opening', extensions: {} } };
    const bytes = real ? (await codec.decode({ buffer: Buffer.from(JSON.stringify(card)), format: 'json' })).runtimeCardBuffer : Buffer.from(JSON.stringify(card));
    const library = createCardLibrary({ roots: directories, stagingRoot, cardCodec: codec, locks: new KeyedLock() });
    const create = async (key, buffer = bytes) => {
        const staged = path.join(stagingRoot, `${key}.png`); await fs.writeFile(staged, buffer);
        return (await core.createWorld({ name: 'Same world', persona: { name: 'P', description: '' },
            source: { type: 'character-card', sha256: crypto.createHash('sha256').update(buffer).digest('hex'), original_name: 'renamed.png', format: 'png' },
            payload: { staged_card: { path: staged, format: 'png' } } }, { idempotencyKey: key })).world;
    };
    return { root, directories, stagingRoot, codec, materializer, core, card, bytes, create, library };
}

test('creating two worlds automatically stores exactly one library original and two independent runtime cards', async t => {
    const f = await fixture(t);
    const worlds = await Promise.all([f.create('one'), f.create('two')]);
    const runtime = new Set(worlds.map(world => world.runtime_card.binding.avatar));
    const files = (await fs.readdir(f.directories.characters)).filter(file => file.endsWith('.png'));
    assert.equal(files.filter(file => !runtime.has(file)).length, 1, 'World creation must auto-enrol and deduplicate its source before publishing runtime copies');
    assert.equal(runtime.size, 2);
    for (const world of worlds) assert.equal(world.lifecycle.status, 'READY');
    const catalog = await f.core.listLibraryCards();
    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.items.some(item => runtime.has(item.avatar)), false);
});

test('explicit library cleanup uses current revision and preserves referenced cards and World data', async t => {
    const f = await fixture(t, true);
    const world = await f.create('playing');
    const original = (await f.core.listLibraryCards()).items[0];
    const runtimeBefore = await fs.readFile(path.join(f.directories.characters, world.runtime_card.binding.avatar));
    for (const name of ['duplicate.png', 'referenced.png']) await fs.writeFile(path.join(f.directories.characters, name), f.bytes);
    await fs.mkdir(path.join(f.directories.chats, 'referenced'));
    await fs.writeFile(path.join(f.directories.chats, 'referenced', 'chat.jsonl'), 'keep');
    await assert.rejects(f.core.manageLibraryCard({ action: 'delete', avatar: original.avatar, revision: 'stale' }), { code: 'NORA_ST_RESOURCE_CONFLICT' });
    const cleaned = await f.core.manageLibraryCard({ action: 'deduplicate', avatar: original.avatar, revision: original.revision });
    assert.deepEqual(cleaned.removed, ['duplicate.png']);
    assert.deepEqual(cleaned.retained, [{ avatar: 'referenced.png', reason: 'referenced' }]);
    await assert.rejects(f.core.manageLibraryCard({ action: 'delete', avatar: world.runtime_card.binding.avatar, revision: original.revision }));
    const deleted = await f.core.manageLibraryCard({ action: 'delete', avatar: original.avatar, revision: original.revision });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.archive, 'retained-referenced');
    await assert.rejects(fs.stat(path.join(f.root, 'core', 'library-cards', `${original.id}.json`)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(path.join(f.directories.characters, world.runtime_card.binding.avatar)), runtimeBefore);
    assert.equal(await fs.readFile(path.join(f.directories.chats, 'referenced', 'chat.jsonl'), 'utf8'), 'keep');
    const referenced = (await f.core.listLibraryCards()).items.find(item => item.avatar === 'referenced.png');
    assert.equal((await f.core.manageLibraryCard({ action: 'delete', avatar: referenced.avatar, revision: referenced.revision })).deleted, false);
});

test('concurrent standalone import and World creation reuse one immutable original', async t => {
    const f = await fixture(t, true);
    const [first, second, world] = await Promise.all([
        f.core.saveLibraryCard({ buffer: f.bytes, format: 'png' }),
        f.core.saveLibraryCard({ buffer: f.bytes, format: 'png' }), f.create('concurrent'),
    ]);
    assert.equal(first.avatar, second.avatar);
    assert.equal((await f.core.listLibraryCards()).items.length, 1);
    assert.equal((await fs.readdir(f.directories.characters)).length, 2);
    assert.deepEqual(await fs.readFile(path.join(f.directories.characters, first.avatar)), f.bytes);
    assert.notEqual(first.avatar, world.runtime_card.binding.avatar);
});

test('a freshly confirmed MCP deletion can remove an identical re-import without reusing the old deletion receipt', async t => {
    const f = await fixture(t);
    for (let attempt = 0; attempt < 2; attempt++) {
        await f.core.saveLibraryCard({ buffer: f.bytes, format: 'png' });
        const original = (await f.core.listLibraryCards()).items[0];
        const result = await f.core.manageLibraryCard({ action: 'delete', avatar: original.avatar, revision: original.revision });
        assert.equal(result.deleted, true);
        assert.equal(result.alreadyAbsent, false);
        await assert.rejects(fs.stat(path.join(f.directories.characters, original.avatar)), { code: 'ENOENT' });
    }
});

test('deleting a library original removes its index and unreferenced archive, not a same-name card', async t => {
    const f = await fixture(t);
    const first = await f.core.saveLibraryCard({ buffer: f.bytes, format: 'png' });
    const changed = structuredClone(f.card); changed.data.description = 'Different card with the same name';
    const other = await f.core.saveLibraryCard({ buffer: Buffer.from(JSON.stringify(changed)), format: 'png' });
    const result = await f.core.deleteLibraryCard(first.avatar);
    assert.equal(result.deleted, true);
    assert.equal(result.archive, 'deleted');
    assert.deepEqual((await f.core.listLibraryCards()).items.map(item => item.avatar), [other.avatar]);
    assert.deepEqual((await fs.readdir(path.join(f.root, 'core', 'library-cards'))).filter(name => name.endsWith('.json')), [`${other.id}.json`]);
    assert.equal((await fs.readdir(path.join(f.root, 'core', 'library-cards', 'sources'))).length, 1);
    assert.deepEqual((await f.core.readLibraryCardSource(other.avatar)).buffer, Buffer.from(JSON.stringify(changed)));
});

test('library deletion preserves a World and its still-referenced source archive', async t => {
    const f = await fixture(t);
    const world = await f.create('archive-owner');
    const original = (await f.core.listLibraryCards()).items[0];
    const runtimePath = path.join(f.directories.characters, world.runtime_card.binding.avatar);
    const runtime = await fs.readFile(runtimePath);
    await assert.rejects(f.core.deleteLibraryCard(world.runtime_card.binding.avatar), { code: 'NORA_WORLD_RESOURCE_IN_USE' });
    const result = await f.core.deleteLibraryCard(original.avatar);
    assert.equal(result.archive, 'retained-referenced');
    assert.equal((await fs.readdir(path.join(f.root, 'core', 'library-cards', 'sources'))).length, 1);
    assert.deepEqual(await fs.readFile(runtimePath), runtime);
    assert.equal((await f.core.getWorld(world.world_id)).lifecycle.status, 'READY');
    assert.deepEqual((await f.core.listLibraryCards()).items, [], 'explicitly deleted originals must not reappear as legacy runtime snapshots');
});

test('interrupted library deletion resumes its recorded targets without allowing stale source import', async t => {
    const f = await fixture(t);
    const original = await f.core.saveLibraryCard({ buffer: f.bytes, format: 'png' });
    const archiveRoot = path.join(f.root, 'core', 'library-cards', 'sources');
    const unlink = fsSync.unlinkSync;
    fsSync.unlinkSync = target => {
        if (path.dirname(target) === archiveRoot) throw Object.assign(new Error('fixture archive busy'), { code: 'EBUSY' });
        return unlink(target);
    };
    try { await assert.rejects(f.core.deleteLibraryCard(original.avatar), { code: 'EBUSY' }); }
    finally { fsSync.unlinkSync = unlink; }
    await assert.rejects(f.core.readLibraryCardSource(original.avatar), { code: 'NORA_WORLD_RESOURCE_DELETING' });
    await assert.rejects(f.core.saveLibraryCard({ buffer: f.bytes, format: 'png' }), { code: 'NORA_WORLD_RESOURCE_DELETING' });
    const result = await f.core.deleteLibraryCard(original.avatar);
    assert.equal(result.alreadyAbsent, true);
    assert.equal(result.archive, 'deleted');
    assert.deepEqual(await fs.readdir(archiveRoot), []);
    assert.deepEqual((await f.core.listLibraryCards()).items, []);
});

test('library deletion retains changed archives instead of deleting by their indexed filename', async t => {
    const f = await fixture(t);
    const original = await f.core.saveLibraryCard({ buffer: f.bytes, format: 'png' });
    const archiveRoot = path.join(f.root, 'core', 'library-cards', 'sources');
    const archive = path.join(archiveRoot, (await fs.readdir(archiveRoot))[0]);
    await fs.writeFile(archive, 'user replaced this archive');
    assert.equal((await f.core.deleteLibraryCard(original.avatar)).archive, 'retained-changed');
    assert.equal(await fs.readFile(archive, 'utf8'), 'user replaced this archive');
    await assert.rejects(fs.stat(path.join(f.root, 'core', 'library-cards', `${original.id}.json`)), { code: 'ENOENT' });
});

test('an old library deletion refuses changed remaining bytes; a newly confirmed operation replans them', async t => {
    const f = await fixture(t);
    const original = await f.core.saveLibraryCard({ buffer: f.bytes, format: 'png' });
    const cardPath = path.join(f.directories.characters, original.avatar);
    const unlink = fsSync.unlinkSync;
    fsSync.unlinkSync = target => {
        if (target === cardPath) throw Object.assign(new Error('fixture card busy'), { code: 'EBUSY' });
        return unlink(target);
    };
    try { await assert.rejects(f.core.deleteLibraryCard(original.avatar, { idempotencyKey: 'old-delete' }), { code: 'EBUSY' }); }
    finally { fsSync.unlinkSync = unlink; }
    await fs.writeFile(cardPath, 'new user content');
    await assert.rejects(f.core.deleteLibraryCard(original.avatar, { idempotencyKey: 'old-delete' }), { code: 'NORA_WORLD_DELETE_PLAN_CHANGED' });
    assert.equal(await fs.readFile(cardPath, 'utf8'), 'new user content');
    assert.equal((await f.core.deleteLibraryCard(original.avatar, { idempotencyKey: 'new-confirmation' })).deleted, true);
});

test('replaying a completed library deletion cannot remove a later re-import of the same original', async t => {
    const f = await fixture(t);
    const original = await f.core.saveLibraryCard({ buffer: f.bytes, format: 'png' });
    await f.core.deleteLibraryCard(original.avatar, { idempotencyKey: 'old-user-action' });
    const replacement = await f.core.saveLibraryCard({ buffer: f.bytes, format: 'png' });
    assert.equal(replacement.avatar, original.avatar);
    await f.core.deleteLibraryCard(original.avatar, { idempotencyKey: 'old-user-action' });
    assert.deepEqual((await f.core.listLibraryCards()).items.map(item => item.avatar), [replacement.avatar]);
    assert.deepEqual((await f.core.readLibraryCardSource(replacement.avatar)).buffer, f.bytes);
    await f.core.deleteLibraryCard(replacement.avatar, { idempotencyKey: 'new-user-confirmation' });
    assert.deepEqual((await f.core.listLibraryCards()).items, []);
});

test('cleans only identical unreferenced originals and preserves chat, group, settings and World bindings', async t => {
    const f = await fixture(t, true);
    const names = ['a.png', 'duplicate.png', 'chat.png', 'group.png', 'settings.png', 'bound.png', 'x--nora-0123456789.png'];
    for (const name of names) await fs.writeFile(path.join(f.directories.characters, name), f.bytes);
    await fs.mkdir(path.join(f.directories.chats, 'chat'));
    await fs.writeFile(path.join(f.directories.chats, 'chat', 'history.jsonl'), 'untouched');
    await fs.mkdir(path.join(f.root, 'groups'));
    await fs.writeFile(path.join(f.root, 'groups', 'one.json'), JSON.stringify({ members: ['group.png'] }));
    await fs.writeFile(path.join(f.root, 'settings.json'), JSON.stringify({ selected: 'settings.png' }));
    const world = { runtime_card: { binding: { avatar: 'bound.png' } }, sessions: { items: [] } };
    const result = await f.library.save({ buffer: f.bytes, format: 'png' }, [world]);
    assert.equal(result.avatar, 'a.png');
    assert.deepEqual(result.removed, ['duplicate.png']);
    assert.deepEqual(result.retained.sort(), ['chat.png', 'group.png', 'settings.png']);
    for (const name of names.filter(name => name !== 'duplicate.png')) assert.deepEqual(await fs.readFile(path.join(f.directories.characters, name)), f.bytes);
    assert.equal(await fs.readFile(path.join(f.directories.chats, 'chat', 'history.jsonl'), 'utf8'), 'untouched');
    assert.deepEqual((await f.library.source('duplicate.png')).buffer, f.bytes, 'A stale preview still resolves to its surviving original');
});

test('ignores import timestamps and JSON object key order, never script, lore or cover differences', async t => {
    const f = await fixture(t, true);
    const base = await f.codec.decode({ buffer: f.bytes, format: 'png' });
    const first = await f.library.save({ buffer: f.bytes, format: 'png' });
    const reordered = { ...base.card, data: Object.fromEntries(Object.entries(base.card.data).reverse()), create_date: 'later', chat: 'storage-only' };
    const second = await f.library.save({ buffer: await f.codec.encodeRuntimeCard({ card: reordered, sourceBuffer: f.bytes }), format: 'png' });
    assert.equal(second.avatar, first.avatar);
    assert.equal((await fs.readdir(path.join(f.root, 'core', 'library-cards', 'sources'))).length, 1);
    for (const extensions of [{ custom_script: 'code A' }, { custom_script: 'code B' }]) {
        const card = structuredClone(base.card); card.data.extensions = extensions;
        const result = await f.library.save({ buffer: await f.codec.encodeRuntimeCard({ card, sourceBuffer: f.bytes }), format: 'png' });
        assert.equal(result.reused, false); assert.equal(result.same_name_different, true);
    }
    const lore = structuredClone(base.card); lore.data.character_book = { entries: [{ id: 1, content: 'different lore' }] };
    const book = await f.library.save({ buffer: await f.codec.encodeRuntimeCard({ card: lore, sourceBuffer: f.bytes }), format: 'png' });
    assert.equal(book.reused, false);
    const cover = Buffer.from(encodePng([
        { name: 'IHDR', data: Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]) },
        { name: 'IDAT', data: deflateSync(Buffer.from([0, 255, 0, 0])) },
        { name: 'IEND', data: Buffer.alloc(0) },
    ]));
    const image = await f.library.save({ buffer: await f.codec.encodeRuntimeCard({ card: base.card, sourceBuffer: cover }), format: 'png' });
    assert.equal(image.reused, false);
    assert.equal((await f.library.list()).items.length, 5);
});

test('CHARX asset differences remain distinct and library staging preserves the full archive', async t => {
    const f = await fixture(t, true);
    const card = structuredClone(f.card);
    card.data.assets = [{ type: 'expression', name: 'happy', ext: 'png', uri: 'embedded://assets/happy.png' }];
    const archive = bytes => Buffer.from(zipSync({ 'card.json': strToU8(JSON.stringify(card)), 'assets/happy.png': new Uint8Array(bytes) }));
    const input = archive([137, 80, 78, 71, 13, 10, 26, 10]);
    const first = await f.library.save({ buffer: input, format: 'charx' });
    const repeated = await f.library.save({ buffer: input, format: 'charx' });
    assert.equal(repeated.avatar, first.avatar);
    const changed = await f.library.save({ buffer: archive([137, 80, 78, 71, 13, 10, 26, 10, 1]), format: 'charx' });
    assert.notEqual(changed.avatar, first.avatar);
    const command = await stageLibraryCard({ avatar: first.avatar, charactersRoot: f.directories.characters, stagingRoot: f.stagingRoot,
        idempotencyKey: 'archive-stage', resolveSource: f.library.source });
    assert.equal(command.source.format, 'charx');
    assert.deepEqual(await fs.readFile(command.payload.staged_card.path), input);
    const world = (await f.core.createWorld(command, { idempotencyKey: 'archive-stage' })).world;
    const next = await stageLibraryCard({ avatar: first.avatar, charactersRoot: f.directories.characters, stagingRoot: f.stagingRoot,
        idempotencyKey: 'archive-stage-two', resolveSource: f.core.readLibraryCardSource });
    const secondWorld = (await f.core.createWorld(next, { idempotencyKey: 'archive-stage-two' })).world;
    assert.equal(world.lifecycle.status, 'READY');
    assert.notEqual(secondWorld.runtime_card.binding.avatar, world.runtime_card.binding.avatar);
    assert.equal((await f.core.listLibraryCards()).items.length, 2, 'Two asset variants remain two originals after creating multiple Worlds from one variant');
    assert.deepEqual(await fs.readFile(path.join(f.directories.characters, card.data.name, 'happy.png')), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test('modified indexed files, malformed cards and symlinks are never deleted as duplicates', async t => {
    const f = await fixture(t, true);
    const first = await f.library.save({ buffer: f.bytes, format: 'png' });
    const card = structuredClone(f.card); card.data.description = 'Edited by user';
    const changed = await f.codec.encodeRuntimeCard({ card, sourceBuffer: f.bytes });
    await fs.writeFile(path.join(f.directories.characters, first.avatar), changed);
    await fs.writeFile(path.join(f.directories.characters, 'broken.png'), 'not a PNG');
    await fs.symlink(path.join(f.directories.characters, first.avatar), path.join(f.directories.characters, 'link.png'));
    const result = await f.library.save({ buffer: f.bytes, format: 'png' });
    assert.notEqual(result.avatar, first.avatar);
    assert.deepEqual(result.removed, []);
    assert.equal(result.warnings.length, 2);
    assert.deepEqual((await f.library.source(first.avatar)).buffer, changed);
    assert.equal((await f.library.list()).items.length, 2);
});

test('pre-library World-only cards stay visible as one legacy snapshot without altering runtime files', async t => {
    const f = await fixture(t, true);
    const avatars = ['old--nora-0123456789.png', 'old--nora-9876543210.png'];
    for (const avatar of avatars) await fs.writeFile(path.join(f.directories.characters, avatar), f.bytes);
    const worlds = avatars.map(avatar => ({ name: 'Old', source: { sha256: 'same-original' }, runtime_card: { binding: { avatar } } }));
    const before = await f.library.list(worlds);
    assert.equal(before.items.length, 1); assert.equal(before.items[0].legacy, true);
    await f.library.save({ buffer: f.bytes, format: 'png' }, worlds);
    const after = await f.library.list(worlds);
    assert.equal(after.items.length, 1); assert.equal(after.items[0].legacy, undefined);
    for (const avatar of avatars) assert.deepEqual(await fs.readFile(path.join(f.directories.characters, avatar)), f.bytes);
});

test('multipart uploads under different filenames deduplicate through the real library route and clean upload files', async t => {
    const f = await fixture(t, true);
    const uploads = path.join(f.root, 'uploads');
    const app = express();
    app.use(express.json());
    app.use(multer({ dest: uploads }).single('avatar'));
    app.use('/api', createNoraWorldsV2Router({ resolveCore: () => f.core }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const upload = async filename => {
        const form = new FormData(); form.append('avatar', new Blob([f.bytes]), filename);
        const response = await fetch(`${base}/library/cards/import`, { method: 'POST', body: form });
        assert.equal(response.status, 200);
        return response.json();
    };
    const first = await upload('First.PNG');
    const second = await upload('Renamed.png');
    assert.equal(first.reused, false); assert.equal(second.reused, true);
    assert.equal(first.avatar, second.avatar);
    assert.equal((await (await fetch(`${base}/library/cards`)).json()).items.length, 1);
    assert.equal((await f.core.listWorlds()).length, 0, 'Store-only import must not create a World');
    for (let attempt = 0; attempt < 50 && (await fs.readdir(uploads)).length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(await fs.readdir(uploads), []);
    const item = (await (await fetch(`${base}/library/cards`)).json()).items[0];
    const manage = revision => fetch(`${base}/library/cards/manage`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delete', avatar: item.avatar, revision }) });
    assert.equal((await manage('stale')).status, 409);
    const deleted = await manage(item.revision);
    assert.equal(deleted.status, 200);
    const receipt = await deleted.json();
    assert.equal(receipt.deleted, true);
    assert.equal(receipt.archive, 'deleted');
    assert.deepEqual(await fs.readdir(path.join(f.root, 'core', 'library-cards', 'sources')), []);
    await assert.rejects(fs.stat(path.join(f.root, 'core', 'library-cards', `${item.id}.json`)), { code: 'ENOENT' });
    assert.deepEqual((await f.core.listLibraryCards()).items, []);
});
