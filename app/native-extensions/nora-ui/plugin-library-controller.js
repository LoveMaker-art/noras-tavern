import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { validatePluginRepository } from '../../engine/sillytavern/public/scripts/nora-controls/plugin-library-actions.js';
import { pluginCatalog, pluginLibraryStatus } from '../../engine/sillytavern/public/scripts/nora-controls/plugin-catalog.js';
export { validatePluginRepository, pluginLibraryStatus };

function needsReload(item, runtime) {
    return typeof item.libraryEnabled === 'boolean' && (runtime ? item.libraryEnabled !== runtime.enabled : item.libraryEnabled);
}

export function createPluginLibraryController({ dialogs, select, selectAll, escapeHtml: esc, headers,
    readRuntime, setBuiltinEnabled, activateBuiltin, openExtensions, isGenerating = () => false, reload = () => location.reload(), fetchImpl = (...args) => fetch(...args) }) {
    let busy = false;
    const pending = new Set();
    const inventoryListeners = new Set();
    const attr = value => esc(String(value)).replaceAll('"', '&quot;');
    async function request(route, body) {
        const response = await fetchImpl(`/api/extensions/${route}`, body ? { method: 'POST', headers: headers(), body: JSON.stringify(body) } : {});
        if (!response.ok) {
            const message = await response.text();
            throw new Error(response.status === 404 && route === 'library' ? tr('插件管理不可用：请检查服务版本或扩展开关。')
                : `${tr('插件操作失败')} (${response.status})：${message.slice(0, 400)}`);
        }
        const text = await response.text();
        try { return JSON.parse(text); } catch { return { message: text }; }
    }
    function sheet(title, content, back) {
        const modal = dialogs.open(tr(title), `<div class="nora-plugin-library">${content}</div>`, 'nora-detail-modal nora-plain-sheet nora-extensions-modal', { back: back ? () => { if (!busy) void back(); } : undefined });
        dialogs.setCloseGuard(() => !busy);
        return modal;
    }
    function fail(error) { dialogs.toast(String(error?.message || error), { tone: 'error', duration: 6000 }); }
    async function catalog() {
        const library = await request('library');
        return pluginCatalog(library.items);
    }
    async function inventory() {
        const installed = await catalog();
        let runtime = {}, runtimeReadFailed = false;
        try { runtime = await readRuntime(); } catch { runtimeReadFailed = true; }
        const items = installed.map(item => ({ ...item, runtime: runtime[item.name], runtimeReadFailed,
            status: pluginLibraryStatus({ ...item, runtimeReadFailed }, runtime[item.name], pending.has(item.name)) }));
        inventoryListeners.forEach(listener => listener(items));
        return items;
    }
    function reloadButton(modal) {
        select('[data-plugin-reload]', modal)?.addEventListener('click', async () => {
            if (busy) return;
            if (isGenerating()) return fail(new Error(tr('请等本轮生成和保存结束后再刷新。')));
            busy = true;
            try {
                if (await dialogs.confirm({ title: tr('刷新以应用插件变更？'), body: tr('请先保存其他页面中的编辑内容。已运行的插件会在刷新后重新加载。'), restoreSheet: true }) && !isGenerating()) reload();
            } finally { busy = false; }
        });
    }
    async function open() {
        if (busy) return;
        const modal = sheet('插件库', `<p role="status">${tr('加载中')}</p>`);
        const version = dialogs.version;
        try {
            const installed = await inventory();
            if (dialogs.version !== version) return;
            const row = item => `<button class="nora-extension-entry" data-plugin="${attr(item.name)}" type="button"><span><strong>${esc(item.builtin ? tr(item.builtin.title) : item.displayName)}</strong><small>${tr(item.status)}</small></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
            select('.nora-plugin-library', modal).innerHTML = `<div class="nora-plugin-toolbar"><button class="nora-secondary" data-plugin-install type="button"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${tr('安装插件')}</button>${pending.size ? `<button class="nora-secondary" data-plugin-reload type="button">${tr('刷新应用变更')}</button>` : ''}</div>
                ${installed.some(item => item.builtin) ? `<section><h3>${tr('内置插件')}</h3>${installed.filter(item => item.builtin).map(row).join('')}</section>` : ''}
                <section><h3>${tr('自行安装')}</h3>${installed.filter(item => !item.builtin).map(row).join('') || `<p class="nora-extension-empty">${tr('尚未安装第三方插件')}</p>`}</section>`;
            select('[data-plugin-install]', modal).addEventListener('click', install);
            selectAll('[data-plugin]', modal).forEach(button => button.addEventListener('click', () => { if (!busy) { const item = installed.find(item => item.name === button.dataset.plugin); detail(item, item.runtime); } }));
            reloadButton(modal);
        } catch (error) {
            if (dialogs.version !== version) return;
            select('.nora-plugin-library', modal).innerHTML = `<p role="alert">${esc(error.message)}</p><button class="nora-secondary" data-plugin-retry type="button">${tr('重试')}</button>`;
            select('[data-plugin-retry]', modal).addEventListener('click', open);
        }
    }
    async function manage(item, { back, openSettings, isCurrent = () => true } = {}) {
        if (busy) return;
        sheet('扩展设置', `<p role="status">${tr('加载中')}</p>`, back);
        const version = dialogs.version;
        try {
            const runtime = await readRuntime();
            if (dialogs.version !== version || !isCurrent()) return;
            if (needsReload(item, runtime[item.name])) pending.add(item.name);
            detail(item, runtime[item.name], { back, openSettings, isCurrent });
        } catch (error) {
            if (dialogs.version === version && isCurrent()) {
                const modal = sheet('扩展设置', `<p role="alert">${esc(error.message)}</p><button class="nora-secondary" data-plugin-retry type="button">${tr('重试')}</button>`, back);
                select('[data-plugin-retry]', modal).addEventListener('click', () => { if (isCurrent()) void manage(item, { back, openSettings, isCurrent }); });
            }
        }
    }
    function detail(item, runtime, management) {
        const enabled = item.libraryEnabled ?? runtime?.enabled ?? false;
        const current = () => !management || management.isCurrent();
        const back = management?.back || open;
        const builtinToggle = ['tavern_helper', 'prompt_template'].includes(item.builtin?.key) && setBuiltinEnabled;
        const canToggle = management && (item.editable || builtinToggle) && typeof (item.libraryEnabled ?? runtime?.enabled) === 'boolean';
        const helper = item.builtin?.key === 'tavern_helper';
        const settingsBlocked = helper && (!enabled || pending.has(item.name));
        const button = (action, label) => `<button class="nora-secondary" data-plugin-action="${action}" type="button">${tr(label)}</button>`;
        const modal = sheet(management ? '扩展设置' : '插件详情', `<h3>${esc(item.builtin ? tr(item.builtin.title) : item.displayName)}</h3><p class="nora-model-note">${esc(item.version || '')}${item.author ? ` · ${esc(item.author)}` : ''}</p>
            <p>${tr('页面加载状态')}：${tr(pluginLibraryStatus(item, runtime, pending.has(item.name)))}</p>
            ${management && runtime?.error ? `<p role="alert">${esc(runtime.error)}</p>` : ''}
            <p class="nora-model-note">${tr(item.builtin ? '内置插件随诺拉更新，不能单独卸载。' : '兼容性未验证：加载成功不代表所有功能可用。')}</p>
            ${canToggle ? `<p class="nora-model-note">${tr('此开关影响所有世界，刷新后生效；不会更改单条脚本或规则的开关。')}</p>` : ''}
            ${item.builtin ? `<p class="nora-model-note">${esc(tr(item.builtin.description))}</p>` : `<dl><dt>${tr('标识')}</dt><dd>${esc(item.name)}</dd><dt>${tr('来源')}</dt><dd>${esc(item.source || tr('未记录仓库地址'))}</dd></dl>`}
            ${item.type === 'global' ? `<p class="nora-model-note">${tr('管理员共享安装，请联系管理员管理。')}</p>` : ''}
            <div class="nora-plugin-toolbar">${canToggle ? button('state', enabled ? '停止全局加载' : '允许全局加载') : ''}
            ${!management && item.editable ? `${item.repository ? button('update', '更新') : ''}${button('delete', '卸载')}` : ''}
            ${management?.openSettings ? `<button class="nora-secondary" data-plugin-settings type="button" ${settingsBlocked ? 'disabled' : ''}>${tr(helper ? '脚本管理' : '功能设置')}</button>` : ''}
            ${!management && openExtensions ? `<button class="nora-secondary" data-plugin-management type="button">${tr('前往扩展管理')}</button>` : ''}</div>
            ${pending.size ? `<button class="nora-secondary" data-plugin-reload type="button">${tr('刷新应用变更')}</button>` : ''}`, back);
        select('[data-plugin-settings]', modal)?.addEventListener('click', async () => {
            if (busy || !current() || modal.isConnected === false || settingsBlocked) return;
            if (!helper || runtime?.loaded) return management.openSettings();
            if (!activateBuiltin) return fail(new Error(tr('酒馆助手尚未加载，请稍后重试。')));
            if (isGenerating()) return fail(new Error(tr('请等本轮生成和保存结束后再操作插件。')));
            busy = true;
            let version;
            try {
                const accepted = await dialogs.confirm({ title: tr('加载酒馆助手？'),
                    body: tr('打开脚本管理需要加载酒馆助手，已授权且开启的脚本可能执行。不会自动发送聊天或修改脚本开关。'), restoreSheet: true });
                version = dialogs.version;
                if (!accepted || !current() || modal.isConnected === false || isGenerating()) return;
                await activateBuiltin(item.name);
                if (version === dialogs.version && current()) management.openSettings();
            } catch (error) { fail(error); }
            finally { busy = false; }
        });
        select('[data-plugin-management]', modal)?.addEventListener('click', () => { if (!busy) openExtensions(); });
        reloadButton(modal);
        selectAll('[data-plugin-action]', modal).forEach(button => button.addEventListener('click', async () => {
            if (!current() || modal.isConnected === false) return;
            if (busy || isGenerating()) return fail(new Error(tr('请等本轮生成和保存结束后再操作插件。')));
            busy = true;
            const action = button.dataset.pluginAction;
            const title = action === 'delete' ? '卸载插件？' : action === 'update' ? '更新插件？' : enabled ? '停止全局加载？' : '允许全局加载此插件？';
            const body = action === 'delete' ? '将删除插件目录及其中的文件，不删除聊天或独立保存的插件设置。刷新后停止运行。'
                : action === 'update' ? '将从该插件的仓库更新代码。已启用的插件会在刷新后执行新版代码；请确认你信任该来源。'
                    : enabled ? '停用影响所有世界；已运行的脚本需要刷新才能退出。'
                        : '第三方代码可读取页面、聊天和配置，并进行网络访问。仅启用你信任的插件；刷新后生效。';
            let version;
            try {
                if (!await dialogs.confirm({ title: tr(title), body: tr(body), restoreSheet: true })) return;
                version = dialogs.version;
                if (!current() || modal.isConnected === false) return;
                if (isGenerating()) throw new Error(tr('请等本轮生成和保存结束后再操作插件。'));
                button.disabled = true;
                button.textContent = tr('正在处理…');
                const result = action === 'state' && builtinToggle
                    ? await setBuiltinEnabled(item.name, !enabled) || {}
                    : await request(action === 'state' ? 'library/state' : action, { extensionName: item.name.replace(/^third-party\//, ''), global: false, ...(action === 'state' ? { enabled: !enabled } : {}) });
                if (action === 'state') item.libraryEnabled = !enabled;
                if (action !== 'update' || !result.isUpToDate) pending.add(item.name);
                if (action === 'update' && result.isUpToDate) dialogs.toast(tr('插件已是最新版本。'));
            } catch (error) { fail(error); }
            finally { busy = false; if (version === dialogs.version && current()) { if (management) void manage(item, management); else void open(); } }
        }));
    }
    function install() {
        if (busy) return;
        const modal = sheet('安装插件', `<form data-plugin-form><label for="nora-plugin-url">${tr('Git 仓库链接')}</label><input id="nora-plugin-url" name="url" type="url" required autocomplete="off" placeholder="https://github.com/author/extension">
            <p class="nora-model-note">${tr('仅支持 ST 前端扩展，不支持服务端插件或酒馆助手脚本 JSON。安装后保持停用，需另行确认启用。')}</p>
            <p data-plugin-error role="alert" hidden></p><button class="nora-secondary" type="submit">${tr('安装并保持停用')}</button></form>`, open);
        const form = select('[data-plugin-form]', modal);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (busy) return;
            let url;
            const errorLabel = select('[data-plugin-error]', modal);
            try { url = validatePluginRepository(select('[name="url"]', modal).value); }
            catch { errorLabel.hidden = false; errorLabel.textContent = tr('请输入不含密钥、参数或片段的 HTTP(S) Git 仓库链接。'); return; }
            busy = true;
            let version;
            try {
                if (!await dialogs.confirm({ title: tr('从此仓库安装？'), body: tr('仓库内容由第三方提供，诺拉未审核其安全性和兼容性。安装不会自动启用插件。'), details: [url], restoreSheet: true })) return;
                version = dialogs.version;
                const submit = select('[type="submit"]', modal);
                submit.disabled = true;
                submit.textContent = tr('正在下载安装…');
                await request('install', { url, global: false, disabled: true });
                dialogs.toast(tr('已安装并保持停用，请在扩展管理中启用。'));
            } catch (error) {
                errorLabel.hidden = false; errorLabel.textContent = error.message;
                select('[type="submit"]', modal).disabled = false;
                select('[type="submit"]', modal).textContent = tr('安装并保持停用');
                return;
            } finally { busy = false; }
            if (version === dialogs.version) void open();
        });
    }
    return { open, catalog, inventory, manage,
        subscribeInventory(listener) { inventoryListeners.add(listener); return () => inventoryListeners.delete(listener); } };
}

export function createRuntimePluginLibrary({ state, loadModule = (...args) => globalThis.__NORA_LOAD_MODULE__(...args), ...options }) {
    return createPluginLibraryController({ ...options,
        setBuiltinEnabled: async (name, enabled) => {
            if (!['third-party/JS-Slash-Runner', 'third-party/ST-Prompt-Template'].includes(name)) throw new Error('Unsupported builtin loading control');
            const extensions = await loadModule('/scripts/extensions.js');
            await (enabled ? extensions.enableExtension(name, false) : extensions.disableExtension(name, false));
        },
        activateBuiltin: async name => {
            if (name !== 'third-party/JS-Slash-Runner') throw new Error('Unsupported explicit activation');
            const extensions = await loadModule('/scripts/extensions.js');
            const loaded = await extensions.activateExtensionNames([name]);
            if (!loaded.includes(name)) throw new Error(tr('酒馆助手加载失败，请检查扩展状态。'));
        },
        readRuntime: async () => {
            await state.whenReady();
            const extensions = await loadModule('/scripts/extensions.js');
            return extensions.getExtensionLibraryRuntime();
        },
    });
}
