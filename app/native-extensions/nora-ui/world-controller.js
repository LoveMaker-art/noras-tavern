import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
export function createWorldController({
    settingsDomain,
    worldRuntime,
    store,
    operations,
    storyScroller,
    select,
    selectAll,
    escapeHtml,
    icons,
    readState,
    activeWorldModel,
    showToast,
    confirmAction,
    normalizeError,
    timedUiStep,
    recordBootMilestone,
    performanceReporter,
    primeActiveWorldbook,
    loadWorldCapabilities = async () => null,
    closeDrawers,
    refresh,
    onWorldLeaving = () => {},
}) {
    let loadPromise;
    let queuedSelection;
    let selectionPromise;
    let selectionRevision = 0;
    let unsubscribeWorldRuntime = null;

    function models() {
        return store.read().worldModels;
    }

    async function load() {
        const startedAt = performance.now();
        if (!unsubscribeWorldRuntime && typeof worldRuntime.subscribe === 'function') {
            unsubscribeWorldRuntime = worldRuntime.subscribe(() => {
                if (!select('#nora-world-list')) return;
                renderRail();
                refresh();
            });
        }
        if (loadPromise) return loadPromise;
        loadPromise = (async () => {
            try {
                await timedUiStep('worlds.authoritative-list', () => worldRuntime.refresh());
                renderRail();
                recordBootMilestone({
                    name: 'nora-worlds-loaded',
                    source: 'world-core-v2',
                    duration: Math.round((performance.now() - startedAt) * 10) / 10,
                });
            } catch (error) {
                console.warn('[Nora UI] Failed to load worlds:', error);
            }
        })();

        try {
            return await loadPromise;
        } finally {
            loadPromise = null;
        }
    }

    function updateActiveSummary() {
        renderRail();
    }

    function renderRail() {
        readState();
        const worlds = models();
        const list = select('#nora-world-list');
        if (!list) return;
        const operation = store.read().worldStatus?.operation;
        const operationLabel = operation?.kind === 'IMPORT' ? tr("正在导入角色卡…") : tr("正在恢复世界导入…");
        const operationHtml = operation?.status === 'RUNNING'
            ? `<div class="nora-world-progress" role="status"><span class="nora-progress-dot" aria-hidden="true"></span><span>${operationLabel}</span></div>`
            : operation?.status === 'FAILED'
                ? `<div class="nora-world-progress is-error" role="alert"><span>${tr("上次导入未完成")}</span>${operation.error?.retryable ? `<button data-retry-world-import type="button">${tr("重试")}</button>` : ''}</div>`
                : '';
        const worldsHtml = worlds.length ? worlds.map((world) => {
            const name = world.name || tr("未命名世界");
            const repair = !world.available
                ? `<button class="nora-world-repair" data-repair-world="${escapeHtml(world.id)}" type="button">${tr("重新检查")}</button>`
                : '';
            const remove = `<button class="nora-delete-button nora-world-delete" data-delete-world="${escapeHtml(world.id)}" type="button" aria-label="${t`删除世界 ${escapeHtml(name)}`}" title="${tr("删除世界")}">${icons?.trash || '×'}</button>`;
            return `<div class="nora-world ${world.active ? 'active' : ''}${world.available === false ? ' needs-repair' : ''}" data-world="${escapeHtml(world.id)}" role="button" tabindex="0" aria-label="${t`打开世界 ${escapeHtml(name)}`}"><div class="nora-world-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(world.meta)}</small></div><div class="nora-world-actions">${repair}${remove}</div></div>`;
        }).join('') : `<div class="nora-rail-empty"><span>✦</span><p>${tr("还没有世界")}</p><small>${tr("导入角色卡开始第一场故事")}</small></div>`;
        list.innerHTML = operationHtml + worldsHtml;
    }

    function listKeydown(event) {
        if (event.target.closest('[data-delete-world], [data-repair-world], [data-retry-world-import]')) return;
        const world = event.target.closest('.nora-world[data-world]');
        if (!world || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        world.click();
    }

    function rememberLastWorld(worldId) {
        if (!worldId) return;
        const settings = settingsDomain.uiSettings();
        if (settings.lastWorldId === worldId) return;
        settings.lastWorldId = worldId;
        settingsDomain.saveUiSettings();
    }

    async function loadSupportingContent(world, interactionId) {
        await timedUiStep(`world-select.${interactionId}.worldbook`, () => primeActiveWorldbook());
        const result = await timedUiStep(
            `world-select.${interactionId}.capabilities`,
            () => loadWorldCapabilities(world.id),
        );
        refresh();
        return result;
    }

    function scheduleSupportingContent(world, interactionId) {
        void loadSupportingContent(world, interactionId).catch((error) => {
            console.error('[Nora UI] World supporting content was degraded after base activation:', error);
            showToast(t`世界已打开，但附加内容载入失败：${normalizeError(error)}`, { tone: 'error', duration: 4200 });
        });
    }

    async function queueSelection(nextSelection) {
        if (!selectionPromise && operations.isBusy('world')) {
            nextSelection.failed = new Error(tr("另一个世界操作尚未完成。"));
            showToast(tr("世界正在更新，请稍候。"));
            return;
        }
        nextSelection.revision = ++selectionRevision;
        queuedSelection = nextSelection;
        if (selectionPromise) {
            const showBuffer = nextSelection.showBuffer !== false;
            document.body.classList.toggle('nora-world-opening', showBuffer);
            select('#nora-world-buffer-title').textContent = nextSelection.name || tr("正在进入世界");
            select('#nora-world-buffer')?.setAttribute('aria-hidden', String(!showBuffer));
            return selectionPromise;
        }

        selectionPromise = operations.run('world', async () => {
            const list = select('#nora-world-list');
            const stopFollowingLatest = storyScroller.followLatest();
            const leavingWorldId = String(activeWorldModel()?.id || '').trim();
            let leavingCheckpointSent = false;
            list?.setAttribute('aria-busy', 'true');
            try {
                while (queuedSelection) {
                    const current = queuedSelection;
                    queuedSelection = null;
                    const isSuperseded = () => current.revision !== selectionRevision;
                    const showBuffer = current.showBuffer !== false;
                    document.body.classList.toggle('nora-world-opening', showBuffer);
                    if (showBuffer) {
                        select('#nora-world-buffer-title').textContent = current.name || tr("正在进入世界");
                        select('#nora-world-buffer')?.setAttribute('aria-hidden', 'false');
                    } else {
                        select('#nora-world-buffer')?.setAttribute('aria-hidden', 'true');
                    }
                    const startedAt = performance.now();
                    try {
                        await timedUiStep(`world-select.${current.interactionId}.lifecycle.open`, () => worldRuntime.activate(current.id));
                        if (isSuperseded()) continue;
                        rememberLastWorld(current.id);
                        if (isSuperseded()) continue;
                        if (!leavingCheckpointSent && leavingWorldId && leavingWorldId !== current.id) {
                            leavingCheckpointSent = true;
                            try {
                                void Promise.resolve(onWorldLeaving(leavingWorldId)).catch(() => {});
                            } catch {
                                // Preference reflection must never change World activation.
                            }
                        }
                    } catch (error) {
                        current.failed = error;
                        console.error('[Nora UI] Failed to open world:', error);
                        showToast(t`世界打开失败：${normalizeError(error)}`, { tone: 'error', duration: 4200 });
                        recordBootMilestone({ name: 'world-selection-failed', interactionId: current.interactionId, duration: Math.round((performance.now() - startedAt) * 10) / 10 });
                        window.__NORA_REPORT_BOOT_METRICS__?.('world-selection-failed');
                        continue;
                    }
                    try {
                        closeDrawers();
                        refresh();
                        await storyScroller.toLatest();
                        scheduleSupportingContent(current, current.interactionId);
                    } catch (error) {
                        current.degraded = error;
                        console.error('[Nora UI] World opened with incomplete supporting content:', error);
                        showToast(t`世界已打开，但附加内容载入失败：${normalizeError(error)}`, { tone: 'error', duration: 4200 });
                    }
                    performanceReporter.timedMilestone(current.degraded ? 'world-selected-degraded' : 'world-selected', startedAt, { interactionId: current.interactionId });
                    window.__NORA_REPORT_BOOT_METRICS__?.('world-selected');
                }
            } finally {
                void stopFollowingLatest();
                document.body.classList.remove('nora-world-opening');
                select('#nora-world-buffer')?.setAttribute('aria-hidden', 'true');
                list?.removeAttribute('aria-busy');
            }
        });

        try {
            return await selectionPromise;
        } finally {
            selectionPromise = null;
        }
    }

    async function openInitial() {
        const worlds = models();
        if (!worlds.length) return;
        const lastWorldId = settingsDomain.uiSettings().lastWorldId;
        const lastWorld = worlds.find(world => world.id === lastWorldId);
        const activeWorld = worlds.find(world => world.active);
        const initialWorld = lastWorld || activeWorld || worlds[0];
        if (initialWorld.active) {
            if (!lastWorld) rememberLastWorld(initialWorld.id);
            await timedUiStep('world-select.initial-world.lifecycle.ready', () => worldRuntime.ensureReady(initialWorld.id));
            scheduleSupportingContent(initialWorld, 'initial-world');
            return;
        }
        const selection = { ...initialWorld, interactionId: 'initial-world', showBuffer: false };
        await queueSelection(selection);
        if (selection.failed) throw selection.failed;
    }

    async function selectWorld(event) {
        const retryImport = event.target instanceof Element ? event.target.closest('[data-retry-world-import]') : null;
        if (retryImport) {
            retryImport.disabled = true;
            try {
                await worldRuntime.retryPendingCreation();
                await load({ force: true });
                showToast(tr("世界创建已恢复。"));
            } catch (error) {
                showToast(t`世界创建重试失败：${normalizeError(error)}`, { tone: 'error', duration: 4200 });
            }
            return;
        }
        const repairButton = event.target instanceof Element ? event.target.closest('[data-repair-world]') : null;
        if (repairButton) {
            repairButton.disabled = true;
            try {
                await worldRuntime.repair(repairButton.dataset.repairWorld);
                renderRail();
                showToast(tr("世界资源已重新检查。"));
            } catch (error) {
                showToast(t`世界仍需修复：${normalizeError(error)}`, { tone: 'error', duration: 4200 });
                repairButton.disabled = false;
            }
            return;
        }
        const deleteButton = event.target instanceof Element ? event.target.closest('[data-delete-world]') : null;
        if (deleteButton) {
            event.preventDefault();
            event.stopPropagation();
            return deleteWorld(deleteButton.dataset.deleteWorld);
        }
        const button = event.target instanceof Element ? event.target.closest('.nora-world[data-world]') : null;
        if (!button) return;
        selectAll('.nora-world', select('#nora-world-list')).forEach(item => item.classList.toggle('active', item === button));
        const interactionId = `world-${Date.now()}`;
        const world = models().find(item => item.id === button.dataset.world);
        if (!world) return;
        if (world.available === false) {
            showToast(tr("这个世界仍需修复，请先点击“重新检查”查看结果。"), { tone: 'error', duration: 4200 });
            renderRail();
            return;
        }
        const selection = { ...world, interactionId };
        await queueSelection(selection);
        if (selection.failed) renderRail();
    }

    async function openById(worldId, { interactionId = `world-${Date.now()}`, showBuffer = true } = {}) {
        const world = models().find(item => item.id === worldId);
        if (!world) throw new Error('The requested World is absent from the authoritative list.');
        const selection = { ...world, interactionId, showBuffer };
        await queueSelection(selection);
        if (selection.failed) throw selection.failed;
        return models().find(item => item.id === worldId) || world;
    }

    async function deleteWorld(worldId) {
        const target = models().find(item => item.id === worldId);
        if (!target) return;
        const accepted = await confirmAction({
            title: t`删除“${target.name || tr("未命名世界")}”？`,
            body: tr("将删除这个世界及其专属会话和资源；共享世界书与外部资源会保留。此操作无法撤销。"),
            confirmLabel: tr("删除世界"),
            cancelLabel: tr("取消"),
            tone: 'danger',
        });
        if (!accepted) return;
        if (operations.isBusy('world-delete')) {
            showToast(tr("世界正在删除，请稍候。"));
            return;
        }
        try {
            await operations.run('world-delete', async () => {
                await worldRuntime.remove(worldId);
                if (target.active) onWorldLeaving({ reason: 'world-delete', worldId });
                await load({ force: true });
                refresh();
                showToast(tr("世界已删除。"));
            });
        } catch (error) {
            showToast(t`世界删除失败：${normalizeError(error)}`, { tone: 'error', duration: 4200 });
        }
    }

    return Object.freeze({
        models,
        load,
        updateActiveSummary,
        renderRail,
        listKeydown,
        rememberLastWorld,
        queueSelection,
        openById,
        deleteWorld,
        openInitial,
        selectWorld,
    });
}
