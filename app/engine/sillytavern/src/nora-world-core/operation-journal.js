import fs from 'node:fs/promises';
import path from 'node:path';

import { documentFileName, quarantineFile, readJsonFile, writeJsonAtomic } from './atomic-json.js';
import {
    cloneJson,
    commandDigest,
    materializationFromWorld,
    normalizeCreateCommand,
    normalizeMaterialization,
    operationIdForKey,
    OPERATION_STAGES,
    OPERATION_STATUSES,
    sha256,
} from './domain.js';
import { NoraWorldCoreError, serializeWorldCoreError } from './errors.js';
import { KeyedLock } from './locks.js';

function validateOperation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Operation must be an object.');
    if (value.schema !== 'nora-world-operation/v1') throw new Error('Unsupported operation schema.');
    if (!OPERATION_STAGES.includes(value.stage) || !OPERATION_STATUSES.includes(value.status)) throw new Error('Invalid operation state.');
    if (value.type !== 'CREATE_WORLD') throw new Error('Unsupported operation type.');
    if (!/^operation:[a-f0-9]{32}$/.test(value.operation_id || '')) throw new Error('Invalid operation identity.');
    if (!/^[a-f0-9]{64}$/.test(value.idempotency_hash || '')) throw new Error('Invalid idempotency digest.');
    if (value.operation_id !== `operation:${value.idempotency_hash.slice(0, 32)}`) throw new Error('Operation identity does not match its idempotency digest.');
    if (!/^[a-f0-9]{64}$/.test(value.command_digest || '')) throw new Error('Invalid command digest.');
    for (const [field, identity] of [
        ['world_id', value.world_id],
        ['session_id', value.session_id],
        ['runtime_card_resource_id', value.runtime_card_resource_id],
    ]) {
        if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(identity || '')) throw new Error(`Invalid ${field}.`);
    }
    if (!Number.isInteger(value.attempts) || value.attempts < 1) throw new Error('Invalid operation attempts.');
    const command = normalizeCreateCommand(value.command);
    if (commandDigest(command) !== value.command_digest) throw new Error('Operation command digest does not match its command.');
    const stageIndex = OPERATION_STAGES.indexOf(value.stage);
    const completed = value.stage === 'COMPLETED';
    if ((value.status === 'COMPLETED') !== completed) throw new Error('Operation completion status contradicts its stage.');
    if (value.status === 'FAILED' && !value.error) throw new Error('Failed operation must preserve an error.');
    if (value.status !== 'FAILED' && value.error) throw new Error('Non-failed operation cannot preserve an active error.');
    const needsMaterialization = stageIndex >= OPERATION_STAGES.indexOf('MATERIALIZED');
    const materialization = value.materialization === null
        ? null
        : normalizeMaterialization(value.materialization);
    if (needsMaterialization !== Boolean(materialization)) throw new Error('Operation materialization contradicts its stage.');
    const inputReleasedAt = value.input_released_at ?? null;
    if (inputReleasedAt !== null && !Number.isFinite(Date.parse(inputReleasedAt))) {
        throw new Error('Operation staged-input release timestamp must be null or an ISO date.');
    }
    const terminalFailure = value.status === 'FAILED' && value.error?.retryable === false;
    if (inputReleasedAt !== null && !needsMaterialization && !terminalFailure) {
        throw new Error('Operation released staged input before reaching a durable terminal state.');
    }
    if (!Number.isFinite(Date.parse(value.created_at)) || !Number.isFinite(Date.parse(value.updated_at))) {
        throw new Error('Operation timestamps must be ISO dates.');
    }
    return cloneJson({ ...value, command, materialization, input_released_at: inputReleasedAt });
}

export class OperationJournal {
    #fileSystem;
    #locks;
    #now;
    #loaded = false;
    #loadPromise = null;
    #operations = new Map();
    #byIdempotency = new Map();

    constructor({ root, fileSystem = fs, locks = new KeyedLock(), now = () => new Date().toISOString() }) {
        this.operationsDirectory = path.join(path.resolve(root), 'operations');
        this.quarantineDirectory = path.join(path.resolve(root), 'quarantine', 'operations');
        this.#fileSystem = fileSystem;
        this.#locks = locks;
        this.#now = now;
    }

