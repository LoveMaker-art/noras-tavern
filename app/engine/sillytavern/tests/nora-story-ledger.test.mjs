import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createStoryLedger } from '../src/nora-story-ledger/core.js';
import { batchSegments, normalizeLedger } from '../src/nora-story-ledger/schema.js';
import { countTurns, coveredMessageCount, prefixText, renderLedger } from '../public/scripts/nora-story-ledger/history.js';

const scope = { worldId: 'world-a', sessionId: 'session-a' };
const copy = value => structuredClone(value);
const fingerprint = messages => crypto.createHash('sha256').update(prefixText(messages, messages.length)).digest('hex');
function chat(turns) {
    const messages = [{ name: 'Narrator', mes: 'Opening', is_user: false, send_date: 'opening' }];
    for (let turn = 1; turn <= turns; turn++) messages.push(
        { name: 'Player', mes: `Action ${turn}`, is_user: true, send_date: `user-${turn}` },
        { name: 'Narrator', mes: `Reply ${turn}`, is_user: false, send_date: `assistant-${turn}`, extra: { stat_data: { turn } } },
    );
    return messages;
}
function memory(label = 'Established event') {
    return { timeline: [label], facts: [], open_threads: [], objects: [], secrets: [],
        scene: { time: '', place: '', participants: [] }, style_notes: [] };
}

test('one registered player cannot stand in for multiple unregistered story characters', () => {
    const ledger = memory();
    ledger.scene.participants = [
        { character_id: '__user__', location: 'stairs', activity: 'holding copper wire', condition: '' },
        { character_id: '__user__', location: 'window', activity: 'Alan holding the key', condition: '' },
    ];
    assert.throws(() => normalizeLedger(ledger), /entity reference/);
    ledger.scene.participants.pop();
    ledger.objects = [{ id: 'key', name: 'brass key', status: 'Held by Alan, not the player', holder: '', location: 'Alan’s belt' }];
    assert.equal(normalizeLedger(ledger).objects[0].holder, '', 'Unregistered NPC custody is textual, never remapped to the player.');
});

test('provider deadline keeps raw history and reports a stable timeout code, not DOMException number 23', async () => {
    const f = fixture(16, async () => { throw new DOMException('Deadline exceeded', 'TimeoutError'); });
    await f.plugin.schedule(scope);
    assert.equal(f.state.active, null);
    assert.equal(f.state.pending, null);
    assert.equal(f.state.lastError.code, 'NORA_LEDGER_COMPRESSION_TIMEOUT');
    assert.equal(countTurns(f.messages), 16);
});
function fixture(turns = 16, model = async input => memory(`Through ${input.segment.endTurn}`)) {
    let messages = chat(turns);
    let state = null;
    const calls = [];
    const options = { readChat: () => ({ messages: copy(messages), entities: ['__user__'] }),
        readState: () => copy(state), writeState: (_, value) => { state = copy(value); },
        merge: input => { calls.push(copy(input)); return model(input); } };
    const plugin = createStoryLedger(options);
    const write = next => plugin.writeChat(scope, next, () => { messages = copy(next); });
    const edit = (id, text) => plugin.edit(scope, { messageId: id, text, expectedSignature: fingerprint(messages) }, next => { messages = copy(next); });
    return { plugin, calls, options, write, edit, get messages() { return copy(messages); }, get state() { return copy(state); } };
}
async function activate(f, record = f.state.pending) {
    const dispatch = await f.plugin.reserve(scope, record.id, [{ role: 'system', content: renderLedger(record) }]);
    await dispatch.accept();
    dispatch.release();
}

