import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editPreset } from '../public/scripts/nora-worlds/preset-edit.js';
import { createWorldPreset } from '../public/scripts/nora-worlds/world-preset.js';
import { readPresetTemplate, savePresetTemplate, listPresetTemplates, importPresetTemplate } from '../src/nora-preset-library.js';
import { PRESET_MAX_BYTES } from '../public/scripts/nora-worlds/preset-file.js';
import { createRuntimeControls } from '../public/scripts/nora-controls/runtime.js';
import { validateControl } from '../public/scripts/nora-controls/contract.js';

const base = () => ({ temperature: 0.8, top_p: 1, openai_max_context: 8192, openai_max_tokens: 1024,
    custom_url: 'private-connection', extensions: { tavern_helper: { scripts: ['not-executed'] } },
    prompts: [{ identifier: 'main', role: 'system', content: 'Original', system_prompt: true },
        { identifier: 'chatHistory', marker: true }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
});
const change = content => ({ prompts: [{ operation: 'update', id: 'main', patch: { content } }] });
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-preset-controls-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'Base.json'), JSON.stringify(base()));
    return directory;
}

test('targeted edits preserve native metadata and allow create/order/delete of ordinary prompts', () => {
    const original = base();
    const value = editPreset(original, { prompts: [{ operation: 'create', id: 'style', patch: { content: 'Short', role: 'system' } }],
        order: [{ identifier: 'style', enabled: true }, ...original.prompt_order[0].order], parameters: { temperature: 0.5 } });
    assert.deepEqual(value.extensions, original.extensions);
    assert.equal(value.custom_url, original.custom_url);
    assert.equal(value.prompts.at(-1).content, 'Short');
    assert.equal(original.prompts.length, 2);
    const deleted = editPreset(value, { prompts: [{ operation: 'delete', id: 'style' }] });
    assert.equal(deleted.prompts.length, 2);
    assert.equal(deleted.prompt_order[0].order.length, 2);
});

test('reject protected slots, ambiguous IDs, unknown fields, invalid roles/order/parameters', () => {
    for (const edits of [
        { prompts: [{ operation: 'delete', id: 'chatHistory' }] },
        { prompts: [{ operation: 'update', id: 'chatHistory', patch: { content: 'lost history' } }] },
        { prompts: [{ operation: 'create', id: 'main', patch: { content: 'duplicate' } }] },
        { prompts: [{ operation: 'update', id: 'main', patch: { role: 'tool' } }] },
        { prompts: [{ operation: 'update', id: 'main', patch: { marker: true } }] },
        { order: [{ identifier: 'main', enabled: true }] },
        { order: [{ identifier: 'chatHistory', enabled: false }] },
        { order: [...base().prompt_order[0].order, { identifier: 'missing', enabled: true }] },
        { parameters: { custom_url: 'changed' } }, { parameters: { temperature: 5 } },
        { parameters: { openai_max_tokens: 8192 } }, { prompts: null },
    ]) assert.throws(() => editPreset(base(), edits));
});

test('real library files use conditional writes, preserve extensions, reject duplicate names and unsafe paths', t => {
    const dir = fixture(t);
    const source = readPresetTemplate(dir, 'Base');
    assert.equal(source.preset.custom_url, undefined);
    assert.equal(source.preset.extensions, undefined);
    const created = savePresetTemplate(dir, { mode: 'create', name: 'New', source: { name: 'Base', revision: source.revision }, edits: change('New') });
    assert.deepEqual(created.storedPreset.extensions, base().extensions);
    assert.equal(readPresetTemplate(dir, 'Base').revision, source.revision);
    assert.throws(() => savePresetTemplate(dir, { mode: 'create', name: 'New', preset: base() }), { code: 'NORA_PRESET_CONFLICT' });
    savePresetTemplate(dir, { mode: 'edit', name: 'New', expectedRevision: created.revision, edits: change('Edited') });
    assert.throws(() => savePresetTemplate(dir, { mode: 'edit', name: 'New', expectedRevision: created.revision, edits: change('Stale') }), { code: 'NORA_PRESET_STALE' });
    for (const name of ['../bad', 'CON', 'bad ', '__proto__']) assert.throws(() => readPresetTemplate(dir, name));
    assert.deepEqual(listPresetTemplates(dir).sort(), ['Base', 'New']);
});

