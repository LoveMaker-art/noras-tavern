import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
export function createDialogController({ select, selectAll, escapeHtml, closeIcon }) {
    let toastTimer;
    let dismissHandler;

    function normalizeError(error) {
        if (error?.code === 'NORA_LEDGER_HISTORY_LOCKED') return tr("这段历史已被剧情账本保护，无法编辑。若正在发送，请等发送结束后重试。");
        if (error?.code === 'NORA_LEDGER_EDIT_STALE') return tr("对话已发生变化，请重新加载后再编辑，原记录未被修改。");
        const message = String(error?.message || error || '').trim();
        if (/authorization header required|unauthorized|invalid api key|status 401|status 403/i.test(message)) {
            return tr("模型授权无效，请检查模型密钥。");
        }
        if (/empty response|returned an empty/i.test(message)) {
            return tr("模型没有返回可显示的内容，请重试。");
        }
        if (/status 400|response status 400/i.test(message)) {
            return tr("模型拒绝了这次请求，请检查模型配置。");
        }
        return message || tr("操作没有完成，请重试。");
    }

    function toast(message, { tone = 'neutral', duration = 2600 } = {}) {
        const element = select('#nora-toast');
        if (!element) return;
        clearTimeout(toastTimer);
        element.textContent = String(message || '');
        element.dataset.tone = tone;
        element.hidden = false;
        element.classList.remove('leaving');
        toastTimer = setTimeout(() => {
            element.classList.add('leaving');
            setTimeout(() => {
                element.hidden = true;
                element.classList.remove('leaving');
            }, 180);
        }, duration);
    }

    function clearNotice() {
        const notice = select('#nora-composer-notice');
        if (!notice) return;
        notice.hidden = true;
        notice.innerHTML = '';
        delete notice.dataset.state;
    }

    function notice({ title, message, actions = [], transient = false }) {
        const element = select('#nora-composer-notice');
        if (!element) return;
        element.dataset.state = transient ? 'transient' : 'persistent';
        const closeButton = transient ? '' : `<button class="nora-notice-close" type="button" data-notice-close aria-label="${tr("关闭提示")}" title="${tr("关闭")}">${closeIcon}</button>`;
        const actionButtons = actions.length
            ? `<div class="nora-notice-actions">${actions.map((action, index) => `<button type="button" data-notice-action="${index}">${escapeHtml(action.label)}</button>`).join('')}</div>`
            : '';
        element.innerHTML = `<div class="nora-notice-head"><span class="nora-notice-icon" aria-hidden="true">!</span><strong>${escapeHtml(title)}</strong>${closeButton}</div><p class="nora-notice-message">${escapeHtml(message)}</p>${actionButtons}`;
        element.hidden = false;
        select('[data-notice-close]', element)?.addEventListener('click', clearNotice);
        selectAll('[data-notice-action]', element).forEach((button) => button.addEventListener('click', async () => {
            const action = actions[Number(button.dataset.noticeAction)];
            if (!action) return;
            clearNotice();
            await action.run?.();
        }));
    }

    function outsideClick(event) {
        if (event.target === select('#nora-modal')) close();
    }

    function open(title, content, className = '') {
        const modal = select('#nora-modal');
        dismissHandler = null;
        modal.className = `nora-modal open ${className}`;
        modal.setAttribute('aria-hidden', 'false');
        modal.innerHTML = `<div class="nora-dialog nora-dialog--sheet nora-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><header><div><span class="nora-dialog-kicker"><b aria-hidden="true">✦</b> ${tr("酒馆")}</span><h2>${escapeHtml(title)}</h2></div><button class="nora-icon-button nora-modal-close" type="button" aria-label="${tr("关闭")}">${closeIcon}</button></header><div class="nora-sheet-body">${content}</div></div>`;
        select('.nora-modal-close', modal).addEventListener('click', close);
        modal.onclick = outsideClick;
        return modal;
    }

    function close({ dismissed = true } = {}) {
        const modal = select('#nora-modal');
        if (!modal?.classList.contains('open')) return;
        modal.className = 'nora-modal';
        modal.setAttribute('aria-hidden', 'true');
        modal.innerHTML = '';
        modal.onclick = null;
        const onDismiss = dismissHandler;
        dismissHandler = null;
        if (dismissed) onDismiss?.();
    }

    function confirm({ kicker = tr("酒馆"), title, body, confirmLabel = tr("确认"), cancelLabel = tr("取消"), tone = 'primary', details = [], detailsLabel = tr("查看详情") }) {
        return new Promise((resolve) => {
            const modal = select('#nora-modal');
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                close({ dismissed: false });
                resolve(value);
            };
            const detailMarkup = details.length ? `<details class="nora-dialog-details"><summary>${escapeHtml(detailsLabel)}<span>${details.length}</span></summary><ul>${details.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : '';
            modal.className = 'nora-modal open nora-confirm-modal';
            modal.setAttribute('aria-hidden', 'false');
            modal.innerHTML = `<div class="nora-dialog nora-dialog--confirm ${tone === 'danger' ? 'nora-dialog--danger' : ''}" role="dialog" aria-modal="true" aria-labelledby="nora-confirm-title"><span class="nora-dialog-kicker"><b aria-hidden="true">✦</b> ${escapeHtml(kicker)}</span><h2 id="nora-confirm-title">${escapeHtml(title)}</h2><p class="nora-dialog-copy">${escapeHtml(body)}</p>${detailMarkup}<div class="nora-dialog-actions"><button class="nora-confirm-cancel" type="button">${escapeHtml(cancelLabel)}</button><button class="nora-confirm-submit" type="button">${escapeHtml(confirmLabel)}</button></div></div>`;
            dismissHandler = () => {
                if (!settled) {
                    settled = true;
                    resolve(false);
                }
            };
            select('.nora-confirm-cancel', modal).addEventListener('click', () => finish(false));
            select('.nora-confirm-submit', modal).addEventListener('click', () => finish(true));
            modal.onclick = outsideClick;
            select('.nora-confirm-submit', modal).focus();
        });
    }

    return Object.freeze({ normalizeError, toast, clearNotice, notice, open, close, confirm });
}
