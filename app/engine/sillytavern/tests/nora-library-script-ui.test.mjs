import './helpers/nora-locale-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCharacterController } from '../../../native-extensions/nora-ui/character-controller.js';
import { createExtensionController } from '../../../native-extensions/nora-ui/extension-controller.js';
import { readCardImportPreview } from '../../../native-extensions/nora-ui/card-import-preview.js';

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function browserGlobal(t, key, value) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
}

// Small event-host fixture, following the other Nora controller tests. Actual
// HTML rendering and browser persistence are checked separately in the preview.
function uiHost() {
    const opened = [], notices = [];
    let current, leaveAllowed = true, approved = true;
    function element(root, key) {
        if (!root.nodes.has(key)) root.nodes.set(key, {
            handlers: {}, dataset: {}, value: '', hidden: false, textContent: '', innerHTML: '',
            get isConnected() { return root.isConnected; },
            addEventListener(type, callback) { this.handlers[type] = callback; },
            setAttribute() {}, setCustomValidity(value) { this.invalid = value; }, reportValidity() { return !this.invalid; },
            insertAdjacentHTML(_position, html) { this.innerHTML += html; },
            fire(type, extra = {}) { return this.handlers[type]?.({ preventDefault() {}, target: this, currentTarget: this, ...extra }); },
        });
        return root.nodes.get(key);
    }
    const dialogs = {
        version: 0,
        open(title, body) {
            if (current) current.isConnected = false;
            current = { title, body, nodes: new Map(), isConnected: true, classList: { add() {} } };
            opened.push(current); this.version++; return current;
        },
        toast: value => notices.push(value), normalizeError: error => error.message || String(error),
        confirm: async () => approved, setCloseGuard() {},
        protectForm: () => ({ release() {}, leave: action => leaveAllowed && action() }),
        close() { current.isConnected = false; this.version++; },
    };
    const select = (key, root = current) => {
        if (key === '[data-library-jump]' && !root.body.includes('data-library-jump')) return null;
        if (key === '[data-script-edit]' && !root.body.includes('data-script-edit type')) return null;
        const node = element(root, key);
        if (key === '[data-library-jump]' && !node.elements) node.elements = { page: element(root, 'page') };
        if (key === '[data-card-import-form]' && !node.elements) node.elements = { file: element(root, 'file') };
        if (key === '[data-script-edit-form]' && !node.elements) node.elements = {
            name: element(root, 'name'), content: element(root, 'content'), namedItem(name) { return this[name]; },
        };
        if (key === '[data-script-save-status]' || key === 'button[type="submit"]') {
            if (root.nodes) return element(root, key);
        }
        // Forms share their owner's controls in a real DOM.
        if (key.endsWith('-form]') || key === '[data-library-jump]') node.nodes = root.nodes;
        return node;
    };
    const selectAll = (key, root = current) => {
        if (key === '[data-extension]') return ['tavern_helper'].map(name => Object.assign(element(root, name), { dataset: { extension: name } }));
        if (key === '[data-script-inspect]') return [Object.assign(element(root, 'inspect'), { dataset: { scriptKey: 'character:script-a' } })];
        return [];
    };
    return { dialogs, select, selectAll, opened, notices, get current() { return current; },
        allowLeave: value => { leaveAllowed = value; }, approve: value => { approved = value; } };
}

function cardsFixture() {
    const ui = uiHost(), writes = [];
    const state = { characters: Array.from({ length: 160 }, (_, i) => ({ name: `Card ${i}`, avatar: `card-${i}.png`, shallow: true, data: { creator: i % 2 ? 'Alice' : 'Bob' } })) };
    const controller = createCharacterController({ cards: { refreshCharacters: async () => {}, importLibraryCard: async file => { writes.push(file); return {}; } },
        dialogs: ui.dialogs, select: ui.select, selectAll: ui.selectAll, readState: () => state,
        operations: { isBusy: () => false, run: async (_key, fn) => fn() }, settings: () => ({}),
        characterField: (card, key) => card.data?.[key] || card[key] || '', escapeHtml: escape,
        icons: { left: 'left', right: 'right' }, resolveCharacter: () => assert.fail('Do not expand cards'),
        isCharacterInWorld: () => false, reloadWorlds: async () => {}, refresh() {} });
    const count = () => [...ui.current.body.matchAll(/data-library-character="\d+"/g)].length;
    return { ...ui, ui, controller, count, writes, state, get current() { return ui.current; } };
}