    async load() {
        if (this.#loaded) return;
        if (!this.#loadPromise) this.#loadPromise = this.#load();
        await this.#loadPromise;
    }

    async #load() {
        await this.#fileSystem.mkdir(this.operationsDirectory, { recursive: true });
        await this.#fileSystem.mkdir(this.quarantineDirectory, { recursive: true });
        const entries = (await this.#fileSystem.readdir(this.operationsDirectory, { withFileTypes: true }))
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const filePath = path.join(this.operationsDirectory, entry.name);
            try {
                const operation = validateOperation(await readJsonFile(filePath, { fileSystem: this.#fileSystem }));
                if (this.#operations.has(operation.operation_id) || this.#byIdempotency.has(operation.idempotency_hash)) {
                    throw new Error('Duplicate operation identity.');
                }
                this.#operations.set(operation.operation_id, operation);
                this.#byIdempotency.set(operation.idempotency_hash, operation.operation_id);
            } catch {
                await quarantineFile(filePath, this.quarantineDirectory, { fileSystem: this.#fileSystem });
            }
        }
        this.#loaded = true;
    }

    async #save(operation) {
        const validated = validateOperation(operation);
        await writeJsonAtomic(
            path.join(this.operationsDirectory, documentFileName(validated.operation_id)),
            validated,
            { fileSystem: this.#fileSystem },
        );
        this.#operations.set(validated.operation_id, validated);
        this.#byIdempotency.set(validated.idempotency_hash, validated.operation_id);
        return cloneJson(validated);
    }

    async get(operationId) {
        await this.load();
        return cloneJson(this.#operations.get(String(operationId)) || null);
    }

    async findByIdempotencyKey(idempotencyKey) {
        await this.load();
        const operationId = this.#byIdempotency.get(sha256(idempotencyKey));
        return cloneJson(operationId ? this.#operations.get(operationId) : null);
    }

    async begin({ idempotencyKey, commandDigest, command, worldId, sessionId, runtimeCardResourceId }) {
        await this.load();
        const idempotencyHash = sha256(idempotencyKey);
        return this.#locks.run(`journal-idempotency:${idempotencyHash}`, async () => {
            const existingId = this.#byIdempotency.get(idempotencyHash);
            if (existingId) {
                const existing = this.#operations.get(existingId);
                if (existing.command_digest !== commandDigest) {
                    throw new NoraWorldCoreError(
                        'NORA_OPERATION_CONFLICT',
                        'The idempotency key was already used for a different World command.',
                        { details: { operationId: existing.operation_id } },
                    );
                }
                return cloneJson(existing);
            }
            const timestamp = this.#now();
            return this.#save({
                schema: 'nora-world-operation/v1',
                operation_id: operationIdForKey(idempotencyKey),
                type: 'CREATE_WORLD',
                idempotency_hash: idempotencyHash,
                command_digest: commandDigest,
                command: cloneJson(command),
                world_id: worldId,
                session_id: sessionId,
                runtime_card_resource_id: runtimeCardResourceId,
                stage: 'RECEIVED',
                status: 'RUNNING',
                attempts: 1,
                materialization: null,
                input_released_at: null,
                error: null,
                created_at: timestamp,
                updated_at: timestamp,
            });
        });
    }

    async recoverCommitted({ idempotencyKey, commandDigest, command, world }) {
        await this.load();
        const idempotencyHash = sha256(idempotencyKey);
        return this.#locks.run(`journal-idempotency:${idempotencyHash}`, async () => {
            if (world.source.import_command_digest !== commandDigest) {
                throw new NoraWorldCoreError(
                    'NORA_OPERATION_CONFLICT',
                    'The idempotency key was already committed with a different World command.',
                    { details: { operationId: world.source.import_operation_id, worldId: world.world_id } },
                );
            }
            const existingId = this.#byIdempotency.get(idempotencyHash);
            if (existingId) {
                const existing = this.#operations.get(existingId);
                if (existing.command_digest !== commandDigest || existing.world_id !== world.world_id) {
                    throw new NoraWorldCoreError(
                        'NORA_OPERATION_CONFLICT',
                        'The committed World conflicts with the persisted operation.',
                        { details: { operationId: existing.operation_id, worldId: world.world_id } },
                    );
                }
                return cloneJson(existing);
            }
            const timestamp = this.#now();
            return this.#save({
                schema: 'nora-world-operation/v1',
                operation_id: operationIdForKey(idempotencyKey),
                type: 'CREATE_WORLD',
                idempotency_hash: idempotencyHash,
                command_digest: commandDigest,
                command: cloneJson(command),
                world_id: world.world_id,
                session_id: world.sessions.default_session_id,
                runtime_card_resource_id: world.runtime_card.resource_id,
                stage: 'COMPLETED',
                status: 'COMPLETED',
                attempts: 1,
                materialization: materializationFromWorld(world),
                input_released_at: timestamp,
                error: null,
                created_at: world.created_at,
                updated_at: timestamp,
            });
        });
    }

