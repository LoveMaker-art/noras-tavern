import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
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
});
