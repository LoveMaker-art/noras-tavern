import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    connectLedger, refreshLedger, adoptLedgerStatus, ledgerAllowsEdit, tagCurrentLedgerHistory,
    digestHistory, prepareLedgerHistory, rememberLedgerPrompt, ledgerPromptPlan, ledgerPromptValid, acknowledgeLedger,
} from '../public/scripts/nora-story-ledger/client.js';
import { LEDGER_SOURCE, renderLedger } from '../public/scripts/nora-story-ledger/history.js';

test('canonical ST and default helper clones share history policy; custom/raw histories remain untouched', async t => {
    const scope = { worldId: 'client-world', sessionId: 'client-session' };
    const chat = [];
    for (let i = 1; i <= 16; i++) chat.push({ is_user: true, name: 'User', mes: `User ${i}`, send_date: i * 2 },
        { is_user: false, name: 'Story', mes: `Reply ${i}`, send_date: i * 2 + 1 });
    const metadata = { nora_world: { id: scope.worldId }, nora_session: { id: scope.sessionId } };
    const context = { chat, chatMetadata: metadata, getRequestHeaders: () => ({}), getNoraAbsoluteMessageId: index => index,
        eventSource: new EventEmitter(), eventTypes: { CHAT_CHANGED: 'chat', CHAT_LOADED: 'loaded', GENERATION_ENDED: 'end' } };
    const record = { id: 'candidate', coveredTurns: 15, messageCount: 30, signature: await digestHistory(chat, 30),
        ledger: { timeline: ['plot'], facts: [], open_threads: [], objects: [], secrets: [], scene: {}, style_notes: [] } };
    const status = { ...scope, enabled: true, active: null, pending: record, running: false };
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => status }));
    const disconnect = connectLedger(() => context);
    t.after(disconnect);
    assert.equal(context.eventSource.listeners('end')[0](), undefined, 'ST must not await a background status RPC at generation end');
    await refreshLedger();
    assert.equal(ledgerAllowsEdit(0), true, 'pending generation does not lock editing');
    tagCurrentLedgerHistory(context);
    // Both native ST coreChat and Helper XW use object spread before conversion.
    const converted = chat.map(message => {
        const clone = { ...message, mes: `regex:${message.mes}` };
        return { role: clone.is_user ? 'user' : 'assistant', content: clone.mes, [LEDGER_SOURCE]: clone[LEDGER_SOURCE] };
    }).reverse();
    const options = { dryRun: false, type: 'normal', source: 'custom' };
    const plan = await prepareLedgerHistory(converted, options);
    assert.equal(plan.messages.length, 2);
    assert.equal(converted.length, 32, 'full raw prompt remains available for fallback');
    assert.equal(plan.messages[0].content, 'regex:Reply 16');
    const prompt = [{ role: 'system', content: plan.text }, ...plan.messages];
    const fallback = async () => [converted, {}];
    rememberLedgerPrompt(prompt, plan, fallback);
    const inlineGraph = await import('../public/scripts/nora-story-ledger/client.js?graph=st-inline');
    const inlineHistory = await import('../public/scripts/nora-story-ledger/history.js?graph=st-inline');
    assert.equal(inlineHistory.LEDGER_SOURCE, LEDGER_SOURCE);
    assert.equal(inlineGraph.ledgerPromptPlan(prompt).fallback, fallback, 'webpack and ST share one proof registry');
    assert.equal((await inlineGraph.prepareLedgerHistory(converted, options)).messages.length, 2);
    assert.equal(ledgerPromptPlan(prompt).fallback, fallback);
    assert.equal(ledgerPromptValid(prompt, plan), true);
    assert.equal(ledgerPromptValid([{ content: 'summary removed by another plugin' }], plan), false);
    assert.equal(await prepareLedgerHistory(converted, { ...options, type: 'quiet' }), null);
    assert.equal(await prepareLedgerHistory(converted, { ...options, dryRun: true }), null);
    assert.equal(await prepareLedgerHistory(converted, { ...options, source: 'claude' }), null);
    assert.equal(await prepareLedgerHistory(converted.map(({ role, content }) => ({ role, content })), options), null);
    assert.equal(await prepareLedgerHistory(converted.slice(0, 10), options), null, 'explicitly limited helper history must not be silently replaced');

    acknowledgeLedger(plan);
    assert.equal(ledgerAllowsEdit(0), false);
    assert.equal(ledgerAllowsEdit(29), false);
    assert.equal(ledgerAllowsEdit(30), true);
    adoptLedgerStatus(status);
    assert.equal(ledgerAllowsEdit(0), false, 'stale status response cannot unlock');
    context.getNoraAbsoluteMessageId = index => index + 24;
    assert.equal(ledgerAllowsEdit(5), false);
    assert.equal(ledgerAllowsEdit(6), true, 'paged UI uses absolute message index');
    assert.equal(await prepareLedgerHistory(converted, options), null);
    context.getNoraAbsoluteMessageId = index => index;
    chat[0].mes = 'edited before cached candidate was activated';
    assert.equal(await prepareLedgerHistory(converted, options), null, 'prefix fingerprint must match canonical raw history');
    context.chatMetadata = { nora_world: { id: 'other' }, nora_session: { id: 'other' } };
    assert.equal(ledgerPromptValid([{ content: renderLedger(record) }], plan), false);
});
