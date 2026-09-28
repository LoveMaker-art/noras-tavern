import { createStRuntimeAdapter } from '../nora-adapters/st-runtime-adapter.js';
import { createStWorldAdapter } from '../nora-adapters/st-world-adapter.js';
import { loadStCompatibilityKernel } from '../nora-compat/st-kernel.js';
import { createWorldCoreClient } from '../nora-worlds/world-core-client.js';
import { createWorldCoreRuntime } from '../nora-worlds/world-core-runtime.js';

const DOMAIN_METHODS = Object.freeze({
    state: ['snapshot', 'subscribe', 'whenReady'],
    messages: ['runSlash', 'prepareMutation', 'sendText', 'stop', 'regenerate', 'editAndRegenerate', 'suggestReplies', 'isGenerating', 'swipe', 'editMessage', 'restoreMessage'],
    cards: ['isSystemCharacter', 'resolveCharacter', 'characterCapabilities', 'ensureCharacterCapability', 'markCharacterCapabilitiesPrompted', 'enableCharacterCapabilities', 'rerenderCharacterChat', 'refreshCharacters', 'updateCharacter', 'patchCharacter', 'readCharacterRegex', 'saveCharacterRegex', 'deleteCharacterCards', 'importLibraryCard', 'savePersona'],
    worldbook: ['loadWorldbook', 'saveWorldbook', 'saveWorldbookEntry', 'saveWorldScenario', 'updateEmbeddedWorldbook'],
    model: ['assertModelConfigured', 'configureModel', 'clearModelConfiguration', 'deleteModelSecret'],
    mvu: ['status', 'setEnabled', 'useStoryModel', 'useIndependentModel'],
    settings: ['uiSettings', 'saveUiSettings', 'setHostPersonality'],
    transport: ['requestHeaders'],
    presets: ['listPresets', 'importPreset', 'applyPreset', 'readPreset', 'savePresetEntries', 'toggleablePresetEntries', 'deletePreset'],
});

function createDomain(runtime, name, methods) {
    const domain = {};
    for (const method of methods) {
        if (typeof runtime?.[method] !== 'function') {
            throw new Error(`故事运行核心的 ${name} 域缺少能力：${method}`);
        }
        domain[method] = runtime[method];
    }
    return Object.freeze(domain);
}

export function createStorySurface(runtime, worlds) {
    if (!worlds || typeof worlds.activate !== 'function') {
        throw new Error('故事运行核心缺少世界生命周期。');
    }
    const domains = Object.fromEntries(Object.entries(DOMAIN_METHODS)
        .map(([name, methods]) => [name, createDomain(runtime, name, methods)]));
    return Object.freeze({
        ...domains,
        worlds,
    });
}

export async function createNoraStoryCore({
    loadKernel = loadStCompatibilityKernel,
    createRuntime = createStRuntimeAdapter,
    createWorldAdapter = createStWorldAdapter,
    createV2Client = createWorldCoreClient,
    createV2Worlds = createWorldCoreRuntime,
    bootstrap = globalThis.__NORA_SHELL_BOOTSTRAP_PROMISE__,
} = {}) {
    let runtime;
    // Only the release-validated bootstrap may authorize the early read.
    const earlyClient = bootstrap ? Promise.resolve(bootstrap).then(data => {
        if (!data?.csrfToken) return null;
        const client = createV2Client(() => runtime ? runtime.requestHeaders() : {
            'Content-Type': 'application/json', 'X-CSRF-Token': data.csrfToken,
        });
        client.prefetchList?.();
        return client;
    }).catch(() => null) : null;
    const kernel = await loadKernel();
    runtime = createRuntime(kernel.getContext, { whenAppReady: () => kernel.whenAppReady });
    const worldAdapter = createWorldAdapter(kernel.getContext);
    const worlds = createV2Worlds(worldAdapter, {
        client: await earlyClient || createV2Client(runtime.requestHeaders),
        capabilityRuntime: runtime,
        refreshCharacters: runtime.refreshCharacters,
    });
    return createStorySurface(runtime, worlds);
}
