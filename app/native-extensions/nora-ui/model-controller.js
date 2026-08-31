import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { HERMES_MODEL_ID, projectTextModelChoices, projectTextModelDisplay } from './model-display.js';
import { createModelProfiles } from '../../engine/sillytavern/public/scripts/nora-adapters/model-profiles.js';
export { planModelRemoval } from '../../engine/sillytavern/public/scripts/nora-adapters/model-profiles.js';

function clamp(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? number : fallback));
}

export function renderMvuModelSection(status, escapeHtml, config = {}) {
    if (!status?.supported) return '';
    const enabled = status.enabled !== false;
    const stateLabel = !enabled
        ? tr("已关闭")
        : status.phase === 'failed'
        ? tr("运行异常")
        : status.initialized ? tr("已启用") : status.runtimeReady ? tr("运行时已加载") : tr("正在加载");
    // This is an MVU protocol value, not a translated display label.
    const followsStory = status.variableModel !== '自定义';
    const modelLabel = followsStory
        ? tr("跟随文本模型")
        : config.model || status.variableModelName || tr("尚未配置");
    const stateTone = status.phase === 'failed' ? 'error' : enabled && status.initialized ? 'ready' : 'pending';
    return `<section class="nora-model-group nora-mvu-model-group"><div class="nora-model-group-head"><span>${tr("MVU 变量模型")}</span><label class="nora-mvu-toggle"><input data-mvu-enabled type="checkbox" ${enabled ? 'checked' : ''}><span aria-hidden="true"></span><b>${stateLabel}</b></label></div><div class="nora-mode-switch nora-mvu-source"><button class="${followsStory ? 'active' : ''}" data-mvu-source="story" type="button">${tr("跟随文本模型")}</button><button class="${followsStory ? '' : 'active'}" data-mvu-source="independent" type="button">${tr("独立模型")}</button></div><div class="nora-mvu-model-summary"><span class="nora-mvu-status is-${stateTone}">${stateLabel}</span><strong>${escapeHtml(modelLabel)}</strong><button data-mvu-config type="button">${tr("配置")}</button></div></section>`;
}

