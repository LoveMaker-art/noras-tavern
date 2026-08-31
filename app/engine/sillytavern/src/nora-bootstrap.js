export async function createBootstrapPayload({
    csrfToken,
    directories,
    listCharactersFn,
    readRuntimeSettingsFn,
    readSecretStateFn,
    readVersionFn,
    readAgentUserIdFn,
}) {
    if (typeof listCharactersFn !== 'function') {
        throw new TypeError('Nora bootstrap data readers are required.');
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
        csrfToken,
        characters,
        runtimeSettings,
        secretState,
        version,
        agentUserId: String(agentUserId || ''),
        fetchedAt: Date.now(),
    };
}