test('agent inspect is pure even with stale candidates, and reports active/reserved edit locks', async () => {
    const f = fixture();
    const empty = await f.plugin.inspect(scope, { limit: 2 });
    assert.equal(f.calls.length, 0);
    assert.equal(f.state, null);
    assert.equal(empty.messageCount, 33);
    assert.equal(empty.expectedSignature, fingerprint(f.messages));
    await f.plugin.schedule(scope);
    const saved = f.state;
    let writes = 0;
    const altered = f.messages; altered[1].mes = 'changed outside the ledger';
    const stale = createStoryLedger({ ...f.options, readChat: () => ({ messages: altered }),
        writeState: () => { writes++; } });
    const observed = await stale.inspect(scope, { limit: 1 });
    assert.equal(observed.stalePending, true);
    assert.equal(observed.pending, null);
    assert.equal(writes, 0);
    assert.deepEqual(f.state, saved);
    const dispatch = await f.plugin.reserve(scope, saved.pending.id, [{ role: 'system', content: renderLedger(saved.pending) }]);
    assert.equal((await f.plugin.inspect(scope, { offset: 1, limit: 1 })).messages[0].editable, false);
    dispatch.release();
    assert.equal((await f.plugin.inspect(scope, { offset: 1, limit: 1 })).messages[0].editable, true);
    await activate(f);
    assert.equal((await f.plugin.inspect(scope, { offset: 1, limit: 1 })).messages[0].editable, false);
    await assert.rejects(f.plugin.inspect(scope, { limit: 101 }), /Invalid history window/);
});

test('original Python batch semantics: 15 saved rounds do not compress; 16 cover 1–15; 31 cover 1–30', async () => {
    const f = fixture(15);
    await f.plugin.schedule(scope);
    assert.equal(f.calls.length, 0);
    await f.write(chat(16));
    await f.plugin.schedule(scope);
    assert.equal(f.state.pending.coveredTurns, 15);
    assert.equal(f.state.active, null);
    assert.equal(f.messages.length, 33, 'compression never deletes the JSONL history');
    await f.write(chat(31));
    await f.plugin.schedule(scope);
    assert.deepEqual(f.calls.map(input => [input.segment.startTurn, input.segment.endTurn]), [[1, 15], [16, 30]]);
    assert.equal(f.state.pending.coveredTurns, 30);
    assert.equal(f.calls[1].previous.timeline[0], 'Through 15');
});

test('only an outgoing context containing the exact persisted ledger can activate and lock it', async () => {
    const f = fixture();
    await f.plugin.schedule(scope);
    await assert.rejects(f.plugin.reserve(scope, f.state.pending.id, [{ role: 'user', content: 'continue' }]), { code: 'NORA_LEDGER_CONTEXT_STALE' });
    assert.equal(f.state.active, null);
    await activate(f);
    assert.equal(f.state.active.coveredTurns, 15);
    assert.equal(f.state.pending, null);
    for (const mutate of [
        messages => { messages[1].mes = 'rewrite'; },
        messages => { messages[2].swipe_id = 1; },
        messages => { messages.splice(3, 1); },
        messages => { messages.unshift(messages.pop()); },
        messages => { messages[2].extra.media = [{ url: 'replacement-image' }]; },
    ]) {
        const messages = f.messages; mutate(messages);
        await assert.rejects(f.write(messages), { code: 'NORA_LEDGER_HISTORY_LOCKED' });
    }
    const messages = f.messages;
    messages[2].extra.stat_data = { recalculated: true };
    messages[2].extra.token_count = 123;
    await f.write(messages);
    assert.equal(f.messages[2].extra.stat_data.recalculated, true, 'MVU and render/token caches are not frozen');
});

test('failed upstream dispatch releases temporary reservation without activating or locking', async () => {
    const f = fixture(); await f.plugin.schedule(scope);
    const record = f.state.pending;
    const dispatch = await f.plugin.reserve(scope, record.id, [{ content: renderLedger(record) }]);
    await assert.rejects(f.edit(1, 'changed during dispatch'), { code: 'NORA_LEDGER_HISTORY_LOCKED' });
    dispatch.release();
    await f.edit(1, 'edit after failed request');
    assert.equal(f.state.active, null);
    assert.equal(f.state.pending, null);
    assert.equal(f.messages.length, 2);
});

test('edit uncompressed user round 18 truncates assistant18 and rounds19–25, preserves covered1–15 and recounts', async () => {
    const f = fixture(); await f.plugin.schedule(scope); await activate(f);
    await f.write(chat(25));
    const id = 1 + 2 * 17;
    await f.edit(id, 'Changed action eighteen');
    assert.equal(f.messages.length, id + 1);
    assert.equal(countTurns(f.messages), 18);
    assert.equal(f.messages.at(-1).mes, 'Changed action eighteen');
    assert.equal(f.state.active.coveredTurns, 15);
    await assert.rejects(f.edit(3, 'edit locked round'), { code: 'NORA_LEDGER_HISTORY_LOCKED' });
    await f.plugin.schedule(scope);
    assert.equal(f.calls.length, 1, 'not enough confirmed new rounds after truncation');
});

