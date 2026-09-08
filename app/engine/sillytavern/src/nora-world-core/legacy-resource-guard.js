import { NoraWorldCoreError } from './errors.js';
import { resolveNoraWorldCore } from './runtime.js';

function boundAvatar(binding) {
    return typeof binding?.avatar === 'string' ? binding.avatar : '';
}

/**
 * Prevent legacy SillyTavern routes from mutating resources owned by World Core.
 * Plain ST character cards remain editable through the compatibility routes.
 *
 * @param {import('../workspace.js').UserDirectoryList} directories User directories.
 * @param {string} avatar Character avatar filename.
 * @param {{resolveCore?: typeof resolveNoraWorldCore}} options Test seam for the World Core resolver.
 */
export async function assertLegacyCharacterMutationAllowed(
    directories,
    avatar,
    { resolveCore = resolveNoraWorldCore } = {},
) {
    const target = String(avatar || '');
    if (!target) return;

    const worlds = await resolveCore(directories).listWorlds();
    const worldIds = worlds
        .filter(world => boundAvatar(world.runtime_card?.binding) === target
            || world.sessions?.items?.some(session => boundAvatar(session.binding) === target))
        .map(world => String(world.world_id))
        .filter(Boolean)
        .sort();

    if (!worldIds.length) return;

    const error = new NoraWorldCoreError(
        'NORA_WORLD_RESOURCE_IN_USE',
        'This character belongs to a Nora World and must be changed through World Core.',
        { details: { avatar: target, worldIds: [...new Set(worldIds)] } },
    );
    error.status = 409;
    throw error;
}
