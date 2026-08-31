import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoryActionDispatcher } from '../../../native-extensions/nora-ui/story-action-dispatcher.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, decline) => {
        resolve = accept;
        reject = decline;
    });
    return { promise, resolve, reject };
}

test('story send crosses one dispatcher seam and reports the observable result', async () => {
    const calls = [];
    const dispatcher = createStoryActionDispatcher({
        messages: {
            isGenerating: () => false,
            sendText: async text => {
                calls.push(text);
                return 'reply';
            },
        },
        hasWorld: () => true,
        createActionId: () => 'action-send',
    });

    const result = await dispatcher.execute({ type: 'story.send', text: '开启轮回' });

    assert.deepEqual(calls, ['开启轮回']);
    assert.deepEqual(result, {
        status: 'completed',
        type: 'story.send',
        scope: 'story',
        actionId: 'action-send',
        value: 'reply',
    });
    assert.deepEqual(dispatcher.status('story'), { active: false, type: null, retryable: false, persisted: null });
});

test('duplicate story actions join one task and cancel uses the same lifecycle', async () => {
    const pending = deferred();
    const sent = [];
    let generating = false;
    let stops = 0;
    const dispatcher = createStoryActionDispatcher({
        messages: {
            isGenerating: () => generating,
            sendText: async text => {
                sent.push(text);
                return pending.promise;
            },
            stop: async () => { stops += 1; },
        },
        hasWorld: () => true,
    });

    const first = dispatcher.execute({ type: 'story.send', text: '第一条', actionId: 'same-action' });
    const duplicate = dispatcher.execute({ type: 'story.send', text: '第一条', actionId: 'same-action' });
    assert.equal(first, duplicate);
    assert.deepEqual(dispatcher.status('story'), { active: true, type: 'story.send', retryable: false, persisted: null });
    pending.resolve('reply');
    await first;
    assert.deepEqual(sent, ['第一条']);

    generating = true;
    const stopped = await dispatcher.cancel('story');
    assert.equal(stopped.status, 'stopping');
    assert.equal(stops, 1);
});

test('story and sidecar commands keep their semantics and independent scopes', async () => {
    const calls = [];
    const dispatcher = createStoryActionDispatcher({
        messages: {
            isGenerating: () => false,
            regenerate: async () => calls.push(['regenerate']),
            editAndRegenerate: async (id, text) => calls.push(['edit-and-regenerate', id, text]),
            suggestReplies: async () => ['一', '二', '三'],
            swipe: async (id, direction) => calls.push(['swipe', id, direction]),
            editMessage: async (id, text) => calls.push(['edit', id, text]),
        },
        hasWorld: () => true,
    });

    assert.equal((await dispatcher.execute({ type: 'story.regenerate' })).status, 'completed');
    assert.equal((await dispatcher.execute({ type: 'story.edit-and-regenerate', id: 7, text: '改写' })).status, 'completed');
    const suggested = await dispatcher.execute({ type: 'sidecar.suggest-replies' });
    assert.deepEqual(suggested.value, ['一', '二', '三']);
    assert.equal(suggested.scope, 'sidecar:suggest-replies');
    assert.equal((await dispatcher.execute({ type: 'story.swipe', id: 8, direction: 'right' })).status, 'completed');
    assert.equal((await dispatcher.execute({ type: 'story.edit', id: 9, text: '修订' })).status, 'completed');

    assert.deepEqual(calls, [
        ['regenerate'],
        ['edit-and-regenerate', 7, '改写'],
        ['swipe', 8, 'right'],
        ['edit', 9, '修订'],
    ]);
});

test('failed story sends preserve retry semantics without duplicating persisted messages', async () => {
    const drafts = [];
    let sends = 0;
    let regenerations = 0;
    const persistedFailure = Object.assign(new Error('empty response'), { noraMessagePersisted: true });
    const dispatcher = createStoryActionDispatcher({
        messages: {
            isGenerating: () => false,
            sendText: async () => {
                sends += 1;
                throw persistedFailure;
            },
            regenerate: async () => { regenerations += 1; },
        },
        hasWorld: () => true,
        restoreDraft: text => drafts.push(text),
    });

    const failed = await dispatcher.execute({ type: 'story.send', text: '继续故事' });
    const retried = await dispatcher.execute({ type: 'story.retry' });

    assert.equal(failed.status, 'failed');
    assert.equal(failed.persisted, true);
    assert.equal(retried.status, 'completed');
    assert.equal(retried.type, 'story.regenerate');
    assert.equal(sends, 1);
    assert.equal(regenerations, 1);
    assert.deepEqual(drafts, []);
    assert.equal(dispatcher.status('story').retryable, false);
});

