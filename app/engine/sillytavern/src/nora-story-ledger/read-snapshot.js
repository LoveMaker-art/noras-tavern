import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import sanitize from 'sanitize-filename';
import { ledgerStatePath } from './state-file.js';
import { normalizeLedger } from './schema.js';
import { LEDGER_MODEL_USE_NOTICE_VERSION } from './core.js';
import { storyEntityBindings } from '../../public/scripts/nora-worlds/story-context.js';
import { BATCH_TURNS, narrative, scopeKey, scopeOf } from '../../public/scripts/nora-story-ledger/history.js';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const revisionOf = stat => stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':') : 'missing';

/** Read the same configured/effective choice as canonical ledger inspection. */
export function ledgerReadModelUseState(state = {}) {
    const configuredEnabled = Object.hasOwn(state || {}, 'enabled') ? state.enabled : true;
    return { configuredEnabled,
        enabled: configuredEnabled === true && state?.modelUseConsent?.noticeVersion === LEDGER_MODEL_USE_NOTICE_VERSION
            && state.modelUseConsent.enabled === true,
        consentRequired: state?.modelUseConsent?.noticeVersion !== LEDGER_MODEL_USE_NOTICE_VERSION };
}
async function fileRevision(file) {
    try { const stat = await fsp.stat(file, { bigint: true }); return stat.isFile() ? revisionOf(stat) : 'not-file'; } catch (error) {
        if (error.code === 'ENOENT') return 'missing'; throw error;
    }
}

/** Scope-local cache of already verified source. It never initializes World
 * Core, opens another Session, writes a derived file, or starts model work. */
