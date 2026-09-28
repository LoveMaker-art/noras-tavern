import assert from 'node:assert/strict';
import test from 'node:test';
import { createStCardAdapter } from '../public/scripts/nora-adapters/st-card-adapter.js';
import { createRegexController } from '../../../native-extensions/nora-ui/regex-controller.js';
import { translate as tr } from '../public/scripts/nora-i18n/core.js';

const rules = () => [{ id: 'original-id', scriptName: '美化', findRegex: '/<content>([\\s\\S]*?)<\\/content>/g',
    replaceString: '</textarea><script>example()</script>\n$1', placement: [2, 99], markdownOnly: true,
    trimStrings: ['\n'], minDepth: null, maxDepth: -1, substituteRegex: 2, customField: { keep: true } },
{ id: 'second-id', scriptName: '隐藏变量', findRegex: 'MVU', replaceString: '', placement: [2], disabled: true }];

function adapterFixture(t) {
    let scripts = rules();
    const calls = [];
    const runtime = { chatMetadata: { nora_world: { id: 'world:a' } }, characters: [{ avatar: 'a.png' }], characterId: 0,
        regex: { parse: value => value === '[' ? undefined : /test/ },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        getCharacters: async () => calls.push('refresh'), refreshCurrentChatDisplay: async () => calls.push('render'), isGenerating: () => false };
    let status = 200, afterRead = () => {};
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const body = JSON.parse(options.body); calls.push({ url, body });
        if (url.endsWith('/get')) {
            afterRead();
            return { ok: true, json: async () => ({ name: '测试卡', data: { extensions: { regex_scripts: structuredClone(scripts) } } }) };
        }
        if (status === 200) scripts = body.data.extensions.regex_scripts;
        return { ok: status === 200, status };
    });
    return { adapter: createStCardAdapter(() => runtime), runtime, calls,
        scripts: () => scripts, setStatus: value => { status = value; }, afterRead: fn => { afterRead = fn; },
        save: patch => createStCardAdapter(() => runtime).saveCharacterRegex({ avatar: 'a.png', index: 0, expectedScripts: rules(), patch, worldId: 'world:a' }) };
}

test('reading a specific card is read-only; saving preserves order, IDs, advanced data and other rules', async t => {
    const f = adapterFixture(t);
    const snapshot = await f.adapter.readCharacterRegex('a.png');
    assert.deepEqual(snapshot.scripts, rules());
    assert.deepEqual(f.calls.map(x => x.url), ['/api/characters/get']);
    await f.save({ replaceString: '\n$1\n', disabled: true });
    assert.deepEqual(f.scripts()[0], { ...rules()[0], replaceString: '\n$1\n', disabled: true });
    assert.deepEqual(f.scripts()[1], rules()[1]);
    const write = f.calls.find(x => x.url?.endsWith('/merge-attributes')).body;
    assert.deepEqual(Object.keys(write), ['avatar', 'data']);
    assert.deepEqual(Object.keys(write.data), ['extensions']);
    assert.deepEqual(Object.keys(write.data.extensions), ['regex_scripts']);
    assert.deepEqual(f.calls.slice(-2), ['refresh', 'render']);
    assert.equal(f.runtime.extensionSettings, undefined, 'Saving never authorizes scripts or changes global settings');
});

test('stale rules fail before writing', async t => {
    const f = adapterFixture(t);
    f.scripts()[1].disabled = false;
    await assert.rejects(f.save({ disabled: true }), /发生变化/);
    assert.equal(f.calls.some(x => x.url?.endsWith('/merge-attributes')), false);
});

for (const patch of [{ id: 'replace-id' }, { placement: [] }, { disabled: 'false' }, { findRegex: '[' }, { findRegex: ' ' }, { scriptName: '' }]) {
    test(`reject invalid regex edit ${JSON.stringify(patch)}`, async t => {
        const f = adapterFixture(t);
        await assert.rejects(f.save(patch));
        assert.equal(f.calls.length, 0);
    });
}

test('macro expressions are preserved for native runtime substitution, not compiled prematurely', async t => {
    const f = adapterFixture(t);
    f.runtime.regex.parse = () => { throw new Error('Do not compile macros before native substitution'); };
    await f.save({ findRegex: '/{{user}}/g' });
    assert.equal(f.scripts()[0].findRegex, '/{{user}}/g');
});

for (const change of ['world', 'generation']) {
    test(`${change} changes during the read prevent a write`, async t => {
        const f = adapterFixture(t);
        f.afterRead(() => {
            if (change === 'world') f.runtime.chatMetadata.nora_world.id = 'world:b';
            else f.runtime.isGenerating = () => true;
        });
        await assert.rejects(f.save({ disabled: true }));
        assert.equal(f.calls.some(x => x.url?.endsWith('/merge-attributes')), false);
    });
}

