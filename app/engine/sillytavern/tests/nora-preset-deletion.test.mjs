import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createStPresetAdapter } from '../public/scripts/nora-adapters/st-preset-adapter.js';

const source = ts.createSourceFile('preset-manager.js', readFileSync(new URL('../public/scripts/preset-manager.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'PresetManager');
const method = declaration.members.find(node => node.name?.getText(source) === 'deletePreset').getText(source);

function fixture() {
    const presets = [{ prompts: [], prompt_order: [], openai_max_tokens: 4000 }, { prompts: [], prompt_order: [], openai_max_tokens: 2000 }];
    const names = { Alpha: 0, Beta: 1 }, requests = [], selections = [];
    const settings = { preset_settings_openai: 'Alpha', openai_max_tokens: 4000, prompts: [], prompt_order: [] };
    const worlds = [{ preset: structuredClone(presets[0]) }, { preset: structuredClone(presets[1]) }];
    let status = 200, networkError = false, generating = false, release;
    const disk = new Set(Object.keys(names));
    const manager = {
        apiId: 'openai', isKeyedApi: () => false,
        getPresetList: () => ({ presets, preset_names: names }),
        getAllPresets: () => Object.keys(names),
        getSelectedPresetName: () => settings.preset_settings_openai,
        findPreset: name => names[name],
        selectPreset: async index => { selections.push(index); Object.assign(settings, presets[index]); },
        ...vm.runInNewContext(`({${method}})`, { getRequestHeaders: () => ({}), fetch: async (url, options) => {
            const body = JSON.parse(options.body);
            requests.push({ url, body });
            if (release) await release;
            if (networkError) throw new Error('network unavailable');
            if (status === 200) disk.delete(body.name);
            return { ok: status === 200, status };
        } }),
    };
    const runtime = { getPresetManager: () => manager, chatCompletionSettings: settings,
        getChatCompletionPromptManager: () => ({ isPromptToggleAllowed: () => true }), isGenerating: () => generating };
    return { adapter: createStPresetAdapter(() => runtime), manager, presets, names, settings, worlds, disk, requests, selections,
        status: value => { status = value; }, networkError: () => { networkError = true; }, generating: () => { generating = true; },
        pause: promise => { release = promise; } };
}

test('deleting the selected template keeps runtime and all World copies unchanged, including the final template', async () => {
    const f = fixture(), settings = structuredClone(f.settings), worlds = structuredClone(f.worlds);
    await f.adapter.deletePreset(f.adapter.readPreset('Alpha', { storedOnly: true }));
    assert.deepEqual(f.names, { Beta: 0 });
    assert.equal(f.presets[0].openai_max_tokens, 2000);
    assert.equal(f.disk.has('Alpha'), false);
    assert.deepEqual(f.selections, []);
    assert.deepEqual(f.settings, settings);
    assert.deepEqual(f.worlds, worlds);
    await f.adapter.deletePreset(f.adapter.readPreset('Beta', { storedOnly: true }));
    assert.deepEqual(f.names, {});
    assert.deepEqual(f.presets, []);
    assert.deepEqual(f.settings, settings);
});

test('server failure and network failure preserve the library and active configuration', async () => {
    for (const mode of ['status', 'network']) {
        const f = fixture(), before = structuredClone({ presets: f.presets, names: f.names, settings: f.settings });
        if (mode === 'status') f.status(403); else f.networkError();
        await assert.rejects(f.adapter.deletePreset(f.adapter.readPreset('Alpha', { storedOnly: true })));
        assert.deepEqual({ presets: f.presets, names: f.names, settings: f.settings }, before);
        assert.equal(f.disk.has('Alpha'), true);
        assert.deepEqual(f.selections, []);
    }
});

test('stale, missing, generating and concurrent deletes are rejected before a duplicate request', async () => {
    const f = fixture(), snapshot = f.adapter.readPreset('Alpha', { storedOnly: true });
    f.presets[0].openai_max_tokens = 5000;
    await assert.rejects(f.adapter.deletePreset(snapshot), /改变/);
    await assert.rejects(f.adapter.deletePreset({ name: 'Missing' }), /不存在/);
    assert.equal(f.requests.length, 0);
    let resolve;
    f.pause(new Promise(done => { resolve = done; }));
    const pending = f.adapter.deletePreset(f.adapter.readPreset('Alpha', { storedOnly: true }));
    await assert.rejects(f.adapter.deletePreset(snapshot), /等待/);
    resolve(); await pending;
    assert.equal(f.requests.length, 1);
    f.generating();
    await assert.rejects(f.adapter.deletePreset(f.adapter.readPreset('Beta', { storedOnly: true })), /等待/);
});

test('native deletion still switches presets on success when skipSwitch is not requested', async () => {
    const f = fixture();
    assert.equal(await f.manager.deletePreset('Alpha'), true);
    assert.deepEqual(f.selections, [0]);
    assert.equal(f.settings.openai_max_tokens, 2000);
});
