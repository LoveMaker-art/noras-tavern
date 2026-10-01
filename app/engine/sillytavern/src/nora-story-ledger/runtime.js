import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { resolveNoraWorldCore } from '../nora-world-core/runtime.js';
import { createStoryLedger, LedgerConflict } from './core.js';
import { ledgerAfterRestore, ledgerStatePath } from './state-file.js';
import { requestStoryProjection } from './profile-projection.js';
import { prefixText, scopeKey, scopeOf } from '../../public/scripts/nora-story-ledger/history.js';
import { storyEntityBindings } from '../../public/scripts/nora-worlds/story-context.js';
import { chatBackupStore, protectChatBeforeRewrite } from '../chat-backup-runtime.js';
import { chatSessionOperations } from '../chat-session-operations.js';
import { reportLedger } from './diagnostics.js';

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
    const activity = chatSessionOperations(directories);
    const statePath = scope => ledgerStatePath(key, scope);
    const readState = (scope, chat) => {
        const state = fs.existsSync(statePath(scope)) ? JSON.parse(fs.readFileSync(statePath(scope), 'utf8')) : null;
        const binding = bindings.get(scopeKey(scope));
        return ledgerAfterRestore(state, chat?.metadata ?? (binding ? jsonl(binding.filePath)[0]?.chat_metadata : null));
    };
    const plugin = createStoryLedger({
        canRun: () => !activity.hasGeneration(),
        readChat: scope => {
            const binding = bindings.get(scopeKey(scope));
            if (!binding) throw new Error('Story ledger scope has not been resolved.');
            const data = jsonl(binding.filePath);
            if (scopeKey(scopeOf(data[0]?.chat_metadata)) !== scopeKey(scope)) {
                throw new LedgerConflict('Story Session identity is missing or changed.', 'NORA_LEDGER_STORAGE_CONFLICT');
            }
            return { messages: data.slice(1), metadata: data[0]?.chat_metadata, entities: Object.keys(binding.entityBindings), entityBindings: binding.entityBindings,
                playerName: binding.playerName, language: binding.language };
        },
        readState,
        writeState: (scope, state) => {
            // A completed/cancelled World deletion must not be resurrected by
            // a background compression finishing or failing afterwards.
            const binding = bindings.get(scopeKey(scope));
            if (binding && !fs.existsSync(binding.filePath)) return;
            const previous = fs.existsSync(statePath(scope)) ? JSON.parse(fs.readFileSync(statePath(scope), 'utf8')) : null;
            fs.mkdirSync(root, { recursive: true });
            writeFileAtomicSync(statePath(scope), JSON.stringify(state), 'utf8');
            if ((state.active?.id && previous?.active?.id !== state.active.id)
                || (previous?.imported?.id && !state.imported)) void requestStoryProjection(directories);
        },
        merge: input => import('./model.js').then(module => module.mergeWithActiveModel(directories, { ...input,
            report: (_label, details) => reportLedger(directories, 'model-attempt', { ...input.scope, taskId: input.taskId, ...details }) })),
        report: (event, details) => reportLedger(directories, event, details),
    });
    activity.subscribe(() => {
        if (activity.hasGeneration()) plugin.cancelAll();
        else for (const bindingKey of bindings.keys()) {
            const scope = bindings.get(bindingKey).scope;
            void Promise.resolve().then(() => plugin.schedule(scope)).catch(() => {});
        }
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
        const playerName = String(world.persona?.name || '');
        const binding = { scope, filePath, language: world.story_context?.language || 'zh', playerName,
            entityBindings: storyEntityBindings(world.story_context, playerName) };
        bindings.set(scopeKey(scope), binding);
        return binding;
    }
    async function writeChat(filePath, data, writer, { beforeWrite = null, activityToken = null } = {}) {
        const existing = jsonl(filePath);
        const scope = scopeOf(existing[0]?.chat_metadata) || scopeOf(data[0]?.chat_metadata);
        if (!scope) {
            beforeWrite?.();
            return writer(); // non-Nora ST chats remain native
        }
        await resolve(scope, filePath);
        if (scopeKey(scopeOf(data[0]?.chat_metadata)) !== scopeKey(scope)) throw new LedgerConflict('Cannot replace Story Session identity.');
        const result = await chatSessionOperations(directories).write(scope, activityToken, () => plugin.writeChat(scope, data.slice(1), () => {
            // The revision precondition and the JSONL replacement share the
            // ledger's per-session lock, making the save an atomic CAS.
            beforeWrite?.();
            return writer();
        }));
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
        let result, protectedData;
        await chatSessionOperations(directories).write(scope, request.activityToken, () => plugin.edit(scope, request, messages => {
            if (fs.readFileSync(filePath, 'utf8') !== protectedData) throw new LedgerConflict('Chat changed after backup.', 'NORA_LEDGER_EDIT_STALE');
            const header = jsonl(filePath)[0];
            header.chat_metadata.tainted = true;
            result = [header, ...messages];
            writeFileAtomicSync(filePath, result.map(item => JSON.stringify(item)).join('\n'), 'utf8');
        }, { beforeWrite: async () => {
            protectedData = fs.readFileSync(filePath, 'utf8');
            await protectChatBeforeRewrite({ directories, filePath, data: protectedData });
        } }));
        void plugin.schedule(scope);
        return result;
    }
    async function checkpoint(scope, { expectedSignature, activityToken }) {
        const { filePath } = await resolve(scope);
        return chatSessionOperations(directories).write(scope, activityToken, () => plugin.checkpoint(scope, expectedSignature, async () => {
            const data = fs.readFileSync(filePath, 'utf8');
            const result = await protectChatBeforeRewrite({ directories, filePath, data });
            if (fs.readFileSync(filePath, 'utf8') !== data) throw new LedgerConflict('Chat changed after backup.', 'NORA_LEDGER_EDIT_STALE');
            return result;
        }));
    }
    async function restore(scope, input) {
        await resolve(scope);
        const result = await chatSessionOperations(directories).restore(scope, () => plugin.withIdleSession(scope, async () => {
            const enabled = readState(scope)?.enabled !== false;
            return chatBackupStore(directories).restore({ ...input, ...scope }, { ledgerEnabled: enabled });
        }));
        // Canonical history/ledger invalidation already committed together.
        // Projection failure is retried, not misreported as an uncommitted chat.
        return { ...result, projectionPending: !await requestStoryProjection(directories) };
    }
    async function reset(scope, { expectedRevision, expectedSignature }) {
        const { filePath } = await resolve(scope);
        const result = await activity.restore(scope, () => plugin.reset(scope, { expectedRevision, prepare: async () => {
            const original = fs.readFileSync(filePath, 'utf8');
            const data = jsonl(filePath);
            const historySignature = crypto.createHash('sha256').update(prefixText(data.slice(1), data.length - 1)).digest('hex');
            if (expectedSignature !== historySignature) throw new LedgerConflict('Chat changed before resetting memory.', 'NORA_LEDGER_EDIT_STALE');
            await protectChatBeforeRewrite({ directories, filePath, data: original });
            if (fs.readFileSync(filePath, 'utf8') !== original) throw new LedgerConflict('Chat changed after backup.', 'NORA_LEDGER_EDIT_STALE');
            const receipt = { id: crypto.randomUUID(), ledgerEnabled: false, historySignature };
            data[0].chat_metadata.nora_restore = receipt;
            // Canonical receipt invalidates old memory even if the process exits
            // before the derived ledger file can be rewritten.
            writeFileAtomicSync(filePath, data.map(item => JSON.stringify(item)).join('\n'), 'utf8');
            return receipt;
        } }));
        return { ...result, projectionPending: !await requestStoryProjection(directories) };
    }
    let projectionRecovered = false;
    function recover() {
        if (projectionRecovered) return;
        projectionRecovered = true;
        if (fs.existsSync(root)) void requestStoryProjection(directories);
    }
    const runtime = Object.freeze({ plugin, resolve, writeChat, edit, checkpoint, restore, reset, guardDestructive, recoverProjection: recover });
    runtimes.set(key, runtime);
    // Once per process/user on first ledger use: recover an activation that
    // committed before a restart, or a previously interrupted memory write.
    if (recoverProjection) recover();
    return runtime;
}
