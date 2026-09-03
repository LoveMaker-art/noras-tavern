import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { createPendingMessageView } from './pending-message-view.js';
import { createMvuTransactionView } from './mvu-transaction-view.js';
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
    const mvuTransactionView = createMvuTransactionView({
        host: () => select('#nora-chat'),
        createElement: tag => documentRef.createElement(tag),
    });
    const messageId = message => Number(message.getAttribute('mesid'));
    const messageNode = id => messageNodes().find(message => messageId(message) === Number(id)) || null;

    function isRichMessage(text) {
        return Boolean(text.querySelector('style, iframe, form, button, input, select, textarea, canvas, video, audio, table, [data-nora-rich], [class*="interactive"], [class*="status"]'));
    }

    function mountRuntime({ chatHost, runtimeHost }) {
        const chat = chatRoot();
        const shell = select('#sheld');
        if (!chat || !shell) throw new Error('Nora UI could not find the ST chat runtime.');
        if (chat.parentElement !== chatHost) chatHost.append(chat);
        if (shell.parentElement !== runtimeHost) runtimeHost.append(shell);
    }

    function embeddedFrameNodes() {
        return [...new Set([
            ...selectAll('#chat .mes_text iframe'),
            ...selectAll('iframe[id^="TH-message--"]'),
        ])];
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
            const swipeCount = Array.isArray(model?.swipes) ? model.swipes.length : 1;
            const hasSwipeChoices = !editing && isLastAssistant && swipeCount > 1;
            let pager = select('.nora-message-pager', message);
            if (hasSwipeChoices && !pager) {
                pager = documentRef.createElement('nav');
                pager.className = 'nora-message-pager';
                select('.mes_block', message)?.insertBefore(pager, text);
            }
            if (pager) {
                pager.hidden = !hasSwipeChoices;
                if (hasSwipeChoices) {
                    const currentSwipe = Math.min(swipeCount, Number(model?.swipe_id || 0) + 1);
                    const pagerMarkup = `<button data-message-action="left" type="button" aria-label="${tr("上一个回复")}" ${atFirstSwipe ? 'disabled' : ''}>${icons.left}<span>${tr("上一页")}</span></button><strong>${currentSwipe} / ${swipeCount}</strong><button data-message-action="right" type="button" aria-label="${tr("下一个回复")}"><span>${tr("下一页")}</span>${icons.right}</button>`;
                    if (pager.dataset.noraMarkup !== pagerMarkup) {
                        pager.innerHTML = pagerMarkup;
                        pager.dataset.noraMarkup = pagerMarkup;
                    }
                    pager.setAttribute('aria-label', tr("回复分页"));
                }
            }
            const markup = editing
                ? `<button data-message-action="save" type="button">${model?.is_user ? tr("保存并生成") : tr("保存")}</button><button data-message-action="cancel" type="button">${tr("取消")}</button>`
                : `${canEdit ? `<button data-message-action="edit" type="button">${icons.edit}<span>${tr("编辑")}</span></button>` : ''}${isLastAssistant ? `<button data-message-action="suggest" type="button">${icons.suggest}<span>${tr("智能回复")}</span></button><button data-message-action="regenerate" type="button">${icons.repeat}<span>${tr("重生成")}</span></button>` : ''}`;
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
        const controls = button.closest('.nora-message-controls, .nora-message-pager');
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
        // A committed Nora branch edit replaces the edited ST message node.
        // Only invoke ST's cancel action while the original editor still owns
        // this node; otherwise it would cancel an editor that no longer exists.
        if (message.dataset.noraEditing === 'true' && select('#curEditTextarea', message)) {
            select('.mes_edit_cancel', message)?.click();
        }
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
        return embeddedFrameNodes().some(frame => frame?.contentWindow === source);
    }

    function ownsEmbeddedEvent(event) {
        if (!event) return false;
        return embeddedFrameNodes().some((frame) => {
            try {
                const EventImpl = frame?.contentWindow?.Event;
                return typeof EventImpl === 'function' && event instanceof EventImpl;
            } catch {
                return false;
            }
        });
    }

    function consumeLegacyInput(event) {
        const input = event?.target;
        if (input?.id !== 'send_textarea' || !ownsEmbeddedEvent(event)) return null;
        const text = String(input.value || '').trim();
        if (!text) return null;
        // A legacy card writes into ST's hidden composer and dispatches an event
        // created by its own frame. Clear it before routing so repeated events
        // cannot submit the same card action twice.
        input.value = '';
        return text;
    }

    return Object.freeze({
        mountRuntime,
        beginPending: pendingView.begin,
        clearPending: pendingView.clear,
        syncPending: pendingView.sync,
        showMvuTransaction: mvuTransactionView.show,
        clearMvuTransaction: mvuTransactionView.clear,
        decorate,
        handleAction,
        beginEdit,
        editorValue,
        finishEdit,
        observe,
        visibleMessageCount,
        ownsEmbeddedSource,
        ownsEmbeddedEvent,
        consumeLegacyInput,
        hasMessages: () => messageNodes().length > 0,
    });
}
