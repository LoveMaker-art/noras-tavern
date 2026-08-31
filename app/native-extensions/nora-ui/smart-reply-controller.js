import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
export function createSmartReplyController({
    storyActions,
    dialogs,
    selectAll,
    escapeHtml,
    getInput,
    updateComposer,
} = {}) {
    async function open() {
        const result = await storyActions.execute({ type: 'sidecar.suggest-replies' });
        if (result.status !== 'completed') return;
        const suggestions = Array.isArray(result.value) ? result.value.filter(Boolean).slice(0, 3) : [];
        if (suggestions.length !== 3) {
            dialogs.toast(tr("这次没有生成三条可用回复，请重试。"), { tone: 'error' });
            return;
        }
        const items = suggestions.map((suggestion, index) => `<button class="nora-suggestion-item" data-smart-reply="${index}" type="button">${escapeHtml(suggestion)}</button>`).join('');
        const modal = dialogs.open(tr("智能回复"), `<div class="nora-suggestion-list">${items}</div>`, 'nora-smart-reply-modal nora-plain-sheet');
        selectAll('[data-smart-reply]', modal).forEach((button) => button.addEventListener('click', () => {
            const input = getInput();
            input.value = suggestions[Number(button.dataset.smartReply)] || '';
            updateComposer();
            dialogs.close();
            input.focus();
        }));
    }

    return Object.freeze({ open });
}
