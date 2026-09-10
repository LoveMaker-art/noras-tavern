import assert from 'node:assert/strict';
import test from 'node:test';
import { createStPresetAdapter } from '../public/scripts/nora-adapters/st-preset-adapter.js';

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
import { describePreset } from '../../../native-extensions/nora-ui/preset-presentation.js';
import { createLibraryController } from '../../../native-extensions/nora-ui/library-controller.js';

const preset = { temperature: 0, top_p: 0.95, openai_max_tokens: 2000, openai_max_context: 32000,
    prompts: [{ identifier: 'a', name: 'First', content: 'A' }, { identifier: 'b', name: 'Second', content: 'B' }, { identifier: 'c', content: 'C' }],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'a', enabled: true }] },
        { character_id: 100001, order: [{ identifier: 'b', enabled: true }, { identifier: 'a', enabled: false }] }] };

test('preview follows ST global order, preserves zero parameters, and does not mutate the preset', () => {
    const before = structuredClone(preset);
    const view = describePreset(preset);
    assert.deepEqual(view.rows.map(row => [row.identifier, row.enabled, row.listed]), [['b', true, true], ['a', false, true], ['c', false, false]]);
    assert.equal(view.parameters[0].value, 0);
    assert.equal(view.scripts, 0);
    assert.deepEqual(preset, before);
    for (const order of [[], [{ character_id: 100001, order: [] }], [{ character_id: 100000, order: [{ identifier: 'a', enabled: true }] }]]) {
        const missing = describePreset({ ...preset, prompt_order: order });
        assert.equal(missing.configured, false);
        assert.ok(missing.rows.every(row => row.enabled === null));
    }
});

test('script presence uses the existing canonical, legacy, folder and serialized-map normalizer', () => {
    const scripts = [{ type: 'folder', scripts: [{ type: 'script', id: 'a', content: 'code' }] }];
    for (const extensions of [{ tavern_helper: { scripts } }, { TavernHelper_scripts: scripts }, { tavern_helper: [['scripts', scripts]] }]) {
        assert.equal(describePreset({ extensions }).scripts, 1);
    }
    assert.equal(describePreset({ extensions: { tavern_helper: {}, TavernHelper_scripts: scripts } }).scripts, 0);
});

function ui() {
    const nodes = new Map();
    const node = selector => {
        if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', handlers: {}, value: '', checked: false,
            addEventListener(type, handler) { this.handlers[type] = handler; }, insertBefore() {} });
        return nodes.get(selector);
    };
    let content = ''; let generating = false; const calls = [];
    const items = [{ name: 'Alpha', preset }, { name: 'Beta', preset }];
    const controller = createLibraryController({
        presets: { listPresets: () => ({ items, selected: 'Alpha' }), applyPreset: async (...args) => calls.push(args) },
        dialogs: { open: (_title, body) => { content = body; return {}; }, close() {}, toast() {}, normalizeError: e => e.message, confirm: async () => true },
        operations: { isBusy: () => false, run: async (_key, fn) => fn() }, isGenerating: () => generating,
        select: selector => selector === '[data-scripts]' && !content.includes('data-scripts') ? null : node(selector),
        selectAll: (selector, root) => selector === '[data-preset]' ? [...root.innerHTML.matchAll(/data-preset="(\d+)"/g)].map(match => {
            const button = node(`row-${match[1]}`); button.dataset = { preset: match[1] }; return button;
        }) : [],
        escapeHtml: value => String(value).replaceAll('<', '&lt;'), refresh() {},
    });
    return { controller, node, calls, content: () => content, generating: value => { generating = value; } };
}

test('search preserves query on return, marks current selection, and distinguishes no results', async () => {
    const f = ui();
    await f.controller.openPresets();
    assert.match(f.node('[data-preset-results]').innerHTML, /aria-current="true"/);
    assert.doesNotMatch(f.node('[data-preset-results]').innerHTML, /聊天补全预设/);
    const search = f.node('[data-preset-search]');
    search.value = 'bEtA'; search.handlers.input({ currentTarget: search });
    assert.doesNotMatch(f.node('[data-preset-results]').innerHTML, /Alpha/);
    f.node('row-1').handlers.click();
    assert.match(f.content(), /nora-preset-footer/);
    assert.doesNotMatch(f.content(), /data-scripts/);
    assert.doesNotMatch(f.content(), /<details[^>]* open/);
    assert.ok(f.content().indexOf('nora-preset-footer') > f.content().indexOf('nora-preset-prompts'));
    await f.node('[data-back]').handlers.click();
    assert.match(f.content(), /value="bEtA"/);
    search.value = 'missing'; search.handlers.input({ currentTarget: search });
    assert.match(f.node('[data-preset-results]').innerHTML, /没有匹配/);
});

test('apply without a script checkbox preserves false consent and generation guard', async () => {
    const f = ui();
    await f.controller.openPresets(); f.node('row-1').handlers.click();
    const button = f.node('[data-apply]');
    f.generating(true); await button.handlers.click({ currentTarget: button });
    assert.equal(f.calls.length, 0);
    f.generating(false); await button.handlers.click({ currentTarget: button });
    assert.deepEqual(f.calls, [['Beta', { enableScripts: false }]]);
});
