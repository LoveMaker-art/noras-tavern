import {
    applyMvuSettings,
    createRetryableMvuLoader,
    ensureHeadlessMvuScript,
    ensureHeadlessMvuScriptInSettings,
    hasInitializedMvuData,
    initializeHeadlessMvuSettings,
    isMvuVariableModelEnabled,
    NORA_MVU_MODEL_PROXY_URL,
    setMvuVariableModelEnabled,
    waitForTavernHelper,
    waitForMvuRuntime,
} from './runtime.js';
import { inspectMvuCompatibility } from '../../engine/sillytavern/public/scripts/nora-compat/mvu-compatibility.js';
import { createMvuUpdateObserver } from './update-observer.js';

const state = {
    phase: 'idle',
    registration: null,
    error: null,
    updateObserver: null,
};

export function createManagedMvuRuntimeLoader({
    waitForHelper = waitForTavernHelper,
    ensureScript = ensureHeadlessMvuScript,
    waitForRuntime = waitForMvuRuntime,
    onRegistration = () => {},
    timeoutMs = 15000,
} = {}) {
    return createRetryableMvuLoader(async () => {
        const helper = await waitForHelper({ timeoutMs });
        onRegistration(ensureScript(helper));
        return waitForRuntime({ timeoutMs });
    });
}

const loadManagedRuntime = createManagedMvuRuntimeLoader({
    onRegistration: registration => { state.registration = registration; },
});

function context() {
    const value = globalThis.SillyTavern?.getContext?.();
    if (!value) throw new Error('Nora runtime context is unavailable.');
    return value;
}

function runtimeDataInitialized() {
    try {
        return hasInitializedMvuData(globalThis.Mvu?.getMvuData?.({ type: 'message', message_id: 'latest' }));
    } catch {
        return false;
    }
}

function statusSnapshot() {
    const settings = context().extensionSettings.mvu_settings ?? {};
    const model = settings['额外模型解析配置'] ?? {};
    const initialized = runtimeDataInitialized();
    return {
        ...state,
        runtimeAvailable: typeof globalThis.Mvu?.getMvuData === 'function',
        declared: false,
        declarationChecked: false,
        initialized,
        supported: initialized,
        enabled: isMvuVariableModelEnabled(settings),
        updateMode: settings['更新方式'] ?? null,
        variableModel: model['模型来源'] ?? null,
        variableModelName: model['模型名称'] ?? null,
        ...(state.updateObserver?.status?.() ?? {
            updateOperational: null,
            updatePhase: 'unobserved',
            lastUpdateAt: null,
            lastUpdateError: null,
            lastUpdateCommandCount: null,
            stateChanged: null,
        }),
    };
}

function attachUpdateObserver(runtime) {
    if (state.updateObserver) return;
    const runtimeContext = context();
    if (typeof runtimeContext.eventSource?.on !== 'function'
        || !runtime?.events?.VARIABLE_UPDATE_STARTED
        || !runtime?.events?.COMMAND_PARSED
        || !runtime?.events?.VARIABLE_UPDATE_ENDED) {
        return;
    }
    state.updateObserver = createMvuUpdateObserver({
        eventSource: runtimeContext.eventSource,
        events: runtime.events,
        identity: () => String(context().chatId || context().getCurrentChatId?.() || ''),
    });
}

async function inspectCurrentCard() {
    const snapshot = statusSnapshot();
    const helper = globalThis.TavernHelper;
    let declared = false;
    let compatibility = null;
    try {
        const bookName = helper?.getCurrentCharPrimaryLorebook?.();
        if (bookName && typeof helper?.getLorebookEntries === 'function') {
            const entries = await helper.getLorebookEntries(bookName);
            compatibility = inspectMvuCompatibility({ books: [entries] });
            declared = compatibility.declared;
        }
    } catch (error) {
        console.warn('[Nora MVU] Unable to inspect the current card worldbook', error);
    }
    return {
        ...snapshot,
        declared,
        declarationChecked: true,
        supported: declared || snapshot.initialized,
        updateProtocol: compatibility?.updateProtocol ?? 'none',
        splitModelSupported: compatibility?.splitModelSupported ?? false,
        updateEntryCount: compatibility?.updateEntryIds.length ?? 0,
        inspectionReasons: compatibility?.reasons ?? [],
    };
}

function exposeApi() {
    globalThis.NoraMvu = Object.freeze({
        status() {
            return statusSnapshot();
        },
        inspectCurrentCard() {
            return inspectCurrentCard();
        },
        settings() {
            return structuredClone(context().extensionSettings.mvu_settings ?? {});
        },
        configure(patch) {
            return applyMvuSettings(context(), patch);
        },
        setEnabled(enabled) {
            return setMvuVariableModelEnabled(context(), enabled);
        },
        useStoryModel() {
            return applyMvuSettings(context(), {
                '更新方式': '额外模型解析',
                '额外模型解析配置': { '模型来源': '与插头相同' },
            });
        },
        useIndependentModel({ model }) {
            return applyMvuSettings(context(), {
                '更新方式': '额外模型解析',
                '额外模型解析配置': {
                    '模型来源': '自定义',
                    'api地址': NORA_MVU_MODEL_PROXY_URL,
                    '密钥': '',
                    '模型名称': String(model || '').trim(),
                },
            });
        },
        async retryLastUpdate() {
            if (typeof globalThis.Mvu?.retryLastUpdate !== 'function') {
                throw new Error('MVU runtime is not ready.');
            }
            await globalThis.Mvu.retryLastUpdate();
        },
    });
}

function startMvuRuntime() {
    if (context().extensionSettings.nora_mvu?.managedRuntimeEnabled === false) {
        state.phase = 'disabled';
        return Promise.reject(Object.assign(new Error('Managed MVU runtime is disabled.'), { code: 'NORA_MVU_DISABLED', retryable: false }));
    }
    if (state.phase === 'ready') return Promise.resolve(globalThis.Mvu);
    if (state.phase === 'loading-runtime' && globalThis.__NORA_MVU_READY_PROMISE__) {
        return globalThis.__NORA_MVU_READY_PROMISE__;
    }
    state.phase = 'loading-runtime';
    state.error = null;
    const ready = loadManagedRuntime().then((runtime) => {
        state.phase = 'ready';
        attachUpdateObserver(runtime);
        console.info('[Nora MVU] headless runtime ready', state.registration);
        return runtime;
    }).catch((error) => {
        state.phase = 'failed';
        state.error = String(error?.message || error);
        exposeApi();
        console.error('[Nora MVU] failed to initialize', error);
        throw error;
    });
    globalThis.__NORA_MVU_READY_PROMISE__ = ready;
    void ready.catch(() => {});
    return ready;
}

export function ensureNoraMvuReady() {
    return startMvuRuntime();
}

export async function activateNoraMvu() {
    if (state.phase === 'ready' || state.phase === 'loading-runtime' || state.phase === 'starting') return;
    state.phase = 'starting';
    state.error = null;
    try {
        const runtimeContext = context();
        initializeHeadlessMvuSettings(runtimeContext);
        state.registration = ensureHeadlessMvuScriptInSettings(runtimeContext);
        exposeApi();
        globalThis.__NORA_ENSURE_MVU_READY__ = ensureNoraMvuReady;
        if (runtimeContext.extensionSettings.nora_mvu?.managedRuntimeEnabled === false) { state.phase = 'disabled'; return; }
        startMvuRuntime();
    } catch (error) {
        state.phase = 'failed';
        state.error = String(error?.message || error);
        exposeApi();
        console.error('[Nora MVU] failed to initialize', error);
        throw error;
    }
}
