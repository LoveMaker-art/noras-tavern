import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { describePreset } from './preset-presentation.js';
import { libraryTabs, beginLibraryView } from './library-tabs.js';
import { normalizeCharacterActivation } from '../../engine/sillytavern/public/scripts/nora-worlds/story-context.js';
import { createWorldPreset, validateWorldPresetParameters, WORLD_PRESET_PARAMETERS } from '../../engine/sillytavern/public/scripts/nora-worlds/world-preset.js';

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
        const draft = dialogs.protectForm($('[data-save-profile]', modal), { isBusy: () => operations.isBusy('library') });
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
                draft.release();
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
                ${target ? '' : `<details class="nora-library-management"><summary>${tr('管理')}</summary><div class="nora-library-actions"><button type="button" class="nora-library-action" data-save-as><i class="fa-solid fa-copy" aria-hidden="true"></i><span>${tr('另存为')}</span></button><button type="button" data-profile-delete class="nora-library-action nora-library-action-danger"><i class="fa-solid fa-trash-can" aria-hidden="true"></i><span>${tr('删除')}</span></button></div></details>`}</div>
                <footer class="nora-library-footer">${targetLabel(world)}<button type="button" class="nora-primary" data-use ${world ? '' : 'disabled'}>${tr(item.kind === 'persona' ? '替换我的角色' : '添加角色设定')}</button></footer>`, 'nora-detail-modal nora-world-library-modal nora-library-detail-modal nora-plain-sheet');
            $('[data-back]', modal).addEventListener('click', () => openProfiles(item.kind, target));
            $('[data-save-as]', modal)?.addEventListener('click', () => openSaveProfile(item.kind, item.data, `${item.name} ${tr('副本')}`));
            if (!target) {
                $('.nora-library-actions', modal)?.insertAdjacentHTML?.('afterbegin', `<button type="button" class="nora-library-action" data-export-profile><i class="fa-solid fa-file-export" aria-hidden="true"></i><span>${tr('导出 JSON')}</span></button>`);
                $('[data-export-profile]', modal)?.addEventListener('click', () => {
                    const url = URL.createObjectURL(new Blob([JSON.stringify({ schema: item.schema, kind: item.kind, name: item.name, data: item.data }, null, 2)], { type: 'application/json' }));
                    const link = document.createElement('a'); link.href = url; link.download = `${item.name.replace(/[/\\:*?"<>|]/g, '_')}.json`;
                    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
                });
            }
            $('[data-profile-delete]', modal)?.addEventListener('click', async event => {
                const button = event.currentTarget;
                if (button.disabled || busy()) return;
                button.disabled = true;
                try {
                    if (!await dialogs.confirm({ title: tr('删除库中资料？'), body: tr('已添加到世界的副本保持不变。'), confirmLabel: tr('删除'), tone: 'danger', restoreSheet: true })) return;
                    if (busy()) return dialogs.toast(tr('请等待当前生成或保存完成。'));
                    await operations.run('library', () => worlds.deleteLibraryProfile(id, item.revision));
                    await openProfiles(item.kind);
                } catch (error) { errorToast(error); }
                finally { button.disabled = false; }
            });
            $('[data-use]', modal).addEventListener('click', async event => {
                const button = event.currentTarget;
                if (!world || busy()) return dialogs.toast(tr('请等待当前生成或保存完成。'));
                if (activeWorldModel()?.id !== world.id) return dialogs.toast(tr('当前世界已改变，请重新打开选择器。'));
                if (item.kind === 'character') return openRoleImport({ name: item.data.name, data: item.data }, world);
                if (!await dialogs.confirm({ title: tr('替换我的角色？'), body: `${world.name}：${tr('替换玩家名字和描述，其他世界保持不变。')}`, confirmLabel: tr('替换'), restoreSheet: true })) return;
                if (busy() || activeWorldModel()?.id !== world.id) return dialogs.toast(tr('当前状态已改变，请重新打开选择器。'));
                button.disabled = true;
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
        const draft = dialogs.protectForm($('[data-save-book]', modal), { isBusy: () => operations.isBusy('library') });
        $('[data-save-book]', modal).addEventListener('submit', async event => {
            event.preventDefault();
            if (operations.isBusy('library')) return;
            const form = event.currentTarget, button = $('button[type="submit"]', form); button.disabled = true;
            try {
                await operations.run('library', () => worlds.saveLibraryWorldbook(form.elements.name.value.trim(), snapshot));
                draft.release();
                dialogs.close(); dialogs.toast(tr('已存入库，当前世界未修改。'));
            } catch (error) { errorToast(error); }
            finally { button.disabled = false; }
        });
    }

    async function commit(world, input, button, draft) {
        if (busy()) return dialogs.toast(tr('请等待当前生成或保存完成。'));
        if (!world || activeWorldModel()?.id !== world.id) return dialogs.toast(tr('当前世界已改变，请重新打开导入预览。'));
        button.disabled = true;
        try {
            await operations.run('world', async () => {
                if (isGenerating() || activeWorldModel()?.id !== world.id) throw new Error(tr('当前状态已改变，请重新打开导入预览。'));
                await worlds.importLibraryItem(world.id, { ...input, expected_revision: world.revision });
            });
            draft?.release();
            dialogs.close();
            refresh();
            dialogs.toast(tr('已添加到当前世界。'));
        } catch (error) {
            if (error.saved) { draft?.release(); dialogs.close(); refresh(); }
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
        const draft = dialogs.protectForm($('[data-library-role]', modal), { isBusy: () => operations.isBusy('world') });
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
                ...(withBook ? { source: book.source, source_revision: book.revision } : {}) }, $('button[type="submit"]', form), draft);
        });
    }

    async function openBook(source, target = null, onBack = null) {
        try {
            const world = target || activeWorldModel();
            const item = await worlds.readLibraryWorldbook(source);
            const alreadyAttached = attached(item, world);
            const rows = Object.values(item.book.entries).map(entry => `<details class="nora-library-book-entry"><summary>${html(entry.comment || tr('未命名条目'))}<small>${entry.disable ? tr('已禁用') : tr('已启用')}</small></summary><p>${html(entry.content)}</p></details>`).join('');
            const management = target ? '' : `<details class="nora-library-management"><summary>${tr('管理')}</summary><div class="nora-library-actions"><button type="button" class="nora-library-action" data-save-book-copy><i class="fa-solid fa-copy" aria-hidden="true"></i><span>${tr('另存独立世界书')}</span></button>${source.kind === 'book' && !item.book.extensions?.nora_resource ? `<button type="button" class="nora-library-action nora-library-action-danger" data-delete-book><i class="fa-solid fa-trash-can" aria-hidden="true"></i><span>${tr('删除世界书')}</span></button>` : ''}</div><p>${html(source.name)}</p></details>`;
            const modal = dialogs.open(item.name, `<div class="nora-library-detail-scroll"><button type="button" class="nora-sheet-back" data-back>${tr(onBack ? '返回完整卡' : '返回世界书库')}</button><p class="nora-library-target">${item.count} ${tr('条目')}${source.kind === 'card' ? ` · ${tr('来自角色卡')} ${html(item.source_name || '')}` : ''}</p>${rows || `<p>${tr('暂无条目')}</p>`}${management}</div>
                <footer class="nora-library-footer">${targetLabel(world)}<button type="button" class="nora-primary" data-attach ${world && !alreadyAttached ? '' : 'disabled'}>${tr(alreadyAttached ? '已添加' : '添加到当前世界')}</button></footer>`, 'nora-detail-modal nora-world-library-modal nora-library-detail-modal nora-plain-sheet');
            $('[data-back]', modal).addEventListener('click', () => onBack ? onBack() : openWorldbooks(target));
            $('[data-save-book-copy]', modal)?.addEventListener('click', () => openSaveBook(item.name, item.book));
            $('[data-delete-book]', modal)?.addEventListener('click', async event => {
                const button = event.currentTarget;
                if (button.disabled || busy()) return;
                button.disabled = true;
                try {
                    if (!await dialogs.confirm({ title: tr('删除库中世界书？'), body: tr('只删除库中原件，已添加到世界的独立副本保持不变。仍被直接引用的世界书不能删除。'), confirmLabel: tr('删除'), tone: 'danger', restoreSheet: true })) return;
                    if (busy()) return dialogs.toast(tr('请等待当前生成或保存完成。'));
                    await operations.run('library', () => worlds.deleteLibraryWorldbook(item.source, item.revision));
                    await openWorldbooks();
                    dialogs.toast(tr('库中世界书已删除。'));
                } catch (error) { errorToast(error); }
                finally { button.disabled = false; }
            });
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
            const matches = items.map((item, index) => ({ item, index })).filter(({ item }) => item.name.toLocaleLowerCase().includes(query));
            const modal = view.open(tr('世界卡库'), `${tabs}<form class="nora-library-search" data-book-search-form><input type="search" data-book-search value="${html(bookQuery)}" placeholder="${tr('搜索世界书')}" aria-label="${tr('搜索世界书')}"><button class="nora-icon-button" type="submit" title="${tr('搜索')}" aria-label="${tr('搜索')}"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button><button class="nora-icon-button" type="button" data-import title="${tr('导入世界书')}" aria-label="${tr('导入世界书')}"><i class="fa-solid fa-file-import" aria-hidden="true"></i></button></form><div class="nora-library-results"><div class="nora-library-list">${matches.map(({ item, index }) => `<button type="button" class="nora-library-row" data-book="${index}"><strong>${html(item.name)}</strong><small>${item.count} ${tr('条目')} · ${tr('独立世界书')}${attached(item, world) ? ` · ${tr('已添加')}` : ''}</small></button>`).join('') || `<p class="nora-sheet-empty" role="status">${tr(query ? '没有匹配的世界书' : '暂无世界书')}</p>`}</div>${warnings.length ? `<details class="nora-library-management"><summary>${warnings.length} ${tr('个来源读取失败')}</summary>${warnings.map(item => `<p>${html(item.source.name)}: ${html(item.message)}</p>`).join('')}</details>` : ''}</div>`, 'nora-detail-modal nora-world-library-modal nora-plain-sheet');
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
                results.innerHTML = items.map(({ item, index }) => `<button type="button" class="nora-preset-row" data-preset="${index}"><strong>${html(item.name)}</strong><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`).join('') || `<p class="nora-sheet-empty" role="status">${tr(query ? '没有匹配的预设' : '暂无预设')}</p>`;
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

    async function openWorldPreset() {
        const world = activeWorldModel();
        if (!world) return dialogs.toast(tr('请先进入一个世界。'));
        if (busy()) return dialogs.toast(tr('请等待当前生成或保存完成。'));
        try {
            const ready = await worlds.ensureReady(world.id);
            if (activeWorldModel()?.id !== world.id) return;
            openPreset({ name: ready.preset.name }, { world: ready });
        } catch (error) { errorToast(error); }
    }

    function openPreset(item, editor = {}) {
        let snapshot;
        const world = editor.world;
        try {
            if (world) {
                const preset = structuredClone(editor.draft || world.preset.preset);
                snapshot = { preset, toggleable: presets.toggleablePresetEntries(preset) };
            } else snapshot = presets.readPreset(item.name, { storedOnly: true });
        }
        catch (error) { errorToast(error); return; }
        let view = describePreset(snapshot.preset);
        let presetName = item.name;
        let templateChanged = editor.templateChanged;
        let panel = null;
        let expectedRevision = world?.revision;
        const changes = new Map();
        const parameterChanges = new Map();
        let saving = false;
        let savedPending = false;
        let savedDraft = false;
        let persistedPreset = world?.preset;
        const draftPreset = () => {
            const draft = structuredClone(snapshot.preset);
            for (const [key, value] of parameterChanges) draft[key] = value;
            let group = draft.prompt_order.find(entry => String(entry.character_id) === '100001');
            if (!group) draft.prompt_order.push(group = { character_id: 100001, order: [] });
            for (const change of changes.values()) {
                const entry = group.order.find(entry => entry.identifier === change.identifier);
                if (entry) entry.enabled = change.enabled;
                else group.order.push({ identifier: change.identifier, enabled: change.enabled });
            }
            return draft;
        };
        const dirty = () => world
            ? JSON.stringify([presetName, draftPreset()]) !== JSON.stringify([persistedPreset.name, persistedPreset.preset])
            : changes.size > 0;
        const parameterError = () => {
            if (!world) return '';
            try { validateWorldPresetParameters(draftPreset()); return ''; } catch (error) { return error.message; }
        };
        const parameterField = (field, slider = false) => {
            const value = snapshot.preset[field.key] ?? '';
            const limits = `min="${field.min}" max="${field.max}" step="${field.step}"`;
            return `<div class="nora-preset-parameter"><label for="nora-preset-${field.key}">${tr(field.label)}${slider ? '' : ' <small>token</small>'}</label><div class="nora-preset-parameter-inputs">${slider ? `<input type="range" data-preset-range="${field.key}" ${limits} value="${html(value)}" aria-label="${tr(field.label)}">` : ''}<input id="nora-preset-${field.key}" type="number" inputmode="${slider ? 'decimal' : 'numeric'}" data-preset-parameter="${field.key}" ${limits} value="${html(value)}" placeholder="${tr('未设置')}"></div></div>`;
        };
        const renderFields = () => {
            const parameterEditor = `<div class="nora-form nora-preset-parameter-editor"><div class="nora-form-grid">${WORLD_PRESET_PARAMETERS.slice(0, 2).map(field => parameterField(field)).join('')}</div><details data-advanced-parameters><summary>${tr('高级参数')}</summary><div class="nora-preset-sampling">${WORLD_PRESET_PARAMETERS.slice(2).map(field => parameterField(field, true)).join('')}</div></details><p class="nora-preset-parameter-error" data-parameter-error role="alert" hidden></p></div>`;
            const rows = view.rows.map((prompt, index) => {
                const status = !view.configured ? tr('顺序未配置') : !prompt.listed ? tr('未加入顺序') : prompt.enabled ? tr('已启用') : tr('已禁用');
                const allowed = snapshot.toggleable.includes(prompt.identifier);
                return `<div class="nora-preset-prompt-row${prompt.enabled === false ? ' is-disabled' : ''}" data-prompt-row="${index}"><details class="nora-preset-prompt"><summary><span>${html(prompt.name || prompt.identifier)}</span><small data-prompt-status>${status}</small></summary><p>${html(prompt.content || tr(prompt.marker ? '动态内容' : '暂无内容'))}</p></details>
                <div class="nora-preset-entry-action">${allowed ? `<input type="checkbox" role="switch" class="nora-preset-toggle" data-prompt-toggle="${index}" aria-label="${html(prompt.name || prompt.identifier)}" ${prompt.enabled ? 'checked' : ''} ${prompt.listed ? '' : 'hidden'}>
                <button type="button" class="nora-icon-button" data-prompt-add="${index}" title="${tr('加入执行顺序')}" aria-label="${tr('加入执行顺序')}：${html(prompt.name || prompt.identifier)}" ${prompt.listed ? 'hidden' : ''}><i class="fa-solid fa-plus" aria-hidden="true"></i></button>` : `<span class="nora-preset-locked" title="${tr('此条目由引擎管理，不支持切换')}" aria-label="${tr('此条目由引擎管理，不支持切换')}" tabindex="0"><i class="fa-solid fa-lock" aria-hidden="true"></i></span>`}</div></div>`;
            }).join('');
            return `${world ? parameterEditor : view.parameters.length ? `<dl class="nora-preset-parameters">${view.parameters.map(parameter => `<div><dt>${tr(parameter.label)}</dt><dd>${html(parameter.value)}</dd></div>`).join('')}</dl>` : ''}
                <details class="nora-preset-prompts" open><summary>${tr('提示词条目')} <small>${view.rows.length}</small></summary>${rows || `<p class="nora-sheet-empty">${tr('暂无条目')}</p>`}</details>`;
        };
        const modal = dialogs.open(world ? tr('编辑预设') : item.name, `<div class="nora-preset-detail-scroll">${world ? `<button type="button" class="nora-preset-selector" data-change-preset aria-expanded="false" aria-controls="nora-preset-choices" title="${tr('更换预设')}"><strong data-current-preset>${html(presetName)}</strong><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
            <section id="nora-preset-choices" class="nora-preset-chooser" data-preset-chooser hidden><div class="nora-preset-search"><input type="search" data-search aria-label="${tr('搜索预设')}" placeholder="${tr('搜索预设')}"><button type="button" class="nora-icon-button" data-chooser-cancel title="${tr('取消更换')}" aria-label="${tr('取消更换')}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div><div class="nora-preset-results" data-results></div></section>` : `<button type="button" class="nora-sheet-back" data-back><i class="fa-solid fa-chevron-left" aria-hidden="true"></i> ${tr('预设库')}</button>`}
            <div class="nora-preset-meta"><span>${world ? html(world.name) : tr('预设模板')}</span><span class="nora-preset-save-state" data-preset-state role="status"></span></div>
            <div data-preset-fields>${renderFields()}</div></div>
            <footer class="nora-form-actions nora-editor-toolbar nora-preset-footer"><div class="nora-preset-actions" data-editor-actions>
                ${world ? `<button type="button" class="nora-preset-save-link" data-save-as>${tr('另存到预设库')}</button><button type="button" class="nora-secondary" data-editor-cancel>${tr('取消')}</button>` : `<button type="button" class="nora-icon-button nora-preset-delete" data-delete-preset title="${tr('删除模板')}" aria-label="${tr('删除模板')}"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>`}<button type="button" data-apply class="nora-primary" disabled>${tr(world ? '保存' : '保存模板')}</button></div>
                ${world ? `<form class="nora-form nora-preset-copy-form" data-save-preset-form hidden><label>${tr('库中名称')}<input name="name" maxlength="150" required autocomplete="off"></label><p class="nora-preset-parameter-error" data-copy-error role="alert" hidden></p><div class="nora-preset-copy-actions"><button type="button" class="nora-secondary" data-copy-cancel>${tr('取消')}</button><button type="submit" class="nora-primary">${tr('存入库')}</button></div></form>` : ''}</footer>`, 'nora-preset-modal nora-preset-detail-modal nora-plain-sheet nora-fixed-editor');
        const updateActions = () => {
            const error = parameterError();
            const errorNode = $('[data-parameter-error]', modal);
            if (errorNode) { errorNode.textContent = error; errorNode.hidden = !error; }
            $('[data-preset-state]', modal).textContent = tr(savedPending ? '已保存，待应用' : dirty() ? '未保存' : '');
            const apply = $('[data-apply]', modal);
            apply.disabled = saving || Boolean(panel) || Boolean(error) || (!dirty() && !savedPending);
            apply.textContent = tr(saving ? '正在保存' : savedPending ? '重试应用' : world ? '保存' : '保存模板');
            $$('[data-prompt-toggle], [data-prompt-add], [data-preset-parameter], [data-preset-range]', modal).forEach(control => { control.disabled = saving; });
            $$('[data-save-as], [data-change-preset], [data-delete-preset]', modal).forEach(control => { control.disabled = saving || Boolean(error); });
            $$('[data-editor-cancel], [data-copy-cancel], [data-chooser-cancel], [data-search], [data-choice], [data-save-preset-form] input, [data-save-preset-form] button[type="submit"]', modal).forEach(control => { control.disabled = saving; });
            const copySubmit = $('[data-save-preset-form] button[type="submit"]', modal);
            if (copySubmit) copySubmit.disabled = saving || Boolean(error);
        };
        const bindFields = () => {
            $$('[data-preset-parameter], [data-preset-range]', modal).forEach(input => input.addEventListener('input', () => {
                if (saving) return;
                const key = input.dataset.presetParameter || input.dataset.presetRange;
                const value = input.value.trim() === '' ? NaN : Number(input.value);
                if (value === snapshot.preset[key]) parameterChanges.delete(key);
                else parameterChanges.set(key, value);
                const number = $(`[data-preset-parameter="${key}"]`, modal);
                if (number !== input) number.value = input.value;
                const range = $(`[data-preset-range="${key}"]`, modal);
                if (range && range !== input && Number.isFinite(value)) range.value = input.value;
                savedPending = false;
                updateActions();
            }));
            const updateEntry = (index, enabled, add = false) => {
                const original = view.rows[index];
                if (!original || saving) return;
                if (!savedDraft && original.listed && enabled === original.enabled && !add) changes.delete(original.identifier);
                else changes.set(original.identifier, { identifier: original.identifier, enabled, ...(add || !original.listed ? { add: true } : {}) });
                savedPending = false;
                const row = $(`[data-prompt-row="${index}"]`, modal);
                row.classList.toggle('is-disabled', !enabled);
                $('[data-prompt-status]', row).textContent = tr(enabled ? '已启用' : '已禁用');
                const input = $(`[data-prompt-toggle="${index}"]`, modal);
                input.hidden = false; input.checked = enabled;
                $(`[data-prompt-add="${index}"]`, modal).hidden = true;
                updateActions();
            };
            $$('[data-prompt-toggle]', modal).forEach(input => input.addEventListener('change', () => updateEntry(Number(input.dataset.promptToggle), input.checked)));
            $$('[data-prompt-add]', modal).forEach(button => button.addEventListener('click', () => {
                const index = Number(button.dataset.promptAdd);
                updateEntry(index, true, true);
                $(`[data-prompt-toggle="${index}"]`, modal).focus();
            }));
        };
        bindFields();
        $('[data-delete-preset]', modal)?.addEventListener('click', async () => {
            if (saving || busy()) return;
            saving = true; updateActions();
            let deleted = false;
            try {
                const body = `${item.name}\n${tr('仅删除预设库中的模板，已应用到各个世界的独立副本不受影响。')}${dirty() ? `\n${tr('本次未保存的修改也会丢弃。')}` : ''}`;
                if (!await dialogs.confirm({ title: tr('删除模板？'), body, confirmLabel: tr('删除模板'), restoreSheet: true })) return;
                await operations.run('library', () => presets.deletePreset(snapshot));
                deleted = true;
                dialogs.setCloseGuard(null);
                await openPresets();
                dialogs.toast(tr('模板已删除，世界中的副本保持不变。'));
            } catch (error) { errorToast(error); }
            finally { saving = false; if (!deleted) updateActions(); }
        });
        const canLeave = async () => {
            if (saving) return false;
            if (savedPending) return dialogs.confirm({ title: tr('离开待应用的预设？'), body: tr('预设已保存，但尚未应用。离开不会撤销已保存的内容。'),
                confirmLabel: tr('离开'), cancelLabel: tr('继续编辑'), restoreSheet: true });
            return !dirty() || dialogs.confirm({ title: tr('放弃未保存的修改？'), body: tr('关闭后，本次修改不会保存。'),
                confirmLabel: tr('放弃修改'), cancelLabel: tr('继续编辑'), restoreSheet: true });
        };
        dialogs.setCloseGuard(() => {
            if (saving) return false;
            if (panel) { closePanel(); return false; }
            return canLeave();
        });
        $('[data-editor-cancel]', modal)?.addEventListener('click', () => dialogs.close());
        $('[data-back]', modal)?.addEventListener('click', async () => { if (await canLeave()) openPresets(); });
        async function save() {
            if (saving || panel || busy()) return dialogs.toast(tr('请等待当前生成或保存完成。'));
            if (parameterError()) return;
            let reopened = false;
            if (!dirty() && !savedPending) return;
            saving = true; updateActions();
            const expanded = $$('[data-prompt-row]', modal).filter(row => $('details', row).open).map(row => view.rows[Number(row.dataset.promptRow)].identifier);
            const promptsOpen = $('.nora-preset-prompts', modal).open;
            const advancedOpen = $('[data-advanced-parameters]', modal)?.open;
            const scrollTop = $('.nora-preset-detail-scroll', modal).scrollTop;
            try {
                let savedWorld;
                const options = { apply: false };
                await operations.run('library', async () => {
                    if (isGenerating()) throw new Error(tr('请等待当前生成或保存完成。'));
                    if (world) {
                        if (activeWorldModel()?.id !== world.id) throw new Error(tr('当前世界已改变，请重新打开编辑。'));
                        const value = createWorldPreset(presetName, draftPreset(), templateChanged ? changes.size + parameterChanges.size > 0 : (world.preset.modified || dirty()));
                        const result = await worlds.updateActive({ preset: value }, { expectedRevision });
                        savedWorld = result.world;
                        if (!result.runtimeApplied) throw Object.assign(new Error(tr('预设已保存，请回到对应世界查看。')), { saved: true });
                    } else await presets.savePresetEntries(snapshot, [...changes.values()], options);
                });
                changes.clear(); savedPending = false;
                dialogs.setCloseGuard(null);
                // Keep the user on the same preset after saving, rather than returning to the library.
                if (world && activeWorldModel()?.id !== world.id) { reopened = true; dialogs.close({ dismissed: false }); refresh(); return; }
                const next = world ? openPreset({ name: savedWorld.preset.name }, { world: savedWorld }) : openPreset(item);
                reopened = Boolean(next);
                if (next) {
                    $('.nora-preset-prompts', next).open = promptsOpen;
                    if (world) $('[data-advanced-parameters]', next).open = advancedOpen;
                    const nextRows = describePreset(world ? savedWorld.preset.preset : presets.readPreset(item.name, { storedOnly: true }).preset).rows;
                    nextRows.forEach((row, index) => { if (expanded.includes(row.identifier)) $(`[data-prompt-row="${index}"] details`, next).open = true; });
                    $('.nora-preset-detail-scroll', next).scrollTop = scrollTop;
                }
                refresh();
                dialogs.toast(tr(world ? '已应用到当前世界。' : '模板已保存，世界中的副本保持不变。'));
            } catch (error) {
                if (error.saved) {
                    if (world) {
                        const stored = worlds.list().find(item => item.id === world.id);
                        if (stored) { expectedRevision = stored.revision; persistedPreset = stored.preset; }
                    }
                    else snapshot = presets.readPreset(item.name, { storedOnly: true });
                    savedPending = true; savedDraft = true;
                }
                errorToast(error);
            } finally { saving = false; if (!reopened) updateActions(); }
        }
        $('[data-apply]', modal).addEventListener('click', save);
        function closePanel() {
            const previous = panel;
            panel = null;
            $('[data-preset-chooser]', modal).hidden = true;
            $('[data-change-preset]', modal).setAttribute('aria-expanded', 'false');
            $('[data-save-preset-form]', modal).hidden = true;
            $('[data-editor-actions]', modal).hidden = false;
            updateActions();
            $(previous === 'copy' ? '[data-save-as]' : '[data-change-preset]', modal).focus();
        }
        let choices = [];
        const renderChoices = query => {
            const normalized = query.trim().toLocaleLowerCase();
            $('[data-results]', modal).innerHTML = choices.map((item, index) => ({ item, index })).filter(({ item }) => item.name.toLocaleLowerCase().includes(normalized))
                .map(({ item, index }) => `<button type="button" class="nora-preset-row${item.name === presetName ? ' is-current' : ''}" data-choice="${index}" ${item.name === presetName ? 'aria-current="true"' : ''}><strong>${html(item.name)}</strong>${item.name === presetName ? `<span><i class="fa-solid fa-check" aria-hidden="true"></i>${tr('当前')}</span>` : ''}</button>`).join('') || `<p class="nora-sheet-empty">${tr('没有匹配的预设')}</p>`;
            $$('[data-choice]', modal).forEach(button => button.addEventListener('click', () => {
                if (saving || panel !== 'choose') return;
                const name = choices[Number(button.dataset.choice)].name;
                if (name === presetName) { closePanel(); return; }
                try {
                    const candidate = presets.readPreset(name, { storedOnly: true });
                    const info = describePreset(candidate.preset);
                    const order = candidate.preset.prompt_order.find(group => String(group.character_id) === '100001') || { character_id: 100001, order: [] };
                    const selected = createWorldPreset(candidate.name, { ...draftPreset(), ...candidate.preset, prompt_order: [order] });
                    const toggleable = presets.toggleablePresetEntries(selected.preset);
                    snapshot = { preset: selected.preset, toggleable };
                    presetName = selected.name;
                    templateChanged = true;
                    view = describePreset(snapshot.preset);
                    changes.clear(); parameterChanges.clear(); savedPending = false;
                    $('[data-current-preset]', modal).textContent = presetName;
                    $('[data-preset-fields]', modal).innerHTML = renderFields();
                    bindFields();
                    closePanel();
                    $('.nora-preset-detail-scroll', modal).scrollTop = 0;
                    if (info.scripts) dialogs.toast(tr('已载入提示词与生成参数，模板内嵌脚本未启用。'));
                } catch (error) { errorToast(error); }
            }));
        };
        $('[data-change-preset]', modal)?.addEventListener('click', () => {
            if (saving || parameterError()) return;
            if (panel === 'choose') { closePanel(); return; }
            try { choices = presets.listPresets().items; } catch (error) { errorToast(error); return; }
            if (panel) closePanel();
            panel = 'choose';
            $('[data-preset-chooser]', modal).hidden = false;
            $('[data-change-preset]', modal).setAttribute('aria-expanded', 'true');
            $('[data-search]', modal).value = '';
            renderChoices(''); updateActions();
            $('.nora-preset-detail-scroll', modal).scrollTop = 0;
            $('[data-search]', modal).focus();
        });
        $('[data-search]', modal)?.addEventListener('input', event => renderChoices(event.currentTarget.value));
        $('[data-chooser-cancel]', modal)?.addEventListener('click', () => { if (!saving) closePanel(); });
        $('[data-save-as]', modal)?.addEventListener('click', () => {
            if (saving || parameterError()) return;
            if (panel) closePanel();
            panel = 'copy';
            $('[data-editor-actions]', modal).hidden = true;
            $('[data-save-preset-form]', modal).hidden = false;
            $('[data-copy-error]', modal).hidden = true;
            const input = $('[data-save-preset-form] input', modal);
            const suffix = ' - ' + tr('副本');
            input.value = presetName.slice(0, 150 - suffix.length) + suffix;
            updateActions(); input.focus();
        });
        $('[data-copy-cancel]', modal)?.addEventListener('click', () => { if (!saving) closePanel(); });
        $$('[data-preset-chooser], [data-save-preset-form]', modal).forEach(container => container.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault(); event.stopPropagation();
            if (!saving) closePanel();
        }));
        $('[data-save-preset-form]', modal)?.addEventListener('submit', async event => {
            event.preventDefault();
            if (saving || panel !== 'copy' || parameterError()) return;
            if (busy()) return dialogs.toast(tr('请等待当前生成或保存完成。'));
            const name = event.currentTarget.elements.name.value.trim();
            const errorNode = $('[data-copy-error]', modal);
            saving = true; updateActions(); errorNode.hidden = true;
            try {
                await operations.run('library', () => presets.importPreset(name, draftPreset()));
                saving = false;
                closePanel(); dialogs.toast(tr('已存入预设库。'));
            } catch (error) { errorNode.textContent = dialogs.normalizeError(error); errorNode.hidden = false; }
            finally { saving = false; updateActions(); }
        });
        updateActions();
        return modal;
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
    return { openWorldbooks, openBook, openPresets, openWorldPreset, openRoleImport, openProfiles, openSaveProfile, openSaveBook };
}
