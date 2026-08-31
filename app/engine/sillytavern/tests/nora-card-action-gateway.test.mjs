import assert from 'node:assert/strict';
import test from 'node:test';

import { createCardActionGateway } from '../../../native-extensions/nora-ui/card-action-gateway.js';

function createWindowHarness() {
    const listeners = new Set();
    return {
        addEventListener(type, listener) {
            if (type === 'message') listeners.add(listener);
        },
        removeEventListener(type, listener) {
            if (type === 'message') listeners.delete(listener);
        },
        async dispatch(event) {
            await Promise.all([...listeners].map(listener => listener(event)));
            await new Promise(resolve => setImmediate(resolve));
        },
        listenerCount: () => listeners.size,
    };
}

test('trusted card completion requests enter the canonical story dispatcher exactly once', async () => {
    const trusted = {};
    const commands = [];
    const gateway = createCardActionGateway({
        storyActions: {
            execute: async command => {
                commands.push(command);
                return { status: 'completed', type: command.type };
            },
            cancel: async () => ({ status: 'stopping' }),
        },
        isEmbeddedSource: source => source === trusted,
    });

    const result = await gateway.handle({
        source: trusted,
        data: { type: 'request_chat_completion', user_input: '开启轮回' },
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(commands, [{
        type: 'story.send',
        text: '开启轮回',
        origin: 'card.post-message',
    }]);
});

test('untrusted and unrelated frame messages are ignored while unknown card actions fail visibly', async () => {
    const trusted = {};
    const unsupported = [];
    const gateway = createCardActionGateway({
        storyActions: {
            execute: async () => ({ status: 'completed' }),
            cancel: async () => ({ status: 'stopping' }),
        },
        isEmbeddedSource: source => source === trusted,
        onUnsupported: result => unsupported.push(result),
    });

    assert.equal((await gateway.handle({ source: {}, data: { type: 'request_chat_completion', user_input: '忽略' } })).status, 'ignored');
    assert.equal((await gateway.handle({ source: trusted, data: { type: 'iframe_resize' } })).status, 'ignored');
    const result = await gateway.handle({ source: trusted, data: { type: 'request_chat_unknown' } });

    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'NORA_UNSUPPORTED_CARD_ACTION');
    assert.equal(unsupported.length, 1);
});

test('gateway installation is idempotent and stop removes its message listener', async () => {
    const windowRef = createWindowHarness();
    const trusted = {};
    let sends = 0;
    const gateway = createCardActionGateway({
        windowRef,
        storyActions: {
            execute: async () => { sends += 1; return { status: 'completed' }; },
            cancel: async () => ({ status: 'stopping' }),
        },
        isEmbeddedSource: source => source === trusted,
    });

    gateway.start();
    gateway.start();
    assert.equal(windowRef.listenerCount(), 1);
    await windowRef.dispatch({ source: trusted, data: { type: 'request_chat_completion', user_input: '继续' } });
    assert.equal(sends, 1);

    gateway.stop();
    assert.equal(windowRef.listenerCount(), 0);
});

test('trusted card stop requests cancel the canonical story scope', async () => {
    const trusted = {};
    const cancelled = [];
    const gateway = createCardActionGateway({
        storyActions: {
            execute: async () => ({ status: 'completed' }),
            cancel: async scope => {
                cancelled.push(scope);
                return { status: 'stopping', scope };
            },
        },
        isEmbeddedSource: source => source === trusted,
    });

    const result = await gateway.handle({ source: trusted, data: { type: 'request_chat_stop' } });

    assert.deepEqual(cancelled, ['story']);
    assert.equal(result.status, 'stopping');
});
