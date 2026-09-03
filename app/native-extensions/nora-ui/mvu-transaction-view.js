import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';

const PRESENTATION = Object.freeze({
    syncing: Object.freeze({ label: '正在同步MVU变量', symbol: '', duration: 0 }),
    committed: Object.freeze({ label: 'MVU变量已更新', symbol: '✓', duration: 1000 }),
    'no-change': Object.freeze({ label: 'MVU变量无变化', symbol: '–', duration: 1000 }),
    failed: Object.freeze({ label: 'MVU变量更新失败', symbol: '!', duration: 3000 }),
});

/** Transient MVU transaction feedback. It never becomes part of ST chat history. */
export function createMvuTransactionView({
    host,
    createElement,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    let root = null;
    let indicator = null;
    let label = null;
    let dismissTimer = null;

    function ensureView() {
        if (root) return root;
        root = createElement('div');
        root.className = 'nora-mvu-transaction-status';
        root.setAttribute('aria-live', 'polite');
        root.setAttribute('role', 'status');
        indicator = createElement('span');
        indicator.className = 'nora-mvu-transaction-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        label = createElement('span');
        label.className = 'nora-mvu-transaction-label';
        root.append(indicator, label);
        return root;
    }

    function clear() {
        if (dismissTimer) clearTimer(dismissTimer);
        dismissTimer = null;
        root?.remove();
        root = null;
        indicator = null;
        label = null;
    }

    function show(status) {
        const presentation = PRESENTATION[status];
        if (!presentation) return false;
        if (dismissTimer) clearTimer(dismissTimer);
        dismissTimer = null;
        const container = host();
        if (!container) return false;
        const view = ensureView();
        view.className = `nora-mvu-transaction-status is-${status}`;
        view.setAttribute('data-status', status);
        indicator.textContent = presentation.symbol;
        label.textContent = tr(presentation.label);
        if (view.parentElement !== container) container.append(view);
        container.scrollTop = container.scrollHeight;
        if (presentation.duration) dismissTimer = setTimer(clear, presentation.duration);
        return true;
    }

    return Object.freeze({ show, clear, isVisible: () => Boolean(root) });
}