test('page jump validates bounds and targets the correct shallow cards without writing', async () => {
    const f = cardsFixture(); await f.controller.openLibrary();
    const jump = f.select('[data-library-jump]');
    for (const value of ['0', '21', '2.5', '', 'oops']) {
        jump.elements.page.value = value;
        await jump.fire('submit');
        assert.equal(f.opened.length, 1); assert.ok(jump.elements.page.invalid);
    }
    jump.elements.page.value = '18'; await jump.fire('submit');
    assert.match(f.current.body, /data-library-character="136"/);
    assert.equal(f.count(), 8); assert.deepEqual(f.writes, []);
});

test('density changes both count and columns, retains the first-card anchor, and tolerates storage failures', async t => {
    browserGlobal(t, 'localStorage', { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
    const f = cardsFixture(); await f.controller.openLibrary(9);
    const density = f.select('[data-library-density]'); density.value = 'compact'; await density.fire('change');
    assert.equal(f.count(), 18); assert.match(f.current.body, /data-library-character="72"/);
    assert.match(f.current.body, /--nora-library-columns:6;--nora-library-mobile-columns:3/);
    const large = f.select('[data-library-density]'); large.value = 'large'; await large.fire('change');
    assert.equal(f.count(), 4); assert.match(f.current.body, /data-library-character="72"/);
    assert.deepEqual(f.writes, []);
});

test('saved density is reused on narrow screens and search resets the filtered page count', async t => {
    let stored = 'compact';
    browserGlobal(t, 'localStorage', { getItem: () => stored, setItem: (_key, value) => { stored = value; } });
    browserGlobal(t, 'matchMedia', () => ({ matches: true }));
    const f = cardsFixture(); await f.controller.openLibrary(3); assert.equal(f.count(), 9);
    f.select('[data-library-search]').value = 'Alice';
    await f.select('[data-library-search-form]').fire('submit');
    assert.match(f.current.body, /1 (?:\/|of) 9/); assert.equal(f.count(), 9);
    assert.doesNotMatch(f.current.body, /data-library-character="0"/);
    const density = f.select('[data-library-density]'); density.value = 'large'; await density.fire('change');
    assert.equal(stored, 'large'); assert.equal(f.count(), 2);
});

test('JSON preview is local, safely displays text, ignores external avatar URLs, and only submit imports', async () => {
    const f = cardsFixture(); await f.controller.openLibrary(); await f.select('[data-library-import]').fire('click');
    const form = f.select('[data-card-import-form]');
    const file = new File([JSON.stringify({ name: '</strong><script>oops()</script>', description: 'Story', avatar: 'https://external.invalid/image.png' })], 'card.json');
    form.elements.file.files = [file]; await form.elements.file.fire('change');
    const preview = f.select('[data-card-preview]');
    assert.match(preview.innerHTML, /&lt;script&gt;/); assert.doesNotMatch(preview.innerHTML, /<script>|external\.invalid/);
    assert.deepEqual(f.writes, []);
    await form.fire('submit'); assert.deepEqual(f.writes, [file]);
});

test('late previews cannot overwrite another file or a departed page; preview errors do not write', async () => {
    const f = cardsFixture(); await f.controller.openLibrary(); await f.select('[data-library-import]').fire('click');
    const form = f.select('[data-card-import-form]'), first = deferred();
    form.elements.file.files = [{ name: 'old.json', size: 10, text: () => first.promise }];
    const old = form.elements.file.fire('change');
    form.elements.file.files = [new File(['{"name":"Latest"}'], 'latest.json')];
    await form.elements.file.fire('change');
    const preview = f.select('[data-card-preview]');
    first.resolve('{"name":"Old"}'); await old;
    assert.match(preview.innerHTML, /Latest/); assert.doesNotMatch(preview.innerHTML, /Old/);
    const second = deferred(); form.elements.file.files = [{ name: 'late.json', size: 10, text: () => second.promise }];
    const late = form.elements.file.fire('change'); f.dialogs.close(); second.resolve('{"name":"After close"}'); await late;
    assert.doesNotMatch(preview.innerHTML, /After close/); assert.deepEqual(f.writes, []);
    await assert.rejects(readCardImportPreview(new File(['bad'], 'bad.json')));
});

test('PNG preview reads a local image and missing-image formats do not invent covers', async t => {
    class Reader { readAsDataURL(blob) { blob.arrayBuffer().then(value => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onload(); }); } }
    browserGlobal(t, 'FileReader', Reader);
    const preview = await readCardImportPreview(new File(['png-test'], 'card.png'));
    assert.match(preview.image, /^data:image\/png;base64,/);
    assert.equal((await readCardImportPreview(new File(['archive'], 'card.charx'))).image, null);
    await assert.rejects(readCardImportPreview({ name: 'large.png', size: 33 * 1024 * 1024 }));
});

function scriptFixture() {
    const ui = uiHost(), calls = [];
    let world = 'a', error, wait, refreshError = false;
    let script = { id: 'script-a', type: 'script', name: 'Script', content: '</textarea><script>neverRun()</script>', enabled: false, button: { buttons: ['keep'] }, data: { keep: 42 } };
    const sibling = { id: 'sibling', content: 'untouched' };
    const worldModel = () => ({ id: world, name: world });
    const controller = createExtensionController({ dialogs: ui.dialogs, select: ui.select, selectAll: ui.selectAll,
        escapeHtml: escape, activeWorldModel: worldModel, currentCharacter: () => ({ avatar: world + '.png' }),
        readState: () => ({ world: { metadata: { nora_session: { id: 'session-' + world } } } }),
        executeControl: async request => {
            calls.push(request);
            if (request.action === 'scripts.list') return { trees: request.params.scope === 'character' ? [script] : [], revision: 'revision-a', enabled: false };
            if (request.action === 'scripts.inspect') {
                if (refreshError && calls.some(c => c.action === 'scripts.update')) throw new Error('readback failed');
                return { script: structuredClone(script), revision: 'revision-a' };
            }
            if (request.action === 'scripts.update') { if (wait) await wait.promise; if (error) throw error; script = { ...script, ...request.params.patch }; return { persistence: 'native-save-completed' }; }
        }, retryCapability() {}, renderPanel() {}, openModelSheet() {}, openCardRegex() {} });
    const open = async () => {
        controller.open(); await ui.selectAll('[data-extension]')[0].fire('click'); await tick();
        await ui.selectAll('[data-script-inspect]')[0].fire('click');
    };
    const edit = async () => {
        await open(); await ui.select('[data-script-edit]').fire('click');
        const form = ui.select('[data-script-edit-form]'); form.elements.name.value = script.name; form.elements.content.value = script.content; return form;
    };
    return { ui, calls, open, edit, sibling, get script() { return script; },
        setError: value => { error = value; }, setWorld: value => { world = value; }, setWait: value => { wait = value; },
        setRefreshError: () => { refreshError = true; }, setScript: patch => { script = { ...script, ...patch }; } };
}

test('script editor preserves identity, sibling data and off state and sends only changed fields', async () => {
    const f = scriptFixture(), form = await f.edit();
    assert.match(f.ui.current.body, /&lt;\/textarea&gt;&lt;script&gt;/);
    form.elements.content.value = 'const updated = true;'; await form.fire('submit');
    const writes = f.calls.filter(c => c.action === 'scripts.update'); assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].params, { scope: 'character', id: 'script-a', expectedRevision: 'revision-a', patch: { content: 'const updated = true;' } });
    assert.equal(f.script.enabled, false); assert.deepEqual(f.script.data, { keep: 42 });
    assert.deepEqual(f.sibling, { id: 'sibling', content: 'untouched' });
    assert.equal(f.calls.some(c => /scripts\.(activate|authorize|import)/.test(c.action)), false);
});

