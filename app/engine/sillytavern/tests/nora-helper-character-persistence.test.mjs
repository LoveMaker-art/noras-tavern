import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as adapter from '../../../native-extensions/JS-Slash-Runner/nora-control-adapter.js';
import { createRuntimeControls } from '../public/scripts/nora-controls/runtime.js';
import { transformCharacterPersistence } from '../../../native-extensions/JS-Slash-Runner/apply-character-persistence.mjs';
import { transformDeferredEditor } from '../../../native-extensions/JS-Slash-Runner/apply-deferred-json-editor.mjs';
import { transformWorldPreset } from '../../../native-extensions/JS-Slash-Runner/apply-world-preset.mjs';
import { transformManagedRuntime } from '../../../native-extensions/JS-Slash-Runner/apply-managed-runtime.mjs';

const require = createRequire(import.meta.url);
const lodash = require('lodash');
const bundle = fs.readFileSync(new URL('../../../native-extensions/JS-Slash-Runner/dist/index.js', import.meta.url), 'utf8');
const start = bundle.indexOf('async function Rk(');
const end = bundle.indexOf('var zk=', start);
assert.ok(start >= 0 && end > start);

test('Helper transforms coexist, are repeatable and reject an unknown save function', () => {
    const transforms = [transformManagedRuntime, transformCharacterPersistence, transformDeferredEditor, transformWorldPreset];
    for (const order of [transforms, [...transforms].reverse()]) {
        assert.equal(order.reduce((source, transform) => transform(source), bundle), bundle);
    }
    assert.throws(() => transformCharacterPersistence('unknown bundle'), /anchors/);
    assert.throws(() => transformCharacterPersistence(bundle.replace('async function Rk(e,t,n,r=!0){', 'async function Rk(e,t,n,r=!0){unknown();')), /function/);
    assert.throws(() => transformCharacterPersistence(bundle.replace('persistCharacterExtension } from', 'missingDependency } from')), /import/);
});

test('shipped character scope switches same-name Worlds and reloads the matching scripts', async () => {
    const vue = fs.readFileSync(new URL('../../../native-extensions/JS-Slash-Runner/vendor/iframe/vue.runtime.global.prod.min.js', import.meta.url), 'utf8');
    const context = vm.createContext({ console });
    vm.runInContext(vue, context);
    const V = context.Vue;
    const cards = [
        { name: 'Same', avatar: 'a--nora-owned.png', scripts: [{ id: 'script-a', enabled: true }] },
        { name: 'Same', avatar: 'b--nora-owned.png', scripts: [{ id: 'script-b', enabled: false }] },
    ];
    const events = new Map();
    Object.assign(context, {
        b: cards, He: 0, M: V.ref, Gi: V.readonly, I: V.watch,
        nF: (_id, setup) => () => V.proxyRefs(setup()),
        iF: id => ({ scripts: structuredClone(cards[id].scripts) }),
        k: { makeFirst: (event, callback) => events.set(event, callback), on() {} },
        A: { CHAT_CHANGED: 'chat-changed' }, $: () => ({ on() {} }),
        window: { fetch() { throw new Error('World switching must not write or run scripts'); } },
        _d: () => ({ ignoreUpdates: callback => callback() }),
    });
    const from = bundle.indexOf('var oF='), to = bundle.indexOf('function sF(', from);
    assert.ok(from >= 0 && to > from, 'Review character-store bindings on upstream upgrades');
    vm.runInContext(bundle.slice(from, to), context);
    const store = context.oF();
    assert.equal(store.settings.scripts[0].id, 'script-a');
    context.He = 1;
    events.get('chat-changed')();
    await V.nextTick();
    assert.equal(store.id, 1);
    assert.equal(store.avatar, 'b--nora-owned.png');
    assert.equal(store.settings.scripts[0].id, 'script-b');
    assert.equal(store.settings.scripts[0].enabled, false);
    context.He = 0;
    events.get('chat-changed')();
    await V.nextTick();
    assert.equal(store.settings.scripts[0].id, 'script-a');
});

