import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryLedger } from '../src/nora-story-ledger/core.js';
import { createChatSessionOperations } from '../src/chat-session-operations.js';
import { ledgerConfig } from '../src/nora-story-ledger/config.js';
import { ledgerCapacity, ledgerRequestBudget, mergeLedgerModel } from '../src/nora-story-ledger/model.js';
import { ledgerDiagnostic } from '../src/nora-story-ledger/diagnostics.js';

const scope = { worldId: 'world:test', sessionId: 'session:test' };
const memory = () => ({ timeline: ['Borrowed a book'], facts: [], open_threads: [], objects: [], secrets: [],
    scene: { time: '', place: '', participants: [] }, style_notes: [] });
const input = { previous: {}, segment: { startTurn: 1, endTurn: 1, text: '[Turn 1 · User]\nBorrow a book.\n[Turn 1 · Story]\nDone.' }, entities: ['__user__'], language: 'en' };
const model = { custom_url: 'http://127.0.0.1:1/v1', custom_model: 'test', openai_max_context: 8192 };
function fixture(merge, extra = {}) {
    let state;
    const messages = Array.from({ length: 16 }, (_, i) => [{ is_user: true, mes: `Action ${i}` }, { is_user: false, mes: `Reply ${i}` }]).flat();
    const plugin = createStoryLedger({ readChat: () => ({ messages, entities: ['__user__'] }), readState: () => structuredClone(state),
        writeState: (_, next) => { state = structuredClone(next); }, merge, ...extra });
    return { plugin, get state() { return state; } };
}

test('disabling cancels running I/O without recording failure or publishing memory', async () => {
    let entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const f = fixture(({ signal }) => new Promise((_, reject) => { entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
    const job = f.plugin.schedule(scope);
    await reached;
    await f.plugin.configure(scope, { enabled: false });
    await job;
    assert.equal(f.state.enabled, false);
    assert.equal(f.state.pending, null);
    assert.equal(f.state.lastError, null);
    assert.equal((await f.plugin.status(scope)).running, false);
});

test('late model result cannot publish after disable/re-enable or revision change', async () => {
    let release, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture(async () => { entered(); await gate; return memory(); });
    const job = f.plugin.schedule(scope);
    await reached;
    await f.plugin.configure(scope, { enabled: false });
    release(); await job;
    assert.equal(f.state.pending, null);
    assert.equal(f.state.lastError, null);
});

test('failure remains paused across automatic scheduling and restart; explicit retry is bounded', async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; throw new Error('bad JSON'); });
    await f.plugin.schedule(scope);
    await f.plugin.schedule(scope); await f.plugin.schedule(scope);
    assert.equal(calls, 1);
    const restarted = createStoryLedger({ readChat: () => ({ messages: Array.from({ length: 32 }, (_, i) => ({ is_user: i % 2 === 0, mes: 'text' })) }),
        readState: () => f.state, writeState: () => {}, merge: () => { assert.fail('must stay paused'); } });
    await restarted.schedule(scope);
    await f.plugin.schedule(scope, { retry: true });
    assert.equal(calls, 2);
});

