import crypto from 'node:crypto';
import path from 'node:path';
import { readStoryLedgerSnapshot } from './read-snapshot.js';

const cursors = new Map();
const fault = (code, message) => Object.assign(new Error(message), { code });
const chars = value => JSON.stringify(value).length;
const branchName = session => session.name || '未命名分支';
function readOptions(payload = {}, cursor) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fault('STORY_READ_OPTIONS_INVALID', '读取参数必须为对象。');
    const result = {};
    for (const key of ['worldId', 'worldName', 'sessionId', 'sessionName', 'query']) {
        if (payload[key] != null && typeof payload[key] !== 'string') throw fault('STORY_READ_OPTIONS_INVALID', '故事名称、标识和关键词必须为文本。');
        result[key] = (payload[key] || '').trim();
    }
    if (result.query.length > 128) throw fault('STORY_READ_OPTIONS_INVALID', '关键词最长128字符。');
    result.view = payload.view ?? cursor?.view ?? 'overview';
    if (!['overview', 'facts', 'objects', 'threads'].includes(result.view)) throw fault('STORY_READ_OPTIONS_INVALID', '不支持的账本视图。');
    if (payload.includeRecent != null && typeof payload.includeRecent !== 'boolean') throw fault('STORY_READ_OPTIONS_INVALID', 'includeRecent必须为布尔值。');
    result.includeRecent = payload.includeRecent ?? cursor?.includeRecent ?? false;
    result.recentLimit = payload.recentLimit ?? cursor?.recentLimit ?? 6;
    result.maxChars = payload.maxChars ?? 3000;
    if (!Number.isSafeInteger(result.maxChars) || result.maxChars < 1000 || result.maxChars > 6000
        || !Number.isSafeInteger(result.recentLimit) || result.recentLimit < 1 || result.recentLimit > 10) {
        throw fault('STORY_READ_OPTIONS_INVALID', 'maxChars须为1000至6000，recentLimit须为1至10。');
    }
    if (cursor) {
        for (const key of ['worldId', 'sessionId', 'view', 'query', 'includeRecent', 'recentLimit']) {
            if (payload[key] != null && result[key] !== cursor[key]) throw fault('STORY_READ_CURSOR_CONFLICT', '分页条件与原请求不符。');
        }
        result.worldId ||= cursor.worldId; result.sessionId ||= cursor.sessionId;
        if (payload.query == null) result.query = cursor.query;
    }
    return result;
}

function baseReply(status) {
    return { schema: 'nora-story-read/1', read_only: true, model_called: false, status,
        scope: null, source: null, ledger: {}, recent_history: [], omitted: {}, nextCursor: null };
}

function boundedReply(reply, maxChars) {
    if (chars(reply) <= maxChars) return reply;
    for (const key of ['worldName', 'sessionName']) if (reply.scope?.[key]) {
        delete reply.scope[key];
        (reply.omitted.scopeFields ||= []).push(key);
    }
    if (chars(reply) <= maxChars) return reply;
    return { ...baseReply('budget-exceeded'), code: 'STORY_READ_METADATA_TOO_LARGE',
        omitted: { reason: '完整来源身份超过本次返回额度；未截断名称或正文。' } };
}

function choicesReply(status, values, maxChars, scope = null) {
    const reply = { ...baseReply(status), scope, choices: [], omitted: { choices: values.length } };
    for (const value of values.slice(0, 5)) {
        reply.choices.push(value); reply.omitted.choices--;
        if (chars(reply) > maxChars) { reply.choices.pop(); reply.omitted.choices++; break; }
    }
    if (!reply.choices.length && values.length) reply.status = 'budget-exceeded';
    return boundedReply(reply, maxChars);
}

