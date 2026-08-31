import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { createWorldCoreRuntime } from '../public/scripts/nora-worlds/world-core-runtime.js';
import { createRuntimeControls } from '../public/scripts/nora-controls/runtime.js';
import { createModelProfiles } from '../public/scripts/nora-adapters/model-profiles.js';
import { createStWorldbookAdapter } from '../public/scripts/nora-adapters/st-worldbook-adapter.js';
import { contentRevision } from '../public/scripts/nora-controls/revision.js';
import { router as bookRouter } from '../src/endpoints/worldinfo.js';
import { createNoraWorldsV2Router } from '../src/endpoints/nora-worlds-v2.js';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-panel-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const materializer = { async materialize(_command, context) { return {
        runtimeCard: { engine: 'sillytavern', binding: { avatar: `${context.worldId}.png` }, ownership: 'owned' },
        defaultSession: { engine: 'sillytavern', binding: { chat_id: 'chat' } },
        knowledge: [{ sourceKey: 'book', engine: 'sillytavern', binding: { name: 'fixture-book' }, ownership: 'owned' }],
        declaredCapabilities: [],
    }; } };
    const core = createNoraWorldCore({ root, materializer });
    const command = { name: 'First', persona: { name: 'Me', description: 'original' }, source: { type: 'manual', sha256: '', original_name: '', format: 'json' } };
    const { world } = await core.createWorld(command, { idempotencyKey: 'first' });
    return { root, core, world, materializer, command };
}

test('Persona edits survive reopening/restarting, preserve all resources, and reject stale or forged fields', async t => {
    const { root, core, world, materializer, command } = await fixture(t);
    const other = (await core.createWorld({ ...command, name: 'Other' }, { idempotencyKey: 'other' })).world;
    const updated = await core.updateWorld(world.world_id, { persona: { description: 'new persona' } }, { expectedRevision: world.revision });
    assert.equal(updated.persona.name, 'Me');
    assert.deepEqual(updated.knowledge, world.knowledge);
    assert.deepEqual(updated.sessions, world.sessions);
    assert.deepEqual(updated.runtime_card, world.runtime_card);
    assert.equal((await core.getWorld(other.world_id)).persona.description, 'original');
    const restarted = createNoraWorldCore({ root, materializer });
    assert.equal((await restarted.prepareOpen(world.world_id)).persona.description, 'new persona');
    await assert.rejects(core.updateWorld(world.world_id, { name: 'stale' }, { expectedRevision: world.revision }), { code: 'NORA_WORLD_REVISION_CONFLICT' });
    for (const patch of [{ runtime_card: {} }, { persona: { role: 'admin' } }, { name: '' }, {}]) {
        await assert.rejects(core.updateWorld(world.world_id, patch, { expectedRevision: updated.revision }), { code: 'NORA_WORLD_INVALID' });
    }
});

test('World update HTTP route passes the exact revision and maps stale writes to 409', async t => {
    const { core, world } = await fixture(t);
    const router = createNoraWorldsV2Router({ resolveCore: () => core });
    const route = router.stack.find(item => item.route?.path === '/worlds/:worldId' && item.route.methods.patch).route.stack[0].handle;
    let status = 200; let payload;
    const res = { status(value) { status = value; return this; }, json(value) { payload = value; return this; }, setHeader() {} };
    const req = { params: { worldId: world.world_id }, body: { patch: { persona: { name: 'New' } }, expected_revision: world.revision } };
    await route(req, res); assert.equal(payload.world.persona.name, 'New');
    await route(req, res); assert.equal(status, 409); assert.equal(payload.error.code, 'NORA_WORLD_REVISION_CONFLICT');
});

test('live World projection never applies the saved persona to a switched World', async t => {
    const { core, world } = await fixture(t);
    const state = { characters: [{ avatar: world.runtime_card.binding.avatar }], metadata: { nora_world: { id: world.world_id }, nora_session: { id: world.sessions.default_session_id } } };
    let projected = 0;
    const runtime = createWorldCoreRuntime({ read: () => state, savePersona: async () => projected++ }, {
        client: { list: () => core.listWorlds(), prepareSnapshot() {},
            updateWorld: async (id, patch, revision) => { const result = await core.updateWorld(id, patch, { expectedRevision: revision }); state.metadata.nora_world.id = 'another'; return result; } },
    });
    await runtime.refresh();
    const result = await runtime.updateActive({ persona: { name: 'Saved' } });
    assert.equal(result.saved, true); assert.equal(result.runtimeApplied, false); assert.equal(projected, 0);
    assert.equal((await core.getWorld(world.world_id)).persona.name, 'Saved');
});