    async advance(operationId, stage, patch = {}) {
        await this.load();
        return this.#locks.run(`journal-operation:${operationId}`, async () => {
            const current = this.#operations.get(String(operationId));
            if (!current) throw new NoraWorldCoreError('NORA_OPERATION_NOT_FOUND', 'World operation was not found.');
            const currentIndex = OPERATION_STAGES.indexOf(current.stage);
            const nextIndex = OPERATION_STAGES.indexOf(stage);
            if (nextIndex < 0 || nextIndex > currentIndex + 1 || nextIndex < currentIndex) {
                throw new NoraWorldCoreError('NORA_OPERATION_STAGE', `Cannot advance operation from ${current.stage} to ${stage}.`);
            }
            if (nextIndex === currentIndex) return cloneJson(current);
            const completed = stage === 'COMPLETED';
            return this.#save({
                ...current,
                ...cloneJson(patch),
                stage,
                status: completed ? 'COMPLETED' : 'RUNNING',
                error: null,
                updated_at: this.#now(),
            });
        });
    }

    async fail(operationId, error) {
        await this.load();
        return this.#locks.run(`journal-operation:${operationId}`, async () => {
            const current = this.#operations.get(String(operationId));
            if (!current) return null;
            if (current.status === 'COMPLETED') return cloneJson(current);
            return this.#save({
                ...current,
                status: 'FAILED',
                error: serializeWorldCoreError(error),
                updated_at: this.#now(),
            });
        });
    }

    async pendingInputReleases() {
        await this.load();
        const materializedIndex = OPERATION_STAGES.indexOf('MATERIALIZED');
        return [...this.#operations.values()]
            .filter(operation => operation.input_released_at === null
                && (OPERATION_STAGES.indexOf(operation.stage) >= materializedIndex
                    || (operation.status === 'FAILED' && operation.error?.retryable === false)))
            .map(cloneJson);
    }

    async markInputReleased(operationId) {
        await this.load();
        return this.#locks.run(`journal-operation:${operationId}`, async () => {
            const current = this.#operations.get(String(operationId));
            if (!current) throw new NoraWorldCoreError('NORA_OPERATION_NOT_FOUND', 'World operation was not found.');
            if (current.input_released_at !== null) return cloneJson(current);
            const materialized = OPERATION_STAGES.indexOf(current.stage) >= OPERATION_STAGES.indexOf('MATERIALIZED');
            const terminalFailure = current.status === 'FAILED' && current.error?.retryable === false;
            if (!materialized && !terminalFailure) {
                throw new NoraWorldCoreError('NORA_OPERATION_STAGE', 'Staged input is still required by this World operation.');
            }
            return this.#save({
                ...current,
                input_released_at: this.#now(),
                updated_at: this.#now(),
            });
        });
    }

    async resume(operationId) {
        await this.load();
        return this.#locks.run(`journal-operation:${operationId}`, async () => {
            const current = this.#operations.get(String(operationId));
            if (!current) throw new NoraWorldCoreError('NORA_OPERATION_NOT_FOUND', 'World operation was not found.');
            if (current.status === 'COMPLETED') return cloneJson(current);
            if (current.status !== 'FAILED') return cloneJson(current);
            return this.#save({
                ...current,
                status: 'RUNNING',
                attempts: current.attempts + 1,
                error: null,
                updated_at: this.#now(),
            });
        });
    }
}
