import { createWaitingReasoningView, cancelWaitingReasoningView } from '../../engine/sillytavern/public/scripts/nora-compat/reasoning-view.js';

/** Transient presentation only: never a ST message, persisted chat or extension input. */
export function createPendingMessageView({ host, readMessages, createElement, documentRef = document }) {
    let pending = null;
    function clear(token) {
        if (!pending || (token && token !== pending.token)) return;
        cancelWaitingReasoningView(pending.reasoning);
        pending.root.remove();
        host()?.classList.remove('nora-has-pending');
        pending = null;
    }
    function begin(text = '', session = '') {
        if (pending) return pending.token;
        const container = host();
        if (!container) return null;
        const root = createElement('div');
        root.className = 'nora-pending-message';
        let user = null;
        if (text) {
            user = createElement('div');
            user.className = 'nora-pending-user';
            user.textContent = text;
            root.append(user);
        }
        const reasoning = createWaitingReasoningView(documentRef);
        if (reasoning) root.append(reasoning);
        const initialMessages = readMessages();
        const baseline = new Map(initialMessages.map(message => [message.key, message.fingerprint]));
        const anchorMessage = text ? initialMessages.at(-1)
            : initialMessages.findLast(message => message.isUser) || initialMessages.at(-1);
        const anchor = anchorMessage?.key;
        pending = { token: {}, root, user, reasoning, baseline, session, anchor, sending: Boolean(text),
            fingerprints: new Set(initialMessages.map(message => message.isUser + ':' + message.fingerprint)) };
        container.classList.add('nora-has-pending');
        container.append(root);
        container.scrollTop = container.scrollHeight;
        return pending.token;
    }
    function sync(session) {
        if (!pending) return;
        if (session !== undefined && session !== pending.session) { clear(); return; }
        const messages = readMessages();
        const boundary = pending.anchor ? messages.findIndex(message => message.key === pending.anchor) : -1;
        // History hydration prepends older messages. Only the new tail can own this send.
        const candidates = boundary >= 0 ? messages.slice(boundary + (pending.sending ? 1 : 0))
            : messages.filter(message => !pending.fingerprints.has(message.isUser + ':' + message.fingerprint));
        const changed = candidates.filter(message => !pending.baseline.has(message.key) || pending.baseline.get(message.key) !== message.fingerprint);
        if (changed.some(message => message.isUser)) {
            pending.user?.remove();
            pending.user = null;
        }
        const output = changed.find(message => !message.isUser && !message.isSystem && message.hasOutput);
        // A streaming handler moves the very same native details element into its message.
        // Non-streaming output has no preflight content left to show.
        if (output && pending.reasoning?.parentElement === pending.root) pending.reasoning.remove();
        if (!pending.user && pending.reasoning?.parentElement !== pending.root) {
            host()?.classList.remove('nora-has-pending');
            pending.root.hidden = true;
        }

    }
    return Object.freeze({ begin, sync, clear, hasPending: () => Boolean(pending) });
}