export function createStoryLedgerSnapshotReader({ onOpen = () => {}, cacheLimit = 32 } = {}) {
    const cache = new Map();
    async function read(directories, world, session, { includeRecent = false } = {}) {
        const scope = { worldId: world.world_id, sessionId: session.session_id };
        const base = { world_id: scope.worldId, world_name: world.name || '', session_id: scope.sessionId,
            session_name: session.name || '', total_turns: null, covered_turns: null, message_count: null,
            covered_message_count: null, history_signature: null, summary_id: null, status: 'unavailable',
            summary_status: 'none', enabled: null, configuredEnabled: null, consentRequired: null, timeline: [], open_threads: [], scene: null,
            uncovered: null, updated_at: null, ledger: null, recent: [], revision: null, restore_id: null };
        const failed = (status, code) => ({ ...base, status, code, ledger: null, recent: [] });
        if (world.lifecycle?.status !== 'READY') return failed('unavailable', 'NORA_LEDGER_SESSION_UNAVAILABLE');
        const avatar = String(world.runtime_card?.binding?.avatar || ''), chatId = session.binding?.chat_id;
        if (!avatar || path.basename(avatar) !== avatar || !chatId) return failed('unavailable', 'NORA_LEDGER_SESSION_MISMATCH');
        const chatPath = path.join(directories.chats, avatar.replace(/\.png$/i, ''), sanitize(`${chatId}.jsonl`));
        const statePath = ledgerStatePath(directories.root, scope);
        const key = JSON.stringify([path.resolve(directories.root), scope.worldId, scope.sessionId]);
        const identity = digest(JSON.stringify([world.world_id, world.name, world.revision, world.lifecycle,
            world.persona, world.story_context, world.runtime_card?.binding, session]));
        let before;
        try { before = await Promise.all([fileRevision(chatPath), fileRevision(statePath)]); } catch {
            return failed('unavailable', 'NORA_LEDGER_SOURCE_UNREADABLE');
        }
        const stamp = JSON.stringify([identity, before]);
        const withProof = snapshot => Object.defineProperty(snapshot, 'isCurrent', { value: async () => {
            try { return isDeepStrictEqual(before, await Promise.all([fileRevision(chatPath), fileRevision(statePath)])); } catch { return false; }
        } });
        const current = cache.get(key);
        if (current?.stamp === stamp && (!includeRecent || current.includeRecent)) {
            const after = await Promise.all([fileRevision(chatPath), fileRevision(statePath)]).catch(() => []);
            if (!isDeepStrictEqual(before, after)) { cache.delete(key); return failed('stale', 'NORA_LEDGER_SOURCE_CHANGED'); }
            cache.delete(key); cache.set(key, current);
            return withProof(structuredClone(current.snapshot));
        }
        cache.delete(key);
        if (['missing', 'not-file'].includes(before[0])) return failed('unavailable', 'NORA_LEDGER_CHAT_UNREADABLE');
        let state = null, stateCode = null, stateText = '';
        if (before[1] === 'not-file') stateCode = 'NORA_LEDGER_STATE_UNREADABLE';
        else if (before[1] !== 'missing') {
            try {
                await onOpen(statePath);
                stateText = await fsp.readFile(statePath, 'utf8'); state = JSON.parse(stateText);
                if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('Invalid ledger state.');
            } catch { stateCode = 'NORA_LEDGER_STATE_UNREADABLE'; }
        }
        const candidates = stateCode ? [] : [
            { record: state?.pending, status: 'prepared' },
            { record: state?.active?.activatedAt ? state.active : null, status: 'active' },
            { record: state?.imported?.source === 'python-validated' ? state.imported : null, status: 'prepared' },
        ].filter(item => item.record);
        const prefixCounts = new Set(candidates.map(item => item.record.messageCount).filter(Number.isSafeInteger));
        const turnCounts = new Set(candidates.map(item => item.record.coveredTurns).filter(Number.isSafeInteger));
        const signatures = new Map(), coveredCounts = new Map(), recent = [];
        let header, messageCount = 0, totalTurns = 0, chatFailed = false;
        const signature = crypto.createHash('sha256').update('[');
        let stream, lines;
        try {
            await onOpen(chatPath);
            stream = fs.createReadStream(chatPath, { encoding: 'utf8' });
            lines = createInterface({ input: stream, crlfDelay: Infinity });
            for await (const line of lines) {
                if (!line.trim()) continue;
                const message = JSON.parse(line);
                if (header === undefined) {
                    header = message;
                    if (scopeKey(scopeOf(header?.chat_metadata)) !== scopeKey(scope)) throw new Error('Foreign chat.');
                    continue;
                }
                if (message?.is_user && !message.is_system) {
                    totalTurns++;
                    if (turnCounts.has(totalTurns - 1)) coveredCounts.set(totalTurns - 1, messageCount);
                }
                signature.update(messageCount ? ',' : '').update(JSON.stringify(narrative(message)));
                messageCount++;
                if (prefixCounts.has(messageCount)) signatures.set(messageCount, signature.copy().update(']').digest('hex'));
                if (includeRecent && !message?.is_system && String(message?.mes || '').trim()) {
                    const text = String(message.mes);
                    recent.push(text.length > 6000 ? { messageId: messageCount - 1, userTurn: totalTurns, oversized: true, chars: text.length }
                        : { messageId: messageCount - 1, userTurn: totalTurns, isUser: message.is_user === true, text });
                    if (recent.length > 10) recent.shift();
                }
            }
            if (!header) throw new Error('Missing chat header.');
        } catch { chatFailed = true; } finally { lines?.close(); stream?.destroy(); }
        let after;
        try { after = await Promise.all([fileRevision(chatPath), fileRevision(statePath)]); } catch {
            return failed('stale', 'NORA_LEDGER_SOURCE_CHANGED');
        }
        if (!isDeepStrictEqual(before, after)) return failed('stale', 'NORA_LEDGER_SOURCE_CHANGED');
        if (chatFailed) return failed('unavailable', 'NORA_LEDGER_CHAT_UNREADABLE');
        base.total_turns = totalTurns; base.message_count = messageCount; base.covered_turns = 0; base.covered_message_count = 0;
        base.history_signature = signature.update(']').digest('hex'); base.restore_id = header.chat_metadata?.nora_restore?.id || null;
        base.uncovered = { from_user_turn: totalTurns ? 1 : null, to_user_turn: totalTurns || null, count: totalTurns };
        if (!stateCode) Object.assign(base, ledgerReadModelUseState(state));
        base.revision = digest(JSON.stringify([stamp, base.history_signature, digest(stateText), base.restore_id]));
        base.recent = recent;
        let snapshot;
        if (stateCode) snapshot = { ...base, status: 'error', code: stateCode };
        else if (state && base.restore_id !== (state.restoreId || null)) snapshot = { ...base, status: 'stale', code: 'NORA_LEDGER_RESTORE_CHANGED' };
        else {
            const allowed = Object.keys(storyEntityBindings(world.story_context, String(world.persona?.name || '')));
            const valid = candidates.filter(({ record }) => {
                if (!Number.isSafeInteger(record.coveredTurns) || record.coveredTurns <= 0 || record.coveredTurns % BATCH_TURNS !== 0
                    || record.coveredTurns > totalTurns || !Number.isSafeInteger(record.messageCount)
                    || record.messageCount !== (coveredCounts.get(record.coveredTurns) ?? messageCount)
                    || record.signature !== signatures.get(record.messageCount)) return false;
                try { return isDeepStrictEqual(normalizeLedger(record.ledger, {}, allowed), record.ledger); } catch { return false; }
            }).sort((a, b) => b.record.coveredTurns - a.record.coveredTurns || Number(b.status === 'active') - Number(a.status === 'active'));
            const chosen = valid[0];
            if (!chosen) snapshot = { ...base, status: candidates.length ? 'stale' : 'unorganized',
                ...(candidates.length ? { code: 'NORA_LEDGER_SOURCE_INVALID' } : {}) };
            else {
                const { record } = chosen;
                snapshot = { ...base, status: 'ready', summary_status: chosen.status, summary_id: record.id,
                    covered_turns: record.coveredTurns, covered_message_count: record.messageCount, ledger: record.ledger,
                    timeline: record.ledger.timeline, open_threads: record.ledger.open_threads, scene: record.ledger.scene,
                    uncovered: { from_user_turn: record.coveredTurns < totalTurns ? record.coveredTurns + 1 : null,
                        to_user_turn: totalTurns || null, count: totalTurns - record.coveredTurns }, updated_at: record.activatedAt || record.createdAt || 0,
                    ...(state.pending && !valid.some(item => item.record === state.pending) ? { stale_candidate: true } : {}),
                    ...(state.lastError ? { code: state.lastError.code } : {}) };
            }
        }
        cache.set(key, { stamp, includeRecent, snapshot: structuredClone(snapshot) });
        while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
        return withProof(snapshot);
    }
    return Object.freeze({ read });
}

export const readStoryLedgerSnapshot = createStoryLedgerSnapshotReader().read;
