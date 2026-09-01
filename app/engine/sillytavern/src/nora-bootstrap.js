export async function createBootstrapPayload({
    csrfToken,
    directories,
    assetRelease,
    listCharactersFn,
    readRuntimeSettingsFn,
    readSecretStateFn,
    readVersionFn,
    readAgentUserIdFn,
}) {
    if (typeof listCharactersFn !== 'function') {
        throw new TypeError('Nora bootstrap data readers are required.');
    }
    if (typeof assetRelease !== 'string' || !/^[a-f0-9]{12,64}$/i.test(assetRelease)) {
        throw new TypeError('Nora bootstrap requires a valid asset release.');
    }
    const [characters, runtimeSettings, secretState, version, agentUserId] = await Promise.all([
        listCharactersFn(directories),
        typeof readRuntimeSettingsFn === 'function' ? readRuntimeSettingsFn(directories) : null,
        typeof readSecretStateFn === 'function' ? readSecretStateFn(directories) : null,
        typeof readVersionFn === 'function' ? readVersionFn() : null,
        typeof readAgentUserIdFn === 'function' ? readAgentUserIdFn() : '',
    ]);
    return {
        schema: 6,
        assetRelease,
        csrfToken,
        characters,
        runtimeSettings,
        secretState,
        version,
        agentUserId: String(agentUserId || ''),
        fetchedAt: Date.now(),
    };
}