function live(t, opened = true) {
    const directory = fixture(t);
    let plan = { world_id: 'world-a', world_revision: 1, preset: createWorldPreset('Base', base()) };
    let busy = false;
    const presets = [base()], names = { Base: 0 }, calls = [];
    let beforeRead = () => {};
    const context = { chatMetadata: { nora_world: { id: opened ? 'world-a' : '' }, nora_session: { id: opened ? 'session-a' : '' } },
        characters: [{ avatar: 'a.png' }], characterId: 0, isGenerating: () => busy,
        getRequestHeaders: () => ({}), getPresetManager: () => ({ getPresetList: () => ({ presets, preset_names: names }) }) };
    const story = { model: {}, settings: { uiSettings: () => ({}) }, worlds: {
        updateActive: async (patch, { expectedRevision }) => {
            assert.equal(expectedRevision, plan.world_revision);
            calls.push('world-write');
            plan = { ...plan, preset: structuredClone(patch.preset), world_revision: plan.world_revision + 1 };
            return { saved: true, runtimeApplied: true, world: structuredClone(plan) };
        },
    } };
    const runtime = createRuntimeControls({ getContext: () => context, story, assertIdle: () => { if (busy) throw new Error('busy'); },
        dispatch: () => ({ execute: async ({ run }) => ({ status: 'completed', value: await run() }) }),
        fetcher: async (url, options) => {
            const body = options.body ? JSON.parse(options.body) : {};
            let result;
            if (url.endsWith('/open-plan')) result = { plan: structuredClone(plan) };
            else if (url.endsWith('/nora-list')) result = { names: listPresetTemplates(directory) };
            else if (url.endsWith('/nora-read')) { beforeRead(); result = readPresetTemplate(directory, body.name); }
            else if (url.endsWith('/nora-save')) { calls.push('library-write'); result = savePresetTemplate(directory, body); }
            else throw new Error(url);
            return { ok: true, json: async () => result };
        },
    });
    const execute = (action, params = {}) => runtime.execute({ action, params, confirm: true, clientId: 'test-client',
        worldId: context.chatMetadata.nora_world.id, sessionId: context.chatMetadata.nora_session.id, idempotencyKey: action });
    return { execute, directory, calls, presets, context, busy: value => { busy = value; }, beforeRead: callback => { beforeRead = callback; } };
}

test('live controls create/read/edit library without an open World or leaking opaque fields', async t => {
    const f = live(t, false);
    const source = await f.execute('preset.inspect', { scope: 'library', name: 'Base' });
    assert.equal(source.storedPreset, undefined);
    const result = await f.execute('preset.create', { name: 'New', source: { name: 'Base', revision: source.revision }, edits: change('New') });
    assert.equal(result.runtimeApplied, false);
    assert.equal(result.storedPreset, undefined);
    await f.execute('preset.edit', { scope: 'library', name: 'New', expectedRevision: result.revision, edits: change('Updated') });
    assert.equal(f.presets[1].prompts[0].content, 'Updated');
    assert.deepEqual(f.presets[1].extensions, base().extensions);
    assert.equal(f.calls.includes('world-write'), false);
});

test('world edit, apply and save-as preserve library originals and copy only safe fields', async t => {
    const f = live(t);
    const original = readPresetTemplate(f.directory, 'Base');
    const world = await f.execute('preset.inspect', { scope: 'world', name: '' });
    await f.execute('preset.edit', { scope: 'world', name: '', expectedRevision: world.revision, edits: change('World-only') });
    const edited = await f.execute('preset.inspect', { scope: 'world', name: '' });
    assert.equal(edited.preset.prompts[0].content, 'World-only');
    assert.equal(readPresetTemplate(f.directory, 'Base').revision, original.revision);
    const saved = await f.execute('preset.save-as', { name: 'World copy', expectedRevision: edited.revision });
    assert.equal(saved.worldUnchanged, true);
    assert.equal(saved.preset.extensions, undefined);
    const applied = await f.execute('preset.apply', { name: 'Base', sourceRevision: original.revision, expectedRevision: edited.revision });
    assert.equal(applied.runtimeApplied, true);
    assert.equal(applied.world.preset.preset.prompts[0].content, 'Original');
    assert.equal(applied.world.preset.preset.custom_url, undefined);
});