function modelFixture() {
    const settings = { activeModel: 'custom', hermesModel: { base: 'https://example.invalid', provider: 'provider', model: 'flash', secretId: 'hidden' },
        modelProfiles: [{ id: 'custom', name: 'Custom', model: 'model', base: 'https://example.invalid', secretId: 'shared' },
            { id: 'other', name: 'Other', model: 'other', secretId: 'shared' }] };
    const calls = [];
    const model = { configureModel: async item => { calls.push(['select', item.id]); return { secretId: item.secretId }; },
        clearModelConfiguration: async () => calls.push(['clear']), deleteModelSecret: async id => calls.push(['secret-delete', id]) };
    return { settings, calls, model, api: createModelProfiles({ model, settings: () => settings, persist: async () => calls.push(['save']) }) };
}

test('UI/MCP shared model service selects Hermes, redacts credentials, refuses deleting it and preserves shared keys', async () => {
    const f = modelFixture();
    assert.equal(JSON.stringify(f.api.list()).includes('hidden'), false);
    assert.equal(JSON.stringify(f.api.list()).includes('example.invalid'), false);
    await f.api.select('hermes'); assert.equal(f.settings.activeModel, '');
    await assert.rejects(f.api.remove('hermes'), /cannot be deleted/);
    await f.api.remove('custom'); assert.equal(f.calls.some(item => item[0] === 'secret-delete'), false);
    assert.equal(f.api.list().find(item => item.id === 'hermes').active, true);
    await assert.rejects(f.api.select('missing'), /not found/);
});

test('two callers cannot switch models concurrently; persistence failures remain explicit', async () => {
    const f = modelFixture(); let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const first = createModelProfiles({ model: { ...f.model, configureModel: () => waiting }, settings: () => f.settings, persist: async () => {} });
    const pending = first.select('custom');
    await assert.rejects(f.api.select('hermes'), { code: 'NORA_CONTROL_BUSY' });
    release(); await pending;
    const failed = createModelProfiles({ model: f.model, settings: () => f.settings, persist: async () => { throw new Error('offline'); } });
    await assert.rejects(failed.select('hermes'), { code: 'NORA_MODEL_SAVE_UNCONFIRMED', runtimeApplied: true });
    assert.equal(f.settings.activeModel, '');
});

function panelFixture() {
    const models = modelFixture();
    const plan = { world_id: 'world:one', world_revision: 3, name: 'World', persona: { name: 'Me', description: '' },
        runtime_card: { binding: { avatar: 'runtime.png' }, ownership: 'owned' },
        knowledge: [{ binding: { name: 'world-book' }, ownership: 'owned', resource_id: 'book:one' }] };
    const context = { chatMetadata: { nora_world: { id: plan.world_id }, nora_session: { id: 'session:one' } },
        characters: [{ avatar: 'runtime.png', data: { scenario: 'original scenario' } }], characterId: 0,
        getRequestHeaders: () => ({}), saveSettingsStrict: async () => {}, extensionSettings: {} };
    let book = { entries: { 0: { comment: 'Time', content: 'clock', key: ['time'], constant: false, position: 4, extensions: { mvu: true } },
        1: { comment: 'Sibling', content: 'keep' } } };
    let savedRevision; let worldPatch;
    const story = { settings: { uiSettings: () => models.settings }, model: models.model, messages: { isGenerating: () => false },
        worlds: { refresh: async () => {}, updateActive: async (patch, options) => { worldPatch = { patch, options }; return { saved: true }; } },
        worldbook: { loadWorldbook: async () => structuredClone(book), saveWorldbook: async (_name, next, options) => { book = next; savedRevision = options.expectedRevision; },
            saveWorldScenario: async text => { context.chatMetadata.scenario = text.trim(); } } };
    const controls = createRuntimeControls({ getContext: () => context, story, assertIdle: () => {}, globalRef: {},
        fetcher: async () => ({ ok: true, json: async () => ({ plan }) }),
        dispatch: () => ({ execute: async input => ({ status: 'completed', value: await input.run() }) }) });
    const execute = (action, params = {}) => controls.execute({ action, params, confirm: true, worldId: plan.world_id, sessionId: 'session:one' });
    return { execute, context, plan, models, get book() { return book; }, get savedRevision() { return savedRevision; }, get worldPatch() { return worldPatch; } };
}

