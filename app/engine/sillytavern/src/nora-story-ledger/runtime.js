import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { resolveNoraWorldCore } from '../nora-world-core/runtime.js';
import { createStoryLedger, LedgerConflict } from './core.js';
import { ledgerStatePath } from './state-file.js';
import { requestStoryProjection } from './profile-projection.js';
import { scopeKey, scopeOf } from '../../public/scripts/nora-story-ledger/history.js';

const runtimes = new Map();
function jsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

export function resolveStoryLedger(directories, { recoverProjection = true } = {}) {
    const key = path.resolve(directories.root);
    if (runtimes.has(key)) {
        const runtime = runtimes.get(key);
        if (recoverProjection) runtime.recoverProjection();
        return runtime;
    }
    const bindings = new Map();
    const root = path.join(key, 'nora-story-ledger');
    const statePath = scope => ledgerStatePath(key, scope);
    const plugin = createStoryLedger({
        readChat: scope => {
            const binding = bindings.get(scopeKey(scope));
            if (!binding) throw new Error('Story ledger scope has not been resolved.');
            const data = jsonl(binding.filePath);
            if (scopeKey(scopeOf(data[0]?.chat_metadata)) !== scopeKey(scope)) {
                throw new LedgerConflict('Story Session identity is missing or changed.', 'NORA_LEDGER_STORAGE_CONFLICT');
            }
            return { messages: data.slice(1), entities: ['__user__'], playerName: binding.playerName, language: binding.language };
        },
        readState: scope => fs.existsSync(statePath(scope)) ? JSON.parse(fs.readFileSync(statePath(scope), 'utf8')) : null,
        writeState: (scope, state) => {
            // A completed/cancelled World deletion must not be resurrected by
            // a background compression finishing or failing afterwards.
            const binding = bindings.get(scopeKey(scope));
            if (binding && !fs.existsSync(binding.filePath)) return;
            const previous = fs.existsSync(statePath(scope)) ? JSON.parse(fs.readFileSync(statePath(scope), 'utf8')) : null;
            fs.mkdirSync(root, { recursive: true });
            writeFileAtomicSync(statePath(scope), JSON.stringify(state), 'utf8');
            if (state.active?.id && previous?.active?.id !== state.active.id) void requestStoryProjection(directories);
        },
        merge: input => import('./model.js').then(module => module.mergeWithActiveModel(directories, input)),
        report: (event, details) => console.info('[Story Ledger]', event, details),
    });
    async function resolve(scope, expectedPath = null) {
        const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(value);
        if (!scope || !identity(scope.worldId) || !identity(scope.sessionId)) throw new TypeError('World and Story Session are required.');
        const world = await resolveNoraWorldCore(directories).getWorld(scope.worldId);
        const session = world?.sessions?.items?.find(item => item.session_id === scope.sessionId);
        if (world?.lifecycle?.status !== 'READY' || !session) throw new LedgerConflict('Story Session is unavailable.', 'NORA_LEDGER_SESSION_UNAVAILABLE');
        const avatar = String(world.runtime_card.binding.avatar);
        if (path.basename(avatar) !== avatar || !session.binding.chat_id) throw new LedgerConflict('Invalid Story Session binding.', 'NORA_LEDGER_STORAGE_CONFLICT');
        const filePath = path.join(directories.chats, avatar.replace(/\.png$/i, ''), sanitize(`${session.binding.chat_id}.jsonl`));
        if (expectedPath && path.resolve(filePath) !== path.resolve(expectedPath)) {
            throw new LedgerConflict('Story Session does not own this chat.', 'NORA_LEDGER_SESSION_MISMATCH');
        }
        const binding = { filePath, language: 'zh', playerName: String(world.persona?.name || '') };
        bindings.set(scopeKey(scope), binding);
        return binding;
    }
    async function writeChat(filePath, data, writer) {
        const existing = jsonl(filePath);
        const scope = scopeOf(existing[0]?.chat_metadata) || scopeOf(data[0]?.chat_metadata);
        if (!scope) return writer(); // non-Nora ST chats remain native
        await resolve(scope, filePath);
        if (scopeKey(scopeOf(data[0]?.chat_metadata)) !== scopeKey(scope)) throw new LedgerConflict('Cannot replace Story Session identity.');
        const result = await plugin.writeChat(scope, data.slice(1), writer);
        void plugin.schedule(scope);
        return result;
    }
    async function guardDestructive(filePath) {
        const scope = scopeOf(jsonl(filePath)[0]?.chat_metadata);
        if (!scope) return;
        await resolve(scope, filePath);
        // World deletion has its own domain operation; native chat rename/delete
        // must never detach an authoritative Story Session, locked or otherwise.
        throw new LedgerConflict('Use the World operation to remove a Story Session.', 'NORA_LEDGER_SESSION_OWNED');
    }
    async function edit(scope, request) {
        const { filePath } = await resolve(scope);
        let result;
        await plugin.edit(scope, request, messages => {
            const header = jsonl(filePath)[0];
            header.chat_metadata.tainted = true;
            result = [header, ...messages];
            writeFileAtomicSync(filePath, result.map(item => JSON.stringify(item)).join('\n'), 'utf8');
        });
        void plugin.schedule(scope);
        return result;
    }
    let projectionRecovered = false;
    function recover() {
        if (projectionRecovered) return;
        projectionRecovered = true;
        if (fs.existsSync(root)) void requestStoryProjection(directories);
    }
    const runtime = Object.freeze({ plugin, resolve, writeChat, edit, guardDestructive, recoverProjection: recover });
    runtimes.set(key, runtime);
    // Once per process/user on first ledger use: recover an activation that
    // committed before a restart, or a previously interrupted memory write.
    if (recoverProjection) recover();
    return runtime;
}
