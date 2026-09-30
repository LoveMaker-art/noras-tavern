import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    connectLedger, refreshLedger, adoptLedgerStatus, ledgerAllowsEdit, tagCurrentLedgerHistory,
    digestHistory, prepareLedgerHistory, rememberLedgerPrompt, ledgerPromptPlan, ledgerPromptValid, acknowledgeLedger,
    protectStoryRegeneration,
} from '../public/scripts/nora-story-ledger/client.js';
import { LEDGER_SOURCE, renderLedger } from '../public/scripts/nora-story-ledger/history.js';

test('regeneration requires a protected checkpoint; normal sends and prompt previews never request one', async t => {
    const context = { chat: [{ is_user: false, mes: 'original', extra: { stat_data: { hp: 10 } } }],
        chatMetadata: { nora_world: { id: 'protection-world' }, nora_session: { id: 'protection-session' } },
        getRequestHeaders: () => ({}), eventSource: new EventEmitter(), eventTypes: {} };
    let fail = false, mutate = false, offline = false;
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (!url.endsWith('/checkpoint')) return { ok: true, json: async () => ({}) };
        if (offline) throw new TypeError('Failed to fetch');
        requests.push(JSON.parse(options.body));
        if (mutate) context.chat[0].extra.stat_data.hp = 8;
        return { ok: !fail, json: async () => fail ? { code: 'NORA_BACKUP_REQUIRED', error: 'checkpoint failed' } : { status: 'created', id: 'snapshot' } };
    });
    const disconnect = connectLedger(() => context);
    t.after(disconnect);
    await protectStoryRegeneration(context, { type: 'normal' });
    await protectStoryRegeneration(context, { type: 'regenerate', dryRun: true });
    await protectStoryRegeneration(context, { type: 'regenerate', depth: 1 });
    assert.equal(requests.length, 0);
    fail = true;
    await assert.rejects(protectStoryRegeneration(context, { type: 'regenerate' }), { code: 'NORA_BACKUP_REQUIRED' });
    assert.equal(context.chat[0].mes, 'original');
    fail = false;
    await protectStoryRegeneration(context, { type: 'regenerate' });
    assert.equal(requests.at(-1).expectedSignature, await digestHistory(context.chat));
    offline = true;
    await assert.rejects(protectStoryRegeneration(context, { type: 'regenerate' }), { code: 'NORA_BACKUP_REQUIRED' });
    offline = false;
    mutate = true;
    await assert.rejects(protectStoryRegeneration(context, { type: 'regenerate' }), { code: 'NORA_LEDGER_EDIT_STALE' });
});

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
    context.chatMetadata = { ...metadata, nora_restore: { id: 'restore-new' } };
    adoptLedgerStatus({ ...status, restoreId: 'restore-new' });
    assert.equal(ledgerAllowsEdit(0), true, 'restoration explicitly clears the old active prefix');
    adoptLedgerStatus({ ...status, active: record });
    assert.equal(ledgerAllowsEdit(0), true, 'a delayed pre-restoration response cannot resurrect the old prefix');
    assert.equal(ledgerPromptValid(prompt, plan), false);
});
