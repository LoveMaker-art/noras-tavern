import {
    applyMvuSettings,
    createManagedMvuRuntimeLoader,
    ensureHeadlessMvuScriptInSettings,
    ensureMvuZodRuntime,
    hasInitializedMvuData,
    initializeHeadlessMvuSettings,
    isMvuVariableModelEnabled,
    NORA_MVU_MODEL_PROXY_URL,
    setMvuVariableModelEnabled,
} from './runtime.js';
import { inspectMvuCompatibility } from 'nora-module/scripts/nora-compat/mvu-compatibility.js';
import { createMvuUpdateObserver } from './update-observer.js';
import { reportMvuDiagnostic } from './diagnostics-reporter.js';

const state = {
    phase: 'idle',
    registration: null,
    error: null,
    updateObserver: null,
};

function formatRuntimeError(error) {
    const name = String(error?.name || 'Error');
    const message = String(error?.message || error);
    const summary = `${name}: ${message}`;
    const stack = String(error?.stack || '');
    return stack.includes(message) ? stack : [summary, stack].filter(Boolean).join('\n');
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
    const updateStatus = state.updateObserver?.status?.() ?? {
        updateOperational: null,
        updatePhase: 'unobserved',
        lastUpdateAt: null,
        lastUpdateCode: null,
        lastUpdateStage: null,
        lastUpdateError: null,
        lastUpdateCommandCount: null,
        lastUpdateValidationErrors: [],
        stateChanged: null,
        transactionDurationMs: null,
        transactionAttempt: null,
        hasPreviousSnapshot: false,
    };
    const initialized = runtimeDataInitialized() || updateStatus.hasPreviousSnapshot;
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
        ...updateStatus,
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
        events: {
            ...runtime.events,
            // These are Nora's pinned MVU transaction event names. Keep the
            // observer independent of a stale runtime API object so a freshly
            // loaded bundle still reports the structured root cause.
            TRANSACTION_STARTED: runtime.events.TRANSACTION_STARTED || 'nora_mvu_transaction_started',
            TRANSACTION_COMMITTED: runtime.events.TRANSACTION_COMMITTED || 'nora_mvu_transaction_committed',
            TRANSACTION_FAILED: runtime.events.TRANSACTION_FAILED || 'nora_mvu_transaction_failed',
        },
        identity: () => String(context().chatId || context().getCurrentChatId?.() || ''),
        report: reportMvuDiagnostic,
    });
}

async function inspectCurrentCard() {
    let snapshot = statusSnapshot();
    const helper = globalThis.TavernHelper;
    let declared = false;
    let compatibility = null;
    try {
        const bookName = helper?.getCurrentCharPrimaryLorebook?.();
        if (bookName && typeof helper?.getLorebookEntries === 'function') {
            const entries = await helper.getLorebookEntries(bookName);
            compatibility = inspectMvuCompatibility({ books: [entries] });
            declared = compatibility.declared;
            if (declared
                && !snapshot.initialized
                && typeof globalThis.Mvu?.ensureCurrentChatInitialized === 'function') {
                await globalThis.Mvu.ensureCurrentChatInitialized();
                snapshot = statusSnapshot();
            }
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
        useIndependentModel({ model, contextLimit = 128000, maxTokens = 20000 }) {
            return applyMvuSettings(context(), {
                '更新方式': '额外模型解析',
                '额外模型解析配置': {
                    '模型来源': '自定义',
                    'api地址': NORA_MVU_MODEL_PROXY_URL,
                    '密钥': '',
                    '模型名称': String(model || '').trim(),
                    '最大上下文token数': Math.min(1000000, Math.max(512, Number(contextLimit) || 128000)),
                    '最大回复token数': Math.min(128000, Math.max(1, Number(maxTokens) || 20000)),
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
        state.error = formatRuntimeError(error);
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
        // Helper copies `z` into every script iframe. Prepare the pinned local
        // Zod runtime before Helper discovers and executes the managed MVU script.
        await ensureMvuZodRuntime();
        state.registration = ensureHeadlessMvuScriptInSettings(runtimeContext);
        exposeApi();
        globalThis.__NORA_ENSURE_MVU_READY__ = ensureNoraMvuReady;
        if (runtimeContext.extensionSettings.nora_mvu?.managedRuntimeEnabled === false) { state.phase = 'disabled'; return; }
        startMvuRuntime();
    } catch (error) {
        state.phase = 'failed';
        state.error = formatRuntimeError(error);
        exposeApi();
        console.error('[Nora MVU] failed to initialize', error);
        throw error;
    }
}
