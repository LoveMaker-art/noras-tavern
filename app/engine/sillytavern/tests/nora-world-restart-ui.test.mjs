import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { createWorldCreationController } from '../../../native-extensions/nora-ui/world-creation-controller.js';

function fixture() {
    let dom, modal, closed = 0, busy = false, failure, openingFailure = false, generating = false;
    const nodes = new WeakMap(), calls = [], openings = [], notices = [];
    const wrap = raw => {
        if (!raw) return null;
        if (nodes.has(raw)) return nodes.get(raw);
        const node = { raw, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; },
            fire(type) { return this.handlers[type]?.({ preventDefault() {}, currentTarget: this }); },
            focus() {}, querySelector(selector) { return select(selector, this); } };
        for (const key of ['value', 'textContent']) Object.defineProperty(node, key, {
            get: () => key === 'value' ? dom(raw).attr('value') || '' : dom(raw).text(),
            set: value => key === 'value' ? dom(raw).attr('value', value) : dom(raw).text(value),
        });
        nodes.set(raw, node); return node;
    };
    const select = (selector, root = modal) => wrap(dom(root.raw).find(selector).get(0));
    const controller = createWorldCreationController({
        worldRuntime: { restartWorld: async args => { calls.push(args); if (failure) throw failure; return { id: 'new-world' }; } },
        operations: { isBusy: () => busy, run: async (_key, fn) => { busy = true; try { return await fn(); } finally { busy = false; } } },
        select, openModal: (_title, html) => { dom = load('<div id="modal">' + html + '</div>'); modal = wrap(dom('#modal').get(0)); return modal; },
        closeModal: () => closed++, showToast: message => notices.push(message), normalizeError: error => error.message,
        loadWorlds: async () => {}, refresh() {}, isGenerating: () => generating,
        openWorldById: async id => { openings.push(id); if (openingFailure) throw new Error('Cannot open'); return { id }; },
    });
    const source = { id: 'old-world', name: '<Original>', revision: 4 };
    return { controller, source, calls, openings, notices, select,
        get closed() { return closed; }, set failure(value) { failure = value; },
        set openingFailure(value) { openingFailure = value; }, set generating(value) { generating = value; },
        submit: () => select('[data-restart-form]').fire('submit'),
    };
}

test('cancel and generation guard create nothing; retry keeps the name and operation identity', async () => {
    const f = fixture();
    f.controller.openRestartWorldSheet(f.source);
    assert.ok(f.select('[name="name"]').value.startsWith('<Original>'));
    await f.select('[data-restart-cancel]').fire('click');
    assert.equal(f.calls.length, 0);
    f.controller.openRestartWorldSheet(f.source);
    f.generating = true;
    await f.submit();
    assert.equal(f.calls.length, 0);
    f.generating = false;
    f.select('[name="name"]').value = 'My new story';
    f.failure = new TypeError('Connection interrupted');
    await f.submit();
    assert.equal(f.calls.length, 1);
    assert.equal(f.select('[type="submit"]').disabled, false);
    f.controller.openRestartWorldSheet(f.source);
    assert.equal(f.select('[name="name"]').value, 'My new story');
    f.failure = null;
    await f.submit();
    assert.deepEqual(f.calls[0], f.calls[1]);
    assert.deepEqual(f.openings, ['new-world']);
    assert.equal(f.source.name, '<Original>');
});

test('activation retry opens the already created World without submitting creation again', async () => {
    const f = fixture();
    f.controller.openRestartWorldSheet(f.source);
    f.openingFailure = true;
    await f.submit();
    assert.equal(f.calls.length, 1);
    assert.equal(f.closed, 0);
    f.openingFailure = false;
    await f.submit();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.openings, ['new-world', 'new-world']);
    assert.equal(f.closed, 1);
});
