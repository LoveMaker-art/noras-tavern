import crypto from 'node:crypto';
import { editStoryCharacter, normalizeStoryContext } from '../../public/scripts/nora-worlds/story-context.js';

import { createActivationPlan } from './activation-plan.js';
import {
    beginWorldCapabilityAttempt,
    commandDigest,
    createWorldManifest,
    normalizeCreateCommand,
    normalizeIdempotencyKey,
    normalizeMaterialization,
    operationIdForKey,
    OPERATION_STAGES,
    settleWorldCapabilityAttempt,
} from './domain.js';
import { asWorldCoreError, NoraWorldCoreError } from './errors.js';
import { KeyedLock } from './locks.js';
import { MutationJournal } from './mutation-journal.js';
import { OperationJournal } from './operation-journal.js';
import { WorldStore } from './store.js';
import { normalizeWorldTheme } from '../../public/scripts/nora-worlds/world-theme.js';

function stageAtLeast(operation, stage) {
    return OPERATION_STAGES.indexOf(operation.stage) >= OPERATION_STAGES.indexOf(stage);
}

export class NoraWorldCore {
    #store;
    #journal;
    #mutations;
    #locks;
    #materializer;
    #createId;
    #now;
    #initialized = null;
    #tasks = new Map();

    constructor({ store, journal, mutations, locks, materializer, createId, now }) {
        this.#store = store;
        this.#journal = journal;
        this.#mutations = mutations;
        this.#locks = locks;
        this.#materializer = materializer;
        this.#createId = createId;
        this.#now = now;
    }

