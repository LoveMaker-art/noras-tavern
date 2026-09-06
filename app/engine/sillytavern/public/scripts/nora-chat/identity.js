function normalize(value) {
    return String(value || '').trim();
}

function normalizeChatId(value) {
    return normalize(value).replace(/\.jsonl$/i, '');
}

function createIdentity(kind, firstName, firstValue, secondName, secondValue) {
    if (!firstValue || !secondValue) return null;
    return Object.freeze({
        kind,
        [firstName]: firstValue,
        [secondName]: secondValue,
    });
}

export function createChatIdentity({ avatar, chatId } = {}) {
    return createIdentity('chat', 'avatar', normalize(avatar), 'chatId', normalizeChatId(chatId));
}

export function createStorySessionIdentity({ worldId, sessionId } = {}) {
    return createIdentity('story-session', 'worldId', normalize(worldId), 'sessionId', normalize(sessionId));
}

export function sameNoraIdentity(left, right) {
    if (!left || !right || left.kind !== right.kind) return false;
    if (left.kind === 'chat') {
        return left.avatar === right.avatar && left.chatId === right.chatId;
    }
    if (left.kind === 'story-session') {
        return left.worldId === right.worldId && left.sessionId === right.sessionId;
    }
    return false;
}

export function noraIdentityKey(identity) {
    if (!identity) return null;
    if (identity.kind === 'chat') return JSON.stringify(['chat', identity.avatar, identity.chatId]);
    if (identity.kind === 'story-session') return JSON.stringify(['story-session', identity.worldId, identity.sessionId]);
    return null;
}
