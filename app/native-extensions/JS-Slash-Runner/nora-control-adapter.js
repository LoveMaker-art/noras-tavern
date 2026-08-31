// Narrow adapter to the upstream stores. Do not mutate ST's serialized copy and
// assume Helper's live reactive store changed with it.
export function createHelperControlAdapter({ globalStore, scopeStore, scopeOwner = () => null, validateSettings, clone, flushScope }) {
    function assign(target, source) {
        for (const [key, value] of Object.entries(source)) {
            if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) assign(target[key], value);
            else target[key] = value;
        }
    }
    return Object.freeze({
        settings: () => clone(globalStore().settings),
        configure(next) {
            // Audio/render consumers may hold refs to nested objects. Preserve those identities.
            assign(globalStore().settings, validateSettings(next));
        },
        scope(type) {
            const store = scopeStore(type);
            if (type !== 'global' && (!store.source || store.source === 'unknown')) throw new Error('Helper scope is not available.');
            return { source: store.source, enabled: store.enabled, ownerId: scopeOwner(type) };
        },
        setScopeEnabled(type, enabled) { scopeStore(type).enabled = Boolean(enabled); },
        async flush(type, expectedSource) {
            // Allow upstream watchers to observe the edit before synchronizing storage.
            await Promise.resolve();
            if (this.scope(type).source !== expectedSource) throw new Error('Helper scope changed during the edit.');
            await flushScope(type);
        },
    });
}
