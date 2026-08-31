import crypto from 'node:crypto';
import { KeyedLock } from '../nora-world-core/locks.js';
import { BATCH_TURNS, containsLedger, countTurns, coveredMessageCount, prefixText, renderLedger, scopeKey } from '../../public/scripts/nora-story-ledger/history.js';
import { batchSegments, normalizeLedger } from './schema.js';

export class LedgerConflict extends Error {
    constructor(message, code = 'NORA_LEDGER_HISTORY_LOCKED') {
        super(message);
        this.code = code;
        this.status = 409;
    }
}

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const signature = (messages, count) => hash(prefixText(messages, count));
export const matchesLedgerHistory = (record, messages) => record && record.coveredTurns > 0 && record.coveredTurns % BATCH_TURNS === 0
    && record.coveredTurns <= countTurns(messages) && record.messageCount === coveredMessageCount(messages, record.coveredTurns)
    && record.signature === signature(messages, record.messageCount);
const valid = matchesLedgerHistory;

/** Stateful headless plugin. Model I/O never holds the chat write lock. */
export function createStoryLedger({ readChat, readState, writeState, merge, now = Date.now, report = () => {} }) {
    const locks = new KeyedLock();
    const jobs = new Map();
    const reservations = new Map();
    // One background model call per user, independent of foreground generation.
    let queue = Promise.resolve();
    const initial = () => ({ version: 1, enabled: true, active: null, pending: null, lastError: null });
    const load = scope => ({ ...initial(), ...readState(scope) });
    const run = (scope, operation) => locks.run(scopeKey(scope), operation);
    function discardStaleCandidates(state, messages) {
        let changed = false;
        for (const key of ['pending', 'imported']) if (state[key] && !valid(state[key], messages)) {
            state[key] = null;
            changed = true;
        }
        return changed;
    }
    function checked(scope) {
        const state = load(scope);
        const chat = readChat(scope);
        if (state.active && !valid(state.active, chat.messages)) {
            throw new LedgerConflict('Active story ledger no longer matches stored history.', 'NORA_LEDGER_STORAGE_CONFLICT');
        }
        if (discardStaleCandidates(state, chat.messages)) writeState(scope, state);
        return { state, chat };
    }
    function projection(scope, state, chat) {
        return { ...scope, enabled: state.enabled, batchTurns: BATCH_TURNS,
            totalTurns: countTurns(chat.messages), active: state.active, pending: state.pending,
            running: jobs.has(scopeKey(scope)), lastError: state.lastError };
    }
    const status = scope => run(scope, () => {
        const { state, chat } = checked(scope);
        return projection(scope, state, chat);
    });

    // Agent reads must neither schedule model work nor repair persisted state.
    const inspect = (scope, { offset = 0, limit = 0 } = {}) => run(scope, () => {
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 0 || limit > 100) throw new TypeError('Invalid history window.');
        const state = load(scope);
        const chat = readChat(scope);
        if (state.active && !valid(state.active, chat.messages)) throw new LedgerConflict('Active ledger no longer matches history.', 'NORA_LEDGER_STORAGE_CONFLICT');
        const held = [...(reservations.get(scopeKey(scope))?.values() || [])];
        const lockedCount = Math.max(0, ...[state.active, ...held].filter(Boolean).map(record => record.messageCount));
        const pendingValid = !state.pending || valid(state.pending, chat.messages);
        return { ...projection(scope, { ...state, pending: pendingValid ? state.pending : null }, chat),
            stalePending: !pendingValid, expectedSignature: signature(chat.messages, chat.messages.length),
            messageCount: chat.messages.length, offset,
            nextOffset: limit > 0 && offset + limit < chat.messages.length ? offset + limit : null,
            messages: chat.messages.slice(offset, offset + limit).map((message, index) => ({
                messageId: offset + index, name: String(message.name || ''), isUser: message.is_user === true,
                isSystem: message.is_system === true, text: String(message.mes || ''),
                editable: offset + index >= lockedCount && !message.is_system,
            })) };
    });

    async function compress(scope) {
        for (;;) {
            const input = await run(scope, () => {
                const { state, chat } = checked(scope);
                if (!state.enabled) return null;
                const previous = state.pending || state.active;
                const covered = previous?.coveredTurns || 0;
                const end = covered + BATCH_TURNS;
                // Foreground must first persist a real answer; failed/in-flight
                // user sends do not trigger a background billable request.
                const last = chat.messages.findLast(message => !message.is_system);
                if (end > countTurns(chat.messages) - 1 || !last || last.is_user || !String(last.mes || '').trim()) return null;
                const count = coveredMessageCount(chat.messages, end);
                return { previous, end, count, signature: signature(chat.messages, count),
                    segments: batchSegments(chat.messages, covered + 1, end), entities: chat.entities || ['__user__'],
                    playerName: chat.playerName || '', entityBindings: chat.entityBindings, language: chat.language || 'zh' };
            });
            if (!input) return;
            let ledger = input.previous?.ledger || {};
            for (const segment of input.segments) {
                ledger = normalizeLedger(await merge({ previous: ledger, segment, entities: input.entities,
                    playerName: input.playerName, entityBindings: input.entityBindings, language: input.language }), ledger, input.entities);
            }
            const published = await run(scope, () => {
                const { state, chat } = checked(scope);
                const previous = state.pending || state.active;
                if (!state.enabled || (previous?.id || null) !== (input.previous?.id || null)
                    || signature(chat.messages, input.count) !== input.signature
                    || countTurns(chat.messages) <= input.end) return false;
                state.pending = { id: crypto.randomUUID(), coveredTurns: input.end, messageCount: input.count,
                    signature: input.signature, ledger, createdAt: now() };
                state.lastError = null;
                writeState(scope, state);
                report('candidate', { ...scope, coveredTurns: input.end });
                return true;
            });
            if (!published) return; // edited, disabled, or another checkpoint advanced
        }
    }

    function schedule(scope, { retry = false } = {}) {
        const key = scopeKey(scope);
        if (jobs.has(key)) return jobs.get(key);
        const state = load(scope);
        if (!state.enabled || (!retry && state.lastError && now() - state.lastError.at < 60000)) return Promise.resolve();
        const { messages } = readChat(scope);
        const covered = (state.pending || state.active)?.coveredTurns || 0;
        const last = messages.findLast(message => !message.is_system);
        if (covered + BATCH_TURNS > countTurns(messages) - 1 || !last || last.is_user || !String(last.mes || '').trim()) return Promise.resolve();
        const job = queue.then(() => compress(scope)).catch(async error => {
            const code = error.name === 'TimeoutError' ? 'NORA_LEDGER_COMPRESSION_TIMEOUT'
                : typeof error.code === 'string' && error.code.startsWith('NORA_') ? error.code : 'NORA_LEDGER_COMPRESSION_FAILED';
            await run(scope, () => {
                const current = load(scope);
                // Never persist model output, credentials or arbitrary upstream
                // error bodies. Detailed prompts stay out of operational logs.
                current.lastError = { code, at: now() };
                writeState(scope, current);
            });
            report('compression-failed', { ...scope, code });
        }).finally(() => jobs.delete(key));
        jobs.set(key, job);
        queue = job.catch(() => {});
        return job;
    }

    async function writeChat(scope, messages, writer) {
        return run(scope, () => {
            const { state } = checked(scope);
            assertWritable(scope, state, messages);
            // Writer is synchronous: no interleaving between guard and JSONL commit.
            const result = writer();
            if (discardStaleCandidates(state, messages)) writeState(scope, state);
            return result;
        });
    }

    function assertWritable(scope, state, messages) {
        const held = [...(reservations.get(scopeKey(scope))?.values() || [])];
        for (const record of [state.active, ...held].filter(Boolean)) {
            if (!valid(record, messages)) throw new LedgerConflict('已压缩并进入上下文的历史不可修改；发送中的账本批次也需等待发送结束。');
        }
    }

    async function edit(scope, { messageId, text, bias = null, expectedSignature }, writer) {
        await run(scope, () => {
            const { state, chat } = checked(scope);
            if (signature(chat.messages, chat.messages.length) !== expectedSignature) {
                throw new LedgerConflict('Chat changed before editing. Reload before retrying.', 'NORA_LEDGER_EDIT_STALE');
            }
            if (!Number.isInteger(messageId) || messageId < 0 || !chat.messages[messageId] || chat.messages[messageId].is_system
                || typeof text !== 'string' || !text.trim() || (bias !== null && typeof bias !== 'string')) throw new TypeError('A valid narrative message and non-empty text are required.');
            const messages = structuredClone(chat.messages.slice(0, messageId + 1));
            messages[messageId].mes = text;
            messages[messageId].extra = { ...messages[messageId].extra, bias };
            if (Array.isArray(messages[messageId].swipes)) messages[messageId].swipes[messages[messageId].swipe_id || 0] = text;
            assertWritable(scope, state, messages);
            writer(messages);
            discardStaleCandidates(state, messages);
            state.lastError = null;
            writeState(scope, state);
        });
    }

    async function reserve(scope, recordId, outgoingMessages) {
        const token = crypto.randomUUID();
        const record = await run(scope, () => {
            const { state } = checked(scope);
            const record = [state.pending, state.active].find(item => item?.id === recordId);
            if (!record || !containsLedger(outgoingMessages, renderLedger(record))) {
                throw new LedgerConflict('Prepared story ledger is stale or missing from outgoing context.', 'NORA_LEDGER_CONTEXT_STALE');
            }
            const held = reservations.get(scopeKey(scope)) || new Map();
            held.set(token, record);
            reservations.set(scopeKey(scope), held);
            return record;
        });
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            const held = reservations.get(scopeKey(scope));
            held?.delete(token);
            if (!held?.size) reservations.delete(scopeKey(scope));
        };
        return {
            accept: () => run(scope, () => {
                if (released) throw new LedgerConflict('Ledger dispatch already ended.', 'NORA_LEDGER_CONTEXT_STALE');
                const { state, chat } = checked(scope);
                if (!valid(record, chat.messages)) throw new LedgerConflict('History changed during generation.');
                if (!state.active || state.active.coveredTurns < record.coveredTurns) {
                    state.active = { ...record, activatedAt: now() };
                    if (state.imported) state.imported = null;
                    if (state.pending?.coveredTurns <= record.coveredTurns) state.pending = null;
                    writeState(scope, state);
                    report('activated', { ...scope, coveredTurns: record.coveredTurns });
                }
            }),
            release,
        };
    }

    async function configure(scope, { enabled }) {
        if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
        await run(scope, () => {
            const state = load(scope);
            state.enabled = enabled;
            if (!enabled) state.pending = null;
            writeState(scope, state);
        });
        if (enabled) void schedule(scope, { retry: true });
        return status(scope);
    }
    return Object.freeze({ status, inspect, schedule, writeChat, edit, reserve, configure });
}
