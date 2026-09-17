import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
export function createMessageController({
    messages,
    model,
    operations,
    storyActions,
    dialogs,
    messageView,
    select,
    icons,
    readState,
    currentCharacter,
    getSmartReplyController,
    openModelSheet,
    recordBootMilestone,
    getSessionKey = () => readState().activeChatId || '',
}) {
    let generating = false;
    let mvuSyncing = false;
    let mvuSession = '';
    const normalizeError = error => dialogs.normalizeError(error);
    const showToast = (message, options) => dialogs.toast(message, options);
    const isModelConfigurationError = error => error?.code === 'NORA_MODEL_CONFIGURATION_REQUIRED'
        || /模型(?:密钥缺失|尚未配置|配置缺失)|model.*(?:not configured|configuration required|api key.*missing)/i.test(String(error?.message || error || ''));

    function composerKeydown(event) {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            select('#nora-composer').requestSubmit();
        }
    }

    function updateComposer() {
        const input = select('#nora-input');
        input.style.height = '0px';
        input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
        input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden';
        const button = select('#nora-send');
        const empty = !input.value.trim();
        button.classList.toggle('empty', (empty || mvuSyncing) && !generating);
        button.classList.toggle('stop', generating);
        button.disabled = !generating && (empty || !currentCharacter() || mvuSyncing);
        button.innerHTML = generating ? icons.stop : icons.send;
        button.setAttribute('aria-label', generating ? tr("停止生成") : mvuSyncing ? tr("正在同步MVU变量") : tr("发送"));
    }

    async function retryGeneration() {
        const failure = storyActions.status('story');
        if (!failure.retryable) {
            dialogs.clearNotice();
            showToast(tr("原操作已结束或世界已切换，请在当前世界重新操作。"));
            return { status: 'blocked', reason: 'stale-retry' };
        }
        const input = select('#nora-input');
        if (failure.retryable && !failure.persisted && !failure.saveFailed) {
            input.value = '';
            updateComposer();
        }
        dialogs.notice({
            title: failure.saveFailed ? tr("正在重试保存") : tr("正在重试"),
            message: failure.saveFailed ? tr("只重试聊天保存，不会重新生成正文。") : tr("正在重新连接并发送…"),
            transient: true,
        });
        const result = await storyActions.execute({ type: 'story.retry' });
        if (result?.status === 'completed') dialogs.clearNotice();
        updateComposer();
        return result;
    }

    function restoreDraft(text) {
        const input = select('#nora-input');
        if (!input.value) input.value = text;
        updateComposer();
    }

    function handleGenerationError(error, context = {}) {
        console.error('[Nora UI] Failed to generate a reply:', error);
        if (context.type === 'story.slash' || context.type === 'sidecar.run') {
            showToast(t`角色卡操作失败：${normalizeError(error)}`, { tone: 'error', duration: 4200 });
            return;
        }
        if (context.scope === 'sidecar:suggest-replies') {
            showToast(t`智能回复失败：${normalizeError(error)}`, { tone: 'error', duration: 4200 });
        } else if (context.scope === 'story') showSendError(error, context.persisted);
    }

    function showSendError(error, persisted = Boolean(error?.noraMessagePersisted)) {
        if (error?.phase === 'save') {
            const conflict = error?.status === 409 || error?.code === 'integrity';
            dialogs.notice({
                title: conflict ? tr("聊天保存冲突") : tr("聊天保存未完成"),
                message: conflict
                    ? tr("服务器拒绝了本次覆盖保存。页面内容未主动清除；请先备份未保存内容，再重新加载核对。")
                    : normalizeError(error),
                actions: typeof error.retrySave === 'function'
                    ? [{ label: tr("重试保存"), run: retryGeneration }]
                    : [],
            });
            return;
        }
        if (isModelConfigurationError(error)) {
            dialogs.notice({
                title: tr("尚未配置文本模型"),
                message: tr("请先完成模型配置后再发送。"),
                actions: [
                    { label: tr("配置模型"), run: openModelSheet },
                ],
            });
            return;
        }
        dialogs.notice({
            title: persisted ? tr("回复生成失败") : tr("消息未发送"),
            message: normalizeError(error),
            actions: [
                { label: tr("重试"), run: retryGeneration },
                { label: tr("模型设置"), run: openModelSheet },
            ],
        });
    }

    async function sendMessage(event) {
        event.preventDefault();
        const input = select('#nora-input');
        const text = input.value.trim();
        recordBootMilestone({
            name: 'send-ui-submit',
            at: Math.round((performance.now() - (window.__NORA_BOOT_METRICS__?.startedAt || 0)) * 10) / 10,
            generating,
            textLength: text.length,
        });
        if (generating || storyActions.status('story').active) {
            await storyActions.cancel('visible');
            updateComposer();
            return;
        }
        if (mvuSyncing) {
            showToast(tr("正在同步MVU变量，请稍候。"));
            return;
        }
        if (!text) return;
        if (!currentCharacter()) {
            showToast(tr("请先选择或开启一个世界。"));
            return;
        }
        try {
            model.assertModelConfigured();
        } catch (error) {
            showSendError(error, false);
            return;
        }
        dialogs.clearNotice();
        input.value = '';
        updateComposer();
        const pending = messageView.beginPending?.(text, getSessionKey());
        try {
            await storyActions.execute({ type: 'story.send', text });
        } finally {
            messageView.clearPending?.(pending);
        }
        updateComposer();
    }

    function decorateMessages() {
        messageView.syncPending?.(getSessionKey());
        messageView.decorate(readState().messages);
        updateEmptyState();
    }

    async function handleMessageAction(event) {
        try {
            await messageView.handleAction(event, async ({ action, id }) => {
                if (storyActions.status('story').active || operations.isBusy('message')) {
                    showToast(tr("当前消息正在处理中，请稍候。"));
                    return;
                }
                if (action === 'regenerate') await storyActions.execute({ type: 'story.regenerate' });
                else if (action === 'suggest') await getSmartReplyController().open();
                else if (action === 'save') await saveMessageEdit(id);
                else {
                    await operations.run('message', async () => {
                        if (action === 'edit') return startMessageEdit(id);
                        if (action === 'cancel') return cancelMessageEdit(id);
                        if (action === 'left' || action === 'right') {
                            const result = await storyActions.execute({ type: 'story.swipe', id, direction: action });
                            if (result.status === 'completed' && !result.value) showToast(tr("没有更多可切换的回复。"));
                        }
                    });
                }
            });
            setTimeout(decorateMessages, 0);
        } catch (error) {
            console.error('[Nora UI] Message action failed:', error);
            showToast(t`消息操作失败：${normalizeError(error)}`, { tone: 'error', duration: 4200 });
        }
    }

    function startMessageEdit(id) {
        const model = readState().messages?.[id];
        if (!model || !messageView.beginEdit(id, model.mes)) return;
        decorateMessages();
    }

    async function saveMessageEdit(id) {
        const model = readState().messages?.[id];
        const value = messageView.editorValue(id);
        if (!model || value === null) return;
        if (model.is_user) {
            const result = await storyActions.execute({ type: 'story.edit-and-regenerate', id, text: value });
            if (result.status !== 'completed') return;
        } else {
            const result = await storyActions.execute({ type: 'story.edit', id, text: value });
            if (result.status !== 'completed') return;
        }
        messageView.finishEdit(id);
        setTimeout(decorateMessages, 0);
    }

    function cancelMessageEdit(id) {
        if (!readState().messages?.[id]) return;
        messageView.finishEdit(id);
        messages.restoreMessage(id);
        setTimeout(decorateMessages, 0);
    }

    function observeMessages() {
        messageView.observe(() => setTimeout(decorateMessages, 0));
        decorateMessages();
    }

    function updateEmptyState() {
        const hasWorld = Boolean(currentCharacter());
        const empty = select('#nora-empty');
        document.body.classList.toggle('nora-no-world', !hasWorld);
        if (!empty) return;
        empty.classList.toggle('hidden', hasWorld && messageView.visibleMessageCount() > 0);
        const title = empty.querySelector('p');
        const detail = empty.querySelector('small');
        if (hasWorld && title && detail) {
            title.textContent = tr("故事尚未开始");
            detail.textContent = tr("发送第一条消息，让这一场正式开始。");
        } else if (title && detail) {
            title.textContent = tr("选一个世界，故事会从这里开始。");
            detail.textContent = tr("也可以导入角色卡开启新世界");
        }
    }

    function setGenerating(value) {
        if (value && !generating && !mvuSyncing) messageView.beginPending?.('', getSessionKey());
        if (!value) messageView.clearPending?.();
        generating = value;
        updateComposer();
        document.body.classList.toggle('nora-generating', value);
        updateEmptyState();
    }

    function syncGenerating() {
        setGenerating(Boolean(storyActions.status('visible').active || messages.isGenerating?.()));
    }

    function setMvuTransaction(transaction = {}) {
        if (transaction.status === 'syncing') {
            mvuSyncing = true;
            mvuSession = getSessionKey();
            messageView.clearPending?.();
            messageView.showMvuTransaction?.('syncing');
        } else if (mvuSyncing && mvuSession === getSessionKey()) {
            mvuSyncing = false;
            if (['cancelled', 'stale', 'skipped', 'partial'].includes(transaction.status)) {
                messageView.clearMvuTransaction?.();
            } else {
                messageView.showMvuTransaction?.(transaction.status);
            }
        }
        updateComposer();
    }

    function clearMvuTransaction() {
        mvuSyncing = false;
        mvuSession = '';
        messageView.clearMvuTransaction?.();
        updateComposer();
    }

    return Object.freeze({
        composerKeydown,
        updateComposer,
        showSendError,
        handleGenerationError,
        restoreDraft,
        sendMessage,
        decorateMessages,
        handleMessageAction,
        observeMessages,
        updateEmptyState,
        setGenerating,
        syncGenerating,
        setMvuTransaction,
        clearMvuTransaction,
        isGenerating: () => generating,
        isMvuSyncing: () => mvuSyncing,
    });
}
