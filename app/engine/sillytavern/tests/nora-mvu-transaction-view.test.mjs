import './helpers/nora-locale-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMvuTransactionView } from '../../../native-extensions/nora-ui/mvu-transaction-view.js';

function node() {
    return {
        children: [],
        className: '',
        attributes: {},
        parentElement: null,
        textContent: '',
        append(...children) {
            children.forEach(child => {
                child.parentElement = this;
                this.children.push(child);
            });
        },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
            this.parentElement = null;
        },
    };
}

test('MVU transaction view presents live state and schedules terminal states for dismissal', () => {
    const host = node();
    host.scrollHeight = 120;
    host.scrollTop = 0;
    const timers = [];
    const view = createMvuTransactionView({
        host: () => host,
        createElement: node,
        setTimer: (callback, duration) => { timers.push({ callback, duration }); return timers.length; },
        clearTimer: () => {},
    });

    assert.equal(view.show('syncing'), true);
    assert.equal(host.children[0].attributes['data-status'], 'syncing');
    assert.equal(host.children[0].children[1].textContent, '正在同步MVU变量');
    assert.equal(timers.length, 0);

    view.show('committed');
    assert.equal(host.children.length, 1);
    assert.equal(host.children[0].children[1].textContent, 'MVU变量已更新');
    assert.equal(timers[0].duration, 1000);
    timers[0].callback();
    assert.equal(view.isVisible(), false);
    assert.equal(host.children.length, 0);

    view.show('no-change');
    assert.equal(host.children[0].children[1].textContent, 'MVU变量无变化');
    assert.equal(timers[1].duration, 1000);
    timers[1].callback();

    view.show('failed');
    assert.equal(host.children[0].children[1].textContent, 'MVU变量更新失败');
    assert.equal(timers[2].duration, 3000);
});