function fixture() {
    const card = { name: 'Same name', avatar: 'world-a-owned.png', data: { extensions: {} } };
    const writes = [];
    let fail = false;
    const context = vm.createContext({
        ...adapter, b: [card], He: 0, _: lodash, Sk: structuredClone,
        Ue: async () => {}, fe: () => ({}), xk: { serialize: x => x },
        $: () => ({ val() {} }), console,
        fetch: async (route, options) => { writes.push(options.body); return { ok: !fail, status: fail ? 500 : 200, text: async () => 'failed' }; },
    });
    vm.runInContext(bundle.slice(start, end), context);
    return { card, writes, context, set fail(value) { fail = value; }, write: (...args) => context.Rk(0, ...args) };
}

test('shipped Helper writes the actual avatar, not the display name', async () => {
    const f = fixture();
    await f.write('tavern_helper', { scripts: [{ id: 'database' }] });
    assert.equal(f.writes[0].avatar_url, 'world-a-owned.png');
});

test('extension saves preserve authored card fields through the real ST formatter', async () => {
    const characters = fs.readFileSync(new URL('../src/endpoints/characters.js', import.meta.url), 'utf8');
    const util = fs.readFileSync(new URL('../src/util.js', import.meta.url), 'utf8');
    const formatStart = characters.indexOf('function charaFormatData(');
    const mergeStart = util.indexOf('function isObject(');
    assert.ok(formatStart >= 0 && mergeStart >= 0);
    const context = vm.createContext({ _: lodash, tryParse: value => { try { return JSON.parse(value); } catch { return null; } },
        humanizedDateTime: () => 'fixture', console });
    vm.runInContext(util.slice(mergeStart, util.indexOf('export const color', mergeStart)).replace('export function', 'function')
        + characters.slice(formatStart, characters.indexOf('\n/**', formatStart)), context);
    for (const serialized of [false, true]) {
        const f = fixture();
        Object.assign(f.card.data, { system_prompt: 'system-kept', post_history_instructions: 'history-kept',
            character_book: { entries: [{ content: 'book-kept' }] }, authored_field: 'data-kept' });
        f.card.authored_field = 'top-kept';
        f.card.data.extensions.depth_prompt = { prompt: 'depth-kept', depth: 8, role: 'user' };
        if (serialized) f.card.json_data = JSON.stringify(f.card);
        await f.write('tavern_helper', { scripts: [] });
        const stored = JSON.parse(JSON.stringify(context.charaFormatData(f.writes[0], {})));
        assert.equal(stored.data.system_prompt, 'system-kept');
        assert.equal(stored.data.post_history_instructions, 'history-kept');
        assert.equal(stored.data.authored_field, 'data-kept');
        assert.equal(stored.authored_field, 'top-kept');
        assert.deepEqual(stored.data.character_book, f.card.data.character_book);
        assert.deepEqual(stored.data.extensions.depth_prompt, f.card.data.extensions.depth_prompt);
        assert.deepEqual(stored.data.extensions.tavern_helper, { scripts: [] });
        assert.equal(stored.json_data, undefined);
    }
});

test('failed writes reject and remain retryable without marking memory saved', async () => {
    const f = fixture(); f.fail = true;
    await assert.rejects(f.write('tavern_helper', { scripts: [] }));
    assert.equal(f.card.data.extensions.tavern_helper, undefined);
    f.fail = false;
    await f.write('tavern_helper', { scripts: [] });
    assert.equal(f.writes.length, 2);
});

test('a changed binding during hydration cannot write another world', async () => {
    const f = fixture();
    f.context.Ue = async () => { f.context.b[0] = { ...f.card, avatar: 'world-b-owned.png' }; };
    await assert.rejects(f.write('tavern_helper', { scripts: [] }));
    assert.equal(f.writes.length, 0);
});

test('missing avatar is rejected instead of inventing a file', async () => {
    const f = fixture(); delete f.card.avatar;
    await assert.rejects(f.write('tavern_helper', { scripts: [] }));
    assert.equal(f.writes.length, 0);
});

test('export-only write preserves live extension state', async () => {
    const f = fixture();
    await f.write('tavern_helper', { scripts: [] }, false);
    assert.equal(f.card.data.extensions.tavern_helper, undefined);
    assert.equal(f.writes[0].avatar_url, f.card.avatar);
});