test('no-op script save does not write; cancellation retains an unsaved draft', async () => {
    const f = scriptFixture(), form = await f.edit(); await form.fire('submit');
    assert.equal(f.calls.some(c => c.action === 'scripts.update'), false);
    const second = await f.edit(); second.elements.content.value = 'draft'; f.ui.allowLeave(false);
    await f.ui.select('[data-script-cancel]').fire('click'); assert.equal(second.isConnected, true);
    assert.equal(second.elements.content.value, 'draft');
});

test('folders and managed MVU scripts remain view-only', async () => {
    for (const patch of [{ type: 'folder', scripts: [] }, { managedByNora: true }]) {
        const f = scriptFixture(); f.setScript(patch); await f.open();
        assert.equal(f.ui.current.title, '脚本详情');
        assert.equal(f.ui.select('[data-script-edit]'), null);
        assert.equal(f.calls.some(c => c.action === 'scripts.update'), false);
    }
});

test('a draft cannot be submitted after the selected World changes', async () => {
    const f = scriptFixture(), form = await f.edit();
    form.elements.content.value = 'draft for a'; f.setWorld('b'); await form.fire('submit');
    assert.equal(f.calls.some(c => c.action === 'scripts.update'), false);
    assert.equal(form.elements.content.value, 'draft for a');
});

