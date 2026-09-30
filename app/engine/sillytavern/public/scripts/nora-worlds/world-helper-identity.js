// Resolve only authoritative World bindings, never a display name or a suffix
// parsed from a filename. Consent remains in Helper's existing settings store.
export function createWorldHelperIdentity() {
    let readWorlds = null;
    const listeners = new Set();
    const api = {
        configure(reader) { readWorlds = reader; api.changed(); },
        resolve(avatar, worldId = null) {
            if (!avatar) return null;
            if (!readWorlds) return { key: avatar, avatar, worldId: null, name: '' };
            const matches = readWorlds().filter(world => !['DELETING', 'DELETED'].includes(world.lifecycle?.status)
                && world.runtime_card?.binding?.avatar === avatar
                && (!worldId || world.world_id === worldId));
            if (matches.length !== 1) return null;
            const world = matches[0];
            return { key: `nora-world:${world.world_id}`, avatar, worldId: world.world_id, name: world.name };
        },
        key(avatar, worldId = null) { return api.resolve(avatar, worldId)?.key || null; },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        changed() { for (const listener of listeners) listener(); },
    };
    return Object.freeze(api);
}

export const worldHelperIdentity = globalThis[Symbol.for('tavern.world-helper-identity')] ??= createWorldHelperIdentity();
