import { executeStActivationSnapshot } from './world-core-client.js';
import { translate } from '../nora-i18n/core.js';
import { createWorldCapabilityController } from './world-capability-controller.js';

function normalizeChatId(value) {
    return String(value || '').replace(/\.jsonl$/i, '');
}

function defaultSession(manifest) {
    return manifest.sessions?.items?.find(item => item.session_id === manifest.sessions.default_session_id) || null;
}

function mutationKey(kind, worldId) {
    const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `browser:${kind}:${worldId}:${nonce}`;
}

export function createWorldCoreRuntime(runtime, {
    client,
    capabilityRuntime = null,
    refreshCharacters = async () => {},
    executeSnapshot = executeStActivationSnapshot,
    measure = (name, operation) => globalThis.__NORA_TIMED_STEP__
        ? globalThis.__NORA_TIMED_STEP__(name, operation)
        : operation(),
} = {}) {
    if (!client || typeof client.list !== 'function' || typeof client.prepareSnapshot !== 'function') {
        throw new Error('Nora World Core v2 client is required.');
    }
    const capabilityController = capabilityRuntime
        ? createWorldCapabilityController({ client, runtime: capabilityRuntime })
        : null;
    let manifests = [];
    let recoveryTask = null;
    let operationState = Object.freeze({ status: 'IDLE', kind: null, operationId: null, error: null });
    const subscribers = new Set();

    function emit() {
        const snapshot = status();
        for (const subscriber of subscribers) {
            try { subscriber(snapshot); } catch (error) { console.error('[Nora World Core] UI subscriber failed:', error); }
        }
    }

    function setOperation(next) {
        operationState = Object.freeze({ ...operationState, ...next });
        emit();
    }

    function status() {
        return Object.freeze({ operation: operationState, worlds: manifests.length });
    }

    function worldIdOf(worldOrId) {
        return String(typeof worldOrId === 'string' ? worldOrId : worldOrId?.id || worldOrId?.world_id || '').trim();
    }

    function manifestById(worldOrId) {
        const worldId = worldIdOf(worldOrId);
        const manifest = manifests.find(item => item.world_id === worldId);
        if (!manifest) throw new Error(`World is absent from the authoritative list: ${worldId || '<unknown>'}`);
        return manifest;
    }

    function model(manifest) {
        const state = runtime.read();
        const avatar = String(manifest.runtime_card?.binding?.avatar || '');
        const session = defaultSession(manifest);
        const characterId = state.characters.findIndex(character => character.avatar === avatar);
        const lifecycleReady = manifest.lifecycle?.status === 'READY';
        const lifecycleDeleting = manifest.lifecycle?.status === 'DELETING';
        const migrationRepair = manifest.lifecycle?.error?.code === 'NORA_WORLD_NEEDS_REPAIR';
        const active = String(state.metadata?.nora_world?.id || '') === manifest.world_id
            && String(state.metadata?.nora_session?.id || '') === String(session?.session_id || '');
        const capabilityStatus = manifest.capabilities?.status;
        const openingState = session?.opening_state === 'empty' ? 'empty' : 'message';
        return Object.freeze({
            id: manifest.world_id,
            revision: manifest.revision,
            name: manifest.name,
            persona: { ...manifest.persona },
            storyContext: manifest.story_context,
            ui: manifest.ui,
            persistent: true,
            available: lifecycleReady && characterId >= 0,
            needsRepair: !lifecycleReady || characterId < 0,
            repairReason: migrationRepair
                ? 'migration_conflict'
                : (!lifecycleReady ? 'lifecycle_failed' : (characterId < 0 ? 'runtime_card_missing' : null)),
            active,
            openingState,
            capabilities: manifest.capabilities,
            meta: translate(lifecycleDeleting
                ? '世界 · 删除中'
                : migrationRepair
                    ? '世界 · 迁移冲突待修复'
                    : !lifecycleReady
                        ? '世界 · 需要修复'
                        : characterId < 0
                            ? '世界 · 需要修复'
                            : capabilityStatus === 'DEGRADED'
                                ? '世界 · 附加能力降级'
                                : (capabilityStatus === 'PENDING' ? '世界 · 增强能力加载中' : '世界 · 已就绪')),
        });
    }

    function list() {
        return manifests.map(model);
    }

    function recoverPendingCreation() {
        const pending = client.pendingCreation?.();
        if (!pending?.idempotencyKey || recoveryTask || operationState.status === 'FAILED') return recoveryTask;
        setOperation({ status: 'RUNNING', kind: 'CREATE_RECOVERY', operationId: pending.operationId || null, error: null });
        recoveryTask = (async () => {
            try {
                const resumed = await client.resumePendingCreation();
                if (resumed?.world) await refreshCharacters();
                manifests = await client.list();
                setOperation({ status: 'COMPLETED', operationId: resumed?.operation?.operation_id || pending.operationId || null, error: null });
                emit();
                return resumed;
            } catch (error) {
                setOperation({
                    status: 'FAILED',
                    operationId: pending.operationId || null,
                    error: Object.freeze({ code: error?.code || 'NORA_CREATE_RECOVERY_FAILED', message: String(error?.message || error), retryable: error?.retryable !== false }),
                });
                return null;
            } finally {
                recoveryTask = null;
            }
        })();
        return recoveryTask;
    }

    async function refresh() {
        manifests = await client.list();
        emit();
        void recoverPendingCreation();
        return list();
    }

    async function activate(worldOrId) {
        const manifest = manifestById(worldOrId);
        const snapshot = await client.prepareSnapshot(manifest.world_id);
        await executeSnapshot(snapshot, runtime, { measure });
        return model(manifest);
    }

    async function ensureReady(worldOrId) {
        const manifest = manifestById(worldOrId);
        const avatar = String(manifest.runtime_card?.binding?.avatar || '');
        const session = defaultSession(manifest);
        const chatId = normalizeChatId(session?.binding?.chat_id);
        const state = runtime.read();
        if (state.activeCharacter?.avatar === avatar
            && normalizeChatId(state.chatId) === chatId
            && String(state.metadata?.nora_world?.id || '') === manifest.world_id
            && String(state.metadata?.nora_session?.id || '') === String(session?.session_id || '')) {
            return model(manifest);
        }
        const snapshot = await client.prepareSnapshot(manifest.world_id);
        await executeSnapshot(snapshot, runtime, { measure });
        return model(manifest);
    }

    async function runCreation(kind, create) {
        setOperation({ status: 'RUNNING', kind, operationId: null, error: null });
        try {
            const result = await create();
            setOperation({ status: 'RUNNING', operationId: result.operation?.operation_id || null });
            await refreshCharacters();
            manifests = await client.list();
            const created = list().find(world => world.id === result.world?.world_id);
            if (!created) throw new Error('The created World was committed but is absent from the authoritative list.');
            setOperation({ status: 'COMPLETED', operationId: result.operation?.operation_id || null, error: null });
            emit();
            return created;
        } catch (error) {
            const pending = client.pendingCreation?.();
            setOperation({
                status: 'FAILED',
                operationId: pending?.operationId || null,
                error: Object.freeze({ code: error?.code || 'NORA_WORLD_CREATE_FAILED', message: String(error?.message || error), retryable: error?.retryable !== false }),
            });
            throw error;
        }
    }

    function importCard(file, options) {
        return runCreation('IMPORT', () => client.importCard(file, options));
    }

    function createFromLibrary(options) {
        return runCreation('IMPORT', () => client.createFromLibrary(options));
    }

    function createBlank(options) {
        return runCreation('BLANK', () => client.createBlank(options));
    }

    function acceptCapabilityWorld(world) {
        if (!world?.world_id) return;
        manifests = manifests.map(item => item.world_id === world.world_id ? world : item);
    }

    function capabilityInput(worldOrId) {
        const manifest = manifestById(worldOrId);
        const avatar = String(manifest.runtime_card?.binding?.avatar || '');
        const characterId = runtime.read().characters.findIndex(character => character.avatar === avatar);
        if (characterId < 0) throw new Error('World Runtime Card is unavailable. Use World repair after the Runtime Card is restored.');
        return { id: manifest.world_id, characterId, manifest };
    }

    async function ensureCapabilities(worldOrId, options = {}) {
        const input = capabilityInput(worldOrId);
        if (!capabilityController) return Object.freeze({ world: input.manifest, results: [] });
        const result = await capabilityController.ensure(input, options);
        acceptCapabilityWorld(result.world);
        emit();
        return result;
    }

    async function retryCapability(worldOrId, capability, options = {}) {
        if (!capabilityController) throw new Error('World capability controller is unavailable.');
        const result = await capabilityController.retry(capabilityInput(worldOrId), capability, options);
        acceptCapabilityWorld(result.world);
        emit();
        return result;
    }

    async function repair(worldOrId, { idempotencyKey = null } = {}) {
        const worldId = worldIdOf(worldOrId);
        setOperation({ status: 'RUNNING', kind: 'REPAIR', operationId: null, error: null });
        try {
            const result = await client.repairWorld(worldId, {
                idempotencyKey: idempotencyKey || mutationKey('repair', worldId),
            });
            await refreshCharacters();
            manifests = await client.list();
            setOperation({ status: 'COMPLETED', operationId: result.operation?.operation_id || null, error: null });
            emit();
            return model(manifestById(worldId));
        } catch (error) {
            await refreshCharacters().catch(() => {});
            manifests = await client.list().catch(() => manifests);
            setOperation({
                status: 'FAILED',
                kind: 'REPAIR',
                operationId: error?.operationId || null,
                error: Object.freeze({ code: error?.code || 'NORA_WORLD_REPAIR_FAILED', message: String(error?.message || error), retryable: error?.retryable !== false }),
            });
            emit();
            throw error;
        }
    }

    async function remove(worldOrId, { idempotencyKey = null } = {}) {
        const worldId = worldIdOf(worldOrId);
        manifestById(worldId);
        setOperation({ status: 'RUNNING', kind: 'DELETE', operationId: null, error: null });
        try {
            const result = await client.deleteWorld(worldId, {
                idempotencyKey: idempotencyKey || mutationKey('delete', worldId),
            });
            manifests = await client.list();
            setOperation({ status: 'COMPLETED', operationId: result.operation?.operation_id || null, error: null });
            emit();
            return result;
        } catch (error) {
            manifests = await client.list().catch(() => manifests);
            setOperation({
                status: 'FAILED',
                kind: 'DELETE',
                operationId: error?.operationId || null,
                error: Object.freeze({ code: error?.code || 'NORA_WORLD_DELETE_FAILED', message: String(error?.message || error), retryable: error?.retryable !== false }),
            });
            emit();
            throw error;
        }
    }

    async function retryPendingCreation() {
        if (typeof client.retryPendingCreation !== 'function') throw new Error('Pending World creation retry is unavailable.');
        setOperation({ status: 'RUNNING', kind: 'CREATE_RECOVERY', error: null });
        try {
            const result = await client.retryPendingCreation();
            await refreshCharacters();
            manifests = await client.list();
            setOperation({ status: 'COMPLETED', operationId: result.operation?.operation_id || operationState.operationId, error: null });
            emit();
            return result;
        } catch (error) {
            setOperation({ status: 'FAILED', error: Object.freeze({ code: error?.code || 'NORA_CREATE_RETRY_FAILED', message: String(error?.message || error), retryable: error?.retryable !== false }) });
            throw error;
        }
    }

    function notAvailable(action) {
        throw new Error(`${action} is not part of the Phase 3 World Core v2 vertical slice.`);
    }

    function usesRuntimeCard(character) {
        const avatar = String(character?.avatar || '');
        return Boolean(avatar && manifests.some(item => item.runtime_card?.binding?.avatar === avatar));
    }

    async function updateActive(patch, { expectedRevision } = {}) {
        const worldId = runtime.read().metadata?.nora_world?.id;
        const current = manifestById(worldId);
        const world = await client.updateWorld(worldId, patch, expectedRevision ?? current.revision);
        manifests = manifests.map(item => item.world_id === worldId ? world : item);
        // The manifest is authoritative. A failed live projection must not roll it back.
        // Never apply a persona to a different World if a switch raced the request.
        let runtimeApplied = false;
        if (runtime.read().metadata?.nora_world?.id === worldId) {
            try {
                if (patch.persona) await runtime.savePersona(world.persona);
                if (world.story_context) runtime.applyStoryContext(world.story_context);
                runtimeApplied = true;
            } catch (error) {
                emit();
                throw Object.assign(new Error('World was saved, but its live persona could not be applied. Reopen the World.'),
                    { code: 'NORA_WORLD_PROJECTION_FAILED', saved: true, cause: error });
            }
        }
        emit();
        return { world: model(world), saved: true, runtimeApplied };
    }

    return Object.freeze({
        list,
        status,
        subscribe(subscriber) {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
        },
        refresh,
        activate,
        ensureReady,
        ensureCapabilities,
        retryCapability,
        repair,
        retryPendingCreation,
        usesRuntimeCard,
        importCard,
        createBlank,
        createFromLibrary,
        create: () => notAvailable('World creation from an existing Runtime Card'),
        updateActive,
        remove,
        references: async () => ({ character_card: [], worldbooks: {} }),
    });
}
