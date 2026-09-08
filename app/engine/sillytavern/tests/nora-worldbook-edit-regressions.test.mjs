import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { prepareWorldbookEntryEdit } from '../src/nora-world-core/worldbook-entry-edit.js';
import { KeyedLock } from '../src/nora-world-core/locks.js';
import { router } from '../src/endpoints/worldinfo.js';
import { createWorldbookController } from '../../../native-extensions/nora-ui/worldbook-controller.js';
import { createStBackendMaterializer } from '../src/nora-world-core/st-backend-materializer.js';
import { createStWorldbookAdapter } from '../public/scripts/nora-adapters/st-worldbook-adapter.js';
import { readActivationSnapshot } from '../src/nora-world-core/activation-snapshot.js';
import { resolveWorldbookOverride } from '../public/scripts/nora-worlds/worldbook-bindings.js';
import { WorldStore } from '../src/nora-world-core/store.js';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';

const revision = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-edit-regression-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const book = { entries: { 0: { key: ['/a{1,3}/'], content: 'Original', comment: 'Rule' } } };
    await fs.writeFile(path.join(directory, 'shared.json'), JSON.stringify(book));
    const world = { world_id: 'world-a', knowledge: [{ resource_id: 'resource-a', ownership: 'owned', binding: { name: 'shared' } }] };
    const input = { name: 'shared', entry_id: '0', patch: { content: 'Edited' }, expected_revision: revision(book) };
    return { directory, book, world, input, locks: new KeyedLock() };
}

test('a legacy owned label without proof of exclusivity never permits an in-place edit', async t => {
    const f = await fixture(t);
    const result = await prepareWorldbookEntryEdit(f);
    assert.notEqual(result.resource.binding.name, 'shared');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'shared.json'), 'utf8')), f.book);
});

test('legacy saves cannot interleave after the edit revision check', async t => {
    const f = await fixture(t);
    f.exclusive = true;
    const editRoute = router.stack.find(layer => layer.route?.path === '/edit').route.stack[0].handle;
    const originalWrite = fs.writeFile;
    let legacySave;
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } };
    fs.writeFile = async (...args) => {
        if (!legacySave && String(args[0]).endsWith('.tmp')) {
            legacySave = Promise.resolve(editRoute({ user: { directories: { worlds: f.directory } }, body: {
                name: 'shared', expected_revision: revision(f.book), data: { entries: { 0: { ...f.book.entries[0], comment: 'Legacy edit' } } },
            } }, response));
        }
        return originalWrite(...args);
    };
    try {
        await prepareWorldbookEntryEdit(f);
        await legacySave;
        assert.equal(response.statusCode, 409, 'The stale competing writer must receive a conflict, not success');
    } finally { fs.writeFile = originalWrite; }
});

test('editing content preserves regex keys containing commas', async () => {
    const book = { entries: { 0: { key: ['/a{1,3}/'], content: 'Original', comment: 'Rule' } } };
    let submitHandler;
    let submitted;
    const form = { addEventListener(_name, fn) { submitHandler = fn; }, querySelector() { return {}; } };
    const inert = { addEventListener() {}, classList: { toggle() {} } };
    const originalFormData = globalThis.FormData;
    globalThis.FormData = class { get(key) { return { keys: '/a{1,3}/', comment: 'Rule', content: 'New content' }[key]; } };
    const controller = createWorldbookController({
        worldbook: { loadWorldbook: async () => book, saveWorldbookEntry: async (_name, _book, _id, patch) => {
            submitted = patch; return { resource: { binding: { name: 'private' } }, book };
        } },
        currentCharacter: () => ({ data: { extensions: { world: 'shared' } } }),
        readState: () => ({ world: { metadata: { nora_world: { id: 'world-a' } } } }),
        operations: { run: async (_key, operation) => operation(), isBusy: () => false },
        store: { cacheWorldbook() {} }, dialogs: { open: () => ({}), close() {}, toast() {}, normalizeError: String },
        select: selector => selector === '#nora-entry-form' ? form : selector === '.nora-sheet-body' ? {} : inert,
        selectAll: () => [], escapeHtml: String, reloadWorlds: async () => {}, onChanged() {},
    });
    try {
        await controller.openEntryEditor('embedded', '0');
        await submitHandler({ preventDefault() {}, currentTarget: form });
        assert.deepEqual(submitted, { content: 'New content' });
    } finally { globalThis.FormData = originalFormData; }
});

