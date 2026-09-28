import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
export function createWorldCreationController({
    worldRuntime,
    operations,
    select,
    openModal,
    closeModal,
    showToast,
    normalizeError,
    loadWorlds,
    refresh,
    openWorldById = async () => {},
    isGenerating = () => false,
}) {
    // Keep a failed/uncertain intent stable until creation AND activation succeed.
    const libraryIntents = new Map();
    const restartIntents = new Map();

    function openRestartWorldSheet(source) {
        if (isGenerating()) { showToast(tr('请等待当前回复结束，再开启新世界。')); return; }
        if (operations.isBusy('world')) { showToast(tr('世界正在更新，请稍候。')); return; }
        const previous = restartIntents.get(source.id);
        const modal = openModal(tr('重新开局'), `<form class="nora-form" data-restart-form>
            <p class="nora-sheet-intro">${tr('沿用人物、世界设定与预设，从开场重新开始。原世界与故事记录都会保留。')}</p>
            <label>${tr('新世界名称')}<input name="name" required maxlength="80" autocomplete="off"></label>
            <p class="nora-field-help">${tr('不带入聊天记录、剧情进度和已变化的角色状态。')}</p>
            <div class="nora-sheet-actions"><button class="nora-secondary" data-restart-cancel type="button">${tr('取消')}</button><button class="nora-primary" type="submit">${tr('开始新故事')}</button></div>
        </form>`, 'nora-world-modal nora-plain-sheet');
        const form = select('[data-restart-form]', modal);
        const input = form.querySelector('[name="name"]');
        const suffix = ` · ${tr('新篇')}`;
        input.value = previous?.name || `${String(source.name || tr('未命名世界')).slice(0, 80 - suffix.length)}${suffix}`;
        if (previous) input.readOnly = true;
        select('[data-restart-cancel]', modal).addEventListener('click', closeModal);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (isGenerating()) { showToast(tr('请等待当前回复结束，再开启新世界。')); return; }
            if (operations.isBusy('world')) return;
            const name = input.value.trim();
            if (!name) { input.focus(); return; }
            const intent = restartIntents.get(source.id) || { key: 'browser:' + crypto.randomUUID(), name, revision: source.revision, worldId: '' };
            restartIntents.set(source.id, intent);
            input.readOnly = true;
            const submit = form.querySelector('[type="submit"]');
            submit.textContent = tr('正在准备新开局…');
            const completed = await runWorldOperation(async () => {
                if (!intent.worldId) {
                    try {
                        const world = await worldRuntime.restartWorld({ worldId: source.id, name: intent.name,
                            expectedRevision: intent.revision, idempotencyKey: intent.key });
                        intent.worldId = world.id;
                    } catch (error) {
                        if (error.retryable === false || ['NORA_WORLD_REVISION_CONFLICT', 'NORA_WORLD_NOT_FOUND', 'NORA_WORLD_NOT_READY', 'NORA_WORLD_INVALID'].includes(error.code)) {
                            restartIntents.delete(source.id);
                            input.readOnly = false;
                            await loadWorlds({ force: true });
                            source = worldRuntime.list().find(world => world.id === source.id) || source;
                        }
                        throw error;
                    }
                }
                await loadWorlds({ force: true });
                refresh();
            }, { control: submit, errorLabel: tr('新开局暂未完成'), logLabel: 'World restart failed' });
            if (completed) {
                try {
                    const opened = await openWorldById(intent.worldId, { interactionId: 'world-restart-' + Date.now() });
                    if (opened === false) throw new Error(tr('请在世界列表中重新打开，原世界已保存。'));
                    restartIntents.delete(source.id);
                    closeModal();
                } catch (error) {
                    showToast(tr('世界已创建，但打开失败：') + normalizeError(error), { tone: 'error', duration: 4200 });
                }
            }
            submit.disabled = false;
            submit.textContent = intent.worldId ? tr('打开新世界') : tr('重试');
        });
        input.focus();
    }
    async function createFromLibrary(character, control) {
        const avatar = character?.avatar;
        if (!avatar) return;
        if (isGenerating()) { showToast(tr("请等待当前回复结束，再开启新世界。")); return; }
        if (operations.isBusy('world')) { showToast(tr("世界正在更新，请稍候。")); return; }
        const intent = libraryIntents.get(avatar) || { key: 'browser:' + crypto.randomUUID(), worldId: '' };
        libraryIntents.set(avatar, intent);
        const originalLabel = control?.textContent;
        if (control) control.textContent = intent.worldId ? tr("正在打开…") : tr("正在创建…");
        const completed = await runWorldOperation(async () => {
            if (!intent.worldId) {
                const world = await worldRuntime.createFromLibrary({ avatar, idempotencyKey: intent.key });
                intent.worldId = world.id;
            }
            await refreshWorldsAfterCommit(tr("世界已创建"));
        }, { control, errorLabel: tr("世界创建失败"), logLabel: 'Library World creation failed' });
        if (completed) {
            closeModal();
            try {
                const opened = await openWorldById(intent.worldId, { interactionId: 'library-create-' + Date.now() });
                if (opened === false) throw new Error(tr("请在世界列表中重新打开，原世界已保存。"));
                libraryIntents.delete(avatar);
            } catch (error) {
                showToast(tr("世界已创建，但打开失败：") + normalizeError(error), { tone: 'error', duration: 4200 });
            }
        }
        if (control) { control.disabled = false; control.textContent = originalLabel; }
    }

    function openNewWorldSheet() {
        const modal = openModal(tr("开启新世界"), `<p class="nora-sheet-intro">${tr("由 World Core 直接建立空白世界，或导入角色卡并创建完整世界。")}</p><div class="nora-choice-list">
            <button data-world-kind="blank" type="button"><strong>${tr("直接创建")}</strong><span>${tr("建立空白世界，之后补充人物与设定")}</span></button>
            <button data-world-source="local" type="button"><strong>${tr("从本地导入")}</strong><span>${tr("支持 PNG、JSON 和 CHARX 角色卡")}</span></button>
        </div>`, 'nora-world-modal nora-plain-sheet');
        select('[data-world-kind="blank"]', modal).addEventListener('click', openBlankWorldSheet);
        select('[data-world-source="local"]', modal).addEventListener('click', () => {
            closeModal();
            select('#nora-character-import')?.click();
        });
    }

    function openBlankWorldSheet() {
        const modal = openModal(tr("直接创建世界"), `<form id="nora-blank-world-form" class="nora-form nora-blank-world-form">
            <p class="nora-sheet-intro">${tr("World Core 会创建一个独立世界和默认故事会话，不依赖浏览器临时状态。")}</p>
            <label>${tr("世界名称")}<input name="name" required maxlength="80" autocomplete="off" placeholder="${tr("未命名世界")}"></label>
            <div class="nora-sheet-actions"><button class="nora-secondary" data-blank-cancel type="button">${tr("取消")}</button><button class="nora-primary" type="submit">${tr("创建世界")}</button></div>
        </form>`, 'nora-world-modal nora-plain-sheet');
        select('[data-blank-cancel]', modal).addEventListener('click', closeModal);
        select('#nora-blank-world-form', modal).addEventListener('submit', async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const submit = form.querySelector('[type="submit"]');
            const name = String(new FormData(form).get('name') || '').trim();
            let createdWorldId = '';
            const completed = await runWorldOperation(async () => {
                const world = await worldRuntime.createBlank({
                    idempotencyKey: `browser:${crypto.randomUUID()}`,
                    name,
                    persona: { name: '', description: '' },
                });
                createdWorldId = world.id;
                closeModal();
                await refreshWorldsAfterCommit(tr("世界已创建"));
            }, { control: submit, errorLabel: tr("世界创建失败"), logLabel: 'Failed to create a blank World through World Core v2' });
            if (completed && createdWorldId) {
                await openWorldById(createdWorldId, { interactionId: `world-create-${Date.now()}` });
            }
        });
        select('#nora-blank-world-form input[name="name"]', modal)?.focus();
    }

    async function runWorldOperation(operation, { control, errorLabel, logLabel } = {}) {
        if (operations.isBusy('world')) {
            showToast(tr("世界正在更新，请稍候。"));
            return false;
        }
        if (control) control.disabled = true;
        try {
            await operations.run('world', operation);
            return true;
        } catch (error) {
            if (control) control.disabled = false;
            console.error(`[Nora UI] ${logLabel || errorLabel || 'World operation failed'}:`, error);
            showToast(`${errorLabel || tr("世界操作失败")}：${normalizeError(error)}`, { tone: 'error', duration: 4200 });
            return false;
        }
    }

    async function refreshWorldsAfterCommit(label) {
        try {
            await loadWorlds({ force: true });
            refresh();
            return true;
        } catch (error) {
            console.error(`[Nora UI] ${label} but the World list did not refresh:`, error);
            showToast(t`${label}，但页面刷新失败，请重新载入。`, { tone: 'error', duration: 4200 });
            return false;
        }
    }

    async function handleCharacterImport(event) {
        const input = event.currentTarget;
        const files = [...(input.files || [])];
        input.value = '';
        if (!files.length) return;
        if (typeof worldRuntime.importCard !== 'function') throw new Error('World card import is unavailable.');
        let importedWorldId = '';
        const completed = await runWorldOperation(async () => {
            let committed = false;
            try {
                for (const file of files) {
                    const idempotencyKey = `browser:${crypto.randomUUID()}`;
                    const world = await worldRuntime.importCard(file, {
                        idempotencyKey,
                        persona: { name: '', description: '' },
                    });
                    importedWorldId = world.id;
                    committed = true;
                }
            } finally {
                if (committed) await refreshWorldsAfterCommit(tr("角色卡已导入"));
            }
        }, { errorLabel: tr("角色导入失败"), logLabel: 'Failed to import a World through World Core v2' });
        if (completed && importedWorldId) {
            await openWorldById(importedWorldId, { interactionId: `world-import-${Date.now()}` });
        }
    }

    return Object.freeze({
        openNewWorldSheet,
        openRestartWorldSheet,
        openBlankWorldSheet,
        handleCharacterImport,
        createFromLibrary,
        runWorldOperation,
        refreshWorldsAfterCommit,
    });
}
