let readinessHandler = null;

function readinessError(message) {
    return Object.assign(new Error(message), { code: 'NORA_WORLD_RENDER_READINESS_UNAVAILABLE' });
}

export function registerWorldRenderReadiness(handler) {
    if (typeof handler !== 'function') {
        throw new TypeError('World render readiness requires one preparation handler.');
    }
    if (readinessHandler) {
        throw readinessError('World render readiness already has an owner.');
    }
    readinessHandler = handler;
    return () => {
        if (readinessHandler === handler) readinessHandler = null;
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
    if (!readinessHandler) {
        throw readinessError('World render readiness has not been registered.');
    }
    return await readinessHandler(Object.freeze({ worldId, sessionId, chatId, characterId }));
}
