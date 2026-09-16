import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { traceConfig, normalizeTrace, traceGeneration } from '../src/nora-mvu-trace.js';
import { createMvuTraceClient } from '../../../native-extensions/nora-mvu/trace-client.js';
import express from 'express';
import vm from 'node:vm';

test('trace defaults off, expires, and never records credentials or reasoning', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mvu-trace-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    assert.equal((await traceConfig({ root })).enabled, false);
    await fs.writeFile(path.join(root, '.nora-mvu-trace.json'), JSON.stringify({ expiresAt: Date.now() + 60000, chatId: 'test-chat' }));
    assert.equal((await traceConfig({ root })).enabled, true);
    const e = normalizeTrace({ stage: 'model-request', chatId: 'test-chat', detail: {
        api_key: 'private-key', reasoning_content: 'private-thinking',
        messages: [{ content: 'Authorization: Bearer abc-secret sk-1234567890abcdefgh' }],
    } });
    assert.doesNotMatch(JSON.stringify(e), /private-key|private-thinking|abc-secret|sk-1234567890abcdefgh/);
    const bounded = normalizeTrace({ detail: { content: 'x'.repeat(200000) } });
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.detail.length < 140000);
});

test('wire trace preserves streaming bytes and correlates request/response; strips trace marker', async () => {
    const saved = [], bytes = [];
    const response = new EventEmitter();
    response.statusCode = 200;
    response.write = chunk => { bytes.push(chunk); return false; };
    response.end = chunk => { if (chunk) bytes.push(chunk); response.emit('finish'); return response; };
    const request = { user: { directories: { root: '/unused' }, profile: { handle: 'test' } }, body: {
        nora_mvu_trace: { chatId: 'chat', requestId: 'request-1' }, model: 'test', stream: true,
        messages: [{ role: 'system', content: 'Use nora-mvu/1. Update state only.' }], custom_key: 'secret',
    } };
    await traceGeneration(request, response, () => {}, {
        config: async () => ({ enabled: true, chatId: 'chat' }), append: async (_, event) => saved.push(event),
    });
    assert.equal('nora_mvu_trace' in request.body, false);
    const part = 'data: {"choices":[{"delta":{"reasoning_content":"hidden","content":"<NoraMvu>"}}]}\n\n';
    assert.equal(response.write(part), false);
    response.end('data: {"choices":[{"delta":{"content":"</NoraMvu>"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bytes[0], part);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].requestId, 'request-1');
    assert.equal(saved[1].requestId, 'request-1');
    assert.match(JSON.stringify(saved[1].detail), /NoraMvu/);
    assert.doesNotMatch(JSON.stringify(saved), /hidden|custom_key/);
});

test('disabled tracing does not wrap transport, but still removes internal marker', async () => {
    const response = { write() {}, end() {} }; const original = response.write;
    const req = { body: { nora_mvu_trace: { chatId: 'chat' } } };
    await traceGeneration(req, response, () => {}, { config: async () => ({ enabled: false }) });
    assert.equal(response.write, original);
    assert.equal('nora_mvu_trace' in req.body, false);
});

test('client captures parser input and failure without changing errors; respects chat and expiry', async () => {
    const posts = []; let listener, clock = 1000, chat = 'target';
    const trace = createMvuTraceClient({ now: () => clock, uuid: () => 'page-id',
        getContext: () => ({ chatId: chat, getRequestHeaders: () => ({}), eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'ready' }, eventSource: { on: (_, fn) => listener = fn } }),
        fetcher: async (url, opts) => {
            if (url.endsWith('/trace-config')) return { ok: true, json: async () => ({ enabled: true, chatId: 'target', expiresAt: 2000 }) };
            posts.push(JSON.parse(opts.body)); return { ok: true };
        },
    });
    await trace.start();
    const data = {}; listener(data); assert.equal(data.nora_mvu_trace.chatId, 'target');
    const error = new Error('missing update block');
    const protocol = trace.wrapProtocol({ readNoraResponse: () => { throw error; } });
    assert.throws(() => protocol.readNoraResponse({ content: 'wrong', reasoning_content: 'hidden' }, '聊天消息'), e => e === error);
    assert.ok(posts.some(p => p.stage === 'parser-input'));
    assert.ok(posts.some(p => p.stage === 'parser-rejected'));
    assert.doesNotMatch(JSON.stringify(posts), /hidden/);
    const count = posts.length;
    chat = 'other'; trace.record('test'); assert.equal(posts.length, count);
    chat = 'target'; clock = 3000; trace.record('test'); assert.equal(posts.length, count);
    const expired = {}; listener(expired); assert.deepEqual(expired, {});
});

