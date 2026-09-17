import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorldbookLibrary } from '../src/nora-world-core/library-worldbooks.js';
import { withWorldbookLock } from '../src/worldbook-lock.js';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-standalone-book-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const roots = Object.fromEntries(['worlds', 'characters', 'chats'].map(key => [key, path.join(root, key)]));
    for (const directory of Object.values(roots)) await fs.mkdir(directory);
    const write = async (file, value) => {
        const target = path.join(root, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify(value));
    };
    const library = createWorldbookLibrary({ roots, cardCodec: { decode: async ({ buffer }) => ({ card: JSON.parse(buffer) }) },
        convertEmbeddedBook: book => ({ ...book, entries: Object.fromEntries(book.entries.map((entry, i) => [i, entry])) }) });
    const book = { name: 'Rules', entries: { 0: { uid: 0, comment: 'Rule', content: 'Rain', disable: true, key: ['rain'], depth: 4 } } };
    await write('worlds/rules.json', book);
    const item = await library.read({ kind: 'book', name: 'rules' });
    return { root, roots, write, library, book, item };
}

test('catalog hides generated shared/owned books and embedded cards without changing them', async t => {
    const f = await fixture(t);
    await f.write('worlds/shared.json', { ...f.book, extensions: { nora_resource: { schema: 1, content_sha256: 'digest' } } });
    await f.write('worlds/owned.json', f.book);
    await f.write('characters/card.png', { data: { character_book: { name: 'Embedded', entries: [{ content: 'Nested' }] } } });
    const worlds = [{ knowledge: [{ ownership: 'owned', binding: { name: 'owned' } }] }];
    const before = await fs.readFile(path.join(f.roots.worlds, 'shared.json'));
    const catalog = await f.library.list(worlds);
    assert.deepEqual(catalog.items.map(item => item.source.name), ['rules']);
    assert.equal((await f.library.read({ kind: 'card', name: 'card.png' })).count, 1);
    assert.deepEqual(await fs.readFile(path.join(f.roots.worlds, 'shared.json')), before);
});

test('explicit save of a runtime book creates a reusable original, retains entries and deduplicates', async t => {
    const f = await fixture(t);
    const runtime = { ...f.book, name: 'Runtime', extensions: { custom: true, nora_resource: { schema: 1, content_sha256: 'digest' } } };
    await f.write('worlds/runtime.json', runtime);
    const saved = await f.library.save('Runtime', runtime);
    assert.notEqual(saved.source.name, 'runtime');
    const item = await f.library.read(saved.source);
    assert.deepEqual(item.book.entries, runtime.entries);
    assert.deepEqual(item.book.extensions, { custom: true });
    assert.equal((await f.library.save('Runtime', runtime)).reused, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.roots.worlds, 'runtime.json'))), runtime);
});

const references = {
    world: async f => [{ knowledge: [{ binding: { name: 'rules' } }] }],
    card: async f => { await f.write('characters/ref.png', { data: { extensions: { world: 'rules' } } }); },
    global: async f => { await f.write('settings.json', { world_info_settings: { world_info: { globalSelect: ['rules'] } } }); },
    extraBook: async f => { await f.write('settings.json', { world_info_settings: { world_info: { charLore: [{ extraBooks: ['rules'] }] } } }); },
    persona: async f => { await f.write('settings.json', { power_user: { persona_descriptions: { player: { lorebook: 'rules' } } } }); },
    chat: async f => { await f.write('chats/card/chat.jsonl', { chat_metadata: { world_info: 'rules' } }); },
    groupChat: async f => { await f.write('group chats/chat.jsonl', { chat_metadata: { world_info: 'rules' } }); },
    group: async f => { await f.write('groups/group.json', { world_info: 'rules' }); },
    corrupt: async f => { await fs.writeFile(path.join(f.root, 'settings.json'), 'broken'); },
    symbolic: async f => { await fs.symlink(path.join(f.roots.worlds, 'rules.json'), path.join(f.roots.characters, 'ref.png')); },
};
for (const [kind, setup] of Object.entries(references)) {
    test(`delete protects ${kind} references or unreadable reference data`, async t => {
        const f = await fixture(t);
        const worlds = await setup(f) || [];
        await assert.rejects(f.library.remove(f.item.source, f.item.revision, worlds), { code: 'NORA_WORLD_INVALID' });
        assert.deepEqual((await f.library.read(f.item.source)).book, f.book);
    });
}

test('delete checks revision and source and never deletes runtime data or card', async t => {
    const f = await fixture(t);
    await assert.rejects(f.library.remove(f.item.source, 'stale', []), { code: 'NORA_WORLD_REVISION_CONFLICT' });
    for (const source of [{ kind: 'card', name: 'card.png' }, { kind: 'book', name: '../settings' }, { kind: 'book' }]) {
        await assert.rejects(f.library.remove(source, f.item.revision, []), { code: 'NORA_WORLD_INVALID' });
    }
    await f.write('worlds/runtime.json', { ...f.book, extensions: { nora_resource: { schema: 1 } } });
    const runtime = await f.library.read({ kind: 'book', name: 'runtime' });
    await assert.rejects(f.library.remove(runtime.source, runtime.revision, []), { code: 'NORA_WORLD_INVALID' });
    await fs.symlink(path.join(f.roots.worlds, 'rules.json'), path.join(f.roots.worlds, 'link.json'));
    await assert.rejects(f.library.remove({ kind: 'book', name: 'link' }, f.item.revision, []), { code: 'NORA_WORLD_INVALID' });
    assert.deepEqual((await f.library.read(f.item.source)).book, f.book);
});

test('deleting library original leaves applied independent copy and card unchanged', async t => {
    const f = await fixture(t);
    const card = { data: { character_book: { entries: [{ content: 'Card content' }] } } };
    await f.write('characters/original.png', card);
    const world = { world_id: 'world:a', knowledge: [] };
    const prepared = await f.library.prepare(world, { source: f.item.source, source_revision: f.item.revision });
    world.knowledge.push(prepared.resource);
    const copyPath = path.join(f.roots.worlds, `${prepared.resource.binding.name}.json`);
    const before = await fs.readFile(copyPath);
    assert.equal((await f.library.remove(f.item.source, f.item.revision, [world])).deleted, true);
    await assert.rejects(fs.stat(path.join(f.roots.worlds, 'rules.json')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(copyPath), before);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.roots.characters, 'original.png'))), card);
    assert.deepEqual((await f.library.list([world])).items, []);
});

test('delete queued behind an edit rechecks revision under the shared file lock', async t => {
    const f = await fixture(t);
    let release;
    let entered;
    const barrier = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const edit = withWorldbookLock(path.join(f.roots.worlds, 'rules.json'), async () => {
        entered();
        await barrier;
        await f.write('worlds/rules.json', { ...f.book, name: 'Edited' });
    });
    await started;
    const deleting = f.library.remove(f.item.source, f.item.revision, []);
    const rejected = assert.rejects(deleting, { code: 'NORA_WORLD_REVISION_CONFLICT' });
    release();
    await edit;
    await rejected;
    assert.equal((await f.library.read(f.item.source)).book.name, 'Edited');
});
