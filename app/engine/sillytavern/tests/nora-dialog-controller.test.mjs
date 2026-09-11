import assert from 'node:assert/strict';
import test from 'node:test';

import { createDialogController } from '../../../native-extensions/nora-ui/dialog-controller.js';

function sheetFixture() {
    const controls = new Map();
    const make = () => ({ attrs: {}, classList: { remove() {} },
        setAttribute(key, value) { this.attrs[key] = value; },
        addEventListener(_type, fn) { this.click = fn; }, focus() {} });
    let rebuilds = 0, body;
    const title = make(), close = make();
    const header = { firstElementChild: title, children: [title, close],
        replaceChildren(...children) { this.children = children; } };
    const sheet = make();
    const modal = { className: '', childNodes: [], setAttribute() {},
        set innerHTML(value) {
            rebuilds++;
            this.markup = value;
            this.childNodes = [sheet];
            body = value.includes('nora-dialog--sheet') ? {
                ownerDocument: { createElement: () => ({ content: { querySelector: () => null } }) },
                replaceChildren(content) { this.content = content; this.updates = (this.updates || 0) + 1; },
                querySelector: () => null, contains: () => false, scrollTop: 0,
            } : null;
        },
        querySelector: selector => selector === '.nora-sheet' ? (body ? sheet : null) : null,
        replaceChildren(...nodes) { this.childNodes = nodes; },
    };
    modal.classList = { contains: value => modal.className.split(' ').includes(value) };
    const select = selector => {
        if (selector === '#nora-modal') return modal;
        if (selector === '.nora-sheet-body') return body;
        if (selector === '.nora-dialog' || selector === '.nora-sheet') return body ? sheet : null;
        if (selector === 'header') return header;
        if (selector === 'header h2') return title;
        if (selector === '.nora-modal-close') return close;
        if (!controls.has(selector)) controls.set(selector, make());
        return controls.get(selector);
    };
    return { dialogs: createDialogController({ select, selectAll: () => [], escapeHtml: String, closeIcon: 'x' }),
        modal, header, title, close, select, body: () => body, rebuilds: () => rebuilds };
}

test('ordinary list/detail/editor navigation reuses the shell without a library key', () => {
    const f = sheetFixture();
    f.dialogs.open('List', '<p>List</p>', 'list');
    const body = f.body();
    f.header.children.splice(1, 0, { transientImportButton: true });
    f.dialogs.open('Detail', '<p>Detail</p>', 'detail');
    f.dialogs.open('Editor', '<form></form>', 'editor');
    f.dialogs.open('List', '<p>List</p>', 'list');
    assert.equal(f.rebuilds(), 1);
    assert.equal(f.body(), body);
    assert.equal(body.updates, 3);
    assert.equal(f.title.textContent, 'List');
    assert.deepEqual(f.header.children, [f.title, f.close]);
    assert.equal(f.modal.className, 'nora-modal open list');
    f.close.click();
    f.dialogs.open('Again', '<p>Again</p>');
    assert.match(f.modal.markup, /nora-dialog--entering/);
    assert.notEqual(f.body(), body);
});

test('opening a page dismisses an outstanding confirmation without restoring an obsolete page', async () => {
    const f = sheetFixture();
    f.dialogs.open('Editor', '<form></form>');
    const confirmation = f.dialogs.confirm({ title: 'Delete?', body: 'Confirm', restoreSheet: true });
    let result = 'pending';
    confirmation.then(value => { result = value; });
    f.dialogs.open('New page', '<p>New page</p>');
    await Promise.resolve();
    assert.equal(result, false);
    assert.match(f.modal.markup, /New page/);
});

test('editor confirmation restores the same draft nodes and handlers on accept, cancel and dismissal', async () => {
    for (const action of ['accept', 'cancel', 'dismiss']) {
        const draft = { value: 'unsaved edit', listener: () => {} };
        const modal = { className: 'nora-modal open nora-test-editor', childNodes: [draft], attrs: {},
            querySelector: () => draft, setAttribute(key, value) { this.attrs[key] = value; },
            replaceChildren(...nodes) { this.childNodes = nodes; },
            set innerHTML(value) { this.childNodes = []; this.markup = value; },
        };
        modal.classList = { contains: value => modal.className.split(' ').includes(value) };
        const controls = new Map();
        const select = selector => {
            if (selector === '#nora-modal') return modal;
            if (!controls.has(selector)) controls.set(selector, { addEventListener(_type, fn) { this.click = fn; }, focus() {} });
            return controls.get(selector);
        };
        const dialogs = createDialogController({ select, selectAll: () => [], escapeHtml: String });
        const result = dialogs.confirm({ title: 'Delete?', body: 'Confirm', restoreSheet: true });
        assert.equal(modal.childNodes.length, 0);
        if (action === 'dismiss') dialogs.close();
        else select(action === 'accept' ? '.nora-confirm-submit' : '.nora-confirm-cancel').click();
        assert.equal(await result, action === 'accept');
        assert.equal(modal.childNodes[0], draft);
        assert.equal(modal.childNodes[0].value, 'unsaved edit');
        assert.equal(modal.childNodes[0].listener, draft.listener);
        assert.equal(modal.className, 'nora-modal open nora-test-editor');
        assert.equal(modal.attrs['aria-hidden'], 'false');
    }
});

test('a persistent notice renders adaptive sections and exposes a working close action', () => {
    const element = { dataset: {}, hidden: true, innerHTML: '' };
    const close = {
        addEventListener(type, listener) {
            if (type === 'click') this.click = listener;
        },
    };
    const controller = createDialogController({
        select: (selector, root) => {
            if (selector === '#nora-composer-notice') return element;
            if (selector === '[data-notice-close]' && root === element) return close;
            return null;
        },
        selectAll: () => [],
        escapeHtml: value => String(value),
        closeIcon: 'close',
    });

    controller.notice({
        title: '尚未配置文本模型',
        message: '请先完成模型配置后再发送。',
    });

    assert.equal(element.dataset.state, 'persistent');
    assert.match(element.innerHTML, /class="nora-notice-head"/);
    assert.match(element.innerHTML, /class="nora-notice-message"/);
    assert.match(element.innerHTML, /data-notice-close/);
    assert.equal(element.hidden, false);
    close.click();
    assert.equal(element.hidden, true);
    assert.equal(element.innerHTML, '');
    assert.equal(element.dataset.state, undefined);
});

test('a transient notice uses the same structure without a close action', () => {
    const element = { dataset: {}, hidden: true, innerHTML: '' };
    const controller = createDialogController({
        select: selector => selector === '#nora-composer-notice' ? element : null,
        selectAll: () => [],
        escapeHtml: value => String(value),
        closeIcon: 'close',
    });

    controller.notice({ title: '正在重试', message: '正在重新连接并发送…', transient: true });

    assert.equal(element.dataset.state, 'transient');
    assert.match(element.innerHTML, /class="nora-notice-head"/);
    assert.match(element.innerHTML, /class="nora-notice-message"/);
    assert.doesNotMatch(element.innerHTML, /data-notice-close/);
});
