import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatWriteQueue, requestChatWrite } from '../public/scripts/nora-story-ledger/chat-persistence.js';

test('a failed queued job releases busy state and does not poison later jobs', async () => {
    const busy = [], calls = [];
    const enqueue = createChatWriteQueue(value => busy.push(value));
    const first = enqueue(async () => { calls.push(1); throw new Error('rejected'); });
    const second = enqueue(async () => { calls.push(2); return 'saved'; });
    await assert.rejects(first, /rejected/);
    assert.equal(await second, 'saved');
    assert.deepEqual(calls, [1, 2]);
    assert.equal(busy.at(-1), false);
});

for (const phase of ['headers', 'body']) {
    test(`request timeout aborts while waiting for ${phase}`, async t => {
        let aborted = false;
        t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
            const wait = () => new Promise((resolve, reject) => signal.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('aborted'));
            }, { once: true }));
            return phase === 'headers' ? wait() : { ok: true, json: wait };
        });
        await assert.rejects(requestChatWrite('/save', {}, 15), { code: 'NORA_CHAT_SAVE_TIMEOUT', phase: 'save' });
        assert.equal(aborted, true);
    });
}
