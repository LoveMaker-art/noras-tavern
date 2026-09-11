import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { describePreset } from './preset-presentation.js';
import { libraryTabs, beginLibraryView } from './library-tabs.js';
import { normalizeCharacterActivation } from '../../engine/sillytavern/public/scripts/nora-worlds/story-context.js';

export function createLibraryController({ worlds, presets, dialogs, operations, activeWorldModel, isGenerating,
    characterField, openCards, refresh, select: $, selectAll: $$, escapeHtml: html }) {
    const errorToast = error => dialogs.toast(dialogs.normalizeError(error), { tone: 'error', duration: 5000 });
    const busy = () => isGenerating() || operations.isBusy('world') || operations.isBusy('library');
    let presetQuery = '';
    let presetScroll = 0;
    let bookQuery = '';
    const attached = (item, world) => (world?.libraryWorldbooks || []).some(resource =>
        (item.source_key && resource.sourceKey === item.source_key)
        || (item.source.kind === 'book' && resource.name === item.source.name));
    const targetLabel = world => `<span class="nora-library-target">${world ? `${tr('目标世界')}：${html(world.name)}` : tr('尚未进入世界')}</span>`;
    const tabs = libraryTabs('worldbooks');
    const queries = { character: '', persona: '' };
    function bindTabs(modal) {
        $$('[data-library-tab]', modal).forEach(button => button.addEventListener('click', () => {
            const kind = button.dataset.libraryTab;
            return kind === 'cards' ? openCards() : kind === 'worldbooks' ? openWorldbooks() : openProfiles(kind);
        }));
    }

    function openSaveProfile(kind, data = {}, initialName = data.name || '') {
        const modal = dialogs.open(tr('另存到库'), `<form class="nora-form nora-editor-form" data-save-profile><div class="nora-editor-fields">
            <label>${tr('库中名称')}<input name="label" value="${html(initialName)}" maxlength="200" required></label>
            <label>${tr('名字')}<input name="name" value="${html(data.name || '')}" maxlength="500" required></label>
            <label>${tr('介绍')}<textarea name="description" rows="8">${html(data.description || '')}</textarea></label>
            ${kind === 'character' ? `<label>${tr('性格')}<textarea name="personality" rows="4">${html(data.personality || '')}</textarea></label>` : ''}
            ${kind === 'character' ? `<label>${tr('设定类型')}<select name="mode"><option value="constant">${tr('常驻角色')}</option><option value="triggered" ${data.activation?.mode === 'triggered' ? 'selected' : ''}>${tr('触发角色')}</option></select></label><label>${tr('触发关键词（每行一个）')}<textarea name="keys" rows="2">${html((data.activation?.keys || []).join('\n'))}</textarea></label><label class="nora-library-check"><input type="checkbox" name="enabled" ${data.activation?.enabled === false ? '' : 'checked'}>${tr('启用')}</label>` : ''}
            </div><footer class="nora-form-actions nora-editor-toolbar"><button type="button" data-cancel>${tr('取消')}</button><button type="submit" class="nora-primary">${tr('存入库')}</button></footer></form>`, 'nora-detail-modal nora-fixed-editor nora-plain-sheet');
        $('[data-cancel]', modal).addEventListener('click', () => dialogs.close());
        $('[data-save-profile]', modal).addEventListener('submit', async event => {
            event.preventDefault();
            if (operations.isBusy('library')) return;
            const form = event.currentTarget, button = $('button[type="submit"]', form);
            button.disabled = true;
            try {
                const value = { name: form.elements.name.value.trim(), description: form.elements.description.value,
                    ...(kind === 'character' ? { ...(data.profile ? { profile: data.profile } : {}), personality: form.elements.personality.value, activation: { ...data.activation,
                        mode: form.elements.mode.value, keys: form.elements.keys.value.split(/\r?\n/), enabled: form.elements.enabled.checked } } : {}) };
                await operations.run('library', () => worlds.saveLibraryProfile({ kind, name: form.elements.label.value.trim(), data: value }));
                dialogs.close();
                dialogs.toast(tr('已存入库，当前世界未修改。'));
            } catch (error) { errorToast(error); }
            finally { button.disabled = false; }
        });
    }

    async function openProfiles(kind = 'character', target = null) {
        const view = beginLibraryView(dialogs, target);
        try {
            const { items, warnings } = await worlds.listLibraryProfiles(kind);
            if (!view.isCurrent()) return;
            const query = queries[kind].trim().toLocaleLowerCase();
            const matches = items.filter(item => `${item.name} ${item.character_name}`.toLocaleLowerCase().includes(query));
            const modal = view.open(tr(target ? '从库选择' : '世界卡库'), `${target ? targetLabel(target) : libraryTabs(kind)}
                <form class="nora-library-search" data-profile-search><input type="search" name="query" value="${html(queries[kind])}" placeholder="${tr('搜索资料')}"><button type="submit" class="nora-icon-button" title="${tr('搜索')}"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button>
                ${target ? '' : `<button type="button" class="nora-icon-button" data-profile-import title="${tr('导入资料')}"><i class="fa-solid fa-file-import" aria-hidden="true"></i></button><button type="button" class="nora-icon-button" data-profile-new title="${tr('新建资料')}"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>`}</form>
                <div class="nora-library-results nora-library-list">${matches.map(item => `<button type="button" class="nora-library-row" data-profile="${item.id}"><strong>${html(item.name)}</strong><small>${html(item.character_name)}</small></button>`).join('') || `<p class="nora-sheet-empty">${tr(query ? '没有匹配的资料' : '暂无资料')}</p>`}
                ${warnings.length ? `<p role="status">${warnings.length} ${tr('项资料读取失败')}</p>` : ''}</div>`, 'nora-detail-modal nora-world-library-modal nora-plain-sheet');
            bindTabs(modal);
            $('[data-profile-search]', modal).addEventListener('submit', event => {
                event.preventDefault(); queries[kind] = event.currentTarget.elements.query.value; openProfiles(kind, target);
            });
            $('[data-profile-new]', modal)?.addEventListener('click', () => openSaveProfile(kind));
            $('[data-profile-import]', modal)?.addEventListener('click', () => openProfileImport(kind));
            $$('[data-profile]', modal).forEach(button => button.addEventListener('click', () => openProfile(button.dataset.profile, target)));
        } catch (error) { if (view.isCurrent()) errorToast(error); }
    }

    async function openProfile(id, target = null) {
        const world = target || activeWorldModel();
        try {
            const item = await worlds.readLibraryProfile(id);
            const modal = dialogs.open(item.name, `<div class="nora-library-detail-scroll"><button type="button" data-back class="nora-sheet-back">${tr('返回')}</button><h3>${html(item.data.name)}</h3>
                <p class="nora-profile-text">${html(item.data.description)}</p>${item.data.personality ? `<details><summary>${tr('性格')}</summary><p class="nora-profile-text">${html(item.data.personality)}</p></details>` : ''}
                ${item.kind === 'character' ? `<p>${tr(item.data.activation.mode === 'triggered' ? '触发角色' : '常驻角色')} · ${tr(item.data.activation.enabled === false ? '已禁用' : '已启用')}</p>` : ''}
                ${target ? '' : `<details class="nora-library-management"><summary>${tr('管理')}</summary><button type="button" data-save-as>${tr('另存为')}</button><button type="button" data-profile-delete class="nora-setting-delete">${tr('删除')}</button></details>`}</div>
                <footer class="nora-library-footer">${targetLabel(world)}<button type="button" class="nora-primary" data-use ${world ? '' : 'disabled'}>${tr(item.kind === 'persona' ? '替换我的角色' : '添加角色设定')}</button></footer>`, 'nora-detail-modal nora-world-library-modal nora-library-detail-modal nora-plain-sheet');
            $('[data-back]', modal).addEventListener('click', () => openProfiles(item.kind, target));
            $('[data-save-as]', modal)?.addEventListener('click', () => openSaveProfile(item.kind, item.data, `${item.name} ${tr('副本')}`));
            if (!target) {
                $('.nora-library-management', modal)?.insertAdjacentHTML?.('beforeend', `<button type="button" data-export-profile>${tr('导出 JSON')}</button>`);
                $('[data-export-profile]', modal)?.addEventListener('click', () => {
                    const url = URL.createObjectURL(new Blob([JSON.stringify({ schema: item.schema, kind: item.kind, name: item.name, data: item.data }, null, 2)], { type: 'application/json' }));
                    const link = document.createElement('a'); link.href = url; link.download = `${item.name.replace(/[/\\:*?"<>|]/g, '_')}.json`;
                    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
                });
            }
            $('[data-profile-delete]', modal)?.addEventListener('click', async event => {
                if (!await dialogs.confirm({ title: tr('删除库中资料？'), body: tr('已添加到世界的副本保持不变。'), confirmLabel: tr('删除'), restoreSheet: true })) return;
                try {
                    await operations.run('library', () => worlds.deleteLibraryProfile(id, item.revision));
                    await openProfiles(item.kind);
                } catch (error) { errorToast(error); }
            });
            $('[data-use]', modal).addEventListener('click', async event => {
                if (!world || busy()) return dialogs.toast(tr('请等待当前生成或保存完成。'));
                if (activeWorldModel()?.id !== world.id) return dialogs.toast(tr('当前世界已改变，请重新打开选择器。'));
                if (item.kind === 'character') return openRoleImport({ name: item.data.name, data: item.data }, world);
                if (!await dialogs.confirm({ title: tr('替换我的角色？'), body: `${world.name}：${tr('替换玩家名字和描述，其他世界保持不变。')}`, confirmLabel: tr('替换'), restoreSheet: true })) return;
                if (busy() || activeWorldModel()?.id !== world.id) return dialogs.toast(tr('当前状态已改变，请重新打开选择器。'));
                const button = event.currentTarget; button.disabled = true;
                try {
                    await operations.run('world', async () => {
                        if (isGenerating() || activeWorldModel()?.id !== world.id) throw new Error(tr('当前世界已改变。'));
                        await worlds.updateActive({ persona: { ...item.data } }, { expectedRevision: world.revision });
                    });
                    dialogs.close(); refresh(); dialogs.toast(tr('我的角色已替换。'));
                } catch (error) { if (error.saved) { dialogs.close(); refresh(); } errorToast(error); }
                finally { button.disabled = false; }
            });
        } catch (error) { errorToast(error); }
    }

    function openProfileImport(kind) {
        const modal = dialogs.open(tr('导入资料'), `<form class="nora-form" data-profile-file><input type="file" name="file" accept=".json" required><button type="submit">${tr('预览')}</button></form>`);
        $('[data-profile-file]', modal).addEventListener('submit', async event => {
            event.preventDefault();
            try {
                const file = event.currentTarget.elements.file.files[0];
                if (!file || file.size > 1024 * 1024) throw new Error(tr('请选择不超过 1 MB 的资料 JSON。'));
                const item = JSON.parse(await file.text());
                if (item.kind !== kind || item.schema !== 1 || !item.data) throw new Error(tr('资料类型不匹配，请选择对应分类的资料文件。'));
                openSaveProfile(kind, item.data, item.name);
            } catch (error) { errorToast(error); }
        });
    }

    function openSaveBook(name, book) {
        const snapshot = structuredClone(book);
        const modal = dialogs.open(tr('另存世界书'), `<form class="nora-form" data-save-book><label>${tr('库中名称')}<input name="name" value="${html(name || '')}" required maxlength="200"></label><p>${Object.keys(snapshot.entries || {}).length} ${tr('条目')}</p><button type="submit" class="nora-primary">${tr('存入库')}</button></form>`);
        $('[data-save-book]', modal).addEventListener('submit', async event => {
            event.preventDefault();
            if (operations.isBusy('library')) return;
            const form = event.currentTarget, button = $('button[type="submit"]', form); button.disabled = true;
            try {
                await operations.run('library', () => worlds.saveLibraryWorldbook(form.elements.name.value.trim(), snapshot));
                dialogs.close(); dialogs.toast(tr('已存入库，当前世界未修改。'));
            } catch (error) { errorToast(error); }
            finally { button.disabled = false; }
        });
    }

    async function commit(world, input, button) {
        if (busy()) return dialogs.toast(tr('请等待当前生成或保存完成。'));
        if (!world || activeWorldModel()?.id !== world.id) return dialogs.toast(tr('当前世界已改变，请重新打开导入预览。'));
        button.disabled = true;
        try {
            await operations.run('world', async () => {
                if (isGenerating() || activeWorldModel()?.id !== world.id) throw new Error(tr('当前状态已改变，请重新打开导入预览。'));
                await worlds.importLibraryItem(world.id, { ...input, expected_revision: world.revision });
            });
            dialogs.close();
            refresh();
            dialogs.toast(tr('已添加到当前世界。'));
        } catch (error) {
            if (error.saved) { dialogs.close(); refresh(); }
            errorToast(error);
        } finally { button.disabled = false; }
    }

    async function openRoleImport(character, target = null) {
        const world = target || activeWorldModel();
        if (!world) return dialogs.toast(tr('请先进入一个世界。'));
        let book = null;
        const source = character.data?.character_book?.entries
            ? { kind: 'card', name: character.avatar }
            : character.data?.extensions?.world ? { kind: 'book', name: character.data.extensions.world } : null;
        if (source) {
            try { book = await worlds.readLibraryWorldbook(source); }
            catch (error) { errorToast(error); }
        }
        const bookAttached = book && attached(book, world);
        const activation = normalizeCharacterActivation(character.data?.activation);
        const modal = dialogs.open(tr('添加角色设定'), `<form class="nora-form nora-editor-form" data-library-role><div class="nora-editor-fields">
            ${targetLabel(world)}
            <label>${tr('角色名')}<input name="name" required maxlength="500" value="${html(character.name || '')}"></label>
            <label>${tr('角色介绍')}<textarea name="description" rows="6">${html(characterField(character, 'description') || '')}</textarea></label>
            <label>${tr('性格')}<textarea name="personality" rows="4">${html(characterField(character, 'personality') || '')}</textarea></label>
            <label>${tr('设定类型')}<select name="mode"><option value="constant" ${activation.mode === 'constant' ? 'selected' : ''}>${tr('常驻角色')}</option><option value="triggered" ${activation.mode === 'triggered' ? 'selected' : ''}>${tr('触发角色')}</option></select></label>
            <label>${tr('触发关键词（每行一个）')}<textarea name="keys" rows="2">${html(activation.keys.join('\n'))}</textarea></label>
            <label class="nora-library-check"><input type="checkbox" name="enabled" ${activation.enabled === false ? '' : 'checked'}>${tr('启用')}</label>
            ${book ? bookAttached ? `<p class="nora-library-target">${html(book.name)} · ${tr('已添加')}</p>` : `<label class="nora-library-check"><input type="checkbox" name="withBook">${tr('同时添加世界书')} · ${html(book.name)} (${book.count})</label>` : ''}</div>
            <div class="nora-form-actions nora-editor-toolbar"><span class="nora-editor-toolbar-spacer"></span><button type="button" data-cancel>${tr('取消')}</button><button class="nora-primary" type="submit">${tr('添加角色设定')}</button></div>
            </form>`, 'nora-detail-modal nora-fixed-editor nora-plain-sheet');
        const characterId = `character:${crypto.randomUUID()}`;
        $('[data-cancel]', modal).addEventListener('click', () => dialogs.close());
        $('[data-library-role]', modal).addEventListener('submit', async event => {
            event.preventDefault();
            const form = event.currentTarget;
            const patch = { name: form.elements.name.value.trim(), description: form.elements.description.value,
                ...(character.data?.profile ? { profile: structuredClone(character.data.profile) } : {}),
                personality: form.elements.personality.value, activation: { ...activation, mode: form.elements.mode?.value || activation.mode,
                    keys: form.elements.keys ? form.elements.keys.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : activation.keys,
                    enabled: form.elements.enabled ? form.elements.enabled.checked : activation.enabled !== false } };
            if (!patch.name) return;
            if (patch.activation.mode === 'triggered' && !patch.activation.keys.length) return dialogs.toast(tr('触发角色至少需要一个关键词。'));
            const withBook = book && !bookAttached && form.elements.withBook?.checked;
            await commit(world, { character: { id: characterId, operation: 'create', patch },
                ...(withBook ? { source: book.source, source_revision: book.revision } : {}) }, $('button[type="submit"]', form));
        });
    }

    async function openBook(source, target = null) {
        try {
            const world = target || activeWorldModel();
            const item = await worlds.readLibraryWorldbook(source);
            const alreadyAttached = attached(item, world);
            const rows = Object.values(item.book.entries).map(entry => `<details class="nora-library-book-entry"><summary>${html(entry.comment || tr('未命名条目'))}<small>${entry.disable ? tr('已禁用') : tr('已启用')}</small></summary><p>${html(entry.content)}</p></details>`).join('');
            const modal = dialogs.open(item.name, `<div class="nora-library-detail-scroll"><button type="button" class="nora-sheet-back" data-back>${tr('返回世界书库')}</button><p class="nora-library-target">${item.count} ${tr('条目')}${source.kind === 'card' ? ` · ${tr('来自角色卡')} ${html(item.source_name || '')}` : ''}</p>${rows || `<p>${tr('暂无条目')}</p>`}<details class="nora-library-management"><summary>${tr('来源文件')}</summary><p>${html(source.name)}</p></details></div>
                <footer class="nora-library-footer">${targetLabel(world)}<button type="button" class="nora-primary" data-attach ${world && !alreadyAttached ? '' : 'disabled'}>${tr(alreadyAttached ? '已添加' : '添加到当前世界')}</button></footer>`, 'nora-detail-modal nora-world-library-modal nora-library-detail-modal nora-plain-sheet');
            $('[data-back]', modal).addEventListener('click', () => openWorldbooks(target));
            const management = $('.nora-library-management', modal);
            if (!target && management) {
                management.insertAdjacentHTML?.('beforeend', `<button type="button" data-save-book-copy>${tr('另存独立世界书')}</button>`);
                $('[data-save-book-copy]', modal)?.addEventListener('click', () => openSaveBook(item.name, item.book));
            }
            $('[data-attach]', modal).addEventListener('click', event => { if (!alreadyAttached) return commit(world, { source, source_revision: item.revision }, event.currentTarget); });
        } catch (error) { errorToast(error); }
    }

    async function openWorldbooks(target = null) {
        const view = beginLibraryView(dialogs, target);
        try {
            const { items, warnings } = await worlds.listLibraryWorldbooks();
            if (!view.isCurrent()) return;
            const world = activeWorldModel();
            const query = bookQuery.trim().toLocaleLowerCase();
            const matches = items.map((item, index) => ({ item, index })).filter(({ item }) => `${item.name} ${item.source_name || ''}`.toLocaleLowerCase().includes(query));
            const modal = view.open(tr('世界卡库'), `${tabs}<form class="nora-library-search" data-book-search-form><input type="search" data-book-search value="${html(bookQuery)}" placeholder="${tr('搜索世界书或来源角色')}" aria-label="${tr('搜索世界书或来源角色')}"><button class="nora-icon-button" type="submit" title="${tr('搜索')}" aria-label="${tr('搜索')}"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button><button class="nora-icon-button" type="button" data-import title="${tr('导入世界书')}" aria-label="${tr('导入世界书')}"><i class="fa-solid fa-file-import" aria-hidden="true"></i></button></form><div class="nora-library-results"><div class="nora-library-list">${matches.map(({ item, index }) => `<button type="button" class="nora-library-row" data-book="${index}"><strong>${html(item.name)}</strong><small>${item.count} ${tr('条目')} · ${item.source.kind === 'card' ? `${tr('来自角色卡')} ${html(item.source_name || '')}` : tr('独立世界书')}${attached(item, world) ? ` · ${tr('已添加')}` : ''}</small></button>`).join('') || `<p class="nora-sheet-empty" role="status">${tr(query ? '没有匹配的世界书' : '暂无世界书')}</p>`}</div>${warnings.length ? `<details class="nora-library-management"><summary>${warnings.length} ${tr('个来源读取失败')}</summary>${warnings.map(item => `<p>${html(item.source.name)}: ${html(item.message)}</p>`).join('')}</details>` : ''}</div>`, 'nora-detail-modal nora-world-library-modal nora-plain-sheet');
            $('[data-book-search-form]', modal)?.addEventListener('submit', event => {
                event.preventDefault();
                bookQuery = $('[data-book-search]', modal).value;
                openWorldbooks(target);
            });
            bindTabs(modal);
            if (target) { $('.nora-library-tabs', modal)?.remove?.(); $('[data-import]', modal)?.remove?.(); }
            $('[data-import]', modal)?.addEventListener('click', () => openJsonImport('book'));
            $$('[data-book]', modal).forEach(button => button.addEventListener('click', () => openBook(items[Number(button.dataset.book)].source, target)));
        } catch (error) { if (view.isCurrent()) errorToast(error); }
    }

    async function openPresets() {
        try {
            const library = presets.listPresets();
            const modal = dialogs.open(tr('预设库'), `<div class="nora-preset-search"><input type="search" data-preset-search value="${html(presetQuery)}" placeholder="${tr('搜索预设')}" aria-label="${tr('搜索预设')}"><button class="nora-icon-button" type="button" data-import title="${tr('导入预设')}" aria-label="${tr('导入预设')}"><i class="fa-solid fa-file-import" aria-hidden="true"></i></button></div><div class="nora-preset-results" data-preset-results></div>`, 'nora-preset-modal nora-preset-list-modal nora-plain-sheet');
            const importButton = $('[data-import]', modal);
            $('.nora-sheet > header', modal)?.insertBefore(importButton, $('.nora-modal-close', modal));
            $('[data-import]', modal).addEventListener('click', () => openJsonImport('preset'));
            const results = $('[data-preset-results]', modal);
            const render = () => {
                const query = presetQuery.trim().toLocaleLowerCase();
                const items = library.items.map((item, index) => ({ item, index })).filter(({ item }) => item.name.toLocaleLowerCase().includes(query));
                results.innerHTML = items.map(({ item, index }) => `<button type="button" class="nora-preset-row${item.name === library.selected ? ' is-current' : ''}" data-preset="${index}" ${item.name === library.selected ? 'aria-current="true"' : ''}><strong>${html(item.name)}</strong><span>${item.name === library.selected ? `<i class="fa-solid fa-check" aria-hidden="true"></i><small>${tr('使用中')}</small>` : '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>'}</span></button>`).join('') || `<p class="nora-sheet-empty" role="status">${tr(query ? '没有匹配的预设' : '暂无预设')}</p>`;
                $$('[data-preset]', results).forEach(button => button.addEventListener('click', () => openPreset(library.items[Number(button.dataset.preset)])));
                results.scrollTop = presetScroll;
            };
            $('[data-preset-search]', modal).addEventListener('input', event => {
                presetQuery = event.currentTarget.value;
                presetScroll = 0;
                render();
            });
            results.addEventListener('scroll', () => { presetScroll = results.scrollTop; });
            render();
        } catch (error) { errorToast(error); }
    }

    function openPreset(item) {
        const view = describePreset(item.preset);
        const current = presets.listPresets().selected === item.name;
        const rows = view.rows.map(prompt => {
            const status = !view.configured ? tr('顺序未配置') : !prompt.listed ? tr('未加入顺序') : prompt.enabled ? tr('已启用') : tr('已禁用');
            return `<details class="nora-preset-prompt${prompt.enabled === false ? ' is-disabled' : ''}"><summary><span>${html(prompt.name || prompt.identifier)}</span><small>${status}</small></summary><p>${html(prompt.content || tr(prompt.marker ? '动态内容' : '暂无内容'))}</p></details>`;
        }).join('');
        const modal = dialogs.open(item.name, `<div class="nora-preset-detail-scroll"><button type="button" class="nora-sheet-back" data-back><i class="fa-solid fa-chevron-left" aria-hidden="true"></i> ${tr('预设库')}</button>
            <div class="nora-preset-meta"><span>${tr('全局预设')}</span>${current ? `<span><i class="fa-solid fa-check" aria-hidden="true"></i> ${tr('使用中')}</span>` : ''}</div>
            ${view.parameters.length ? `<dl class="nora-preset-parameters">${view.parameters.map(parameter => `<div><dt>${tr(parameter.label)}</dt><dd>${html(parameter.value)}</dd></div>`).join('')}</dl>` : ''}
            <details class="nora-preset-prompts"><summary>${tr('提示词条目')} <small>${view.rows.length}</small></summary>${rows || `<p class="nora-sheet-empty">${tr('暂无条目')}</p>`}</details></div>
            <footer class="nora-form-actions nora-editor-toolbar nora-preset-footer">${view.scripts ? `<label class="nora-library-check"><input type="checkbox" data-scripts>${tr('启用嵌入式脚本')} (${view.scripts})</label>` : ''}<button type="button" data-apply class="nora-primary">${tr(current ? '重新应用' : '应用预设')}</button></footer>`, 'nora-preset-modal nora-preset-detail-modal nora-plain-sheet');
        $('[data-back]', modal).addEventListener('click', openPresets);
        $('[data-apply]', modal).addEventListener('click', async event => {
            if (busy()) return dialogs.toast(tr('请等待当前生成或保存完成。'));
            const button = event.currentTarget;
            const accepted = await dialogs.confirm({ title: tr('应用此预设？'), body: tr('将更换全局提示词与生成参数，切换世界后仍使用此预设。模型地址和密钥保持不变。'), confirmLabel: tr('应用'), restoreSheet: true });
            if (!accepted || busy()) return;
            button.disabled = true;
            try {
                await operations.run('library', () => presets.applyPreset(item.name, { enableScripts: Boolean($('[data-scripts]', modal)?.checked) }));
                await openPresets();
                refresh();
            } catch (error) { errorToast(error); }
            finally { button.disabled = false; }
        });
    }

    function openJsonImport(kind) {
        const preset = kind === 'preset';
        const modal = dialogs.open(tr(preset ? '导入预设' : '导入世界书'), `<form class="nora-form" data-import-form>
            <label>JSON<input type="file" accept=".json,application/json" name="file" required></label>
            <label>${tr('名称')}<input name="name" maxlength="150" required></label>
            <div class="nora-form-actions"><button type="button" data-back>${tr('取消')}</button><button type="submit" class="nora-primary">${tr('导入')}</button></div></form>`, 'nora-detail-modal');
        const form = $('[data-import-form]', modal);
        form.elements.file.addEventListener('change', () => { if (!form.elements.name.value) form.elements.name.value = (form.elements.file.files[0]?.name || '').replace(/\.json$/i, ''); });
            $('[data-back]', modal).addEventListener('click', () => preset ? openPresets() : openWorldbooks());
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (preset ? busy() : operations.isBusy('library')) return dialogs.toast(tr('请等待当前操作完成。'));
            const button = $('button[type="submit"]', form);
            button.disabled = true;
            try {
                const file = form.elements.file.files[0];
                if (!file || file.size > 10 * 1024 * 1024) throw new Error(tr('请选择不超过 10 MB 的 JSON 文件。'));
                const data = JSON.parse(await file.text());
                await operations.run('library', () => preset ? presets.importPreset(form.elements.name.value.trim(), data) : worlds.saveLibraryWorldbook(form.elements.name.value.trim(), data));
                if (preset) { presetQuery = ''; presetScroll = 0; }
                else bookQuery = '';
                await (preset ? openPresets() : openWorldbooks());
                dialogs.toast(tr('已导入库。'));
            } catch (error) { errorToast(error); }
            finally { button.disabled = false; }
        });
    }
    return { openWorldbooks, openPresets, openRoleImport, openProfiles, openSaveProfile, openSaveBook };
}
