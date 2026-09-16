import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createStPresetAdapter } from '../public/scripts/nora-adapters/st-preset-adapter.js';

// Run the engine's real selection methods without loading browser-only imports.
const source = ts.createSourceFile('PromptManager.js', readFileSync(new URL('../public/scripts/PromptManager.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const managerClass = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'PromptManager');
const methodNames = ['getPromptsForCharacter', 'getPromptOrderForCharacter', 'getPromptById', 'isPromptToggleAllowed'];
const engineMethods = vm.runInNewContext(`({${managerClass.members.filter(node => methodNames.includes(node.name?.getText(source))).map(node => node.getText(source)).join(',')}})`);

function fixture(selected = 'Alpha') {
    const original = { temperature: 0.8, extensions: { tavern_helper: { scripts: ['preserved'] } },
        prompts: [{ identifier: 'a', content: 'A' }, { identifier: 'b', content: 'B' }, { identifier: 'extra', content: 'Extra' }, { identifier: 'locked', marker: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true, extra: 'keep' }, { identifier: 'b', enabled: false }] },
            { character_id: 7, order: [{ identifier: 'a', enabled: false }] }] };
    const values = [structuredClone(original), structuredClone(original)];
    const names = { Alpha: 0, Beta: 1 };
    const settings = { ...structuredClone(original), preset_settings_openai: selected, temperature: 0.2, custom_url: 'unchanged', bind_preset_to_connection: true };
    const disk = new Map(), calls = [];
    const manager = {
        getPresetList: () => ({ presets: values, preset_names: names }),
        getAllPresets: () => Object.keys(names), getSelectedPresetName: () => settings.preset_settings_openai,
        findPreset: name => names[name],
        savePreset: async (name, value, options) => { calls.push(['save', options]); disk.set(name, structuredClone(value)); },
        selectPreset: async index => { calls.push(['select']); Object.assign(settings, structuredClone(values[index]), { preset_settings_openai: Object.keys(names)[index] }); },
    };
    const promptManager = { isPromptToggleAllowed: prompt => !prompt.marker, render: () => calls.push(['render']) };
    const context = { getPresetManager: () => manager, chatCompletionSettings: settings,
        getChatCompletionPromptManager: () => promptManager, saveSettingsStrict: async () => calls.push(['settings']) };
    return { adapter: createStPresetAdapter(() => context), context, manager, settings, values, original, disk, calls };
}

test('active editor reads live prompt state; inactive editor reads the stored preset', () => {
    const f = fixture();
    f.settings.prompt_order[0].order[0].enabled = false;
    assert.equal(f.adapter.readPreset('Alpha').preset.prompt_order[0].order[0].enabled, false);
    assert.equal(f.adapter.readPreset('Beta').preset.prompt_order[0].order[0].enabled, true);
    assert.equal(f.adapter.readPreset('Alpha').toggleable.includes('locked'), false);
});

test('save inactive toggles preserves payload and ordering without selecting or running scripts', async () => {
    const f = fixture(), before = structuredClone(f.settings);
    await f.adapter.savePresetEntries(f.adapter.readPreset('Beta'), [{ identifier: 'b', enabled: true }]);
    const expected = structuredClone(f.original); expected.prompt_order[0].order[1].enabled = true;
    assert.deepEqual(f.values[1], expected);
    assert.deepEqual(f.disk.get('Beta'), expected);
    assert.deepEqual(f.settings, before);
    assert.deepEqual(f.calls, [['save', { skipUpdate: true }]]);
});

test('save and apply active toggles changes next-request settings, not sampler, connection or scripts', async () => {
    const f = fixture();
    await f.adapter.savePresetEntries(f.adapter.readPreset('Alpha'), [{ identifier: 'a', enabled: false }], { apply: true });
    assert.equal(f.settings.prompt_order[0].order[0].enabled, false);
    assert.equal(f.disk.get('Alpha').prompt_order[0].order[0].enabled, false);
    assert.equal(f.adapter.readPreset('Alpha').preset.prompt_order[0].order[0].enabled, false);
    assert.equal(f.settings.temperature, 0.2);
    assert.equal(f.values[0].temperature, 0.8);
    assert.equal(f.settings.custom_url, 'unchanged');
    assert.deepEqual(f.settings.extensions, f.original.extensions);
    assert.equal(f.calls.some(([name]) => name === 'select'), false);
    assert.equal(f.calls.some(([name]) => name === 'settings'), true);
});

test('unlisted entry can be explicitly appended, while unknown and locked entries are rejected', async () => {
    const f = fixture();
    await f.adapter.savePresetEntries(f.adapter.readPreset('Beta'), [{ identifier: 'extra', enabled: true, add: true }]);
    assert.deepEqual(f.values[1].prompt_order[0].order.at(-1), { identifier: 'extra', enabled: true });
    for (const change of [{ identifier: 'missing', enabled: true }, { identifier: 'locked', enabled: true, add: true }]) {
        await assert.rejects(f.adapter.savePresetEntries(f.adapter.readPreset('Beta'), [change]), /条目/);
    }
});

test('stale drafts and active-preset switches are rejected before writing', async () => {
    for (const mutate of [f => { f.values[1].temperature = 1; }, f => { f.settings.preset_settings_openai = 'Beta'; }]) {
        const f = fixture(), snapshot = f.adapter.readPreset('Beta');
        mutate(f);
        await assert.rejects(f.adapter.savePresetEntries(snapshot, [{ identifier: 'a', enabled: false }]), /改变/);
        assert.equal(f.disk.size, 0);
    }
});

test('save failure leaves library and running settings untouched', async () => {
    const f = fixture(), before = structuredClone(f.settings);
    f.manager.savePreset = async () => { throw new Error('disk failure'); };
    await assert.rejects(f.adapter.savePresetEntries(f.adapter.readPreset('Alpha'), [{ identifier: 'a', enabled: false }], { apply: true }), /disk failure/);
    assert.deepEqual(f.settings, before); assert.deepEqual(f.values[0], f.original);
});

test('settings failure distinguishes saved preset from unapplied runtime and restores running order', async () => {
    const f = fixture(), before = structuredClone(f.settings.prompt_order);
    f.context.saveSettingsStrict = async () => { throw new Error('settings failure'); };
    await assert.rejects(f.adapter.savePresetEntries(f.adapter.readPreset('Alpha'), [{ identifier: 'a', enabled: false }], { apply: true }), error => error.saved === true);
    assert.equal(f.disk.get('Alpha').prompt_order[0].order[0].enabled, false);
    assert.deepEqual(f.settings.prompt_order, before);
});

test('the engine selection excludes disabled entries and restores them in the original order', async () => {
    const f = fixture();
    const prompts = { ...engineMethods, serviceSettings: f.settings, configuration: { toggleDisabled: [] } };
    f.context.getChatCompletionPromptManager = () => prompts;
    const enabled = () => Array.from(prompts.getPromptsForCharacter({ id: 100001 }, true), prompt => prompt.identifier);
    assert.deepEqual(enabled(), ['a']);
    await f.adapter.savePresetEntries(f.adapter.readPreset('Alpha'), [{ identifier: 'a', enabled: false }, { identifier: 'b', enabled: true }], { apply: true });
    assert.deepEqual(enabled(), ['b']);
    await f.adapter.savePresetEntries(f.adapter.readPreset('Alpha'), [{ identifier: 'a', enabled: true }], { apply: true });
    assert.deepEqual(enabled(), ['a', 'b']);
    assert.equal(prompts.isPromptToggleAllowed({ identifier: 'chatHistory', marker: true }), true);
    assert.equal(prompts.isPromptToggleAllowed({ identifier: 'unknown-marker', marker: true }), false);
    prompts.configuration.toggleDisabled = ['a'];
    assert.equal(f.adapter.readPreset('Alpha').toggleable.includes('a'), false);
});

test('inactive save and apply uses existing script consent while keeping the connection', async () => {
    const f = fixture();
    await f.adapter.savePresetEntries(f.adapter.readPreset('Beta'), [{ identifier: 'b', enabled: true }], { apply: true });
    assert.equal(f.settings.preset_settings_openai, 'Beta');
    assert.equal(f.settings.prompt_order[0].order[1].enabled, true);
    assert.equal(f.settings.custom_url, 'unchanged');
    assert.equal(f.settings.bind_preset_to_connection, true);
    assert.equal(f.settings.extensions.tavern_helper, undefined);
    assert.deepEqual(f.values[1].extensions, f.original.extensions);
});

test('generation and concurrent saves are rejected without a duplicate write', async () => {
    const f = fixture();
    f.context.isGenerating = () => true;
    await assert.rejects(f.adapter.savePresetEntries(f.adapter.readPreset('Alpha'), [{ identifier: 'a', enabled: false }]), /等待/);
    assert.equal(f.disk.size, 0);
    f.context.isGenerating = () => false;
    let release;
    const originalSave = f.manager.savePreset;
    f.manager.savePreset = async (...args) => { await new Promise(resolve => { release = resolve; }); await originalSave(...args); };
    const snapshot = f.adapter.readPreset('Alpha');
    const pending = f.adapter.savePresetEntries(snapshot, [{ identifier: 'a', enabled: false }]);
    await assert.rejects(f.adapter.savePresetEntries(snapshot, [{ identifier: 'b', enabled: true }]), /等待/);
    release(); await pending;
    assert.equal(f.calls.filter(([name]) => name === 'save').length, 1);
});
