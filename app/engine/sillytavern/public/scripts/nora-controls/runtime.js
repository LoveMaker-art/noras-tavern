import { CONTROL_ACTIONS, validateControl, controlError } from './contract.js';
import { interactionBridge } from '../nora-compat/interaction-bridge.js';
import { createThemeActions } from './theme-actions.js';
import { createPanelActions } from './panel-actions.js';

const denied = ['assets', 'attachments', 'connection-manager', 'gallery', 'memory', 'token-counter'];
const managedScriptId = 'nora-mvu-headless-runtime';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const secretField = key => /api.?key|access.?token|auth.?token|secret|password|^token$|^key$|密钥|密码/i.test(key);
const redact = value => Array.isArray(value) ? value.map(redact) : record(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretField(key) ? '[redacted]' : redact(item)])) : value;
const revision = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
function findScript(items, id) {
    for (const [index, item] of items.entries()) {
        if (item.id === id) return { items, index, item };
        if (Array.isArray(item.scripts)) { const found = findScript(item.scripts, id); if (found) return found; }
    }
    return null;
}
function primitivePatch(target, updates) {
    for (const [key, value] of Object.entries(updates)) {
        const parts = key.split('.');
        if (parts.some(part => /^(?:__proto__|prototype|constructor)$/.test(part) || secretField(part))) throw controlError('NORA_CONTROL_FIELD_DENIED', 'Secret/prototype fields require a dedicated configuration operation.');
        let parent = target;
        for (const part of parts.slice(0, -1)) { if (!record(parent?.[part])) throw controlError('NORA_CONTROL_FIELD_DENIED', 'Unknown configuration path.'); parent = parent[part]; }
        const leaf = parts.at(-1);
        if (!Object.hasOwn(parent, leaf) || !['boolean', 'number', 'string'].includes(typeof value) || typeof parent[leaf] !== typeof value) throw controlError('NORA_CONTROL_FIELD_DENIED', 'Only existing primitive fields of the same type may be patched.');
        parent[leaf] = value;
    }
}