test('control actions edit World persona, real scenario override, and global model via existing services', async () => {
    const f = panelFixture(); const before = await f.execute('world.inspect');
    await f.execute('world.update', { patch: { persona: { name: 'Player' } }, expectedRevision: before.revision });
    assert.equal(f.worldPatch.options.expectedRevision, 3);
    await assert.rejects(f.execute('world.update', { patch: { name: 'X' }, expectedRevision: '2' }), { code: 'NORA_CONTROL_EDIT_STALE' });
    const scenario = await f.execute('scenario.inspect');
    await f.execute('scenario.update', { text: 'override', expectedRevision: scenario.revision });
    const updated = await f.execute('scenario.inspect'); assert.equal(updated.effective, 'override');
    await f.execute('scenario.update', { text: '', expectedRevision: updated.revision });
    assert.equal((await f.execute('scenario.inspect')).effective, 'original scenario');
    const models = await f.execute('models.list');
    await f.execute('models.select', { id: 'hermes', expectedRevision: models.revision });
    assert.equal(f.models.settings.activeModel, '');
    await assert.rejects(f.execute('models.delete', { id: 'custom', expectedRevision: models.revision }), { code: 'NORA_CONTROL_EDIT_STALE' });
});

test('runtime book entry writes preserve complex fields and siblings; reject shared resources, stale revisions and prototype patches', async () => {
    const f = panelFixture(); const before = await f.execute('worldbook.inspect', { name: 'world-book' });
    const params = { name: 'world-book', entryId: '0', expectedRevision: before.revision, patch: { content: 'changed', constant: true } };
    await f.execute('worldbook.update-entry', params);
    assert.equal(f.book.entries[0].content, 'changed'); assert.equal(f.book.entries[0].position, 4);
    assert.deepEqual(f.book.entries[0].extensions, { mvu: true }); assert.equal(f.book.entries[1].content, 'keep');
    assert.equal(f.savedRevision, before.revision);
    await assert.rejects(f.execute('worldbook.update-entry', params), { code: 'NORA_CONTROL_EDIT_STALE' });
    const current = await f.execute('worldbook.inspect', { name: 'world-book' });
    await assert.rejects(f.execute('worldbook.update-entry', { ...params, expectedRevision: current.revision, patch: JSON.parse('{"__proto__":{}}') }), { code: 'NORA_CONTROL_INVALID' });
    await assert.rejects(f.execute('worldbook.inspect', { name: 'unrelated-book' }), { code: 'NORA_CONTROL_RESOURCE_SCOPE' });
    f.plan.knowledge[0].ownership = 'shared';
    await assert.rejects(f.execute('worldbook.delete-entry', { name: 'world-book', entryId: '0', expectedRevision: current.revision }), { code: 'NORA_CONTROL_RESOURCE_SHARED' });
    f.plan.knowledge[0].ownership = 'owned';
    await f.execute('worldbook.delete-entry', { name: 'world-book', entryId: '0', expectedRevision: current.revision });
    assert.deepEqual(Object.keys(f.book.entries), ['1']);
});

test('ST worldbook endpoint atomically rejects an outdated Nora revision without losing a newer edit', async t => {
    const { root } = await fixture(t);
    const initial = { entries: { 0: { content: 'first' } } };
    await fs.writeFile(path.join(root, 'book.json'), JSON.stringify(initial));
    const edit = bookRouter.stack.find(item => item.route?.path === '/edit').route.stack[0].handle;
    let status = 200;
    const res = { status(value) { status = value; return this; }, send() { return this; }, json() { return this; } };
    const req = { user: { directories: { worlds: root } }, body: { name: 'book', data: { entries: { 0: { content: 'new' } } }, expected_revision: await contentRevision(initial) } };
    edit(req, res); assert.equal(status, 200);
    req.body.data = initial; edit(req, res); assert.equal(status, 409);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'book.json'))).entries[0].content, 'new');
});

test('Nora Worldbook adapter passes the original revision, not the edited data hash, and propagates save errors', async () => {
    let options; const original = { entries: { 0: { content: 'old' } } };
    const runtime = { loadWorldInfo: async () => structuredClone(original), saveWorldInfo: async (_name, _book, immediate, input) => { options = input; assert.equal(immediate, true); } };
    const api = createStWorldbookAdapter(() => runtime);
    const book = await api.loadWorldbook('book'); book.entries[0].content = 'edited';
    await api.saveWorldbook('book', book); assert.equal(options.expectedRevision, await contentRevision(original));
    runtime.saveWorldInfo = async () => { throw new Error('rejected'); };
    await assert.rejects(api.saveWorldbook('book', book), /rejected/);
});