export function createModelController({ model, settingsDomain, operations, readState, activeWorldModel, settings, dialogs, select, selectAll, escapeHtml, icons, mvu, onChanged }) {
    const profileActions = createModelProfiles({ model, settings, persist: () => settingsDomain.saveUiSettings({ immediate: true }) });
    const profiles = () => settings().modelProfiles || [];
    const activeWorldCapabilities = () => activeWorldModel()?.capabilities || null;
    const hermesProfile = () => {
        const hermes = settings().hermesModel;
        if (!hermes?.base || !hermes?.model || !hermes?.secretId) return null;
        return {
            id: HERMES_MODEL_ID,
            name: hermes.provider,
            base: hermes.base,
            model: hermes.model,
            context: hermes.context,
            tokens: hermes.tokens,
            secretId: hermes.secretId,
        };
    };

    async function refreshMvuSection(modal) {
        const slot = select('[data-mvu-model-slot]', modal);
        if (!slot) return;
        const status = await mvu?.inspect?.(activeWorldCapabilities());
        if (!slot.isConnected) return;
        let config = {};
        if (status?.supported) {
            try {
                config = await mvu.config();
            } catch (error) {
                console.warn('[Nora UI] Unable to read MVU model configuration', error);
            }
        }
        if (!slot.isConnected) return;
        slot.innerHTML = renderMvuModelSection(status, escapeHtml, config);
        bindMvuControls(modal, status, config);
    }

    async function runMvu(operation, modal) {
        if (operations.isBusy('mvu-model')) {
            dialogs.toast(tr("MVU 模型设置正在更新，请稍候。"));
            return;
        }
        try {
            await operations.run('mvu-model', operation);
            await refreshMvuSection(modal);
        } catch (error) {
            dialogs.toast(t`MVU 模型设置失败：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
        }
    }

    function bindMvuControls(modal, status, config) {
        const enabled = select('[data-mvu-enabled]', modal);
        enabled?.addEventListener('change', () => runMvu(() => mvu.setEnabled(enabled.checked), modal));
        selectAll('[data-mvu-source]', modal).forEach(button => button.addEventListener('click', () => {
            if (button.dataset.mvuSource === 'story') {
                void runMvu(() => mvu.useStoryModel(), modal);
                return;
            }
            if (!config.base_url || !config.model || !config.has_api_key) {
                openMvuConfigForm(config, status);
                return;
            }
            void runMvu(() => mvu.useIndependentModel(), modal);
        }));
        select('[data-mvu-config]', modal)?.addEventListener('click', () => openMvuConfigForm(config, status));
    }

    function open() {
        const native = readState().model;
        const available = projectTextModelChoices(settings());
        const display = projectTextModelDisplay({ nativeModel: native, uiSettings: settings() });
        const contextValue = clamp(native.openai_max_context, 32768, 512, 1000000);
        const tokenValue = clamp(native.openai_max_tokens, 2048, 1, 128000);
        const rows = available.map((choice) => `<div class="nora-model-item ${choice.active ? 'active' : ''}" data-model-choice="${escapeHtml(choice.id)}" role="button" tabindex="0"><div class="nora-model-info"><strong>${escapeHtml(choice.name)}</strong><span>${escapeHtml(choice.model)}</span></div><span class="nora-model-check" aria-hidden="true">✓</span>${choice.deletable ? `<button class="nora-delete-button nora-model-delete" data-model-delete="${escapeHtml(choice.id)}" type="button" aria-label="${t`删除模型 ${escapeHtml(choice.name)}`}" title="${tr("删除模型")}">${icons.trash}</button>` : ''}</div>`).join('');
        const initialMvuStatus = mvu?.status?.(activeWorldCapabilities());
        const modal = dialogs.open(tr("模型"), `<section class="nora-model-group"><div class="nora-model-group-head"><span>${tr("文本模型")}</span><button data-model-add type="button">${icons.plus}<span>${tr("添加")}</span></button></div><p class="nora-model-hint">${t`当前使用：${escapeHtml(display.label)}`}</p><div class="nora-model-list">${rows || `<p class="nora-model-empty">${tr("还没有保存自定义模型。")}</p>`}</div></section><div data-mvu-model-slot>${renderMvuModelSection(initialMvuStatus, escapeHtml)}</div>`, 'nora-model-modal nora-plain-sheet');
        void refreshMvuSection(modal);
        selectAll('[data-model-choice]', modal).forEach((row) => {
            row.addEventListener('click', () => apply(row.dataset.modelChoice));
            row.addEventListener('keydown', (event) => {
                if (event.target.closest?.('[data-model-delete]')) return;
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    apply(row.dataset.modelChoice);
                }
            });
        });
        selectAll('[data-model-delete]', modal).forEach((button) => button.addEventListener('click', (event) => {
            event.stopPropagation();
            void remove(button.dataset.modelDelete);
        }));
        select('[data-model-add]', modal).addEventListener('click', () => openConfig({ contextValue, tokenValue }));
    }

    function openMvuConfigForm(config = {}, status = {}) {
        const modal = dialogs.open(tr("配置 MVU 变量模型"), `<form id="nora-mvu-model-form" class="nora-form nora-model-config-form"><label>${tr("API 地址")}<input name="base" type="url" required inputmode="url" value="${escapeHtml(config.base_url || '')}" placeholder="https://api.example.com/v1"></label><label>${tr("模型 ID")}<input name="model" required autocomplete="off" value="${escapeHtml(config.model || status.variableModelName || '')}" placeholder="${tr("填写变量模型 ID")}"></label><label>API Key<input name="key" type="password" autocomplete="new-password" placeholder="${config.has_api_key ? tr("留空沿用已保存密钥") : tr("填写变量模型密钥")}"></label><p class="nora-model-note">${tr("密钥保存在后端，不会写入角色卡、聊天记录或前端设置。")}</p><div class="nora-sheet-actions"><button class="nora-secondary" data-mvu-cancel type="button">${tr("返回")}</button><button class="nora-primary" type="submit">${tr("保存")}</button></div></form>`, 'nora-model-modal nora-plain-sheet');
        select('[data-mvu-cancel]', modal).addEventListener('click', open);
        select('#nora-mvu-model-form', modal).addEventListener('submit', saveMvuConfig);
        select('#nora-mvu-model-form input[name="base"]', modal)?.focus();
    }

    async function saveMvuConfig(event) {
        event.preventDefault();
        if (operations.isBusy('mvu-model')) {
            dialogs.toast(tr("MVU 模型设置正在保存，请稍候。"));
            return;
        }
        const data = new FormData(event.currentTarget);
        const submit = event.currentTarget.querySelector('[type="submit"]');
        submit.disabled = true;
        try {
            await operations.run('mvu-model', () => mvu.configureIndependent({
                baseUrl: data.get('base'),
                model: data.get('model'),
                apiKey: data.get('key'),
            }));
            open();
        } catch (error) {
            submit.disabled = false;
            dialogs.toast(t`MVU 模型配置失败：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
        }
    }

    function openConfig({ contextValue, tokenValue } = {}) {
        const providers = [
            { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
            { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', model: '' },
            { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: '' },
            { id: 'custom', name: tr("全自定义"), base: '', model: '' },
        ];
        const choices = providers.map(provider => `<button data-model-provider="${provider.id}" type="button"><strong>${provider.name}</strong><span>${provider.base || 'OpenAI-compatible API'}</span></button>`).join('');
        const modal = dialogs.open(tr("添加模型"), `<div class="nora-choice-list nora-provider-list">${choices}</div>`, 'nora-model-modal nora-plain-sheet');
        selectAll('[data-model-provider]', modal).forEach(button => button.addEventListener('click', () => {
            const provider = providers.find(item => item.id === button.dataset.modelProvider);
            openConfigForm(provider, { contextValue, tokenValue });
        }));
    }

    function openConfigForm(provider, { contextValue, tokenValue } = {}) {
        const native = readState().model;
        const normalizedContext = contextValue ?? clamp(native.openai_max_context, 32768, 512, 1000000);
        const normalizedTokens = tokenValue ?? clamp(native.openai_max_tokens, 2048, 1, 128000);
        const custom = provider?.id === 'custom';
        const name = custom ? '自定义模型' : provider?.name || '自定义模型';
        const base = custom ? native.custom_url || '' : provider?.base || '';
        const model = custom ? native.custom_model || '' : provider?.model || '';
        const modal = dialogs.open(t`配置 ${name}`, `<form id="nora-model-form" class="nora-form nora-model-config-form"><label>${tr("配置名称")}<input name="name" required maxlength="60" autocomplete="off" value="${escapeHtml(name)}"></label><label>${tr("API 地址")}<input name="base" type="url" required inputmode="url" value="${escapeHtml(base)}" placeholder="https://api.example.com/v1"></label><label>${tr("模型 ID")}<input name="model" required autocomplete="off" value="${escapeHtml(model)}" placeholder="${tr("填写供应商提供的模型 ID")}"></label><label>API Key<input name="key" type="password" autocomplete="new-password" placeholder="${tr("留空则沿用已保存密钥")}"></label><div class="nora-form-grid"><label>${tr("上下文")}<input name="context" type="number" min="512" max="1000000" value="${normalizedContext}"></label><label>${tr("最大回复")}<input name="tokens" type="number" min="1" max="128000" value="${normalizedTokens}"></label></div><p class="nora-model-note">${tr("保存时会先测试连接；完整密钥不会显示在模型列表中。")}</p><div class="nora-sheet-actions"><button class="nora-secondary" data-model-cancel type="button">${tr("返回")}</button><button class="nora-primary" type="submit">${tr("测试并保存")}</button></div></form>`, 'nora-model-modal nora-plain-sheet');
        select('[data-model-cancel]', modal).addEventListener('click', () => openConfig({ contextValue: normalizedContext, tokenValue: normalizedTokens }));
        select('#nora-model-form', modal).addEventListener('submit', save);
        select('#nora-model-form input[name="name"]', modal)?.focus();
    }

    async function save(event) {
        event.preventDefault();
        if (operations.isBusy('model')) {
            dialogs.toast(tr("模型配置正在保存，请稍候。"));
            return;
        }
        const data = new FormData(event.currentTarget);
        const profile = {
            id: `model_${Date.now().toString(36)}`,
            name: String(data.get('name') || '').trim(),
            base: String(data.get('base') || '').trim(),
            model: String(data.get('model') || '').trim(),
            context: Number(data.get('context') || 32768),
            tokens: Number(data.get('tokens') || 2048),
        };
        const submit = event.currentTarget.querySelector('[type="submit"]');
        const previousActive = settings().activeModel;
        submit.disabled = true;
        let configured = false;
        let persisted = false;
        try {
            await operations.run('model', async () => {
                await profileActions.create(profile, String(data.get('key') || '').trim());
                configured = true;
                persisted = true;
                onChanged();
                open();
            });
        } catch (error) {
            if (!persisted && !error.runtimeApplied) {
                settings().modelProfiles = profiles().filter((item) => item.id !== profile.id);
                settings().activeModel = previousActive;
            }
            const prefix = persisted ? tr("模型已保存，但页面刷新失败") : configured ? tr("模型连接成功，但本地配置保存失败") : tr("模型配置失败");
            dialogs.toast(`${prefix}：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
        } finally {
            if (!persisted) submit.disabled = false;
        }
    }

    async function apply(id) {
        const profile = id === HERMES_MODEL_ID ? hermesProfile() : profiles().find((item) => item.id === id);
        if (id === HERMES_MODEL_ID && !profile) {
            dialogs.toast(tr("Hermes 默认模型尚未完成初始化，请重新启动酒馆。"), { tone: 'error', duration: 4200 });
            return;
        }
        if (!profile) return;
        if (operations.isBusy('model')) {
            dialogs.toast(tr("模型正在切换，请稍候。"));
            return;
        }
        let configured = false;
        let persisted = false;
        const previousActive = settings().activeModel;
        try {
            await operations.run('model', async () => {
                await profileActions.select(id);
                configured = true;
                persisted = true;
                dialogs.close();
                onChanged();
            });
        } catch (error) {
            if (!persisted && !error.runtimeApplied) settings().activeModel = previousActive;
            const prefix = persisted ? tr("模型已切换，但页面刷新失败") : configured ? tr("模型已连接，但本地配置保存失败") : tr("模型切换失败");
            dialogs.toast(`${prefix}：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
        }
    }

    async function remove(id) {
        if (operations.isBusy('model')) {
            dialogs.toast(tr("模型正在更新，请稍候。"));
            return;
        }
        const profile = profiles().find(item => item.id === id);
        if (!profile) return;
        const confirmed = await dialogs.confirm({
            title: tr("删除模型配置"),
            body: t`确定删除“${profile.name || profile.model}”吗？${settings().activeModel === id ? tr(" 当前模型将自动切换或清空。") : ''}`,
            confirmLabel: tr("删除"),
            cancelLabel: tr("取消"),
            tone: 'danger',
        });
        if (!confirmed) {
            open();
            return;
        }
        if (operations.isBusy('model')) {
            dialogs.toast(tr("模型正在更新，请稍候。"));
            open();
            return;
        }
        try {
            await operations.run('model', async () => {
                await profileActions.remove(id);
                onChanged();
                open();
            });
        } catch (error) {
            dialogs.toast(t`模型删除失败：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
            open();
        }
    }

    return Object.freeze({ open });
}