test('streaming diagnostics retain closing tags after hundreds of small chunks', async () => {
    const saved = [];
    const response = new EventEmitter(); response.write = () => true; response.end = () => response.emit('finish');
    const request = { body: { nora_mvu_trace: { chatId: 'c' }, messages: [{ content: 'Use nora-mvu/1.' }] } };
    await traceGeneration(request, response, () => {}, { config: async () => ({ enabled: true }), append: async (_, e) => saved.push(e) });
    for (let i = 0; i < 400; i++) response.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"</NoraMvu>"},"finish_reason":"stop"}]}\n\n');
    response.end(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(saved[1].detail.choices[0].content, 'x'.repeat(400) + '</NoraMvu>');
    assert.equal(saved[1].truncated, false);
});

test('real HTTP boundary persists paired evidence privately without changing JSON reply', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mvu-http-trace-'));
    await fs.writeFile(path.join(root, '.nora-mvu-trace.json'), JSON.stringify({ expiresAt: Date.now() + 60000, chatId: 'fixture' }));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories: { root }, profile: { handle: 'fixture' } }; next(); });
    const reply = { choices: [{ message: { content: '<NoraMvu>{"protocol":"nora-mvu/1","operations":[]}</NoraMvu>', reasoning_content: 'private-reasoning' }, finish_reason: 'stop' }] };
    app.post('/generate', traceGeneration, (req, res) => {
        assert.equal(req.body.nora_mvu_trace, undefined);
        res.json(reply);
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        messages: [{ role: 'system', content: 'Use nora-mvu/1.' }], custom_key: 'private-key', nora_mvu_trace: { chatId: 'fixture', requestId: 'pair-1' },
    }) });
    assert.deepEqual(await response.json(), reply);
    const file = path.join(root, 'nora-telemetry/mvu-diagnostics.ndjson');
    let text = '';
    for (let i = 0; i < 50; i++) {
        try { text = await fs.readFile(file, 'utf8'); } catch {}
        if (text.trim().split('\n').length === 2) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const events = text.trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(e => e.requestId), ['pair-1', 'pair-1']);
    assert.equal(events[1].stage, 'model-response');
    assert.doesNotMatch(text, /private-key|private-reasoning/);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('Helper prelude reports a schema import failure before any Zod registration', async () => {
    const events = [], handlers = {}, original = [];
    const code = await fs.readFile(new URL('../../../native-extensions/JS-Slash-Runner/vendor/iframe/log.js', import.meta.url), 'utf8');
    const context = {
        getIframeName: () => 'TH-script--Zod Schema--schema-1',
        _th_impl: { _init() {}, _log() {}, _clearLog() {} },
        parent: { NoraMvu: { trace: { recordScript: (...args) => events.push(args) } } },
        window: { addEventListener: (event, listener) => { handlers[event] = listener; } },
        $: () => ({ on() {} }),
        console: Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map(level => [level, (...args) => original.push([level, ...args])])),
    };
    vm.runInNewContext(code, context);
    handlers.error({ message: 'Failed to fetch dynamically imported module', filename: 'schema.js', lineno: 1 });
    context.console.error('script failed');
    assert.equal(events[0][0], 'schema-script-start');
    assert.equal(events[1][0], 'schema-script-error');
    assert.match(events[1][2].message, /Failed to fetch/);
    assert.equal(original[0][1], 'script failed');
});
