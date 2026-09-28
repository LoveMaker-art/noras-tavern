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

const require = createRequire(import.meta.url);
const lodash = require('lodash');
const bundle = fs.readFileSync(new URL('../../../native-extensions/JS-Slash-Runner/dist/index.js', import.meta.url), 'utf8');
const start = bundle.indexOf('async function oA(');
const end = bundle.indexOf('var sA=', start);
assert.ok(start >= 0 && end > start);

test('Helper transforms coexist, are repeatable and reject an unknown save function', () => {
    const transforms = [transformCharacterPersistence, transformDeferredEditor, transformWorldPreset];
    for (const order of [transforms, [...transforms].reverse()]) {
        assert.equal(order.reduce((source, transform) => transform(source), bundle), bundle);
    }
    assert.throws(() => transformCharacterPersistence('unknown bundle'), /anchors/);
    assert.throws(() => transformCharacterPersistence(bundle.replace('async function oA(e,t,n,r=!0){', 'async function oA(e,t,n,r=!0){unknown();')), /function/);
    assert.throws(() => transformCharacterPersistence(bundle.replace('persistCharacterExtension } from', 'missingDependency } from')), /import/);
});

function fixture() {
    const card = { name: 'Same name', avatar: 'world-a-owned.png', data: { extensions: {} } };
    const writes = [];
    let fail = false;
    const context = vm.createContext({
        ...adapter, b: [card], He: 0, _: lodash, Wk: structuredClone,
        Ue: async () => {}, pe: () => ({}), Uk: { serialize: x => x },
        $: () => ({ val() {} }), console,
        fetch: async (route, options) => { writes.push(options.body); return { ok: !fail, status: fail ? 500 : 200, text: async () => 'failed' }; },
    });
    vm.runInContext(bundle.slice(start, end), context);
    return { card, writes, context, set fail(value) { fail = value; }, write: (...args) => context.oA(0, ...args) };
}

test('shipped Helper writes the actual avatar, not the display name', async () => {
    const f = fixture();
    await f.write('tavern_helper', { scripts: [{ id: 'database' }] });
    assert.equal(f.writes[0].avatar_url, 'world-a-owned.png');
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
    await f.context.oA(1, 'tavern_helper', { scripts: [{ id: 'other' }] });
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