test('active World replacements suppress old global lore without modifying global selection', async () => {
    const source = await fs.readFile(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');
    const collectors = source.slice(source.indexOf('async function getCharacterLore()'), source.indexOf('export async function getSortedEntries()'));
    const globals = ['shared'];
    const metadata = { nora_world: { id: 'world-a', worldbook_overrides: { shared: 'private' } }, world_info: 'private' };
    const context = { selected_world_info: globals, chat_metadata: metadata, METADATA_KEY: 'world_info',
        characters: [{ data: { extensions: { world: 'private' } } }], this_chid: 0,
        getCharaFilename: () => 'card', world_info: {}, power_user: {}, console: { debug() {} },
        loadWorldInfo: async name => ({ entries: { 0: { uid: 0, content: name === 'shared' ? 'Old rule' : 'New rule' } } }),
        resolveWorldbookName: name => resolveWorldbookOverride(name, metadata),
    };
    const result = await vm.runInNewContext(`${collectors}; Promise.all([getGlobalLore(), getCharacterLore(), getChatLore(), getPersonaLore()])`, context);
    assert.deepEqual(Array.from(result.flat(), entry => entry.content), ['New rule']);
    assert.deepEqual(globals, ['shared']);
    metadata.nora_world = { id: 'world-b' }; metadata.world_info = 'shared';
    context.characters[0].data.extensions.world = 'shared';
    const other = await vm.runInNewContext('Promise.all([getGlobalLore(), getCharacterLore(), getChatLore(), getPersonaLore()])', context);
    assert.deepEqual(Array.from(other.flat(), entry => entry.content), ['Old rule']);
});

test('materializer checks other Worlds, library bindings and global references before overwriting', async t => {
    const f = await fixture(t);
    const characters = path.join(f.directory, 'characters');
    const books = path.join(f.directory, 'worlds');
    await fs.mkdir(characters); await fs.mkdir(books);
    await fs.writeFile(path.join(books, 'shared.json'), JSON.stringify(f.book));
    const directories = { characters, worlds: books, chats: path.join(f.directory, 'chats') };
    const materializer = createStBackendMaterializer({ directories, stagingRoot: f.directory,
        cardCodec: { decode: async () => ({ card: { data: { extensions: { world: 'shared' } } } }) } });
    const other = { world_id: 'world-b', knowledge: [{ ownership: 'external', binding: { name: 'shared' } }] };
    for (const mode of ['other-world', 'library', 'global']) {
        if (mode === 'library') await fs.writeFile(path.join(characters, 'library.png'), 'fixture');
        if (mode === 'global') {
            await fs.unlink(path.join(characters, 'library.png'));
            await fs.writeFile(path.join(f.directory, 'settings.json'), JSON.stringify({ world_info_settings: { world_info: { globalSelect: ['shared'] } } }));
        }
        const result = await materializer.editWorldbookEntry(f.world, f.input, { worlds: mode === 'other-world' ? [f.world, other] : [f.world] });
        assert.notEqual(result.resource.binding.name, 'shared', mode);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(books, 'shared.json'), 'utf8')), f.book);
        await result.abort();
    }
});

test('embedded-only edits create a private book and survive snapshot reopening without the original embedded copy', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-embedded-edit-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directories = Object.fromEntries(['characters', 'chats', 'worlds'].map(key => [key, path.join(root, key)]));
    await Promise.all(Object.values(directories).map(dir => fs.mkdir(dir)));
    const raw = { name: 'Embedded', entries: [{ id: 7, keys: ['/a{1,3}/'], content: 'Original', enabled: true }] };
    const card = { data: { character_book: raw, extensions: {} } };
    const cardBytes = JSON.stringify(card);
    await fs.writeFile(path.join(directories.characters, 'card.png'), cardBytes);
    const coreRoot = path.join(root, 'core');
    const store = new WorldStore({ root: coreRoot });
    let world = await store.put({
        schema_version: 2, world_id: 'world:embedded-test', revision: 0, name: 'Embedded test', persona: { name: '', description: '' },
        lifecycle: { status: 'READY', error: null }, source: { type: 'manual', sha256: '', original_name: '', format: '' },
        runtime_card: { resource_id: 'resource:embedded-card', engine: 'sillytavern', binding: { avatar: 'card.png' }, ownership: 'owned' },
        sessions: { default_session_id: 'session:embedded-test', items: [{ session_id: 'session:embedded-test', engine: 'sillytavern', binding: { chat_id: 'opening' }, opening_state: 'empty' }] },
        knowledge: [], capabilities: { declared: [], status: 'READY', items: {} },
        created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z',
    }, { expectedRevision: 0 });
    const materializer = createStBackendMaterializer({ directories, stagingRoot: root,
        cardCodec: { decode: async () => ({ card: structuredClone(card) }) } });
    const core = createNoraWorldCore({ root: coreRoot, materializer });
    const current = { chatMetadata: { nora_world: { id: world.world_id } }, characters: [structuredClone(card)], characterId: 0,
        getRequestHeaders: () => ({}), primeWorldInfoSnapshot() {}, updateWorldInfoList: async () => {} };
    const adapter = createStWorldbookAdapter(() => current);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
        const result = await core.editWorldbookEntry(world.world_id, JSON.parse(options.body));
        world = result.world;
        return { ok: true, json: async () => result };
    };
    try { await adapter.saveWorldbookEntry('', raw, '0', { content: 'Edited' }, world.world_id); }
    finally { globalThis.fetch = originalFetch; }
    const privateName = world.knowledge[0].binding.name;
    assert.equal(current.characters[0].data.extensions.world, privateName);
    assert.equal(current.characters[0].data.character_book, undefined);
    const book = JSON.parse(await fs.readFile(path.join(directories.worlds, `${privateName}.json`), 'utf8'));
    assert.equal(book.entries[7].content, 'Edited');
    assert.deepEqual(book.entries[7].key, ['/a{1,3}/']);
    assert.equal(await fs.readFile(path.join(directories.characters, 'card.png'), 'utf8'), cardBytes);
    const reopened = createNoraWorldCore({ root: coreRoot, materializer });
    const plan = await reopened.prepareOpen(world.world_id);
    const opened = await readActivationSnapshot(plan, directories, { revision: 'test', readers: {
        character: async () => structuredClone(card), chat: async () => ({ header: { chat_metadata: {} }, messages: [] }),
        worldbook: async () => book,
    } });
    assert.equal(opened.snapshot.character.data.extensions.world, privateName);
    assert.equal(opened.snapshot.character.data.character_book, undefined);
    assert.equal(opened.snapshot.worldbooks[0].data.entries[7].content, 'Edited');
    await assert.rejects(materializer.editWorldbookEntry(world, { name: '', entry_id: '0', expected_revision: revision(raw), patch: { content: 'Stale' } }), /already has a binding/);
});
