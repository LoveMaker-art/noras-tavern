import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { createCardCapabilityController } from './card-capability-controller.js';
import { createCardActionGateway } from './card-action-gateway.js';
import { createDialogController } from './dialog-controller.js';
import { createMessageController } from './message-controller.js';
import { createPanelController } from './panel-controller.js';
import { createWorldThemeController } from './world-theme-controller.js';
import { createPerformanceReporter } from './performance-reporter.js';
import { createSmartReplyController } from './smart-reply-controller.js';
import { createShellController } from './shell-controller.js';
import { createStMessageViewAdapter } from './st-message-view-adapter.js';
import { createStartupController } from './startup-controller.js';
import { createStoryActionDispatcher } from './story-action-dispatcher.js';
import { createStoryScroller } from './story-scroller.js';
import { createUiStore } from './ui-store.js';
import { createUiOperationRegistry } from './ui-operation-registry.js';
import { createWorldController } from './world-controller.js';
import { createWorldbookController } from './worldbook-controller.js';
import { createTavernHelperActionAdapter } from '../../engine/sillytavern/public/scripts/nora-adapters/tavern-helper-action-adapter.js';
(() => {
    'use strict';

    if (window.__NORA_UI_BOOTSTRAP_LOADED__) return;
    window.__NORA_UI_BOOTSTRAP_LOADED__ = true;

    const initialBootMetrics = window.__NORA_BOOT_METRICS__;
    initialBootMetrics?.milestones?.push({
        name: 'nora-bootstrap-evaluated',
        at: Math.round((performance.now() - initialBootMetrics.startedAt) * 10) / 10,
    });

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const ICON = {
        menu: '<i class="fa-solid fa-bars"></i>', info: '<i class="fa-solid fa-circle-info"></i>',
        plus: '<i class="fa-solid fa-plus"></i>', close: '<i class="fa-solid fa-xmark"></i>',
        send: '<i class="fa-solid fa-arrow-up"></i>', stop: '<i class="fa-solid fa-stop"></i>',
        edit: '<i class="fa-solid fa-pen"></i>', repeat: '<i class="fa-solid fa-rotate-right"></i>',
        suggest: '<i class="fa-solid fa-wand-magic-sparkles"></i>',
        left: '<i class="fa-solid fa-chevron-left"></i>', right: '<i class="fa-solid fa-chevron-right"></i>',
        trash: '<i class="fa-solid fa-trash-can"></i>',
    };

    let uiStore;
    let operations;
    let storyActions;
    let tavernHelperActions;
    let capabilityController;
    let cardActionGateway;
    let messageController;
    let modelController;
    let panelController;
    let worldThemeController;
    let smartReplyController;
    let storyScroller;
    let characterController;
    let worldController;
    let worldCreationController;
    let worldbookController;
    let ensureCharacterController;
    let ensureModelController;
    let ensureWorldCreationController;
    let mounted = false;
    let started = false;
    let hydrated = false;
    const extensionStartedAt = Date.now();

    const performanceReporter = createPerformanceReporter({
        getMetrics: () => window.__NORA_BOOT_METRICS__,
        reportPhase: phase => window.__NORA_REPORT_BOOT_METRICS__?.(phase),
    });
    const recordBootMilestone = milestone => performanceReporter.milestone(milestone);
    const timedUiStep = (name, operation) => performanceReporter.step(`nora.${name}`, operation);
    const recordActionEvent = (event) => {
        const log = window.__NORA_ACTION_LOG__ ??= [];
        log.push(Object.freeze({ at: Date.now(), ...event }));
        if (log.length > 100) log.splice(0, log.length - 100);
        console.info('[Nora Action]', event);
    };

    function finishBootScreen() {
        if (hydrated) return;
        hydrated = true;
        document.documentElement.dataset.noraReadyMs = String(Date.now() - extensionStartedAt);
        const timing = performanceReporter.hydrateShell({ alreadyVisible: document.body.classList.contains('nora-shell-visible') });
        if (timing) {
            document.documentElement.dataset.noraShellReadyMs = String(timing.shellReadyAt);
            document.documentElement.dataset.noraInteractiveMs = String(timing.hydratedAt);
        }
        document.body.classList.add('nora-ui-ready');
        document.body.classList.remove('nora-booting');
    }

    function escapeHtml(value) {
        const node = document.createElement('span');
        node.textContent = String(value ?? '');
        return node.innerHTML;
    }

    const dialogs = createDialogController({ select: $, selectAll: $$, escapeHtml, closeIcon: ICON.close });
    const messageView = createStMessageViewAdapter({ select: $, selectAll: $$, icons: ICON });
    const shellController = createShellController({ select: $, selectAll: $$, icons: ICON, messageView, exposeMessageApi });
    function readState() {
        if (!uiStore) throw new Error('Nora UI requires the Nora Runtime interface.');
        return uiStore.read().runtime;
    }

    function settings() {
        return uiStore.read().settings;
    }
    function characterField(character, field) {
        return character?.data?.[field] ?? character?.[field] ?? '';
    }

    function currentCharacter() {
        return uiStore.read().currentCharacter;
    }
    const activeWorldModel = () => uiStore.read().activeWorld;

    function currentWorldPersona() {
        return uiStore.read().persona;
    }
    const removeNestedLayoutCopies = () => shellController.removeNestedLayoutCopies();
    const buildLayout = () => shellController.buildLayout();
    function bindLayoutEvents() {
        shellController.bindLayoutEvents({
            openNewWorld: openNewWorldSheet,
            sendMessage: messageController.sendMessage,
            updateComposer: messageController.updateComposer,
            composerKeydown: messageController.composerKeydown,
            importCharacter: handleCharacterImport,
            handleMessageAction: messageController.handleMessageAction,
            selectWorld,
            worldListKeydown,
            closeModal,
        });
    }
    const closeDrawers = () => shellController.closeDrawers();

    const normalizeNoticeMessage = (error) => dialogs.normalizeError(error);
    const showToast = (message, options) => dialogs.toast(message, options);
    const loadWorlds = options => worldController.load(options);
    const updateActiveWorldSummary = () => worldController.updateActiveSummary();
    const renderRail = () => worldController.renderRail();
    const worldListKeydown = event => worldController.listKeydown(event);
    const openWorldById = (worldId, options) => worldController.openById(worldId, options);
    const selectWorld = event => worldController.selectWorld(event);

    const entriesFromBook = (book) => worldbookController.entries(book);
    const worldbookSummary = (character, editing = false) => worldbookController.summary(character, editing);
    const primeActiveWorldbook = (options = {}) => worldbookController.prime(options);
    const openWorldbookEntryDetail = (kind, entryId = '') => worldbookController.openEntryDetail(kind, entryId);
    const openWorldbookSheet = () => worldbookController.open();
    const openWorldbookEntryEditor = (kind, entryId = '') => worldbookController.openEntryEditor(kind, entryId);

    const renderPanel = () => panelController.render();
    const runPanelAction = action => panelController.runAction(action);
    const refreshHeader = () => panelController.refreshHeader();

    function refresh() {
        if (!started) return;
        removeNestedLayoutCopies();
        panelController.applyHostPersonality();
        worldThemeController.render(activeWorldModel());
        renderRail();
        renderPanel();
        refreshHeader();
        messageController.decorateMessages();
    }

    const openModal = (title, content, className = '') => dialogs.open(title, content, className);
    const closeModal = (options) => dialogs.close(options);
    const confirmAction = (options) => dialogs.confirm(options);

    function exposeMessageApi() {
        window.__NORA_MESSAGES__ = Object.freeze({
            toast: (message, options) => showToast(message, options),
            confirm: (options) => confirmAction(options),
            composerError: (error) => messageController.showSendError(error),
        });
        window.__NORA_PREPARE_ST_POPUP__ = (popup) => {
            const dialog = popup?.dlg;
            if (!(dialog instanceof HTMLDialogElement)) return;
            dialog.classList.add('nora-popup-adapted');
            dialog.dataset.noraPopupType = String(popup.type || '');
        };
        const confirmCharacterCapabilities = ({ characterName, reload = false } = {}) => {
            const current = readState();
            const characters = current.characters;
            const character = characters.find((item) => item?.name === characterName)
                || characters[current.activeCharacterId]
                || null;
            return promptCharacterCapabilities(character, { reload, force: true });
        };
        window.__NORA_CONFIRM_CHARACTER_CAPABILITIES__ = confirmCharacterCapabilities;
        window.__NORA_CONFIRM_CHARACTER_REGEX__ = confirmCharacterCapabilities;
    }

    const characterCapabilities = character => capabilityController.capabilities(character);
    const resolveCharacterCapabilities = characterId => capabilityController.resolve(characterId);
    const enableCharacterCapabilities = (character, options) => capabilityController.enable(character, options);
    const promptCharacterCapabilities = (character, options) => capabilityController.prompt(character, options);
    const loadWorldCapabilities = (world, options) => capabilityController.load(world, options);
    const retryWorldCapability = (world, capability) => capabilityController.retry(world, capability);
    const openNewWorldSheet = async () => (await ensureWorldCreationController()).openNewWorldSheet();
    const handleCharacterImport = async event => (await ensureWorldCreationController()).handleCharacterImport(event);
    const runWorldOperation = async (operation, options) => (await ensureWorldCreationController()).runWorldOperation(operation, options);
    const refreshWorldsAfterCommit = async label => (await ensureWorldCreationController()).refreshWorldsAfterCommit(label);

    const openCharacterLibrary = async () => (await ensureCharacterController()).openLibrary();
    const openCharacterSheet = async (characterId, backToLibrary = false) => (await ensureCharacterController()).openSheet(characterId, backToLibrary);
    const openCharacterEditor = async characterId => (await ensureCharacterController()).openEditor(characterId);

    const openModelSheet = async () => (await ensureModelController()).open();

    function mount({ story }) {
        if (mounted) return;
        const { state, messages, cards, worldbook, model, mvu, settings: settingsDomain, transport, worlds } = story || {};
        if (!state || !messages || !cards || !worldbook || !model || !mvu || !settingsDomain || !transport || !worlds) {
            throw new Error('Nora UI mount requires the named story domain interfaces.');
        }
        mounted = true;
        uiStore = createUiStore(state, settingsDomain, worlds);
        worldThemeController = createWorldThemeController(selector => $(selector));
        const notifyStoryProfileCheckpoint = (requestedWorldId = '') => {
            const worldId = String(requestedWorldId || activeWorldModel()?.id || '').trim();
            if (!worldId) return;
            void fetch('/api/nora-story-profile/checkpoint', {
                method: 'POST',
                headers: transport.requestHeaders(),
                body: JSON.stringify({ world_id: worldId }),
            }).then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
            }).catch((error) => {
                console.warn('[Nora Story Profile] Background checkpoint failed:', error);
            });
        };
        operations = createUiOperationRegistry();
        storyActions = createStoryActionDispatcher({
            messages,
            hasWorld: () => Boolean(currentCharacter()),
            getSessionKey: () => JSON.stringify([activeWorldModel()?.id || '', readState().activeChatId || '']),
            onGenerationState: value => messageController?.setGenerating(value || messages.isGenerating()),
            onGenerationError: (error, context = {}) => {
                console.error('[Nora UI] Failed to generate a reply:', error);
                if (context.type === 'story.slash' || context.type === 'sidecar.run') { showToast(t`角色卡操作失败：${normalizeNoticeMessage(error)}`, { tone: 'error', duration: 4200 }); return; }
                if (context.scope === 'sidecar:suggest-replies') showToast(t`智能回复失败：${normalizeNoticeMessage(error)}`, { tone: 'error', duration: 4200 });
                else if (context.scope === 'story') messageController.showSendError(error, context.persisted);
            },
            onGenerationCompleted: notifyStoryProfileCheckpoint,
            onGenerationSettled: metric => {
                if (metric.scope === 'story') performanceReporter.firstGeneration(metric);
            },
            onTaskEvent: recordActionEvent,
            onMissingWorld: () => showToast(tr("请先选择或开启一个世界。")),
            restoreDraft: (text) => {
                const input = $('#nora-input');
                if (!input.value) input.value = text;
                messageController.updateComposer();
            },
        });
        tavernHelperActions = createTavernHelperActionAdapter({ storyActions, messages });
        tavernHelperActions.start();
        messageController = createMessageController({
            messages,
            model,
            operations,
            storyActions,
            dialogs,
            messageView,
            select: $,
            icons: ICON,
            readState,
            currentCharacter,
            getSessionKey: () => activeWorldModel()?.id || '',
            getSmartReplyController: () => smartReplyController,
            openModelSheet,
            recordBootMilestone,
        });
        cardActionGateway = createCardActionGateway({ storyActions,
            isEmbeddedSource: source => messageView.ownsEmbeddedSource(source),
            consumeLegacyInput: event => messageView.consumeLegacyInput(event),
            onUnsupported: ({ error }) => {
                console.warn('[Nora Card Action] Unsupported action:', error);
                showToast(error.message, { tone: 'error', duration: 4200 });
            },
            onError: error => {
                console.error('[Nora Card Action] Action failed:', error);
                showToast(t`角色卡操作失败：${normalizeNoticeMessage(error)}`, { tone: 'error', duration: 4200 });
            },
            onAction: recordActionEvent,
        });
        cardActionGateway.start();
        capabilityController = createCardCapabilityController({
            cards,
            worldRuntime: worlds,
            confirmAction,
            showToast,
            onWorldCapabilitiesChanged: () => refresh(),
        });
        storyScroller = createStoryScroller({ getContainer: () => $('#nora-chat') });
        smartReplyController = createSmartReplyController({
            storyActions,
            dialogs,
            selectAll: $$,
            escapeHtml,
            getInput: () => $('#nora-input'),
            updateComposer: messageController.updateComposer,
        });
        worldbookController = createWorldbookController({
            worldbook,
            operations,
            store: uiStore,
            dialogs,
            readState,
            currentCharacter,
            characterField,
            select: $,
            selectAll: $$,
            escapeHtml,
            icons: ICON,
            onChanged: renderPanel,
            reloadWorlds: () => loadWorlds({ force: true }),
        });
        let characterControllerPromise;
        ensureCharacterController = () => {
            if (characterController) return Promise.resolve(characterController);
            characterControllerPromise ??= import('./character-controller.js').then(({ createCharacterController }) => {
                characterController = createCharacterController({
                    cards,
                    operations,
                    dialogs,
                    readState,
                    settings,
                    characterField,
                    characterCapabilities,
                    resolveCharacter: resolveCharacterCapabilities,
                    enableCharacterCapabilities,
                    worldbookEntries: entriesFromBook,
                    select: $,
                    selectAll: $$,
                    escapeHtml,
                    icons: ICON,
                    reloadWorlds: () => loadWorlds({ force: true }),
                    refresh,
                    isCharacterInWorld: character => worlds.usesRuntimeCard?.(character) || false,
                    createWorldFromCard: async (character, control) => (await ensureWorldCreationController()).createFromLibrary(character, control),
                    activeWorldModel,
                    updateWorld: (...args) => worlds.updateActive(...args),
                });
                return characterController;
            });
            return characterControllerPromise;
        };

        let modelControllerPromise;
        ensureModelController = () => {
            if (modelController) return Promise.resolve(modelController);
            modelControllerPromise ??= Promise.all([
                import('./model-controller.js'),
                import('./mvu-model-adapter.js'),
            ]).then(([{ createModelController }, { createMvuModelAdapter }]) => {
                modelController = createModelController({
                    model,
                    settingsDomain,
                    operations,
                    readState,
                    activeWorldModel,
                    settings,
                    dialogs,
                    select: $,
                    selectAll: $$,
                    escapeHtml,
                    icons: ICON,
                    mvu: createMvuModelAdapter({
                        controlApi: mvu,
                        requestHeaders: transport.requestHeaders,
                    }),
                    onChanged: renderPanel,
                });
                return modelController;
            });
            return modelControllerPromise;
        };

        let worldCreationControllerPromise;
        ensureWorldCreationController = () => {
            if (worldCreationController) return Promise.resolve(worldCreationController);
            worldCreationControllerPromise ??= import('./world-creation-controller.js').then(({ createWorldCreationController }) => {
                worldCreationController = createWorldCreationController({
                    worldRuntime: worlds,
                    operations,
                    select: $,
                    openModal,
                    closeModal,
                    showToast,
                    normalizeError: normalizeNoticeMessage,
                    loadWorlds,
                    refresh,
                    openWorldById: (worldId, options) => worldController.openById(worldId, options),
                    isGenerating: () => messageController.isGenerating(),
                });
                return worldCreationController;
            });
            return worldCreationControllerPromise;
        };
        worldController = createWorldController({
            settingsDomain,
            worldRuntime: worlds,
            store: uiStore,
            operations,
            storyScroller,
            select: $,
            selectAll: $$,
            escapeHtml,
            icons: ICON,
            readState,
            activeWorldModel,
            showToast,
            confirmAction,
            normalizeError: normalizeNoticeMessage,
            timedUiStep,
            recordBootMilestone,
            performanceReporter,
            primeActiveWorldbook,
            loadWorldCapabilities,
            closeDrawers,
            refresh,
            refreshWorldsAfterCommit,
            updateComposer: messageController.updateComposer,
            isGenerating: messageController.isGenerating,
            onWorldLeaving: notifyStoryProfileCheckpoint,
        });
        panelController = createPanelController({
            settingsDomain,
            worldRuntime: worlds,
            dialogs,
            select: $,
            selectAll: $$,
            escapeHtml,
            icons: ICON,
            readState,
            settings,
            characterField,
            currentCharacter,
            activeWorldModel,
            currentWorldPersona,
            worldbookSummary,
            openWorldbookEntryDetail,
            openWorldbookEntryEditor,
            openWorldbookSheet,
            openCharacterLibrary,
            openCharacterSheet,
            openCharacterEditor,
            openModelSheet,
            closeDrawers,
            runWorldOperation,
            refreshWorldsAfterCommit,
            retryWorldCapability,
            agentUserId: () => String(window.__NORA_AGENT_USER_ID__ || ''),
            currentUrl: () => window.location.href,
        });
        recordBootMilestone({
            name: 'nora-context-ready',
            at: Math.round((performance.now() - (window.__NORA_BOOT_METRICS__?.startedAt || 0)) * 10) / 10,
        });
        const startupController = createStartupController({
            state,
            messageView,
            messageController,
            select: $,
            selectAll: $$,
            readState,
            settings,
            buildLayout,
            bindLayoutEvents,
            refresh,
            loadWorlds,
            openWorldById,
            openNewWorldSheet,
            runPanelAction,
            updateActiveWorldSummary,
            finishBootScreen,
            recordBootMilestone,
            performanceReporter,
            onStarted: () => { started = true; },
            onWorldbookChanged: (name, book) => uiStore.cacheWorldbook(name, book),
        });
        startupController.start();
    }

    const prepareShell = () => shellController.prepareShell();

    window.NoraUI = Object.freeze({ prepareShell, mount, controlActions: () => storyActions, themeState: () => worldThemeController?.inspect() || { ready: false } });
})();
