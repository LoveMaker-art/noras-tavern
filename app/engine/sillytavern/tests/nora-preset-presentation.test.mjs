import './fixtures/nora-zh-locale.mjs';
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
