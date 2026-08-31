import assert from 'node:assert/strict';
import test from 'node:test';

import { createDialogController } from '../../../native-extensions/nora-ui/dialog-controller.js';

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
