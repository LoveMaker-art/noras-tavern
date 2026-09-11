import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import vm from 'node:vm';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { createStBackendMaterializer } from '../src/nora-world-core/st-backend-materializer.js';
import { createNoraWorldsV2Router } from '../src/endpoints/nora-worlds-v2.js';
import { readActivationSnapshot } from '../src/nora-world-core/activation-snapshot.js';
import { createStPresetAdapter } from '../public/scripts/nora-adapters/st-preset-adapter.js';

test('library HTTP imports isolate books, atomically add roles, reject races and preserve original entries', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-library-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directories = Object.fromEntries(['characters', 'chats', 'worlds'].map(key => [key, path.join(root, key)]));
    const stagingRoot = path.join(root, 'staging');
    for (const dir of [...Object.values(directories), stagingRoot]) await fs.mkdir(dir);
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Original', description: 'Role', first_mes: 'Opening', extensions: {},
        character_book: { name: 'Original book', entries: [{ id: 7, keys: ['rain'], content: 'Disabled content', enabled: false,
            extensions: { depth: 7, sticky: 4, position: 4, custom: { keep: true } } }] } } };
    const bytes = Buffer.from(JSON.stringify(card));
    const codec = { decode: async ({ buffer }) => ({ card: JSON.parse(buffer), runtimeCardBuffer: buffer }),
        encodeRuntimeCard: async ({ card }) => Buffer.from(JSON.stringify(card)) };
    const base = createStBackendMaterializer({ directories, stagingRoot, cardCodec: codec });
    let race = false;
    const core = createNoraWorldCore({ root: path.join(root, 'core'), materializer: { ...base,
        async prepareLibraryWorldbook(world, input) {
            const result = await base.prepareLibraryWorldbook(world, input);
            if (race) await core.updateWorld(world.world_id, { name: 'Concurrent edit' }, { expectedRevision: world.revision });
            return result;
        },
    } });
    async function create(key) {
        const staged = path.join(stagingRoot, `${key}.png`);
        await fs.writeFile(staged, bytes);
        return (await core.createWorld({ name: key, persona: { name: 'Player', description: '' },
            source: { type: 'character-card', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), original_name: 'card.png', format: 'png' },
            payload: { staged_card: { path: staged, format: 'png' } } }, { idempotencyKey: key })).world;
    }
    const a = await create('a'); const b = await create('b');
    await fs.writeFile(path.join(directories.characters, 'source.png'), bytes);
    const app = express(); app.use(express.json());
    app.use('/api', createNoraWorldsV2Router({ resolveCore: () => core }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const request = async (route, body) => {
        const result = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, { method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: result.status, data: await result.json() };
    };
    const catalog = await request('/library/worldbooks');
    assert.equal(catalog.status, 200);
    assert.ok(catalog.data.items.some(item => item.source.name === 'source.png'));
    const preview = (await request('/library/worldbooks/read', { source: { kind: 'card', name: 'source.png' } })).data;
    assert.equal(preview.source_name, card.data?.name || card.name);
    assert.equal((await request('/library/worldbooks/read', { source: { name: 'source.png', kind: 'card', ignored: 'metadata' } })).data.source_key, preview.source_key);
    assert.equal(catalog.data.items.find(item => item.source.name === 'source.png').source_key, preview.source_key);
    assert.equal(preview.book.entries['7'].disable, true);
    assert.equal(preview.book.entries['7'].depth, 7);
    const input = { source: preview.source, source_revision: preview.revision, expected_revision: a.revision,
        character: { id: 'imported-role', operation: 'create', patch: { name: 'Alice', description: 'Independent' } } };
    const bad = await request(`/worlds/${a.world_id}/library`, { ...input, source_revision: 'stale' });
    assert.equal(bad.status, 409);
    assert.deepEqual(await core.getWorld(a.world_id), a, 'No half-added role after a bad book');
    const result = await request(`/worlds/${a.world_id}/library`, input);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const world = result.data.world;
    assert.equal(world.story_context.characters.at(-1).profile.identity.name, 'Alice');
    const owned = world.knowledge.at(-1);
    assert.equal(owned.source_key, preview.source_key);
    assert.equal(owned.ownership, 'owned');
    const book = JSON.parse(await fs.readFile(path.join(directories.worlds, `${owned.binding.name}.json`)));
    assert.deepEqual(book.entries, preview.book.entries);
    assert.deepEqual(await core.getWorld(b.world_id), b);
    assert.deepEqual(await fs.readFile(path.join(directories.characters, 'source.png')), bytes);
    assert.equal((await request(`/worlds/${a.world_id}/library`, input)).status, 409, 'Stale retries cannot duplicate a role');
    const repeated = await request(`/worlds/${a.world_id}/library`, { source: preview.source, source_revision: preview.revision, expected_revision: world.revision });
    assert.equal(repeated.data.world.knowledge.length, world.knowledge.length, 'Explicit reattach reuses the existing binding');
    const plan = await core.prepareOpen(a.world_id);
    const projected = await readActivationSnapshot(plan, directories, { revision: 'test', readers: {
        character: async () => ({ ...card, avatar: a.runtime_card.binding.avatar }),
        chat: async () => ({ header: { chat_metadata: {} }, messages: [] }),
        worldbook: async (_dirs, name) => JSON.parse(await fs.readFile(path.join(directories.worlds, `${name}.json`))),
    } });
    assert.equal(projected.snapshot.chat.header.chat_metadata.nora_world.library_worldbooks[0].name, owned.binding.name);
    assert.ok(!(await core.listLibraryWorldbooks()).items.some(item => item.source.name === owned.binding.name), 'Runtime copies stay out of the library');
    for (const name of ['../secret', 'x/../../secret', '..\\secret']) {
        assert.equal((await request('/library/worldbooks/read', { source: { kind: 'book', name } })).status, 400);
    }
    await fs.symlink(path.join(directories.characters, 'source.png'), path.join(directories.characters, 'link.png'));
    assert.equal((await request('/library/worldbooks/read', { source: { kind: 'card', name: 'link.png' } })).status, 400);
    const filesBefore = await fs.readdir(directories.worlds);
    race = true;
    const conflict = await request(`/worlds/${b.world_id}/library`, { ...input, expected_revision: b.revision });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await fs.readdir(directories.worlds), filesBefore, 'Uncommitted copy is cleaned on revision conflict');
    assert.equal((await core.getWorld(b.world_id)).story_context?.characters.length || 0, 0);
    race = false;
    const profileInput = { kind: 'character', name: 'Independent profile', data: { name: 'Reusable role', description: 'Original profile',
        personality: '', activation: { mode: 'triggered', enabled: false, keys: ['rain'], cooldown: 2 } } };
    const savedProfile = await request('/library/profiles/save', profileInput);
    assert.equal(savedProfile.status, 200);
    assert.equal((await request('/library/profiles/save', profileInput)).data.reused, true);
    const profile = (await request('/library/profiles/read', { id: savedProfile.data.item.id })).data;
    for (const original of [a, b]) {
        const current = await core.getWorld(original.world_id);
        const applied = await request(`/worlds/${current.world_id}/library`, { expected_revision: current.revision,
            character: { id: `role-${current.world_id}`, operation: 'create', patch: profile.data } });
        assert.equal(applied.status, 200);
        assert.equal(applied.data.world.story_context.characters.at(-1).activation.enabled, false);
    }
    const currentA = await core.getWorld(a.world_id);
    const currentB = await core.getWorld(b.world_id);
    await core.updateWorld(a.world_id, { character: { id: `role-${a.world_id}`, patch: { description: 'A only' } } }, { expectedRevision: currentA.revision });
    assert.deepEqual(await core.getWorld(b.world_id), currentB);
    assert.equal((await request('/library/profiles/read', { id: profile.id })).data.data.description, 'Original profile');
    assert.equal((await request('/library/profiles/delete', { id: profile.id, revision: profile.revision })).status, 200);
    assert.deepEqual(await core.getWorld(b.world_id), currentB, 'Deleting a template leaves copies intact');
    const retryBook = await request('/library/worldbooks/import', { name: 'Saved independent book', book: preview.book });
    const againBook = await request('/library/worldbooks/import', { name: 'Saved independent book', book: preview.book });
    assert.deepEqual(againBook.data.source, retryBook.data.source);
    assert.equal(againBook.data.reused, true);
    const changedBook = structuredClone(preview.book); changedBook.entries['7'].content = 'Different';
    assert.equal((await request('/library/worldbooks/import', { name: 'Saved independent book', book: changedBook })).status, 400);
    const latestA = await core.getWorld(a.world_id);
    const badReference = await request(`/worlds/${a.world_id}/library`, { expected_revision: latestA.revision,
        character: { id: 'broken-ref', operation: 'create', patch: { name: 'Broken', description: '{{char::nonexistent}}' } } });
    assert.equal(badReference.status, 400);
    assert.deepEqual(await core.getWorld(a.world_id), latestA);
});

