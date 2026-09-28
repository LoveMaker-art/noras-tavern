import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createWorldPreset, normalizeWorldPreset, WORLD_PRESET_FIELDS } from '../public/scripts/nora-worlds/world-preset.js';
import { worldPresetProjection } from '../public/scripts/nora-worlds/world-preset-projection.js';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { createStWorldAdapter } from '../public/scripts/nora-adapters/st-world-adapter.js';
import { createWorldCoreRuntime } from '../public/scripts/nora-worlds/world-core-runtime.js';

const definition = ts.createSourceFile('openai.js', await fs.readFile(new URL('../public/scripts/openai.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = definition.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(definition) === 'settingsToUpdate');
const fields = vm.runInNewContext('(' + declaration.initializer.getText(definition) + ')');

test('snapshot parameter whitelist uses native generation keys and excludes connection fields', () => {
    for (const field of WORLD_PRESET_FIELDS) {
        assert.ok(fields[field], field);
        assert.equal(fields[field][3], false, field);
    }
});

test('product bundle and native module identities share one live preset projection', async () => {
    const second = await import('../public/scripts/nora-worlds/world-preset-projection.js?native-module');
    assert.equal(second.worldPresetProjection, worldPresetProjection);
    let calls = 0;
    worldPresetProjection.bind('shared', () => calls++);
    second.worldPresetProjection.restore('shared');
    assert.equal(calls, 1);
    worldPresetProjection.clear();
});
const preset = (name, enabled, temperature = 0.5) => createWorldPreset(name, { temperature, top_p: 0.9, openai_max_context: 32768, openai_max_tokens: 2048,
    prompts: [{ identifier: 'a', content: name }, { identifier: 'b', content: 'optional' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled }] }] });

function contextFixture() {
    const base = preset('Default', true);
    const current = {
        characters: [], characterId: null, chatId: '', chatMetadata: {}, chat: [], powerUserSettings: {},
        selectCharacterById() {}, updateChatMetadata() {}, saveMetadata() {},
        chatCompletionSettings: { ...base.preset, temp_openai: 0.5, preset_settings_openai: 'Default', custom_url: 'original-url',
            custom_model: 'original-model', api_key: 'test-only', extensions: { existing: true } },
        chatCompletionPresetFields: fields,
        getChatCompletionPromptManager: () => ({ sanitizeServiceSettings() {} }),
        setExtensionPrompt() {}, setUserName() {}, async updatePersonaDescription() {},
        async activateNoraWorldSnapshot(id, snapshot) {
            this.characterId = id; this.chatId = snapshot.plan.session.binding.chat_id;
            this.chatMetadata = { nora_world: { id: snapshot.plan.world_id }, nora_session: { id: snapshot.plan.session.session_id } };
        },
    };
    return { current, runtime: createStWorldAdapter(() => current) };
}

test('snapshot removes connections, script extensions and foreign character orders; validates entries', () => {
    const original = preset('A', true);
    original.preset.custom_url = 'must-not-copy'; original.preset.proxy_password = 'must-not-copy';
    original.preset.extensions = { tavern_helper: { scripts: ['must-not-run'] } };
    original.preset.prompt_order.push({ character_id: 7, order: [] });
    const value = normalizeWorldPreset(original);
    assert.equal(value.preset.custom_url, undefined); assert.equal(value.preset.extensions, undefined);
    assert.equal(value.preset.prompt_order.length, 1);
    value.preset.prompts[0].content = 'different'; assert.equal(original.preset.prompts[0].content, 'A');
    for (const change of [v => { v.preset.prompts.push(v.preset.prompts[0]); }, v => { v.preset.prompt_order[0].order[0].enabled = 'false'; },
        v => { v.preset.prompt_order[0].order[0].identifier = 'missing'; }, v => { v.preset.temperature = {}; }]) {
        const invalid = preset('A', true); change(invalid); assert.throws(() => normalizeWorldPreset(invalid));
    }
});

test('native projection restores complete A/B copies and protects model credentials and scripts', () => {
    const { current, runtime } = contextFixture();
    const before = structuredClone(current.chatCompletionSettings);
    runtime.defaultWorldPreset();
    current.chatMetadata = { nora_world: { id: 'a' } };
    runtime.applyWorldPreset(preset('A', false, 0.2));
    assert.equal(current.chatCompletionSettings.temp_openai, 0.2);
    current.chatCompletionSettings.prompts[0].content = 'external override';
    worldPresetProjection.restore('a');
    assert.equal(current.chatCompletionSettings.prompts[0].content, 'A');
    current.chatMetadata.nora_world.id = 'b';
    assert.throws(() => worldPresetProjection.restore('b'), /预设尚未就绪/);
    runtime.applyWorldPreset(preset('B', true, 0.9));
    assert.equal(current.chatCompletionSettings.prompt_order[0].order[1].enabled, true);
    current.chatMetadata.nora_world.id = 'a'; runtime.applyWorldPreset(preset('A', false, 0.2));
    assert.equal(current.chatCompletionSettings.prompt_order[0].order[1].enabled, false);
    for (const key of ['custom_url', 'custom_model', 'api_key', 'extensions']) assert.deepEqual(current.chatCompletionSettings[key], before[key]);
    worldPresetProjection.clear();
});

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-world-preset-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const materializer = { async materialize(_command, { worldId }) { return {
        runtimeCard: { engine: 'sillytavern', binding: { avatar: `${worldId}.png` }, ownership: 'owned' },
        defaultSession: { engine: 'sillytavern', binding: { avatar: `${worldId}.png`, chat_id: 'chat' } }, knowledge: [], declaredCapabilities: [],
    }; } };
    const core = createNoraWorldCore({ root, materializer });
    const command = { name: 'Fixture', persona: { name: 'Player', description: '' }, source: { type: 'manual', sha256: '', original_name: '', format: 'json' } };
    const a = (await core.createWorld(command, { idempotencyKey: 'a' })).world;
    const b = (await core.createWorld(command, { idempotencyKey: 'b' })).world;
    return { core, root, materializer, a, b };
}