function selectScope(worlds, options) {
    let selected = worlds.filter(world => world.lifecycle?.status !== 'DELETED');
    if (options.worldId) {
        selected = selected.filter(world => world.world_id === options.worldId);
        if (selected[0] && options.worldName && selected[0].name !== options.worldName) throw fault('STORY_READ_SCOPE_CONFLICT', '故事标识与名称不一致，请重新确认目标。');
    } else if (options.worldName) selected = selected.filter(world => world.name === options.worldName);
    if (!selected.length) return { missing: 'WORLD_NOT_FOUND' };
    if (selected.length !== 1) return { choices: selected.map(world => ({ worldId: world.world_id, worldName: world.name })), status: 'choose-world' };
    const world = selected[0], allSessions = world.sessions?.items || [];
    let sessions = allSessions;
    if (options.sessionId) {
        sessions = sessions.filter(session => session.session_id === options.sessionId);
        if (sessions[0] && options.sessionName && branchName(sessions[0]) !== options.sessionName) throw fault('STORY_READ_SCOPE_CONFLICT', '分支标识与名称不一致，请重新确认目标。');
    } else if (options.sessionName) sessions = sessions.filter(session => branchName(session) === options.sessionName);
    if (!sessions.length) return { missing: 'STORY_SESSION_NOT_FOUND' };
    if (sessions.length !== 1) return { status: 'choose-session', scope: { worldId: world.world_id, worldName: world.name },
        choices: sessions.map(session => ({ worldId: world.world_id, worldName: world.name,
            sessionId: session.session_id, sessionName: branchName(session) })) };
    return { world, session: sessions[0] };
}

function ledgerItems(snapshot, options) {
    if (!snapshot.ledger) return [];
    const ledger = snapshot.ledger, items = [];
    const add = (section, values) => values.forEach(value => items.push({ section, value }));
    if (options.view === 'overview') {
        const scene = { ...ledger.scene, participants: ledger.scene.participants.filter(item => item.character_id === '__user__') };
        if (scene.time || scene.place || scene.participants.length) items.push({ section: 'scene', value: scene });
        add('timeline', [...ledger.timeline].reverse()); add('open_threads', ledger.open_threads);
    } else if (options.view === 'facts') add('facts', ledger.facts.filter(item => item.known_by.includes('__user__')));
    else if (options.view === 'objects') add('objects', ledger.objects);
    else add('open_threads', ledger.open_threads);
    const query = options.query.toLowerCase();
    return query ? items.filter(item => JSON.stringify(item.value).toLowerCase().includes(query)) : items;
}

function addItem(reply, item) {
    if (item.section === 'recent') reply.recent_history.push(item.value);
    else if (item.section === 'scene') reply.ledger.scene = item.value;
    else (reply.ledger[item.section] ||= []).push(item.value);
}

function recentOmissions(reply, messageCount, includeRecent) {
    const metadata = reply.omitted.recent;
    metadata.unread = messageCount == null ? null : Math.max(0, messageCount - reply.recent_history.length);
    if (!includeRecent) return;
    metadata.messageIdBase = 0;
    metadata.rangesInclusive = true;
    if (messageCount == null) { metadata.notReturnedMessageIdRanges = null; return; }
    const returned = [...new Set(reply.recent_history.map(item => item.messageId))].sort((a, b) => a - b);
    const ranges = [];
    let start = 0;
    for (const id of returned) {
        if (start < id) ranges.push([start, id - 1]);
        start = id + 1;
    }
    if (start < messageCount) ranges.push([start, messageCount - 1]);
    metadata.notReturnedMessageIdRanges = ranges;
}

/** Exact resolution, one verified source snapshot, complete-item bounded output.
 * Neither the name lookup nor pagination is a second persistent story index. */
