import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mergeLedgerModel } from '../src/nora-story-ledger/model.js';

test('a loopback provider taking 125 seconds is not cut off at 120 seconds', { skip: process.env.NORA_LEDGER_SLOW_TEST !== '1', timeout: 160000 }, async t => {
    const ledger = { timeline: ['Borrowed a book'], facts: [], open_threads: [], objects: [], secrets: [],
        scene: { time: '', place: '', participants: [] }, style_notes: [] };
    let timer;
    const server = http.createServer(async (request, response) => {
        for await (const _chunk of request) { /* Drain the request before simulating computation. */ }
        timer = setTimeout(() => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(ledger) } }] }));
        }, 125000);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const started = Date.now();
    const result = await mergeLedgerModel({ model: { custom_url: `http://127.0.0.1:${server.address().port}`, custom_model: 'loopback-only', openai_max_context: 8192 },
        input: { previous: {}, entities: ['__user__'], language: 'en', segment: { startTurn: 1, endTurn: 1, text: 'A book was borrowed.' } }, report: () => {} });
    assert.deepEqual(result, ledger);
    assert.ok(Date.now() - started >= 120000);
});
