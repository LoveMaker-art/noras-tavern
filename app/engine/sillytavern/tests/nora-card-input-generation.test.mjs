import './helpers/nora-locale-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteractionBridge } from '../public/scripts/nora-compat/interaction-bridge.js';
import { createStMessageAdapter } from '../public/scripts/nora-adapters/st-message-adapter.js';
import { createTavernHelperActionAdapter } from '../public/scripts/nora-adapters/tavern-helper-action-adapter.js';
import { createStoryActionDispatcher } from '../../../native-extensions/nora-ui/story-action-dispatcher.js';
import { createMessageController } from '../../../native-extensions/nora-ui/message-controller.js';
import { createStartupController } from '../../../native-extensions/nora-ui/startup-controller.js';

function deferred() {
    let resolve;
    const promise = new Promise(accept => { resolve = accept; });
    return { promise, resolve };
}

function harness(t, { failPreparation = false, failGeneration = false } = {}) {
    const noop = () => {};
    const classList = { toggle: noop, contains: () => false };
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { classList } } });
    let busy = false, pending = false, stopped = 0, handlers, controller;
    const entered = deferred(), completion = deferred();
    const input = { value: '', style: {}, scrollHeight: 20 };
    const send = { classList, setAttribute: noop };
    const runtime = {
        chat: [],
        isGenerating: () => busy,
        stopGeneration: () => { stopped++; completion.resolve(); },
        executeSlashCommandsWithOptions: async (text, { abortController }) => {
            if (text === '/echo hello') return { pipe: 'hello' };
            // This is the native /trigger contract: prepare, then Generate().
            await abortController.noraPrepareGeneration();
            handlers.generationChanged(true); // ST emits this before is_send_press becomes true.
            busy = true;
            entered.resolve();
            try {
                await completion.promise;
                if (failGeneration) throw new Error('test model failure');
                return { pipe: 'reply' };
            } finally {
                busy = false;
                handlers.generationChanged(false);
            }
        },
    };
    const messages = createStMessageAdapter(() => runtime, {
        ensureBackendReady: async () => {
            if (failPreparation) throw new Error('test preparation failure');
        },
    });
    const actions = createStoryActionDispatcher({ messages, getSessionKey: () => 'test-session',
        onGenerationState: value => controller.setGenerating(value || messages.isGenerating()),
    });
    controller = createMessageController({ messages, storyActions: actions,
        messageView: { beginPending: () => { pending = true; }, clearPending: () => { pending = false; } },
        select: key => ({ '#nora-input': input, '#nora-send': send })[key],
        icons: { send: 'send', stop: 'stop' }, readState: () => ({}), currentCharacter: () => ({}),
        dialogs: {}, getSessionKey: () => 'test-session',
    });
    createStartupController({ state: { subscribe: value => { handlers = value; } }, messageController: controller }).wireEvents();
    const globalRef = { TavernHelper: { generate: noop, generateRaw: noop, triggerSlash: noop,
        triggerSlashWithResult: noop, createChatMessages: async items => { runtime.chat.push(...items); } } };
    const helper = createTavernHelperActionAdapter({ storyActions: actions, messages, globalRef, bridge: createInteractionBridge() });
    helper.start();
    const inFlight = [];
    const trackedHelper = Object.fromEntries(['createChatMessages', 'triggerSlash', 'triggerSlashWithResult'].map(method => [method, (...args) => {
        const result = globalRef.TavernHelper[method](...args);
        inFlight.push(result);
        return result;
    }]));
    t.after(async () => {
        completion.resolve();
        await Promise.allSettled(inFlight);
        helper.stop();
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else delete globalThis.document;
    });
    return { helper: trackedHelper, actions, controller, entered, completion, send,
        pending: () => pending, stopped: () => stopped, runtime };
}

for (const method of ['triggerSlash', 'triggerSlashWithResult']) {
    test(`card ${method} /trigger shows pending and stop control until generation settles`, async t => {
        const h = harness(t);
        await h.helper.createChatMessages([{ role: 'user', message: '普通技术测试' }]);
        assert.equal(h.pending(), false, 'Writing a message alone must not imply model generation');
        const result = h.helper[method]('/trigger');
        await h.entered.promise;
        assert.equal(h.runtime.isGenerating(), true);
        assert.equal(h.pending(), true, 'Card input must show the same waiting feedback as the main composer');
        assert.equal(h.controller.isGenerating(), true);
        assert.equal(h.send.innerHTML, 'stop');
        assert.equal(h.actions.status('visible').active, true);
        h.completion.resolve();
        assert.equal(await result, 'reply');
        assert.equal(h.pending(), false);
        assert.equal(h.send.innerHTML, 'send');
        assert.equal(h.actions.status('all').active, false);
    });
}

test('non-generating card commands never display thinking', async t => {
    const h = harness(t);
    assert.equal(await h.helper.triggerSlash('/echo hello'), 'hello');
    assert.equal(h.pending(), false);
    assert.equal(h.controller.isGenerating(), false);
});

test('card generation preparation failure does not leave pending feedback behind', async t => {
    const h = harness(t, { failPreparation: true });
    await assert.rejects(h.helper.triggerSlash('/trigger'), /test preparation failure/);
    assert.equal(h.pending(), false);
    assert.equal(h.controller.isGenerating(), false);
    assert.equal(h.actions.status('all').active, false);
});

test('model failure clears the card generation indicator', async t => {
    const h = harness(t, { failGeneration: true });
    const result = h.helper.triggerSlash('/trigger');
    const rejection = assert.rejects(result, /test model failure/);
    await h.entered.promise;
    assert.equal(h.pending(), true);
    h.completion.resolve();
    await rejection;
    assert.equal(h.pending(), false);
    assert.equal(h.controller.isGenerating(), false);
});

test('visible stop cancels generation started from card input', async t => {
    const h = harness(t);
    const result = h.helper.triggerSlash('/trigger');
    const rejection = assert.rejects(result, { name: 'AbortError' });
    await h.entered.promise;
    assert.equal(h.pending(), true);
    await h.actions.cancel('visible');
    await rejection;
    assert.equal(h.stopped(), 1);
    assert.equal(h.pending(), false);
    assert.equal(h.controller.isGenerating(), false);
});

test('MVU handoff is not replaced with thinking during a card-triggered generation', async t => {
    const h = harness(t);
    const result = h.helper.triggerSlash('/trigger');
    await h.entered.promise;
    assert.equal(h.pending(), true);
    h.controller.setMvuTransaction({ status: 'syncing' });
    assert.equal(h.pending(), false);
    h.controller.syncGenerating();
    assert.equal(h.pending(), false);
    h.completion.resolve();
    await result;
    h.controller.setMvuTransaction({ status: 'committed' });
    assert.equal(h.controller.isGenerating(), false);
});