export async function readStoryOnDemand({ directories, worlds, payload = {}, readSnapshotFn = readStoryLedgerSnapshot, verifyScopeFn }) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fault('STORY_READ_OPTIONS_INVALID', '读取参数必须为对象。');
    let cursor;
    if (payload.cursor != null) {
        if (typeof payload.cursor !== 'string' || !(cursor = cursors.get(payload.cursor)) || cursor.expires < Date.now()) {
            throw fault('STORY_READ_CURSOR_INVALID', '分页已失效，请重新读取同一故事。');
        }
        if (cursor.root !== path.resolve(directories.root)) throw fault('STORY_READ_CURSOR_CONFLICT', '分页不属于当前实例。');
    }
    const options = readOptions(payload, cursor), selected = selectScope(worlds, options);
    if (selected.choices) return choicesReply(selected.status, selected.choices, options.maxChars, selected.scope);
    if (selected.missing) return { ...baseReply('not-found'), code: selected.missing };
    const { world, session } = selected;
    if (cursor && (cursor.worldId !== world.world_id || cursor.sessionId !== session.session_id)) throw fault('STORY_READ_CURSOR_CONFLICT', '分页不属于指定世界和分支。');
    const snapshot = await readSnapshotFn(directories, world, session, { includeRecent: options.includeRecent });
    const scopeCurrent = !verifyScopeFn || await verifyScopeFn(world, session);
    const sourceCurrent = !snapshot.isCurrent || await snapshot.isCurrent();
    const status = !scopeCurrent || !sourceCurrent || cursor && snapshot.revision !== cursor.revision ? 'stale'
        : snapshot.status === 'unorganized' && snapshot.enabled === false ? 'disabled' : snapshot.status === 'error' ? 'unavailable' : snapshot.status;
    let reply = { ...baseReply(status), scope: { worldId: world.world_id, worldName: world.name,
        sessionId: session.session_id, sessionName: branchName(session) }, source: {
        revision: snapshot.revision, summaryId: snapshot.summary_id, status: snapshot.summary_status,
        coveredTurns: snapshot.covered_turns, totalTurns: snapshot.total_turns, messageCount: snapshot.message_count,
        coveredMessageCount: snapshot.covered_message_count, uncoveredTurns: snapshot.uncovered?.count ?? null,
        restoreId: snapshot.restore_id,
        autoEnabled: snapshot.enabled,
        configuredEnabled: snapshot.configuredEnabled, consentRequired: snapshot.consentRequired,
    }, ...(snapshot.code ? { code: snapshot.code } : {}) };
    if (status === 'stale' && (!scopeCurrent || !sourceCurrent || cursor || snapshot.code === 'NORA_LEDGER_SOURCE_CHANGED')) return boundedReply({ ...reply, code: 'STORY_READ_SOURCE_CHANGED' }, options.maxChars);
    const items = ledgerItems(snapshot, options);
    const recent = options.includeRecent ? (snapshot.recent || []).filter(item => item.messageId >= (snapshot.covered_message_count || 0)).slice(-options.recentLimit) : [];
    const recentOversized = recent.filter(item => item.oversized).length;
    for (const item of recent.filter(item => !item.oversized)) items.push({ section: 'recent', value: item });
    const offset = cursor?.offset || 0;
    reply.omitted = { ledgerItems: 0, oversizedItems: 0, recent: { reason: options.includeRecent ? 'bounded-uncovered-window' : 'not-requested',
        unread: snapshot.message_count ?? null, oversized: recentOversized } };
    recentOmissions(reply, snapshot.message_count, options.includeRecent);
    reply = boundedReply(reply, options.maxChars);
    if (reply.status === 'budget-exceeded') return reply;
    const token = 'story_' + crypto.randomBytes(18).toString('base64url');
    let position = offset, included = 0;
    for (; position < items.length; position++) {
        const candidate = structuredClone(reply); addItem(candidate, items[position]);
        candidate.omitted.ledgerItems = items.slice(position + 1).filter(item => item.section !== 'recent').length;
        recentOmissions(candidate, snapshot.message_count, options.includeRecent);
        candidate.nextCursor = position + 1 < items.length ? token : null;
        if (chars(candidate) > options.maxChars) {
            if (included === 0) { reply.omitted.oversizedItems++; continue; }
            break;
        }
        addItem(reply, items[position]); included++;
    }
    reply.omitted.ledgerItems = items.slice(position).filter(item => item.section !== 'recent').length;
    recentOmissions(reply, snapshot.message_count, options.includeRecent);
    if (items.length > offset && included === 0 && position === items.length) reply.status = 'budget-exceeded';
    if (position < items.length) {
        reply.nextCursor = token;
        cursors.set(token, { root: path.resolve(directories.root), worldId: world.world_id, sessionId: session.session_id,
            revision: snapshot.revision, view: options.view, query: options.query, includeRecent: options.includeRecent,
            recentLimit: options.recentLimit, offset: position, expires: Date.now() + 15 * 60 * 1000 });
        while (cursors.size > 512) cursors.delete(cursors.keys().next().value);
    }
    return boundedReply(reply, options.maxChars);
}
