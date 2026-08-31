import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
import { projectTextModelDisplay } from './model-display.js';
import { buildCuratorReviewLink, storyProfileHref } from './story-profile-controller.js';

export function createPanelController({
    settingsDomain,
    worldRuntime,
    dialogs,
    select,
    selectAll,
    escapeHtml,
    icons,
    readState,
    settings,
    characterField,
    currentCharacter,
    activeWorldModel,
    currentWorldPersona,
    worldbookSummary,
    openWorldbookEntryDetail,
    openWorldbookEntryEditor,
    openWorldbookSheet,
    openCharacterLibrary,
    openCharacterSheet,
    openCharacterEditor,
    openModelSheet,
    closeDrawers,
    runWorldOperation,
    refreshWorldsAfterCommit,
    retryWorldCapability = async () => {},
    agentUserId = () => '',
    currentUrl = () => globalThis.location?.href || '/',
}) {
    let castEditing = false;
    let worldbookEditing = false;
    let castFolded = true;
    let worldSettingsFolded = true;
    let worldSettingsWorldKey = '';

    function hasCharacterProfile(character) {
        return Boolean(String(characterField(character, 'personality') || '').trim());
    }

    function currentCast() {
        const world = activeWorldModel();
        const character = currentCharacter();
        const characterId = readState().activeCharacterId;
        if (!world || !hasCharacterProfile(character) || !Number.isInteger(characterId) || characterId < 0) return [];
        return [{ character, index: characterId }];
    }

    function capabilitySection(world) {
        const capabilities = world?.capabilities;
        if (!capabilities?.declared?.length) return '';
        const labels = { regex: tr("Regex 显示规则"), tavern_helper: tr("角色脚本"), mvu: tr("MVU 变量") };
        const statuses = { READY: tr("已就绪"), PENDING: tr("加载中"), DEGRADED: tr("未就绪") };
        const reasons = {
            NORA_MVU_TIMEOUT: tr("变量系统启动超时，可以重试。"),
            NORA_MVU_API_UNAVAILABLE: tr("变量系统未完整加载，可以重试。"),
            NORA_REGEX_NOT_AUTHORIZED: tr("显示规则尚未授权。"),
            NORA_TAVERN_HELPER_NOT_AUTHORIZED: tr("角色脚本尚未授权。"),
        };
        const rows = capabilities.declared.map((capability) => {
            const item = capabilities.items?.[capability] || { status: 'PENDING' };
            const error = item.status === 'DEGRADED'
                ? (reasons[item.error?.code] || tr("增强能力暂未就绪，可以重试。"))
                : '';
            const retry = item.status === 'DEGRADED'
                ? `<button class="nora-capability-retry" data-retry-capability="${escapeHtml(capability)}" type="button">${tr("重试")}</button>`
                : '';
            return `<div class="nora-capability-row" data-capability-status="${escapeHtml(item.status)}"${error ? ` title="${escapeHtml(error)}"` : ''}><span>${escapeHtml(labels[capability] || capability)}</span><span class="nora-capability-state">${escapeHtml(statuses[item.status] || item.status)}${retry}</span></div>`;
        }).join('');
        return `<div class="pSection nora-capability-section"><div class="pHead">${tr("增强能力")}</div>${rows}</div>`;
    }

    function render() {
        const world = activeWorldModel();
        const character = currentCharacter();
        const cast = currentCast();
        const body = select('#nora-panel-body');
        const persona = world ? currentWorldPersona() : null;
        const nextWorldKey = world?.id || '';
        if (nextWorldKey !== worldSettingsWorldKey) {
            worldSettingsWorldKey = nextWorldKey;
            castEditing = false;
            worldbookEditing = false;
            castFolded = true;
            worldSettingsFolded = true;
        }
        const castFoldClass = castFolded ? ' folded' : '';
        const settingsFoldClass = worldSettingsFolded ? ' folded' : '';
        const activeCharacterId = readState().activeCharacterId;
        const emptyCastEdit = castEditing && character && Number.isInteger(activeCharacterId) && activeCharacterId >= 0
            ? `<div class="emptyEditRow"><span>${tr("暂无常驻角色")}</span><button class="itemEdit" data-cast-edit="${activeCharacterId}" type="button" aria-label="${tr("编辑常驻角色资料")}" title="${tr("编辑常驻角色资料")}">${icons.edit}</button></div>`
            : `<p class="pmuted">${tr("暂无常驻角色")}</p>`;
        const castHtml = cast.length ? cast.map(({ character: member, index }) => {
            const tags = Array.isArray(member?.tags) ? member.tags.filter(Boolean) : [];
            return `<div class="castCard castProfileCard" data-cast-character="${index}" role="button" tabindex="0" aria-label="${t`查看${escapeHtml(member.name || tr("未命名角色"))}资料`}"><div class="castTop"><p class="cname">${escapeHtml(member.name || tr("未命名角色"))}</p>${castEditing ? `<span class="itemActions"><button class="itemEdit" data-cast-edit="${index}" type="button" aria-label="${tr("编辑常驻角色")}" title="${tr("编辑常驻角色")}">${icons.edit}</button></span>` : ''}</div><p class="cdesc">${escapeHtml(characterField(member, 'description') || tr("暂无角色资料"))}</p>${tags.length ? `<div class="ctags">${tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}</div>`;
        }).join('') : emptyCastEdit;
        const reviewHref = buildCuratorReviewLink({ agentUserId: agentUserId(), worldName: world?.name });
        const reviewLink = reviewHref
            ? `<a class="pLink" href="${escapeHtml(reviewHref)}" target="_blank" rel="noopener external"><i class="fa-solid fa-comments" aria-hidden="true"></i>${tr("找主理人复盘")}</a>`
            : `<span class="pLink" aria-disabled="true" title="${tr("主理人的 ClawChat 身份尚未就绪")}"><i class="fa-solid fa-comments" aria-hidden="true"></i>${tr("找主理人复盘")}</span>`;
        const archiveHref = storyProfileHref(currentUrl());
        const actorSection = `<div class="pSection actorSec"><div class="pHead">${tr("故事主理人")}</div>${reviewLink}<a class="pLink" href="${escapeHtml(archiveHref)}"><i class="fa-solid fa-book-open" aria-hidden="true"></i>${tr("主理人的故事档案")}</a></div>`;
        const modelDisplay = projectTextModelDisplay({ nativeModel: readState().model, uiSettings: settings() });
        const modelSection = `<div class="pSection modelSection"><div class="pHead">${tr("模型")}</div><div class="modelGroup"><div class="modelUnit"><div class="modelUnitHead">${tr("文本模型")}</div><p class="mdlCur">${escapeHtml(modelDisplay.label)}</p><button class="actorMore" data-action="model" type="button"><i class="fa-solid fa-sliders" aria-hidden="true"></i>${tr("切换 / 管理")}</button></div></div></div>`;
        const librarySection = `<div class="pSection librarySec"><div class="pHead">${tr("角色卡库")}</div><div class="libraryLinks"><button class="actorMore" data-action="library" type="button"><i class="fa-solid fa-address-book" aria-hidden="true"></i>${tr("打开角色卡库")}</button></div><div class="librarySupport">${actorSection}${modelSection}</div></div>`;
        body.innerHTML = `
            <div class="pSection"><div class="pHead pHeadAction"><span>${tr("我的角色")}</span><button class="sectionEdit" data-action="profile" type="button" ${world ? '' : 'disabled'}>${tr("编辑")}</button></div>${world ? `<p class="pname">${escapeHtml(persona?.name || tr("我"))}</p><p class="pdesc">${escapeHtml(persona?.description || tr("补充你在这个世界中的身份与性格"))}</p>` : `<p class="pmuted">${tr("选择世界后设置我的角色。")}</p>`}</div>
            ${world ? `<div class="pSection pFold"><div class="pHead pHeadFold${castFoldClass}" data-fold="cast"><span>常驻角色</span><span class="headRight"><button class="sectionEdit" data-edit-section="cast" type="button">${castEditing ? tr("完成") : tr("编辑")}</button><span class="arr">▼</span></span></div><div class="pFoldBody${castFoldClass}" id="nora-cast-body">${castHtml}</div></div>` : `<div class="pSection"><div class="pHead">${tr("常驻角色")}</div><p class="pmuted">${tr("选择世界后显示常驻角色。")}</p></div>`}
            ${world ? `<div class="pSection pFold"><div class="pHead pHeadFold${settingsFoldClass}" data-fold="settings"><span>世界书</span><span class="headRight"><button class="sectionEdit" data-edit-section="worldbook" type="button">${worldbookEditing ? tr("完成") : tr("编辑")}</button><span class="arr">▼</span></span></div><div class="pFoldBody${settingsFoldClass}" id="nora-settings-body">${worldbookSummary(character, worldbookEditing)}</div></div>` : `<div class="pSection"><div class="pHead">${tr("世界书")}</div><p class="pmuted">${tr("选择世界后查看世界书。")}</p></div>`}
            ${world ? capabilitySection(world) : ''}
            ${librarySection}
            <footer class="lwFoot"><span class="mark">✦</span>tavern</footer>`;
        selectAll('[data-action]', body).forEach(button => button.addEventListener('click', (event) => {
            event.stopPropagation();
            runAction(button.dataset.action);
        }));
        selectAll('[data-cast-edit]', body).forEach(button => button.addEventListener('click', (event) => {
            event.stopPropagation();
            closeDrawers();
            openCharacterEditor(Number(button.dataset.castEdit));
        }));
        selectAll('[data-cast-character]', body).forEach((card) => {
            const open = () => { closeDrawers(); openCharacterSheet(Number(card.dataset.castCharacter)); };
            card.addEventListener('click', open);
            card.addEventListener('keydown', (event) => {
                if (!['Enter', ' '].includes(event.key)) return;
                event.preventDefault();
                open();
            });
        });
        selectAll('[data-worldbook-kind]', body).forEach((item) => {
            const open = () => openWorldbookEntryDetail(item.dataset.worldbookKind, item.dataset.entryId);
            item.addEventListener('click', (event) => {
                if (!event.target.closest('[data-action]')) open();
            });
            item.addEventListener('keydown', (event) => {
                if (!['Enter', ' '].includes(event.key) || event.target.closest('[data-action]')) return;
                event.preventDefault();
                open();
            });
        });
        selectAll('[data-worldbook-edit-kind]', body).forEach(button => button.addEventListener('click', (event) => {
            event.stopPropagation();
            closeDrawers();
            openWorldbookEntryEditor(button.dataset.worldbookEditKind, button.dataset.entryId);
        }));
        selectAll('[data-retry-capability]', body).forEach(button => button.addEventListener('click', async (event) => {
            event.stopPropagation();
            const world = activeWorldModel();
            if (!world || button.disabled) return;
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            try {
                await retryWorldCapability(world.id, button.dataset.retryCapability);
                render();
            } catch (error) {
                dialogs.toast(t`增强能力重试失败：${dialogs.normalizeError(error)}`, { tone: 'error', duration: 4200 });
                button.disabled = false;
                button.removeAttribute('aria-busy');
            }
        }));
        selectAll('[data-fold]', body).forEach(header => header.addEventListener('click', () => {
            if (header.dataset.fold === 'cast') castFolded = !castFolded;
            if (header.dataset.fold === 'settings') worldSettingsFolded = !worldSettingsFolded;
            render();
        }));
        selectAll('[data-edit-section="cast"]', body).forEach(button => button.addEventListener('click', (event) => {
            event.stopPropagation();
            castEditing = !castEditing;
            if (castEditing) castFolded = false;
            render();
        }));
        selectAll('[data-edit-section="worldbook"]', body).forEach(button => button.addEventListener('click', (event) => {
            event.stopPropagation();
            worldbookEditing = !worldbookEditing;
            if (worldbookEditing) worldSettingsFolded = false;
            render();
        }));
    }

    function runAction(action) {
        closeDrawers();
        const actions = { profile: openPersona, character: openCharacterSheet, worldbook: openWorldbookSheet, library: openCharacterLibrary, model: openModelSheet };
        actions[action]?.();
    }

    function refreshHeader() {
        const world = activeWorldModel();
        select('#nora-title').textContent = world?.name || tr("酒馆");
        select('#nora-subtitle').textContent = world ? (currentCharacter()?.name || tr("角色卡")) : '';
    }

    function applyHostPersonality() {
        settingsDomain.setHostPersonality(String(settings().profile.hostPersonality || '').trim());
    }

    function openPersona() {
        if (!activeWorldModel()) return;
        const editingWorld = activeWorldModel();
        const persona = currentWorldPersona();
        const modal = dialogs.open(tr("我的角色"), `<form id="nora-persona-form" class="nora-form" autocomplete="off"><label>${tr("名字")}<input name="name" value="${escapeHtml(persona.name)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></label><label>${tr("故事中的你")}<textarea name="description" rows="10" placeholder="${tr("身份、性格、外貌，以及希望角色了解的背景。")}" autocomplete="off">${escapeHtml(persona.description)}</textarea></label><button class="nora-primary" type="submit">${tr("保存到当前世界")}</button></form>`);
        select('#nora-persona-form', modal).addEventListener('submit', async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            await runWorldOperation(async () => {
                if (activeWorldModel()?.id !== editingWorld.id) throw new Error('World changed; reopen the editor.');
                await worldRuntime.updateActive({ persona: {
                    name: String(data.get('name') || '').trim(),
                    description: String(data.get('description') || '').trim(),
                } }, { expectedRevision: editingWorld.revision });
                dialogs.close();
                await refreshWorldsAfterCommit(tr("我的角色已保存"));
            }, { control: form.querySelector('[type="submit"]'), errorLabel: tr("我的角色保存失败"), logLabel: 'Failed to update persona' });
        });
    }

    return Object.freeze({ render, runAction, refreshHeader, applyHostPersonality, openPersona });
}
