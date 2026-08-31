import fs from 'node:fs/promises';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { matchesLedgerHistory } from './core.js';
import { ledgerStatePath } from './state-file.js';
import { scopeKey, scopeOf } from '../../public/scripts/nora-story-ledger/history.js';
import { runStoryProfileAdapter } from '../nora-story-profile-adapter.js';

const projections = new Map();
const report = (event, details) => console.info('[Story Ledger Projection]', event, details);

/** Original Python production shape, derived only from verified active records.
 * A World can have alternative Sessions: project the most recently activated
 * one, never merge mutually exclusive branches into a fabricated shared story.
 */
export async function collectStoryProductions(directories, listWorlds, notify = report) {
    const productions = [];
    for (const world of await listWorlds()) {
        if (world.lifecycle?.status !== 'READY') continue;
        let latest = null;
        for (const session of world.sessions?.items || []) {
            const scope = { worldId: world.world_id, sessionId: session.session_id };
            const statePath = ledgerStatePath(directories.root, scope);
            let state;
            try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            const active = state.active;
            if (!active?.activatedAt) continue; // candidate/failed requests are not memories
            const avatar = String(world.runtime_card?.binding?.avatar || '');
            const chatId = session.binding?.chat_id;
            if (!avatar || path.basename(avatar) !== avatar || !chatId) throw new Error('Invalid projection Session binding.');
            const chatPath = path.join(directories.chats, avatar.replace(/\.png$/i, ''), sanitize(`${chatId}.jsonl`));
            let data;
            try { data = (await fs.readFile(chatPath, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (scopeKey(scopeOf(data[0]?.chat_metadata)) !== scopeKey(scope) || !matchesLedgerHistory(active, data.slice(1))) {
                notify('invalid-history-skipped', scope);
                continue;
            }
            if (!latest || active.activatedAt > latest.activatedAt) latest = active;
        }
        if (latest) productions.push({
            id: world.world_id,
            name: world.name,
            story_state: {
                turns: latest.coveredTurns,
                timeline: latest.ledger.timeline,
                open_threads: latest.ledger.open_threads,
                updated_at: Math.floor(latest.activatedAt / 1000),
            },
        });
    }
    // Stable ties: ordinary World updates must not reorder identical memories.
    return productions.sort((left, right) => left.id.localeCompare(right.id));
}

/** Coalesce activation/deletion notifications and retry failed projections.
 * Callers never wait on Python before returning model tokens. On restart the
 * persisted active ledgers are the recovery source, not a second memory store.
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
            while (dirty) {
                dirty = false;
                await publish(await collect());
                failures = 0;
                notify('synced', {});
            }
            return true;
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
    if (!projections.has(key)) projections.set(key, createStoryProjection({
        collect: async () => {
            // World Core owns creation/deletion; defer resolution until after
            // its materializer has returned, avoiding constructor re-entry.
            const { resolveNoraWorldCore } = await import('../nora-world-core/runtime.js');
            return collectStoryProductions(directories, () => resolveNoraWorldCore(directories).listWorlds());
        },
        publish: async productions => {
            const result = await runStoryProfileAdapter('sync-story-states', { productions });
            if (result.code !== 0 || result.value?.ok !== true) throw new Error('Story projection adapter failed.');
        },
    }));
    return projections.get(key).request();
}