test('failed and stale script writes keep the draft and do not claim success', async () => {
    const f = scriptFixture(), form = await f.edit(); form.elements.content.value = 'draft';
    f.setError(Object.assign(new Error('Source changed'), { code: 'NORA_CONTROL_EDIT_STALE' }));
    await form.fire('submit'); assert.equal(form.elements.content.value, 'draft');
    assert.equal(form.isConnected, true); assert.match(f.ui.select('[data-script-save-status]', form).textContent, /Source changed/);
    assert.equal(f.ui.notices.length, 0); assert.notEqual(f.script.content, 'draft');
});

test('script retry uses only the revision confirmed by its own failure recovery', async () => {
    const f = scriptFixture(), form = await f.edit(); form.elements.content.value = 'retained draft';
    const recoveredRevision = 'a'.repeat(64);
    f.setError(Object.assign(new Error('write unavailable'), { retryRevision: recoveredRevision }));
    await form.fire('submit');
    assert.equal(form.elements.content.value, 'retained draft');
    f.setError(undefined); await form.fire('submit');
    assert.equal(f.calls.filter(c => c.action === 'scripts.update').at(-1).params.expectedRevision, recoveredRevision);
    assert.equal(f.script.content, 'retained draft');
});

test('pending script save rejects duplicate submit and late results cannot replace another World', async () => {
    const f = scriptFixture(), form = await f.edit(), gate = deferred(); f.setWait(gate);
    form.elements.content.value = 'changed'; const first = form.fire('submit'); await form.fire('submit');
    assert.equal(f.calls.filter(c => c.action === 'scripts.update').length, 1);
    f.setWorld('b'); f.ui.dialogs.open('Other World', 'Keep this view'); gate.resolve(); await first;
    assert.equal(f.ui.current.title, 'Other World'); assert.equal(f.ui.notices.length, 0);
});

test('enabled script edit requires confirmation and saved/readback failure offers exit without duplicate write', async () => {
    const f = scriptFixture(); f.setScript({ enabled: true });
    const form = await f.edit(); form.elements.content.value = 'changed'; f.ui.approve(false); await form.fire('submit');
    assert.equal(f.calls.some(c => c.action === 'scripts.update'), false);
    f.ui.approve(true); f.setRefreshError(); await form.fire('submit');
    assert.equal(f.calls.filter(c => c.action === 'scripts.update').length, 1);
    assert.match(f.ui.select('[data-script-save-status]', form).textContent, /已保存|saved/i);
    await f.ui.select('[data-script-cancel]').fire('click'); await tick(); assert.notEqual(f.ui.current.title, '编辑脚本');
});
