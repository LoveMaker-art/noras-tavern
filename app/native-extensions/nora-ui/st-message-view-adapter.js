import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { createPendingMessageView } from './pending-message-view.js';
import { initializeReasoningView } from '../../engine/sillytavern/public/scripts/nora-compat/reasoning-view.js';
import { ledgerAllowsEdit, subscribeLedger } from '../../engine/sillytavern/public/scripts/nora-story-ledger/client.js';

export function createStMessageViewAdapter({ select, selectAll, icons, documentRef = document, MutationObserverImpl = MutationObserver }) {
    let observer = null;
    let latestModels = [];
    let releaseLedger = null;

    const chatRoot = () => select('#chat');
    const messageNodes = () => selectAll('#chat .mes');
    function readMessages() {
        return messageNodes().map(node => {
            const text = select('.mes_text', node)?.textContent || '';
            const reasoning = select('.mes_reasoning', node)?.textContent || '';
            return { key: node, isUser: node.getAttribute('is_user') === 'true', isSystem: node.getAttribute('is_system') === 'true',
                fingerprint: text + '\u0000' + reasoning,
                hasOutput: Boolean(reasoning.trim() || text.trim().replace(/^(?:\.{3}|…|\u200b)$/u, '')) };
        });
    }
    const pendingView = createPendingMessageView({ host: () => select('#nora-chat'), readMessages,
        createElement: tag => documentRef.createElement(tag), documentRef,
    });
    const messageId = message => Number(message.getAttribute('mesid'));
    const messageNode = id => messageNodes().find(message => messageId(message) === Number(id)) || null;

    function isRichMessage(text) {
        return Boolean(text.querySelector('style, iframe, form, button, input, select, textarea, canvas, video, audio, table, [data-nora-rich], [class*="interactive"], [class*="status"]'));
    }

    function swipeLabel(message) {
        return select('.swipes-counter', message)?.textContent?.trim() || '1 / 1';
    }

    function mountRuntime({ chatHost, runtimeHost }) {
        const chat = chatRoot();
        const shell = select('#sheld');
        if (!chat || !shell) throw new Error('Nora UI could not find the ST chat runtime.');
        if (chat.parentElement !== chatHost) chatHost.append(chat);
        if (shell.parentElement !== runtimeHost) runtimeHost.append(shell);
    }

    function decorate(models = []) {
        latestModels = models;
        pendingView.sync();
        const messages = messageNodes();
        const lastMessage = [...messages].reverse().find(message => message.getAttribute('is_system') !== 'true');
        messages.forEach((message) => {
            const text = select('.mes_text', message);
            if (!text) return;
            const reasoningDetails = select('.mes_reasoning_details', message);
            initializeReasoningView(reasoningDetails);
            message.dataset.noraReasoningReady = 'true';
            message.classList.toggle('nora-rich-message', isRichMessage(text));
            let controls = select('.nora-message-controls', message);
            if (!controls) {
                controls = documentRef.createElement('div');
                controls.className = 'nora-message-controls';
                select('.mes_block', message)?.append(controls);
            }
            const model = models[messageId(message)];
            const editing = message.dataset.noraEditing === 'true';
            const isLastAssistant = message === lastMessage && message.getAttribute('is_user') !== 'true';
            const canEdit = message.getAttribute('is_system') !== 'true' && ledgerAllowsEdit(messageId(message));
            const atFirstSwipe = Number(model?.swipe_id || 0) <= 0;
            const markup = editing
                ? `<button data-message-action="save" type="button">${model?.is_user ? tr("保存并生成") : tr("保存")}</button><button data-message-action="cancel" type="button">${tr("取消")}</button>`
                : `${isLastAssistant ? `<span class="nora-swipe"><button data-message-action="left" type="button" aria-label="${tr("上一个回复")}" ${atFirstSwipe ? 'disabled' : ''}>${icons.left}</button><span>${swipeLabel(message)}</span><button data-message-action="right" type="button" aria-label="${tr("下一个回复")}">${icons.right}</button></span>` : ''}${canEdit ? `<button data-message-action="edit" type="button">${icons.edit}<span>${tr("编辑")}</span></button>` : ''}${isLastAssistant ? `<button data-message-action="suggest" type="button">${icons.suggest}<span>${tr("智能回复")}</span></button><button data-message-action="regenerate" type="button">${icons.repeat}<span>${tr("重生成")}</span></button>` : ''}`;
            if (controls.dataset.noraMarkup !== markup) {
                controls.innerHTML = markup;
                controls.dataset.noraMarkup = markup;
            }
        });
    }

    async function handleAction(event, operation) {
        const button = event.target.closest('[data-message-action]');
        if (!button) return false;
        const message = button.closest('.mes');
        if (!message) return false;
        const controls = button.closest('.nora-message-controls');
        button.disabled = true;
        controls?.setAttribute('aria-busy', 'true');
        try {
            await operation({ action: button.dataset.messageAction, id: messageId(message) });
        } finally {
            button.disabled = false;
            controls?.removeAttribute('aria-busy');
        }
        return true;
    }

    function beginEdit(id) {
        if (!ledgerAllowsEdit(Number(id))) return false;
        const message = messageNode(id);
        const nativeEditButton = message && select('.mes_edit', message);
        if (!message || !nativeEditButton) return false;
        nativeEditButton.click();
        if (!select('#curEditTextarea', message)) return false;
        message.dataset.noraEditing = 'true';
        return true;
    }

    function editorValue(id) {
        const message = messageNode(id);
        const editor = message && select('#curEditTextarea', message);
        return editor ? editor.value : null;
    }

    function finishEdit(id) {
        const message = messageNode(id);
        if (!message) return;
        select('.mes_edit_cancel', message)?.click();
        delete message.dataset.noraEditing;
    }

    function observe(onChanged) {
        releaseLedger?.();
        releaseLedger = subscribeLedger(() => decorate(latestModels));
        observer?.disconnect();
        observer = new MutationObserverImpl(() => onChanged());
        const chat = chatRoot();
        if (chat) observer.observe(chat, { childList: true, subtree: true, characterData: true });
        return () => { observer?.disconnect(); releaseLedger?.(); releaseLedger = null; };
    }

    function visibleMessageCount() {
        return messageNodes().filter(message => message.getAttribute('is_system') !== 'true').length + (pendingView.hasPending() ? 1 : 0);
    }

    function ownsEmbeddedSource(source) {
        if (!source) return false;
        return selectAll('#chat .mes_text iframe').some(frame => frame?.contentWindow === source);
    }

    return Object.freeze({
        mountRuntime,
        beginPending: pendingView.begin,
        clearPending: pendingView.clear,
        syncPending: pendingView.sync,
        decorate,
        handleAction,
        beginEdit,
        editorValue,
        finishEdit,
        observe,
        visibleMessageCount,
        ownsEmbeddedSource,
        hasMessages: () => messageNodes().length > 0,
    });
}
