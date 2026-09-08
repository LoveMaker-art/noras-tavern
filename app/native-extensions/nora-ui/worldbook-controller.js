import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
export function createWorldbookController({ worldbook, worldRuntime, operations, store, dialogs, readState, currentCharacter, characterField, select, selectAll, escapeHtml, icons, onChanged, reloadWorlds }) {
    function entries(book) {
        const raw = book?.entries || book || {};
        return Array.isArray(raw) ? raw.map((entry, index) => [String(index), entry]) : Object.entries(raw);
    }

    function runtimeName(character = currentCharacter()) {
        return String(character?.data?.extensions?.world || readState().world.metadata?.world_info || '').trim();
    }

    function activeBindings(character) {
        const embedded = character?.data?.character_book;
        const boundName = runtimeName(character);
        const embeddedName = String(embedded?.name || '').trim();
        const bindings = [];
        if (embedded && (!boundName || (embeddedName && embeddedName !== boundName))) {
            bindings.push({ id: 'embedded', name: embeddedName || tr("角色卡内置世界书"), label: t`导入原件 · ${entries(embedded).length}条`, embedded });
        }
        const named = new Map();
        const addNamed = (name, source) => {
            const normalized = String(name || '').trim();
            if (!normalized) return;
            const binding = named.get(normalized) || { id: `named:${normalized}`, name: normalized, sources: [] };
            if (!binding.sources.includes(source)) binding.sources.push(source);
            named.set(normalized, binding);
        };
        addNamed(character?.data?.extensions?.world, tr("角色绑定"));
        addNamed(readState().world.metadata?.world_info, tr("当前世界绑定"));
        named.forEach((binding) => bindings.push({ ...binding, label: binding.sources.join(' · '), readonly: false }));
        return bindings;
    }

    function displayed(character = currentCharacter()) {
        const name = runtimeName(character);
        if (name && store.cachedWorldbook(name)) return store.cachedWorldbook(name);
        return character?.data?.character_book || null;
    }

    async function load(character = currentCharacter(), { force = false } = {}) {
        const name = runtimeName(character);
        if (!name) return character?.data?.character_book || null;
        if (!force && store.cachedWorldbook(name)) return store.cachedWorldbook(name);
        const embedded = character?.data?.character_book || null;
        const book = await worldbook.loadWorldbook(name, { fallback: embedded, fresh: force });
        store.cacheWorldbook(name, book);
        return book || embedded;
    }

    async function prime(options = {}) {
        const book = await load(currentCharacter(), options);
        onChanged();
        return book;
    }

    function scenario(character) {
        return String(readState().world.metadata?.scenario || characterField(character, 'scenario') || '').trim();
    }

    function entryKeys(entry) {
        const keys = entry?.key ?? entry?.keys ?? [];
        if (Array.isArray(keys)) return keys.map((key) => String(key || '').trim()).filter(Boolean);
        return String(keys || '').split(',').map((key) => key.trim()).filter(Boolean);
    }

    function entryTitle(entry) {
        const keys = entryKeys(entry);
        return String(entry?.comment || entry?.name || keys.join('、') || tr("设定")).trim();
    }

    function isAlwaysOn(entry) {
        return Boolean(entry?.constant) || entryKeys(entry).length === 0;
    }

    function panelItems(items, type, editing = false) {
        return items.map(([id, entry]) => {
            const title = entryTitle(entry);
            const editAction = editing ? `<span class="itemActions"><button class="itemEdit" data-worldbook-edit-kind="embedded" data-entry-id="${escapeHtml(id)}" type="button" aria-label="${t`编辑${escapeHtml(title)}`}" title="${t`编辑${escapeHtml(title)}`}">${icons.edit}</button></span>` : '';
            return `<div class="loreItem loreSummaryItem is-${type}" data-worldbook-kind="embedded" data-entry-id="${escapeHtml(id)}" role="button" tabindex="0" aria-label="${t`查看${escapeHtml(title)}详情`}"><div class="loreSummaryLine"><span class="loreTitle">${escapeHtml(title)}</span>${editAction}</div></div>`;
        }).join('');
    }

    function summary(character, editing = false) {
        const visibleEntries = entries(displayed(character))
            .filter(([, entry]) => entry && typeof entry === 'object' && !entry.disable);
        const alwaysOn = visibleEntries.filter(([, entry]) => isAlwaysOn(entry));
        const triggered = visibleEntries.filter(([, entry]) => !isAlwaysOn(entry));
        const background = scenario(character);
        const scenarioEdit = editing ? `<span class="itemActions"><button class="itemEdit" data-worldbook-edit-kind="scenario" type="button" aria-label="${tr("编辑世界背景")}" title="${tr("编辑世界背景")}">${icons.edit}</button></span>` : '';
        const canEditEntries = editing;
        const alwaysHtml = `${background ? `<div class="loreItem loreSummaryItem is-always" data-worldbook-kind="scenario" role="button" tabindex="0" aria-label="${tr("查看世界背景详情")}"><div class="loreSummaryLine"><span class="loreTitle">${tr("世界背景")}</span>${scenarioEdit}</div></div>` : ''}${panelItems(alwaysOn, 'always', canEditEntries)}`;
        return `
            <div class="loreGroupTitle">${tr("常驻设定")}</div>${alwaysHtml || `<p class="pmuted">${tr("暂无常驻设定")}</p>`}
            <div class="loreGroupTitle is-triggered">${tr("触发设定")}</div>${panelItems(triggered, 'triggered', canEditEntries) || `<p class="pmuted">${tr("暂无触发设定")}</p>`}
            <button class="nora-add-setting" data-add-world-setting type="button">${icons.plus}${visibleEntries.length || background ? tr("添加设定") : tr("添加第一条设定")}</button>`;
    }

    async function openEntryDetail(kind, entryId = '') {
        const character = currentCharacter();
        let title = tr("世界书");
        let mode = tr("常驻：每轮进入上下文");
        let content = '';
        if (kind === 'scenario') {
            title = tr("世界背景");
            content = scenario(character);
        } else {
            let book;
            try {
                book = await load(character);
            } catch (error) {
                dialogs.toast(t`世界书载入失败：${dialogs.normalizeError(error)}`, { tone: 'error' });
                return;
            }
            const entry = entries(book).find(([id]) => id === String(entryId))?.[1];
            if (!entry) {
                dialogs.toast(tr("这条世界书内容已不存在。"), { tone: 'error' });
                return;
            }
            const keys = entryKeys(entry);
            title = entryTitle(entry);
            mode = isAlwaysOn(entry) ? mode : t`触发词：${keys.join('、')}`;
            content = String(entry.content || '').trim();
        }
        dialogs.open(title, `<div class="nora-lore-detail">
            <section><h3>${tr("进入方式")}</h3><p>${escapeHtml(mode)}</p></section>
            <section><h3>${tr("完整内容")}</h3><p>${escapeHtml(content || tr("暂无内容"))}</p></section>
        </div>`, 'nora-lore-detail-modal');
    }

    function open() {
        const character = currentCharacter();
        const bindings = activeBindings(character);
        const background = scenario(character);
        const modal = dialogs.open(tr("世界书"), `
            <section class="nora-world-setting-section">
                <div class="nora-world-setting-head"><div><h3>${tr("世界背景")}</h3><p>${tr("故事中始终成立的舞台和前提")}</p></div><button data-edit-scenario type="button">${tr("编辑")}</button></div>
                <button class="nora-scenario-preview" data-edit-scenario type="button">${background ? tr("世界背景") : tr("暂无世界背景")}</button>
            </section>
            <section class="nora-world-setting-section">
                <div class="nora-world-setting-head"><div><h3>${tr("世界书内容")}</h3><p>${tr("分为常驻设定和触发设定")}</p></div></div>
                <div class="nora-world-binding-list">${bindings.map((binding) => `<button ${binding.embedded ? 'data-embedded-book' : `data-worldbook="${escapeHtml(binding.name)}" data-worldbook-readonly="${binding.readonly ? 'true' : 'false'}"`} type="button"><strong>${escapeHtml(binding.name)}</strong></button>`).join('') || `<p class="nora-sheet-empty">${tr("当前世界还没有补充设定。")}</p>`}</div>
                <button class="nora-add-setting" data-add-world-setting type="button">${icons.plus}${bindings.length ? tr("添加设定") : tr("添加第一条设定")}</button>
            </section>`, 'nora-world-settings-modal');
        selectAll('[data-edit-scenario]', modal).forEach((button) => button.addEventListener('click', () => editScenario(modal, character)));
        select('[data-embedded-book]', modal)?.addEventListener('click', () => renderEntries(modal, bindings.find((binding) => binding.embedded)?.embedded, '', true));
        selectAll('[data-worldbook]', modal).forEach((button) => button.addEventListener('click', async () => {
            if (operations.isBusy('world')) {
                dialogs.toast(tr("世界书正在载入，请稍候。"));
                return;
            }
            button.disabled = true;
            try {
                const book = await operations.run('world', () => worldbook.loadWorldbook(button.dataset.worldbook));
                renderEntries(modal, book, button.dataset.worldbook, button.dataset.worldbookReadonly === 'true');
            } catch (error) {
                button.disabled = false;
                dialogs.toast(t`世界书载入失败：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
            }
        }));
        select('[data-add-world-setting]', modal)?.addEventListener('click', () => openAdd());
    }

    function openAdd() {
        let mode = 'constant';
        const modal = dialogs.open(tr("添加世界设定"), `
            <form id="nora-add-setting-form" class="nora-form nora-entry-form">
                <label>${tr("标题")}<input name="title" maxlength="500" placeholder="${tr("例如：雨夜规则")}"></label>
                <div class="nora-field-label">${tr("设定类型")}<div class="nora-mode-switch" role="group"><button data-entry-mode="constant" type="button">${tr("常驻设定")}</button><button data-entry-mode="trigger" type="button">${tr("触发设定")}</button></div></div>
                <label data-entry-keys>${tr("触发词")}<input name="keys" maxlength="5000" placeholder="${tr("多个触发词用逗号或顿号分隔")}"></label>
                <label>${tr("设定内容")}<textarea name="content" rows="14" maxlength="100000" required placeholder="${tr("写下模型需要遵守或在触发时获知的设定")}"></textarea></label>
                <div class="nora-form-actions"><button class="nora-secondary" data-cancel-setting type="button">${tr("取消")}</button><button class="nora-primary" type="submit">${tr("添加")}</button></div>
            </form>`, 'nora-worldbook-add-modal nora-plain-sheet');
        const syncMode = () => {
            selectAll('[data-entry-mode]', modal).forEach((button) => button.classList.toggle('active', button.dataset.entryMode === mode));
            select('[data-entry-keys]', modal).classList.toggle('hidden', mode !== 'trigger');
        };
        selectAll('[data-entry-mode]', modal).forEach(button => button.addEventListener('click', () => {
            mode = button.dataset.entryMode;
            syncMode();
        }));
        select('[data-cancel-setting]', modal).addEventListener('click', () => dialogs.close());
        syncMode();
        select('#nora-add-setting-form', modal).addEventListener('submit', async (event) => {
            event.preventDefault();
            if (operations.isBusy('world')) {
                dialogs.toast(tr("世界书正在保存，请稍候。"));
                return;
            }
            const form = event.currentTarget;
            const submit = form.querySelector('[type="submit"]');
            const data = new FormData(form);
            const content = String(data.get('content') || '').trim();
            const keys = mode === 'trigger' ? String(data.get('keys') || '').split(/[,，、]/).map(item => item.trim()).filter(Boolean) : [];
            if (!content) {
                dialogs.toast(tr("请填写设定内容。"), { tone: 'error' });
                return;
            }
            if (mode === 'trigger' && !keys.length) {
                dialogs.toast(tr("触发设定至少需要一个触发词。"), { tone: 'error' });
                return;
            }
            submit.disabled = true;
            try {
                const result = await operations.run('world', () => worldRuntime.addSetting({
                    type: mode,
                    title: String(data.get('title') || '').trim(),
                    content,
                    keys,
                }));
                store.cacheWorldbook(result.resource.binding.name, result.book);
                await reloadWorlds();
                dialogs.close();
                onChanged();
                dialogs.toast(tr("设定已添加。"));
            } catch (error) {
                if (error?.saved && error?.result) {
                    const result = error.result;
                    store.cacheWorldbook(result.resource?.binding?.name, result.book);
                    await reloadWorlds().catch(() => {});
                    dialogs.close();
                    onChanged();
                    dialogs.toast(tr("设定已保存，重新打开世界后生效。"));
                    return;
                }
                submit.disabled = false;
                dialogs.toast(`${tr("添加设定失败")}：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
            }
        });
    }

    function editScenario(modal, character, returnToWorldbook = true) {
        const cardScenario = String(characterField(character, 'scenario') || '').trim();
        const hasOverride = Boolean(String(readState().world.metadata?.scenario || '').trim());
        const background = scenario(character);
        select('.nora-sheet-body', modal).innerHTML = `
            <form id="nora-scenario-form" class="nora-form nora-scenario-form">
                <div class="nora-editor-intro"><strong>${tr("世界背景")}</strong><span>${hasOverride ? tr("当前世界使用独立设定") : tr("当前使用角色卡原设定")}</span></div>
                <label>${tr("故事舞台")}<textarea name="scenario" rows="14" placeholder="${tr("描述这个世界始终成立的背景、时间、地点和关系。")}">${escapeHtml(background)}</textarea></label>
                <div class="nora-form-actions">
                    <button class="nora-secondary" data-reset-scenario type="button" ${cardScenario ? '' : 'disabled'}>${tr("恢复原始设定")}</button>
                    <button class="nora-primary" type="submit">${tr("保存")}</button>
                </div>
            </form>`;
        select('[data-reset-scenario]', modal).addEventListener('click', async (event) => {
            if (operations.isBusy('world')) {
                dialogs.toast(tr("世界书正在保存，请稍候。"));
                return;
            }
            const button = event.currentTarget;
            button.disabled = true;
            let persisted = false;
            try {
                await operations.run('world', async () => {
                    await worldbook.saveWorldScenario('');
                    persisted = true;
                    onChanged();
                    if (returnToWorldbook) open();
                    else dialogs.close();
                });
            } catch (error) {
                if (!persisted) button.disabled = false;
                const prefix = persisted ? tr("世界背景已恢复，但页面刷新失败") : tr("世界背景恢复失败");
                dialogs.toast(`${prefix}：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
            }
        });
        select('#nora-scenario-form', modal).addEventListener('submit', async (event) => {
            event.preventDefault();
            if (operations.isBusy('world')) {
                dialogs.toast(tr("世界书正在保存，请稍候。"));
                return;
            }
            const form = event.currentTarget;
            const submit = form.querySelector('[type="submit"]');
            const value = String(new FormData(form).get('scenario') || '').trim();
            submit.disabled = true;
            let persisted = false;
            try {
                await operations.run('world', async () => {
                    await worldbook.saveWorldScenario(value && value !== cardScenario ? value : '');
                    persisted = true;
                    onChanged();
                    if (returnToWorldbook) open();
                    else dialogs.close();
                });
            } catch (error) {
                if (!persisted) submit.disabled = false;
                const prefix = persisted ? tr("世界背景已保存，但页面刷新失败") : tr("世界背景保存失败");
                dialogs.toast(`${prefix}：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
            }
        });
    }

    async function openEntryEditor(kind, entryId = '') {
        const character = currentCharacter();
        if (!character) return;
        if (kind === 'scenario') {
            const modal = dialogs.open(tr("编辑世界书"), '<div></div>', 'nora-worldbook-entry-editor-modal nora-plain-sheet');
            editScenario(modal, character, false);
            return;
        }
        const name = runtimeName(character);
        const modal = dialogs.open(tr("编辑世界书"), '<div></div>', 'nora-worldbook-entry-editor-modal nora-plain-sheet');
        let book;
        try {
            book = await operations.run('world', () => load(character, { force: true }));
        } catch (error) {
            dialogs.close();
            dialogs.toast(t`世界书载入失败：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
            return;
        }
        const entry = entries(book).find(([id]) => id === String(entryId))?.[1];
        if (!book || !entry) {
            dialogs.close();
            dialogs.toast(tr("这条世界书内容已不存在。"), { tone: 'error' });
            return;
        }
        editEntry(modal, name, book, entryId, {
            onBack: dialogs.close,
            onSaved: async () => {
                dialogs.close();
                onChanged();
                dialogs.toast(tr("世界书设定已保存。"));
            },
        });
    }

    function renderEntries(modal, book, name, readonly) {
        const available = entries(book).filter(([, entry]) => entry && typeof entry === 'object');
        const groups = [
            [tr("常驻设定"), 'always', available.filter(([, entry]) => isAlwaysOn(entry))],
            [tr("触发设定"), 'triggered', available.filter(([, entry]) => !isAlwaysOn(entry))],
        ];
        const renderGroup = (items, type) => items.map(([id, entry]) => {
            const title = entryTitle(entry);
            return `<article class="is-${type}"><button class="nora-entry-summary" data-view-entry="${escapeHtml(id)}" type="button" aria-label="${t`查看${escapeHtml(title)}详情`}"><strong>${escapeHtml(title)}</strong></button>${readonly ? '' : `<button data-edit-entry="${escapeHtml(id)}" type="button">${tr("编辑")}</button>`}</article>`;
        }).join('');
        select('.nora-sheet-body', modal).innerHTML = `
            <button class="nora-sheet-back" data-back-world-settings type="button">${tr("‹ 返回世界书")}</button>
            <div class="nora-entry-list">${groups.map(([label, type, items]) => items.length ? `<section class="is-${type}"><h3>${label}</h3>${renderGroup(items, type)}</section>` : '').join('') || `<p class="nora-sheet-empty">${tr("这里还没有设定条目。")}</p>`}</div>
            ${readonly ? `<p class="nora-readonly-note">${tr("角色卡内嵌世界书会原样保留，避免修改复杂卡本体。")}</p>` : ''}`;
        select('[data-back-world-settings]', modal).addEventListener('click', open);
        selectAll('[data-view-entry]', modal).forEach((button) => button.addEventListener('click', () => renderEntryDetail(modal, book, name, readonly, button.dataset.viewEntry)));
        if (!readonly) selectAll('[data-edit-entry]', modal).forEach((button) => button.addEventListener('click', () => editEntry(modal, name, book, button.dataset.editEntry)));
    }

    function renderEntryDetail(modal, book, name, readonly, id) {
        const available = book?.entries || book || {};
        const entry = Array.isArray(available) ? available[Number(id)] : available[id];
        if (!entry) return;
        const keys = entryKeys(entry);
        const mode = isAlwaysOn(entry) ? tr("常驻：每轮进入上下文") : t`触发词：${keys.join('、')}`;
        select('.nora-sheet-body', modal).innerHTML = `
            <button class="nora-sheet-back" data-back-entries type="button">${tr("‹ 返回条目列表")}</button>
            <div class="nora-lore-detail">
                <section><h3>${tr("进入方式")}</h3><p>${escapeHtml(mode)}</p></section>
                <section><h3>${tr("完整内容")}</h3><p>${escapeHtml(String(entry.content || '').trim() || tr("暂无内容"))}</p></section>
            </div>
            ${readonly ? '' : `<div class="nora-entry-detail-actions"><button class="nora-primary" data-edit-detail type="button">${tr("编辑条目")}</button></div>`}`;
        select('[data-back-entries]', modal).addEventListener('click', () => renderEntries(modal, book, name, readonly));
        select('[data-edit-detail]', modal)?.addEventListener('click', () => editEntry(modal, name, book, id));
    }

    function editEntry(modal, name, book, id, options = null) {
        options ||= {};
        const worldId = readState().world.metadata?.nora_world?.id;
        const available = book.entries || book;
        const entry = available[id];
        if (!entry) return;
        let mode = isAlwaysOn(entry) ? 'constant' : 'trigger';
        const keys = entryKeys(entry);
        select('.nora-sheet-body', modal).innerHTML = `
            <button class="nora-sheet-back" data-back-entries type="button">${tr("‹ 返回设定条目")}</button>
            <form id="nora-entry-form" class="nora-form nora-entry-form">
                <label>${tr("标题")}<input name="comment" value="${escapeHtml(entry.comment || entry.name || '')}"></label>
                <div class="nora-field-label">${tr("设定类型")}<div class="nora-mode-switch" role="group"><button data-entry-mode="constant" type="button">${tr("常驻设定")}</button><button data-entry-mode="trigger" type="button">${tr("触发设定")}</button></div></div>
                <label data-entry-keys>${tr("触发词")}<input name="keys" value="${escapeHtml(keys.join('、'))}" placeholder="${tr("多个触发词用逗号或顿号分隔")}"></label>
                <label>${tr("设定内容")}<textarea name="content" rows="14">${escapeHtml(entry.content || '')}</textarea></label>
                <button class="nora-primary" type="submit">${tr("保存设定")}</button>
            </form>`;
        const syncMode = () => {
            selectAll('[data-entry-mode]', modal).forEach((button) => button.classList.toggle('active', button.dataset.entryMode === mode));
            select('[data-entry-keys]', modal).classList.toggle('hidden', mode !== 'trigger');
        };
        select('[data-back-entries]', modal).addEventListener('click', () => options.onBack ? options.onBack() : renderEntries(modal, book, name, false));
        selectAll('[data-entry-mode]', modal).forEach((button) => button.addEventListener('click', () => {
            mode = button.dataset.entryMode;
            syncMode();
        }));
        syncMode();
        select('#nora-entry-form', modal).addEventListener('submit', async (event) => {
            event.preventDefault();
            if (operations.isBusy('world')) {
                dialogs.toast(tr("世界书正在保存，请稍候。"));
                return;
            }
            const form = event.currentTarget;
            const submit = form.querySelector('[type="submit"]');
            const data = new FormData(form);
            const nextKeys = mode === 'trigger' ? String(data.get('keys') || '').split(/[,，、]/).map((item) => item.trim()).filter(Boolean) : [];
            if (mode === 'trigger' && !nextKeys.length) {
                dialogs.toast(tr("触发设定至少需要一个触发词。"), { tone: 'error' });
                return;
            }
            let persisted = false;
            submit.disabled = true;
            try {
                await operations.run('world', async () => {
                    const patch = {};
                    const title = String(data.get('comment') || '');
                    const content = String(data.get('content') || '');
                    if (title !== String(entry.comment || entry.name || '')) patch.comment = title;
                    if (content !== String(entry.content || '')) patch.content = content;
                    if (mode !== (isAlwaysOn(entry) ? 'constant' : 'trigger')) patch.constant = mode === 'constant';
                    if (mode === 'trigger' && JSON.stringify(nextKeys) !== JSON.stringify(entryKeys(entry))) patch.key = nextKeys;
                    if (!Object.keys(patch).length) { dialogs.close(); return; }
                    const result = await worldbook.saveWorldbookEntry(name, book, id, patch, worldId);
                    persisted = true;
                    name = result.resource.binding.name;
                    book = result.book;
                    store.cacheWorldbook(name, book);
                    await reloadWorlds();
                    onChanged();
                    if (options.onSaved) await options.onSaved();
                    else renderEntries(modal, book, name, false);
                });
            } catch (error) {
                submit.disabled = false;
                persisted ||= Boolean(error.saved);
                const prefix = persisted ? tr("世界书已保存，但页面刷新失败") : tr("世界书保存失败");
                dialogs.toast(`${prefix}：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
            }
        });
    }

    return Object.freeze({ entries, summary, scenario, prime, open, openAdd, openEntryDetail, openEntryEditor });
}