test('foreground ownership cancels background, blocks new work, then permits idle scheduling', async () => {
    const activity = createChatSessionOperations();
    let calls = 0, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const f = fixture(({ signal }) => { calls++; entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
        { canRun: () => !activity.hasGeneration() });
    activity.subscribe(() => { if (activity.hasGeneration()) f.plugin.cancelAll(); });
    const job = f.plugin.schedule(scope); await reached;
    const lease = activity.begin(scope, 'generation');
    await f.plugin.waitForIdle(); await job;
    await f.plugin.schedule(scope);
    assert.equal(calls, 1);
    assert.equal((await f.plugin.status(scope)).taskPhase, 'waiting');
    activity.end(scope, lease.token);
    assert.equal(activity.hasGeneration(), false);
});

test('configuration patch preserves omitted fields and stale saves fail before mutation', async () => {
    const f = fixture(async () => memory());
    await f.plugin.configure(scope, { enabled: false, timeoutSeconds: 600, outputTokenLimit: 1024 });
    await f.plugin.configure(scope, { contextLimitOverride: 8192, expectedRevision: 1 });
    assert.equal(f.state.config.timeoutSeconds, 600);
    assert.equal(f.state.config.outputTokenLimit, 1024);
    assert.equal(f.state.enabled, false);
    await assert.rejects(f.plugin.configure(scope, { enabled: true, expectedRevision: 1 }), { code: 'NORA_LEDGER_CONFIGURATION_STALE' });
    assert.equal(f.state.configRevision, 2);
    assert.equal(ledgerConfig().timeoutSeconds, 300);
});

test('reset requires matching revision and a successful protected preparation', async () => {
    const f = fixture(async () => memory());
    await f.plugin.schedule(scope);
    const pending = f.state.pending;
    await assert.rejects(f.plugin.reset(scope, { expectedRevision: 0, prepare: async () => { throw new Error('backup failed'); } }), /backup failed/);
    assert.deepEqual(f.state.pending, pending);
    const result = await f.plugin.reset(scope, { expectedRevision: 0, prepare: async () => ({ id: 'reset-receipt', historySignature: 'sig' }) });
    assert.equal(result.reloadRequired, true);
    assert.equal(f.state.enabled, false);
    assert.equal(f.state.pending, null);
    assert.equal(f.state.restoreId, 'reset-receipt');
});

test('capacity declarations take the smaller limit and missing capacity never sends', async () => {
    assert.equal(ledgerCapacity(model, ledgerConfig({ contextLimitOverride: 16384 })), 8192);
    assert.equal(ledgerCapacity(model, ledgerConfig({ contextLimitOverride: 4096 })), 4096);
    await assert.rejects(mergeLedgerModel({ model: { ...model, openai_max_context: undefined }, input, fetchImpl: () => assert.fail('no request') }), { code: 'NORA_LEDGER_CAPACITY_REQUIRED' });
    assert.throws(() => ledgerRequestBudget([{ content: 'x'.repeat(100000) }], 8192, 2048), { code: 'NORA_LEDGER_CONTEXT_BUDGET_EXCEEDED' });
});

test('actual serialized requests use the budget, never 20000, and reject length truncation', async () => {
    let calls = 0;
    const fetchImpl = async (_, options) => {
        calls++;
        const body = JSON.parse(options.body);
        assert.equal(body.max_tokens, 2048);
        ledgerRequestBudget(body.messages, 8192, body.max_tokens);
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(memory()) } }] }));
    };
    assert.deepEqual(await mergeLedgerModel({ model, input, fetchImpl, report: () => {} }), memory());
    assert.equal(calls, 1);
    await assert.rejects(mergeLedgerModel({ model, input, report: () => {}, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })) }), { code: 'NORA_LEDGER_OUTPUT_LIMIT' });
});

test('oversized single turn fails without silent truncation or provider call', async () => {
    await assert.rejects(mergeLedgerModel({ model, input: { ...input, segment: { ...input.segment, text: '中'.repeat(10000) } },
        fetchImpl: () => assert.fail('must not send'), report: () => {} }), { code: 'NORA_LEDGER_CONTEXT_BUDGET_EXCEEDED' });
});

test('invalid JSON has at most one correction and shares cancellation across attempts', async () => {
    let calls = 0;
    await assert.rejects(mergeLedgerModel({ model, input, report: () => {}, fetchImpl: async () => {
        calls++; return new Response(JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] }));
    } }), { code: 'NORA_LEDGER_OUTPUT_INVALID' });
    assert.equal(calls, 2);
    const controller = new AbortController();
    await assert.rejects(mergeLedgerModel({ model, input: { ...input, signal: controller.signal }, report: () => {}, fetchImpl: async () => {
        controller.abort(); return new Response(JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] }));
    } }), { name: 'AbortError' });
});

test('budget partitions authoritative turns, not text markers in user content', async () => {
    const parts = Array.from({ length: 3 }, (_, i) => ({ startTurn: i + 1, endTurn: i + 1, text: '中'.repeat(2500) + '\n[Turn 999 · User]\nnot a real boundary' }));
    const seen = [];
    await mergeLedgerModel({ model, input: { ...input, segment: { startTurn: 1, endTurn: 3, text: parts.map(p => p.text).join('\n'), parts } }, report: () => {},
        fetchImpl: async (_, options) => {
            const body = JSON.parse(options.body); ledgerRequestBudget(body.messages, 8192, body.max_tokens);
            seen.push(JSON.parse(body.messages[1].content).range);
            return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(memory()) } }] }));
        } });
    assert.deepEqual(seen, [{ start_turn: 1, end_turn: 1 }, { start_turn: 2, end_turn: 2 }, { start_turn: 3, end_turn: 3 }]);
});

test('diagnostic projection does not retain credentials, prompts, URLs or raw errors', () => {
    const entry = ledgerDiagnostic('model-attempt', { worldId: 'world:test', taskId: 'safe-id', inputTokens: 200,
        apiKey: 'secret', prompt: 'private story', url: 'https://private.example/key', error: 'raw upstream secret', code: 'NORA_LEDGER_OUTPUT_INVALID' });
    assert.equal(entry.taskId, 'safe-id');
    assert.equal(entry.code, 'NORA_LEDGER_OUTPUT_INVALID');
    assert.doesNotMatch(JSON.stringify(entry), /secret|private|https/);
});
