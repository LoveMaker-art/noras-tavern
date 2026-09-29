import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatActivityClient } from '../public/scripts/nora-story-ledger/chat-activity.js';

function fixture() {
    let scope = { worldId: 'world:a', sessionId: 'session:a' }, timer, rejectRenew = false;
    const calls = [];
    const client = createChatActivityClient({
        current: () => ({ scope, revision: 'revision-a' }),
        request: async (action, data) => {
            calls.push({ action, ...data });
            if (action === 'renew' && rejectRenew) throw new Error('lease lost');
            return action === 'begin' ? { token: `token-${data.worldId}`, expiresAt: Date.now() + 120000 } : {};
        },
        setTimer: callback => { timer = callback; return 1; }, clearTimer: () => { timer = null; },
    });
    return { client, calls, currentScope: () => scope, change: () => { scope = { worldId: 'world:b', sessionId: 'session:b' }; },
        failRenew: () => { rejectRenew = true; }, tick: () => timer?.() };
}

test('one generation owns nested MVU and all saves until the final awaited operation settles', async () => {
    const f = fixture();
    await f.client.run('generation', async () => {
        assert.equal(f.client.tokenFor(f.currentScope()), 'token-world:a');
        await f.client.run('mvu', async () => { assert.equal(f.client.tokenFor(f.currentScope()), 'token-world:a'); });
        assert.equal(f.calls.filter(call => call.action === 'end').length, 0);
    });
    assert.deepEqual(f.calls.map(call => call.action), ['begin', 'end']);
    assert.equal(f.client.tokenFor(f.currentScope()), null);
});

test('lease loss fences saves, surfaces the failure and never renews an already finished operation', async () => {
    const f = fixture();
    await assert.rejects(f.client.run('generation', async () => {
        f.failRenew(); await f.tick();
        assert.throws(() => f.client.tokenFor(f.currentScope()), { code: 'NORA_CHAT_OPERATION_STALE' });
    }), { code: 'NORA_CHAT_OPERATION_STALE' });
    const count = f.calls.length;
    await f.tick();
    assert.equal(f.calls.length, count);
});

test('switching World never lends the old token to the new chat and errors still release the old owner', async () => {
    const f = fixture();
    await assert.rejects(f.client.run('generation', async () => {
        f.change();
        assert.equal(f.client.tokenFor(f.currentScope()), null);
        await f.client.run('mvu', async () => assert.equal(f.client.tokenFor(f.currentScope()), 'token-world:b'));
        throw new Error('original operation failed');
    }), /original operation failed/);
    assert.deepEqual(f.calls.filter(call => call.action === 'end').map(call => call.worldId), ['world:b', 'world:a']);
});

test('a new operation waits for release acknowledgement instead of joining a closing lease', async () => {
    const calls = [], scope = { worldId: 'world:a', sessionId: 'session:a' };
    let finishEnd, startedEnd;
    const ending = new Promise(resolve => { startedEnd = resolve; });
    const client = createChatActivityClient({ current: () => ({ scope, revision: 'r' }),
        request: async action => {
            calls.push(action);
            if (action === 'end' && !finishEnd) {
                startedEnd(); await new Promise(resolve => { finishEnd = resolve; });
            }
            return { token: 'owned' };
        }, setTimer: () => 1, clearTimer() {},
    });
    const first = client.run('generation', async () => {});
    await ending;
    const second = client.run('mvu', async () => {});
    await Promise.resolve();
    assert.deepEqual(calls, ['begin', 'end']);
    finishEnd();
    await Promise.all([first, second]);
    assert.deepEqual(calls, ['begin', 'end', 'begin', 'end']);
});
