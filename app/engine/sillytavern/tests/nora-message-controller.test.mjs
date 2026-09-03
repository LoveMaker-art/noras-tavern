import './helpers/nora-locale-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMessageController } from '../../../native-extensions/nora-ui/message-controller.js';

function createHarness({ messages = {}, model = {}, retryResult = { status: 'completed' }, failure = null, storyActive = false, messageView = {} } = {}) {
    const notices = [];
    const toasts = [];
    let cleared = 0;
    let submissions = 0;
    let cancellations = 0;
    let modelSheets = 0;
    const input = {
        value: '保留这条草稿',
        style: {},
        scrollHeight: 39,
    };
    const send = {
        classList: { toggle: () => {} },
        disabled: false,
        innerHTML: '',
        setAttribute: () => {},
    };
    const select = selector => ({
        '#nora-input': input,
        '#nora-send': send,
    })[selector] || null;
    const dialogs = {
        normalizeError: error => String(error?.message || error || ''),
        toast: message => toasts.push(message),
        notice: value => notices.push(value),
        clearNotice: () => { cleared += 1; },
    };
    const operations = {
        run: async (_scope, operation) => operation(),
        isBusy: () => false,
    };
    const storyActions = {
        status: () => ({ active: storyActive, retryable: Boolean(failure), persisted: failure?.persisted ?? null }),
        execute: async (command) => {
            if (command.type === 'story.retry') return retryResult;
            if (command.type === 'story.send') submissions += 1;
            return { status: 'completed' };
        },
        cancel: async () => {
            cancellations += 1;
            return { status: 'stopping' };
        },
    };
    const controller = createMessageController({
        messages: { isGenerating: () => false, ...messages },
        model: { assertModelConfigured: () => {}, ...model },
        operations,
        storyActions,
        dialogs,
        messageView,
        select,
        icons: { send: 'send', stop: 'stop' },
        readState: () => ({ messages: [] }),
        currentCharacter: () => ({}),
        getSmartReplyController: () => null,
        openModelSheet: async () => { modelSheets += 1; },
        recordBootMilestone: () => {},
    });
    return {
        controller,
        input,
        send,
        notices,
        toasts,
        counts: () => ({ cancellations, cleared, submissions, modelSheets }),
    };
}

test('missing model configuration preserves the draft and offers configuration without retry', async (context) => {
    globalThis.window = { __NORA_BOOT_METRICS__: { startedAt: performance.now() } };
    context.after(() => { delete globalThis.window; });
    const error = Object.assign(new Error('模型密钥缺失。'), { code: 'NORA_MODEL_CONFIGURATION_REQUIRED' });
    const harness = createHarness({
        model: { assertModelConfigured: () => { throw error; } },
    });

    await harness.controller.sendMessage({ preventDefault: () => {} });

    assert.equal(harness.input.value, '保留这条草稿');
    assert.equal(harness.counts().submissions, 0);
    assert.equal(harness.notices.length, 1);
    assert.equal(harness.notices[0].title, '尚未配置文本模型');
    assert.equal(harness.notices[0].message, '请先完成模型配置后再发送。');
    assert.equal('placement' in harness.notices[0], false);
    assert.equal('dismissible' in harness.notices[0], false);
    assert.deepEqual(harness.notices[0].actions.map(action => action.label), ['配置模型']);
});

test('transient generation errors keep retry and expose an immediate retrying state', async () => {
    const harness = createHarness({ failure: { text: '重试内容', persisted: true } });
    harness.controller.showSendError(new Error('network unavailable'));

    assert.deepEqual(harness.notices[0].actions.map(action => action.label), ['重试', '模型设置']);
    const result = await harness.notices[0].actions[0].run();

    assert.equal(result.status, 'completed');
    assert.equal(harness.notices[1].title, '正在重试');
    assert.equal(harness.notices[1].message, '正在重新连接并发送…');
    assert.equal(harness.notices[1].transient, true);
    assert.equal(harness.counts().cleared, 1);
});

test('a TavernHelper sidecar generation does not turn the story composer into a stop button', async (context) => {
    globalThis.window = { __NORA_BOOT_METRICS__: { startedAt: performance.now() } };
    context.after(() => { delete globalThis.window; });
    const harness = createHarness({ messages: { isGenerating: () => true }, storyActive: false });

    await harness.controller.sendMessage({ preventDefault: () => {} });

    assert.equal(harness.counts().submissions, 1);
    assert.equal(harness.counts().cancellations, 0);
});

test('MVU transaction feedback blocks only a second send and restores the composer after commit', async (context) => {
    globalThis.window = { __NORA_BOOT_METRICS__: { startedAt: performance.now() } };
    context.after(() => { delete globalThis.window; });
    const statuses = [];
    const harness = createHarness({
        messageView: { showMvuTransaction: status => statuses.push(status) },
    });

    harness.controller.setMvuTransaction({ status: 'syncing' });
    assert.equal(harness.controller.isMvuSyncing(), true);
    assert.equal(harness.send.disabled, true);
    await harness.controller.sendMessage({ preventDefault: () => {} });
    assert.equal(harness.counts().submissions, 0);
    assert.deepEqual(harness.toasts, ['正在同步MVU变量，请稍候。']);

    harness.controller.setMvuTransaction({ status: 'committed' });
    assert.equal(harness.controller.isMvuSyncing(), false);
    assert.equal(harness.send.disabled, false);
    assert.deepEqual(statuses, ['syncing', 'committed']);
});
