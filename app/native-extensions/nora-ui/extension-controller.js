import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { prepareScriptImport } from '../../engine/sillytavern/public/scripts/nora-controls/script-import.js';
import { scriptUsage, regexUsage } from './extension-usage.js';

const managedId = 'nora-mvu-headless-runtime';
const scopes = { character: '本世界', preset: '当前预设', global: '全局' };

export function createExtensionController({ dialogs, select, selectAll, escapeHtml: esc, activeWorldModel,
    currentCharacter, readState, executeControl, openCardRegex, openModelSheet, retryCapability, renderPanel,
    plugins, ledgerRequest, isGenerating = () => false }) {
    let target;
    let busy = false;
    let runtimeReloadPending = false;
    const scriptScopes = () => activeWorldModel()?.preset?.preset?.extensions?.tavern_helper || activeWorldModel()?.preset?.preset?.extensions?.TavernHelper_scripts
        ? ['character', 'preset', 'global'] : ['character', 'global'];
    const attr = value => esc(value).replaceAll('"', '&quot;');
    const session = () => readState().world?.metadata?.nora_session?.id || '';
    const current = () => target && (activeWorldModel()?.id || null) === target.worldId && currentCharacter()?.avatar === target.avatar && session() === target.sessionId;
    const run = (action, params, write = false) => {
        if (!current()) throw new Error(tr('当前世界已改变，请重新打开编辑。'));
        return executeControl({ action, params, worldId: target.worldId, sessionId: target.sessionId,
            confirm: write, allowScriptExecution: write, allowModelCall: write && action === 'mvu.runtime' });
    };
    function sheet(title, html, back, showWorld = true) {
        const modal = dialogs.open(title, `<div class="nora-extension-manager">${showWorld && target.name ? `<p class="nora-extension-world">${esc(target.name)}</p>` : ''}${html}</div>`, 'nora-detail-modal nora-plain-sheet nora-extensions-modal', {
            back: back ? () => { if (!busy && current()) back(); } : undefined,
        });
        dialogs.setCloseGuard?.(() => !busy);
        return modal;
    }
    function state(key) {
        const caps = activeWorldModel()?.capabilities;
        if (!caps?.declared?.includes(key)) return tr('当前世界未使用');
        return tr({ READY: '已就绪', PENDING: '加载中', DEGRADED: '未就绪' }[caps.items?.[key]?.status] || '加载中');
    }
    function menu() {
        if (!current()) return;
        const entries = [
            ['regex', '正则', 'fa-code'],
            ['tavern_helper', '酒馆助手', 'fa-scroll'],
            ['mvu', 'MVU 变量', 'fa-sliders'],
            ['prompt_template', '提示词模板', 'fa-file-lines'],
        ].filter(([key]) => activeWorldModel()?.capabilities?.declared?.includes(key)
            || key === 'regex' && activeWorldModel()?.preset?.preset?.extensions?.regex_scripts?.length);
        const entry = ([key, label, icon], summary = tr('加载中')) => `<button class="nora-extension-entry" data-extension="${key}" type="button"><i class="fa-solid ${icon} nora-extension-icon" aria-hidden="true"></i><span><strong>${tr(label)}</strong><small data-extension-summary="${key}">${esc(summary)}</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
        const templateStatus = { READY: tr('模板已加载'), PENDING: tr('模板加载中'), DEGRADED: tr('模板加载失败，点击处理') };
        const modal = sheet(tr('扩展管理'), `${plugins && target.worldId ? `<h3>${tr('当前世界相关')}</h3>` : ''}<div class="nora-extension-menu">${entries.map(item => entry(item, item[0] === 'prompt_template' ? templateStatus[activeWorldModel()?.capabilities?.items?.prompt_template?.status] || tr('模板加载中') : undefined)).join('')}</div><div data-extension-empty>${entries.length ? '' : `<p class="nora-model-note">${tr(target.worldId ? '正在检查当前世界的扩展' : '未打开世界，可管理全局插件加载。')}</p>`}</div>${plugins ? `<section data-other-plugins><h3>${tr(target.worldId ? '其他已安装插件' : '已安装插件')}</h3><div data-plugin-list>${tr('加载中')}</div></section>` : ''}`, null);
        const version = dialogs.version;
        const alive = () => current() && dialogs.version === version;
        let inventory = [];
        let inventoryReady = false;
        let otherHtml;
        const owner = target;
        const sameWorld = () => target === owner && current();
        const settings = key => {
            if (!current()) return;
            if (!target.worldId) return dialogs.toast(tr('请先打开一个世界，再配置此功能。'));
            if (key === 'regex') void regexScopes();
            if (key === 'mvu') void mvuSettings();
            if (key === 'tavern_helper') void scripts();
            if (key === 'prompt_template') template();
            if (key === 'ledger') void ledgerSettings();
        };
        const managePlugin = item => {
            const key = item.builtin?.key;
            // Keep specialised controls specialised; a ledger session switch is
            // not a global module loader switch.
            if (['regex', 'mvu', 'ledger'].includes(key) && target.worldId) return settings(key);
            void plugins.manage(item, { back: () => { if (sameWorld()) menu(); }, isCurrent: sameWorld,
                openSettings: key ? () => { if (sameWorld()) settings(key); } : undefined });
        };
        const renderOthers = () => {
            if (!plugins || !alive() || !inventoryReady) return;
            const others = inventory.filter(item => !item.builtin || !select(`[data-extension="${item.builtin.key}"]`, modal));
            const html = others.map(item => `<button class="nora-extension-entry" data-installed-plugin="${attr(item.name)}" type="button"><span><strong>${esc(item.builtin ? tr(item.builtin.title) : item.displayName)}</strong><small>${tr(item.builtin ? '内置插件' : '第三方插件 · 全局加载')}</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`).join('');
            select('[data-other-plugins]', modal).hidden = !others.length;
            if (otherHtml === html) return;
            otherHtml = html;
            select('[data-plugin-list]', modal).innerHTML = html;
            selectAll('[data-installed-plugin]', modal).forEach(button => button.addEventListener('click', () => {
                if (alive()) managePlugin(inventory.find(item => item.name === button.dataset.installedPlugin));
            }));
        };
        const bind = button => button?.addEventListener('click', () => {
            if (!alive()) return;
            const key = button.dataset.extension;
            const item = inventory.find(item => item.builtin?.key === key);
            if (plugins && ['tavern_helper', 'prompt_template'].includes(key)) {
                if (item) managePlugin(item);
                else dialogs.toast(tr('插件列表尚未就绪，请稍后重试。'));
            } else settings(key);
        });
        selectAll('[data-extension]', modal).forEach(bind);
        if (plugins) {
            const loadInventory = () => plugins.catalog().then(items => {
                if (!alive()) return;
                inventory = items;
                inventoryReady = true;
                renderOthers();
            }).catch(error => {
                if (!alive()) return;
                select('[data-other-plugins]', modal).hidden = false;
                select('[data-plugin-list]', modal).innerHTML = `<p role="alert">${esc(dialogs.normalizeError(error))}</p><button class="nora-secondary" data-plugins-retry type="button">${tr('重试')}</button>`;
                select('[data-plugins-retry]', modal).addEventListener('click', () => { if (alive()) void loadInventory(); });
            });
            void loadInventory();
        }
        if (!target.worldId) return;
        const update = (key, summary) => {
            if (!alive()) return;
            const label = select(`[data-extension-summary="${key}"]`, modal);
            if (label) label.textContent = summary;
        };
        const showEmpty = () => {
            if (!alive() || select('[data-extension]', modal)) return;
            select('[data-extension-empty]', modal).innerHTML = `<div class="nora-extension-empty"><p>${tr('当前世界暂无扩展')}</p><button class="nora-secondary" data-add-script type="button">＋ ${tr('导入脚本')}</button></div>`;
            select('[data-add-script]', modal)?.addEventListener('click', () => {
                if (!alive()) return;
                if (!plugins) return void scripts(true);
                const helper = inventory.find(item => item.builtin?.key === 'tavern_helper');
                if (!helper) return dialogs.toast(tr('插件列表尚未就绪，请稍后重试。'));
                void plugins.manage(helper, { back: () => { if (sameWorld()) menu(); }, isCurrent: sameWorld,
                    openSettings: () => { if (sameWorld()) void scripts(true); } });
            });
        };
        const showScripts = summary => {
            if (!alive()) return;
            if (!select('[data-extension="tavern_helper"]', modal)) {
                select('.nora-extension-menu', modal).insertAdjacentHTML('beforeend', entry(['tavern_helper', '酒馆助手', 'fa-scroll'], summary));
                bind(select('[data-extension="tavern_helper"]', modal));
            } else update('tavern_helper', summary);
            select('[data-extension-empty]', modal).innerHTML = '';
            renderOthers();
        };
        const sources = scriptScopes();
        void Promise.all(sources.map(scope => run('scripts.list', { scope }))).then(groups => {
            if (!alive()) return;
            const counts = groups.map(scriptUsage);
            if (counts.some(count => count.total) || entries.some(([key]) => key === 'tavern_helper')) {
                const summary = counts.map((count, index) => count.total
                    ? t`${tr(scopes[sources[index]])}：${count.total} 个，启用 ${count.enabled} 个` : '').filter(Boolean).join(' · ');
                showScripts(summary || tr('本世界声明使用，暂无独立脚本'));
            } else showEmpty();
        }).catch(error => {
            // A never-loaded Helper is normal for a plain world. Merely opening
            // management must neither load it nor invent a failed capability.
            if (error?.code === 'NORA_HELPER_NOT_READY' && !entries.some(([key]) => key === 'tavern_helper')) showEmpty();
            else showScripts(tr('脚本读取失败，点击重试'));
        });
        {
            void Promise.all(Object.keys(scopes).map(async scope => {
                try { return await run('regex.list', { scope }); }
                catch (error) {
                    if (scope === 'preset' && error?.code === 'NORA_CONTROL_PRESET_MISSING') return { scripts: [], allowed: false };
                    throw error;
                }
            })).then(groups => {
                if (!alive()) return;
                if (groups.some(group => !Array.isArray(group.scripts))) throw new Error('Invalid regex response');
                const rules = groups.flatMap(group => group.scripts);
                if (rules.length && !select('[data-extension="regex"]', modal)) {
                    select('.nora-extension-menu', modal).insertAdjacentHTML('afterbegin', entry(['regex', '正则', 'fa-code']));
                    bind(select('[data-extension="regex"]', modal));
                    select('[data-extension-empty]', modal).innerHTML = '';
                }
                const usage = regexUsage(groups);
                const summary = t`${usage.total} 条规则 · 启用 ${usage.enabled} 条`;
                update('regex', activeWorldModel()?.capabilities?.items?.regex?.status === 'DEGRADED' ? t`${summary} · 加载异常` : summary);
                renderOthers();
            }).catch(() => update('regex', tr('规则读取失败，点击查看')));
        }
        if (entries.some(([key]) => key === 'mvu')) {
            void run('mvu.status', {}).then(status => {
                const summary = runtimeReloadPending ? tr('配置已更改，待刷新')
                    : status.managedRuntimeEnabled === false && !status.runtimeAvailable ? tr('内置程序已停用')
                        : status.managedPhase === 'failed' || activeWorldModel()?.capabilities?.items?.mvu?.status === 'DEGRADED' ? tr('运行异常，点击处理')
                            : !status.runtimeAvailable ? tr('程序尚未加载')
                                : status.enabled ? tr('程序已加载 · 额外模型更新') : tr('程序已加载 · 正文解析');
                update('mvu', summary);
            }).catch(() => update('mvu', tr('状态读取失败，点击查看')));
        }
        if (ledgerRequest) {
            const scope = { worldId: target.worldId, sessionId: target.sessionId };
            void ledgerRequest('inspect', scope).then(status => {
                if (!alive() || !status) return;
                if (status.enabled || status.active || status.pending || status.lastError) {
                    select('.nora-extension-menu', modal).insertAdjacentHTML('beforeend', entry(['ledger', '压缩账本', 'fa-book'], tr(status.lastError ? '压缩异常，点击查看' : status.enabled ? '自动压缩已开启' : '自动压缩已关闭')));
                    bind(select('[data-extension="ledger"]', modal));
                    select('[data-extension-empty]', modal).innerHTML = '';
                }
                renderOthers();
            }).catch(() => {
                if (!alive()) return;
                select('.nora-extension-menu', modal).insertAdjacentHTML('beforeend', entry(['ledger', '压缩账本', 'fa-book'], tr('状态读取失败，点击查看')));
                bind(select('[data-extension="ledger"]', modal));
                select('[data-extension-empty]', modal).innerHTML = '';
                renderOthers();
            });
        }
    }
    async function ledgerSettings() {
        if (!current() || !target.worldId || busy || !ledgerRequest) return;
        const scope = { worldId: target.worldId, sessionId: target.sessionId };
        const modal = sheet(tr('压缩账本'), `<div data-ledger-content>${tr('加载中')}</div>`, menu);
        const version = dialogs.version;
        const alive = () => current() && dialogs.version === version;
        const slot = select('[data-ledger-content]', modal);
        try {
            const status = await ledgerRequest('inspect', scope);
            if (!alive()) return;
            if (typeof status?.enabled !== 'boolean') throw new Error(tr('状态读取失败，点击查看'));
            slot.innerHTML = `<section class="nora-extension-setting"><div class="nora-extension-setting-head">
                <div class="nora-extension-setting-copy"><strong>${tr(status.enabled ? '自动压缩已开启' : '自动压缩已关闭')}</strong></div>
                <div class="nora-extension-setting-actions"><button class="nora-setting-button" data-ledger-toggle type="button">${tr(status.enabled ? '关闭自动压缩' : '开启自动压缩')}</button></div>
                </div><p class="nora-setting-description">${tr('仅影响当前会话。关闭后不再生成新的压缩；已经使用的账本仍保留，不恢复为全部原文上下文。')}</p>
                <p class="nora-setting-metric">${t`已应用账本覆盖 ${status.active?.coveredTurns || 0} 轮`}</p>
                ${status.running ? `<p role="status">${tr('正在压缩')}</p>` : ''}
                ${status.lastError ? `<p role="alert">${esc(status.lastError.message || status.lastError.code || tr('压缩失败'))}</p>` : ''}
                </section>`;
            select('[data-ledger-toggle]', modal).addEventListener('click', async () => {
                if (!alive() || busy) return;
                if (isGenerating()) return dialogs.toast(tr('请等本轮生成和保存结束后再操作插件。'));
                busy = true;
                let completedVersion;
                try {
                    const approved = await dialogs.confirm({ title: tr(status.enabled ? '关闭自动压缩？' : '开启自动压缩？'),
                        body: tr(status.enabled ? '只停止当前会话后续自动压缩，不删除已有账本和聊天。' : '开启后，满足条件的历史将自动调用模型压缩，可能产生模型费用。'), restoreSheet: true });
                    completedVersion = dialogs.version;
                    if (approved && current() && slot.isConnected !== false && !isGenerating()) await ledgerRequest('configure', scope, { enabled: !status.enabled });
                } catch (error) { dialogs.toast(dialogs.normalizeError(error), { tone: 'error' }); }
                finally { busy = false; if (current() && slot.isConnected !== false && dialogs.version === completedVersion) void ledgerSettings(); }
            });
        } catch (error) {
            if (!alive()) return;
            slot.innerHTML = `<p role="alert">${esc(dialogs.normalizeError(error))}</p><button class="nora-secondary" data-ledger-retry type="button">${tr('重试')}</button>`;
            select('[data-ledger-retry]', modal).addEventListener('click', () => { if (alive()) void ledgerSettings(); });
        }
    }
    async function regexScopes() {
        if (!current() || busy) return;
        try {
            const groups = await Promise.all(Object.keys(scopes).map(async scope => ({ scope, ...await run('regex.list', { scope }) })));
            if (!current()) return;
            const modal = sheet(tr('正则规则'), groups.filter(group => group.scripts.length).map(group => `<section class="nora-extension-setting"><div class="nora-extension-setting-head">
                <div class="nora-extension-setting-copy"><strong>${tr(scopes[group.scope])}</strong><small>${t`${group.scripts.length} 条规则`}</small></div>
                <div class="nora-extension-setting-actions"><button class="nora-setting-button is-primary" type="button" data-regex-scope="${group.scope}">${tr('查看与编辑')}</button>${group.scope !== 'global' ? `<button class="nora-setting-button" type="button" data-regex-permission="${group.scope}">${tr(group.allowed ? '停用此组' : '启用此组')}</button>` : ''}</div>
                </div></section>`).join('') || `<p>${tr('没有正则规则')}</p>`, menu);
            const version = dialogs.version;
            selectAll('[data-regex-scope]', modal).forEach(button => button.addEventListener('click', () => {
                if (!current() || dialogs.version !== version) return;
                const scope = button.dataset.regexScope;
                void openCardRegex(target.avatar, regexScopes, { backLabel: tr('返回正则规则'), name: tr(scopes[scope]),
                    read: () => run('regex.list', { scope }),
                    write: (snapshot, index, patch) => run('regex.update', { scope, id: snapshot.scripts[index].id, expectedRevision: snapshot.revision, patch }, true) });
            }));
            selectAll('[data-regex-permission]', modal).forEach(button => button.addEventListener('click', async () => {
                if (!current() || busy || dialogs.version !== version) return;
                const group = groups.find(group => group.scope === button.dataset.regexPermission);
                busy = true;
                try {
                    const approved = await dialogs.confirm({ title: tr(group.allowed ? '停用此组正则？' : '启用此组正则？'), body: tr('正则可以改变显示内容和发送给模型的内容。此操作不修改聊天原文。'), restoreSheet: true });
                    if (approved && current()) await run('regex.permission', { scope: group.scope, enabled: !group.allowed }, true);
                } catch (error) { dialogs.toast(dialogs.normalizeError(error), { tone: 'error' }); }
                finally { busy = false; if (current()) void regexScopes(); }
            }));
        } catch (error) { dialogs.toast(dialogs.normalizeError(error), { tone: 'error' }); }
    }
    async function mvuSettings(reloadRequired = runtimeReloadPending) {
        if (!current() || busy) return;
        const modal = sheet(tr('MVU 设置'), `<div data-mvu-runtime-content>${tr('加载中')}</div>`, menu);
        const version = dialogs.version;
        const alive = () => current() && dialogs.version === version;
        const slot = select('[data-mvu-runtime-content]', modal);
        try {
            const status = await run('mvu.status', {});
            if (!alive()) return;
            const enabled = status.managedRuntimeEnabled !== false;
            slot.innerHTML = `<section class="nora-extension-item"><div class="nora-capability-row"><strong>${tr('内置 MVU 程序')}</strong><span>${enabled ? tr('已启用') : tr('已停用')}</span></div><p class="nora-model-note">${tr('此开关影响所有世界；更改后需要刷新页面。不会修改卡片自带的脚本。')}</p><p class="nora-model-note">${reloadRequired ? tr('设置已保存，请刷新页面后继续使用。') : status.runtimeAvailable ? tr('运行时已加载') : tr('运行时未加载')}</p><button class="nora-extension-action" data-mvu-runtime-toggle type="button">${enabled ? tr('停用内置 MVU') : tr('启用内置 MVU')}</button></section><section class="nora-extension-item"><strong>${tr('变量更新方式与模型')}</strong><p class="nora-model-note">${tr('关闭额外模型仅切换为正文解析，不会关闭 MVU 程序。模型设置为全局配置，卡片规则可能覆盖部分设置。')}</p><button class="nora-secondary" data-mvu-model-settings type="button" ${!status.runtimeAvailable || reloadRequired ? 'disabled' : ''}>${tr('配置更新方式与模型')}</button></section>`;
            select('[data-mvu-model-settings]', modal)?.addEventListener('click', () => { if (alive() && !busy) openModelSheet(() => mvuSettings(), { mvuOnly: true, backLabel: tr('返回 MVU 设置') }); });
            select('[data-mvu-runtime-toggle]', modal)?.addEventListener('click', async () => {
                if (!alive() || busy) return;
                busy = true;
                let saved = false;
                let completedVersion;
                try {
                    const approved = await dialogs.confirm({ title: enabled ? tr('停用内置 MVU？') : tr('启用内置 MVU？'), body: tr('此操作影响所有世界。停用后依赖内置 MVU 的卡片无法正常更新变量。更改后需要刷新页面；不会自动发送消息或修改卡片。'), restoreSheet: true });
                    completedVersion = dialogs.version;
                    if (approved && current() && slot.isConnected !== false) {
                        await run('mvu.runtime', { enabled: !enabled }, true);
                        runtimeReloadPending = true;
                        saved = true;
                    }
                } catch (error) { dialogs.toast(dialogs.normalizeError(error), { tone: 'error' }); } finally {
                    busy = false;
                    if (current() && slot.isConnected !== false && dialogs.version === completedVersion) void mvuSettings(reloadRequired || saved);
                }
            });
        } catch (error) {
            if (!alive()) return;
            slot.innerHTML = `<p class="nora-model-note" role="alert">${esc(dialogs.normalizeError(error))}</p><button class="nora-secondary" data-mvu-runtime-retry type="button">${tr('重试')}</button>`;
            select('[data-mvu-runtime-retry]', modal)?.addEventListener('click', () => mvuSettings(reloadRequired));
        }
    }
    function template() {
        if (!current()) return;
        const failed = activeWorldModel()?.capabilities?.items?.prompt_template?.status === 'DEGRADED';
        const modal = sheet(tr('提示词模板'), `<section class="nora-extension-item"><div class="nora-capability-row"><span>${tr('提示词模板')}</span><span>${state('prompt_template')}</span></div><p class="nora-model-note">${tr('模板随当前世界加载，此处显示运行状态。')}</p>${failed ? `<button data-template-retry class="nora-secondary" type="button">${tr('重试')}</button>` : ''}</section>`, menu);
        select('[data-template-retry]', modal)?.addEventListener('click', async () => {
            if (busy || !current()) return;
            const version = dialogs.version;
            busy = true;
            try { await retryCapability(target.worldId, 'prompt_template'); renderPanel(); } catch (error) { dialogs.toast(dialogs.normalizeError(error), { tone: 'error' }); } finally { busy = false; if (current() && dialogs.version === version) template(); }
        });
    }
    async function scripts(importImmediately = false) {
        if (!current() || busy) return;
        const modal = sheet(tr('脚本管理'), `<div data-script-content aria-live="polite">${tr('加载中')}</div>`, menu);
        const version = dialogs.version;
        const alive = () => current() && dialogs.version === version;
        const slot = select('[data-script-content]', modal);
        let groups;
        try {
            groups = await Promise.all(scriptScopes().map(async scope => ({ scope, ...await run('scripts.list', { scope }) })));
        } catch (error) {
            if (alive()) {
                slot.innerHTML = `<p class="nora-model-note">${esc(dialogs.normalizeError(error))}</p><button data-script-reload class="nora-secondary" type="button">${tr('重试')}</button>`;
                select('[data-script-reload]', modal)?.addEventListener('click', () => { if (alive()) void scripts(); });
            }
            return;
        }
        if (!alive()) return;
        const entries = new Map();
        const managedRuntimeEnabled = groups.some(group => group.trees.some(item => item.id === managedId && item.enabled !== false));
        const takenOver = item => item.managedByNora && item.enabled === false && managedRuntimeEnabled;
        const rows = (items, group, parentEnabled = true, nested = false) => items.filter(item => item.id !== managedId).map(item => {
            const key = `${group.scope}:${item.id}`;
            entries.set(key, { item, group, parentEnabled });
            if (takenOver(item)) {
                return `<div class="nora-script-item"><div class="nora-script-line"><div class="nora-script-name">${esc(item.name || 'MVU')}</div><button class="nora-script-view" data-script-inspect="${attr(item.id)}" data-script-key="${attr(key)}" type="button">${tr('查看')}</button><span class="nora-script-state">${tr('内置接管')}</span></div></div>`;
            }
            const enabled = item.enabled !== false;
            const status = !enabled ? tr('已停用') : !parentEnabled ? tr('父文件夹已停用') : !group.enabled ? tr('待许可') : tr('已启用');
            const blocked = !parentEnabled && !enabled;
            const label = enabled ? tr('停用') : tr('启用');
            return `<div class="nora-script-item${nested ? ' is-nested' : ''}"><div class="nora-script-line"><div class="nora-script-name">${esc(item.name || tr('未命名脚本'))}${item.type === 'folder' ? ` · ${tr('文件夹')}` : ''}</div><button class="nora-script-view" data-script-inspect="${attr(item.id)}" data-script-key="${attr(key)}" type="button">${tr('查看')}</button><span class="nora-script-state">${status}</span><div class="nora-script-row-actions">${enabled && parentEnabled && !group.enabled ? `<button class="nora-extension-action" data-script-activate="${attr(key)}" type="button">${tr('允许运行')}</button>` : ''}<button class="nora-extension-action" data-script-toggle="${attr(item.id)}" data-script-key="${attr(key)}" type="button" ${blocked ? `disabled title="${tr('请先启用父文件夹')}"` : ''}>${label}</button></div></div>${item.scripts ? rows(item.scripts, group, parentEnabled && enabled, true) : ''}</div>`;
        }).join('');
        const sections = groups.map(group => {
            const content = rows(group.trees, group);
            return content ? `<section class="nora-script-group"><h3>${tr({ character: '本世界脚本', preset: '当前预设脚本', global: '全局脚本' }[group.scope])}</h3>${content}</section>` : '';
        }).join('');
        slot.innerHTML = `<div class="nora-script-list">${sections || `<p class="nora-model-note">${tr('当前没有可管理的脚本')}</p>`}</div><footer class="nora-script-footer"><button class="nora-secondary" data-script-import type="button"><span aria-hidden="true">＋</span> ${tr('导入脚本 JSON')}</button></footer>`;
        select('[data-script-import]', modal)?.addEventListener('click', () => { if (alive() && !busy) importScript(); });
        async function change(group, action, params, title, body, details = []) {
            if (!alive() || busy) return;
            busy = true;
            let completedVersion;
            try {
                const approved = await dialogs.confirm({ title, body, details, detailsLabel: tr('受影响的脚本'), restoreSheet: true });
                completedVersion = dialogs.version;
                if (approved && current() && slot.isConnected !== false) {
                    await run(action, { scope: group.scope, expectedRevision: group.revision, ...params }, true);
                    dialogs.toast(tr('已保存'));
                }
            } catch (error) { dialogs.toast(dialogs.normalizeError(error), { tone: 'error' }); } finally {
                busy = false;
                if (current() && slot.isConnected !== false && dialogs.version === completedVersion) void scripts();
            }
        }
        function toggle(key, activate = false) {
            const entry = entries.get(key);
            if (!entry || !alive() || busy) return;
            const { item, group, parentEnabled } = entry;
            const enabled = activate || item.enabled === false;
            if (enabled && !parentEnabled) return;
            const allowing = enabled && !group.enabled;
            const affected = (items, parent = true) => items.flatMap(child => {
                const runs = parent && (child.id === item.id ? enabled : child.enabled !== false);
                return child.type === 'folder' ? affected(child.scripts || [], runs) : runs ? [child.name || tr('未命名脚本')] : [];
            });
            const body = [
                group.scope === 'global' ? tr('此操作会影响所有世界。') : tr('此操作只修改当前世界。'),
                allowing ? tr('需要开启这组脚本的运行许可；以下已启用脚本也会获得运行许可，不只是所点的一条。') : tr('启用会执行脚本代码。停用不撤销脚本此前造成的数据修改。'),
                t`目标脚本：${item.name || tr('未命名脚本')}`,
            ].join('\n');
            void change(group, allowing ? 'scripts.activate' : 'scripts.enabled', { id: item.id, ...(allowing ? {} : { enabled }) }, tr('更改脚本状态？'), body, allowing ? affected(group.trees) : []);
        }
        selectAll('[data-script-toggle]', modal).forEach(button => button.addEventListener('click', () => toggle(button.dataset.scriptKey)));
        selectAll('[data-script-activate]', modal).forEach(button => button.addEventListener('click', () => toggle(button.dataset.scriptActivate, true)));
        selectAll('[data-script-inspect]', modal).forEach(button => button.addEventListener('click', async () => {
            if (!alive() || busy) return;
            const { group, item: selected } = entries.get(button.dataset.scriptKey);
            try {
                const result = await run('scripts.inspect', { scope: group.scope, id: selected.id });
                if (!alive()) return;
                const item = result.script;
                sheet(tr('脚本详情'), `<h3 class="nora-script-title">${esc(item.name || tr('未命名脚本'))}</h3><p class="nora-model-note">${tr(scopes[group.scope])}</p>${takenOver(selected) ? `<p class="nora-model-note">${tr('由内置 MVU 提供；原脚本保留')}</p>` : ''}${item.info ? `<p class="nora-model-note">${esc(item.info)}</p>` : ''}<p class="nora-model-note">${tr('仅查看源代码，不会执行。')}</p><textarea class="nora-regex-code" rows="12" readonly spellcheck="false" aria-label="${tr('脚本源码')}">\n${esc(item.type === 'folder' ? JSON.stringify(item, null, 2) : item.content || '')}</textarea>`, () => void scripts());
            } catch (error) { if (alive()) dialogs.toast(dialogs.normalizeError(error), { tone: 'error' }); }
        }));
        function importScript() {
            const importModal = sheet(tr('导入脚本 JSON'), `<section class="nora-script-import-form"><p class="nora-model-note">${tr('支持酒馆助手脚本或文件夹。导入后保持停用，不覆盖现有内容。')}</p><label>${tr('导入位置')}<select data-script-destination><option value="character">${tr('本世界')}</option><option value="global">${tr('用于所有世界')}</option></select></label><p class="nora-model-note">${tr('全局脚本会影响所有世界。')}</p><button class="nora-secondary" data-choose-script type="button">${tr('选择 JSON 文件')}</button><input data-script-file type="file" hidden accept=".json,application/json"></section>`, scripts);
            const importForm = select('.nora-script-import-form', importModal);
            let importVersion = dialogs.version;
            const importAlive = () => current() && dialogs.version === importVersion;
            select('[data-choose-script]', importModal)?.addEventListener('click', () => { if (importAlive() && !busy) select('[data-script-file]', importModal)?.click(); });
            select('[data-script-file]', importModal)?.addEventListener('change', async event => {
                const file = event.target.files?.[0]; event.target.value = '';
                if (!file || !importAlive() || busy) return;
                const scope = select('[data-script-destination]', importModal)?.value === 'global' ? 'global' : 'character';
                const group = groups.find(item => item.scope === scope);
                busy = true;
                try {
                    if (file.size > 240000) throw new Error(tr('脚本文件过大，请使用小于 240 KB 的文件。'));
                    const tree = prepareScriptImport(JSON.parse(await file.text()));
                    if (!importAlive()) return;
                    const count = tree.type === 'folder' ? tree.scripts.length : 1;
                    const approved = await dialogs.confirm({ title: tr('导入脚本？'), body: t`将「${tree.name || file.name}」导入「${tr(scopes[scope])}」，共 ${count} 个脚本。导入后保持停用，不覆盖同名内容。`, restoreSheet: true });
                    importVersion = dialogs.version;
                    if (approved && current() && importForm.isConnected !== false) {
                        await run('scripts.import', { scope, expectedRevision: group.revision, tree }, true);
                        dialogs.toast(tr('已保存'));
                        busy = false;
                        if (current() && importForm.isConnected !== false) void scripts();
                    }
                } catch (error) { if (current()) dialogs.toast(dialogs.normalizeError(error), { tone: 'error' }); } finally { busy = false; }
            });
        }
        if (importImmediately) importScript();
    }
    return Object.freeze({ open() {
        if (busy) return;
        target = { worldId: activeWorldModel()?.id || null, name: activeWorldModel()?.name || '', avatar: currentCharacter()?.avatar, sessionId: session() };
        menu();
    } });
}

export function createLedgerRequest({ requestHeaders, fetchImpl = (...args) => fetch(...args) }) {
    return async (action, scope, params = {}) => {
        if (!['inspect', 'configure'].includes(action)) throw new Error('Unsupported ledger action');
        const response = await fetchImpl(`/api/nora-story-ledger/${action}`, {
            method: 'POST', headers: requestHeaders(), cache: 'no-store',
            body: JSON.stringify({ ...params, ...scope }), signal: AbortSignal.timeout(15000),
        });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.error || tr('压缩失败')), { code: result.code });
        return result;
    };
}