test('concurrent extension writes preserve both fields and use one world', async () => {
    const f = fixture();
    await Promise.all([f.write('tavern_helper', { scripts: [] }), f.write('other', { enabled: true })]);
    const stored = JSON.parse(f.writes.at(-1).extensions);
    assert.deepEqual(stored, { tavern_helper: { scripts: [] }, other: { enabled: true } });
    assert.ok(f.writes.every(x => x.avatar_url === f.card.avatar));
});

test('export then restore writes again even though live data is unchanged', async () => {
    const f = fixture();
    f.card.data.extensions.tavern_helper = { scripts: [{ id: 'original' }] };
    await f.write('tavern_helper', { scripts: [] }, false);
    await f.write('tavern_helper', { scripts: [{ id: 'original' }] }, false);
    assert.equal(f.writes.length, 2);
    assert.equal(JSON.parse(f.writes[1].extensions).tavern_helper.scripts[0].id, 'original');
});

test('switch during request does not update the new world in memory', async () => {
    const f = fixture();
    const other = { ...f.card, avatar: 'other.png', data: { extensions: {} } };
    f.context.fetch = async () => { f.context.b[0] = other; return { ok: true }; };
    await assert.rejects(f.write('tavern_helper', { scripts: [] }));
    assert.deepEqual(other.data.extensions, {});
});

test('same-name worlds use separate files and a renamed display name is harmless', async () => {
    const f = fixture();
    const other = { ...f.card, avatar: 'other.png', data: { extensions: {} } };
    f.context.b.push(other);
    await f.context.Rk(1, 'tavern_helper', { scripts: [{ id: 'other' }] });
    f.card.name = 'Renamed';
    await f.write('tavern_helper', { scripts: [] });
    assert.deepEqual(f.writes.map(x => x.avatar_url), ['other.png', 'world-a-owned.png']);
    assert.equal(other.data.extensions.tavern_helper.scripts[0].id, 'other');
});

for (const changeAt of [null, 'flush', 'read']) {
    test(`control save verifies its captured world (${changeAt || 'stable'})`, async () => {
        let trees = [{ type: 'script', id: 'one', name: 'One', enabled: false, content: '' }];
        let disk;
        const ctx = { characterId: 0, characters: [{ avatar: 'owned.png' }],
            chatMetadata: { nora_world: { id: 'world' }, nora_session: { id: 'session' } },
            extensionSettings: {}, getRequestHeaders: () => ({}), saveSettingsStrict: async () => {} };
        const reads = [];
        const controls = createRuntimeControls({ getContext: () => ctx, story: { messages: { isGenerating: () => false } },
            assertIdle: () => {}, dispatch: () => ({ execute: async c => ({ status: 'completed', value: await c.run() }) }),
            globalRef: { TavernHelper: { getScriptTrees: () => structuredClone(trees), replaceScriptTrees: async next => { trees = next; },
                noraControls: { scope: () => ({ source: 'card', ownerId: 0, enabled: false }), flush: async () => {
                    disk = structuredClone(trees);
                    if (changeAt === 'flush') ctx.chatMetadata.nora_world.id = 'other';
                } } } },
            fetcher: async (url, options) => {
                if (url.endsWith('/open-plan')) return { ok: true, json: async () => ({ plan: { world_id: 'world', runtime_card: { binding: { avatar: 'owned.png' }, ownership: 'owned' } } }) };
                reads.push(JSON.parse(options.body).avatar_url);
                if (changeAt === 'read') ctx.chatMetadata.nora_world.id = 'other';
                return { ok: true, json: async () => ({ data: { extensions: { tavern_helper: { scripts: disk } } } }) };
            } });
        const base = { worldId: 'world', sessionId: 'session', confirm: true, allowScriptExecution: true };
        const list = await controls.execute({ ...base, action: 'scripts.list', params: { scope: 'character' } });
        const work = controls.execute({ ...base, action: 'scripts.enabled', params: { scope: 'character', id: 'one', enabled: true, expectedRevision: list.revision } });
        if (changeAt) await assert.rejects(work, { code: 'NORA_CONTROL_SCOPE_CHANGED' });
        else assert.equal((await work).persistence, 'native-save-completed');
        assert.deepEqual(reads, changeAt === 'flush' ? [] : ['owned.png']);
    });
}
