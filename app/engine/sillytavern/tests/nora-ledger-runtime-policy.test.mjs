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
const model = { custom_url: 'http://127.0.0.1:1/v1', custom_model: 'test', openai_max_context: 8192, openai_max_tokens: 1000 };
function fixture(merge, extra = {}) {
    let state = { enabled: true, modelUseConsent: { noticeVersion: 1, enabled: true } };
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

test('ordinary history edits do not clear a model failure pause', async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; throw Object.assign(new Error('missing capacity'), { code: 'NORA_LEDGER_CAPACITY_REQUIRED' }); });
    await f.plugin.schedule(scope);
    const before = await f.plugin.inspect(scope);
    await f.plugin.edit(scope, { messageId: 31, text: 'Edited reply', expectedSignature: before.expectedSignature }, () => {});
    await f.plugin.schedule(scope);
    assert.equal(calls, 1);
    assert.equal(f.state.lastError.code, 'NORA_LEDGER_CAPACITY_REQUIRED');
});

test('cancelled failure queued behind a config change cannot pause the new revision', async () => {
    let rejectModel, entered, releaseLock, locked;
    const reached = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { locked = resolve; });
    const barrier = new Promise(resolve => { releaseLock = resolve; });
    const f = fixture(() => { entered(); return new Promise((_, reject) => { rejectModel = reject; }); });
    const job = f.plugin.schedule(scope); await reached;
    const { expectedSignature } = await f.plugin.inspect(scope);
    const checkpoint = f.plugin.checkpoint(scope, expectedSignature, async () => { locked(); await barrier; });
    await held;
    const configure = f.plugin.configure(scope, { timeoutSeconds: 600 });
    rejectModel(new Error('old request failed'));
    await new Promise(resolve => setImmediate(resolve));
    releaseLock(); await checkpoint; await configure; await job;
    assert.equal(f.state.configRevision, 1);
    assert.equal(f.state.lastError, null);
});

test('model snapshot invalidation prevents a mixed-model candidate', async () => {
    let current = true, snapshots = 0, calls = 0;
    const f = fixture(async () => assert.fail('snapshot merger must own every segment'), {
        prepareMerge: async () => { snapshots++; return { isCurrent: () => current, merge: async () => { calls++; current = false; return memory(); } }; },
    });
    await f.plugin.schedule(scope);
    assert.equal(snapshots, 1);
    assert.equal(calls, 1);
    assert.equal(f.state.pending, null);
    assert.equal(f.state.lastError.code, 'NORA_LEDGER_MODEL_CHANGED');
});

test('model currency is checked before provider-sized parts and correction attempts', async () => {
    for (const invalid of [false, true]) {
        let current = true, calls = 0;
        const parts = Array.from({ length: 3 }, (_, i) => ({ startTurn: i + 1, endTurn: i + 1, text: '中'.repeat(2500) }));
        await assert.rejects(mergeLedgerModel({ model, input: { ...input, segment: { ...input.segment, parts } },
            isCurrent: () => current, report: () => {}, fetchImpl: async () => {
                calls++; current = false;
                return new Response(JSON.stringify({ choices: [{ message: { content: invalid ? 'not JSON' : JSON.stringify(memory()) } }] }));
            } }), { code: 'NORA_LEDGER_MODEL_CHANGED' });
        assert.equal(calls, 1);
    }
});

test('cancelling a queued session releases its restore without bypassing another running task', async () => {
    let entered, release, calls = 0;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture(async () => { calls++; entered(); await gate; return memory(); });
    const running = f.plugin.schedule(scope); await reached;
    const queued = { worldId: 'other-world', sessionId: 'other-session' };
    const waiting = f.plugin.schedule(queued);
    f.plugin.cancel(queued);
    await f.plugin.waitForIdle(queued); await waiting;
    await f.plugin.withIdleSession(queued, () => {});
    assert.equal((await f.plugin.status(scope)).running, true);
    assert.equal(calls, 1);
    release(); await running;
    assert.equal(calls, 1);
});

test('read-triggered lease expiry does not resume deferred compression', async () => {
    let time = 0, calls = 0;
    const activity = createChatSessionOperations({ now: () => time, leaseMs: 1 });
    const f = fixture(async () => { calls++; return memory(); }, { canRun: () => !activity.hasGeneration() });
    activity.subscribe(reason => {
        if (reason === 'expired') return;
        if (activity.hasGeneration()) f.plugin.cancelAll({ defer: true });
        else void f.plugin.resumeDeferred();
    });
    activity.begin(scope, 'generation'); await f.plugin.schedule(scope);
    time = 2;
    await f.plugin.inspect(scope);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
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

test('idle resumes only eligible work explicitly deferred behind foreground generation', async () => {
    let idle = false, calls = 0;
    const f = fixture(async () => { calls++; return memory(); }, { canRun: () => idle });
    await f.plugin.inspect(scope);
    idle = true;
    await f.plugin.resumeDeferred(); await f.plugin.waitForIdle();
    assert.equal(calls, 0);
    idle = false;
    await f.plugin.schedule(scope);
    idle = true;
    await f.plugin.resumeDeferred(); await f.plugin.waitForIdle();
    assert.equal(calls, 1);
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

test('actual serialized requests inherit Tavern output budget and reject length truncation', async () => {
    let calls = 0;
    const fetchImpl = async (_, options) => {
        calls++;
        const body = JSON.parse(options.body);
        assert.equal(body.max_tokens, 1000);
        ledgerRequestBudget(body.messages, 8192, body.max_tokens);
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(memory()) } }] }));
    };
    assert.deepEqual(await mergeLedgerModel({ model, input, fetchImpl, report: () => {} }), memory());
    assert.equal(calls, 1);
    await assert.rejects(mergeLedgerModel({ model, input, report: () => {}, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })) }), { code: 'NORA_LEDGER_OUTPUT_LIMIT' });
});

