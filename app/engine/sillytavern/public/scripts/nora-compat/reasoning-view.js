import { translate } from '../nora-i18n/core.js';

/** Native reasoning presentation shared by preflight feedback and the stream renderer.
 * No chat rows, model text, timing or generation state are synthesized here.
 */
export const WAITING_REASONING_TITLE = translate('正在思考…');

export function initializeReasoningView(details) {
    if (!details || details.dataset.noraReasoningInitialized === 'true') return;
    details.open = false;
    details.dataset.noraReasoningInitialized = 'true';
}

export function createWaitingReasoningView(documentRef = document) {
    const template = documentRef.querySelector('#message_template .mes_reasoning_details');
    if (!template) return null;
    const details = template.cloneNode(true);
    initializeReasoningView(details);
    details.dataset.state = 'pending';
    details.hidden = false;
    details.querySelector('.mes_reasoning').textContent = '';
    const title = details.querySelector('.mes_reasoning_header_title');
    title.textContent = WAITING_REASONING_TITLE;
    title.setAttribute('role', 'status');
    title.setAttribute('aria-live', 'polite');
    return details;
}

/** Called only by a live stream, before the handler caches native DOM references. */
export function adoptWaitingReasoningView(message, documentRef = document) {
    const waiting = documentRef.querySelector('#nora-chat .nora-pending-message > .mes_reasoning_details');
    const current = message.querySelector('.mes_reasoning_details');
    if (!waiting || !current) return;
    const summary = waiting.querySelector('summary');
    const focused = documentRef.activeElement === summary;
    current.replaceWith(waiting);
    message.dataset.noraReasoningReady = 'true';
    if (focused) summary.focus();
}

export function cancelWaitingReasoningView(details) {
    if (details?.dataset.state !== 'pending') return;
    details.dataset.state = 'none';
    details.hidden = true;
}
