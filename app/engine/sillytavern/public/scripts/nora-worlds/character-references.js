// Stable World-owned identities, never array positions or display names.
export function characterReference(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(id)) {
        throw new TypeError('Invalid character reference ID.');
    }
    return `{{char::${id}}}`;
}

export function resolveCharacterReference(id, characters = [], { strict = false } = {}) {
    const key = String(id).trim();
    const member = characters.find(character => character.id === key);
    if (member) return member.profile.identity.name;
    const message = `无效人物引用：${key || '空 ID'}（当前世界不存在此人物）`;
    if (strict) throw new Error(message);
    return `[${message}]`;
}

// Return a copy. Saved source text, keys and IDs are never rewritten.
export function resolveCharacterReferences(value, characters = [], options = {}) {
    if (typeof value === 'string') {
        return value.replace(/\{\{char::([^{}]*)\}\}/gi,
            (_, id) => resolveCharacterReference(id, characters, options));
    }
    if (Array.isArray(value)) return value.map(item => resolveCharacterReferences(item, characters, options));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .map(([key, item]) => [key, resolveCharacterReferences(item, characters, options)]));
    return value;
}
