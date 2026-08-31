export function createUiStore(state, settingsDomain, worlds) {
    let runtimeState = state.snapshot();
    const worldbookCache = new Map();

    function read() {
        runtimeState = state.snapshot();
        const worldModels = worlds.list();
        const activeWorld = worldModels.find((world) => world.active) || null;
        const currentCharacter = runtimeState.characters?.[runtimeState.activeCharacterId] || null;
        const persona = activeWorld?.persona || {
            name: runtimeState.user.name,
            description: runtimeState.user.description,
        };
        return Object.freeze({
            runtime: runtimeState,
            settings: settingsDomain.uiSettings(),
            worldModels,
            activeWorld,
            currentCharacter,
            persona,
            worldStatus: typeof worlds.status === 'function' ? worlds.status() : null,
        });
    }

    function cachedWorldbook(name) {
        return worldbookCache.get(String(name || '').trim());
    }

    function cacheWorldbook(name, book) {
        const normalized = String(name || '').trim();
        if (normalized && book && typeof book === 'object') worldbookCache.set(normalized, book);
        return book;
    }

    function clearWorldbook(name) {
        worldbookCache.delete(String(name || '').trim());
    }

    return Object.freeze({ read, cachedWorldbook, cacheWorldbook, clearWorldbook });
}
