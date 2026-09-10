import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { storyCharacterView, normalizeCharacterActivation } from '../../engine/sillytavern/public/scripts/nora-worlds/story-context.js';
import { resolveCharacterReferences } from '../../engine/sillytavern/public/scripts/nora-worlds/character-references.js';
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
        if (!libraryLoaded) {
            await cards.refreshCharacters();
            libraryLoaded = true;
        }
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
        const modal = dialogs.open(tr("世界卡库"), content, 'nora-character-library-modal nora-plain-sheet');
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
        const activation = normalizeCharacterActivation(member?.activation);
        const modeFields = (member || creating) ? `<input type="hidden" name="activationMode" value="${activation.mode}"><div class="nora-field-label">${tr("设定类型")}<div class="nora-mode-switch" role="group"><button data-character-mode="constant" type="button">${tr("常驻角色")}</button><button data-character-mode="triggered" type="button">${tr("触发角色")}</button></div></div><div data-character-trigger><label>${tr("触发关键词（每行一个，支持 ST 正则）")}<textarea name="activationKeys" rows="3">${escapeHtml(activation.keys.join('\n'))}</textarea></label><label>${tr("扫描最近消息数（留空跟随世界书）")}<input name="scanDepth" type="number" min="1" max="1000" value="${activation.scanDepth ?? ''}"></label><details><summary>${tr("高级触发设置")}</summary><label>${tr("辅助关键词（每行一个）")}<textarea name="secondaryKeys" rows="2">${escapeHtml(activation.secondaryKeys.join('\n'))}</textarea></label><label>${tr("辅助条件")}<select name="selectiveLogic">${['同时命中任一', '不全部命中', '全部不命中', '同时命中全部'].map((label, index) => `<option value="${index}" ${(activation.selectiveLogic ?? 0) === index ? 'selected' : ''}>${tr(label)}</option>`).join('')}</select></label>${[['sticky', '持续消息数'], ['cooldown', '冷却消息数'], ['delay', '延迟至消息数']].map(([key, label]) => `<label>${tr(label)}<input name="${key}" type="number" min="0" value="${activation[key] ?? 0}"></label>`).join('')}</details><p class="nora-model-note">${tr("使用世界书的关键词扫描规则；提到人物不等于人物实际在场。")}</p></div>` : '';
        const modal = dialogs.open(tr(creating ? "添加角色设定" : member ? "编辑角色设定" : "编辑原卡基础字段"), `<form id="nora-character-form" class="nora-form nora-entry-form nora-editor-form" autocomplete="off"><div class="nora-editor-fields"><label>${tr("名字")}<input name="name" required value="${escapeHtml(character.name || '')}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></label>${modeFields}<label>${tr("角色介绍")}<textarea name="description" rows="9" placeholder="${tr("身份、外貌、背景和在故事中的位置。")}">${escapeHtml(characterField(character, 'description'))}</textarea></label><label>${tr("性格")}<textarea name="personality" rows="7" placeholder="${tr("性格、行为方式和表达习惯。")}">${escapeHtml(characterField(character, 'personality'))}</textarea></label><p class="nora-model-note">${tr("只更新这些角色资料，不会改动角色卡内的脚本、正则或世界书。")}</p></div><div class="nora-form-actions nora-editor-toolbar">${canDelete ? `<button class="nora-setting-delete" type="button" data-delete-character>${tr("删除")}</button>` : ''}<span class="nora-editor-toolbar-spacer"></span><button class="nora-secondary" data-cancel-character type="button">${tr("取消")}</button><button class="nora-primary" type="submit">${tr(creating ? "添加" : "保存")}</button></div> </form>`, 'nora-character-editor-modal nora-plain-sheet nora-fixed-editor');
        const editor = select('#nora-character-form', modal);
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
