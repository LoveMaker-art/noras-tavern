import { containsLedger, countTurns, LEDGER_SOURCE, prefixText, renderLedger, scopeKey, scopeOf, tagHistory } from './history.js';

// Nora's webpack entry and ST's import-map modules are separate module graphs.
// They MUST share one page registry, including symbol lineage and WeakMap proof.
const registry = globalThis[Symbol.for('nora.story-ledger')] ??= {
    states: new Map(), listeners: new Set(), prepared: new WeakMap(), runtime: null,
    timer: null, refreshSequence: 0, lastRefresh: Promise.resolve(),
};
const { states, listeners, prepared } = registry;
const runtime = () => registry.runtime?.();

export const ledgerScope = () => scopeOf(runtime()?.chatMetadata);
const currentState = () => states.get(scopeKey(ledgerScope()));
const emit = () => listeners.forEach(listener => {
    try { listener(); } catch (error) { console.warn('[Story Ledger] view update failed:', error); }
});
export function subscribeLedger(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export function adoptLedgerStatus(status) {
    if (!status?.worldId || !status?.sessionId) return;
    const key = scopeKey(status);
    const previous = states.get(key);
    // Old network responses must never unlock an already activated prefix.
    if ((previous?.active?.coveredTurns || 0) > (status.active?.coveredTurns || 0)) status = { ...status, active: previous.active };
    states.set(key, status);
    emit();
}

export async function requestLedger(action, data = {}) {
    const scope = ledgerScope();
    if (!scope || !registry.runtime) return null;
    const response = await fetch(`/api/nora-story-ledger/${action}`, {
        method: 'POST', headers: runtime().getRequestHeaders(), cache: 'no-store',
        body: JSON.stringify({ ...scope, ...data }), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Story ledger request failed.'), { code: result.code });
    return result;
}

export function refreshLedger() {
    clearTimeout(registry.timer);
    const scope = ledgerScope();
    if (!scope) return Promise.resolve();
    const sequence = ++registry.refreshSequence;
    registry.lastRefresh = requestLedger('status').then(status => {
        if (sequence !== registry.refreshSequence) return;
        adoptLedgerStatus(status);
        if (status?.running && scopeKey(scope) === scopeKey(ledgerScope())) registry.timer = setTimeout(refreshLedger, 2000);
    }).catch(error => console.warn('[Story Ledger] status unavailable:', error.code || error.name));
    return registry.lastRefresh;
}

export function connectLedger(getContext) {
    registry.runtime = getContext;
    const context = runtime();
    const events = [context.eventTypes.CHAT_CHANGED, context.eventTypes.CHAT_LOADED, context.eventTypes.GENERATION_ENDED];
    // ST awaits event-handler return values. Never return this background RPC's
    // promise into the world-open or foreground generation critical path.
    const changed = () => { void refreshLedger(); };
    events.filter(Boolean).forEach(event => context.eventSource.on(event, changed));
    void refreshLedger();
    return () => {
        events.filter(Boolean).forEach(event => context.eventSource.removeListener(event, changed));
        clearTimeout(registry.timer);
        registry.runtime = null;
        registry.refreshSequence++;
    };
}

export function ledgerAllowsEdit(id) {
    if (!registry.runtime || !ledgerScope()) return true;
    const context = runtime();
    const absoluteId = Number(context.getNoraAbsoluteMessageId?.(id) ?? id);
    const state = currentState();
    if (!state) {
        // Unknown status is not permission to expose every historical editor.
        return id === context.chat.length - 1 || id === context.chat.findLastIndex(message => message.is_user && !message.is_system);
    }
    return absoluteId >= (state.active?.messageCount || 0);
}

export function tagCurrentLedgerHistory(context) {
    tagHistory(context.chat, scopeOf(context.chatMetadata));
}

export async function digestHistory(messages, count = messages.length) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prefixText(messages, count)));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareLedgerHistory(messages, { dryRun, type, source }) {
    if (dryRun || type === 'quiet' || !registry.runtime || source !== 'custom') return null;
    const scope = ledgerScope();
    const state = currentState();
    const record = (state?.enabled && state?.pending) || state?.active;
    if (!scope || !record) return null;
    const context = runtime();
    const count = record.messageCount;
    // A paged window or independently supplied helper history is not the full
    // canonical history. Only explicitly tagged messages can be replaced.
    const sources = new Set(messages.filter(message => message?.[LEDGER_SOURCE]?.key === scopeKey(scope))
        .map(message => message[LEDGER_SOURCE].index));
    if (context.getNoraAbsoluteMessageId?.(0) > 0 || count > context.chat.length || countTurns(context.chat) < record.coveredTurns) return null;
    for (let index = 0; index < count; index++) {
        if (!context.chat[index].is_system && !sources.has(index)) return null;
    }
    if (await digestHistory(context.chat, count) !== record.signature) return null;
    if (scopeKey(scope) !== scopeKey(ledgerScope())) return null;
    return { scope, record, text: renderLedger(record), messages: messages.filter(message => {
        const source = message?.[LEDGER_SOURCE];
        return !source || source.key !== scopeKey(scope) || source.index >= count;
    }) };
}

export function rememberLedgerPrompt(messages, plan, fallback) {
    prepared.set(messages, { ...plan, fallback });
}
export function ledgerPromptPlan(messages) { return prepared.get(messages) || null; }
export function ledgerPromptValid(messages, plan) {
    return scopeKey(plan.scope) === scopeKey(ledgerScope()) && containsLedger(messages, plan.text);
}
export function acknowledgeLedger(plan) {
    const state = states.get(scopeKey(plan.scope));
    if (!state) return;
    adoptLedgerStatus({ ...state, active: plan.record,
        pending: state.pending?.coveredTurns > plan.record.coveredTurns ? state.pending : null });
}

export async function editStoryMessage(context, id, text, bias = null) {
    // The edit endpoint checks revision and locks in the same atomic operation;
    // no serial status preflight is needed here either.
    if (!ledgerAllowsEdit(id)) throw Object.assign(new Error('This message is protected by the story ledger.'), { code: 'NORA_LEDGER_HISTORY_LOCKED' });
    const scope = scopeOf(context.chatMetadata);
    const result = await requestLedger('edit', { messageId: id, text, bias,
        expectedSignature: await digestHistory(context.chat) });
    if (scopeKey(scope) !== scopeKey(ledgerScope())) throw new Error('World changed during editing.');
    adoptLedgerStatus(result.ledger);
    return result.chat;
}
