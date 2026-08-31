import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
export function createCharacterController({
    cards,
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
}) {
    const desktopLibraryPageSize = 8;
    const mobileLibraryPageSize = 4;
    let libraryPage = 0;

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
        const libraryGroups = groups();
        const pageSize = libraryPageSize();
        const pageCount = Math.max(1, Math.ceil(libraryGroups.length / pageSize));
        const parsedPage = Number(requestedPage);
        libraryPage = Number.isInteger(parsedPage) ? Math.min(Math.max(parsedPage, 0), pageCount - 1) : Math.min(libraryPage, pageCount - 1);
        const pageStart = libraryPage * pageSize;
        const pageGroups = libraryGroups.slice(pageStart, pageStart + pageSize);
        const cardMarkup = pageGroups.map((group, pageIndex) => {
            const groupIndex = pageStart + pageIndex;
            const { character, index } = group.primary;
            const duplicateBadge = group.members.length > 1 ? `<small class="nora-card-duplicate">${t`${group.members.length}份`}</small>` : '';
            const deleteTitle = group.deletable.length ? (group.retained.length ? tr("清理重复副本") : tr("删除角色卡")) : tr("正在被世界使用");
            return `<article class="nora-card-library-item"><button class="nora-card-library-open" data-library-character="${index}" type="button"><img src="/thumbnail?type=avatar&amp;file=${encodeURIComponent(character.avatar)}" alt="" loading="lazy"><span><strong>${escapeHtml(character.name || tr("未命名角色"))}</strong><small>${escapeHtml(characterField(character, 'creator') || tr("角色卡"))}</small></span></button>${duplicateBadge}<button class="nora-delete-button nora-card-library-delete" data-library-delete="${groupIndex}" type="button" aria-label="${deleteTitle}" title="${deleteTitle}" ${group.deletable.length ? '' : 'disabled'}>${icons.trash}</button></article>`;
        }).join('');
        const pager = pageCount > 1 ? `<nav class="nora-library-pager" aria-label="${tr("角色卡分页")}"><button data-library-page="${Math.max(0, libraryPage - 1)}" type="button" aria-label="${tr("上一页")}" ${libraryPage === 0 ? 'disabled' : ''}>${icons.left}</button><span>${t`第 ${libraryPage + 1} / ${pageCount} 页`}</span><button data-library-page="${Math.min(pageCount - 1, libraryPage + 1)}" type="button" aria-label="${tr("下一页")}" ${libraryPage === pageCount - 1 ? 'disabled' : ''}>${icons.right}</button></nav>` : '';
        const columns = Math.min(4, pageGroups.length);
        const mobileColumns = Math.min(2, pageGroups.length);
        const content = libraryGroups.length ? `<div class="nora-card-waterfall" style="--nora-library-columns:${columns};--nora-library-mobile-columns:${mobileColumns}">${cardMarkup}</div>${pager}` : `<p class="nora-sheet-empty">${tr("还没有导入角色卡。")}</p>`;
        const modal = dialogs.open(tr("角色卡库"), content, 'nora-character-library-modal nora-plain-sheet');
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
        selectAll('[data-library-delete]', modal).forEach((button) => button.addEventListener('click', () => deleteGroup(libraryGroups[Number(button.dataset.libraryDelete)])));
        selectAll('[data-library-page]', modal).forEach((button) => button.addEventListener('click', () => openLibrary(Number(button.dataset.libraryPage))));
    }

    function openSheet(characterId = readState().activeCharacterId, backToLibrary = false) {
        const character = readState().characters?.[characterId];
        if (!character) return;
        const fields = [[tr("角色介绍"), characterField(character, 'description')], [tr("性格"), characterField(character, 'personality')], [tr("场景"), characterField(character, 'scenario')], [tr("开场内容"), characterField(character, 'first_mes')], [tr("示例对话"), characterField(character, 'mes_example')], [tr("创作者备注"), characterField(character, 'creator_notes')]].filter(([, value]) => String(value || '').trim());
        const capabilities = characterCapabilities(character);
        const capabilityCount = capabilities.regexScripts.length + capabilities.helperScripts.length;
        const worldbookCount = worldbookEntries(character?.data?.character_book).length;
        const capabilitiesEnabled = (!capabilities.regexScripts.length || capabilities.regexAllowed)
            && (!capabilities.helperScripts.length || capabilities.helperAllowed);
        const rules = capabilityCount ? `<div class="nora-character-rules ${capabilitiesEnabled ? 'enabled' : ''}"><div><strong>${tr("角色扩展能力")}</strong><span>${t`${capabilities.regexScripts.length} 条显示规则 · ${capabilities.helperScripts.length} 个脚本 · ${capabilitiesEnabled ? tr("已启用") : tr("未启用")}`}</span></div>${capabilitiesEnabled ? '' : `<button data-enable-character-capabilities type="button">${tr("启用")}</button>`}</div>` : '';
        const overview = `<div class="nora-character-overview"><img src="/thumbnail?type=avatar&amp;file=${encodeURIComponent(character.avatar)}" alt=""><div><p class="nora-provenance">${escapeHtml(characterField(character, 'creator') || tr("角色资料"))}</p><p>${t`${worldbookCount} 条世界书 · ${capabilities.regexScripts.length} 条显示规则 · ${capabilities.helperScripts.length} 个脚本`}</p></div></div>`;
        const back = backToLibrary ? `<button class="nora-sheet-back" data-back-character-library type="button">${tr("‹ 返回角色卡库")}</button>` : '';
        const empty = fields.length ? '' : `<p class="nora-sheet-empty">${tr("该卡主要由内置世界书和扩展脚本构成。")}</p>`;
        const createAction = backToLibrary ? `<div class="nora-sheet-actions"><button class="nora-primary" data-card-create-world type="button">${tr("开启新世界")}</button></div>` : '';
        const modal = dialogs.open(character.name, `${back}<div class="nora-character-detail">${overview}${rules}${fields.map(([label, value]) => `<section><h3>${label}</h3><p>${escapeHtml(value)}</p></section>`).join('')}${empty}</div>${createAction}`, 'nora-detail-modal');
        select('[data-card-create-world]', modal)?.addEventListener('click', event => createWorldFromCard(character, event.currentTarget));
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
                    await enableCharacterCapabilities(character, { reload: true });
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

    function openEditor(characterId = readState().activeCharacterId) {
        const character = readState().characters?.[characterId];
        if (!character) return;
        const modal = dialogs.open(tr("编辑常驻角色"), `<form id="nora-character-form" class="nora-form" autocomplete="off"><label>${tr("名字")}<input name="name" required value="${escapeHtml(character.name || '')}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></label><label>${tr("角色介绍")}<textarea name="description" rows="9" placeholder="${tr("身份、外貌、背景和在故事中的位置。")}">${escapeHtml(characterField(character, 'description'))}</textarea></label><label>${tr("性格")}<textarea name="personality" rows="7" placeholder="${tr("性格、行为方式和表达习惯。")}">${escapeHtml(characterField(character, 'personality'))}</textarea></label><p class="nora-model-note">${tr("只更新这些角色资料，不会改动角色卡内的脚本、正则或世界书。")}</p><button class="nora-primary" type="submit">${tr("保存角色资料")}</button></form>`, 'nora-character-editor-modal nora-plain-sheet');
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
                    await cards.updateCharacter({
                        avatar: character.avatar,
                        name: String(data.get('name') || '').trim(),
                        description: String(data.get('description') || '').trim(),
                        personality: String(data.get('personality') || '').trim(),
                    });
                    persisted = true;
                    await reloadWorlds();
                    refresh();
                    dialogs.close();
                    dialogs.toast(tr("常驻角色资料已保存。"));
                });
            } catch (error) {
                if (!persisted) submit.disabled = false;
                const prefix = persisted ? tr("角色资料已保存，但页面刷新失败") : tr("角色资料保存失败");
                dialogs.toast(`${prefix}：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
            }
        });
    }

    return Object.freeze({ openLibrary, openSheet, openEditor });
}
