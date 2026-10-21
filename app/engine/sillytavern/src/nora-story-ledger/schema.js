// Ported from v1.24.12 app/backend/story_state_service.py. Deliberately no
// runtime_cast/MVU writes: their state has a separate authority in Nora.
import { isDeepStrictEqual } from 'node:util';

const fields = ['timeline', 'facts', 'open_threads', 'objects', 'secrets', 'scene', 'style_notes'];
const exact = (object, keys) => object && !Array.isArray(object)
    && Object.keys(object).sort().join(',') === [...keys].sort().join(',');
const text = value => typeof value === 'string';
const nonempty = value => text(value) && value.trim().length > 0;
const limitFailure = () => {
    throw Object.assign(new Error('Story ledger exceeds a field or collection limit; no content was truncated.'), {
        code: 'NORA_LEDGER_SCHEMA_LIMIT_EXCEEDED',
    });
};
const bounded = (value, limit, { identity = false } = {}) => {
    const normalized = identity ? value.trim() : value.trim().replace(/^[-•]\s*/, '').replace(/\s+/g, ' ').trim();
    if (normalized.length > limit) limitFailure();
    return normalized;
};

export function normalizeLedger(raw, previous = {}, allowedIds = ['__user__']) {
    const invalid = () => { throw new Error('Invalid story ledger schema or entity reference.'); };
    if (!exact(raw, fields)) invalid();
    for (const key of fields.filter(key => key !== 'scene')) if (!Array.isArray(raw[key])) invalid();
    for (const key of ['timeline', 'open_threads', 'style_notes']) if (!raw[key].every(nonempty)) invalid();
    const allowed = new Set(allowedIds);
    for (const key of ['facts', 'secrets']) for (const item of raw[key]) {
        if (!exact(item, ['id', 'content', 'known_by']) || !nonempty(item.id) || !nonempty(item.content)
            || !Array.isArray(item.known_by) || !item.known_by.every(id => allowed.has(id))) invalid();
    }
    for (const item of raw.objects) {
        if (!exact(item, ['id', 'name', 'status', 'holder', 'location']) || !nonempty(item.id) || !nonempty(item.name)
            || !['status', 'holder', 'location'].every(key => text(item[key]))
            || (item.holder && !allowed.has(item.holder))) invalid();
    }
    if (!exact(raw.scene, ['time', 'place', 'participants']) || !text(raw.scene.time) || !text(raw.scene.place)
        || !Array.isArray(raw.scene.participants)) invalid();
    for (const item of raw.scene.participants) {
        if (!exact(item, ['character_id', 'location', 'activity', 'condition'])
            || !Object.values(item).every(text) || !allowed.has(item.character_id)) invalid();
    }
    // One registered identity denotes one actor, not a placeholder for every
    // named NPC. Reject ambiguity so the same-model schema retry can correct it.
    if (new Set(raw.scene.participants.map(item => item.character_id)).size !== raw.scene.participants.length) invalid();
    const strings = (key, count, length) => {
        const values = [...new Set(raw[key].map(value => bounded(value, length)))];
        if (values.some(value => !value)) invalid();
        if (values.length > count) limitFailure();
        return values;
    };
    const unique = (items, count) => {
        const values = new Map();
        for (const item of items) {
            if (values.has(item.id) && !isDeepStrictEqual(values.get(item.id), item)) invalid();
            values.set(item.id, item);
        }
        if (values.size > count) limitFailure();
        return [...values.values()];
    };
    const facts = key => unique(raw[key].map(item => ({ id: bounded(item.id, 80, { identity: true }), content: bounded(item.content, 220), known_by: [...new Set(item.known_by)] })), key === 'facts' ? 24 : 16);
    if (raw.scene.participants.length > 24) limitFailure();
    const ledger = {
        timeline: strings('timeline', 12, 120), facts: facts('facts'), open_threads: strings('open_threads', 12, 140),
        objects: unique(raw.objects.map(item => ({ id: bounded(item.id, 160, { identity: true }), name: bounded(item.name, 160),
            status: bounded(item.status, 160), holder: item.holder, location: bounded(item.location, 160) })), 16),
        secrets: facts('secrets'),
        scene: { time: bounded(raw.scene.time, 160), place: bounded(raw.scene.place, 160), participants: raw.scene.participants.map(item => ({
            character_id: item.character_id, location: bounded(item.location, 160), activity: bounded(item.activity, 160), condition: bounded(item.condition, 160),
        })) },
        style_notes: strings('style_notes', 6, 120),
    };
    const lists = ['style_notes', 'timeline', 'facts', 'objects', 'open_threads', 'secrets'];
    if (JSON.stringify(ledger).length > 15000) throw Object.assign(new Error('Story ledger exceeds its 15000-character memory budget.'), {
        code: 'NORA_LEDGER_MEMORY_BUDGET_EXCEEDED',
    });
    if (!lists.some(key => ledger[key].length)) throw new Error('Story ledger contains no memory.');
    for (const keys of [['open_threads', 'objects', 'secrets'], ['timeline', 'facts']]) {
        const count = state => keys.reduce((sum, key) => sum + (state[key]?.length || 0), 0);
        if (count(previous) >= 6 && count(ledger) < 2) throw new Error('Story ledger lost too much established memory.');
    }
    return ledger;
}

export function estimateTokens(value) {
    const cjk = (value.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu) || []).length;
    const other = value.replace(/[\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu, '').length;
    return cjk + Math.ceil(other / 4);
}

export function batchSegments(messages, startTurn, endTurn, tokenBudget = 50000) {
    const turns = new Map();
    let turn = 0;
    for (const message of messages) {
        if (message.is_user && !message.is_system) turn++;
        if ((turn < startTurn && !(startTurn === 1 && turn === 0)) || turn > endTurn || message.is_system) continue;
        const key = Math.max(1, turn);
        const entry = `[Turn ${turn} · ${message.is_user ? 'User' : message.name || 'Story'}]\n${String(message.mes || '').trim()}`;
        turns.set(key, [...(turns.get(key) || []), entry]);
    }
    const result = [];
    let current = null;
    for (const [number, entries] of turns) {
        const value = entries.join('\n');
        const tokens = estimateTokens(value);
        if (!current || current.tokens + tokens > tokenBudget) {
            current = { startTurn: number, endTurn: number, text: '', tokens: 0, parts: [] };
            result.push(current);
        }
        current.text += `${current.text ? '\n' : ''}${value}`;
        current.tokens += tokens;
        current.parts.push({ startTurn: number, endTurn: number, text: value });
        current.endTurn = number;
    }
    return result;
}
