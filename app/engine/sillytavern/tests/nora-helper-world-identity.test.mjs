import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createWorldHelperIdentity } from '../public/scripts/nora-worlds/world-helper-identity.js';
import { collectManagedExtensionCoreBridges } from '../build/generate-nora-runtime-assets.mjs';

const helperUrl = new URL('../../../native-extensions/JS-Slash-Runner/dist/index.js', import.meta.url);
const world = (id, avatar = 'same.png') => ({ world_id: id, name: '同名世界', runtime_card: { binding: { avatar } } });

test('the shipped Helper identity import is included in the versioned extension bridge', async () => {
    const bridges = await collectManagedExtensionCoreBridges();
    assert.ok(bridges.includes('scripts/nora-worlds/world-helper-identity.js'));
});

test('World consent resolves authoritative bindings, not names, filenames or imported consent', () => {
    const identity = createWorldHelperIdentity();
    let worlds = [world('a'), world('b')];
    identity.configure(() => worlds);
    assert.equal(identity.resolve('same.png'), null, 'ambiguous bindings must not guess');
    assert.equal(identity.key('same.png', 'a'), 'nora-world:a');
    assert.equal(identity.key('same.png', 'b'), 'nora-world:b');
    assert.equal(identity.key('same.png', 'missing'), null);
    worlds = [world('a', 'renamed.png')];
    assert.equal(identity.key('renamed.png'), 'nora-world:a');
    assert.equal(identity.key('same.png', 'a'), null);
    for (const status of ['DELETING', 'DELETED']) {
        worlds[0].lifecycle = { status };
        assert.equal(identity.key('renamed.png', 'a'), null);
    }
    worlds[0].lifecycle = { status: 'FAILED', error: { deletion_pending: true } };
    assert.equal(identity.key('renamed.png', 'a'), null, 'a failed pending deletion cannot restore execution consent');
    worlds[0].lifecycle = { status: 'FAILED', error: { code: 'NORA_WORLD_RESOURCE_MISSING' } };
    assert.equal(identity.key('renamed.png', 'a'), 'nora-world:a', 'unrelated repair failures do not silently reset consent');
});

async function fixture() {
    const helper = await fs.readFile(helperUrl, 'utf8');
    const vue = await fs.readFile(new URL('../../../native-extensions/JS-Slash-Runner/vendor/iframe/vue.runtime.global.prod.min.js', import.meta.url), 'utf8');
    const identity = createWorldHelperIdentity(), worlds = [world('a'), world('b')];
    identity.configure(() => worlds);
    const handlers = new Map(), metadata = { nora_world: { id: 'a' } };
    const context = { console, noraHelperIdentity: identity, S: metadata, A: { CHAT_CHANGED: 'chat_changed' }, k: { on: (name, callback) => handlers.set(name, callback) } };
    vm.createContext(context); vm.runInContext(vue, context);
    const V = context.Vue;
    const settings = V.reactive({ script: { enabled: { characters: ['same.png', '同名世界'] }, popuped: { characters: [] } } });
    const store = V.reactive({ avatar: 'same.png', settings: { scripts: [{ id: 's', enabled: true, type: 'script' }] } });
    const lodash = items => ({ filter(fn) { items = items.filter(fn); return this; }, flatMap(fn) { items = items.flatMap(fn); return this; }, value: () => items });
    lodash.pull = (items, value) => { let index; while ((index = items.indexOf(value)) !== -1) items.splice(index, 1); };
    Object.assign(context, { uF: () => ({ settings }), oF: () => store, G: V.computed, M: V.ref,
        nF: (_id, create) => () => V.proxyRefs(create()), JO: item => item.type !== 'folder', _: lodash });
    const prefixStart = helper.indexOf('let noraHelperIdentityRevision;');
    assert.ok(prefixStart >= 0, 'managed Helper must use the World identity resolver');
    vm.runInContext(helper.slice(prefixStart, helper.indexOf('function publishTavernHelper(', prefixStart)), context);
    const start = helper.indexOf('function TI('), end = helper.indexOf('var EI=', start);
    vm.runInContext(helper.slice(start, end), context);
    const scope = context.TI('character')();
    const open = id => { metadata.nora_world.id = id; handlers.get('chat_changed')(); };
    return { context, identity, worlds, settings, store, scope, open };
}

test('shipped Helper isolates same-avatar Worlds, preserves consent across binding changes and keeps file sources intact', async () => {
    const f = await fixture();
    assert.equal(f.scope.enabled, false, 'legacy grants cannot silently grant World consent');
    f.scope.enabled = true;
    assert.ok(f.settings.script.enabled.characters.includes('nora-world:a'));
    assert.equal(f.scope.enabled_scripts.length, 1);
    assert.equal(f.scope.source, 'same.png', 'file and script APIs still use the ST binding');
    f.open('b'); assert.equal(f.scope.enabled_scripts.length, 0);
    f.open('a'); assert.equal(f.scope.enabled_scripts.length, 1);
    f.worlds[0].runtime_card.binding.avatar = 'changed.png';
    f.store.avatar = 'changed.png'; f.identity.changed();
    assert.equal(f.scope.enabled_scripts.length, 1);
    assert.equal(f.scope.source, 'changed.png');
    f.open('missing'); assert.equal(f.scope.enabled, false);
    f.scope.enabled = true;
    assert.equal(f.settings.script.enabled.characters.length, 3, 'unresolved World cannot grant permission');
    const helper = await fs.readFile(helperUrl, 'utf8');
    assert.ok(!helper.includes('t.value.script.enabled.characters.map(e=>e.endsWith(`.png`)'));
});

test('native Helper prompt captures the original World and does not enable another World after a switch', async () => {
    const f = await fixture(), calls = [];
    let finish;
    f.context.__NORA_CONFIRM_CHARACTER_CAPABILITIES__ = options => {
        calls.push(options);
        return new Promise(resolve => { finish = resolve; });
    };
    f.context.noraPromptCharacterScripts(f.settings, f.scope);
    f.open('b');
    await Promise.resolve();
    assert.equal(calls[0].worldId, 'a');
    assert.equal(calls[0].characterAvatar, 'same.png');
    finish(true); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.scope.enabled, false, 'the Nora controller, not a late enabled=true, grants the captured World');
    assert.deepEqual([...f.settings.script.popuped.characters], ['nora-world:a']);
});

test('shipped Helper revokes effective consent until a failed deletion is resolved', async () => {
    const f = await fixture();
    f.scope.enabled = true;
    f.worlds[0].lifecycle = { status: 'FAILED', error: { deletion_pending: true } };
    f.identity.changed();
    assert.equal(f.scope.enabled, false);
    assert.equal(f.scope.enabled_scripts.length, 0);
    assert.ok(f.settings.script.enabled.characters.includes('nora-world:a'), 'do not destroy stored consent during a retryable deletion');
});