export function createRuntimeControls({ getContext, story, dispatch, globalRef = globalThis,
    loadExtensions = () => import(/* webpackIgnore: true */ '/scripts/extensions.js'),
    loadRegex = () => import(/* webpackIgnore: true */ '/scripts/extensions/regex/engine.js'),
    assertIdle = () => interactionBridge.assertSessionIdle(),
    triggerButton = id => getContext().eventSource.emit(id),
    fetcher = (...args) => fetch(...args),
} = {}) {
    const scope = () => ({ worldId: getContext().chatMetadata?.nora_world?.id || '', sessionId: getContext().chatMetadata?.nora_session?.id || '' });
    const helper = () => {
        if (!globalRef.TavernHelper?.getScriptTrees) throw controlError('NORA_HELPER_NOT_READY', 'Tavern Helper is not active.');
        return globalRef.TavernHelper;
    };
    const helperControl = () => {
        const api = helper().noraControls;
        if (!api) throw controlError('NORA_HELPER_CONTROL_UNAVAILABLE', 'Upgrade the managed Helper control adapter.');
        return api;
    };
    async function saveHelper(type, source) {
        await helperControl().flush(type, source);
        await save();
        if (type === 'character') {
            const stored = await request('/api/characters/get', { avatar_url: character().avatar });
            const actual = stored.data?.extensions?.tavern_helper?.scripts ?? [];
            if (await revision(actual) !== await revision(helper().getScriptTrees({ type }))) throw controlError('NORA_CONTROL_SAVE_UNCONFIRMED', 'Character script persistence could not be confirmed.');
        }
    }
    const character = () => {
        const current = getContext(); const card = current.characters?.[Number(current.characterId)];
        if (!scope().worldId || !card) throw controlError('NORA_CONTROL_NO_WORLD', 'Open the target World first.');
        return card;
    };
    async function save() {
        if (typeof getContext().saveSettingsStrict !== 'function') throw controlError('NORA_CONTROL_SAVE_UNAVAILABLE', 'Strict settings save is unavailable.');
        await getContext().saveSettingsStrict();
    }
    async function request(route, body) {
        const response = await fetcher(route, { method: body === undefined ? 'GET' : 'POST', headers: getContext().getRequestHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw controlError('NORA_CONTROL_BACKEND_FAILED', 'Backend rejected control change.');
        return response.json();
    }
    async function assertOwnedCard() {
        const current = character(); const worldId = scope().worldId;
        const { plan } = await request('/api/nora-worlds-v2/worlds/' + encodeURIComponent(worldId) + '/open-plan');
        if (plan?.world_id !== worldId || plan.runtime_card?.binding?.avatar !== current.avatar || plan.runtime_card?.ownership !== 'owned') throw controlError('NORA_CONTROL_CARD_SHARED', 'This runtime card is shared/external; a World-owned card is required for edits.');
    }
    function pluginConfig(name) {
        const key = name === 'third-party/JS-Slash-Runner' ? 'tavern_helper' : name === 'third-party/nora-mvu' ? 'mvu_settings' : name.replace(/^third-party\//, '');
        if (!Object.hasOwn(getContext().extensionSettings, key)) throw controlError('NORA_CONTROL_CONFIG_UNAVAILABLE', 'No saved configuration for this extension.');
        const value = getContext().extensionSettings[key];
        if (!record(value)) throw controlError('NORA_CONTROL_CONFIG_UNAVAILABLE', 'This extension has no mapped configuration namespace.');
        return { key, value };
    }
    async function plugins() {
        const module = await loadExtensions();
        return module.extensionNames.map(name => ({ name, active: getContext().getActiveExtensionNames().includes(name),
            enabled: !getContext().extensionSettings.disabledExtensions?.includes(name),
            controllable: !denied.includes(name) && name !== 'third-party/nora-ui',
            reason: denied.includes(name) ? 'disabled-by-product-policy' : name === 'third-party/nora-ui' ? 'product-shell' : null,
            effect: name === 'third-party/nora-mvu' ? 'use-mvu.runtime' : 'reload-required' }));
    }
    let mutating = false;
    const themeAction = createThemeActions({ getContext, request, story, readTheme: () => globalRef.NoraUI?.themeState?.() || { ready: false } });
    const panelAction = createPanelActions({ getContext, story, request, character, assertOwnedCard, save });
    async function execute(command) {
        const definition = validateControl(command);
        const currentScope = scope();
        if (currentScope.worldId !== command.worldId || currentScope.sessionId !== command.sessionId) throw controlError('NORA_CONTROL_SCOPE_CHANGED', 'World/Session changed before execution.');
        const isStop = command.action === 'story.stop';
        if (!definition.readOnly && !isStop) {
            if (mutating) throw controlError('NORA_CONTROL_BUSY', 'Another control mutation is in progress.');
            assertIdle();
            if (globalRef.Mvu?.isDuringExtraAnalysis?.()) throw controlError('NORA_CONTROL_BUSY', 'MVU is still updating variables.');
        }
        const params = command.params ?? {};
        if (params.scope && params.scope !== 'global') character();
        if (!definition.readOnly && !isStop) mutating = true;
        try {
            // Use the existing task registry: World changes already consult this registry.
            // Do not nest story generation inside another generation action.
            if (!definition.readOnly && !isStop && !command.action.startsWith('story.') && currentScope.worldId) {
                const result = await dispatch().execute({ type: 'sidecar.run', key: 'runtime-controls',
                    run: () => apply(command.action, params) });
                if (result.status !== 'completed') throw result.error || controlError('NORA_CONTROL_BUSY', 'Control action was not completed.');
                return result.value;
            }
            return await apply(command.action, params);
        } finally { if (!definition.readOnly && !isStop) mutating = false; }
    }
    async function apply(action, params) {
        if (action.startsWith('theme.')) return themeAction(action, params);
        const context = getContext();
        if (/^(world|scenario|worldbook|models)\./.test(action)) return panelAction(action, params);
        if (params.scope === 'character' && !CONTROL_ACTIONS[action].readOnly && action !== 'helper.permissions' && action !== 'regex.permission') await assertOwnedCard();
        if (action === 'plugins.list') return { plugins: await plugins(), quickReply: { available: false, reason: 'frontend-module-not-installed' }, backend: ['nora.ledger.*', 'nora.story.*'] };
        if (action.startsWith('plugins.')) {
            const items = await plugins(); const item = items.find(item => item.name === params.name);
            if (!item) throw controlError('NORA_CONTROL_PLUGIN_MISSING', 'Extension is not installed.');
            if (action === 'plugins.config') return redact(pluginConfig(params.name));
            if (!item.controllable) throw controlError('NORA_CONTROL_PROTECTED', item.reason);
            if (params.name === 'third-party/nora-mvu') throw controlError('NORA_CONTROL_USE_MVU', 'Use the explicit MVU operations.');
            if (action === 'plugins.enabled') {
                if (!params.enabled && params.name === 'third-party/JS-Slash-Runner' && context.extensionSettings.nora_mvu?.managedRuntimeEnabled !== false) throw controlError('NORA_CONTROL_DEPENDENCY', 'Disable managed MVU and dependent card scripts before disabling Tavern Helper.');
                const module = await loadExtensions();
                await (params.enabled ? module.enableExtension : module.disableExtension)(params.name, false);
                await save();
            } else {
                if (params.name === 'third-party/JS-Slash-Runner') throw controlError('NORA_CONTROL_USE_SCRIPTS', 'Use scripts/helper operations for script execution settings.');
                const { key, value } = pluginConfig(params.name); const next = structuredClone(value);
                primitivePatch(next, params.updates); context.extensionSettings[key] = next; await save();
            }
            return { saved: true, runtimeApplied: false, reloadRequired: true };
        }
        if (action === 'scripts.buttons') return { buttons: helper().getAllEnabledScriptButtons() };
        if (action === 'scripts.button') {
            const buttons = Object.values(helper().getAllEnabledScriptButtons()).flat();
            if (!buttons.some(button => button.button_id === params.buttonId)) throw controlError('NORA_CONTROL_BUTTON_MISSING', 'No currently enabled script button with this ID.');
            // Helper's own button invokes eventSource.emit(button_id); it has no matching DOM ID.
            await triggerButton(params.buttonId);
            return { dispatched: true, completionKnown: false };
        }
        if (action.startsWith('scripts.')) {
            const api = helper(); const option = { type: params.scope }; const trees = api.getScriptTrees(option);
            const source = helperControl().scope(params.scope);
            if (params.scope === 'character' && String(source.ownerId) !== String(context.characterId)) throw controlError('NORA_CONTROL_SCOPE_CHANGED', 'Helper has not switched to the current character.');
            const treeRevision = () => revision([source.source, source.ownerId, api.getScriptTrees(option)]);
            const replace = async next => {
                const current = helperControl().scope(params.scope);
                if (current.source !== source.source || current.ownerId !== source.ownerId) throw controlError('NORA_CONTROL_SCOPE_CHANGED', 'Helper source changed before mutation.');
                await api.replaceScriptTrees(next, option);
                await saveHelper(params.scope, source.source);
            };
            if (action === 'scripts.list') {
                const summary = items => items.map(item => ({ id: item.id, type: item.type, name: item.name, enabled: item.enabled, contentLength: item.content?.length ?? 0, scripts: item.scripts ? summary(item.scripts) : undefined }));
                return { trees: summary(trees), revision: await treeRevision(), scope: params.scope, ...source };
            }
            if (action === 'scripts.inspect') {
                const selected = findScript(trees, params.id);
                if (!selected) throw controlError('NORA_CONTROL_SCRIPT_MISSING', 'Script not found.');
                return { script: selected.item, revision: await treeRevision(), ...source };
            }
            if (await treeRevision() !== params.expectedRevision) throw controlError('NORA_CONTROL_EDIT_STALE', 'Scripts or their source changed; read again.');
            const next = structuredClone(trees);
            if (action === 'scripts.create') {
                const id = crypto.randomUUID();
                next.push({ id, type: 'script', name: params.name, content: params.content, enabled: false, info: '', button: { enabled: false, buttons: [] }, data: {} });
                await replace(next);
                return { id, enabled: false, runtimeAccepted: true, persistence: 'native-save-completed' };
            }
            const selected = findScript(next, params.id);
            if (!selected) throw controlError('NORA_CONTROL_SCRIPT_MISSING', 'Script ID not found in selected scope.');
            if (params.id === managedScriptId || findScript(selected.item.scripts || [], managedScriptId)) throw controlError('NORA_CONTROL_USE_MVU', 'Managed MVU script is controlled through mvu.runtime.');
            if (action === 'scripts.delete') selected.items.splice(selected.index, 1);
            if (action === 'scripts.enabled') selected.item.enabled = params.enabled;
            if (action === 'scripts.update') {
                for (const key of Object.keys(params.patch)) if (!['name', 'content', 'info', 'enabled', 'button', 'data'].includes(key)) throw controlError('NORA_CONTROL_FIELD_DENIED', 'Unsupported script field.');
                Object.assign(selected.item, params.patch);
            }
            await replace(next);
            return { runtimeAccepted: true, revision: await treeRevision(), persistence: 'native-save-completed', cleanupGuaranteed: false };
        }
        if (action.startsWith('regex.')) {
            const module = await loadRegex(); const type = { global: 0, character: 1, preset: 2 }[params.scope];
            if (action === 'regex.permission') {
                if (params.scope === 'character') (params.enabled ? module.allowScopedScripts : module.disallowScopedScripts)(character());
                else {
                    if (!module.getCurrentPresetAPI() || !module.getCurrentPresetName()) throw controlError('NORA_CONTROL_PRESET_MISSING', 'No active preset.');
                    (params.enabled ? module.allowPresetScripts : module.disallowPresetScripts)(module.getCurrentPresetAPI(), module.getCurrentPresetName());
                }
                await save(); return { saved: true, runtimeApplied: true };
            }
            const scripts = module.getScriptsByType(type, { allowedOnly: false });
            const source = params.scope === 'preset' ? [module.getCurrentPresetAPI(), module.getCurrentPresetName()] : params.scope === 'character' ? character().avatar : 'global';
            const persistRules = async next => {
                if (params.scope === 'preset' && (source[0] !== module.getCurrentPresetAPI() || source[1] !== module.getCurrentPresetName())) throw controlError('NORA_CONTROL_SCOPE_CHANGED', 'Preset changed before mutation.');
                await module.saveScriptsByType(next, type); await save();
                if (params.scope === 'character') {
                    const stored = await request('/api/characters/get', { avatar_url: source });
                    if (await revision(stored.data?.extensions?.regex_scripts ?? []) !== await revision(next)) throw controlError('NORA_CONTROL_SAVE_UNCONFIRMED', 'Character regex persistence could not be confirmed.');
                }
            };
            if (params.scope === 'preset' && (!source[0] || !source[1])) throw controlError('NORA_CONTROL_PRESET_MISSING', 'No active preset.');
            if (action === 'regex.list') return { scripts, revision: await revision([source, scripts]), scope: params.scope, source };
            if (await revision([source, scripts]) !== params.expectedRevision) throw controlError('NORA_CONTROL_EDIT_STALE', 'Regex configuration or source changed.');
            const next = structuredClone(scripts);
            if (action === 'regex.create') {
                const id = crypto.randomUUID();
                next.push({ id, scriptName: params.name, findRegex: params.findRegex, replaceString: params.replaceString, disabled: true, placement: [2], trimStrings: [], substituteRegex: 0, markdownOnly: true, promptOnly: false, runOnEdit: true });
                await persistRules(next); return { id, saved: true, enabled: false };
            }
            const index = next.findIndex(script => script.id === params.id);
            if (index < 0) throw controlError('NORA_CONTROL_SCRIPT_MISSING', 'Regex ID not found.');
            if (action === 'regex.delete') next.splice(index, 1);
            if (action === 'regex.enabled') next[index].disabled = !params.enabled;
            if (action === 'regex.update') {
                for (const key of Object.keys(params.patch)) if (!['scriptName', 'findRegex', 'replaceString', 'placement', 'trimStrings', 'disabled', 'markdownOnly', 'promptOnly', 'runOnEdit', 'minDepth', 'maxDepth', 'substituteRegex'].includes(key)) throw controlError('NORA_CONTROL_FIELD_DENIED', 'Unsupported regex field.');
                for (const [key, value] of Object.entries(params.patch)) {
                    const valid = ['scriptName', 'findRegex', 'replaceString'].includes(key) ? typeof value === 'string'
                        : key === 'placement' ? Array.isArray(value) && value.every(item => [0, 1, 2, 3, 5, 6].includes(item))
                            : key === 'trimStrings' ? Array.isArray(value) && value.every(item => typeof item === 'string')
                                : ['minDepth', 'maxDepth'].includes(key) ? value === null || Number.isInteger(value) && value >= -1
                                    : key === 'substituteRegex' ? [0, 1, 2].includes(value) : typeof value === 'boolean';
                    if (!valid) throw controlError('NORA_CONTROL_INVALID', `Invalid regex field: ${key}`);
                }
                Object.assign(next[index], params.patch);
            }
            await persistRules(next);
            return { saved: true, runtimeApplied: true, appliesTo: 'subsequent-formatting-and-prompts', revision: await revision([source, next]) };
        }
        if (action.startsWith('mvu.')) {
            if (action === 'mvu.status') {
                const managed = globalRef.NoraMvu?.status?.() ?? null;
                return {
                    ...story.mvu.status(),
                    managedPhase: managed?.phase ?? null,
                    managedError: managed?.error ?? null,
                    legacyScriptCleanup: managed?.registration ?? null,
                    updatePhase: managed?.updatePhase ?? 'unobserved',
                    lastUpdateCode: managed?.lastUpdateCode ?? null,
                    lastUpdateStage: managed?.lastUpdateStage ?? null,
                    lastUpdateError: managed?.lastUpdateError ?? null,
                    lastUpdateCommandCount: managed?.lastUpdateCommandCount ?? null,
                    lastUpdateValidationErrors: managed?.lastUpdateValidationErrors ?? [],
                    transactionAttempt: managed?.transactionAttempt ?? null,
                    transactionDurationMs: managed?.transactionDurationMs ?? null,
                    lastUpdateAt: managed?.lastUpdateAt ?? null,
                    analysisRunning: Boolean(globalRef.Mvu?.isDuringExtraAnalysis?.()),
                    managedRuntimeEnabled: context.extensionSettings.nora_mvu?.managedRuntimeEnabled !== false,
                    scope: 'global',
                    updateSwitch: 'extra-model-parsing-only',
                    cardOverridesMayApply: true,
                };
            }
            if (action === 'mvu.settings') return { settings: redact(context.extensionSettings.mvu_settings ?? {}), scope: 'global' };
            if (action === 'mvu.configure') {
                if (!globalRef.Mvu?.reloadSettings) throw controlError('NORA_MVU_NOT_READY', 'MVU configuration interface is unavailable.');
                const settings = structuredClone(context.extensionSettings.mvu_settings ?? {});
                const enums = { '额外模型解析配置.破限方案': ['使用内置破限', '使用当前预设', '使用其他预设'], '额外模型解析配置.应答格式': ['聊天消息', '工具调用', '格式化输出', '格式化输出(v4兼容)'], '额外模型解析配置.请求方式': ['依次请求，失败后重试', '同时请求多次', '先请求一次, 失败后再同时请求多次'] };
                for (const [key, value] of Object.entries(params.updates)) {
                    if (/api地址|模型来源|模型名称|更新方式|启用自动请求|^internal\./.test(key)) throw controlError('NORA_CONTROL_FIELD_DENIED', 'Use mvu.enabled/model or nora.mvu_model.configure for connection changes.');
                    if (enums[key] && !enums[key].includes(value)) throw controlError('NORA_CONTROL_INVALID', `Invalid MVU option: ${key}`);
                    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 && !/频率惩罚|存在惩罚/.test(key))) throw controlError('NORA_CONTROL_INVALID', `Invalid MVU numeric setting: ${key}`);
                    if (/请求次数|快照保留间隔/.test(key) && (!Number.isInteger(value) || value < 1)) throw controlError('NORA_CONTROL_INVALID', 'Request count and snapshot interval must be positive integers.');
                }
                primitivePatch(settings, params.updates);
                // Both embedded and managed MVU expose this same upstream settings interface.
                context.extensionSettings.mvu_settings = settings;
                await globalRef.Mvu.reloadSettings(); await save();
                return { saved: true, runtimeApplied: true, settings: redact(context.extensionSettings.mvu_settings), scope: 'global', cardOverridesMayApply: true };
            }
            if (action === 'mvu.data') {
                character(); if (!globalRef.Mvu?.getMvuData) throw controlError('NORA_MVU_NOT_READY', 'MVU runtime is not available.');
                return { data: globalRef.Mvu.getMvuData({ type: 'message', message_id: 'latest' }) };
            }
            if (action === 'mvu.runtime') {
                if (params.enabled && context.extensionSettings.disabledExtensions?.includes('third-party/JS-Slash-Runner')) throw controlError('NORA_CONTROL_DEPENDENCY', 'Enable Tavern Helper and reload the page first.');
                context.extensionSettings.nora_mvu ??= {};
                context.extensionSettings.nora_mvu.managedRuntimeEnabled = params.enabled;
                // Tavern Helper owns the live script tree. Persist the policy in
                // Nora, then update and flush the same live store Helper executes.
                if (globalRef.TavernHelper?.noraControls) {
                    const api = helper();
                    const scripts = api.getScriptTrees({ type: 'global' });
                    const found = findScript(scripts, managedScriptId);
                    if (found) {
                        found.item.enabled = params.enabled;
                        await api.replaceScriptTrees(scripts, { type: 'global' });
                    }
                    if (params.enabled) helperControl().setScopeEnabled('global', true);
                    await saveHelper('global', 'global');
                }
                await save(); return { saved: true, runtimeApplied: false, reloadRequired: true, scope: 'global-managed-runtime', embeddedScriptsUnchanged: true };
            }
            if (action === 'mvu.enabled') await story.mvu.setEnabled(params.enabled);
            if (action === 'mvu.model') {
                if (params.source === 'story') await story.mvu.useStoryModel();
                else {
                    const config = await request('/api/nora-mvu-model/config', {});
                    if (!config.model || !config.base_url || !config.has_api_key) throw controlError('NORA_MVU_MODEL_MISSING', 'Configure independent MVU model first.');
                    const model = { model: config.model };
                    if (Number.isFinite(Number(config.context))) model.contextLimit = Number(config.context);
                    if (Number.isFinite(Number(config.max_tokens))) model.maxTokens = Number(config.max_tokens);
                    await story.mvu.useIndependentModel(model);
                }
            }
            if (action === 'mvu.retry') {
                character(); if (!globalRef.Mvu?.retryLastUpdate) throw controlError('NORA_MVU_NOT_READY', 'Runtime retry operation unavailable.');
                await globalRef.Mvu.retryLastUpdate(); return { completed: true, status: story.mvu.status() };
            }
            await save(); return { saved: true, runtimeApplied: true, status: story.mvu.status(), scope: 'global' };
        }
        if (action === 'helper.settings' || action === 'helper.configure') {
            const api = helperControl();
            const current = api.settings();
            if (action === 'helper.settings') return { settings: redact(current), scope: 'global' };
            const next = structuredClone(current);
            for (const key of Object.keys(params.updates)) if (key === 'script' || key.startsWith('script.') || key.startsWith('$')) throw controlError('NORA_CONTROL_FIELD_DENIED', 'Script permissions and contents use dedicated operations.');
            primitivePatch(next, params.updates);
            api.configure(next); await saveHelper('global', 'global');
            return { saved: true, runtimeAccepted: true, cleanupGuaranteed: false };
        }
        if (action === 'helper.permissions') {
            const api = helperControl(); const source = api.scope(params.scope);
            if (params.scope === 'character' && String(source.ownerId) !== String(context.characterId)) throw controlError('NORA_CONTROL_SCOPE_CHANGED', 'Helper has not switched to the current character.');
            if (params.scope === 'global') {
                if (!params.enabled && context.extensionSettings.nora_mvu?.managedRuntimeEnabled !== false) throw controlError('NORA_CONTROL_DEPENDENCY', 'Global scripts include managed MVU; disable it first.');
            }
            api.setScopeEnabled(params.scope, params.enabled);
            await saveHelper('global', 'global'); return { saved: true, runtimeAccepted: true, source: source.source, cleanupGuaranteed: false };
        }
        if (action === 'cards.inspect' || action === 'cards.opening' || action === 'cards.fields') {
            const current = character();
            if (!story.worlds?.usesRuntimeCard(current)) throw controlError('NORA_CONTROL_CARD_OWNERSHIP', 'Current character is not an authoritative World runtime card.');
            const card = await request('/api/characters/get', { avatar_url: current.avatar });
            const fields = card.data || card;
            if (action === 'cards.inspect') return { avatar: current.avatar, fields, revision: await revision(fields) };
            await assertOwnedCard();
            if (await revision(fields) !== params.expectedRevision) throw controlError('NORA_CONTROL_EDIT_STALE', 'Runtime card changed; inspect it again.');
            const patch = action === 'cards.opening' ? { first_mes: params.text } : params.patch;
            for (const key of Object.keys(patch)) if (!['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'alternate_greetings'].includes(key)) throw controlError('NORA_CONTROL_FIELD_DENIED', 'Unsupported runtime-card field.');
            for (const [key, value] of Object.entries(patch)) if (key === 'alternate_greetings' ? !Array.isArray(value) || value.some(item => typeof item !== 'string') : typeof value !== 'string') throw controlError('NORA_CONTROL_INVALID', 'Invalid narrative field value.');
            if ('name' in patch && !patch.name.trim()) throw controlError('NORA_CONTROL_INVALID', 'Character name cannot be empty.');
            await story.cards.patchCharacter({ avatar: current.avatar, patch });
            await story.worlds.refresh();
            return { saved: true, existingChatUnchanged: true, target: 'world-runtime-card', librarySourceUnchanged: true };
        }
        if (action === 'page.reload') return { reloadRequested: true, runtimeApplied: false };
        if (action.startsWith('story.')) {
            character();
            if (action === 'story.stop') { await dispatch().cancel('visible'); return { stopRequested: true }; }
            const result = await dispatch().execute({ type: { 'story.send': 'story.send', 'story.regenerate': 'story.regenerate', 'story.suggest': 'sidecar.suggest-replies' }[action], text: params.text });
            if (result.status !== 'completed') throw controlError('NORA_CONTROL_STORY_FAILED', `Story operation: ${result.status}`);
            return { completed: true, value: action === 'story.suggest' ? result.value : null };
        }
        throw controlError('NORA_CONTROL_UNSUPPORTED', 'No executor for this operation.');
    }
    return Object.freeze({ scope, execute, catalog: () => CONTROL_ACTIONS, busy: () => mutating || Boolean(story.messages.isGenerating()) });
}