test('null output setting inherits current model while explicit and historical overrides survive', async () => {
    assert.equal(ledgerConfig().outputTokenLimit, null);
    assert.equal(ledgerConfig({ outputTokenLimit: null }).outputTokenLimit, null);
    assert.equal(ledgerConfig({ outputTokenLimit: 2048 }).outputTokenLimit, 2048);
    for (const [configuration, expected] of [[{}, 3000], [{ outputTokenLimit: null }, 3000], [{ outputTokenLimit: 512 }, 512]]) {
        await mergeLedgerModel({ model: { ...model, openai_max_tokens: 3000, openai_max_context: 16384 },
            input: { ...input, config: configuration }, report: () => {}, fetchImpl: async (_, options) => {
                assert.equal(JSON.parse(options.body).max_tokens, expected);
                return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(memory()) } }] }));
            } });
    }
    await assert.rejects(mergeLedgerModel({ model: { ...model, openai_max_tokens: undefined }, input,
        fetchImpl: () => assert.fail('no fallback output request'), report: () => {} }), { code: 'NORA_LEDGER_OUTPUT_CONFIGURATION_REQUIRED' });
});

test('ledger model respects configured temperature and custom transport options without hidden budget overrides', async () => {
    for (const exclude of ['', '- temperature', ['temperature']]) {
        await mergeLedgerModel({ model: { ...model, temp_openai: 1, custom_include_body: 'top_p: 0.8\nmax_tokens: 99999\nmax_completion_tokens: 99999\nmodel: wrong\nstream: true\nmessages: []',
            custom_exclude_body: exclude, custom_include_headers: 'X-Custom-Route: saved-setting' }, input, report: () => {},
        fetchImpl: async (_, options) => {
            const body = JSON.parse(options.body);
            assert.equal(body.temperature, exclude ? undefined : 1);
            assert.equal(body.top_p, 0.8); assert.equal(body.max_tokens, 1000);
            assert.equal(body.max_completion_tokens, undefined); assert.equal(body.model, 'test'); assert.equal(body.stream, false);
            assert.match(body.messages[0].content, /Merge previous_state/);
            assert.equal(options.headers['X-Custom-Route'], 'saved-setting');
            return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(memory()) } }] }));
        } });
    }
    await assert.rejects(mergeLedgerModel({ model: { ...model, custom_exclude_body: 'temperature: true' }, input, report: () => {},
        fetchImpl: () => assert.fail('invalid options cannot reach provider') }), { code: 'NORA_LEDGER_MODEL_OPTIONS_INVALID' });
});

test('turning off completed prepared memory preserves it without making it active or permitting another model call', async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return memory(); });
    await f.plugin.schedule(scope);
    const saved = f.state.pending;
    await f.plugin.configure(scope, { enabled: false });
    assert.deepEqual(f.state.pending, saved); assert.equal(f.state.active, null);
    await f.plugin.schedule(scope); assert.equal(calls, 1);
    assert.equal((await f.plugin.inspect(scope)).pending.id, saved.id);
});

test('length and oversized complete outputs preserve the preceding valid batch and original history', async () => {
    for (const kind of ['length', 'storage-budget']) {
        const messages = Array.from({ length: 62 }, (_, i) => ({ is_user: i % 2 === 0, mes: `original ${i}` }));
        const original = structuredClone(messages);
        let state = { enabled: true, modelUseConsent: { noticeVersion: 1, enabled: true } }, calls = 0;
        const oversized = memory();
        oversized.facts = Array.from({ length: 24 }, (_, i) => ({ id: `f${i}`, content: 'x'.repeat(220), known_by: [] }));
        oversized.secrets = Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, content: 'y'.repeat(220), known_by: [] }));
        oversized.objects = Array.from({ length: 16 }, (_, i) => ({ id: `o${i}`, name: 'z'.repeat(160), status: 'a'.repeat(160), location: 'b'.repeat(160), holder: '' }));
        const plugin = createStoryLedger({ readChat: () => ({ messages: structuredClone(messages), entities: ['__user__'] }),
            readState: () => structuredClone(state), writeState: (_, next) => { state = structuredClone(next); },
            merge: part => mergeLedgerModel({ model: { ...model, openai_max_context: 32768, openai_max_tokens: 4000 }, input: part, report: () => {},
                fetchImpl: async () => {
                    calls++;
                    return new Response(JSON.stringify({ choices: [{ finish_reason: calls > 1 && kind === 'length' ? 'length' : 'stop',
                        message: { content: JSON.stringify(calls > 1 && kind === 'storage-budget' ? oversized : memory()) } }] }));
                } }) });
        await plugin.schedule(scope);
        assert.equal(state.pending.coveredTurns, 15); assert.equal(state.active, null);
        assert.equal(state.lastError.code, kind === 'length' ? 'NORA_LEDGER_OUTPUT_LIMIT' : 'NORA_LEDGER_MEMORY_BUDGET_EXCEEDED');
        assert.equal(calls, kind === 'length' ? 2 : 3, 'one correction only for complete invalid output, no retry of truncation');
        assert.deepEqual(messages, original); assert.deepEqual(state.pending.ledger, memory());
        await plugin.schedule(scope); assert.equal(calls, kind === 'length' ? 2 : 3, 'failure stays paused without a new model call');
    }
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
    await mergeLedgerModel({ model, input: { ...input, config: { outputTokenLimit: 2048 }, segment: { startTurn: 1, endTurn: 3, text: parts.map(p => p.text).join('\n'), parts } }, report: () => {},
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
