import { addLocaleData, translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';

const preferenceMessages = {
    '偏好设置未能确认，请重新读取。': 'Preference settings could not be confirmed. Read them again.',
    '正在读取偏好设置…': 'Reading preference settings…',
    '适用于所有世界。开启后，按故事进度在后台整理偏好，使用当前酒馆文本模型，发送必要故事片段，可能产生调用费用。关闭后保留已有聊天、偏好和历史档案。': 'Applies to all worlds. When enabled, story progress can trigger background preference reviews using the current Tavern text model. Necessary story excerpts are sent to that service and calls may incur charges. Turning this off preserves chats, preferences and archives.',
    '已开启自动整理故事偏好。': 'Automatic story preference reviews are enabled.',
    '已关闭自动整理，已有档案保留。': 'Automatic reviews are off. Existing archives are preserved.',
    '保存结果未能确认，请重新读取设置后再操作。': 'The save result is unconfirmed. Read settings again before making another change.',
};

function clean(value) {
    return String(value ?? '').trim();
}

/**
 * Build the original Story Profile handoff: open the current Hermes curator
 * chat with a review draft. The draft is deliberately not sent automatically.
 */
export function buildCuratorReviewLink({ agentUserId, worldName } = {}) {
    const userId = clean(agentUserId);
    if (!userId) return '';
    const world = clean(worldName) || '最近一场';
    const query = new URLSearchParams({
        chat: '1',
        draft: `整理「${world}」这场故事`,
    });
    return `clawchat://u/${encodeURIComponent(userId)}?${query.toString()}`;
}

/**
 * Story Profile is a separate lightweight page served by the current Nora
 * process, not a modal backed by browser-local settings.
 */
export function storyProfileHref(returnUrl = '') {
    const query = new URLSearchParams({ from: 'console' });
    const target = clean(returnUrl);
    if (target) query.set('return', target);
    return `/actor?${query.toString()}`;
}

export function createStoryProfileCheckpoint({ activeWorldModel, requestHeaders, fetchImpl = (...args) => fetch(...args) }) {
    return (requestedWorldId = '') => {
        const worldId = String(requestedWorldId || activeWorldModel()?.id || '').trim();
        if (!worldId) return;
        void fetchImpl('/api/nora-story-profile/checkpoint', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ world_id: worldId }),
        }).then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
        }).catch((error) => {
            console.warn('[Nora Story Profile] Background checkpoint failed:', error);
        });
    };
}

/** Global curator preference consent, separate from the read-only archive. */
export function createStoryPreferenceSettings({ dialogs, select, escapeHtml: esc, requestHeaders, fetchImpl = (...args) => fetch(...args) }) {
    addLocaleData('en', preferenceMessages);
    let busy = false;
    async function request(value) {
        const response = await fetchImpl('/api/nora-story-profile/settings', {
            method: value === undefined ? 'GET' : 'POST', headers: requestHeaders(), cache: 'no-store',
            signal: AbortSignal.timeout(15000),
            ...(value === undefined ? {} : { body: JSON.stringify({ auto_enabled: value, consent_version: 'story-profile-auto/v1' }) }),
        });
        const result = await response.json();
        if (!response.ok || typeof result.auto_enabled !== 'boolean') throw new Error(result.error || tr('偏好设置未能确认，请重新读取。'));
        return result.auto_enabled;
    }
    async function open() {
        if (busy) return;
        const modal = dialogs.open(tr('偏好设置'), `<div class="nora-form" data-preference-settings><p class="nora-model-note">${tr('正在读取偏好设置…')}</p></div>`, 'nora-detail-modal nora-plain-sheet nora-preference-settings-modal');
        const version = dialogs.version;
        const current = () => dialogs.version === version && modal.isConnected !== false;
        const body = select('[data-preference-settings]', modal);
        dialogs.setCloseGuard?.(() => !busy);
        async function read() {
            body.innerHTML = `<p class="nora-model-note">${tr('正在读取偏好设置…')}</p>`;
            try {
                const enabled = await request();
                if (!current()) return;
                body.innerHTML = `<p class="nora-model-note">${tr('适用于所有世界。开启后，按故事进度在后台整理偏好，使用当前酒馆文本模型，发送必要故事片段，可能产生调用费用。关闭后保留已有聊天、偏好和历史档案。')}</p><label class="nora-library-check"><input type="checkbox" data-auto-preferences ${enabled ? 'checked' : ''}><span>${tr('自动整理故事偏好')}</span></label><p class="nora-model-note" role="status" aria-live="polite" data-preference-result></p>`;
                const toggle = select('[data-auto-preferences]', body);
                const status = select('[data-preference-result]', body);
                toggle.addEventListener('change', async () => {
                    if (busy || !current()) return;
                    const wanted = toggle.checked;
                    busy = true;
                    toggle.disabled = true;
                    status.textContent = tr('正在保存…');
                    try {
                        const saved = await request(wanted);
                        if (!current()) return;
                        toggle.checked = saved;
                        status.textContent = tr(saved ? '已开启自动整理故事偏好。' : '已关闭自动整理，已有档案保留。');
                        toggle.disabled = false;
                    } catch {
                        if (current()) {
                            status.textContent = tr('保存结果未能确认，请重新读取设置后再操作。');
                            status.insertAdjacentHTML('beforeend', `<button class="nora-secondary" data-preference-retry type="button">${tr('重新读取')}</button>`);
                            select('[data-preference-retry]', status).addEventListener('click', read);
                        }
                    } finally { busy = false; }
                });
            } catch (error) {
                if (!current()) return;
                body.innerHTML = `<p class="nora-model-note" role="alert">${esc(error.message)}</p><button class="nora-secondary" data-preference-retry type="button">${tr('重新读取')}</button>`;
                select('[data-preference-retry]', body).addEventListener('click', read);
            }
        }
        await read();
    }
    return { open };
}
