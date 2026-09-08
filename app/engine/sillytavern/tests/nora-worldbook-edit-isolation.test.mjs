import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createNoraWorldsV2Router } from '../src/endpoints/nora-worlds-v2.js';
import { createStWorldbookAdapter } from '../public/scripts/nora-adapters/st-worldbook-adapter.js';
import { readActivationSnapshot } from '../src/nora-world-core/activation-snapshot.js';
import { createStBackendMaterializer } from '../src/nora-world-core/st-backend-materializer.js';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { createWorldbookController } from '../../../native-extensions/nora-ui/worldbook-controller.js';

const revision = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');

test('imported Worldbook entries retain their edit buttons', () => {
    const book = { entries: { 0: { comment: 'Test rule', content: 'Original', constant: true } } };
    const character = { data: { extensions: { world: 'shared-book' }, character_book: book } };
    const controller = createWorldbookController({
        worldRuntime: { list: () => [{ active: true, worldbookName: '' }] },
        readState: () => ({ world: { metadata: {} } }), currentCharacter: () => character,
        characterField: () => '', store: { cachedWorldbook: () => book }, escapeHtml: String, icons: { edit: 'edit', plus: '+' },
    });
    assert.match(controller.summary(character, true), /data-worldbook-edit-kind="embedded"/);
});

