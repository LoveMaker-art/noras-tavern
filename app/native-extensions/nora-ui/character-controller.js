import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { storyCharacterView, normalizeCharacterActivation } from '../../engine/sillytavern/public/scripts/nora-worlds/story-context.js';
import { resolveCharacterReferences } from '../../engine/sillytavern/public/scripts/nora-worlds/character-references.js';
import { libraryTabs, beginLibraryView } from './library-tabs.js';
export function createCharacterController({
    cards,
    listLibraryCards,
    operations,
    dialogs,
    readState,
    settings,
    characterField,
    characterCapabilities,
    resolveCharacter,
    enableCharacterCapabilities,
    worldbookEntries,
    select,
    selectAll,
    escapeHtml,
    icons,
    reloadWorlds,
    refresh,
    isCharacterInWorld = () => false,
    createWorldFromCard,
    openWorldbookLibrary = () => {},
    openProfileLibrary = () => {},
    saveProfile = () => {},
    addRoleFromCard = () => {},
    activeWorldModel = () => null,
    updateWorld,
    isGenerating = () => false,
}) {
    function worldCharacter(key) {
        if (typeof key !== 'string' || !key.startsWith('world-character:')) return null;
        return activeWorldModel()?.storyContext?.characters.find(item => item.id === key.slice(16)) || null;
    }
    const desktopLibraryPageSize = 8;
    const mobileLibraryPageSize = 4;
    let libraryPage = 0;
    let libraryLoaded = false;
    let libraryQuery = '';
    let libraryCatalog = null;

    function libraryPageSize() {
        return globalThis.matchMedia?.('(max-width: 560px)').matches
            ? mobileLibraryPageSize
            : desktopLibraryPageSize;
    }

    function stableJson(value) {
        if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
        if (value && typeof value === 'object') {
            return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    function identity(character) {
        const data = structuredClone(character?.data || {
            name: character?.name,
            description: characterField(character, 'description'),
            personality: characterField(character, 'personality'),
            scenario: characterField(character, 'scenario'),
            first_mes: characterField(character, 'first_mes'),
        });
        if (data.extensions && typeof data.extensions === 'object') delete data.extensions.nora_import;
        const source = stableJson(data);
        let hash = 2166136261;
        for (let index = 0; index < source.length; index += 1) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `${String(character?.name || '').trim()}\u0000${source.length}\u0000${hash >>> 0}`;
    }

    function libraryGroupKey(character) {
        if (libraryCatalog) return `library:${character.avatar}`;
        // A source fingerprint identifies the imported file, not the card's current
        // editable contents. Keep shallow cards separate until their full identity
        // is available so duplicate cleanup can never delete a locally edited card.
        if (character?.shallow) return `shallow:${String(character.avatar || '')}`;
        return `identity:${identity(character)}`;
    }

    function groups() {
        const grouped = new Map();
        readState().characters
            .map((character, index) => ({ character, index }))
            .filter(({ character }) => character.avatar !== settings().blankCharacterAvatar && !cards.isSystemCharacter?.(character))
            .filter(({ character }) => !libraryCatalog || libraryCatalog.has(character.avatar))
            .forEach((member) => {
                const key = libraryGroupKey(member.character);
                const group = grouped.get(key) || { identity: key, members: [] };
                group.members.push(member);
                grouped.set(key, group);
            });
        return [...grouped.values()].map((group) => {
            const retained = group.members.filter(({ character }) => isCharacterInWorld(character));
            const deletable = group.members.filter(({ character }) => !isCharacterInWorld(character));
            return { ...group, retained, deletable, primary: retained[0] || group.members[0] };
        });
    }

    async function deleteGroup(group) {
        if (!group?.deletable?.length) {
            dialogs.toast(tr("这张角色卡正在被世界使用，请先删除对应世界。"), { tone: 'error' });
            return;
        }
        const cleaningDuplicates = group.retained.length > 0;
        const avatars = group.deletable.map(({ character }) => character.avatar);
        const accepted = await dialogs.confirm({
            title: cleaningDuplicates ? tr("清理重复角色卡？") : t`删除“${group.primary.character.name || tr("未命名角色")}”？`,
            body: cleaningDuplicates
                ? t`将删除 ${avatars.length} 个未被世界使用的重复副本，正在运行的世界不会受影响。`
                : tr("将删除这张角色卡及其关联聊天记录，此操作无法撤销。"),
            confirmLabel: cleaningDuplicates ? tr("清理副本") : tr("删除角色卡"),
            tone: 'danger',
            details: avatars,
            detailsLabel: tr("查看文件"),
        });
        if (!accepted) return;
        if (operations.isBusy('character-delete')) {
            dialogs.toast(tr("角色卡正在删除，请稍候。"));
            return;
        }
        let deleted = false;
        try {
            await operations.run('character-delete', async () => {
                await cards.deleteCharacterCards({ avatars, deleteChats: !cleaningDuplicates });
                deleted = true;
                await reloadWorlds();
                refresh();
                dialogs.toast(cleaningDuplicates ? tr("重复角色卡已清理。") : tr("角色卡已删除。"));
                await openLibrary();
            });
        } catch (error) {
            const prefix = deleted ? tr("角色卡已删除，但页面刷新失败") : tr("角色卡删除失败");
            dialogs.toast(`${prefix}：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
        }
    }

    async function openLibrary(requestedPage = libraryPage) {
        const view = beginLibraryView(dialogs);
        try {
            if (!libraryLoaded || listLibraryCards) {
                await cards.refreshCharacters();
                if (!view.isCurrent()) return;
                libraryLoaded = true;
            }
            if (listLibraryCards) {
                const catalog = await listLibraryCards();
                if (!view.isCurrent()) return;
                libraryCatalog = new Map(catalog.items.map(item => [item.avatar, item]));
                if (catalog.warnings?.length) dialogs.toast(tr('部分卡读取失败，已保留原文件。'), { tone: 'error' });
            }
            const query = libraryQuery.trim().toLocaleLowerCase();
            const libraryGroups = groups().filter(({ primary: { character } }) =>
                `${character.name || ''} ${characterField(character, 'creator') || ''}`.toLocaleLowerCase().includes(query));
            const pageSize = libraryPageSize();
            const pageCount = Math.max(1, Math.ceil(libraryGroups.length / pageSize));
            const parsedPage = Number(requestedPage);
            libraryPage = Number.isInteger(parsedPage) ? Math.min(Math.max(parsedPage, 0), pageCount - 1) : Math.min(libraryPage, pageCount - 1);
            const pageStart = libraryPage * pageSize;
            const pageGroups = libraryGroups.slice(pageStart, pageStart + pageSize);
            const cardMarkup = pageGroups.map((group) => {
                const { character, index } = group.primary;
                const duplicateBadge = group.members.length > 1 ? `<small class="nora-card-duplicate">${t`${group.members.length}份`}</small>` : '';
                const sourceLabel = libraryCatalog?.get(character.avatar)?.legacy ? tr('已有世界快照') : characterField(character, 'creator') || tr('角色卡');
                return `<article class="nora-card-library-item"><button class="nora-card-library-open" data-library-character="${index}" type="button"><img src="/thumbnail?type=avatar&amp;file=${encodeURIComponent(character.avatar)}" alt="" loading="lazy"><span><strong title="${escapeHtml(character.name || '')}">${escapeHtml(character.name || tr("未命名角色"))}</strong><small>${escapeHtml(sourceLabel)}</small></span></button>${duplicateBadge}</article>`;
            }).join('');
            const pager = pageCount > 1 ? `<nav class="nora-library-pager" aria-label="${tr("角色卡分页")}"><button data-library-page="${Math.max(0, libraryPage - 1)}" type="button" aria-label="${tr("上一页")}" ${libraryPage === 0 ? 'disabled' : ''}>${icons.left}</button><span>${t`第 ${libraryPage + 1} / ${pageCount} 页`}</span><button data-library-page="${Math.min(pageCount - 1, libraryPage + 1)}" type="button" aria-label="${tr("下一页")}" ${libraryPage === pageCount - 1 ? 'disabled' : ''}>${icons.right}</button></nav>` : '';
            const columns = Math.min(4, pageGroups.length);
            const mobileColumns = Math.min(2, pageGroups.length);
            const content = libraryGroups.length ? `<div class="nora-card-waterfall" style="--nora-library-columns:${columns};--nora-library-mobile-columns:${mobileColumns}">${cardMarkup}</div>${pager}` : `<p class="nora-sheet-empty" role="status">${tr(query ? '没有匹配的角色卡' : '还没有导入角色卡。')}</p>`;
            const tabs = libraryTabs('cards');
            const modal = view.open(tr("世界卡库"), `${tabs}<form class="nora-library-search" data-library-search-form><input type="search" data-library-search value="${escapeHtml(libraryQuery)}" placeholder="${tr('搜索角色卡或作者')}" aria-label="${tr('搜索角色卡或作者')}"><button class="nora-icon-button" type="submit" title="${tr('搜索')}" aria-label="${tr('搜索')}"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button><button class="nora-icon-button" type="button" data-library-import title="${tr('导入角色卡')}" aria-label="${tr('导入角色卡')}"><i class="fa-solid fa-file-import" aria-hidden="true"></i></button></form><div class="nora-library-results">${content}</div>`, 'nora-character-library-modal nora-world-library-modal nora-plain-sheet');
            select('[data-library-search-form]', modal)?.addEventListener('submit', event => {
                event.preventDefault();
                libraryQuery = select('[data-library-search]', modal).value;
                openLibrary(0);
            });
            select('[data-library-import]', modal)?.addEventListener('click', openCardImport);
            selectAll('[data-library-tab]', modal).forEach(button => button.addEventListener('click', () => {
                const kind = button.dataset.libraryTab;
                if (kind === 'worldbooks') return openWorldbookLibrary();
                if (kind !== 'cards') return openProfileLibrary(kind);
                return openLibrary();
            }));
            selectAll('[data-library-character]', modal).forEach((button) => button.addEventListener('click', async () => {
                const characterId = Number(button.dataset.libraryCharacter);
                if (operations.isBusy('character-library-detail')) {
                    dialogs.toast(tr("角色资料正在载入，请稍候。"));
                    return;
                }
                button.disabled = true;
                try {
                    const character = readState().characters?.[characterId];
                    if (character?.shallow) {
                        const resolved = await operations.run('character-library-detail', () => resolveCharacter(characterId));
                        if (!resolved) throw new Error(tr("角色卡资料不完整。"));
                    }
                    openSheet(characterId, true);
                } catch (error) {
                    button.disabled = false;
                    dialogs.toast(t`角色卡载入失败：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
                }
            }));
            selectAll('[data-library-page]', modal).forEach((button) => button.addEventListener('click', () => openLibrary(Number(button.dataset.libraryPage))));
        } catch (error) {
            if (view.isCurrent()) dialogs.toast(dialogs.normalizeError(error), { tone: 'error', duration: 4200 });
        }
    }

    function openCardImport() {
        const modal = dialogs.open(tr('导入角色卡'), `<form class="nora-form" data-card-import-form><label>PNG / JSON / CHARX / YAML<input name="file" type="file" accept=".png,.json,.charx,.yaml,.yml" required></label><div class="nora-form-actions"><button type="button" data-back>${tr('取消')}</button><button type="submit" class="nora-primary">${tr('存入库')}</button></div></form>`, 'nora-detail-modal');
        select('[data-back]', modal)?.addEventListener('click', () => openLibrary());
        select('[data-card-import-form]', modal)?.addEventListener('submit', async event => {
            event.preventDefault();
            if (isGenerating() || operations.isBusy('world') || operations.isBusy('library')) return dialogs.toast(tr('请等待当前操作完成。'));
            const form = event.currentTarget;
            const button = select('button[type="submit"]', form);
            button.disabled = true;
            let saved = false;
            try {
                await operations.run('library', async () => {
                    const result = await cards.importLibraryCard(form.elements.file.files[0]);
                    if (result?.reused) dialogs.toast(tr('相同卡已在库中，已复用原件。'));
                    if (result?.retained?.length) dialogs.toast(tr('部分重复文件仍有关联数据，已保留。'));
                    if (result?.same_name_different) dialogs.toast(tr('同名卡内容不同，已作为独立版本保留。'));
                    saved = true;
                    libraryLoaded = false;
                    libraryQuery = '';
                    await openLibrary(0);
                });
                dialogs.toast(tr('角色卡已存入库。'));
            } catch (error) {
                if (saved) dialogs.close();
                dialogs.toast(`${tr(saved ? '角色卡已存入库，但列表刷新失败' : '角色卡导入失败')}：${dialogs.normalizeError(error)}`, { tone: 'error' });
            } finally { button.disabled = false; }
        });
    }

    function openSheet(characterId = readState().activeCharacterId, backToLibrary = false) {
        const member = worldCharacter(characterId);
        const character = member ? storyCharacterView(member, activeWorldModel().storyContext) : readState().characters?.[characterId];
        if (!character) return;
        const fields = [[tr("角色介绍"), characterField(character, 'description')], [tr("性格"), characterField(character, 'personality')], [tr("场景"), characterField(character, 'scenario')], [tr("开场内容"), characterField(character, 'first_mes')], [tr("示例对话"), characterField(character, 'mes_example')], [tr("创作者备注"), characterField(character, 'creator_notes')]].filter(([, value]) => String(value || '').trim());
        const capabilities = characterCapabilities(character);
        const capabilityCount = capabilities.regexScripts.length + capabilities.helperScripts.length;
        const worldbookCount = worldbookEntries(character?.data?.character_book).length;
        const capabilitiesEnabled = (!capabilities.regexScripts.length || capabilities.regexAllowed)
            && (!capabilities.helperScripts.length || capabilities.helperAllowed);
        const rules = capabilityCount ? `<div class="nora-character-rules ${capabilitiesEnabled ? 'enabled' : ''}"><div><strong>${tr("角色扩展能力")}</strong><span>${t`${capabilities.regexScripts.length} 条显示规则 · ${capabilities.helperScripts.length} 个脚本 · ${capabilitiesEnabled ? tr("已启用") : tr("未启用")}`}</span></div>${capabilitiesEnabled ? '' : `<button data-enable-character-capabilities type="button">${tr("启用")}</button>`}</div>` : '';
        const portrait = character.avatar ? `<img src="/thumbnail?type=avatar&amp;file=${encodeURIComponent(character.avatar)}" alt="">` : '';
        const overview = `<div class="nora-character-overview">${portrait}<div><p class="nora-provenance">${escapeHtml(characterField(character, 'creator') || tr("角色资料"))}</p><p>${t`${worldbookCount} 条世界书 · ${capabilities.regexScripts.length} 条显示规则 · ${capabilities.helperScripts.length} 个脚本`}</p></div></div>`;
        const back = backToLibrary ? `<button class="nora-sheet-back" data-back-character-library type="button">${tr("‹ 返回世界卡库")}</button>` : '';
        const empty = fields.length ? '' : `<p class="nora-sheet-empty">${tr("该卡主要由内置世界书和扩展脚本构成。")}</p>`;
        const group = backToLibrary ? groups().find(item => item.members.some(member => member.character.avatar === character.avatar)) : null;
        const deleteTitle = group?.deletable.length ? (group.retained.length ? tr('清理重复副本') : tr('删除角色卡')) : tr('正在被世界使用');
        const management = backToLibrary ? `<details class="nora-library-management"><summary>${tr('管理')}</summary><button class="nora-delete-button" data-library-delete type="button" ${group?.deletable.length ? '' : 'disabled'}>${icons.trash} ${deleteTitle}</button></details>` : '';
        const createAction = backToLibrary ? `<footer class="nora-library-footer"><span class="nora-library-target">${activeWorldModel() ? `${tr('目标世界')}：${escapeHtml(activeWorldModel().name)}` : tr('尚未进入世界')}</span><div class="nora-sheet-actions"><button data-card-add-role type="button" ${activeWorldModel() ? '' : 'disabled'}>${tr('添加角色设定')}</button><button class="nora-primary" data-card-create-world type="button">${tr('创建新世界')}</button></div></footer>` : '';
        const fieldMarkup = fields.map(([label, value]) => backToLibrary ? `<details class="nora-library-book-entry"><summary>${label}</summary><p>${escapeHtml(value)}</p></details>` : `<section><h3>${label}</h3><p>${escapeHtml(value)}</p></section>`).join('');
        const detail = `${back}<div class="nora-character-detail">${overview}${rules}${fieldMarkup}${empty}${management}</div>`;
        const modal = dialogs.open(character.name, `${backToLibrary ? `<div class="nora-library-detail-scroll">${detail}</div>` : detail}${createAction}`, backToLibrary ? 'nora-detail-modal nora-world-library-modal nora-library-detail-modal nora-plain-sheet' : 'nora-detail-modal');
        select('[data-library-delete]', modal)?.addEventListener('click', () => deleteGroup(groups().find(item => item.members.some(member => member.character.avatar === character.avatar))));
        select('[data-card-create-world]', modal)?.addEventListener('click', event => createWorldFromCard(character, event.currentTarget));
        select('[data-card-add-role]', modal)?.addEventListener('click', () => addRoleFromCard(character));
        if (backToLibrary) {
            select('.nora-library-management', modal)?.insertAdjacentHTML?.('beforeend', `<button type="button" data-save-card-profile>${tr('另存角色资料')}</button>`);
            select('[data-save-card-profile]', modal)?.addEventListener('click', () => saveProfile('character', {
                name: character.name || '', description: characterField(character, 'description') || '', personality: characterField(character, 'personality') || '',
            }));
        }
        select('[data-back-character-library]', modal)?.addEventListener('click', () => openLibrary());
        select('[data-enable-character-capabilities]', modal)?.addEventListener('click', async (event) => {
            if (operations.isBusy('character-capabilities')) {
                dialogs.toast(tr("角色扩展能力正在启用，请稍候。"));
                return;
            }
            const button = event.currentTarget;
            button.disabled = true;
            let enabled = false;
            try {
                await operations.run('character-capabilities', async () => {
                    await enableCharacterCapabilities(character, { refresh: true });
                    enabled = true;
                    dialogs.toast(tr("角色扩展能力已启用。"));
                    openSheet(characterId, backToLibrary);
                });
            } catch (error) {
                if (!enabled) button.disabled = false;
                const prefix = enabled ? tr("角色扩展能力已启用，但页面刷新失败") : tr("角色扩展能力启用失败");
                dialogs.toast(`${prefix}：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
            }
        });
    }

    async function toggleInjection(characterId, control) {
        const world = activeWorldModel();
        const member = worldCharacter(characterId);
        const cardProfile = characterId === 'card-profile';
        if (!world || (!member && !cardProfile) || control.disabled) return;
        if (isGenerating() || operations.isBusy('world')) {
            dialogs.toast(tr('请等待当前生成或保存完成后再修改。'));
            return;
        }
        control.disabled = true;
        control.setAttribute('aria-busy', 'true');
        let persisted = false;
        try {
            await operations.run('world', async () => {
                if (activeWorldModel()?.id !== world.id) throw new Error(tr('当前世界已改变，请重新操作。'));
                if (isGenerating()) throw new Error(tr('请等待当前生成完成后再修改。'));
                const patch = cardProfile ? { cardProfileEnabled: world.storyContext?.card_profile_enabled === false } : { character: { id: member.id, operation: 'update', patch: {
                    activation: { ...normalizeCharacterActivation(member.activation), enabled: member.activation?.enabled === false },
                } } };
                await updateWorld(patch, { expectedRevision: world.revision });
                persisted = true;
                await reloadWorlds();
            });
        } catch (error) {
            if (persisted || error?.saved) {
                await reloadWorlds().catch(() => {});
                dialogs.toast(tr('角色注入设置已保存，重新打开世界后生效。'));
            } else dialogs.toast(dialogs.normalizeError(error), { tone: 'error' });
        } finally {
            control.disabled = false;
            control.removeAttribute('aria-busy');
            if (activeWorldModel()?.id === world.id) refresh();
        }
    }

    async function removeSetting(characterId, control = {}) {
        const world = activeWorldModel();
        const member = worldCharacter(characterId);
        const cardProfile = characterId === 'card-profile';
        if (!world || (!member && !cardProfile) || control.disabled) return false;
        if (isGenerating() || operations.isBusy('world')) {
            dialogs.toast(tr('请等待当前生成或保存完成后再删除。'));
            return false;
        }
        control.disabled = true;
        let persisted = false;
        try {
            const accepted = await dialogs.confirm({ title: tr('删除角色设定？'), body: cardProfile
                ? tr('从当前世界移除这条角色资料，不删除卡库原件、开场白或聊天记录。')
                : tr('删除当前世界中的此人物资料及关联关系，不删除聊天或卡库原件。指向此人物的引用将失效。'), confirmLabel: tr('删除'), tone: 'danger', restoreSheet: true });
            if (!accepted) return false;
            if (activeWorldModel()?.id !== world.id) throw new Error(tr('当前世界已改变，请重新操作。'));
            if (isGenerating() || operations.isBusy('world')) throw new Error(tr('请等待当前生成或保存完成后再删除。'));
            await operations.run('world', async () => {
                if (activeWorldModel()?.id !== world.id || isGenerating()) throw new Error(tr('当前世界状态已改变，请重新操作。'));
                await updateWorld(cardProfile ? { removeSetting: 'card-profile' }
                    : { character: { id: member.id, operation: 'delete' } }, { expectedRevision: world.revision });
                persisted = true;
                await reloadWorlds();
            });
            dialogs.toast(tr('角色设定已删除。'));
        } catch (error) {
            persisted ||= Boolean(error.saved);
            dialogs.toast(persisted ? tr('删除已保存，请重新打开世界以刷新显示。') : dialogs.normalizeError(error), { tone: 'error' });
        } finally {
            control.disabled = false;
            if (activeWorldModel()?.id === world.id) refresh();
        }
        return persisted;
    }

    function openEditor(characterId = readState().activeCharacterId) {
        const member = worldCharacter(characterId);
        const creating = characterId === 'new-world-character';
        const world = activeWorldModel();
        const canDelete = !creating && world && (member || characterId === readState().activeCharacterId);
        if (creating && !world) return;
        const character = creating ? { name: '', data: {} } : member ? { ...storyCharacterView(member), data: { description: member.profile.identity.description || '',
            personality: member.profile.personality?.summary || '' } } : readState().characters?.[characterId];
        if (!character) return;
        const activation = normalizeCharacterActivation(member?.activation || { mode: 'constant', enabled: creating || world?.storyContext?.card_profile_enabled !== false });
        const modeFields = (member || creating) ? `<input type="hidden" name="activationMode" value="${activation.mode}"><div class="nora-field-label">${tr("设定类型")}<div class="nora-mode-switch" role="group"><button data-character-mode="constant" type="button">${tr("常驻角色")}</button><button data-character-mode="triggered" type="button">${tr("触发角色")}</button></div></div><div data-character-trigger><label>${tr("触发关键词（每行一个，支持 ST 正则）")}<textarea name="activationKeys" rows="3">${escapeHtml(activation.keys.join('\n'))}</textarea></label><label>${tr("扫描最近消息数（留空跟随世界书）")}<input name="scanDepth" type="number" min="1" max="1000" value="${activation.scanDepth ?? ''}"></label><details><summary>${tr("高级触发设置")}</summary><label>${tr("辅助关键词（每行一个）")}<textarea name="secondaryKeys" rows="2">${escapeHtml(activation.secondaryKeys.join('\n'))}</textarea></label><label>${tr("辅助条件")}<select name="selectiveLogic">${['同时命中任一', '不全部命中', '全部不命中', '同时命中全部'].map((label, index) => `<option value="${index}" ${(activation.selectiveLogic ?? 0) === index ? 'selected' : ''}>${tr(label)}</option>`).join('')}</select></label>${[['sticky', '持续消息数'], ['cooldown', '冷却消息数'], ['delay', '延迟至消息数']].map(([key, label]) => `<label>${tr(label)}<input name="${key}" type="number" min="0" value="${activation[key] ?? 0}"></label>`).join('')}</details><p class="nora-model-note">${tr("使用世界书的关键词扫描规则；提到人物不等于人物实际在场。")}</p></div>` : '';
        const modal = dialogs.open(tr(creating ? "添加角色设定" : member ? "编辑角色设定" : "编辑原卡基础字段"), `<form id="nora-character-form" class="nora-form nora-entry-form nora-editor-form" autocomplete="off"><div class="nora-editor-fields"><div class="nora-library-field"><div class="nora-library-heading" data-role-library-heading><label for="nora-character-name">${tr("名字")}</label></div><input id="nora-character-name" name="name" required value="${escapeHtml(character.name || '')}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></div>${modeFields}<label>${tr("角色介绍")}<textarea name="description" rows="9" placeholder="${tr("身份、外貌、背景和在故事中的位置。")}">${escapeHtml(characterField(character, 'description'))}</textarea></label><label>${tr("性格")}<textarea name="personality" rows="7" placeholder="${tr("性格、行为方式和表达习惯。")}">${escapeHtml(characterField(character, 'personality'))}</textarea></label><p class="nora-model-note">${tr("只更新这些角色资料，不会改动角色卡内的脚本、正则或世界书。")}</p></div><div class="nora-form-actions nora-editor-toolbar">${canDelete ? `<button class="nora-setting-delete" type="button" data-delete-character>${tr("删除")}</button>` : ''}<span class="nora-editor-toolbar-spacer"></span><button class="nora-secondary" data-cancel-character type="button">${tr("取消")}</button><button class="nora-primary" type="submit">${tr(creating ? "添加" : "保存")}</button></div> </form>`, 'nora-character-editor-modal nora-plain-sheet nora-fixed-editor');
        const editor = select('#nora-character-form', modal);
        select('[data-role-library-heading]', modal)?.insertAdjacentHTML?.('beforeend', `<div class="nora-library-editor-actions">${creating ? `<button type="button" data-pick-role><i class="fa-solid fa-book-open" aria-hidden="true"></i><span>${tr('从库选择')}</span></button>` : ''}<button type="button" data-save-role><i class="fa-regular fa-bookmark" aria-hidden="true"></i><span>${tr('另存到库')}</span></button></div>`);
        select('[data-pick-role]', modal)?.addEventListener('click', () => openProfileLibrary('character', world));
        select('[data-save-role]', modal)?.addEventListener('click', () => {
            const data = new FormData(editor);
            const savedActivation = { ...activation, mode: String(data.get('activationMode') || activation.mode),
                keys: data.has('activationKeys') ? String(data.get('activationKeys')).split(/\r?\n/) : activation.keys,
                secondaryKeys: data.has('secondaryKeys') ? String(data.get('secondaryKeys')).split(/\r?\n/) : activation.secondaryKeys };
            for (const key of ['selectiveLogic', 'scanDepth', 'sticky', 'cooldown', 'delay']) {
                if (data.has(key)) savedActivation[key] = data.get(key) === '' ? null : Number(data.get(key));
            }
            saveProfile('character', { name: String(data.get('name') || '').trim(), description: String(data.get('description') || ''),
                personality: String(data.get('personality') || ''), activation: savedActivation,
                ...(member ? { profile: structuredClone(member.profile) } : {}) });
        });
        const modeInput = editor.querySelector('[name="activationMode"]');
        const updateMode = () => {
            selectAll('[data-character-mode]', modal).forEach(button => {
                button.classList.toggle('active', button.dataset.characterMode === modeInput.value);
            });
            const fields = editor.querySelector('[data-character-trigger]');
            if (fields) {
                fields.hidden = modeInput.value !== 'triggered';
                fields.querySelector('[name="activationKeys"]').required = !fields.hidden;
            }
        };
        selectAll('[data-character-mode]', modal).forEach(button => button.addEventListener('click', () => {
            modeInput.value = button.dataset.characterMode;
            updateMode();
        }));
        editor.querySelector('[data-cancel-character]')?.addEventListener('click', () => {
            if (!operations.isBusy('world')) dialogs.close();
        });
        updateMode();
        editor.querySelector('[data-delete-character]')?.addEventListener('click', async event => {
            if (!canDelete || activeWorldModel()?.id !== world.id) return;
            if (await removeSetting(member ? characterId : 'card-profile', event.currentTarget)) dialogs.close();
        });
        select('#nora-character-form', modal).addEventListener('submit', async (event) => {
            event.preventDefault();
            if (operations.isBusy('world')) {
                dialogs.toast(tr("角色资料正在保存，请稍候。"));
                return;
            }
            const form = event.currentTarget;
            const submit = form.querySelector('[type="submit"]');
            const data = new FormData(form);
            submit.disabled = true;
            let persisted = false;
            try {
                await operations.run('world', async () => {
                    const changes = {
                        avatar: character.avatar,
                        name: String(data.get('name') || '').trim(),
                        description: String(data.get('description') || '').trim(),
                        personality: String(data.get('personality') || '').trim(),
                    };
                    resolveCharacterReferences(changes, activeWorldModel()?.storyContext?.characters, { strict: true });
                    if (member || creating) {
                        if (activeWorldModel()?.id !== world.id) throw new Error(tr('当前世界已改变，请重新打开编辑。'));
                        const activation = { ...normalizeCharacterActivation(member?.activation), mode: String(data.get('activationMode')),
                            keys: String(data.get('activationKeys') || '').split(/\r?\n/),
                            secondaryKeys: String(data.get('secondaryKeys') || '').split(/\r?\n/),
                            selectiveLogic: Number(data.get('selectiveLogic') || 0),
                        };
                        for (const key of ['scanDepth', 'sticky', 'cooldown', 'delay']) {
                            activation[key] = data.get(key) === '' ? null : Number(data.get(key) || 0);
                        }
                        const patch = { name: changes.name, description: changes.description, personality: changes.personality,
                            activation: normalizeCharacterActivation(activation) };
                        resolveCharacterReferences(patch.activation, activeWorldModel()?.storyContext?.characters, { strict: true });
                        await updateWorld({ character: { id: creating ? `character:${crypto.randomUUID()}` : member.id, operation: creating ? 'create' : 'update', patch } }, { expectedRevision: world.revision });
                    } else await cards.updateCharacter(changes);
                    persisted = true;
                    await reloadWorlds();
                    refresh();
                    dialogs.close();
                    dialogs.toast(tr(creating ? "角色设定已添加。" : "角色设定已保存。"));
                });
            } catch (error) {
                if (error?.saved || persisted) {
                    await reloadWorlds().catch(() => {});
                    refresh();
                    dialogs.close();
                    dialogs.toast(tr("角色设定已保存，重新打开世界后生效。"));
                    return;
                }
                submit.disabled = false;
                const prefix = persisted ? tr("角色资料已保存，但页面刷新失败") : tr("角色资料保存失败");
                dialogs.toast(`${prefix}：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
            }
        });
    }

    return Object.freeze({ openLibrary, openSheet, openEditor, toggleInjection, removeSetting });
}