test('assistant edit truncates only the following suffix and keeps the selected edited swipe', async () => {
    const f = fixture(10);
    const messages = f.messages;
    messages[10].swipe_id = 1; messages[10].swipes = ['old1', 'old2'];
    await f.write(messages);
    await f.edit(10, 'Edited fifth response');
    assert.equal(f.messages.length, 11);
    assert.equal(f.messages[10].swipes[1], 'Edited fifth response');
    assert.equal(countTurns(f.messages), 5);
});

test('second compression failure preserves first candidate and all remaining raw history', async () => {
    const f = fixture(31, async input => {
        if (input.segment.startTurn === 16) throw new Error('provider unavailable');
        return memory();
    });
    await f.plugin.schedule(scope);
    assert.equal(f.state.pending.coveredTurns, 15);
    assert.equal(f.state.active, null);
    assert.equal(f.messages.length, 63);
    assert.equal(f.state.lastError.code, 'NORA_LEDGER_COMPRESSION_FAILED');
});

test('pending prefix edited during background compression cannot publish; append-only sends remain allowed', async () => {
    let resolveModel;
    let started;
    const running = new Promise(resolve => { started = resolve; });
    const f = fixture(16, () => { started(); return new Promise(resolve => { resolveModel = resolve; }); });
    const job = f.plugin.schedule(scope);
    await running;
    await f.edit(1, 'different branch');
    resolveModel(memory('obsolete'));
    await job;
    assert.equal(f.state?.pending, null);
    assert.equal(f.messages.length, 2);

    let finish;
    let begin;
    const began = new Promise(resolve => { begin = resolve; });
    const append = fixture(16, () => { begin(); return new Promise(resolve => { finish = resolve; }); });
    const appendedJob = append.plugin.schedule(scope); await began;
    await append.write(chat(20));
    finish(memory()); await appendedJob;
    assert.equal(append.state.pending.coveredTurns, 15);
    assert.equal(countTurns(append.messages), 20);
});

test('restart and disabling new compression never remove the active lock', async () => {
    const f = fixture(); await f.plugin.schedule(scope); await activate(f);
    const restarted = createStoryLedger(f.options);
    await restarted.configure(scope, { enabled: false });
    assert.equal((await restarted.status(scope)).active.coveredTurns, 15);
    const messages = f.messages; messages[1].mes = 'overwrite';
    await assert.rejects(restarted.writeChat(scope, messages, () => assert.fail('write forbidden')), { code: 'NORA_LEDGER_HISTORY_LOCKED' });
});

test('edit revision rejects stale clients before any destructive write', async () => {
    const f = fixture();
    await assert.rejects(f.plugin.edit(scope, { messageId: 1, text: 'changed', expectedSignature: 'stale' }, () => assert.fail()), { code: 'NORA_LEDGER_EDIT_STALE' });
    assert.equal(f.messages.length, 33);
});

test('oversized batches split only between whole turns and include the opening exactly once', () => {
    const messages = chat(3); messages[1].mes = '大'.repeat(200);
    const segments = batchSegments(messages, 1, 3, 100);
    assert.equal(segments[0].startTurn, 1);
    assert.equal(segments[0].endTurn, 1);
    assert.match(segments[0].text, /Reply 1/);
    assert.equal(segments.filter(segment => segment.text.includes('Opening')).length, 1);
    assert.equal(coveredMessageCount(messages, 1), 3);
});

test('strict Python-compatible schema rejects invented entity IDs, missing fields and catastrophic loss', () => {
    assert.throws(() => normalizeLedger({ timeline: ['only a generic summary'] }));
    const value = memory(); value.secrets = [{ id: 'secret', content: 'truth', known_by: ['invented-npc'] }];
    assert.throws(() => normalizeLedger(value));
    assert.throws(() => normalizeLedger(memory(), { open_threads: Array(6).fill('unresolved') }));
    assert.deepEqual(normalizeLedger(memory()), memory());
});
