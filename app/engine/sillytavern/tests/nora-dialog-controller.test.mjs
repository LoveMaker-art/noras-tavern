import assert from 'node:assert/strict';
import test from 'node:test';

import { createDialogController } from '../../../native-extensions/nora-ui/dialog-controller.js';

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