test('World persistence is independent, revision checked and preserved through process recreation', async t => {
    const { core, root, materializer, a, b } = await fixture(t);
    const updatedA = await core.updateWorld(a.world_id, { preset: preset('A', false) }, { expectedRevision: a.revision });
    await core.updateWorld(b.world_id, { preset: preset('B', true) }, { expectedRevision: b.revision });
    await assert.rejects(core.updateWorld(a.world_id, { preset: preset('wrong', true) }, { expectedRevision: a.revision }), { code: 'NORA_WORLD_REVISION_CONFLICT' });
    for (const key of ['persona', 'sessions', 'runtime_card', 'knowledge', 'capabilities']) assert.deepEqual(updatedA[key], a[key]);
    const reopened = createNoraWorldCore({ root, materializer });
    assert.equal((await reopened.prepareOpen(a.world_id)).preset.name, 'A');
    assert.equal((await reopened.prepareOpen(b.world_id)).preset.name, 'B');
    const invalid = preset('bad', true); invalid.preset.prompt_order[0].order[0].enabled = 'yes';
    await assert.rejects(core.updateWorld(a.world_id, { preset: invalid }, { expectedRevision: updatedA.revision }), { code: 'NORA_WORLD_INVALID' });
});

test('real World activation + ST adapter: A to B to A, lazy initialization and reload do not leak', async t => {
    const { core, root, materializer, a, b } = await fixture(t);
    const client = backend => ({ list: () => backend.listWorlds(), updateWorld: (id, patch, revision) => backend.updateWorld(id, patch, { expectedRevision: revision }),
        async prepareSnapshot(id) {
            const plan = await backend.prepareOpen(id);
            return { schema: 'nora-world-snapshot/v1', revision: String(plan.world_revision), plan,
                character: { name: 'Test', avatar: plan.runtime_card.binding.avatar }, chat: { messages: [] }, worldbooks: [] };
        } });
    const { current, runtime } = contextFixture();
    const worlds = createWorldCoreRuntime(runtime, { client: client(core) });
    await worlds.refresh(); await worlds.activate(a.world_id);
    await worlds.updateActive({ preset: preset('A', false, 0.2) });
    await worlds.activate(b.world_id);
    assert.equal(current.chatCompletionSettings.temp_openai, 0.5, 'Uninitialized B uses the initial default, not A');
    const bPreset = preset('B', true, 0.9);
    Object.assign(bPreset.preset, { top_p: 0.8, openai_max_context: 65536, openai_max_tokens: 4096 });
    await worlds.updateActive({ preset: bPreset });
    await worlds.activate(a.world_id);
    assert.equal(current.chatCompletionSettings.prompts[0].content, 'A');
    assert.equal(current.chatCompletionSettings.prompt_order[0].order[1].enabled, false);
    assert.equal(current.chatCompletionSettings.top_p_openai, 0.9);
    assert.equal(current.chatCompletionSettings.openai_max_context, 32768);
    assert.equal(current.chatCompletionSettings.openai_max_tokens, 2048);
    const afterReload = contextFixture();
    const fresh = createWorldCoreRuntime(afterReload.runtime, { client: client(createNoraWorldCore({ root, materializer })) });
    await fresh.refresh(); await fresh.activate(b.world_id);
    assert.equal(afterReload.current.chatCompletionSettings.temp_openai, 0.9);
    assert.equal(afterReload.current.chatCompletionSettings.prompts[0].content, 'B');
    assert.equal(afterReload.current.chatCompletionSettings.top_p_openai, 0.8);
    assert.equal(afterReload.current.chatCompletionSettings.openai_max_context, 65536);
    assert.equal(afterReload.current.chatCompletionSettings.openai_max_tokens, 4096);
    worldPresetProjection.clear();
});