test('edits isolate Worlds, preserve other fields and survive reopening', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-edit-isolation-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directories = Object.fromEntries(['characters', 'chats', 'worlds'].map(key => [key, path.join(root, key)]));
    const stagingRoot = path.join(root, 'staging');
    await Promise.all([...Object.values(directories), stagingRoot].map(dir => fs.mkdir(dir, { recursive: true })));
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: {
        name: 'Isolated test', first_mes: 'Opening', description: '', extensions: {},
        character_book: { name: 'Shared test book', entries: [
            { id: 0, keys: [], enabled: true, constant: false, content: 'Original', insertion_order: 71,
                extensions: { position: 4, depth: 7, custom: { preserve: true } } },
            { id: 1, keys: ['rain'], enabled: true, content: 'Second entry' },
        ] },
    } };
    const library = JSON.stringify(card);
    const libraryPath = path.join(root, 'library-card.json');
    await fs.writeFile(libraryPath, library);
    const makeMaterializer = () => createStBackendMaterializer({ directories, stagingRoot, cardCodec: {
        decode: async () => ({ card: structuredClone(card), runtimeCardBuffer: Buffer.from(library) }),
        encodeRuntimeCard: async ({ card }) => Buffer.from(JSON.stringify(card)),
    } });
    const coreRoot = path.join(root, 'core');
    const core = createNoraWorldCore({ root: coreRoot, materializer: makeMaterializer() });
    async function create(key) {
        const staged = path.join(stagingRoot, `${key}.png`);
        await fs.writeFile(staged, library);
        return (await core.createWorld({ name: key, persona: { name: 'Player', description: '' },
            source: { type: 'character-card', sha256: crypto.createHash('sha256').update(library).digest('hex'), original_name: 'test.png', format: 'png' },
            payload: { staged_card: { path: staged, format: 'png' } },
        }, { idempotencyKey: key })).world;
    }
    const a = await create('world-a');
    const b = await create('world-b');
    assert.equal(a.knowledge[0].binding.name, b.knowledge[0].binding.name);
    const sourceName = a.knowledge[0].binding.name;
    const readBook = async name => JSON.parse(await fs.readFile(path.join(directories.worlds, `${name}.json`), 'utf8'));
    const original = await readBook(sourceName);
    const cardsBefore = await Promise.all([a, b].map(w => fs.readFile(path.join(directories.characters, w.runtime_card.binding.avatar))));
    await assert.rejects(core.editWorldbookEntry(a.world_id, { name: sourceName, entry_id: '0', patch: { content: 'bad' }, expected_revision: 'stale' }), /changed/);
    const app = express();
    app.use(express.json());
    app.use('/api/nora-worlds-v2', createNoraWorldsV2Router({ resolveCore: () => core }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => nativeFetch(new URL(url, `http://127.0.0.1:${server.address().port}`), options);
    t.after(() => { globalThis.fetch = nativeFetch; });
    const cache = new Map();
    const browserRuntime = {
        chatMetadata: { nora_world: { id: a.world_id }, world_info: sourceName },
        characters: [{ data: { extensions: { world: sourceName } } }], characterId: 0,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        loadWorldInfo: async () => structuredClone(original),
        primeWorldInfoSnapshot: (name, book) => cache.set(name, book), updateWorldInfoList: async () => {},
    };
    const adapter = createStWorldbookAdapter(() => browserRuntime);
    const loaded = await adapter.loadWorldbook(sourceName);
    const edited = await adapter.saveWorldbookEntry(sourceName, loaded, '0', { content: 'Only A changed' }, a.world_id);
    assert.notEqual(edited.resource.binding.name, sourceName);
    assert.equal(edited.resource.ownership, 'owned');
    assert.equal(browserRuntime.characters[0].data.extensions.world, edited.resource.binding.name);
    assert.equal(browserRuntime.chatMetadata.world_info, edited.resource.binding.name);
    assert.equal(cache.get(edited.resource.binding.name).entries['0'].content, 'Only A changed');
    const expected = structuredClone(original);
    expected.entries['0'].content = 'Only A changed';
    assert.deepEqual(edited.book, expected, 'Only the edited content changes, including empty-key trigger semantics');
    assert.deepEqual(await readBook(sourceName), original, 'Shared original unchanged');
    assert.deepEqual(await core.getWorld(b.world_id), b, 'Other World manifest unchanged');
    assert.equal(await fs.readFile(libraryPath, 'utf8'), library, 'Library source unchanged');
    for (const [index, world] of [a, b].entries()) assert.deepEqual(await fs.readFile(path.join(directories.characters, world.runtime_card.binding.avatar)), cardsBefore[index]);
    await assert.rejects(core.editWorldbookEntry(b.world_id, { name: edited.resource.binding.name, entry_id: '0', patch: { content: 'cross-world' }, expected_revision: revision(edited.book) }), /does not belong/);
    const reopenedCore = createNoraWorldCore({ root: coreRoot, materializer: makeMaterializer() });
    const reopened = await reopenedCore.getWorld(a.world_id);
    assert.equal(reopened.knowledge[0].binding.name, edited.resource.binding.name);
    assert.equal((await readBook(reopened.knowledge[0].binding.name)).entries['0'].content, 'Only A changed');
    const plan = await reopenedCore.prepareOpen(a.world_id);
    assert.equal(plan.knowledge[0].binding.name, edited.resource.binding.name, 'Activation selects the private edited Worldbook');
    const chatBefore = { header: { chat_metadata: { world_info: sourceName } }, messages: [] };
    const projected = await readActivationSnapshot(plan, directories, { revision: 'fixture', readers: {
        character: async () => JSON.parse(cardsBefore[0].toString()),
        chat: async () => chatBefore,
        worldbook: async (_directories, name) => readBook(name),
    } });
    assert.equal(projected.snapshot.chat.header.chat_metadata.world_info, edited.resource.binding.name, 'Chat also selects the edited book, preventing duplicate old rules');
    assert.equal(chatBefore.header.chat_metadata.world_info, sourceName, 'Projection does not modify persisted chat data');
    const second = await reopenedCore.editWorldbookEntry(a.world_id, { name: edited.resource.binding.name, entry_id: '1', patch: { content: 'Second edit' }, expected_revision: revision(edited.book) });
    assert.equal(second.resource.binding.name, edited.resource.binding.name, 'Reuse the current World private copy');
    assert.equal(second.book.entries['0'].content, 'Only A changed');
    assert.equal(second.book.entries['1'].content, 'Second edit');
    await assert.rejects(reopenedCore.editWorldbookEntry(a.world_id, { name: edited.resource.binding.name, entry_id: '1', patch: { content: 'stale overwrite' }, expected_revision: revision(edited.book) }), /changed/);
    assert.equal((await fs.readdir(directories.worlds)).length, 2, 'No copies created by subsequent or rejected edits');
    if (reopenedCore.addWorldSetting) {
        const added = await reopenedCore.addWorldSetting(b.world_id, { type: 'constant', title: 'New', content: 'New setting', keys: [] }, { expectedRevision: b.revision, idempotencyKey: 'own-setting' });
        const ownEdit = await reopenedCore.editWorldbookEntry(b.world_id, { name: added.resource.binding.name, entry_id: added.entry_id, patch: { content: 'Edited own setting' }, expected_revision: revision(added.book) });
        const addedAgain = await reopenedCore.addWorldSetting(b.world_id, { type: 'constant', title: 'Another', content: 'Another setting', keys: [] }, { expectedRevision: ownEdit.world.revision, idempotencyKey: 'another-setting' });
        assert.equal(addedAgain.book.entries[added.entry_id].content, 'Edited own setting', 'Adding settings after editing preserves the edit');
    }
});
