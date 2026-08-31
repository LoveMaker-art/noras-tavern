import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
const CARD_COMPLETION_REQUEST = 'request_chat_completion';
const CARD_STOP_REQUEST = 'request_chat_stop';

function unsupportedAction(type) {
    const error = new Error(t`当前角色卡动作尚不受支持：${String(type || 'unknown')}`);
    error.code = 'NORA_UNSUPPORTED_CARD_ACTION';
    return error;
}

function isCardActionType(value) {
    const type = String(value || '');
    if (type === 'slash-command') return true;
    return /^(?:request_(?:chat|slash|variable|worldbook)_|nora\.card\.)/.test(type);
}

export function createCardActionGateway({
    storyActions,
    isEmbeddedSource,
    onUnsupported = () => {},
    onError = () => {},
    onAction = () => {},
    windowRef = globalThis.window,
} = {}) {
    if (!storyActions?.execute || !storyActions?.cancel) {
        throw new Error('Card action gateway requires the story action dispatcher.');
    }
    if (typeof isEmbeddedSource !== 'function') {
        throw new Error('Card action gateway requires an embedded-source authorizer.');
    }

    let listening = false;

    async function handle(event = {}) {
        if (!isEmbeddedSource(event.source)) return Object.freeze({ status: 'ignored', reason: 'untrusted-source' });
        const request = event.data;
        if (!request || typeof request !== 'object') return Object.freeze({ status: 'ignored', reason: 'empty-action' });
        if (!isCardActionType(request.type)) return Object.freeze({ status: 'ignored', reason: 'unrelated-message' });

        let result;
        if (request.type === 'slash-command') {
            const text = String(request.content || '').trim();
            if (!text) throw new Error(tr("角色卡命令为空。"));
            result = await storyActions.execute({ type: 'story.slash', text, origin: 'card.post-message', actionId: request.requestId });
        } else if (request.type === CARD_COMPLETION_REQUEST) {
            const text = String(request.user_input || '').trim();
            if (!text) return Object.freeze({ status: 'ignored', reason: 'empty-text' });
            result = await storyActions.execute({ type: 'story.send', text, origin: 'card.post-message' });
        } else if (request.type === CARD_STOP_REQUEST) {
            result = await storyActions.cancel('story');
        } else {
            const error = unsupportedAction(request.type);
            result = Object.freeze({ status: 'failed', type: String(request.type || ''), error });
            try { onUnsupported(result); } catch { /* Diagnostics never change routing. */ }
        }
        if (result?.error && request.type !== CARD_STOP_REQUEST) {
            try { onError(result.error); } catch { /* Diagnostics cannot change routing. */ }
        }
        if (request.requestId && isEmbeddedSource(event.source)) {
            event.source.postMessage({ type: 'nora.card.result', requestId: request.requestId,
                status: result.status, error: result.error ? { code: result.error.code || 'NORA_ACTION_FAILED', message: result.error.message } : null,
            }, event.origin && event.origin !== 'null' ? event.origin : '*');
        }
        try { onAction(Object.freeze({ origin: 'card.post-message', requestType: request.type, result })); } catch { /* Diagnostics never change routing. */ }
        return result;
    }

    const listener = event => handle(event).catch((error) => {
        try { onError(error); } catch { /* UI error reporting is best effort. */ }
        return Object.freeze({ status: 'failed', error });
    });

    function start() {
        if (listening) return;
        if (!windowRef?.addEventListener) throw new Error('Card action gateway requires a window event target.');
        windowRef.addEventListener('message', listener);
        listening = true;
    }

    function stop() {
        if (!listening) return;
        windowRef.removeEventListener('message', listener);
        listening = false;
    }

    return Object.freeze({ handle, start, stop });
}