test('HTTP failure is not reported as saved or projected into current chat', async t => {
    const f = adapterFixture(t); f.setStatus(403);
    await assert.rejects(f.save({ replaceString: '' }), error => /403/.test(error.message) && !error.saved);
    assert.deepEqual(f.scripts(), rules());
    assert.equal(f.calls.includes('render'), false);
});

test('saved data and display refresh failure are distinguished', async t => {
    const f = adapterFixture(t);
    f.runtime.getCharacters = async () => { throw new Error('refresh failed'); };
    await assert.rejects(f.save({ replaceString: '' }), error => error.saved === true);
    assert.equal(f.scripts()[0].replaceString, '');
});

function uiFixture() {
    const nodes = new Map(), saves = [], notices = [];
    let markup = '', worldId = 'world:a', generating = false, releaseCount = 0, read;
    let saveError, allowLeave = true;
    const node = key => {
        if (!nodes.has(key)) nodes.set(key, { handlers: {}, dataset: {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
        return nodes.get(key);
    };
    const form = node('[data-regex-form]');
    const fields = Object.fromEntries(['scriptName', 'findRegex', 'replaceString'].map(key => [key, { value: String(rules()[0][key] ?? '') }]));
    for (const key of ['disabled', 'markdownOnly', 'promptOnly', 'runOnEdit']) fields[key] = { checked: Boolean(rules()[0][key]) };
    form.elements = { namedItem: name => fields[name] };
    const placementNodes = [1, 2, 3, 5, 6].map(value => ({ value: String(value), checked: value === 2 }));
    const dialogs = { version: 0, open(_title, text) { markup = text; this.version++; return {}; },
        toast: value => notices.push(value), normalizeError: error => error.message,
        close() { this.version++; }, protectForm: () => ({ release: () => releaseCount++, leave: fn => allowLeave && fn() }) };
    const cards = { readCharacterRegex: async avatar => read ? read(avatar) : { avatar, name: '卡名', scripts: rules() },
        saveCharacterRegex: async input => { if (saveError) throw saveError; saves.push(input); } };
    const controller = createRegexController({ cards, dialogs, operations: { isBusy: () => false, run: async (_key, fn) => fn() },
        select: node, selectAll: selector => selector === '[data-regex-rule]' ? [Object.assign(node('rule'), { dataset: { regexRule: '0' } })]
            : selector === '[data-regex-edit]' ? [Object.assign(node('edit'), { dataset: { regexEdit: '0' } })]
            : selector === '[data-regex-toggle]' ? [Object.assign(node('toggle'), { dataset: { regexToggle: '0' } })]
            : selector === '[name="placement"]' ? placementNodes : [],
        escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
        activeWorldModel: () => ({ id: worldId }), isGenerating: () => generating, refresh() {},
    });
    return { controller, cards, dialogs, node, fields, saves, notices, placementNodes, markup: () => markup, releases: () => releaseCount,
        setRead: fn => { read = fn; }, setWorld: value => { worldId = value; }, setGenerating: value => { generating = value; },
        setError: value => { saveError = value; }, setLeave: value => { allowLeave = value; },
        edit: async () => { await controller.open('a.png'); await node('edit').handlers.click(); },
        submit: () => form.handlers.submit({ preventDefault() {} }),
    };
}

test('themed editor escapes HTML as text and opens without writes or enabling scripts', async () => {
    const f = uiFixture(); await f.edit();
    assert.match(f.markup(), /nora-editor-fields/);
    assert.match(f.markup(), /&lt;\/textarea&gt;&lt;script&gt;/);
    assert.doesNotMatch(f.markup(), /<script>/);
    assert.ok(f.markup().includes(tr('查看完整原始规则（只读）')));
    assert.equal(f.saves.length, 0);
    await f.submit();
    assert.equal(f.saves.length, 0, 'No-op save must not normalize omitted legacy fields');
});

test('form sends only changed fields, retains unknown placement, and allows empty replacement', async () => {
    const f = uiFixture(); await f.edit();
    f.fields.replaceString.value = '';
    f.placementNodes[0].checked = true;
    await f.submit();
    assert.deepEqual(f.saves[0].patch, { replaceString: '', placement: [99, 1, 2] });
    assert.equal(f.saves[0].avatar, 'a.png');
    assert.equal(f.saves[0].worldId, 'world:a');
    assert.deepEqual(f.saves[0].expectedScripts, rules());
    assert.equal(f.releases(), 1);
});

test('busy generation, switched world and rejected persistence keep edits from being reported as saved', async () => {
    const f = uiFixture(); await f.edit(); f.fields.scriptName.value = '更名';
    f.setGenerating(true); await f.submit(); assert.equal(f.notices.at(-1), tr('请等待当前操作完成后再保存。'));
    f.setGenerating(false); f.setWorld('world:b'); await f.submit(); assert.equal(f.notices.at(-1), tr('世界已切换，请重新打开。'));
    f.setWorld('world:a'); f.setError(new Error('save failed')); await f.submit();
    assert.equal(f.releases(), 0);
    assert.equal(f.saves.length, 0);
    assert.equal(f.node('button[type="submit"]').disabled, false);
    assert.equal(f.fields.scriptName.value, '更名');
});

test('cancel delegates to unsaved-draft protection', async () => {
    const f = uiFixture(); await f.edit(); const original = f.markup();
    f.setLeave(false); await f.node('[data-regex-cancel]').handlers.click(); assert.equal(f.markup(), original);
    f.setLeave(true); await f.node('[data-regex-cancel]').handlers.click(); assert.match(f.markup(), /data-regex-rule/);
    assert.equal(f.saves.length, 0);
});

test('closing a dialog or switching worlds during reading cannot reopen a stale regex list', async () => {
    for (const switchWorld of [false, true]) {
        const f = uiFixture(); let finish;
        f.setRead(() => new Promise(resolve => { finish = resolve; }));
        const pending = f.controller.open('a.png');
        if (switchWorld) f.setWorld('world:b'); else f.dialogs.close();
        finish({ avatar: 'a.png', scripts: rules() }); await pending;
        assert.equal(f.markup(), '');
    }
});

test('empty and malformed lists have explicit states without writes', async () => {
    const f = uiFixture(); f.setRead(async () => ({ avatar: 'a.png', scripts: [] }));
    await f.controller.open('a.png'); assert.ok(f.markup().includes(tr('这张卡没有内置正则规则。')));
    f.setRead(async () => ({ avatar: 'a.png', scripts: {} }));
    await f.controller.open('a.png'); assert.equal(f.notices.at(-1), tr('这张卡的正则规则格式无效。'));
    assert.equal(f.saves.length, 0);
});

test('inline toggle saves only disabled; busy, stale and switched-world operations do not write', async () => {
    const f = uiFixture(), control = {};
    await f.controller.toggle('a.png', 0, rules()[0], control);
    assert.deepEqual(f.saves[0].patch, { disabled: true });
    assert.equal(f.saves[0].worldId, 'world:a');
    assert.equal(control.disabled, false);
    f.setGenerating(true);
    await f.controller.toggle('a.png', 0, rules()[0], control);
    assert.equal(f.saves.length, 1);
    f.setGenerating(false);
    await f.controller.toggle('a.png', 0, { ...rules()[0], scriptName: 'stale' }, control);
    assert.equal(f.saves.length, 1);
    assert.equal(control.disabled, false);
    f.setRead(async avatar => { f.setWorld('world:b'); return { avatar, scripts: rules() }; });
    await f.controller.toggle('a.png', 0, rules()[0], control);
    assert.equal(f.saves.length, 1);
});

test('list toggle reloads persisted state, but failed saves do not show optimistic state', async () => {
    const f = uiFixture();
    let scripts = rules(), reads = 0;
    f.setRead(async avatar => { reads++; return { avatar, scripts: structuredClone(scripts) }; });
    f.cards.saveCharacterRegex = async input => { Object.assign(scripts[input.index], input.patch); };
    await f.controller.open('a.png');
    await f.node('toggle').handlers.click();
    assert.equal(reads, 3, 'Initial list, fresh save snapshot, refreshed list');
    assert.match(f.markup(), /aria-pressed="false"/);
    f.cards.saveCharacterRegex = async () => { throw new Error('save failed'); };
    await f.node('toggle').handlers.click();
    assert.match(f.markup(), /aria-pressed="false"/);
    assert.equal(f.notices.at(-1), 'save failed');
    assert.equal(reads, 4, 'Failed save must not pretend the list changed');
});

test('finishing a toggle after dialog closes does not reopen the list', async () => {
    const f = uiFixture(); let finish;
    f.cards.saveCharacterRegex = () => new Promise(resolve => { finish = resolve; });
    await f.controller.open('a.png');
    const pending = f.node('toggle').handlers.click();
    await Promise.resolve();
    f.dialogs.close(); const version = f.dialogs.version;
    finish(); await pending;
    assert.equal(f.dialogs.version, version);
});
