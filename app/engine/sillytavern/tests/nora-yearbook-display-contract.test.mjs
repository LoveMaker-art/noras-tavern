import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeLedgerModel, ledgerPrompt } from '../src/nora-story-ledger/model.js';
import { createStoryLedger } from '../src/nora-story-ledger/core.js';

const ledger = () => ({ timeline: ['The missing book was recovered.'], facts: [], open_threads: ['Find its missing page.'],
    objects: [], secrets: [{ id: 'hidden', content: 'NPC-only hidden location', known_by: [] }],
    scene: { time: 'Morning', place: 'Cafe', participants: [] }, style_notes: [] });

test('normal compression keeps its original seven-field output without a yearbook generation protocol', async () => {
    const scope = { worldId: 'w', sessionId: 's' };
    const messages = Array.from({ length: 32 }, (_, i) => ({ mes: `Message ${i}`, is_user: i % 2 === 0 }));
    let state = { enabled: true, modelUseConsent: { noticeVersion: 1, enabled: true } }, calls = 0;
    const plugin = createStoryLedger({ readChat: () => ({ messages, entities: ['__user__'] }), readState: () => state,
        writeState: (_scope, next) => { state = structuredClone(next); }, merge: async input => {
            calls++; assert.equal(Object.hasOwn(input, 'includeRecap'), false); return ledger();
        } });
    await plugin.schedule(scope);
    assert.equal(calls, 1); assert.equal(Object.hasOwn(state.pending, 'recap'), false);
    assert.deepEqual(state.pending.ledger, ledger());
});

test('actual model adapter requests only the ledger and returns it without an additional display call', async () => {
    let calls = 0;
    const input = { config: {}, previous: {}, entities: ['__user__'], language: 'en', segment: { startTurn: 1, endTurn: 15, text: 'A complete story batch' } };
    assert.doesNotMatch(ledgerPrompt(input)[0].content, /recap|milestones|reader-facing/);
    const result = await mergeLedgerModel({ model: { custom_url: 'https://fixture.invalid/v1', custom_model: 'offline', openai_max_tokens: 4000, openai_max_context: 32000 },
        apiKey: 'offline', input, report: () => {}, fetchImpl: async (_url, options) => {
            calls++; assert.doesNotMatch(JSON.parse(options.body).messages[0].content, /recap|milestones/);
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(ledger()) } }] }) };
        } });
    assert.equal(calls, 1); assert.deepEqual(result, ledger());
});
