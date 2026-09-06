const readinessRegistryKey = Symbol.for('nora.world-render-readiness');

function readinessRegistry() {
    const existing = globalThis[readinessRegistryKey];
    if (existing) return existing;
    const registry = { handler: null };
    Object.defineProperty(globalThis, readinessRegistryKey, {
        value: registry,
        configurable: true,
    });
    return registry;
}

function readinessError(message) {
    return Object.assign(new Error(message), { code: 'NORA_WORLD_RENDER_READINESS_UNAVAILABLE' });
}

export function registerWorldRenderReadiness(handler) {
    if (typeof handler !== 'function') {
        throw new TypeError('World render readiness requires one preparation handler.');
    }
    const registry = readinessRegistry();
    if (registry.handler) {
        throw readinessError('World render readiness already has an owner.');
    }
    registry.handler = handler;
    return () => {
        if (registry.handler === handler) registry.handler = null;
    };
}

export async function prepareWorldRender(context) {
    const worldId = String(context?.worldId || '').trim();
    const sessionId = String(context?.sessionId || '').trim();
    const chatId = String(context?.chatId || '').replace(/\.jsonl$/i, '').trim();
    const characterId = Number(context?.characterId);
    if (!worldId || !sessionId || !chatId || !Number.isInteger(characterId) || characterId < 0) {
        throw readinessError('World render readiness received an incomplete active Story Session.');
    }
    const handler = readinessRegistry().handler;
    if (!handler) {
        throw readinessError('World render readiness has not been registered.');
    }
    return await handler(Object.freeze({ worldId, sessionId, chatId, characterId }));
}
