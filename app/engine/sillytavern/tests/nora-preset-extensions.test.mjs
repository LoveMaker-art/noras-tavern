import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createWorldPreset } from '../public/scripts/nora-worlds/world-preset.js';
import { createWorldPresetExtensions, worldPresetManager } from '../public/scripts/nora-worlds/world-preset-extensions.js';

const data = () => ({ prompts: [], prompt_order: [{ character_id: 100001, order: [] }],
    extensions: { regex_scripts: [{ id: 'r', findRegex: 'x', replaceString: 'y', disabled: false }],
        tavern_helper: { scripts: [{ id: 's', type: 'script', name: 'same', enabled: true, content: '/* never execute */' }], variables: {} } } });
function fixture() {
    const projection = createWorldPresetExtensions();
    const stored = new Map([['a', createWorldPreset('R', data())], ['b', createWorldPreset('R', data())]]);
    let current = 'a';
    projection.setWriter(async (id, value) => { assert.equal(id, current); stored.set(id, value); projection.bind(id, value); });
    const open = id => { current = id; projection.bind(id, stored.get(id)); };
    open('a');
    return { projection, stored, open };
}
test('snapshot retains embedded regex and scripts but never imports execution permission or connection fields', () => {
    const source = { ...data(), custom_url: 'secret-connection', api_key: 'secret', extension_permissions: { scripts: true } };
    const snapshot = createWorldPreset('R', source);
    assert.deepEqual(snapshot.preset.extensions, source.extensions);
    assert.deepEqual(snapshot.extension_permissions, { scripts: false, regex: false });
    assert.equal(snapshot.preset.api_key, undefined); assert.equal(snapshot.preset.custom_url, undefined);
});
test('permissions are World-local; replacing code revokes permission while a toggle preserves it', async () => {
    const f = fixture(), p = f.projection;
    await p.permission('scripts', true); await p.permission('regex', true);
    let next = p.snapshot().preset;
    next.extensions.tavern_helper.scripts[0].enabled = false;
    await p.save(next); assert.equal(p.enabled('scripts'), true);
    f.open('b'); assert.equal(p.enabled('scripts'), false); assert.equal(p.enabled('regex'), false);
    f.open('a'); assert.equal(p.enabled('scripts'), true);
    next = p.snapshot().preset; next.extensions.tavern_helper.scripts[0].content = 'changed';
    await p.save(next); assert.equal(p.enabled('scripts'), false);
    next = p.snapshot().preset; next.extensions.regex_scripts[0].replaceString = 'changed';
    await p.save(next); assert.equal(p.enabled('regex'), false);
    assert.equal(f.stored.get('b').preset.extensions.tavern_helper.scripts[0].content, '/* never execute */');
});
test('managed Helper reads and writes the active World copy, rejects delayed writes from another World', async () => {
    const f = fixture(), calls = [];
    const native = { getPresetList: () => ({ presets: [], preset_names: {} }), getSelectedPreset: () => '9', getSelectedPresetName: () => 'Default', savePreset: (...args) => calls.push(args) };
    const manager = worldPresetManager(native, f.projection);
    const source = manager.getSelectedPresetName();
    const value = manager.getPresetList().presets[Number(manager.getSelectedPreset())];
    value.extensions.tavern_helper.variables.count = 1;
    await manager.savePreset(source, value);
    assert.equal(f.stored.get('a').preset.extensions.tavern_helper.variables.count, 1);
    assert.equal(calls.length, 0);
    f.open('b'); await assert.rejects(manager.savePreset(source, value), /已改变/);
    f.projection.clear(); assert.equal(manager.getSelectedPresetName(), 'Default');
    await assert.rejects(manager.savePreset(source, value), /已改变/);
    assert.equal(calls.length, 0);
});
test('failed persistence never grants execution permission', async () => {
    const f = fixture(); f.projection.setWriter(async () => { throw new Error('save failed'); });
    await assert.rejects(f.projection.permission('scripts', true), /save failed/);
    assert.equal(f.projection.enabled('scripts'), false);
});
test('actual regex engine consumes only the permitted active World rules', async () => {
    const code = await fs.readFile(new URL('../public/scripts/extensions/regex/engine.js', import.meta.url), 'utf8');
    const start = code.indexOf('export function getScriptsByType(');
    const end = code.indexOf('\n/**', start);
    const f = fixture();
    const context = { worldPresetExtensions: f.projection, SCRIPT_TYPES: { GLOBAL: 0, SCOPED: 1, PRESET: 2 }, SCRIPT_TYPE_UNKNOWN: -1,
        DEFAULT_GET_REGEX_SCRIPTS_OPTIONS: { allowedOnly: false }, extension_settings: {}, getPresetManager() { throw new Error('must not read library'); } };
    vm.createContext(context); vm.runInContext(code.slice(start, end).replace('export ', ''), context);
    assert.equal(context.getScriptsByType(2).length, 1);
    assert.equal(context.getScriptsByType(2, { allowedOnly: true }).length, 0);
    await f.projection.permission('regex', true);
    assert.equal(context.getScriptsByType(2, { allowedOnly: true })[0].replaceString, 'y');
    f.open('b'); assert.equal(context.getScriptsByType(2, { allowedOnly: true }).length, 0);
});

test('shipped Helper preset scope reacts to permission and World changes without adding library grants', async () => {
    const helper = await fs.readFile(new URL('../../../native-extensions/JS-Slash-Runner/dist/index.js', import.meta.url), 'utf8');
    const vue = await fs.readFile(new URL('../../../native-extensions/JS-Slash-Runner/vendor/iframe/vue.runtime.global.prod.min.js', import.meta.url), 'utf8');
    const f = fixture(), context = { console, noraWorldPreset: f.projection };
    vm.createContext(context); vm.runInContext(vue, context);
    const V = context.Vue;
    const settings = V.reactive({ script: { enabled: { presets: [] } } });
    const store = V.reactive({ name: f.projection.source, settings: f.projection.snapshot().preset.extensions.tavern_helper });
    f.projection.subscribe(() => { store.name = f.projection.source; store.settings = f.projection.snapshot()?.preset.extensions.tavern_helper || { scripts: [] }; });
    Object.assign(context, { uF: () => ({ settings }), hF: () => store, G: V.computed,
        nF: (_id, create) => () => V.proxyRefs(create()), JO: item => item.type !== 'folder',
        _: items => ({ filter(fn) { items = items.filter(fn); return this; }, flatMap(fn) { items = items.flatMap(fn); return this; }, value: () => items }) });
    const start = helper.indexOf('function TI('), end = helper.indexOf('var EI=', start);
    vm.runInContext(helper.slice(start, end), context);
    const scope = context.TI('preset')();
    assert.equal(scope.enabled_scripts.length, 0);
    await f.projection.permission('scripts', true);
    assert.equal(scope.enabled_scripts[0].id, 's');
    let next = f.projection.snapshot().preset;
    next.extensions.tavern_helper.scripts[0].enabled = false;
    await f.projection.save(next); assert.equal(scope.enabled_scripts.length, 0);
    next.extensions.tavern_helper.scripts[0].enabled = true;
    await f.projection.save(next); assert.equal(scope.enabled_scripts.length, 1);
    f.open('b'); assert.equal(scope.enabled_scripts.length, 0);
    f.open('a'); assert.equal(scope.enabled_scripts.length, 1);
    f.projection.clear(); assert.equal(scope.enabled_scripts.length, 0);
    assert.equal(settings.script.enabled.presets.length, 0);
});
