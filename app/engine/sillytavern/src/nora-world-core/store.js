import fs from 'node:fs/promises';
import path from 'node:path';

import { documentFileName, quarantineFile, readJsonFile, writeJsonAtomic } from './atomic-json.js';
import { cloneJson, stableStringify, validateWorldManifest } from './domain.js';
import { NoraWorldCoreError } from './errors.js';
import { KeyedLock } from './locks.js';
import { ResourceCatalog } from './resource-catalog.js';

function bindingKeys(world) {
    return [
        stableStringify({ engine: world.runtime_card.engine, binding: world.runtime_card.binding }),
        ...world.sessions.items.map(session => stableStringify({ engine: session.engine, binding: session.binding })),
    ];
}

function isActive(world) {
    return world.lifecycle.status !== 'DELETED';
}

export class WorldStore {
    #fileSystem;
    #locks;
    #loaded = false;
    #loadPromise = null;
    #worlds = new Map();
    #sourceIndex = new Map();
    #bindingIndex = new Map();
    #operationIndex = new Map();
    #resources = new ResourceCatalog();
    #loadReport = { loaded: 0, quarantined: 0 };

    constructor({ root, fileSystem = fs, locks = new KeyedLock() }) {
        this.root = path.resolve(root);
        this.worldsDirectory = path.join(this.root, 'worlds');
        this.quarantineDirectory = path.join(this.root, 'quarantine', 'worlds');
        this.#fileSystem = fileSystem;
        this.#locks = locks;
    }