    async #initialize() {
        if (!this.#initialized) this.#initialized = Promise.all([
            this.#store.load(),
            this.#journal.load(),
            this.#mutations.load(),
        ]);
        await this.#initialized;
    }

    async #begin(command, { idempotencyKey } = {}) {
        await this.#initialize();
        const normalizedCommand = normalizeCreateCommand(command);
        const key = normalizeIdempotencyKey(idempotencyKey);
        const digest = commandDigest(normalizedCommand);
        const operationId = operationIdForKey(key);
        return this.#locks.run(`operation:${operationId}`, async () => {
            const before = await this.#journal.findByIdempotencyKey(key);
            if (!before) {
                const committedWorld = await this.#store.findByOperation(operationId);
                if (committedWorld) {
                    const operation = await this.#journal.recoverCommitted({
                        idempotencyKey: key,
                        commandDigest: digest,
                        command: normalizedCommand,
                        world: committedWorld,
                    });
                    return { world: committedWorld, operation, reused: true };
                }
            }
            const operation = await this.#journal.begin({
                idempotencyKey: key,
                commandDigest: digest,
                command: normalizedCommand,
                worldId: this.#createId('world'),
                sessionId: this.#createId('session'),
                runtimeCardResourceId: this.#createId('resource'),
            });
            if (operation.status === 'COMPLETED') {
                const committedWorld = await this.#store.get(operation.world_id);
                if (!committedWorld) {
                    throw new NoraWorldCoreError(
                        'NORA_WORLD_STORAGE_CORRUPT',
                        'The completed operation references a missing World.',
                        { details: { operationId: operation.operation_id, worldId: operation.world_id } },
                    );
                }
                return { world: committedWorld, operation, reused: true };
            }
            return { world: null, operation, reused: Boolean(before) };
        });
    }

    #schedule(operation, { reused = true } = {}) {
        if (operation.status !== 'RUNNING') return null;
        const operationId = operation.operation_id;
        const existing = this.#tasks.get(operationId);
        if (existing) return existing;
        const task = Promise.resolve().then(() => this.#locks.run(`operation:${operationId}`, async () => {
            const current = await this.#journal.get(operationId);
            if (!current) throw new NoraWorldCoreError('NORA_OPERATION_NOT_FOUND', 'World operation was not found.');
            if (current.status === 'FAILED') throw new NoraWorldCoreError(
                current.error?.code || 'NORA_WORLD_CREATE_FAILED',
                current.error?.message || 'World creation failed.',
                { retryable: Boolean(current.error?.retryable), details: { operationId, worldId: current.world_id } },
            );
            return this.#run(current, { reused });
        })).finally(() => {
            if (this.#tasks.get(operationId) === task) this.#tasks.delete(operationId);
        });
        this.#tasks.set(operationId, task);
        void task.catch(() => {});
        return task;
    }

    async submitWorld(command, options = {}) {
        const receipt = await this.#begin(command, options);
        if (!receipt.world && receipt.operation.status === 'RUNNING') this.#schedule(receipt.operation, { reused: receipt.reused });
        return receipt;
    }

    async createWorld(command, options = {}) {
        let receipt = await this.submitWorld(command, options);
        if (receipt.world) return receipt;
        if (receipt.operation.status === 'FAILED') return this.retryOperation(receipt.operation.operation_id);
        const task = this.#tasks.get(receipt.operation.operation_id) || this.#schedule(receipt.operation, { reused: receipt.reused });
        if (task) return task;
        const operation = await this.#journal.get(receipt.operation.operation_id);
        const world = operation ? await this.#store.get(operation.world_id) : null;
        if (operation?.status === 'COMPLETED' && world) return { world, operation, reused: true };
        throw new NoraWorldCoreError('NORA_OPERATION_STAGE', 'World operation did not start.');
    }

    async retryOperation(operationId) {
        await this.#initialize();
        const createOperation = await this.#journal.get(operationId);
        if (!createOperation) {
            let mutation = await this.#mutations.get(operationId);
            if (!mutation) throw new NoraWorldCoreError('NORA_OPERATION_NOT_FOUND', 'World operation was not found.');
            if (mutation.status === 'FAILED') mutation = await this.#mutations.resume(mutation.operation_id);
            if (mutation.status === 'COMPLETED') {
                return { world: await this.#store.get(mutation.world_id), operation: mutation, reused: true };
            }
            return this.#scheduleMutation(mutation, { reused: true });
        }
        const operation = await this.#locks.run(`operation:${operationId}`, async () => {
            let operation = createOperation;
            if (operation.status === 'FAILED') operation = await this.#journal.resume(operation.operation_id);
            return operation;
        });
        if (operation.status === 'COMPLETED') {
            const world = await this.#store.get(operation.world_id);
            if (!world) throw new NoraWorldCoreError('NORA_WORLD_STORAGE_CORRUPT', 'The completed operation references a missing World.');
            return { world, operation, reused: true };
        }
        return this.#schedule(operation, { reused: true });
    }

    async #run(initialOperation, { reused }) {
        let operation = initialOperation;
        try {
            const committedWorld = await this.#store.get(operation.world_id);
            if (committedWorld) {
                await this.#materializer.release?.(operation.command).catch(() => {});
                if (!stageAtLeast(operation, 'WORLD_COMMITTED')) {
                    operation = await this.#journal.advance(operation.operation_id, 'WORLD_COMMITTED');
                }
                if (operation.stage !== 'COMPLETED') {
                    operation = await this.#journal.advance(operation.operation_id, 'COMPLETED');
                }
                return { world: committedWorld, operation, reused: true };
            }
            if (operation.status === 'COMPLETED') {
                throw new NoraWorldCoreError(
                    'NORA_WORLD_STORAGE_CORRUPT',
                    'The completed operation references a missing World.',
                    { details: { operationId: operation.operation_id, worldId: operation.world_id } },
                );
            }
            if (operation.stage === 'RECEIVED') {
                normalizeCreateCommand(operation.command);
                operation = await this.#journal.advance(operation.operation_id, 'VALIDATED');
            }
            if (operation.stage === 'VALIDATED') {
                let materialization;
                try {
                    materialization = normalizeMaterialization(await this.#materializer.materialize(operation.command, {
                        operationId: operation.operation_id,
                        worldId: operation.world_id,
                        sessionId: operation.session_id,
                        runtimeCardResourceId: operation.runtime_card_resource_id,
                    }));
                } catch (error) {
                    throw asWorldCoreError(
                        error,
                        'NORA_WORLD_MATERIALIZATION_FAILED',
                        'World resources could not be materialized.',
                        { retryable: true },
                    );
                }
                operation = await this.#journal.advance(operation.operation_id, 'MATERIALIZED', { materialization });
            }
            if (operation.stage === 'MATERIALIZED') {
                await this.#materializer.release?.(operation.command).catch(() => {});
                const manifest = createWorldManifest({
                    operation,
                    command: operation.command,
                    materialization: operation.materialization,
                    now: this.#now,
                });
                const world = await this.#store.put(manifest, { expectedRevision: 0 });
                operation = await this.#journal.advance(operation.operation_id, 'WORLD_COMMITTED');
                operation = await this.#journal.advance(operation.operation_id, 'COMPLETED');
                return { world, operation, reused };
            }
            throw new NoraWorldCoreError('NORA_OPERATION_STAGE', `Operation stopped at unsupported stage ${operation.stage}.`);
        } catch (error) {
            const coreError = asWorldCoreError(error, 'NORA_WORLD_CREATE_FAILED', 'World creation failed.', { retryable: true });
            await this.#journal.fail(operation.operation_id, coreError).catch(() => {});
            if (!coreError.retryable) await this.#materializer.release?.(operation.command).catch(() => {});
            coreError.details = {
                ...coreError.details,
                operationId: operation.operation_id,
                worldId: operation.world_id,
            };
            throw coreError;
        }
    }

    async getOperation(operationId) {
        await this.#initialize();
        const operation = await this.#journal.get(operationId);
        if (operation) {
            if (operation.status === 'RUNNING') this.#schedule(operation, { reused: true });
            return operation;
        }
        const mutation = await this.#mutations.get(operationId);
        if (mutation?.status === 'RUNNING') this.#scheduleMutation(mutation, { reused: true });
        return mutation;
    }

    async getWorld(worldId) {
        await this.#initialize();
        return this.#store.get(worldId);
    }

    async listWorlds() {
        await this.#initialize();
        return this.#store.list();
    }

    async updateWorld(worldId, patch, { expectedRevision } = {}) {
        await this.#initialize();
        const invalid = message => { throw new NoraWorldCoreError('NORA_WORLD_INVALID', message); };
        if (!patch || Array.isArray(patch) || typeof patch !== 'object'
            || !Object.keys(patch).length || Object.keys(patch).some(key => !['name', 'persona', 'character', 'relationships'].includes(key))) invalid('Unsupported World edit.');
        if ('name' in patch && (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 500)) invalid('Invalid World name.');
        if ('persona' in patch) {
            if (!patch.persona || Array.isArray(patch.persona) || typeof patch.persona !== 'object'
                || !Object.keys(patch.persona).length
                || Object.entries(patch.persona).some(([key, value]) => !['name', 'description'].includes(key) || typeof value !== 'string' || value.length > 100000)) invalid('Invalid World persona.');
        }
        const world = await this.#store.update(worldId, current => {
            if (current.lifecycle.status !== 'READY') throw new NoraWorldCoreError('NORA_WORLD_NOT_READY', 'World is not ready for editing.');
            if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) throw new NoraWorldCoreError('NORA_WORLD_REVISION_CONFLICT', 'World changed; read it again before editing.');
            let context = current.story_context;
            try {
                if ('character' in patch) context = editStoryCharacter(context, patch.character);
                if ('relationships' in patch) context = normalizeStoryContext({ ...context, relationships: patch.relationships });
                if (context && patch.persona) {
                    context = normalizeStoryContext(context);
                    context.player.profile.identity = { ...context.player.profile.identity, ...patch.persona };
                }
            } catch (error) { invalid(error.message); }
            return { ...current, ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
                ...(context ? { story_context: context } : {}),
                persona: { ...current.persona, ...patch.persona }, updated_at: this.#now() };
        });
        if (!world) throw new NoraWorldCoreError('NORA_WORLD_NOT_FOUND', 'World was not found.');
        return world;
    }

    async setWorldTheme(worldId, value, { expectedRevision } = {}) {
        await this.#initialize();
        let ui;
        try { ui = normalizeWorldTheme(value); } catch (error) { throw new NoraWorldCoreError('NORA_WORLD_INVALID', error.message); }
        const world = await this.#store.update(worldId, current => {
            if (current.lifecycle.status !== 'READY') throw new NoraWorldCoreError('NORA_WORLD_NOT_READY', 'World is not ready for editing.');
            if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) throw new NoraWorldCoreError('NORA_WORLD_REVISION_CONFLICT', 'World changed; inspect again before applying a theme.');
            return { ...current, ui, updated_at: this.#now() };
        });
        if (!world) throw new NoraWorldCoreError('NORA_WORLD_NOT_FOUND', 'World was not found.');
        return world;
    }

    async prepareOpen(worldId) {
        await this.#initialize();
        const world = await this.#store.get(worldId);
        if (!world) throw new NoraWorldCoreError('NORA_WORLD_NOT_FOUND', 'World was not found.', { details: { worldId } });
        return createActivationPlan(world);
    }

    async beginCapabilityAttempt(worldId, capability) {
        await this.#initialize();
        const normalizedCapability = String(capability || '').trim();
        const attemptId = this.#createId('capability-attempt');
        const world = await this.#store.update(worldId, current => beginWorldCapabilityAttempt(
            current,
            normalizedCapability,
            { attemptId, now: this.#now },
        ));
        if (!world) throw new NoraWorldCoreError('NORA_WORLD_NOT_FOUND', 'World was not found.', { details: { worldId } });
        return {
            world,
            attempt: {
                attempt_id: attemptId,
                capability: normalizedCapability,
                attempt: world.capabilities.items[normalizedCapability].attempts,
                started_at: world.capabilities.items[normalizedCapability].started_at,
            },
        };
    }

    async settleCapabilityAttempt(worldId, capability, attemptId, result) {
        await this.#initialize();
        const world = await this.#store.update(worldId, current => settleWorldCapabilityAttempt(
            current,
            capability,
            result,
            { attemptId, now: this.#now },
        ));
        if (!world) throw new NoraWorldCoreError('NORA_WORLD_NOT_FOUND', 'World was not found.', { details: { worldId } });
        return world;
    }

    async inspectWorld(worldId) {
        await this.#initialize();
        const result = await this.#store.inspect(worldId);
        if (!result) throw new NoraWorldCoreError('NORA_WORLD_NOT_FOUND', 'World was not found.', { details: { worldId } });
        return result;
    }

    #scheduleMutation(operation, { reused = true } = {}) {
        if (operation.status !== 'RUNNING') return null;
        const operationId = operation.operation_id;
        const existing = this.#tasks.get(operationId);
        if (existing) return existing;
        const task = Promise.resolve().then(() => this.#locks.run(`operation:${operationId}`, async () => {
            const current = await this.#mutations.get(operationId);
            if (!current) throw new NoraWorldCoreError('NORA_OPERATION_NOT_FOUND', 'World operation was not found.');
            if (current.status === 'FAILED') {
                throw new NoraWorldCoreError(
                    current.error?.code || 'NORA_WORLD_MUTATION_FAILED',
                    current.error?.message || 'World mutation failed.',
                    { retryable: Boolean(current.error?.retryable), details: { operationId, worldId: current.world_id } },
                );
            }
            return this.#runMutation(current, { reused });
        })).finally(() => {
            if (this.#tasks.get(operationId) === task) this.#tasks.delete(operationId);
        });
        this.#tasks.set(operationId, task);
        void task.catch(() => {});
        return task;
    }

    async #mutateWorld(type, worldId, { idempotencyKey } = {}) {
        await this.#initialize();
        const existingWorld = await this.#store.get(worldId);
        if (!existingWorld) throw new NoraWorldCoreError('NORA_WORLD_NOT_FOUND', 'World was not found.', { details: { worldId } });
        const receipt = await this.#mutations.begin({ type, worldId, idempotencyKey });
        let operation = receipt.operation;
        if (operation.status === 'FAILED') operation = await this.#mutations.resume(operation.operation_id);
        if (operation.status === 'COMPLETED') {
            return { world: await this.#store.get(worldId), operation, reused: true };
        }
        return this.#scheduleMutation(operation, { reused: receipt.reused });
    }

    async deleteWorld(worldId, options = {}) {
        return this.#mutateWorld('DELETE_WORLD', worldId, options);
    }

    async repairWorld(worldId, options = {}) {
        return this.#mutateWorld('REPAIR_WORLD', worldId, options);
    }

    async #runMutation(operation, { reused }) {
        // Operation IDs deduplicate retries, but different commands can still
        // target one World. Their inspect/delete/commit lifecycle must not overlap.
        return this.#locks.run(`mutation-world:${operation.world_id}`, () => {
            if (operation.type === 'DELETE_WORLD') return this.#runDelete(operation, { reused });
            if (operation.type === 'REPAIR_WORLD') return this.#runRepair(operation, { reused });
            throw new NoraWorldCoreError('NORA_OPERATION_TYPE', 'Unsupported World mutation operation.');
        });
    }

    async #runDelete(initialOperation, { reused }) {
        let operation = initialOperation;
        try {
            let world = await this.#store.get(operation.world_id);
            if (!world) throw new NoraWorldCoreError('NORA_WORLD_NOT_FOUND', 'World was not found.');
            if (operation.stage === 'RECEIVED') {
                if (world.lifecycle.status !== 'DELETED') {
                    world = await this.#store.update(world.world_id, current => ({
                        ...current,
                        lifecycle: { status: 'DELETING', error: null },
                        updated_at: this.#now(),
                    }));
                }
                operation = await this.#mutations.advance(operation.operation_id, 'WORLD_MARKED_DELETING');
            }
            if (operation.stage === 'WORLD_MARKED_DELETING') {
                world = await this.#store.get(operation.world_id);
                if (world.lifecycle.status !== 'DELETED') {
                    if (typeof this.#materializer.deleteResources !== 'function') {
                        throw new NoraWorldCoreError('NORA_WORLD_DELETE_UNSUPPORTED', 'The compatibility adapter cannot delete World resources.');
                    }
                    const plan = await this.#store.deletionPlan(world.world_id);
                    await this.#materializer.deleteResources(world, plan);
                }
                operation = await this.#mutations.advance(operation.operation_id, 'RESOURCES_RELEASED');
            }
            if (operation.stage === 'RESOURCES_RELEASED') {
                world = await this.#store.update(operation.world_id, current => ({
                    ...current,
                    lifecycle: { status: 'DELETED', error: null },
                    updated_at: this.#now(),
                }));
                operation = await this.#mutations.advance(operation.operation_id, 'COMPLETED', {
                    result: { deleted: true },
                });
            }
            return { world, operation, reused };
        } catch (error) {
            const coreError = asWorldCoreError(error, 'NORA_WORLD_DELETE_FAILED', 'World deletion failed.', { retryable: true });
            await this.#store.update(operation.world_id, current => current.lifecycle.status === 'DELETED' ? current : ({
                ...current,
                lifecycle: {
                    status: 'FAILED',
                    error: { code: coreError.code, message: coreError.message, retryable: coreError.retryable },
                },
                updated_at: this.#now(),
            })).catch(() => {});
            await this.#mutations.fail(operation.operation_id, coreError).catch(() => {});
            coreError.details = { ...coreError.details, operationId: operation.operation_id, worldId: operation.world_id };
            throw coreError;
        }
    }

    async #runRepair(initialOperation, { reused }) {
        let operation = initialOperation;
        try {
            let world = await this.#store.get(operation.world_id);
            if (!world) throw new NoraWorldCoreError('NORA_WORLD_NOT_FOUND', 'World was not found.');
            if (['DELETING', 'DELETED'].includes(world.lifecycle.status)) {
                throw new NoraWorldCoreError('NORA_WORLD_NOT_READY', 'A deleting or deleted World cannot be repaired.');
            }
            if (operation.stage === 'RECEIVED') {
                if (typeof this.#materializer.inspect !== 'function') {
                    throw new NoraWorldCoreError('NORA_WORLD_REPAIR_UNSUPPORTED', 'The compatibility adapter cannot inspect World resources.');
                }
                const [storage, compatibility] = await Promise.all([
                    this.#store.inspect(world.world_id),
                    this.#materializer.inspect(world),
                ]);
                const issues = [
                    ...(storage.binding_conflicts.runtime_card.length ? [{
                        code: 'NORA_WORLD_RUNTIME_BINDING_CONFLICT',
                        message: 'Runtime Card binding is owned by another World.',
                    }] : []),
                    ...storage.binding_conflicts.sessions.map(item => ({
                        code: 'NORA_WORLD_SESSION_BINDING_CONFLICT',
                        message: `Story Session ${item.session_id} is bound to another World.`,
                    })),
                    ...(compatibility?.issues || []),
                ];
                if (issues.length) {
                    const repairError = new NoraWorldCoreError(
                        'NORA_WORLD_NEEDS_REPAIR',
                        'World resources still require repair.',
                        { retryable: true, details: { issues } },
                    );
                    await this.#store.update(world.world_id, current => ({
                        ...current,
                        lifecycle: {
                            status: 'FAILED',
                            error: { code: repairError.code, message: repairError.message, retryable: true, issues },
                        },
                        updated_at: this.#now(),
                    }));
                    throw repairError;
                }
                world = await this.#store.update(world.world_id, current => ({
                    ...current,
                    lifecycle: { status: 'READY', error: null },
                    updated_at: this.#now(),
                }));
                operation = await this.#mutations.advance(operation.operation_id, 'INSPECTED', {
                    result: { repaired: true, inspected_at: this.#now() },
                });
            }
            if (operation.stage === 'INSPECTED') {
                operation = await this.#mutations.advance(operation.operation_id, 'COMPLETED');
            }
            return { world, operation, reused };
        } catch (error) {
            const coreError = asWorldCoreError(error, 'NORA_WORLD_REPAIR_FAILED', 'World repair failed.', { retryable: true });
            await this.#mutations.fail(operation.operation_id, coreError).catch(() => {});
            coreError.details = { ...coreError.details, operationId: operation.operation_id, worldId: operation.world_id };
            throw coreError;
        }
    }
}

export function composeNoraWorldCore({
    root,
    materializer,
    now = () => new Date().toISOString(),
    createId = prefix => `${prefix}:${crypto.randomUUID()}`,
}) {
    if (!root) throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'World Core storage root is required.');
    if (typeof materializer?.materialize !== 'function') {
        throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'World Core materializer is required.');
    }
    const locks = new KeyedLock();
    const store = new WorldStore({ root, locks });
    const journal = new OperationJournal({ root, locks, now });
    const mutations = new MutationJournal({ root, locks, now });
    return new NoraWorldCore({ store, journal, mutations, locks, materializer, createId, now });
}
