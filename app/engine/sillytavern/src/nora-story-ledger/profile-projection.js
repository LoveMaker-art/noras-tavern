import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import sanitize from 'sanitize-filename';
import { matchesLedgerHistory } from './core.js';
import { ledgerStatePath } from './state-file.js';
import { normalizeLedger } from './schema.js';
import { ledgerReadModelUseState } from './read-snapshot.js';
import { storyEntityBindings } from '../../public/scripts/nora-worlds/story-context.js';
import { countTurns, prefixText, scopeKey, scopeOf } from '../../public/scripts/nora-story-ledger/history.js';
import { runStoryProfileAdapter } from '../nora-story-profile-adapter.js';

const projections = new Map();
const report = (event, details) => console.info('[Story Ledger Projection]', event, details);

/** Read only canonical chats and source-verified saved summaries. Activation is
 * exclusively an outgoing-context event; reading prepared memory never locks
 * history, schedules a model or repairs a derived file. Every Session remains
 * separate; the MEMORY writer owns its own final selection and size budget. */
export async function collectStoryProgress(directories, listWorlds, notify = report) {
    const result = [];
    for (const world of await listWorlds()) {
        if (world.lifecycle?.status === 'DELETED') continue;
        const sessions = world.sessions?.items || [];
        for (const session of sessions.length ? sessions : [null]) {
            const base = { world_id: world.world_id, world_name: world.name || '', session_id: session?.session_id || null,
                session_name: session?.name || '', total_turns: null, covered_turns: null, message_count: null,
                covered_message_count: null, history_signature: null, summary_id: null,
                status: 'unavailable', summary_status: 'none', enabled: null, configuredEnabled: null, consentRequired: null, timeline: [], open_threads: [], scene: null,
                uncovered: null, updated_at: null, last_played_at: 0 };
            const scope = { worldId: world.world_id, sessionId: session?.session_id };
            const fail = (status, code) => {
                notify('source-unavailable', { ...scope, code });
                return { ...base, status, code };
            };
            if (world.lifecycle?.status !== 'READY' || !session) {
                result.push(fail('unavailable', 'NORA_LEDGER_SESSION_UNAVAILABLE')); continue;
            }
            try {
                const avatar = String(world.runtime_card?.binding?.avatar || '');
                const chatId = session.binding?.chat_id;
                if (!avatar || path.basename(avatar) !== avatar || !chatId) {
                    result.push(fail('unavailable', 'NORA_LEDGER_SESSION_MISMATCH')); continue;
                }
                const chatPath = path.join(directories.chats, avatar.replace(/\.png$/i, ''), sanitize(`${chatId}.jsonl`));
                let data;
                try { data = (await fs.readFile(chatPath, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); } catch (error) {
                    result.push(fail(error.code === 'ENOENT' ? 'unavailable' : 'error', 'NORA_LEDGER_CHAT_UNREADABLE')); continue;
                }
                if (scopeKey(scopeOf(data[0]?.chat_metadata)) !== scopeKey(scope)) {
                    result.push(fail('unavailable', 'NORA_LEDGER_SESSION_MISMATCH')); continue;
                }
                const messages = data.slice(1);
                for (const message of messages) {
                    if (message.is_system || !String(message.mes || '').trim()) continue;
                    const date = message.send_date;
                    const stamp = typeof date === 'number' || (typeof date === 'string' && /^\d+$/.test(date))
                        ? Number(date) : typeof date === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(date) ? Date.parse(date) : NaN;
                    if (Number.isFinite(stamp) && stamp > 0) base.last_played_at = Math.max(base.last_played_at, stamp);
                }
                base.total_turns = countTurns(messages); base.message_count = messages.length;
                base.history_signature = crypto.createHash('sha256').update(prefixText(messages, messages.length)).digest('hex');
                // The canonical chat is confirmed; zero means no currently
                // usable summarized prefix, not that prior work never existed.
                // Failure status/code remain explicit for stale/unreadable state.
                base.covered_turns = 0; base.covered_message_count = 0;
                base.uncovered = uncoveredRange(0, base.total_turns);
                let state;
                try { state = JSON.parse(await fs.readFile(ledgerStatePath(directories.root, scope), 'utf8')); } catch (error) {
                    if (error.code !== 'ENOENT') { result.push(fail('error', 'NORA_LEDGER_STATE_UNREADABLE')); continue; }
                    Object.assign(base, ledgerReadModelUseState());
                    result.push({ ...base, status: 'unorganized', covered_turns: 0, covered_message_count: 0,
                        uncovered: uncoveredRange(0, base.total_turns) }); continue;
                }
                if (!state || typeof state !== 'object' || Array.isArray(state)) {
                    result.push(fail('error', 'NORA_LEDGER_STATE_INVALID')); continue;
                }
                Object.assign(base, ledgerReadModelUseState(state));
                if ((data[0]?.chat_metadata?.nora_restore?.id || null) !== (state.restoreId || null)) {
                    result.push(fail('stale', 'NORA_LEDGER_RESTORE_CHANGED')); continue;
                }
                const allowed = Object.keys(storyEntityBindings(world.story_context, String(world.persona?.name || '')));
                const candidates = [
                    { record: state.pending, status: 'prepared' },
                    { record: state.active?.activatedAt ? state.active : null, status: 'active' },
                    { record: state.imported?.source === 'python-validated' ? state.imported : null, status: 'prepared' },
                ];
                const valid = candidates.filter(({ record }) => {
                    if (!record || !matchesLedgerHistory(record, messages)) return false;
                    try { return isDeepStrictEqual(normalizeLedger(record.ledger, {}, allowed), record.ledger); } catch { return false; }
                }).sort((a, b) => b.record.coveredTurns - a.record.coveredTurns
                    || Number(b.status === 'active') - Number(a.status === 'active'));
                const chosen = valid[0];
                if (!chosen) {
                    if (candidates.some(item => item.record)) result.push(fail('stale', 'NORA_LEDGER_SOURCE_INVALID'));
                    else result.push({ ...base, status: 'unorganized', covered_turns: 0, covered_message_count: 0,
                        uncovered: uncoveredRange(0, base.total_turns), ...(state.lastError ? { code: state.lastError.code } : {}) });
                    continue;
                }
                const { record } = chosen;
                result.push({ ...base, status: 'ready', summary_status: chosen.status, summary_id: record.id,
                    covered_turns: record.coveredTurns, covered_message_count: record.messageCount,
                    timeline: structuredClone(record.ledger.timeline), open_threads: structuredClone(record.ledger.open_threads),
                    scene: structuredClone(record.ledger.scene),
                    uncovered: uncoveredRange(record.coveredTurns, base.total_turns),
                    updated_at: record.activatedAt || record.createdAt || 0,
                    ...(state.pending && !valid.some(item => item.record === state.pending) ? { stale_candidate: true } : {}),
                    ...(state.lastError ? { code: state.lastError.code } : {}) });
            } catch {
                result.push(fail('error', 'NORA_LEDGER_PROGRESS_UNREADABLE'));
            }
        }
    }
    return result.sort((a, b) => String(a.world_id).localeCompare(String(b.world_id))
        || String(a.session_id).localeCompare(String(b.session_id)));
}

function uncoveredRange(covered, total) {
    return { from_user_turn: covered < total ? covered + 1 : null, to_user_turn: total || null, count: Math.max(0, total - covered) };
}

/** Python projection input uses the same full per-Session read model. Unusable
 * states remain visible as metadata but cannot become shared story content. */
export async function collectStoryProductions(directories, listWorlds, notify = report) {
    return (await collectStoryProgress(directories, listWorlds, notify)).map(item => ({
        id: item.world_id, world_id: item.world_id, name: item.world_name, session_id: item.session_id, session_name: item.session_name,
        total_turns: item.total_turns, story_state: {
            status: item.summary_status === 'none' ? item.status === 'unorganized' ? 'missing' : item.status : item.summary_status,
            enabled: item.enabled, turns: item.covered_turns, covered_turns: item.covered_turns, total_turns: item.total_turns,
            message_count: item.message_count, covered_message_count: item.covered_message_count,
            timeline: item.timeline, open_threads: item.open_threads, scene: item.scene, updated_at: item.updated_at,
            ...(item.code ? { code: item.code } : {}),
        },
    }));
}

/** Coalesce prepared/activation/deletion notifications and retry failed projections.
 * Callers never wait on Python before returning model tokens. On restart the
 * persisted verified ledgers are the recovery source, not a second memory store.
 */
export function createStoryProjection({ collect, publish, notify = report, retryMs = 5000 }) {
    let dirty = false;
    let running = null;
    let timer = null;
    let failures = 0;
    function request() {
        dirty = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (!running) running = Promise.resolve().then(async () => {
            let complete = true;
            while (dirty) {
                dirty = false;
                const outcome = await publish(await collect());
                failures = 0;
                complete = outcome?.status !== 'pending';
                notify(complete ? 'synced' : 'pending', complete ? {} : { code: outcome.code });
            }
            return complete;
        }).catch(() => {
            dirty = true;
            failures++;
            const delay = Math.min(60000, retryMs * 2 ** Math.min(failures - 1, 4));
            // No raw adapter errors: stderr can contain private file contents.
            notify('retry-scheduled', { code: 'NORA_STORY_PROJECTION_FAILED', retryMs: delay });
            timer = setTimeout(() => { timer = null; void request(); }, delay);
            timer.unref?.();
            return false;
        }).finally(() => { running = null; });
        return running;
    }
    return Object.freeze({ request });
}

export function requestStoryProjection(directories) {
    const key = path.resolve(directories.root);
    if (!projections.has(key)) {
        // Retries remain bound to the originating instance even if a test or
        // embedding process later changes its global environment.
        const adapterEnv = { ...process.env };
        projections.set(key, createStoryProjection({
            collect: async () => {
                // World Core owns creation/deletion; defer resolution until after
                // its materializer has returned, avoiding constructor re-entry.
                const { resolveNoraWorldCore } = await import('../nora-world-core/runtime.js');
                return collectStoryProductions(directories, () => resolveNoraWorldCore(directories).inspectWorlds());
            },
            publish: async productions => {
                return storyProjectionOutcome(await runStoryProfileAdapter('sync-story-states', { productions }, { env: adapterEnv }));
            },
        }));
    }
    return projections.get(key).request();
}

/** Story and USER projections have independent outcomes. Source data can be
 * saved while USER needs another summary, or MEMORY has insufficient room. */
export function storyProjectionOutcome(result) {
    if (result.code !== 0 || result.value?.ok !== true) throw new Error('Story projection adapter failed.');
    const targets = result.value.projections;
    const memory = targets?.memory || targets?.targets?.['MEMORY.md'];
    if (!memory) throw new Error('Story projection receipt is missing.');
    if (memory.status === 'complete') return { status: 'complete' };
    if (['STORY_PROFILE_MEMORY_BUDGET_EXHAUSTED', 'STORY_PROFILE_MEMORY_MARKERS_UNCONFIRMED',
        'STORY_PROFILE_PROJECTION_STALE'].includes(memory.code)) return { status: 'pending', code: memory.code };
    throw new Error('Story memory projection needs an I/O retry.');
}
