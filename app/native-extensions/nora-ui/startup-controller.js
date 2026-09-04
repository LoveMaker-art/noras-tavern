import { createUiActivationLifecycle } from './activation-lifecycle.js';

export function createStartupController({
    state,
    messageView,
    messageController,
    select,
    selectAll,
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
    onStarted,
    onWorldbookChanged = () => {},
}) {
    let runtimeReady = false;

    async function consumeEarlyIntent() {
        const early = window.__NORA_EARLY__;
        if (!early) return;
        const pendingAction = early.pendingAction;
        early.pendingAction = null;
        selectAll('[aria-busy="true"]', select('#nora-layout')).forEach(node => node.removeAttribute('aria-busy'));
        if (pendingAction?.name === 'world') {
            await openWorldById(pendingAction.worldId, {
                interactionId: `early-world-${Math.round(pendingAction.clickedAt || performance.now())}`,
                showBuffer: true,
            });
        } else if (pendingAction?.name === 'new-world') openNewWorldSheet();
        else if (pendingAction?.name) runPanelAction(pendingAction.name);
        if (!early.pendingSend) return;
        early.pendingSend = false;
        if (select('#nora-input').value.trim()) select('#nora-composer').requestSubmit();
    }

    function wireEvents() {
        state.subscribe({
            stateChanged: () => setTimeout(refresh, 0),
            worldbookChanged: (name, book) => { onWorldbookChanged(name, book); setTimeout(refresh, 0); },
            worldChanged: () => {
                messageController.clearMvuTransaction();
                setTimeout(messageController.syncGenerating, 500);
                setTimeout(updateActiveWorldSummary, 0);
            },
            messageChanged: () => setTimeout(updateActiveWorldSummary, 0),
            generationChanged: () => {
                messageController.syncGenerating();
            },
            mvuTransactionChanged: transaction => messageController.setMvuTransaction(transaction),
        });
    }

    function mountUi() {
        onStarted();
        settings();
        buildLayout();
        bindLayoutEvents();
        messageController.observeMessages();
        wireEvents();
        refresh();
    }

    async function hydrateUi() {
        const startedAt = performance.now();
        readState();
        refresh();
        await loadWorlds();
        messageController.updateComposer();
        await consumeEarlyIntent();
        performanceReporter.phase('nora-ui-hydrated', startedAt, { mode: 'world-list' });
    }

    function reportStartupUsable() {
        const currentState = readState();
        const worldListReady = Boolean(select('#nora-world-list') && select('#nora-new-world'));
        const input = select('#nora-input');
        const composer = select('#nora-composer');
        const activeCharacterId = Number(currentState.activeCharacterId);
        const activeWorld = Number.isInteger(activeCharacterId) && activeCharacterId >= 0 && Boolean(currentState.activeChatId);
        const renderedMessages = Array.isArray(currentState.messages) ? currentState.messages.length : 0;
        const messagesReady = renderedMessages === 0 || messageView.hasMessages();
        const composerEnabled = Boolean(input && composer && !input.disabled && composer.getAttribute('aria-busy') !== 'true');
        if (worldListReady) {
            performanceReporter.usable({
                mode: activeWorld ? 'active-world' : 'world-list',
                worldListReady,
                activeWorld,
                renderedMessages,
                composerEnabled,
                criticalExtensionsReady: document.body.classList.contains('nora-critical-extensions-ready'),
            });
            globalThis.dispatchEvent(new Event('nora:usable'));
        } else {
            performanceReporter.milestone({
                name: 'nora-usable-blocked',
                at: Math.round((performance.now() - (window.__NORA_BOOT_METRICS__?.startedAt || 0)) * 10) / 10,
                worldListReady,
                activeWorld,
                messagesReady,
                composerEnabled,
            });
        }
    }

    function markRuntimeReady() {
        if (runtimeReady) return;
        runtimeReady = true;
        const startedAt = performance.now();
        document.body.classList.add('nora-runtime-ready');
        globalThis.dispatchEvent(new Event('nora:runtime-ready'));
        performanceReporter.phase('nora-runtime-ready', startedAt);
    }

    async function finalizeUi() {
        const startedAt = performance.now();
        finishBootScreen();
        document.body.classList.add('nora-app-ready');
        markRuntimeReady();
        reportStartupUsable();
        globalThis.dispatchEvent(new Event('nora:app-ready'));
        performanceReporter.phase('nora-app-ready', startedAt);
    }

    function start() {
        const activation = createUiActivationLifecycle({
            mount: mountUi,
            hydrate: hydrateUi,
            finalize: finalizeUi,
            onTransition: state => recordBootMilestone({ name: `nora-startup-${state}` }),
        });
        activation.mount().catch(error => {
            console.error('[Nora UI] Failed to mount the application:', error);
            globalThis.__NORA_REPORT_BOOT_METRICS__?.('nora-startup-failed');
        });
        state.whenReady()
            .then(() => activation.finalize())
            .catch(error => {
                console.error('[Nora UI] Failed to complete runtime activation:', error);
                globalThis.__NORA_REPORT_BOOT_METRICS__?.('nora-startup-failed');
            });
    }

    return Object.freeze({ start, mountUi, hydrateUi, finalizeUi, consumeEarlyIntent, wireEvents });
}
