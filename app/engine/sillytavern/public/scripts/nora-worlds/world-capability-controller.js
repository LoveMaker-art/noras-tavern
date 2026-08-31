const CAPABILITY_ORDER = Object.freeze(['tavern_helper', 'regex', 'mvu']);

function manifestFor(world) {
    return world?.manifest || world;
}

function runtimeCapabilityKey(worldId, capability) {
    return `${worldId}\u0000${capability}`;
}

function orderedCapabilities(manifest, requested = null, runtimeVerified = new Set()) {
    const declared = manifest?.capabilities?.declared || [];
    const worldId = String(manifest?.world_id || '').trim();
    const selected = requested
        ? declared.filter(capability => requested.includes(capability))
        : declared.filter(capability => !runtimeVerified.has(runtimeCapabilityKey(worldId, capability)));
    return [...selected].sort((left, right) => {
        const leftIndex = CAPABILITY_ORDER.indexOf(left);
        const rightIndex = CAPABILITY_ORDER.indexOf(right);
        return (leftIndex < 0 ? CAPABILITY_ORDER.length : leftIndex)
            - (rightIndex < 0 ? CAPABILITY_ORDER.length : rightIndex)
            || left.localeCompare(right);
    });
}

function capabilityFailure(capability, error) {
    const fallback = `NORA_${capability.toUpperCase()}_READINESS_FAILED`;
    const candidate = String(error?.code || '');
    const code = /^NORA_[A-Z0-9_]+$/.test(candidate) ? candidate : fallback;
    const safeMessages = {
        NORA_MVU_TIMEOUT: 'MVU readiness timed out.',
        NORA_MVU_API_UNAVAILABLE: 'MVU did not expose its required data interface.',
        NORA_MVU_READINESS_UNAVAILABLE: 'MVU did not expose a readiness contract.',
        NORA_REGEX_NOT_AUTHORIZED: 'Regex is not authorized for this Runtime Card.',
        NORA_TAVERN_HELPER_NOT_AUTHORIZED: 'Character scripts are not authorized for this Runtime Card.',
    };
    return {
        code,
        message: safeMessages[code] || `${capability} readiness did not complete.`,
        retryable: error?.retryable !== false,
    };
}

export function createWorldCapabilityController({
    client,
    runtime,
    clock = () => performance.now(),
    logger = console,
} = {}) {
    if (typeof client?.beginCapabilityAttempt !== 'function' || typeof client?.settleCapabilityAttempt !== 'function') {
        throw new Error('World capability controller requires the v2 capability persistence interface.');
    }
    if (typeof runtime?.resolveCharacter !== 'function' || typeof runtime?.ensureCharacterCapability !== 'function') {
        throw new Error('World capability controller requires the Runtime Card capability adapter.');
    }
    const tasks = new Map();
    const ensureTasks = new Map();
    const runtimeVerified = new Set();

    async function execute(world, capability, character) {
        const worldId = String(world?.id || manifestFor(world)?.world_id || '').trim();
        const key = runtimeCapabilityKey(worldId, capability);
        if (tasks.has(key)) return tasks.get(key);
        const task = (async () => {
            const begun = await client.beginCapabilityAttempt(worldId, capability);
            const startedAt = clock();
            let result;
            try {
                const evidence = await runtime.ensureCharacterCapability(character, capability);
                result = {
                    status: 'READY',
                    duration_ms: Math.max(0, clock() - startedAt),
                    error: null,
                    evidence,
                };
            } catch (error) {
                logger.warn?.(`[Nora Capability] ${capability} readiness failed:`, error);
                result = {
                    status: 'DEGRADED',
                    duration_ms: Math.max(0, clock() - startedAt),
                    error: capabilityFailure(capability, error),
                    evidence: {
                        engine: 'sillytavern',
                        phase: 'readiness',
                        api_visible: false,
                    },
                };
            }
            const settled = await client.settleCapabilityAttempt(
                worldId,
                capability,
                begun.attempt.attempt_id,
                result,
            );
            runtimeVerified.add(key);
            return Object.freeze({ capability, result, world: settled.world });
        })().finally(() => tasks.delete(key));
        tasks.set(key, task);
        return task;
    }

    async function run(world, { capabilities = null, authorize = null, forceAuthorization = false } = {}) {
        const manifest = manifestFor(world);
        const selected = orderedCapabilities(manifest, capabilities, runtimeVerified);
        if (!selected.length) return Object.freeze({ world: manifest, results: [] });
        const characterId = Number(world?.characterId);
        const character = await runtime.resolveCharacter(characterId);
        if (!character?.avatar) throw new Error('World capability loading requires one available Runtime Card.');
        if (typeof authorize === 'function') {
            await authorize(character, { force: forceAuthorization, reload: true });
        }
        const results = [];
        let latestWorld = manifest;
        for (const capability of selected) {
            const settled = await execute({ ...world, manifest: latestWorld }, capability, character);
            latestWorld = settled.world;
            results.push(settled);
        }
        return Object.freeze({ world: latestWorld, results: Object.freeze(results) });
    }

    function ensure(world, options = {}) {
        const worldId = String(world?.id || manifestFor(world)?.world_id || '').trim();
        if (ensureTasks.has(worldId)) return ensureTasks.get(worldId);
        const task = run(world, options).finally(() => ensureTasks.delete(worldId));
        ensureTasks.set(worldId, task);
        return task;
    }

    return Object.freeze({
        ensure,
        retry: (world, capability, options = {}) => run(world, {
            ...options,
            capabilities: [String(capability || '').trim()],
            forceAuthorization: true,
        }),
    });
}