test('a delayed save stays in A when runtime switches to B before the response returns', async t => {
    const { core, a, b } = await fixture(t);
    const { current, runtime } = contextFixture();
    current.chatMetadata = { nora_world: { id: a.world_id } };
    runtime.applyWorldPreset(preset('A', false));
    const worlds = createWorldCoreRuntime(runtime, { client: {
        list: () => core.listWorlds(), prepareSnapshot() {},
        async updateWorld(id, patch, revision) {
            const saved = await core.updateWorld(id, patch, { expectedRevision: revision });
            current.chatMetadata.nora_world.id = b.world_id;
            runtime.applyWorldPreset(preset('B', true));
            return saved;
        },
    } });
    await worlds.refresh();
    const result = await worlds.updateActive({ preset: preset('Saved A', false) });
    assert.equal(result.runtimeApplied, false);
    assert.equal((await core.getWorld(a.world_id)).preset.name, 'Saved A');
    assert.equal(current.chatCompletionSettings.prompts[0].content, 'B');
    worldPresetProjection.clear();
});

test('known model capacity rejects a World edit before persistence and blocks incompatible generation', async t => {
    const { core, a } = await fixture(t);
    const { current, runtime } = contextFixture();
    current.getChatCompletionModelLimits = () => ({ context: 8192, tokens: 2048 });
    current.chatMetadata = { nora_world: { id: a.world_id } };
    const worlds = createWorldCoreRuntime(runtime, { client: {
        list: () => core.listWorlds(), prepareSnapshot() {},
        updateWorld: (id, patch, revision) => core.updateWorld(id, patch, { expectedRevision: revision }),
    } });
    await worlds.refresh();
    const value = preset('A', true);
    value.preset.openai_max_context = 16384; value.preset.openai_max_tokens = 1024;
    await assert.rejects(worlds.updateActive({ preset: value }), /8192/);
    assert.equal((await core.getWorld(a.world_id)).revision, a.revision);
    runtime.applyWorldPreset(value);
    assert.throws(() => worldPresetProjection.restore(a.world_id), /8192/);
    value.preset.openai_max_context = 8192;
    await worlds.updateActive({ preset: value });
    assert.doesNotThrow(() => worldPresetProjection.restore(a.world_id));
    assert.equal(current.chatCompletionSettings.openai_max_context, 8192);
    worldPresetProjection.clear();
});

test('backend rejects malformed numeric patches without quarantining existing Worlds', async t => {
    const { core, a } = await fixture(t);
    for (const [key, value] of [['temperature', '0.8'], ['top_p', 2], ['openai_max_context', 1], ['openai_max_tokens', 1.5]]) {
        const invalid = preset('A', true); invalid.preset[key] = value;
        await assert.rejects(core.updateWorld(a.world_id, { preset: invalid }, { expectedRevision: a.revision }), { code: 'NORA_WORLD_INVALID' });
        assert.equal((await core.getWorld(a.world_id)).revision, a.revision);
    }
});

test('preset entry is below World settings with Edit, and generation restores before prompt assembly', async () => {
    const panel = await fs.readFile(new URL('../../../native-extensions/nora-ui/panel-controller.js', import.meta.url), 'utf8');
    assert.ok(panel.indexOf('nora-world-preset-section') > panel.indexOf('data-action="worldbook"'));
    assert.match(panel, /data-action="world-preset" type="button">\$\{tr\('编辑'\)\}/);
    assert.match(panel, /data-fold="preset"><span>\$\{tr\('预设'\)\}<\/span><span class="headRight"><button class="sectionEdit"/);
    assert.match(panel, /id="nora-preset-body"/);
    const source = await fs.readFile(new URL('../public/script.js', import.meta.url), 'utf8');
    const start = source.indexOf('worldPresetProjection.restore(chat_metadata?.nora_world?.id)');
    assert.ok(start > 0);
    assert.ok(source.indexOf('eventSource.emit(event_types.GENERATION_STARTED', start) > start);
});

test('preset toggles use the existing dot visual without reducing the click target', async () => {
    const css = await fs.readFile(new URL('../../../native-extensions/nora-ui/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.nora-preset-toggle \{[^}]*width:44px; height:44px/);
    assert.match(css, /\.nora-preset-toggle::after \{[^}]*width:10px; height:10px; border-radius:50%/);
    assert.match(css, /\.nora-preset-toggle:checked::after \{ background:var\(--nora-brand\)/);
    assert.doesNotMatch(css, /\.nora-preset-toggle::before/);
});
