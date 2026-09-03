import { createStCardAdapter } from './st-card-adapter.js';
import { createStMessageAdapter } from './st-message-adapter.js';
import { createStModelAdapter } from './st-model-adapter.js';
import { createStMvuSettingsAdapter } from './st-mvu-settings-adapter.js';
import { createStSettingsAdapter } from './st-settings-adapter.js';
import { createStWorldbookAdapter } from './st-worldbook-adapter.js';

function requireRuntime(getContext) {
    const runtime = getContext();
    const required = [
        'sendText',
        'stopGeneration',
        'regenerate',
        'commitMessageEdit',
        'deleteLastMessage',
        'saveChat',
        'generateRaw',
        'configureCustomChatCompletion',
        'clearCustomChatCompletion',
        'hasCustomChatCompletionApiKey',
        'getRequestHeaders',
        'activateExtensionNames',
        'getActiveExtensionNames',
    ];
    const missing = required.filter((name) => typeof runtime?.[name] !== 'function');
    if (missing.length) throw new Error(`故事运行核心缺少以下能力：${missing.join(', ')}`);
    return runtime;
}

function reportSendStage(name, details = {}) {
    const metrics = globalThis.__NORA_BOOT_METRICS__;
    if (metrics) {
        metrics.milestones ??= [];
        metrics.milestones.push({
            name,
            at: Math.round((performance.now() - metrics.startedAt) * 10) / 10,
            ...details,
        });
    }
    globalThis.__NORA_REPORT_BOOT_METRICS__?.(name);
}

function normalizeCharacterId(value) {
    if (value === null || value === undefined || value === '') return null;
    const id = Number(value);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

const MVU_TRANSACTION_EVENTS = Object.freeze({
    started: 'nora_mvu_transaction_started',
    committed: 'nora_mvu_transaction_committed',
    failed: 'nora_mvu_transaction_failed',
});

export function createStRuntimeAdapter(getContext, { whenAppReady = null } = {}) {
    const runtime = () => requireRuntime(getContext);

    function snapshot() {
        const current = runtime();
        return Object.freeze({
            characters: current.characters || [],
            activeCharacterId: normalizeCharacterId(current.characterId),
            messages: current.chat || [],
            activeChatId: String(current.chatId || '').replace(/\.jsonl$/i, ''),
            user: Object.freeze({
                name: String(current.name1 || '').trim(),
                description: String(current.powerUserSettings?.persona_description || '').trim(),
            }),
            world: Object.freeze({ metadata: current.chatMetadata || {} }),
            model: Object.freeze({ ...(current.chatCompletionSettings || {}) }),
        });
    }

    function subscribe(handlers = {}) {
        const current = runtime();
        const source = current.eventSource;
        const events = current.eventTypes;
        const bindings = [];
        const on = (event, handler) => {
            if (!event || typeof handler !== 'function') return;
            source.on(event, handler);
            bindings.push([event, handler]);
        };
        const refreshEvents = [
            events.CHAT_CHANGED,
            events.CHAT_LOADED,
            events.CHARACTER_EDITED,
            events.CHARACTER_DELETED,
            events.CHARACTER_RENAMED,
            events.MESSAGE_RECEIVED,
            events.MESSAGE_EDITED,
            events.MESSAGE_DELETED,
            events.MESSAGE_SWIPED,
            events.PERSONA_CHANGED,
            events.SETTINGS_UPDATED,
        ];
        refreshEvents.forEach((event) => on(event, handlers.stateChanged));
        on(events.WORLDINFO_UPDATED, (name, book) => handlers.worldbookChanged?.(name, book));
        [events.CHAT_CHANGED, events.CHAT_LOADED].forEach((event) => on(event, handlers.worldChanged));
        [events.MESSAGE_RECEIVED, events.MESSAGE_EDITED, events.MESSAGE_DELETED].forEach((event) => on(event, handlers.messageChanged));
        on(events.GENERATION_STARTED, () => handlers.generationChanged?.(true));
        on(events.GENERATION_ENDED, () => handlers.generationChanged?.(false));
        on(events.GENERATION_STOPPED, () => handlers.generationChanged?.(false));
        on(MVU_TRANSACTION_EVENTS.started, detail => handlers.mvuTransactionChanged?.({ ...detail, status: 'syncing' }));
        on(MVU_TRANSACTION_EVENTS.committed, detail => handlers.mvuTransactionChanged?.({ ...detail, status: 'committed' }));
        on(MVU_TRANSACTION_EVENTS.failed, detail => handlers.mvuTransactionChanged?.({ ...detail, status: 'failed' }));
        return () => bindings.forEach(([event, handler]) => source.off?.(event, handler));
    }

    const settings = createStSettingsAdapter(runtime);
    const model = createStModelAdapter(runtime, { reportStage: reportSendStage });
    const mvuSettings = createStMvuSettingsAdapter(runtime);
    const messages = createStMessageAdapter(runtime, {
        ensureBackendReady: model.ensureReady,
        reportStage: reportSendStage,
    });
    const cards = createStCardAdapter(runtime, { saveUiSettings: settings.saveUiSettings });
    const worldbooks = createStWorldbookAdapter(runtime);

    return Object.freeze({
        snapshot,
        requestHeaders: () => runtime().getRequestHeaders(),
        ...settings,
        ...worldbooks,
        ...cards,
        ...messages,
        ...model.actions,
        ...mvuSettings,
        subscribe,
        whenReady: async () => {
            if (typeof whenAppReady === 'function') await whenAppReady();
            return snapshot();
        },
    });
}
