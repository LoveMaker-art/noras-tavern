export function normalizeNoraReasoningMessage(message, parseReasoning) {
    if (!message || message.is_user || message.is_system || message.extra?.reasoning || typeof parseReasoning !== 'function') return false;
    const parsed = parseReasoning(String(message.mes || ''));
    if (!parsed?.reasoning) return false;

    message.extra ??= {};
    message.extra.reasoning = parsed.reasoning;
    message.extra.reasoning_type = 'parsed';
    message.mes = parsed.content;

    const swipeId = Number(message.swipe_id || 0);
    if (Array.isArray(message.swipes) && swipeId >= 0 && swipeId < message.swipes.length) {
        message.swipes[swipeId] = parsed.content;
    }
    if (Array.isArray(message.swipe_info) && message.swipe_info[swipeId]) {
        message.swipe_info[swipeId].extra ??= {};
        message.swipe_info[swipeId].extra.reasoning = parsed.reasoning;
        message.swipe_info[swipeId].extra.reasoning_type = 'parsed';
    }
    return true;
}