test('stale and busy operations fail before writes; reads remain allowed', async t => {
    const f = live(t);
    await assert.rejects(f.execute('preset.edit', { scope: 'world', name: '', expectedRevision: '0', edits: change('Wrong') }));
    await assert.rejects(f.execute('preset.apply', { name: 'Base', sourceRevision: 'stale', expectedRevision: '1' }));
    f.busy(true);
    await assert.rejects(f.execute('preset.save-as', { name: 'Not saved', expectedRevision: '1' }));
    assert((await f.execute('preset.list')).names.includes('Base'));
    assert.deepEqual(f.calls, []);
});

test('large imports inspect and apply without overflowing receipts; incompatible parameters fail before a World write', async t => {
    const f = live(t), value = base();
    value.prompts[0].content = 'x'.repeat(2200000);
    importPresetTemplate(f.directory, { name: 'Large', json: JSON.stringify(value) });
    const source = await f.execute('preset.inspect', { scope: 'library', name: 'Large' });
    assert.equal(source.contentOmitted, true);
    assert.equal(source.promptCount, 2);
    assert.equal(source.preset, undefined);
    assert.equal(JSON.stringify(source).length < 512000, true);
    const result = await f.execute('preset.apply', { name: 'Large', sourceRevision: source.revision, expectedRevision: '1' });
    assert.equal(result.saved, true);
    assert.equal(result.contentOmitted, true);
    assert.equal(JSON.stringify(result).length < 512000, true);
    const world = await f.execute('preset.inspect', { scope: 'world', name: '' });
    assert.equal(world.contentOmitted, true);
    value.openai_max_context = 2000000;
    const invalid = importPresetTemplate(f.directory, { name: 'Unsupported', json: JSON.stringify(value) });
    const before = f.calls.length;
    await assert.rejects(f.execute('preset.apply', { name: 'Unsupported', sourceRevision: invalid.revision, expectedRevision: world.revision }), { code: 'NORA_PRESET_PARAMETERS_INVALID' });
    assert.equal(f.calls.length, before);
});

test('catalog rejects writes through read tools and requires confirmation', () => {
    assert.throws(() => validateControl({ action: 'preset.save-as', params: { name: 'x', expectedRevision: '1' }, confirm: true }, { readOnly: true }));
    assert.throws(() => validateControl({ action: 'preset.create', params: {} }));
});

test('switching World during source lookup cannot apply to the new World', async t => {
    const f = live(t);
    const source = readPresetTemplate(f.directory, 'Base');
    f.beforeRead(() => { f.context.chatMetadata.nora_world.id = 'world-b'; });
    await assert.rejects(f.execute('preset.apply', { name: 'Base', sourceRevision: source.revision, expectedRevision: '1' }));
    assert.deepEqual(f.calls, []);
});

test('switching only the session during lookup also rejects the old target', async t => {
    const f = live(t);
    const source = readPresetTemplate(f.directory, 'Base');
    f.beforeRead(() => { f.context.chatMetadata.nora_session.id = 'session-b'; });
    await assert.rejects(f.execute('preset.apply', { name: 'Base', sourceRevision: source.revision, expectedRevision: '1' }));
    assert.deepEqual(f.calls, []);
});

