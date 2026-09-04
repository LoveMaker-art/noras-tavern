export async function createBootstrapPayload({
    csrfToken,
    directories,
    assetRelease,
    readRuntimeSettingsFn,
    readSecretStateFn,
    readVersionFn,
    readAgentUserIdFn,
}) {
    if (typeof assetRelease !== 'string' || !/^[a-f0-9]{12,64}$/i.test(assetRelease)) {
        throw new TypeError('Nora bootstrap requires a valid asset release.');
    }
    const [runtimeSettings, secretState, version, agentUserId] = await Promise.all([
        typeof readRuntimeSettingsFn === 'function' ? readRuntimeSettingsFn(directories) : null,
        typeof readSecretStateFn === 'function' ? readSecretStateFn(directories) : null,
        typeof readVersionFn === 'function' ? readVersionFn() : null,
        typeof readAgentUserIdFn === 'function' ? readAgentUserIdFn() : '',
    ]);
    return {
        schema: 7,
        assetRelease,
        csrfToken,
        runtimeSettings,
        secretState,
        version,
        agentUserId: String(agentUserId || ''),
        fetchedAt: Date.now(),
    };
}

function defaultSession(world) {
    const sessionId = String(world?.sessions?.default_session_id || '');
    return world?.sessions?.items?.find(item => String(item?.session_id || '') === sessionId) || null;
}

export function projectShellWorld(world) {
    const session = defaultSession(world);
    return {
        id: String(world?.world_id || ''),
        revision: Number(world?.revision || 0),
        name: String(world?.name || ''),
        lifecycleStatus: String(world?.lifecycle?.status || 'FAILED'),
        capabilityStatus: String(world?.capabilities?.status || 'READY'),
        openingState: session?.opening_state === 'empty' ? 'empty' : 'message',
        updatedAt: String(world?.updated_at || ''),
    };
}

export async function createShellPayload({ assetRelease, listWorldsFn }) {
    if (typeof listWorldsFn !== 'function') {
        throw new TypeError('Nora shell requires the authoritative World reader.');
    }
    if (typeof assetRelease !== 'string' || !/^[a-f0-9]{12,64}$/i.test(assetRelease)) {
        throw new TypeError('Nora shell requires a valid asset release.');
    }
    const worlds = (await listWorldsFn()).map(projectShellWorld);
    return {
        schema: 1,
        assetRelease,
        worlds,
        fetchedAt: Date.now(),
    };
}
