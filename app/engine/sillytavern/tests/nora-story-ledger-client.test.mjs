import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    connectLedger, refreshLedger, adoptLedgerStatus, ledgerAllowsEdit, tagCurrentLedgerHistory,
    digestHistory, prepareLedgerHistory, rememberLedgerPrompt, ledgerPromptPlan, ledgerPromptValid, acknowledgeLedger,
    protectStoryRegeneration,
} from '../public/scripts/nora-story-ledger/client.js';
import { regenerationRollback, withRegenerationRollback } from '../public/scripts/nora-story-ledger/regeneration-rollback.js';
import { LEDGER_SOURCE, renderLedger } from '../public/scripts/nora-story-ledger/history.js';

test('backup failure only warns during regeneration; stale history and unavailable server still fail preflight', async t => {
    const context = { chat: [{ is_user: false, mes: 'original', extra: { stat_data: { hp: 10 } } }],
        chatMetadata: { nora_world: { id: 'protection-world' }, nora_session: { id: 'protection-session' } },
        getRequestHeaders: () => ({}), eventSource: new EventEmitter(), eventTypes: {} };
    let fail = false, mutate = false, offline = false;
    const requests = [];
    const warnings = [];
    const previousToastr = globalThis.toastr;
    globalThis.toastr = { warning: message => warnings.push(message) };
    t.after(() => { if (previousToastr === undefined) delete globalThis.toastr; else globalThis.toastr = previousToastr; });
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (!url.endsWith('/checkpoint')) return { ok: true, json: async () => ({}) };
        if (offline) throw new TypeError('Failed to fetch');
        requests.push(JSON.parse(options.body));
        if (mutate) context.chat[0].extra.stat_data.hp = 8;
        return { ok: true, json: async () => fail ? { status: 'failed', code: 'NORA_BACKUP_BUDGET_EXCEEDED' } : { status: 'created', id: 'snapshot' } };
    });
    const disconnect = connectLedger(() => context);
    t.after(disconnect);
    await protectStoryRegeneration(context, { type: 'normal' });
    await protectStoryRegeneration(context, { type: 'regenerate', dryRun: true });
    await protectStoryRegeneration(context, { type: 'regenerate', depth: 1 });
    assert.equal(requests.length, 0);
    fail = true;
    await protectStoryRegeneration(context, { type: 'regenerate' });
    await refreshLedger();
    await protectStoryRegeneration(context, { type: 'regenerate' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warnings.length, 1, 'repeated failures do not spam the player');
    assert.ok(warnings[0].length > 0);
    assert.equal(context.chat[0].mes, 'original');
    fail = false;
    await protectStoryRegeneration(context, { type: 'regenerate' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.at(-1).expectedSignature, await digestHistory(context.chat));
    globalThis.toastr.warning = () => { throw new Error('notification renderer failed'); };
    fail = true;
    await protectStoryRegeneration(context, { type: 'regenerate' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.chat[0].mes, 'original', 'a broken reminder never rejects a successful checkpoint response');
    fail = false;
    offline = true;
    await assert.rejects(protectStoryRegeneration(context, { type: 'regenerate' }), TypeError);
    offline = false;
    mutate = true;
    await assert.rejects(protectStoryRegeneration(context, { type: 'regenerate' }), { code: 'NORA_LEDGER_EDIT_STALE' });
});

test('failed regeneration restores the exact original reply and variables without requiring a disk backup', () => {
    const context = { chat: [{ is_user: true, mes: 'action' }, { is_user: false, mes: 'original',
        swipes: ['original', 'alternative'], swipe_id: 0, extra: { stat_data: { hp: 10 } } }],
    chatMetadata: { nora_world: { id: 'rollback-world' }, nora_session: { id: 'rollback-session' } } };
    const original = structuredClone(context.chat);
    const rollback = regenerationRollback(() => context);
    context.chat.pop();
    assert.equal(rollback(), true);
    assert.deepEqual(context.chat, original);
    assert.equal(rollback(), false);
    context.chat.at(-1).mes = 'partial failed response';
    context.chat.at(-1).extra.stat_data.hp = 3;
    const unsaved = structuredClone(context.chat);
    assert.equal(rollback({ phase: 'save' }), false, 'a successful model reply stays available for save-only retry');
    assert.deepEqual(context.chat, unsaved);
    assert.equal(rollback(), true);
    assert.deepEqual(context.chat, original);
    context.chat[0].mes = 'a different edit';
    context.chat.pop();
    assert.equal(rollback(), false, 'a changed prefix is never overwritten');
});

test('generation wrapper preserves successful replies and save-only retries, and never hides model errors behind renderer errors', async () => {
    const context = { chat: [{ is_user: false, mes: 'original' }],
        chatMetadata: { nora_world: { id: 'wrapper-world' }, nora_session: { id: 'wrapper-session' } } };
    let renders = 0;
    const render = () => { renders++; };
    assert.equal(await withRegenerationRollback(() => context, async () => {
        context.chat[0].mes = 'generated'; return 'generated';
    }, render), 'generated');
    assert.equal(context.chat[0].mes, 'generated');
    assert.equal(renders, 0);
    const saveError = Object.assign(new Error('save failed'), { phase: 'save', retrySave: () => true });
    await assert.rejects(withRegenerationRollback(() => context, async () => {
        context.chat[0].mes = 'new unsaved reply'; throw saveError;
    }, render), error => error === saveError);
    assert.equal(context.chat[0].mes, 'new unsaved reply');
    assert.equal(renders, 0);
    const modelError = new Error('model failed');
    await assert.rejects(withRegenerationRollback(() => context, async () => {
        context.chat.pop(); throw modelError;
    }, () => { throw new Error('render failed'); }), error => error === modelError);
    assert.equal(context.chat[0].mes, 'new unsaved reply');
    assert.equal(await withRegenerationRollback(() => context, async () => { context.chat.pop(); }, render), undefined);
    assert.equal(context.chat[0].mes, 'new unsaved reply');
    assert.equal(renders, 1);
});

test('generation rollback never alters a switched World, different chat array or appended messages', () => {
    const metadata = { nora_world: { id: 'original' }, nora_session: { id: 'session' } };
    for (const mutate of [context => { context.chatMetadata = { nora_world: { id: 'other' }, nora_session: { id: 'session' } }; },
        context => { context.chat = []; }, context => { context.chat.push({ is_user: true, mes: 'new action' }); }]) {
        const context = { chat: [{ is_user: false, mes: 'original' }], chatMetadata: metadata };
        const rollback = regenerationRollback(() => context);
        mutate(context);
        const changed = structuredClone(context);
        assert.equal(rollback(), false);
        assert.deepEqual(context, changed);
    }
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