test('HTTP preset routes persist, read back, reject stale overwrites and preserve user isolation', async t => {
    const { default: express } = await import('express');
    const directory = fixture(t), other = fixture(t);
    const config = path.join(directory, 'config.yaml');
    fs.writeFileSync(config, '{}');
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(config);
    const { router } = await import('../src/endpoints/presets.js');
    const app = express();
    app.use(express.json({ limit: '30mb' }));
    app.use((req, _res, next) => { req.user = { directories: { openAI_Settings: directory } }; next(); });
    app.use('/api/presets', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const post = async (route, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/presets/${route}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
    };
    const source = (await post('nora-read', { name: 'Base' })).data;
    const result = await post('nora-save', { mode: 'edit', name: 'Base', expectedRevision: source.revision, edits: change('HTTP edit') });
    assert.equal(result.status, 200);
    assert.equal((await post('nora-read', { name: 'Base' })).data.preset.prompts[0].content, 'HTTP edit');
    assert.equal((await post('nora-save', { mode: 'edit', name: 'Base', expectedRevision: source.revision, edits: change('lost update') })).status, 409);
    assert.equal(readPresetTemplate(other, 'Base').preset.prompts[0].content, 'Original');
    const large = base();
    large.prompts[0].content = '字'.repeat(800000);
    const imported = await post('nora-import', { name: 'Large', json: JSON.stringify(large) });
    assert.equal(imported.status, 200);
    assert.equal(imported.data.saved, true);
    assert.equal((await post('nora-read', { name: 'Large' })).data.storedPreset.prompts[0].content, large.prompts[0].content);
    assert.equal((await post('nora-import', { name: 'Large', json: JSON.stringify(base()) })).status, 409);
    assert.equal((await post('nora-import', { name: 'Over', json: ' '.repeat(PRESET_MAX_BYTES + 1) })).status, 413);
});

test('JSON import preserves all fields and raw bytes, reuses identical retries, and only warns on model parameter limits', t => {
    const dir = fixture(t), value = base();
    value.openai_max_context = 2000000;
    value.prompts[0].content = '中文'.repeat(400000);
    const json = JSON.stringify(value, null, 2);
    const result = importPresetTemplate(dir, { name: 'Authored', json });
    assert.equal(result.canApply, false);
    assert.equal(result.warnings[0].code, 'NORA_PRESET_PARAMETERS_INVALID');
    assert.equal(result.runtimeApplied, false);
    assert.equal(result.worldUnchanged, true);
    assert.equal(fs.readFileSync(path.join(dir, 'Authored.json'), 'utf8'), json);
    assert.deepEqual(readPresetTemplate(dir, 'Authored').storedPreset, value);
    assert.equal(importPresetTemplate(dir, { name: 'Authored', json }).reused, true);
    assert.throws(() => importPresetTemplate(dir, { name: 'Authored', json: JSON.stringify(base()) }), { code: 'NORA_PRESET_CONFLICT' });
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
});

test('10 MB boundary uses UTF-8 bytes and large saved presets remain editable without pretty-print expansion failures', t => {
    const dir = fixture(t), value = base();
    value.prompts[0].content = '';
    const overhead = Buffer.byteLength(JSON.stringify(value));
    value.prompts[0].content = 'a'.repeat(PRESET_MAX_BYTES - overhead);
    const json = JSON.stringify(value);
    assert.equal(Buffer.byteLength(json), PRESET_MAX_BYTES);
    importPresetTemplate(dir, { name: 'Boundary', json });
    const source = readPresetTemplate(dir, 'Boundary');
    savePresetTemplate(dir, { mode: 'edit', name: 'Boundary', expectedRevision: source.revision, edits: {} });
    assert.equal(fs.statSync(path.join(dir, 'Boundary.json')).size, PRESET_MAX_BYTES);
    assert.throws(() => importPresetTemplate(dir, { name: 'Over', json: json + ' ' }), { code: 'NORA_PRESET_TOO_LARGE' });
    assert.equal(fs.existsSync(path.join(dir, 'Over.json')), false);
    for (const bad of ['{', '[]', JSON.stringify({ prompts: [], prompt_order: [] })]) {
        assert.throws(() => importPresetTemplate(dir, { name: 'Invalid', json: bad }), { code: 'NORA_PRESET_INVALID' });
    }
    assert.throws(() => importPresetTemplate(dir, { name: '../escape', json }), { code: 'NORA_PRESET_INVALID' });
});

test('source revisions and symlinks are checked before creating templates', t => {
    const dir = fixture(t);
    const original = readPresetTemplate(dir, 'Base');
    savePresetTemplate(dir, { mode: 'edit', name: 'Base', expectedRevision: original.revision, edits: change('new source') });
    assert.throws(() => savePresetTemplate(dir, { mode: 'create', name: 'Nope', source: { name: 'Base', revision: original.revision }, edits: {} }), { code: 'NORA_PRESET_STALE' });
    assert.equal(fs.existsSync(path.join(dir, 'Nope.json')), false);
    fs.symlinkSync(path.join(dir, 'Base.json'), path.join(dir, 'Link.json'));
    assert.throws(() => readPresetTemplate(dir, 'Link'), { code: 'NORA_PRESET_INVALID' });
});