test('unpersisted send failures restore the draft and retry the original text', async () => {
    const drafts = [];
    let sends = 0;
    const dispatcher = createStoryActionDispatcher({
        messages: {
            isGenerating: () => false,
            sendText: async () => {
                sends += 1;
                if (sends === 1) throw new Error('network unavailable');
                return 'reply';
            },
        },
        hasWorld: () => true,
        restoreDraft: text => drafts.push(text),
    });

    const failed = await dispatcher.execute({ type: 'story.send', text: '不要丢失' });
    const retried = await dispatcher.execute({ type: 'story.retry' });

    assert.equal(failed.persisted, false);
    assert.deepEqual(drafts, ['不要丢失']);
    assert.equal(retried.type, 'story.send');
    assert.equal(sends, 2);
});

test('dispatcher owns generation state, timing and task evidence', async () => {
    const states = [];
    const metrics = [];
    const events = [];
    let completed = 0;
    const clock = [10, 42];
    const dispatcher = createStoryActionDispatcher({
        messages: {
            isGenerating: () => false,
            sendText: async () => 'reply',
        },
        hasWorld: () => true,
        now: () => clock.shift(),
        createActionId: () => 'action-1',
        onGenerationState: state => states.push(state),
        onGenerationCompleted: () => { completed += 1; },
        onGenerationSettled: metric => metrics.push(metric),
        onTaskEvent: event => events.push(event),
    });

    const result = await dispatcher.execute({ type: 'story.send', text: '继续' });

    assert.equal(result.actionId, 'action-1');
    assert.deepEqual(states, [true, false]);
    assert.equal(completed, 1);
    assert.deepEqual(metrics, [{
        actionId: 'action-1',
        type: 'story.send',
        scope: 'story',
        status: 'completed',
        persisted: undefined,
        duration: 32,
    }]);
    assert.deepEqual(events.map(event => event.phase), ['started', 'completed']);
});

test('sidecar tasks are independently tracked and cancelled by their own scope', async () => {
    let cancelCalls = 0;
    const dispatcher = createStoryActionDispatcher({
        messages: { isGenerating: () => false },
        hasWorld: () => true,
        createActionId: () => 'helper-generation-1',
    });

    const running = dispatcher.execute({
        type: 'sidecar.run',
        key: 'helper-generation-1',
        run: ({ signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' })), { once: true });
        }),
        cancel: () => { cancelCalls += 1; },
    });

    assert.deepEqual(dispatcher.status('sidecar:helper-generation-1'), {
        active: true,
        type: 'sidecar.run',
        retryable: false,
        persisted: null,
    });
    const cancelling = await dispatcher.cancel('sidecar:helper-generation-1');
    const result = await running;

    assert.equal(cancelling.status, 'cancelling');
    assert.equal(result.status, 'cancelled');
    assert.equal(cancelCalls, 1);
    assert.equal(dispatcher.status('sidecar:helper-generation-1').active, false);
});

test('stopping an active story marks it cancelled before the engine rejects its request', async () => {
    const pending = deferred();
    const errors = [];
    const drafts = [];
    const dispatcher = createStoryActionDispatcher({
        messages: {
            isGenerating: () => true,
            sendText: () => pending.promise,
            stop: async () => pending.reject(new Error('engine request stopped')),
        },
        hasWorld: () => true,
        restoreDraft: text => drafts.push(text),
        onGenerationError: error => errors.push(error),
    });

    const running = dispatcher.execute({ type: 'story.send', text: '正在生成' });
    await Promise.resolve(); // The fixture request must have started before stop rejects it.
    const stopping = await dispatcher.cancel('story');
    const result = await running;

    assert.equal(stopping.status, 'stopping');
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(errors, []);
    assert.deepEqual(drafts, []);
});