    async load() {
        if (this.#loaded) return cloneJson(this.#loadReport);
        if (!this.#loadPromise) this.#loadPromise = this.#load();
        return this.#loadPromise;
    }

    async #load() {
        await this.#fileSystem.mkdir(this.worldsDirectory, { recursive: true });
        await this.#fileSystem.mkdir(this.quarantineDirectory, { recursive: true });
        const entries = (await this.#fileSystem.readdir(this.worldsDirectory, { withFileTypes: true }))
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .sort((left, right) => left.name.localeCompare(right.name));
        const worlds = new Map();
        let resources = new ResourceCatalog();
        let quarantined = 0;
        for (const entry of entries) {
            const filePath = path.join(this.worldsDirectory, entry.name);
            try {
                const world = validateWorldManifest(await readJsonFile(filePath, { fileSystem: this.#fileSystem }));
                if (worlds.has(world.world_id)) throw new NoraWorldCoreError('NORA_WORLD_STORAGE_CORRUPT', 'Duplicate World identity in storage.');
                if (world.source.import_operation_id
                    && [...worlds.values()].some(existing => existing.source.import_operation_id === world.source.import_operation_id)) {
                    throw new NoraWorldCoreError('NORA_WORLD_STORAGE_CORRUPT', 'Duplicate import operation binding in storage.');
                }
                resources = new ResourceCatalog([...worlds.values(), world].filter(isActive));
                worlds.set(world.world_id, world);
            } catch {
                await quarantineFile(filePath, this.quarantineDirectory, { fileSystem: this.#fileSystem });
                quarantined += 1;
            }
        }
        this.#worlds = worlds;
        this.#resources = resources;
        this.#rebuildIndexes();
        this.#loadReport = { loaded: worlds.size, quarantined };
        this.#loaded = true;
        return cloneJson(this.#loadReport);
    }

    #rebuildIndexes() {
        this.#sourceIndex = new Map();
        this.#bindingIndex = new Map();
        this.#operationIndex = new Map();
        for (const world of [...this.#worlds.values()].filter(isActive)) {
            if (world.source.import_operation_id) {
                this.#operationIndex.set(world.source.import_operation_id, world.world_id);
            }
            if (world.source.sha256) {
                if (!this.#sourceIndex.has(world.source.sha256)) this.#sourceIndex.set(world.source.sha256, new Set());
                this.#sourceIndex.get(world.source.sha256).add(world.world_id);
            }
            for (const key of bindingKeys(world)) {
                if (!this.#bindingIndex.has(key)) this.#bindingIndex.set(key, new Set());
                this.#bindingIndex.get(key).add(world.world_id);
            }
        }
    }

    async get(worldId) {
        await this.load();
        return cloneJson(this.#worlds.get(String(worldId)) || null);
    }

    async list() {
        await this.load();
        return [...this.#worlds.values()]
            .filter(isActive)
            .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.world_id.localeCompare(right.world_id))
            .map(cloneJson);
    }

    async #commit(worldId, manifest, expectedRevision) {
        // Per-World locks protect transforms; this short commit lock protects
        // invariants shared by ALL Worlds across the asynchronous disk write.
        return this.#locks.run('store:commit', () => this.#commitLocked(worldId, manifest, expectedRevision));
    }

    async #commitLocked(worldId, manifest, expectedRevision) {
        const current = this.#worlds.get(worldId) || null;
        const currentRevision = current?.revision || 0;
        if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision) {
            throw new NoraWorldCoreError(
                'NORA_WORLD_REVISION_CONFLICT',
                `World ${worldId || '<unknown>'} revision changed.`,
                { retryable: true, details: { worldId, expectedRevision, currentRevision } },
            );
        }
        const candidate = validateWorldManifest({ ...manifest, revision: currentRevision + 1 });
        if (candidate.world_id !== worldId) {
            throw new NoraWorldCoreError('NORA_WORLD_INVALID', 'A World update cannot change its identity.');
        }
        const candidateWorlds = [...this.#worlds.values()].filter(world => world.world_id !== worldId);
        candidateWorlds.push(candidate);
        const importOperations = candidateWorlds
            .map(world => world.source.import_operation_id)
            .filter(Boolean);
        if (new Set(importOperations).size !== importOperations.length) {
            throw new NoraWorldCoreError(
                'NORA_OPERATION_CONFLICT',
                'One import operation cannot commit more than one World.',
                { details: { operationId: candidate.source.import_operation_id } },
            );
        }
        const resources = new ResourceCatalog(candidateWorlds.filter(isActive));
        const filePath = path.join(this.worldsDirectory, documentFileName(worldId));
        await writeJsonAtomic(filePath, candidate, { fileSystem: this.#fileSystem });
        this.#worlds.set(worldId, candidate);
        this.#resources = resources;
        this.#rebuildIndexes();
        return cloneJson(candidate);
    }

    async put(manifest, { expectedRevision }) {
        await this.load();
        const worldId = String(manifest?.world_id || '');
        return this.#locks.run(`world:${worldId}`, () => this.#commit(worldId, manifest, expectedRevision));
    }

    async update(worldId, transform) {
        await this.load();
        const normalizedWorldId = String(worldId || '');
        return this.#locks.run(`world:${normalizedWorldId}`, async () => {
            const current = this.#worlds.get(normalizedWorldId) || null;
            if (!current) return null;
            const candidate = await transform(cloneJson(current));
            return this.#commit(normalizedWorldId, candidate, current.revision);
        });
    }

    async findBySource(sourceSha256) {
        await this.load();
        return [...(this.#sourceIndex.get(String(sourceSha256).toLowerCase()) || [])]
            .map(worldId => cloneJson(this.#worlds.get(worldId)));
    }

    async findByBinding(engine, binding) {
        await this.load();
        const key = stableStringify({ engine, binding });
        return [...(this.#bindingIndex.get(key) || [])].map(worldId => cloneJson(this.#worlds.get(worldId)));
    }

    async findByOperation(operationId) {
        await this.load();
        const worldId = this.#operationIndex.get(String(operationId));
        return cloneJson(worldId ? this.#worlds.get(worldId) : null);
    }

    async inspect(worldId) {
        await this.load();
        const world = this.#worlds.get(String(worldId));
        if (!world) return null;
        return {
            world: cloneJson(world),
            resource_references: this.#resources.referencesForWorld(world),
            binding_conflicts: this.#bindingConflicts(world),
        };
    }

    #bindingWorlds(engine, binding) {
        const key = stableStringify({ engine, binding });
        return [...(this.#bindingIndex.get(key) || [])]
            .map(worldId => this.#worlds.get(worldId))
            .filter(Boolean);
    }

    #bindingConflicts(world) {
        const runtimeMatches = this.#bindingWorlds(world.runtime_card.engine, world.runtime_card.binding)
            .filter(item => item.world_id !== world.world_id);
        const runtimeCard = runtimeMatches.filter(item => (
            world.runtime_card.ownership === 'owned'
            || item.runtime_card.resource_id !== world.runtime_card.resource_id
        )).map(item => item.world_id).sort();
        const sessions = world.sessions.items.map(session => ({
            session_id: session.session_id,
            world_ids: this.#bindingWorlds(session.engine, session.binding)
                .filter(item => item.world_id !== world.world_id)
                .map(item => item.world_id)
                .sort(),
        })).filter(item => item.world_ids.length);
        return { runtime_card: runtimeCard, sessions };
    }

    async deletionPlan(worldId) {
        await this.load();
        const world = this.#worlds.get(String(worldId));
        if (!world) return null;
        const references = this.#resources.referencesForWorld(world);
        return {
            world: cloneJson(world),
            runtime_card: {
                delete: world.runtime_card.ownership === 'owned'
                    && references.runtime_card?.world_ids.length === 1,
            },
            knowledge: world.knowledge.map((resource, index) => ({
                resource_id: resource.resource_id,
                delete: resource.ownership === 'owned'
                    && references.knowledge[index]?.world_ids.length === 1,
            })),
            sessions: world.sessions.items.map(session => ({
                session_id: session.session_id,
                delete: this.#bindingWorlds(session.engine, session.binding).length === 1,
            })),
        };
    }
}
