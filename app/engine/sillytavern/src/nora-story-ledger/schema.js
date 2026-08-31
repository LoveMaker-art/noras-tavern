// Ported from v1.24.12 app/backend/story_state_service.py. Deliberately no
// runtime_cast/MVU writes: their state has a separate authority in Nora.
const fields = ['timeline', 'facts', 'open_threads', 'objects', 'secrets', 'scene', 'style_notes'];
const exact = (object, keys) => object && !Array.isArray(object)
    && Object.keys(object).sort().join(',') === [...keys].sort().join(',');
const text = value => typeof value === 'string';
const nonempty = value => text(value) && value.trim().length > 0;
const clip = (value, limit) => value.trim().replace(/^[-•]\s*/, '').replace(/\s+/g, ' ').slice(0, limit).trim();

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
    const strings = (key, count, length) => [...new Set(raw[key].map(value => clip(value, length)))].slice(0, count);
    const unique = (items, count) => [...new Map(items.map(item => [item.id, item])).values()].slice(0, count);
    const facts = key => unique(raw[key].map(item => ({ id: clip(item.id, 80), content: clip(item.content, 220), known_by: [...new Set(item.known_by)] })), key === 'facts' ? 24 : 16);
    const ledger = {
        timeline: strings('timeline', 12, 120), facts: facts('facts'), open_threads: strings('open_threads', 12, 140),
        objects: unique(raw.objects.map(item => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, clip(value, 160)]))), 16),
        secrets: facts('secrets'),
        scene: { time: clip(raw.scene.time, 160), place: clip(raw.scene.place, 160), participants: raw.scene.participants.slice(0, 24).map(item => ({
            character_id: item.character_id, location: clip(item.location, 160), activity: clip(item.activity, 160), condition: clip(item.condition, 160),
        })) },
        style_notes: strings('style_notes', 6, 120),
    };
    const lists = ['style_notes', 'timeline', 'facts', 'objects', 'open_threads', 'secrets'];
    while (JSON.stringify(ledger).length > 15000) {
        const key = lists.find(key => ledger[key].length);
        if (!key) throw new Error('Story ledger exceeds its memory budget.');
        ledger[key].shift();
    }
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
            current = { startTurn: number, endTurn: number, text: '', tokens: 0 };
            result.push(current);
        }
        current.text += `${current.text ? '\n' : ''}${value}`;
        current.tokens += tokens;
        current.endTurn = number;
    }
    return result;
}
