import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { createWorldCreationController } from '../../../native-extensions/nora-ui/world-creation-controller.js';
import { createWorldController } from '../../../native-extensions/nora-ui/world-controller.js';
import { createUiOperationRegistry } from '../../../native-extensions/nora-ui/ui-operation-registry.js';
import { translate as tr } from '../public/scripts/nora-i18n/core.js';

function fixture(kind) {
    let dom, modal, closed = 0, openingFailure = false, listFailure = false, creating;
    const nodes = new WeakMap(), notices = [], created = [], activated = [];
    const worlds = [{ id: 'existing', name: 'Existing story', available: true,
        persona: { name: 'Player' }, messages: ['Keep existing story'], preset: { name: 'Saved preset' } }];
    const original = structuredClone(worlds[0]);
    const operations = createUiOperationRegistry();
    const wrap = raw => {
        if (!raw) return null;
        if (nodes.has(raw)) return nodes.get(raw);
        const node = { raw, handlers: {}, disabled: false,
            addEventListener(type, fn) { this.handlers[type] = fn; }, focus() {},
            fire(type) { if (!this.disabled) return this.handlers[type]?.({ preventDefault() {}, currentTarget: this }); },
            querySelector(selector) { return select(selector, this); },
            get fields() { return dom(raw).find('[name]').toArray().map(el => [el.attribs.name, dom(el).attr('value') || '']); } };
        for (const key of ['value', 'textContent']) Object.defineProperty(node, key, {
            get: () => key === 'value' ? dom(raw).attr('value') || '' : dom(raw).text(),
            set: value => { if (key === 'value') dom(raw).attr('value', value); else dom(raw).text(value); },
        });
        nodes.set(raw, node);
        return node;
    };
    const select = (selector, parent = modal) => wrap(dom(parent.raw).find(selector).get(0));
    const create = async input => {
        created.push(input);
        if (creating) await creating;
        const world = { id: `created:${created.length}`, name: 'New story', available: true };
        worlds.push(world);
        return world;
    };
    const elements = new Map();
    const worldController = createWorldController({
        settingsDomain: { uiSettings: () => ({}), saveUiSettings: async () => {} },
        worldRuntime: { activate: async id => {
            if (openingFailure) throw new Error('Injected activation failure');
            activated.push(id);
        } },
        operations, store: { read: () => ({ worldModels: worlds }) },
        storyScroller: { followLatest: () => () => {}, toLatest: async () => {} },
        select: selector => {
            if (!elements.has(selector)) elements.set(selector, { setAttribute() {}, removeAttribute() {} });
            return elements.get(selector);
        },
        selectAll: () => [], escapeHtml: value => value, icons: {}, readState: () => ({ messages: [] }),
        activeWorldModel: () => worlds[0], showToast: message => notices.push(message),
        confirmAction: async () => false, normalizeError: error => error.message,
        timedUiStep: async (_name, fn) => fn(), recordBootMilestone() {},
        performanceReporter: { timedMilestone() {} }, primeActiveWorldbook: async () => {},
        closeDrawers() {}, refresh() {},
    });
    const controller = createWorldCreationController({
        worldRuntime: { createBlank: create, importCard: create }, operations, select,
        openModal: (_title, html) => { dom = load('<div id="modal">' + html + '</div>'); modal = wrap(dom('#modal').get(0)); return modal; },
        closeModal: () => closed++, showToast: message => notices.push(message), normalizeError: error => error.message,
        loadWorlds: async () => { if (listFailure) throw new Error('Injected list failure'); }, refresh() {},
        openWorldById: (id, options) => worldController.openById(id, options),
    });
    const file = new File(['{"name":"Synthetic card"}'], 'synthetic.json', { type: 'application/json' });
    if (kind === 'blank') {
        controller.openBlankWorldSheet();
        select('[name="name"]').value = 'New story';
    }
    return { created, activated, worlds, original, notices, operations, worldController,
        set openingFailure(value) { openingFailure = value; }, set listFailure(value) { listFailure = value; },
        set creating(value) { creating = value; }, get closed() { return closed; },
        submit: () => kind === 'blank' ? select('#nora-blank-world-form').fire('submit')
            : controller.handleCharacterImport({ currentTarget: { files: [file], value: 'selected' } }),
    };
}

test('creation and opening share the real world controller and operation registry', async t => {
    const nativeFormData = globalThis.FormData, originalDocument = globalThis.document, originalWindow = globalThis.window;
    globalThis.FormData = class extends nativeFormData {
        constructor(form) { super(); for (const [key, value] of form.fields) this.append(key, value); }
    };
    globalThis.document = { body: { classList: { toggle() {}, remove() {} } } };
    globalThis.window = {};
    t.mock.method(console, 'error', () => {});
    t.after(() => { globalThis.FormData = nativeFormData; globalThis.document = originalDocument; globalThis.window = originalWindow; });
    for (const kind of ['blank', 'import']) {
        await t.test(`${kind}: create then open automatically without self-blocking`, async () => {
            const f = fixture(kind);
            await f.submit();
            assert.equal(f.created.length, 1);
            assert.deepEqual(f.activated, [f.worlds[1].id]);
            assert.equal(f.operations.isBusy('world'), false);
            assert.deepEqual(f.worlds[0], f.original);
            assert.ok(!f.notices.some(message => /另一个世界操作|创建失败|导入失败/.test(message)));
            if (kind === 'blank') assert.equal(f.closed, 1);
        });
        await t.test(`${kind}: activation retry only opens the committed world`, async () => {
            const f = fixture(kind);
            f.openingFailure = true;
            await f.submit();
            assert.equal(f.worlds.length, 2);
            assert.deepEqual(f.activated, []);
            assert.equal(f.operations.isBusy('world'), false);
            assert.ok(f.notices.some(message => message.startsWith(tr('世界已创建，但打开失败：'))
                && message.includes('Injected activation failure')));
            f.openingFailure = false;
            await f.submit();
            assert.equal(f.created.length, 1);
            assert.deepEqual(f.activated, [f.worlds[1].id]);
            assert.deepEqual(f.worlds[0], f.original);
            await f.worldController.openById('existing');
            assert.equal(f.activated.at(-1), 'existing');
            assert.equal(f.operations.isBusy('world'), false);
        });
        await t.test(`${kind}: list refresh retry preserves the committed world`, async () => {
            const f = fixture(kind);
            f.listFailure = true;
            await f.submit();
            f.listFailure = false;
            await f.submit();
            assert.equal(f.created.length, 1);
            assert.deepEqual(f.activated, [f.worlds[1].id]);
            assert.deepEqual(f.worlds[0], f.original);
        });
        await t.test(`${kind}: duplicate submission cannot create another world`, async () => {
            const f = fixture(kind);
            let release;
            f.creating = new Promise(resolve => { release = resolve; });
            const first = f.submit();
            await Promise.resolve();
            assert.equal(f.operations.isBusy('world'), true);
            const duplicate = f.submit();
            release();
            await Promise.all([first, duplicate]);
            assert.equal(f.created.length, 1);
            assert.deepEqual(f.activated, [f.worlds[1].id]);
        });
    }
    await t.test('unrelated active world operation still blocks opening', async () => {
        const f = fixture('blank');
        let release;
        const running = f.operations.run('world', () => new Promise(resolve => { release = resolve; }));
        await Promise.resolve();
        await assert.rejects(f.worldController.openById('existing'), { message: tr('另一个世界操作尚未完成。') });
        assert.deepEqual(f.activated, []);
        release();
        await running;
        await f.worldController.openById('existing');
        assert.deepEqual(f.activated, ['existing']);
    });
});
