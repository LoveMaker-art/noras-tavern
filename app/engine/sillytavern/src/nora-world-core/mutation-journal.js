import fs from 'node:fs/promises';
import path from 'node:path';

import { documentFileName, quarantineFile, readJsonFile, writeJsonAtomic } from './atomic-json.js';
import { cloneJson, sha256, stableStringify } from './domain.js';
import { NoraWorldCoreError, serializeWorldCoreError } from './errors.js';
import { KeyedLock } from './locks.js';

const DEFINITIONS = Object.freeze({
    DELETE_WORLD: Object.freeze(['RECEIVED', 'WORLD_MARKED_DELETING', 'RESOURCES_RELEASED', 'COMPLETED']),
    REPAIR_WORLD: Object.freeze(['RECEIVED', 'INSPECTED', 'COMPLETED']),
});
const STATUSES = Object.freeze(['RUNNING', 'FAILED', 'COMPLETED']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/;

function operationIdentity(type, idempotencyKey) {
    const idempotencyHash = sha256(`${type}\u0000${idempotencyKey}`);
    return { idempotencyHash, operationId: `operation:${idempotencyHash.slice(0, 32)}` };
}

function commandDigest(type, worldId) {
    return sha256(stableStringify({ type, world_id: worldId }));
}

function validateOperation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Mutation operation must be an object.');
    if (value.schema !== 'nora-world-operation/v1') throw new Error('Unsupported mutation operation schema.');
    const stages = DEFINITIONS[value.type];
    if (!stages) throw new Error('Unsupported mutation operation type.');
    if (!stages.includes(value.stage) || !STATUSES.includes(value.status)) throw new Error('Invalid mutation operation state.');
    if (!/^operation:[a-f0-9]{32}$/.test(value.operation_id || '')) throw new Error('Invalid mutation operation identity.');
    if (!/^[a-f0-9]{64}$/.test(value.idempotency_hash || '')) throw new Error('Invalid mutation idempotency digest.');
    if (value.operation_id !== `operation:${value.idempotency_hash.slice(0, 32)}`) throw new Error('Mutation identity does not match its idempotency digest.');
    if (!ID_PATTERN.test(value.world_id || '')) throw new Error('Invalid mutation World identity.');
    if (value.command_digest !== commandDigest(value.type, value.world_id)) throw new Error('Mutation command digest does not match its command.');
    if (!Number.isInteger(value.attempts) || value.attempts < 1) throw new Error('Invalid mutation attempts.');
    const completed = value.stage === 'COMPLETED';
    if ((value.status === 'COMPLETED') !== completed) throw new Error('Mutation completion status contradicts its stage.');
    if (value.status === 'FAILED' && !value.error) throw new Error('Failed mutation must preserve an error.');
    if (value.status !== 'FAILED' && value.error) throw new Error('Non-failed mutation cannot preserve an active error.');
    if (!Number.isFinite(Date.parse(value.created_at)) || !Number.isFinite(Date.parse(value.updated_at))) {
        throw new Error('Mutation timestamps must be ISO dates.');
    }
    return cloneJson({ ...value, result: value.result ?? null });
}

export class MutationJournal {
    #fileSystem;
    #locks;
    #now;
    #loaded = false;
    #loadPromise = null;
    #operations = new Map();
    #byIdempotency = new Map();

    constructor({ root, fileSystem = fs, locks = new KeyedLock(), now = () => new Date().toISOString() }) {
        this.operationsDirectory = path.join(path.resolve(root), 'mutations');
        this.quarantineDirectory = path.join(path.resolve(root), 'quarantine', 'mutations');
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
                    throw new Error('Duplicate mutation operation identity.');
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

    async begin({ type, worldId, idempotencyKey }) {
        await this.load();
        if (!DEFINITIONS[type]) throw new NoraWorldCoreError('NORA_OPERATION_TYPE', 'Unsupported World mutation operation.');
        const normalizedWorldId = String(worldId || '').trim();
        const normalizedKey = String(idempotencyKey || '').trim();
        if (!ID_PATTERN.test(normalizedWorldId) || !normalizedKey || normalizedKey.length > 512) {
            throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'World mutation identity or idempotency key is invalid.');
        }
        const { idempotencyHash, operationId } = operationIdentity(type, normalizedKey);
        return this.#locks.run(`mutation-idempotency:${idempotencyHash}`, async () => {
            const existingId = this.#byIdempotency.get(idempotencyHash);
            if (existingId) {
                const existing = this.#operations.get(existingId);
                if (existing.type !== type || existing.world_id !== normalizedWorldId) {
                    throw new NoraWorldCoreError(
                        'NORA_OPERATION_CONFLICT',
                        'The idempotency key was already used for another World mutation.',
                        { details: { operationId: existing.operation_id } },
                    );
                }
                return { operation: cloneJson(existing), reused: true };
            }
            const timestamp = this.#now();
            const operation = await this.#save({
                schema: 'nora-world-operation/v1',
                operation_id: operationId,
                type,
                idempotency_hash: idempotencyHash,
                command_digest: commandDigest(type, normalizedWorldId),
                world_id: normalizedWorldId,
                stage: 'RECEIVED',
                status: 'RUNNING',
                attempts: 1,
                result: null,
                error: null,
                created_at: timestamp,
                updated_at: timestamp,
            });
            return { operation, reused: false };
        });
    }

    async advance(operationId, stage, patch = {}) {
        await this.load();
        return this.#locks.run(`mutation-operation:${operationId}`, async () => {
            const current = this.#operations.get(String(operationId));
            if (!current) throw new NoraWorldCoreError('NORA_OPERATION_NOT_FOUND', 'World operation was not found.');
            const stages = DEFINITIONS[current.type];
            const currentIndex = stages.indexOf(current.stage);
            const nextIndex = stages.indexOf(stage);
            if (nextIndex < 0 || nextIndex > currentIndex + 1 || nextIndex < currentIndex) {
                throw new NoraWorldCoreError('NORA_OPERATION_STAGE', `Cannot advance operation from ${current.stage} to ${stage}.`);
            }
            if (nextIndex === currentIndex) return cloneJson(current);
            return this.#save({
                ...current,
                ...cloneJson(patch),
                stage,
                status: stage === 'COMPLETED' ? 'COMPLETED' : 'RUNNING',
                error: null,
                updated_at: this.#now(),
            });
        });
    }

    async fail(operationId, error) {
        await this.load();
        return this.#locks.run(`mutation-operation:${operationId}`, async () => {
            const current = this.#operations.get(String(operationId));
            if (!current || current.status === 'COMPLETED') return cloneJson(current || null);
            return this.#save({
                ...current,
                status: 'FAILED',
                error: serializeWorldCoreError(error),
                updated_at: this.#now(),
            });
        });
    }

    async resume(operationId) {
        await this.load();
        return this.#locks.run(`mutation-operation:${operationId}`, async () => {
            const current = this.#operations.get(String(operationId));
            if (!current) throw new NoraWorldCoreError('NORA_OPERATION_NOT_FOUND', 'World operation was not found.');
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
