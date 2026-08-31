// Shared, deterministic story rules. ST message indexes are NOT turn numbers.
export const BATCH_TURNS = 15;
export const LEDGER_SOURCE = Symbol.for('nora.story-ledger.source');

export function scopeOf(metadata) {
    const worldId = metadata?.nora_world?.id;
    const sessionId = metadata?.nora_session?.id;
    return worldId && sessionId ? { worldId, sessionId } : null;
}

export function scopeKey(scope) {
    return scope ? JSON.stringify([scope.worldId, scope.sessionId]) : '';
}

export function countTurns(messages) {
    return messages.filter(message => message?.is_user && !message.is_system).length;
}

export function coveredMessageCount(messages, turns) {
    if (turns <= 0) return 0;
    let seen = 0;
    for (let index = 0; index < messages.length; index++) {
        if (messages[index]?.is_user && !messages[index]?.is_system && ++seen > turns) return index;
    }
    return messages.length;
}

// Only narrative identity/content is immutable. In particular, MVU stat_data,
// reasoning display caches and tokenizer caches are not a second ledger.
export function narrative(message) {
    return [message?.is_user === true, message?.is_system === true,
        String(message?.name || ''), String(message?.mes || ''),
        message?.send_date ?? null, message?.swipe_id ?? 0,
        message?.extra?.bias ?? null,
        message?.extra?.type ?? null, message?.extra?.media ?? null,
        message?.extra?.tool_invocations ?? null];
}

export function prefixText(messages, count) {
    return JSON.stringify(messages.slice(0, count).map(narrative));
}

export function renderLedger(record) {
    return `<story_ledger turns="1-${record.coveredTurns}">\n${JSON.stringify(record.ledger)}\n</story_ledger>`;
}

export function containsLedger(messages, text) {
    return Array.isArray(messages) && messages.some(message => {
        const content = typeof message?.content === 'string' ? message.content
            : Array.isArray(message?.content) ? message.content.map(part => part?.text || '').join('\n') : '';
        return content.includes(text);
    });
}

export function tagHistory(messages, scope) {
    if (!scope) return;
    messages.forEach((message, index) => {
        message[LEDGER_SOURCE] = { key: scopeKey(scope), index };
    });
}
