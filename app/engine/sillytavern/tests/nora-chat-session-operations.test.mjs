import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatSessionOperations } from '../src/chat-session-operations.js';

const scope = { worldId: 'world:a', sessionId: 'session:a' };
const other = { worldId: 'world:b', sessionId: 'session:b' };

test('generation and MVU ownership exclude restoration and other pages, but not another World', async () => {
    const operations = createChatSessionOperations();
    const lease = operations.begin(scope, 'generation');
    assert.throws(() => operations.begin(scope, 'mvu'), { code: 'NORA_CHAT_OPERATION_BUSY' });
    await assert.rejects(operations.restore(scope, () => assert.fail('must not restore')), { code: 'NORA_CHAT_OPERATION_BUSY' });
    await assert.rejects(operations.write(scope, null, () => assert.fail('another page must not save')), { code: 'NORA_CHAT_OPERATION_BUSY' });
    assert.equal(await operations.write(scope, lease.token, () => 'saved by owner'), 'saved by owner');
    assert.equal(await operations.restore(other, () => 'other world'), 'other world');
    operations.end(scope, lease.token);
    assert.equal(await operations.restore(scope, () => 'restored after generation'), 'restored after generation');
});

test('expired or released tokens cannot renew or save after a restore or new generation', async () => {
    let clock = 0;
    const operations = createChatSessionOperations({ now: () => clock, leaseMs: 100 });
    const old = operations.begin(scope, 'mvu');
    clock = 80;
    assert.equal(operations.renew(scope, old.token).expiresAt, 180);
    clock = 181;
    assert.throws(() => operations.renew(scope, old.token), { code: 'NORA_CHAT_OPERATION_STALE' });
    await operations.restore(scope, () => {});
    const fresh = operations.begin(scope, 'generation');
    await assert.rejects(operations.write(scope, old.token, () => assert.fail('expired task must not overwrite')), { code: 'NORA_CHAT_OPERATION_STALE' });
    assert.equal(operations.end(scope, old.token), false, 'late release cannot unlock a new owner');
    assert.throws(() => operations.begin(scope, 'generation'), { code: 'NORA_CHAT_OPERATION_BUSY' });
    operations.end(scope, fresh.token);
    await assert.rejects(operations.write(scope, fresh.token, () => assert.fail('released task must not write')), { code: 'NORA_CHAT_OPERATION_STALE' });
});

test('expiry and release never interrupt a running canonical write or permit overlapping restore', async () => {
    let clock = 0, enter, release;
    const operations = createChatSessionOperations({ now: () => clock, leaseMs: 100 });
    const lease = operations.begin(scope, 'generation');
    const reached = new Promise(resolve => { enter = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const saving = operations.write(scope, lease.token, async () => { enter(); await wait; return 'saved'; });
    await reached;
    clock = 101;
    operations.end(scope, lease.token);
    await assert.rejects(operations.restore(scope, () => assert.fail('save still in flight')), { code: 'NORA_CHAT_OPERATION_BUSY' });
    release();
    assert.equal(await saving, 'saved');
    assert.equal(await operations.restore(scope, () => 'safe now'), 'safe now');
});

test('restore excludes every write and failure releases ownership without poisoning the next operation', async () => {
    const operations = createChatSessionOperations();
    await assert.rejects(operations.restore(scope, async () => {
        assert.throws(() => operations.begin(scope, 'generation'), { code: 'NORA_CHAT_OPERATION_BUSY' });
        await assert.rejects(operations.write(scope, null, () => assert.fail()), { code: 'NORA_CHAT_OPERATION_BUSY' });
        throw new Error('synthetic checkpoint failure');
    }), /synthetic checkpoint failure/);
    await assert.rejects(operations.write(scope, null, () => { throw new Error('synthetic save failure'); }), /synthetic save failure/);
    assert.equal(await operations.write(scope, null, () => 'ordinary save'), 'ordinary save');
    const restarted = createChatSessionOperations();
    const token = operations.begin(scope, 'generation').token;
    await assert.rejects(restarted.write(scope, token, () => assert.fail()), { code: 'NORA_CHAT_OPERATION_STALE' });
    assert.throws(() => operations.begin({ worldId: '', sessionId: 'x' }, 'generation'), { code: 'NORA_CHAT_OPERATION_INVALID' });
});