test('preset import does not apply; explicit apply keeps connections and filters unapproved scripts before events', async () => {
    const values = []; const names = {}; const selected = []; const saved = [];
    const settings = { bind_preset_to_connection: true, custom_url: 'unchanged', preset_settings_openai: '' };
    const manager = { getAllPresets: () => Object.keys(names), getSelectedPresetName: () => settings.preset_settings_openai,
        getPresetList: () => ({ presets: values, preset_names: names }), findPreset: name => names[name],
        savePreset: async (...args) => saved.push(args),
        selectPreset: async index => { selected.push(structuredClone(values[index])); assert.equal(settings.bind_preset_to_connection, false); settings.preset_settings_openai = Object.keys(names)[index]; } };
    const adapter = createStPresetAdapter(() => ({ getPresetManager: () => manager, chatCompletionSettings: settings }));
    const preset = { prompts: [{ identifier: 'main', content: 'Story instructions' }], prompt_order: [{ character_id: 100001, order: [] }],
        extensions: { tavern_helper: { scripts: [{ content: 'unsafe' }] }, custom: { preserved: true } }, custom_url: 'different' };
    await adapter.importPreset('Test preset', preset);
    assert.equal(saved[0][2].skipUpdate, true); assert.equal(selected.length, 0);
    assert.deepEqual(adapter.listPresets().items[0].preset, preset);
    await adapter.applyPreset('Test preset');
    assert.equal(selected[0].extensions.tavern_helper, undefined);
    assert.deepEqual(selected[0].extensions.custom, { preserved: true });
    assert.deepEqual(values[0], preset, 'Original stored preset remains intact');
    assert.equal(settings.bind_preset_to_connection, true); assert.equal(settings.custom_url, 'unchanged');
    await adapter.applyPreset('Test preset', { enableScripts: true });
    assert.deepEqual(selected[1].extensions.tavern_helper, preset.extensions.tavern_helper);
    await assert.rejects(adapter.importPreset('Test preset', preset), /同名/);
    await assert.rejects(adapter.importPreset('Bad', { description: 'A card, not a preset' }), /prompts/);
    await assert.rejects(adapter.importPreset('__proto__', preset), /有效/);
    manager.selectPreset = async () => { throw new Error('failure'); };
    await assert.rejects(adapter.applyPreset('Test preset'), /failure/);
    assert.deepEqual(values[0], preset); assert.equal(settings.bind_preset_to_connection, true);
});

test('actual ST lore collector includes library copies once and drops them when switching worlds', async () => {
    const source = await fs.readFile(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function getCharacterLore()');
    const collector = source.slice(start, source.indexOf('\n}', start) + 2);
    const metadata = { nora_world: { id: 'world:a', library_worldbooks: [{ name: 'added' }, { name: 'added' }, { name: 'base' }] } };
    const sandbox = { chat_metadata: metadata, characters: [{ data: { extensions: { world: 'base' } } }], this_chid: 0,
        selected_world_info: [], world_info: {}, power_user: {}, METADATA_KEY: 'world_info', getCharaFilename: () => 'card',
        resolveWorldbookName: name => name, console: { debug() {} },
        loadWorldInfo: async name => ({ entries: { 0: { uid: 0, content: name } } }) };
    const first = await vm.runInNewContext(`${collector}; getCharacterLore()`, sandbox);
    assert.deepEqual(Array.from(first, entry => entry.content), ['base', 'added']);
    metadata.nora_world = { id: 'world:b', library_worldbooks: [] };
    const second = await vm.runInNewContext(`${collector}; getCharacterLore()`, sandbox);
    assert.deepEqual(Array.from(second, entry => entry.content), ['base']);
});
