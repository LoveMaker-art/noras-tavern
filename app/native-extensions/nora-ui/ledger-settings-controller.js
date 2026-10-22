import { addLocaleData, translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { ledgerPhase } from '../../engine/sillytavern/public/scripts/nora-controls/plugin-catalog.js';

const errors = {
    NORA_LEDGER_COMPRESSION_TIMEOUT: '整理超时', NORA_LEDGER_CONTEXT_BUDGET_EXCEEDED: '上下文容量不足',
    NORA_LEDGER_CAPACITY_REQUIRED: '缺少模型上下文配置', NORA_LEDGER_OUTPUT_LIMIT: '整理结果超过输出上限',
    NORA_LEDGER_OUTPUT_INVALID: '模型未返回有效的剧情记忆', NORA_LEDGER_CONFIGURATION_STALE: '设置已发生变化，请保留修改后重新打开',
    NORA_LEDGER_MODEL_SCOPE_UNAVAILABLE: '请先打开目标世界', NORA_LEDGER_COMPRESSION_FAILED: '整理失败',
    NORA_LEDGER_MODEL_CHANGED: '整理期间模型发生变化，请确认配置后重试',
    NORA_LEDGER_OUTPUT_CONFIGURATION_REQUIRED: '缺少模型输出额度配置',
    NORA_LEDGER_MEMORY_BUDGET_EXCEEDED: '整理结果超过存储上限，旧记忆已保留',
    NORA_LEDGER_SCHEMA_LIMIT_EXCEEDED: '整理结果超出字段限制，旧记忆已保留',
    NORA_LEDGER_MODEL_OPTIONS_INVALID: '模型的自定义连接参数格式无效',
};

// Settings-only copy stays with this interaction instead of the startup catalog.
const ledgerMessages = {
    '当前会话自动整理': 'Automatic compression for this session',
    '记忆覆盖': 'Memory coverage', '模型配置容量': 'Configured model capacity',
    '已整理，待续写采用': 'Prepared; awaiting continuation', '已用于续写': 'Used for continuation',
    '上下文上限（tokens）': 'Context limit (tokens)', '整理输出上限（tokens）': 'Compression output limit (tokens)',
    '总超时（秒）': 'Total timeout (seconds)', '重置剧情记忆': 'Reset story memory',
    '记忆已重置，请刷新页面': 'Memory reset. Reload the page.',
    '整理超时': 'Compression timed out', '上下文容量不足': 'Insufficient context capacity',
    '缺少模型上下文配置': 'Model context capacity is missing', '整理结果超过输出上限': 'Compression output limit exceeded',
    '模型未返回有效的剧情记忆': 'Model did not return valid story memory', '整理失败': 'Compression failed',
    '设置已发生变化，请保留修改后重新打开': 'Settings changed. Preserve your draft and reopen.',
    '请先打开目标世界': 'Open the target world first',
    '整理期间模型发生变化，请确认配置后重试': 'Model changed during compression. Review configuration and retry.',
};

export function createLedgerSettingsController({ dialogs, select, escapeHtml: esc, request, isGenerating = () => false }) {
    addLocaleData('en', ledgerMessages);
    return { async open(scope, { name, isCurrent, back }) {
        let busy = false, state, formRevision, baseline, draft;
        const modal = dialogs.open(tr('剧情账本'), `<div class="nora-extension-manager"><p class="nora-extension-world">${esc(name || '')} · ${tr('当前会话')}</p><div data-ledger-content>${tr('加载中')}</div></div>`, 'nora-detail-modal nora-plain-sheet nora-extensions-modal', {
            back: () => { if (draft) void draft.leave(back); else if (!busy && isCurrent()) back(); },
        });
        const slot = select('[data-ledger-content]', modal);
        const alive = () => isCurrent() && slot.isConnected !== false;
        dialogs.setCloseGuard(() => !busy);
        const errorText = error => tr(errors[error?.code] || error?.message || error?.code || '操作没有完成');
        try {
            state = await request('inspect', scope);
            if (!alive()) return;
            if (typeof state?.enabled !== 'boolean' || !state.effectiveConfig) throw new Error(tr('状态读取失败'));
            slot.innerHTML = `<section class="nora-ledger-settings">
                <label class="nora-ledger-enabled"><span>${tr('自动整理')}<small>${tr('当前会话')}</small></span><input data-ledger-toggle type="checkbox" aria-label="${tr('当前会话自动整理')}"></label>
                <dl class="nora-ledger-metrics"><div><dt>${tr('运行状态')}</dt><dd data-ledger-status role="status"></dd></div><div><dt>${tr('记忆覆盖')}</dt><dd data-ledger-metric></dd></div><div><dt>${tr('当前模型')}</dt><dd data-ledger-model></dd></div><div><dt>${tr('模型配置容量')}</dt><dd data-ledger-capacity></dd></div></dl>
                <p data-ledger-error role="alert" hidden></p>
                <button class="nora-secondary" data-ledger-compress type="button" hidden>${tr('重新整理')}</button>
                <form class="nora-ledger-form" data-ledger-form><details class="nora-ledger-options"><summary>${tr('高级设置')}</summary><div class="nora-ledger-fields">
                <label for="nora-ledger-context">${tr('上下文上限（tokens）')}</label><input id="nora-ledger-context" name="context" data-ledger-context type="number" min="512" max="2000000">
                <label for="nora-ledger-output">${tr('整理输出上限（tokens）')}</label><input id="nora-ledger-output" name="output" data-ledger-output type="number" min="128" max="16384"><small data-ledger-output-source></small>
                <label for="nora-ledger-timeout">${tr('总超时（秒）')}</label><input id="nora-ledger-timeout" name="timeout" data-ledger-timeout type="number" required min="60" max="1800">
                <footer class="nora-ledger-save"><span data-ledger-draft role="status"></span><button class="nora-primary" data-ledger-save type="button">${tr('保存设置')}</button></footer></div></details></form>
                <section class="nora-ledger-reset"><button class="nora-secondary" data-ledger-reset type="button"><i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i> ${tr('重置剧情记忆')}</button></section>
                </section>`;
            const form = select('[data-ledger-form]', modal);
            const toggle = select('[data-ledger-toggle]', modal);
            const fields = ['context', 'output', 'timeout'].map(key => select(`[data-ledger-${key}]`, modal));
            const values = () => fields.map(field => field.value);
            const dirty = () => JSON.stringify(values()) !== baseline;
            const controls = () => {
                fields.forEach(field => { field.disabled = busy; });
                select('[data-ledger-save]', modal).disabled = busy || isGenerating() || !dirty();
                toggle.disabled = busy || !state.enabled && isGenerating();
                select('[data-ledger-reset]', modal).disabled = busy || isGenerating();
                select('[data-ledger-compress]', modal).disabled = busy || isGenerating();
                select('[data-ledger-draft]', modal).textContent = dirty() ? tr('未保存') : '';
            };
            const remember = () => {
                baseline = JSON.stringify(values()); formRevision = state.configRevision;
                draft = dialogs.protectForm(form, { isBusy: () => busy });
            };
            const fill = () => {
                fields[0].value = state.effectiveConfig.contextLimitOverride ?? '';
                fields[1].value = state.effectiveConfig.outputTokenLimit ?? '';
                fields[2].value = state.effectiveConfig.timeoutSeconds;
                remember();
            };
            const renderState = () => {
                toggle.checked = state.enabled;
                select('[data-ledger-status]', modal).textContent = tr(ledgerPhase(state));
                const summary = state.pending || state.active;
                const stage = state.pending ? tr('已整理，待续写采用') : state.active ? tr('已用于续写') : '';
                select('[data-ledger-metric]', modal).textContent = `${summary?.coveredTurns || 0} / ${state.totalTurns ?? '?'} ${tr('轮')}${stage ? ` · ${stage}` : ''}`;
                select('[data-ledger-model]', modal).textContent = state.model?.name || tr('未配置');
                select('[data-ledger-capacity]', modal).textContent = state.model?.contextLimit ? `${state.model.contextLimit} tokens` : tr('未配置');
                fields[0].placeholder = state.model?.contextLimit ? t`继承模型配置：${state.model.contextLimit}` : tr('继承模型配置');
                fields[1].placeholder = state.model?.outputTokenLimit ? t`继承模型配置：${state.model.outputTokenLimit}` : tr('继承模型配置');
                const output = state.outputBudget?.limit ?? state.effectiveConfig.outputTokenLimit ?? state.model?.outputTokenLimit;
                select('[data-ledger-output-source]', modal).textContent = state.effectiveConfig.outputTokenLimit === null
                    ? `${tr('继承模型配置')}${output ? ` · ${output} tokens` : ''}` : `${tr('当前会话')} · ${output} tokens`;
                const error = select('[data-ledger-error]', modal);
                error.hidden = !state.lastError;
                error.textContent = state.lastError ? errorText(state.lastError) : '';
                select('[data-ledger-compress]', modal).hidden = !state.lastError || !state.enabled;
                controls();
            };
            fill(); renderState();
            form.addEventListener('input', controls);
            const save = async event => {
                event.preventDefault();
                if (!alive() || busy || isGenerating() || !dirty()) return;
                if (!form.reportValidity()) return;
                busy = true; controls();
                try {
                    const patch = { expectedRevision: formRevision,
                        contextLimitOverride: fields[0].value === '' ? null : Number(fields[0].value),
                        outputTokenLimit: fields[1].value === '' ? null : Number(fields[1].value), timeoutSeconds: Number(fields[2].value) };
                    await request('configure', scope, patch);
                    const fresh = await request('inspect', scope);
                    if (!alive()) return;
                    if (['contextLimitOverride', 'outputTokenLimit', 'timeoutSeconds'].some(key => fresh.effectiveConfig?.[key] !== patch[key])) {
                        throw { code: 'NORA_LEDGER_CONFIGURATION_STALE' };
                    }
                    state = fresh; fill(); renderState();
                    dialogs.toast(tr('设置已保存'));
                } catch (error) { if (alive()) dialogs.toast(errorText(error), { tone: 'error' }); }
                finally { busy = false; if (alive()) controls(); }
            };
            form.addEventListener('submit', save);
            select('[data-ledger-save]', modal).addEventListener('click', save);
            toggle.addEventListener('change', async () => {
                const enabled = toggle.checked;
                toggle.checked = state.enabled;
                if (!alive() || busy || enabled && isGenerating()) return;
                busy = true; controls();
                try {
                    const approved = await dialogs.confirm({ title: tr(enabled ? '开启自动整理？' : '关闭自动整理？'),
                        body: tr(enabled ? '当前会话将自动调用模型整理历史，可能产生费用。' : '取消当前会话的后台整理，保留已应用的记忆、聊天和变量。'), restoreSheet: true });
                    if (!approved || !alive() || enabled && isGenerating()) return;
                    const fresh = await request('configure', scope, { enabled, expectedRevision: formRevision });
                    if (!alive()) return;
                    state = { ...fresh, model: state.model }; formRevision = state.configRevision; renderState();
                } catch (error) { if (alive()) dialogs.toast(errorText(error), { tone: 'error' }); }
                finally { busy = false; if (alive()) controls(); }
            });
            for (const action of ['compress', 'reset']) select(`[data-ledger-${action}]`, modal).addEventListener('click', async () => {
                if (!alive() || busy || isGenerating()) return;
                if (!await draft.check() || !alive() || busy || isGenerating()) return;
                busy = true; controls();
                try {
                    const reset = action === 'reset';
                    const approved = await dialogs.confirm({ title: tr(reset ? '重置剧情记忆？' : '重新整理？'), tone: reset ? 'danger' : 'primary',
                        body: tr(reset ? '先备份，再清除当前会话的剧情记忆并关闭自动整理。聊天和变量保留。原始历史可能超过模型容量，完成后需要刷新。' : '将调用当前模型重新整理，可能产生费用。'), restoreSheet: true });
                    if (!approved || !alive() || isGenerating()) return;
                    const fresh = await request('inspect', scope);
                    if (!alive() || isGenerating()) return;
                    await request(action, scope, reset ? { confirm: true, expectedRevision: fresh.configRevision, expectedSignature: fresh.expectedSignature } : {});
                    if (alive()) {
                        state = await request('inspect', scope);
                        if (!alive()) return;
                        fill(); renderState();
                        if (reset) dialogs.toast(tr('记忆已重置，请刷新页面'));
                    }
                } catch (error) { if (alive()) dialogs.toast(errorText(error), { tone: 'error' }); }
                finally { busy = false; if (alive()) controls(); }
            });
            const poll = async () => {
                if (!alive()) {
                    if (isCurrent() && modal.classList?.contains('nora-confirm-modal')) setTimeout(poll, 5000);
                    return;
                }
                if (!busy) try {
                    const fresh = await request('inspect', scope);
                    if (alive() && !busy && fresh.configRevision >= state.configRevision) {
                        const keepDraft = dirty();
                        state = fresh;
                        if (!keepDraft) fill();
                        renderState();
                    }
                } catch { if (alive()) select('[data-ledger-status]', modal).textContent = tr('状态读取失败'); }
                if (alive()) setTimeout(poll, 5000);
            };
            if (typeof window !== 'undefined') setTimeout(poll, 5000);
        } catch (error) {
            if (!alive()) return;
            slot.innerHTML = `<p role="alert">${esc(errorText(error))}</p><button class="nora-secondary" data-ledger-retry type="button">${tr('重试')}</button>`;
            select('[data-ledger-retry]', modal).addEventListener('click', () => { if (alive()) void this.open(scope, { name, isCurrent, back }); });
        }
    } };
}
