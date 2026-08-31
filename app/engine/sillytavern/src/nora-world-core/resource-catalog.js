import { cloneJson, stableStringify } from './domain.js';
import { NoraWorldCoreError } from './errors.js';

function resourcesForWorld(world) {
    return [
        { kind: 'runtime_card', resource: world.runtime_card },
        ...world.knowledge.map(resource => ({ kind: 'knowledge', resource })),
    ];
}

function definition(resource) {
    return stableStringify({ engine: resource.engine, binding: resource.binding });
}

export class ResourceCatalog {
    #resources = new Map();

    constructor(worlds = []) {
        for (const world of worlds) this.#addWorld(world);
    }

    #addWorld(world) {
        for (const { kind, resource } of resourcesForWorld(world)) {
            const existing = this.#resources.get(resource.resource_id);
            if (existing && existing.definition !== definition(resource)) {
                throw new NoraWorldCoreError(
                    'NORA_RESOURCE_CONFLICT',
                    `Resource ${resource.resource_id} has conflicting compatibility bindings.`,
                    { details: { resourceId: resource.resource_id, worldId: world.world_id } },
                );
            }
            const entry = existing || {
                kind,
                definition: definition(resource),
                resource: cloneJson(resource),
                worldIds: new Set(),
            };
            entry.worldIds.add(world.world_id);
            this.#resources.set(resource.resource_id, entry);
        }
    }

    references(resourceId) {
        const entry = this.#resources.get(resourceId);
        if (!entry) return null;
        return {
            kind: entry.kind,
            resource: cloneJson(entry.resource),
            world_ids: [...entry.worldIds].sort(),
        };
    }

    referencesForWorld(world) {
        return {
            runtime_card: this.references(world.runtime_card.resource_id),
            knowledge: world.knowledge.map(resource => this.references(resource.resource_id)),
        };
    }
}
