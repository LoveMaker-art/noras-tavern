import { cloneJson, validateWorldManifest } from './domain.js';
import { NoraWorldCoreError } from './errors.js';

export function createActivationPlan(value) {
    const world = validateWorldManifest(value);
    if (world.lifecycle.status !== 'READY') {
        throw new NoraWorldCoreError(
            'NORA_WORLD_NOT_READY',
            `World ${world.world_id} is not ready to open.`,
            { details: { worldId: world.world_id, lifecycle: world.lifecycle.status } },
        );
    }
    const session = world.sessions.items.find(item => item.session_id === world.sessions.default_session_id);
    if (!session) {
        throw new NoraWorldCoreError(
            'NORA_WORLD_STORAGE_CORRUPT',
            `World ${world.world_id} has no default Story Session.`,
            { details: { worldId: world.world_id } },
        );
    }
    return Object.freeze({
        schema: 'nora-world-activation/v1',
        world_id: world.world_id,
        world_revision: world.revision,
        name: world.name,
        persona: cloneJson(world.persona),
        ...(world.story_context ? { story_context: cloneJson(world.story_context) } : {}),
        ...(world.ui === undefined ? {} : { ui: cloneJson(world.ui) }),
        runtime_card: cloneJson(world.runtime_card),
        session: cloneJson(session),
        knowledge: cloneJson(world.knowledge),
        capabilities: {
            declared: [...world.capabilities.declared],
            status: world.capabilities.status,
        },
    });
}
